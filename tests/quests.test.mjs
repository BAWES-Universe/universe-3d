import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGameServer } from '../server/app.mjs';
const scene={version:1,theme:'garden',bounds:{width:20,depth:20},spawn:{x:0,z:0},objects:[],areas:[{id:'garden',name:'Named garden',x:6,z:0,width:3,depth:3,action:'welcome'}]};
const seeds=[{id:'world',name:'World',rooms:[{id:'room',name:'Room',scene},{id:'elsewhere',name:'Elsewhere',scene}]}];
async function fixture(opts={}) {
  const app=createGameServer({seeds,...opts});const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`;
  const client=()=>({cookie:'',async call(path,method='GET',body){const response=await fetch(base+path,{method,headers:{...(this.cookie?{Cookie:this.cookie}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});if(response.headers.get('set-cookie'))this.cookie=response.headers.get('set-cookie').split(';')[0];return {status:response.status,data:await response.json()};}});
  const guest=async name=>{const c=client(),result=await c.call('/api/session','POST',{name,woka:0});c.user=result.data.user;await c.call('/api/rooms/room/join','POST',{});return c;};
  return {app,client,guest,base};
}
async function state(c){const r=await c.call('/api/quests');assert.equal(r.status,200);return r.data;}
async function accept(c,kind){const def=(await state(c)).available.find(q=>q.kind===kind);assert.ok(def,`Missing ${kind} offer`);const result=await c.call('/api/quests/accept','POST',{roomId:'room',definitionId:def.id,version:def.version});assert.equal(result.status,201,JSON.stringify(result));return {def,...result.data};}
const move=(c,x,z=0)=>c.call('/api/presence','POST',{roomId:'room',x,z,moving:false});
const wave=c=>c.call('/api/rooms/room/emote','POST',{emoji:'👋'});
const connect=c=>c.call('/api/media/state','POST',{enabled:true});

test('quests require explicit acceptance; decline and tracking are identity scoped',async t=>{
 const f=await fixture();t.after(()=>f.app.close());const owner=await f.guest('Owner'),member=await f.guest('Member');
 assert.equal((await f.client().call('/api/quests')).status,401);
 assert.deepEqual((await state(member)).available.map(x=>x.kind),['explore']);
 await move(member,6);assert.equal((await state(member)).stampCount,0);
 await member.call('/api/quests/preferences','PATCH',{declined:true});assert.equal((await state(member)).preferences.declined,true);assert.equal((await state(owner)).preferences.declined,false);
 const accepted=await accept(owner,'explore');assert.equal((await state(owner)).tracked.id,accepted.attemptId);
 const again=await owner.call('/api/quests/accept','POST',{roomId:'room',definitionId:accepted.def.id,version:accepted.def.version});assert.equal(again.status,200);assert.equal(again.data.attemptId,accepted.attemptId);
 const build=await accept(owner,'build');assert.equal((await state(owner)).tracked.id,build.attemptId);assert.equal((await state(owner)).attempts.filter(a=>a.status==='accepted').length,2);
 assert.equal((await member.call('/api/quests/preferences','PATCH',{trackedAttemptId:accepted.attemptId})).status,404);
 assert.equal((await member.call('/api/quests/archive','POST',{attemptId:accepted.attemptId})).status,404);
 assert.equal((await owner.call('/api/quests/complete','POST',{attemptId:accepted.attemptId})).status,404);
 await owner.call('/api/quests/preferences','PATCH',{trackedAttemptId:null});assert.equal((await state(owner)).tracked,null);
 await move(owner,6);assert.equal((await state(owner)).stampCount,1);assert.equal((await state(member)).stampCount,0);
 await move(owner,0);await move(owner,6);assert.equal((await state(owner)).stampCount,1);
});

test('explore requires a post-acceptance crossing and rejects stale or deleted targets',async t=>{
 const f=await fixture();t.after(()=>f.app.close());const a=await f.guest('Owner');await move(a,6);await accept(a,'explore');await move(a,6);assert.equal((await state(a)).stampCount,0);await move(a,0);await move(a,6);assert.equal((await state(a)).stampCount,1);
 const b=await f.guest('Other');const pending=(await state(b)).available[0];const room=(await a.call('/api/rooms/room')).data.room;await a.call('/api/rooms/room/scene','PUT',{revision:room.revision,scene:{...room.scene,areas:[]}});
 assert.equal((await b.call('/api/quests/accept','POST',{roomId:'room',definitionId:pending.id,version:pending.version})).status,409);
 assert.equal((await state(b)).available.length,0);
});

test('Explore guidance walks outside first when accepted inside, then back in without early credit',async t=>{
 const f=await fixture();t.after(()=>f.app.close());const a=await f.guest('Inside explorer');
 await move(a,6);const accepted=await accept(a,'explore');let tracked=(await state(a)).tracked;
 assert.equal(tracked.guidance.phase,'leave-area');assert.match(tracked.guidance.instruction,/Step outside Named garden first/);
 assert.ok(Math.abs(tracked.target.x-6)>1.5||Math.abs(tracked.target.z)>1.5,'first target is outside the area');
 await move(a,tracked.target.x,tracked.target.z);let snapshot=await state(a);tracked=snapshot.tracked;
 assert.equal(snapshot.stampCount,0);assert.equal(tracked.status,'accepted');assert.equal(tracked.version,accepted.def.version);
 assert.equal(tracked.guidance.phase,'enter-area');assert.match(tracked.guidance.instruction,/Walk into Named garden/);
 assert.ok(Math.abs(tracked.target.x-6)<=1.5&&Math.abs(tracked.target.z)<=1.5,'next target is inside the area');
 await move(a,tracked.target.x,tracked.target.z);snapshot=await state(a);
 assert.equal(snapshot.stampCount,1);assert.equal(snapshot.tracked,null);assert.equal(snapshot.attempts[0].status,'completed');
 await move(a,0);await move(a,6);assert.equal((await state(a)).stampCount,1);
});

test('Build credits only the actor’s successful authorized new instance CAS, atomically once',async t=>{
 const f=await fixture();t.after(()=>f.app.close());const a=await f.guest('Owner'),b=await f.guest('Editor');await a.call(`/api/rooms/room/members/${b.user.id}`,'PUT',{role:'editor'});await accept(a,'build');await accept(b,'build');
 const data={revision:0,scene:{...scene,objects:[{id:'new-object',type:'chair',x:2,z:2}]}};
 assert.equal((await b.call('/api/rooms/room/scene','PUT',data)).status,200);assert.equal((await state(b)).stampCount,1);assert.equal((await state(a)).stampCount,0);
 assert.equal((await b.call('/api/rooms/room/scene','PUT',data)).status,409);assert.equal((await state(b)).stampCount,1);
 assert.equal((await a.call('/api/rooms/room/scene','PUT',{revision:1,scene:{...data.scene,objects:[{...data.scene.objects[0],x:3}]}})).status,200);assert.equal((await state(a)).stampCount,0);
 assert.equal((await a.call('/api/rooms/room/scene','PUT',{revision:2,scene:{...data.scene,objects:[...data.scene.objects,{id:'second',type:'rug',x:4,z:4}]}})).status,200);assert.equal((await state(a)).stampCount,1);
 const grants=f.app.store.get('SELECT count(*) AS n FROM quest_grants');assert.equal(grants.n,2);
 const notices=await Promise.all([a.call('/api/quests/notices/claim','POST',{}),a.call('/api/quests/notices/claim','POST',{})]);assert.equal(notices.reduce((n,x)=>n+x.data.notices.length,0),1);
 assert.equal((await b.call('/api/quests/notices/claim','POST',{})).data.notices.length,1);
});

test('Meet needs two distinct real opt-in players, post-acceptance reciprocal waves in one bubble',async t=>{
 const f=await fixture();t.after(()=>f.app.close());const a=await f.guest('A'),b=await f.guest('B');
 assert.equal((await state(a)).available.some(q=>q.kind==='meet'),false);await connect(a);await connect(b);await wave(b);await accept(a,'meet');await wave(a);assert.equal((await state(a)).stampCount,0);await wave(b);assert.equal((await state(a)).stampCount,1);
 await accept(b,'meet');await wave(b);await move(a,8);await move(a,0);await wave(a);assert.equal((await state(b)).stampCount,0);await wave(b);assert.equal((await state(b)).stampCount,1);
 await wave(a);await wave(b);assert.equal((await state(a)).stampCount,1);assert.equal((await state(b)).stampCount,1);
});

test('Meet progress reflects only post-acceptance waves in the same current pair and resets on reconnect',async t=>{
 const f=await fixture();t.after(()=>f.app.close());const a=await f.guest('A'),b=await f.guest('B');
 await connect(a);await connect(b);await wave(a);await wave(b);await accept(a,'meet');
 let tracked=(await state(a)).tracked;assert.deepEqual(tracked.progress,{completed:0,total:2,ownWave:false,otherWave:false});
 await wave(a);tracked=(await state(a)).tracked;
 assert.deepEqual(tracked.progress,{completed:1,total:2,ownWave:true,otherWave:false});assert.equal(tracked.guidance.phase,'waiting-for-wave');
 assert.equal((await state(a)).stampCount,0);
 await b.call('/api/media/state','POST',{enabled:false});tracked=(await state(a)).tracked;assert.equal(tracked.available,false);assert.equal(tracked.progress,undefined);
 await connect(b);tracked=(await state(a)).tracked;assert.equal(tracked.progress.completed,0);assert.equal(tracked.guidance.phase,'send-wave');
 await wave(b);tracked=(await state(a)).tracked;assert.deepEqual(tracked.progress,{completed:1,total:2,ownWave:false,otherWave:true});assert.match(tracked.guidance.instruction,/Wave back/);
 await wave(a);assert.equal((await state(a)).stampCount,1);
});

test('room leave, media off and reconnect do not combine separate greeting sessions',async t=>{
 const f=await fixture();t.after(()=>f.app.close());const a=await f.guest('A'),b=await f.guest('B');await connect(a);await connect(b);await accept(a,'meet');await wave(a);
 await b.call('/api/media/state','POST',{enabled:false});await connect(b);await wave(b);assert.equal((await state(a)).stampCount,0);
 await wave(a);assert.equal((await state(a)).stampCount,1);
 const c=await f.guest('C');await connect(c);await accept(c,'meet');await wave(c);
 await c.call('/api/rooms/room/join','POST',{});await connect(c);await wave(a);assert.equal((await state(c)).stampCount,0);await wave(c);assert.equal((await state(c)).stampCount,1);
});

test('SQLite restart restores guest/account attempts, decline, private stamps and consumed notices',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'universe-quests-'));t.after(()=>rm(dir,{recursive:true,force:true}));const database=join(dir,'quests.sqlite');let f=await fixture({database});let a=await f.guest('Persistent');await accept(a,'explore');await move(a,6);await a.call('/api/quests/preferences','PATCH',{declined:true,signInDismissed:true});const stamp=(await state(a)).attempts[0].stampId;const cookie=a.cookie;await a.call('/api/quests/notices/claim','POST',{});await a.call('/api/account','POST',{username:'quest_owner',password:'quest test password'});await f.app.close();
 f=await fixture({database});t.after(()=>f.app.close());a=f.client();a.cookie=cookie;let saved=await state(a);assert.equal(saved.stampCount,1);assert.equal(saved.attempts[0].stampId,stamp);assert.equal(saved.preferences.declined,true);assert.equal(saved.pendingNotices,0);
 const otherDevice=f.client();assert.equal((await otherDevice.call('/api/login','POST',{username:'quest_owner',password:'quest test password'})).status,200);assert.equal((await state(otherDevice)).stampCount,1);
});

test('quest flag off preserves game, suppresses offers and cannot accept',async t=>{
 const f=await fixture({questsEnabled:false});t.after(()=>f.app.close());const a=await f.guest('A');assert.equal((await state(a)).enabled,false);assert.equal((await move(a,6)).status,200);assert.equal((await a.call('/api/quests/accept','POST',{roomId:'room',definitionId:'x',version:'v'})).status,503);
});

test('lost editor access, changed targets and forged identity never credit an accepted quest',async t=>{
 const f=await fixture();t.after(()=>f.app.close());const a=await f.guest('Owner'),b=await f.guest('Editor');await a.call(`/api/rooms/room/members/${b.user.id}`,'PUT',{role:'editor'});await accept(b,'build');await a.call(`/api/rooms/room/members/${b.user.id}`,'PUT',{role:'member'});
 assert.equal((await b.call('/api/rooms/room/scene','PUT',{revision:0,scene:{...scene,objects:[{id:'forged',type:'rug',x:2,z:2}]},userId:a.user.id})).status,403);assert.equal((await state(b)).stampCount,0);assert.equal((await state(b)).attempts[0].available,false);
 const explore=await accept(b,'explore');await a.call('/api/rooms/room/scene','PUT',{revision:0,scene:{...scene,areas:[{...scene.areas[0],x:5}]}});await move(b,6);assert.equal((await state(b)).stampCount,0);assert.equal((await state(b)).attempts.find(q=>q.id===explore.attemptId).target,null);
 const archived=await b.call('/api/quests/archive','POST',{attemptId:explore.attemptId});assert.equal(archived.data.attempts.find(q=>q.id===explore.attemptId).status,'archived');
});

test('a grant failure rolls back the scene, observation and attempt completion together',async t=>{
 const f=await fixture();t.after(()=>f.app.close());const a=await f.guest('Owner');await accept(a,'build');const run=f.app.store.run.bind(f.app.store);f.app.store.run=(sql,...args)=>{if(sql.startsWith('INSERT OR IGNORE INTO quest_grants'))throw new Error('Injected durable grant failure');return run(sql,...args);};
 const save={revision:0,scene:{...scene,objects:[{id:'atomic',type:'rug',x:2,z:2}]}};
 const failed=await a.call('/api/rooms/room/scene','PUT',save);assert.equal(failed.status,500);f.app.store.run=run;
 assert.equal((await a.call('/api/rooms/room')).data.room.revision,0);assert.equal((await state(a)).stampCount,0);assert.equal((await state(a)).attempts[0].status,'accepted');assert.equal(f.app.store.get('SELECT count(*) AS n FROM quest_observations').n,0);
 assert.equal((await a.call('/api/rooms/room/scene','PUT',save)).status,200);assert.equal((await state(a)).stampCount,1);
});

test('unsafe, sealed and whole-room entry targets are not offered',async t=>{
 const allArea={...scene,areas:[{id:'all',name:'Whole room',x:0,z:0,width:20,depth:20,action:'welcome'},{id:'door',name:'Automatic teleport',x:6,z:0,width:3,depth:3,action:'teleport',target:'elsewhere'}]};
 const f=await fixture({seeds:[{id:'world',name:'World',rooms:[{id:'room',name:'Room',scene:allArea}]}]});t.after(()=>f.app.close());const a=await f.guest('Owner');assert.equal((await state(a)).available.filter(q=>q.kind==='explore').length,0);
});
