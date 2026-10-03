// Actual loopback HTTP/SSE with SQLite. No browser, devices or external providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join as pathJoin} from 'node:path';
import {createGameServer} from '../server/app.mjs';
import {ARRIVAL_LIMITS} from '../src/arrivals.js';
import {canStand} from '../src/worlds.js';
import {proximityFixture} from './fixtures/proximity-config.mjs';
const area=(key,x,z,isDefault=false)=>({id:`area-${key}`,name:key==='cafe'?'Café welcome':'Stage doors',action:'welcome',x,z,width:8,depth:6,start:{key,isDefault}});
const plain=()=>({version:1,theme:'garden',bounds:{width:40,depth:30},spawn:{x:0,z:0},objects:[],areas:[]});
const destination=()=>({...plain(),spawn:{x:0,z:10},areas:[area('cafe',-9,-3,true),area('stage',9,-3,true)]});
const source=()=>({...plain(),objects:[{id:'portal',type:'portal',x:0,z:0,actions:[{id:'travel',type:'teleport',target:'other',entry:'stage',trigger:'interact'}]}]});
const seeds=()=>[{id:'world',name:'Arrivals',rooms:[{id:'r',name:'Source',scene:source()},{id:'other',name:'Destination',scene:destination()}]}];
async function fixture(t,options={}){
 let time=1800000000000;const app=createGameServer({database:':memory:',seeds:seeds(),clock:()=>time,questsEnabled:false,proximityMembershipConfig:proximityFixture,...options});const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`;t?.after(()=>app.close());
 function client(cookie=''){return{cookie,async call(path,method='GET',body){const response=await fetch(base+path,{method,headers:{cookie:this.cookie,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});const next=response.headers.get('set-cookie');if(next)this.cookie=next.split(';')[0];return{status:response.status,data:await response.json()};}};}
 async function user(name){const c=client(),response=await c.call('/api/session','POST',{name});assert.equal(response.status,201);c.user=response.data.user;return c;}
 function sibling(c,room='r'){const token=randomBytes(32).toString('base64url');app.store.run('INSERT INTO sessions VALUES(?,?,?,?)',createHash('sha256').update(token).digest('hex'),c.user.id,time+1e7,room);const copy=client(`universe_session=${token}`);copy.user=c.user;return copy;}
 return{app,base,user,client,sibling,advance:ms=>time+=ms};
}
const enter=(c,room='r',body={})=>c.call(`/api/rooms/${room}/join`,'POST',body);
async function save(c,room,mutate){const current=(await c.call(`/api/rooms/${room}`)).data.room,next=structuredClone(current.scene);mutate(next);return c.call(`/api/rooms/${room}/scene`,'PUT',{revision:current.revision,scene:next,personalAreaRevisions:Object.fromEntries(current.personalAreas.map(a=>[a.areaId,a.revision]))});}
const identity={roomId:'r',revision:0,entityType:'item',entityId:'portal',actionId:'travel'};
function delayed(f,c,path,input){let resolve,reject;const done=new Promise((a,b)=>{resolve=a;reject=b;}),request=http.request(f.base+path,{method:'POST',headers:{cookie:c.cookie,'content-type':'application/json'}},response=>{let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode,data:JSON.parse(text)}));});request.on('error',reject);request.write('{');return{done,ready:new Promise(resolve=>setTimeout(resolve,20)),finish(){request.end(JSON.stringify(input).slice(1));}};}
async function events(t,f,c){
 const controller=new AbortController(),events=[],waiters=new Set(),response=await fetch(f.base+'/api/events',{headers:{cookie:c.cookie},signal:controller.signal});assert.equal(response.status,200);const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
 const reading=(async()=>{try{for(;;){const{done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let end;while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);const event=block.match(/^event: (.+)$/m)?.[1],data=block.match(/^data: (.+)$/m)?.[1];if(event&&data){events.push({event,data:JSON.parse(data)});for(const check of waiters)check();}}}}catch(error){if(error.name!=='AbortError')throw error;}})();
 t.after(async()=>{controller.abort();await reading;});
 const result={events,wait(predicate,offset=0){const find=()=>events.slice(offset).find(predicate);if(find())return Promise.resolve(find());return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{waiters.delete(check);reject(Error('SSE arrival test timed out'));},2000);const check=()=>{const found=find();if(found){clearTimeout(timeout);waiters.delete(check);resolve(found);}};waiters.add(check);check();});}};await result.wait(e=>e.event==='hello');return result;
}
function coordinates(p){return{x:p.x,z:p.z,admissionId:p.admissionId,admissionEpoch:p.admissionEpoch,admissionRevision:p.admissionRevision};}
function assertInside(p,area){assert(Math.abs(p.x-area.x)<=area.width/2-ARRIVAL_LIMITS.inset);assert(Math.abs(p.z-area.z)<=area.depth/2-ARRIVAL_LIMITS.inset);}
async function control(c,s){const connectionId=s.events.filter(e=>e.event==='proximity-controls').at(-1)?.data.connectionId;const result=await c.call('/api/proximity-controls?connectionId='+connectionId);assert.equal(result.status,200,JSON.stringify(result));return result.data;}
function command(p,action,extra={}){return{...Object.fromEntries(['connectionId','roomId','memberId','bubbleId','membershipRevision','controlRevision','stateRevision'].map(key=>[key,p[key]])),action,operationId:randomUUID(),...extra};}

test('ARRIVAL-HTTP-01 named/default settings and target entries survive SQLite restart; public catalogs contain only named metadata',async t=>{
 const directory=await mkdtemp(pathJoin(tmpdir(),'universe-arrivals-')),database=pathJoin(directory,'game.sqlite');let f; t.after(async()=>{await f?.app.close();await rm(directory,{recursive:true,force:true});});f=await fixture(null,{database});const owner=await f.user('Owner');
 const saved=await save(owner,'other',scene=>{scene.areas[0].name='Renamed café';scene.areas[0].action='meeting';});assert.equal(saved.status,200);const catalog=(await owner.call('/api/rooms/other/entries')).data;assert.equal(catalog.revision,1);assert.deepEqual(catalog.entries.map(e=>Object.keys(e)),[['key','areaId','name','isDefault'],['key','areaId','name','isDefault']]);assert.equal(catalog.entries[0].key,'cafe');
 const oldEpoch=(await enter(owner,'other',{entry:'cafe',mode:'travel'})).data.arrival.admissionEpoch,cookie=owner.cookie;await f.app.close();f=null;f=await fixture(null,{database});assert.deepEqual((await f.client(cookie).call('/api/rooms/other/entries')).data,catalog);
 const stored=JSON.parse(f.app.store.get('SELECT scene FROM rooms WHERE id=?','r').scene);assert.equal(stored.objects[0].actions[0].entry,'stage');
 const arrived=await enter(f.client(cookie),'other',{entry:'cafe',mode:'travel'});assert.equal(arrived.status,200);assert.notEqual(arrived.data.arrival.admissionEpoch,oldEpoch);assert.equal(arrived.data.arrival.entry,'cafe');assertInside(arrived.data.arrival,saved.data.room.scene.areas[0]);
});

test('ARRIVAL-HTTP-02 first destination SSE publication, join position and live room/proximity presence agree',async t=>{
 const f=await fixture(t),watcher=await f.user('Watcher'),traveler=await f.user('Traveler');await enter(watcher,'other',{entry:'stage',mode:'travel'});await enter(traveler);const stream=await events(t,f,watcher),offset=stream.events.length;
 const response=await enter(traveler,'other',{entry:'stage',mode:'travel'});assert.equal(response.status,200,JSON.stringify(response));const accepted=response.data.arrival;
 const first=await stream.wait(e=>e.event==='presence'&&e.data.roomId==='other'&&e.data.presence.some(p=>p.id===traveler.user.id),offset),published=first.data.presence.find(p=>p.id===traveler.user.id);
 assert.deepEqual(coordinates(published),coordinates(accepted));assert.deepEqual(coordinates(response.data.presence.find(p=>p.id===traveler.user.id)),coordinates(accepted));
 assert.deepEqual(coordinates((await traveler.call('/api/rooms/other')).data.presence.find(p=>p.id===traveler.user.id)),coordinates(accepted));assertInside(accepted,destination().areas[1]);assert(canStand(destination(),accepted.x,accepted.z,ARRIVAL_LIMITS.radius));
 const policy=(await traveler.call('/api/media')).data;assert.equal(policy.roomId,'other');assert(policy.proximityMembership.memberId);assert.equal(f.app.presence.has(`r:${traveler.user.id}`),false);
});

test('ARRIVAL-HTTP-03 concurrent arrivals reserve distinct safe coordinates before any next publication',async t=>{
 const f=await fixture(t),clients=[];for(let i=0;i<14;i++)clients.push(await f.user('Visitor '+i));const results=await Promise.all(clients.map(c=>enter(c,'other',{entry:'cafe',mode:'travel'})));
 for(const result of results){assert.equal(result.status,200,JSON.stringify(result));assertInside(result.data.arrival,destination().areas[0]);}
 for(let a=0;a<results.length;a++)for(let b=a+1;b<results.length;b++)assert(Math.hypot(results[a].data.arrival.x-results[b].data.arrival.x,results[a].data.arrival.z-results[b].data.arrival.z)>=ARRIVAL_LIMITS.spacing);
 assert.equal(f.app.store.get('SELECT COUNT(*) AS count FROM sessions WHERE current_room_id=?','other').count,14);
});

test('ARRIVAL-HTTP-04 malformed and denied targets retain the prior room; unknown valid entries explicitly fall back',async t=>{
 const f=await fixture(t),owner=await f.user('Owner'),guest=await f.user('Guest');await enter(guest);const prior=coordinates(f.app.presence.get(`r:${guest.user.id}`));
 for(const body of [{entry:''},{entry:'../cafe'},{entry:'cafe',mode:'resume'},{entry:'cafe',x:4}]){assert.equal((await enter(guest,'other',body)).status,400);assert.equal((await guest.call('/api/session')).data.currentRoomId,'r');assert.deepEqual(coordinates(f.app.presence.get(`r:${guest.user.id}`)),prior);}
 assert.equal((await owner.call('/api/rooms/other','PATCH',{public:false})).status,200);assert.equal((await guest.call('/api/rooms/other/entries')).status,404);assert.equal((await enter(guest,'other',{entry:'stage',mode:'travel'})).status,404);assert.equal((await guest.call('/api/session')).data.currentRoomId,'r');
 await owner.call('/api/rooms/other','PATCH',{public:true});const unknown=await enter(guest,'other',{entry:'removed',mode:'travel'});assert.equal(unknown.status,200);assert.equal(unknown.data.arrival.fallback,'unknown-entry');assert.equal(unknown.data.arrival.requestedEntry,'removed');assert(['cafe','stage'].includes(unknown.data.arrival.entry));
});

test('ARRIVAL-HTTP-05 blocked and crowded recognized entries fail boundedly without retiring source consent or presence',async t=>{
 const tiny={...destination(),areas:[{...area('single',8,0,true),width:.9,depth:.9}]};const f=await fixture(t,{seeds:[{id:'world',name:'World',rooms:[{id:'r',name:'Source',scene:source()},{id:'other',name:'One slot',scene:tiny}]}]}),owner=await f.user('Owner'),guest=await f.user('Guest');await enter(owner,'other',{entry:'single',mode:'travel'});await enter(guest);const before=coordinates(f.app.presence.get(`r:${guest.user.id}`));
 const crowded=await enter(guest,'other',{entry:'single',mode:'travel'});assert.equal(crowded.status,409);assert.equal(crowded.data.code,'ARRIVAL_OCCUPIED');assert.equal(crowded.data.attempted,257);assert.deepEqual(coordinates(f.app.presence.get(`r:${guest.user.id}`)),before);
 // A direct persisted legacy/externally changed scene exercises runtime defense
 // separately from the editor, which refuses to save this blocked destination.
 tiny.objects=[{id:'block',type:'table',x:8,z:0,width:3,depth:3}];f.app.store.run('UPDATE rooms SET scene=?,revision=revision+1 WHERE id=?',JSON.stringify(tiny),'other');const blocked=await enter(guest,'other',{entry:'single',mode:'travel'});assert.equal(blocked.status,409);assert.equal(blocked.data.code,'ARRIVAL_BLOCKED');assert.equal((await guest.call('/api/session')).data.currentRoomId,'r');assert.deepEqual(coordinates(f.app.presence.get(`r:${guest.user.id}`)),before);
});

test('ARRIVAL-HTTP-06 canonical action identity rejects client target/entry substitution and source revision races',async t=>{
 const f=await fixture(t),owner=await f.user('Owner'),guest=await f.user('Guest');await enter(guest);
 const canonical=await guest.call('/api/rooms/r/actions/resolve','POST',{...identity,entry:'cafe',target:'r'});assert.equal(canonical.status,200);assert.equal(canonical.data.action.target,'other');assert.equal(canonical.data.action.entry,'stage');
 for(const [room,entry]of [['other','cafe'],['r','stage']]){const mismatch=await enter(guest,room,{entry,sourceAction:identity,mode:'travel'});assert.equal(mismatch.status,409);assert.equal(mismatch.data.code,'DESTINATION_MISMATCH');}
 const pending=delayed(f,guest,'/api/rooms/other/join',{sourceAction:identity,mode:'travel'});await pending.ready;assert.equal((await save(owner,'r',scene=>{scene.objects[0].actions[0].entry='cafe';})).status,200);pending.finish();assert.equal((await pending.done).data.code,'SCENE_CHANGED');assert.equal((await guest.call('/api/session')).data.currentRoomId,'r');
 const accepted=await enter(guest,'other',{sourceAction:{...identity,revision:1},mode:'travel'});assert.equal(accepted.status,200);assert.equal(accepted.data.arrival.entry,'cafe');
});

for(const mutation of ['room-private','parent-private','room-archived','ban','entry-removed'])test(`ARRIVAL-HTTP-07 fresh target authority and entry state handle ${mutation} during a streamed travel body`,async t=>{
 const f=await fixture(t),owner=await f.user('Owner'),guest=await f.user('Guest');await enter(guest);const prior=coordinates(f.app.presence.get(`r:${guest.user.id}`)),pending=delayed(f,guest,'/api/rooms/other/join',{sourceAction:identity,mode:'travel'});await pending.ready;
 if(mutation==='room-private')await owner.call('/api/rooms/other','PATCH',{public:false});
 if(mutation==='parent-private'){
  // Put source in another public parent, then privatize only target's parent.
  const world=(await owner.call('/api/worlds','POST',{name:'Isolated target parent'})).data.world;f.app.store.run('UPDATE rooms SET world_id=? WHERE id=?',world.id,'other');await owner.call(`/api/worlds/${world.id}`,'PATCH',{public:false});
 }
 if(mutation==='room-archived')await owner.call('/api/rooms/other','DELETE',{});
 if(mutation==='ban')await owner.call('/api/rooms/other/moderate','POST',{userId:guest.user.id,action:'ban'});
 if(mutation==='entry-removed')assert.equal((await save(owner,'other',scene=>{scene.areas=scene.areas.filter(a=>a.start.key!=='stage');})).status,200);
 pending.finish();const result=await pending.done;
 if(mutation==='entry-removed'){assert.equal(result.status,200);assert.equal(result.data.arrival.fallback,'unknown-entry');assert.equal(result.data.arrival.entry,'cafe');}
 else{assert.equal(result.status,404,JSON.stringify(result));assert.equal((await guest.call('/api/session')).data.currentRoomId,'r');assert.deepEqual(coordinates(f.app.presence.get(`r:${guest.user.id}`)),prior);assert.equal((await guest.call('/api/rooms/other/entries')).status,404);}
});

test('ARRIVAL-HTTP-08 same-room travel rotates the arrival; explicit resume preserves position; delayed/missing/old movement cannot rewind it',async t=>{
 const f=await fixture(t,{proximityMembershipConfig:undefined}),guest=await f.user('Guest');const first=await enter(guest,'other');const sibling=f.sibling(guest,'other'),old=first.data.arrival.admissionId,body={roomId:'other',x:0,z:0},held=delayed(f,sibling,'/api/presence',body);await held.ready;
 const travel=await enter(guest,'other',{mode:'travel',entry:'stage'});assert.equal(travel.status,200);assert.notEqual(travel.data.arrival.admissionId,old);body.admissionId=travel.data.arrival.admissionId;held.finish();assert.equal((await held.done).data.code,'STALE_ARRIVAL');
 for(const extra of [{},{admissionId:old}])assert.equal((await sibling.call('/api/presence','POST',{roomId:'other',x:0,z:0,...extra})).data.code,'STALE_ARRIVAL');
 const current=travel.data.arrival.admissionId;assert.equal((await guest.call('/api/presence','POST',{roomId:'other',x:8,z:1,admissionId:current})).status,200);const resumed=await enter(guest,'other',{mode:'resume'});assert.equal(resumed.data.arrival.resumed,true);assert.deepEqual(coordinates(resumed.data.arrival),{x:8,z:1,admissionId:current,admissionEpoch:travel.data.arrival.admissionEpoch,admissionRevision:travel.data.arrival.admissionRevision});
 // A legacy secondary rejoin cannot downgrade the modern admission fence.
 assert.equal((await enter(sibling,'other',{})).status,200);assert.equal((await sibling.call('/api/presence','POST',{roomId:'other',x:0,z:0})).data.code,'STALE_ARRIVAL');
});

test('ARRIVAL-HTTP-09 resume preserves consented following; failed travel keeps it; explicit same-room travel ends only traveler relation',async t=>{
 const f=await fixture(t),leader=await f.user('Leader'),follower=await f.user('Follower');await enter(leader);await enter(follower);const sl=await events(t,f,leader),sf=await events(t,f,follower);await sl.wait(e=>e.event==='proximity-controls');await sf.wait(e=>e.event==='proximity-controls');
 let p=await control(leader,sl);assert.equal((await leader.call('/api/proximity-controls/action','POST',command(p,'invite'))).status,200);p=await control(follower,sf);const accepted=await follower.call('/api/proximity-controls/action','POST',command(p,'accept',{invitationId:p.invitations[0].invitationId}));assert.equal(accepted.status,200);const lease=accepted.data.state.following.leaseId,before=coordinates(f.app.presence.get(`r:${follower.user.id}`));
 const resume=await enter(follower,'r',{mode:'resume'});assert.equal(resume.data.arrival.resumed,true);assert.deepEqual(coordinates(resume.data.arrival),before);assert.equal((await control(follower,sf)).following.leaseId,lease);
 assert.equal((await enter(follower,'missing',{mode:'travel'})).status,404);assert.equal((await control(follower,sf)).following.leaseId,lease);
 const leaderBefore=coordinates(f.app.presence.get(`r:${leader.user.id}`));assert.equal((await enter(follower,'r',{mode:'travel'})).status,200);await sf.wait(e=>e.event==='proximity-controls'&&e.data.connectionId!==accepted.data.state.connectionId);assert.equal((await control(follower,sf)).following,null);assert.deepEqual(coordinates(f.app.presence.get(`r:${leader.user.id}`)),leaderBefore);
});

test('ARRIVAL-HTTP-10 scene and personal-area authority reject unusable/forged starts and protect stable keys',async t=>{
 const f=await fixture(t),owner=await f.user('Owner'),guest=await f.user('Guest');
 const current=(await owner.call('/api/rooms/other')).data.room;
 for(const mutate of [s=>s.arrival={x:4,z:5},s=>s.areas[0].admissionId='forged',s=>s.areas[1].start.key='cafe',s=>s.areas[0].start.key='Upper',s=>s.areas[0].start.ownerId=guest.user.id,s=>s.areas[0].width=.5,s=>s.areas[0].x=-19,s=>s.objects.push({id:'block',type:'table',x:-9,z:-3,width:10,depth:8})]){const invalid=await save(owner,'other',mutate);assert.equal(invalid.status,400,JSON.stringify(invalid));assert.equal((await owner.call('/api/rooms/other')).data.room.revision,current.revision);}
 assert.equal((await save(guest,'other',s=>s.areas[0].start.isDefault=false)).status,403);
 assert.equal((await guest.call('/api/account','POST',{username:'arrival_guest',password:'Local test only password'})).status,201);
 assert.equal((await save(owner,'r',s=>s.areas=[{id:'personal',name:'Personal desk',action:'welcome',x:-8,z:0,width:8,depth:8,personalArea:{mode:'dynamic',allowedTags:[]}}])).status,200);
 await enter(guest);await guest.call('/api/presence','POST',{roomId:'r',x:-8,z:0});const room=(await guest.call('/api/rooms/r')).data.room;assert.equal((await guest.call('/api/rooms/r/personal-areas/personal/claim','POST',{revision:room.personalAreas[0].revision,clientOperationId:randomUUID()})).status,200);
 for(const mutate of [s=>s.areas[0].start={key:'personal',isDefault:true},s=>s.spawn={x:-8,z:0},s=>s.areas[0].x=-7])assert.equal((await save(guest,'r',mutate)).data.code,'PERSONAL_AREA_ONLY');
 const created=await owner.call('/api/rooms','POST',{worldId:'world',name:'Blocked import',scene:{...plain(),areas:[{...area('bad',8,0),width:.9,depth:.9}],objects:[{id:'solid',type:'table',x:8,z:0,width:3,depth:3}]}});assert.equal(created.status,400);assert.equal(created.data.code,'ARRIVAL_BLOCKED');
});

test('ARRIVAL-HTTP-11 legacy room-only bodyless joins still resolve a safe spawn and identifiers remain optional until opted in',async t=>{
 const f=await fixture(t,{proximityMembershipConfig:undefined}),user=await f.user('Legacy');const response=await user.call('/api/rooms/r/join','POST');assert.equal(response.status,200);assert.equal(response.data.arrival.source,'spawn');assert.deepEqual({x:response.data.arrival.x,z:response.data.arrival.z},{x:0,z:0});assert.equal((await user.call('/api/presence','POST',{roomId:'r',x:1,z:2})).status,200);
});

test('ARRIVAL-HTTP-12 sibling explicit same-room travel retires the shared actor controller and fences its old movement/control/media requests',async t=>{
 const f=await fixture(t),leader=await f.user('Leader'),follower=await f.user('Follower');await enter(leader);const first=await enter(follower),sl=await events(t,f,leader),sf=await events(t,f,follower);await sl.wait(e=>e.event==='proximity-controls');await sf.wait(e=>e.event==='proximity-controls');const sibling=f.sibling(follower),ss=await events(t,f,sibling);await ss.wait(e=>e.event==='proximity-controls');
 let p=await control(leader,sl);await leader.call('/api/proximity-controls/action','POST',command(p,'invite'));p=await control(follower,sf);const accepted=(await follower.call('/api/proximity-controls/action','POST',command(p,'accept',{invitationId:p.invitations[0].invitationId}))).data.state;
 const oldMove={roomId:'r',x:19,z:0,admissionId:first.data.arrival.admissionId,connectionId:accepted.connectionId,followLeaseId:accepted.following.leaseId},held=delayed(f,follower,'/api/presence',oldMove),heldControl=delayed(f,follower,'/api/proximity-controls/action',command(accepted,'stop')),heldMedia=delayed(f,follower,'/api/media/state',{roomId:'r',enabled:true,memberId:accepted.memberId});await Promise.all([held.ready,heldControl.ready,heldMedia.ready]);
 const leaderBefore=coordinates(f.app.presence.get(`r:${leader.user.id}`)),travel=await enter(sibling,'r',{mode:'travel'});assert.equal(travel.status,200);const arrived=coordinates(travel.data.arrival);assert.notEqual(arrived.admissionId,first.data.arrival.admissionId);
 for(const request of [held,heldControl]){request.finish();assert.equal((await request.done).status,409);}heldMedia.finish();const rejectedMedia=await heldMedia.done;assert([403,409].includes(rejectedMedia.status));
 assert.equal((await follower.call('/api/presence','POST',oldMove)).status,409);
 // Even knowing the new arrival ID cannot make the old follow-control lease valid.
 assert.equal((await follower.call('/api/presence','POST',{...oldMove,admissionId:arrived.admissionId})).status,409);
 await sf.wait(e=>e.event==='proximity-controls'&&e.data.connectionId!==accepted.connectionId);const after=await control(follower,sf);assert.equal(after.following,null);assert.notEqual(after.memberId,accepted.memberId);assert.equal((await follower.call('/api/media')).data.enabled,false);
 assert.deepEqual(coordinates(f.app.presence.get(`r:${follower.user.id}`)),arrived);assert.deepEqual(coordinates(f.app.presence.get(`r:${leader.user.id}`)),leaderBefore);
});

test('ARRIVAL-HTTP-13 same-timestamp sibling arrivals have ordered revisions and SSE hello scopes them to a process epoch',async t=>{
 const f=await fixture(t),user=await f.user('Ordered traveler'),first=await enter(user,'other',{mode:'travel',entry:'cafe'}),s=await events(t,f,user);assert.equal(s.events.find(e=>e.event==='hello').data.arrivalEpoch,first.data.arrival.admissionEpoch);
 const other=f.sibling(user,'other'),offset=s.events.length,second=await enter(other,'other',{mode:'travel',entry:'stage'}),third=await enter(user,'other',{mode:'travel',entry:'cafe'});
 assert.equal(first.data.arrival.admissionEpoch,second.data.arrival.admissionEpoch);assert.equal(second.data.arrival.admissionEpoch,third.data.arrival.admissionEpoch);assert(first.data.arrival.admissionRevision<second.data.arrival.admissionRevision);assert(second.data.arrival.admissionRevision<third.data.arrival.admissionRevision);
 await s.wait(e=>e.event==='presence'&&e.data.presence.some(p=>p.admissionId===third.data.arrival.admissionId),offset);const publications=s.events.slice(offset).filter(e=>e.event==='presence').flatMap(e=>e.data.presence).filter(p=>p.id===user.user.id);const revisions=[...new Set(publications.map(p=>p.admissionRevision))];assert.deepEqual(revisions,[second.data.arrival.admissionRevision,third.data.arrival.admissionRevision]);assert.equal(new Set(publications.map(p=>p.lastSeen)).size,1);
 const latest=(await user.call('/api/rooms/other')).data.presence.find(p=>p.id===user.user.id);assert.deepEqual(coordinates(latest),coordinates(third.data.arrival));const resumed=await enter(user,'other',{mode:'resume'});assert.equal(resumed.data.arrival.admissionRevision,third.data.arrival.admissionRevision);
});

test('ARRIVAL-HTTP-14 expired movement cannot replace a fresh safe arrival; resume and reconnect rotate placement identity',async t=>{
 const f=await fixture(t,{proximityMembershipConfig:undefined}),user=await f.user('Returning visitor'),first=await enter(user,'other',{mode:'travel',entry:'cafe'});f.advance(60000);
 const old=await user.call('/api/presence','POST',{roomId:'other',x:0,z:0,admissionId:first.data.arrival.admissionId});assert.equal(old.status,409);assert.equal(old.data.code,'POSITION_UNCONFIRMED');
 const resumed=await enter(user,'other',{mode:'resume'});assert.equal(resumed.status,200);assert.equal(resumed.data.arrival.resumed,false);assert(resumed.data.arrival.admissionRevision>first.data.arrival.admissionRevision);assert.notEqual(resumed.data.arrival.admissionId,first.data.arrival.admissionId);
 assert.equal((await user.call('/api/presence','POST',{roomId:'other',x:0,z:0,admissionId:first.data.arrival.admissionId})).data.code,'STALE_ARRIVAL');
 f.advance(60000);const stream=await events(t,f,user),published=await stream.wait(e=>e.event==='presence'&&e.data.presence.some(p=>p.id===user.user.id)),fresh=published.data.presence.find(p=>p.id===user.user.id);assert(fresh.admissionRevision>resumed.data.arrival.admissionRevision);assert(canStand(destination(),fresh.x,fresh.z,ARRIVAL_LIMITS.radius));assert.equal(fresh.moving,false);
});

test('ARRIVAL-HTTP-15 session opt-in survives both production TTL sweeps; legacy sessions stay compatible and deleted/expired sessions release guards',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const f=await fixture(t,{proximityMembershipConfig:undefined}),modern=await f.user('Modern'),legacy=await f.user('Legacy');const first=await enter(modern,'other',{mode:'travel',entry:'cafe'});await enter(legacy);
 const sibling=f.sibling(modern,'other');assert.equal((await enter(sibling,'other',{})).status,200);assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM arrival_session_guards').n,2);
 f.advance(60001);t.mock.timers.tick(30000); // Runs the actual expiry and subsequent metadata-pruning callbacks.
 assert.equal(f.app.presence.size,0);const s=await events(t,f,modern),pub=await s.wait(e=>e.event==='presence'&&e.data.presence.some(p=>p.id===modern.user.id)),current=pub.data.presence.find(p=>p.id===modern.user.id);assert.notEqual(current.admissionId,first.data.arrival.admissionId);
 for(const client of [modern,sibling])assert.equal((await client.call('/api/presence','POST',{roomId:'other',x:19,z:0})).data.code,'STALE_ARRIVAL');
 await events(t,f,legacy);assert.equal((await legacy.call('/api/presence','POST',{roomId:'r',x:1,z:1})).status,200);assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM arrival_session_guards').n,2);
 await modern.call('/api/logout','POST',{});assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM arrival_session_guards').n,1);
 f.app.store.run('UPDATE sessions SET expires_at=? WHERE user_id=?',0,modern.user.id);t.mock.timers.tick(15000);assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM arrival_session_guards').n,0);
});

test('ARRIVAL-HTTP-16 session protocol guard survives server restart and releases on logout without changing legacy-only sessions',async t=>{
 const directory=await mkdtemp(pathJoin(tmpdir(),'universe-arrival-guard-')),database=pathJoin(directory,'game.sqlite');let f;t.after(async()=>{await f?.app.close();await rm(directory,{recursive:true,force:true});});
 f=await fixture(null,{database,proximityMembershipConfig:undefined});const modern=await f.user('Modern'),legacy=await f.user('Legacy'),first=await enter(modern,'other',{mode:'travel',entry:'stage'});await enter(legacy);const modernCookie=modern.cookie,legacyCookie=legacy.cookie;await f.app.close();f=null;
 f=await fixture(null,{database,proximityMembershipConfig:undefined});const m=f.client(modernCookie),l=f.client(legacyCookie),s=await events(t,f,m),pub=await s.wait(e=>e.event==='presence'&&e.data.presence.some(p=>p.id===modern.user.id)),recovered=pub.data.presence.find(p=>p.id===modern.user.id);assert.notEqual(recovered.admissionEpoch,first.data.arrival.admissionEpoch);
 for(const extra of [{},{admissionId:first.data.arrival.admissionId}])assert.equal((await m.call('/api/presence','POST',{roomId:'other',x:19,z:0,...extra})).data.code,'STALE_ARRIVAL');
 assert.equal((await m.call('/api/presence','POST',{roomId:'other',x:1,z:1,admissionId:recovered.admissionId})).status,200);
 await events(t,f,l);assert.equal((await l.call('/api/presence','POST',{roomId:'r',x:1,z:1})).status,200);await m.call('/api/logout','POST',{});assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM arrival_session_guards').n,0);
});

test('ARRIVAL-HTTP-17 first-human arrival accounts for dormant enabled residents without activating a failed destination',async t=>{
 const tiny={...plain(),areas:[{...area('only',8,0,true),width:.9,depth:.9}]};const f=await fixture(t,{seeds:[{id:'world',name:'World',rooms:[{id:'r',name:'Source',scene:source()},{id:'other',name:'Dormant resident',scene:tiny}]}]}),owner=await f.user('Owner'),visitor=await f.user('Visitor');await enter(visitor);
 const created=await owner.call('/api/rooms/other/bots','POST',{clientOperationId:randomUUID(),config:{name:'Resident',spawn:{x:8,z:0},radius:0,behavior:'idle'}});assert.equal(created.status,201);assert.equal((await owner.call('/api/rooms/other')).data.bots.length,0);
 const before=coordinates(f.app.presence.get(`r:${visitor.user.id}`)),failed=await enter(visitor,'other',{mode:'travel',entry:'only'});assert.equal(failed.status,409);assert.equal(failed.data.code,'ARRIVAL_OCCUPIED');assert.deepEqual(coordinates(f.app.presence.get(`r:${visitor.user.id}`)),before);assert.equal((await owner.call('/api/rooms/other')).data.bots.length,0);
 assert.equal((await save(owner,'other',scene=>{scene.areas[0].width=4;scene.areas[0].depth=4;})).status,200);const accepted=await enter(visitor,'other',{mode:'travel',entry:'only'});assert.equal(accepted.status,200);assert.equal(accepted.data.bots.length,1);const bot=accepted.data.bots[0],arrival=accepted.data.arrival;assert(Math.hypot(bot.x-arrival.x,bot.z-arrival.z)>=ARRIVAL_LIMITS.spacing);
});

test('ARRIVAL-HTTP-18 sole-actor same-room travel predicts resident restart at home rather than its earlier patrol position',async t=>{
 t.mock.timers.enable({apis:['setInterval']});const scene={...plain(),areas:[{...area('only',8,0),width:.9,depth:.9}]};const f=await fixture(t,{seeds:[{id:'world',name:'World',rooms:[{id:'r',name:'Source',scene:source()},{id:'other',name:'Patrol room',scene}]}]}),owner=await f.user('Owner'),visitor=await f.user('Visitor');
 const created=await owner.call('/api/rooms/other/bots','POST',{clientOperationId:randomUUID(),config:{name:'Patroller',spawn:{x:8,z:0},radius:4,behavior:'patrol',waypoints:[{x:8,z:3}],speed:4,pauseMs:0}});assert.equal(created.status,201);await enter(visitor,'other',{mode:'travel'});
 f.advance(250);t.mock.timers.tick(250);const before=(await visitor.call('/api/rooms/other')).data.bots[0];assert(Math.hypot(before.x-8,before.z)>=.8);
 const position=coordinates(f.app.presence.get(`other:${visitor.user.id}`)),result=await enter(visitor,'other',{mode:'travel',entry:'only'});assert.equal(result.status,409);assert.equal(result.data.code,'ARRIVAL_OCCUPIED');assert.deepEqual(coordinates(f.app.presence.get(`other:${visitor.user.id}`)),position);assert.deepEqual((await visitor.call('/api/rooms/other')).data.bots[0],before);
});

test('ARRIVAL-HTTP-19 recovery resume cannot undo a later travel or kick, including an unfinished body',async t=>{
 const f=await fixture(t,{proximityMembershipConfig:undefined}),owner=await f.user('Owner'),visitor=await f.user('Visitor');assert.equal((await enter(visitor,'r',{mode:'resume'})).data.code,'RESUME_CONTEXT_CHANGED');await enter(visitor);assert.equal((await visitor.call('/api/session')).data.currentRoomId,'r');
 const pending=delayed(f,visitor,'/api/rooms/r/join',{mode:'resume'});await pending.ready;const newer=await enter(visitor,'other',{mode:'travel',entry:'cafe'});assert.equal(newer.status,200);pending.finish();assert.equal((await pending.done).data.code,'RESUME_CONTEXT_CHANGED');
 assert.equal((await enter(visitor,'r',{mode:'resume'})).data.code,'RESUME_CONTEXT_CHANGED');assert.equal((await visitor.call('/api/session')).data.currentRoomId,'other');assert.deepEqual(coordinates(f.app.presence.get(`other:${visitor.user.id}`)),coordinates(newer.data.arrival));
 const kicked=delayed(f,visitor,'/api/rooms/other/join',{mode:'resume'});await kicked.ready;assert.equal((await owner.call('/api/rooms/other/moderate','POST',{userId:visitor.user.id,action:'kick'})).status,200);kicked.finish();assert.equal((await kicked.done).data.code,'RESUME_CONTEXT_CHANGED');assert.equal((await enter(visitor,'other',{mode:'resume'})).data.code,'RESUME_CONTEXT_CHANGED');assert.equal((await visitor.call('/api/session')).data.currentRoomId,null);assert.equal(f.app.presence.has(`other:${visitor.user.id}`),false);
});

const placementIdentity=arrival=>Object.fromEntries(['admissionId','admissionEpoch','admissionRevision'].map(key=>[key,arrival[key]]));
test('ARRIVAL-HTTP-20 failed client initialization can retire only its exact current placement; duplicate cleanup is inert',async t=>{
 const f=await fixture(t),user=await f.user('Initializing visitor'),joined=await enter(user,'other',{mode:'travel',entry:'cafe'}),expected=placementIdentity(joined.data.arrival);
 const cleanup=await user.call('/api/rooms/other/leave','POST',expected);assert.deepEqual(cleanup,{status:200,data:{ok:true,applied:true}});assert.equal((await user.call('/api/session')).data.currentRoomId,null);assert.equal(f.app.presence.has(`other:${user.user.id}`),false);
 assert.deepEqual((await user.call('/api/rooms/other/leave','POST',expected)).data,{ok:true,applied:false,reason:'placement-changed'});
 await enter(user);assert.deepEqual((await user.call('/api/rooms/r/leave','POST')).data,{ok:true});assert.equal((await user.call('/api/session')).data.currentRoomId,null);
});

test('ARRIVAL-HTTP-21 conditional cleanup requires all three exact placement fields and cannot override its actor',async t=>{
 const f=await fixture(t),user=await f.user('Actor'),other=await f.user('Other'),joined=await enter(user,'other',{mode:'travel'}),expected=placementIdentity(joined.data.arrival),before=coordinates(f.app.presence.get(`other:${user.user.id}`));
 for(const bad of [{admissionId:expected.admissionId},{admissionEpoch:expected.admissionEpoch},{...expected,admissionRevision:0},{...expected,admissionRevision:'1'},{...expected,userId:other.user.id},{...expected,roomId:'r'}])assert.equal((await user.call('/api/rooms/other/leave','POST',bad)).status,400);
 for(const patch of [{admissionId:randomUUID()},{admissionEpoch:randomUUID()},{admissionRevision:expected.admissionRevision+1}])assert.equal((await user.call('/api/rooms/other/leave','POST',{...expected,...patch})).data.applied,false);
 assert.equal((await user.call('/api/rooms/r/leave','POST',expected)).data.applied,false);assert.deepEqual(coordinates(f.app.presence.get(`other:${user.user.id}`)),before);assert.equal((await user.call('/api/session')).data.currentRoomId,'other');
});

for(const change of ['same-room-sibling','different-room','same-placement-rejoin','epoch-change','revision-change'])test(`ARRIVAL-HTTP-22 body-time ${change} makes conditional cleanup inert even if final JSON is rebound`,async t=>{
 const f=await fixture(t),user=await f.user('Actor'),joined=await enter(user,'other',{mode:'travel',entry:'cafe'}),expected=placementIdentity(joined.data.arrival),sibling=f.sibling(user,'other'),held=delayed(f,user,'/api/rooms/other/leave',expected);await held.ready;
 let roomId='other';
 if(change==='same-room-sibling'){const newer=await enter(sibling,'other',{mode:'travel',entry:'stage'});Object.assign(expected,placementIdentity(newer.data.arrival));}
 if(change==='different-room'){await enter(user,'r',{mode:'travel'});roomId='r';}
 if(change==='same-placement-rejoin'){const newer=await enter(user,'other',{});assert.equal(newer.data.arrival.admissionId,joined.data.arrival.admissionId);}
 if(change==='epoch-change'){const person=f.app.presence.get(`other:${user.user.id}`);person.admissionEpoch=randomUUID();expected.admissionEpoch=person.admissionEpoch;} // Models an exact-identity mismatch independently of opaque ID equality.
 if(change==='revision-change'){const person=f.app.presence.get(`other:${user.user.id}`);person.admissionRevision++;expected.admissionRevision=person.admissionRevision;}
 const before=coordinates(f.app.presence.get(`${roomId}:${user.user.id}`));held.finish();const result=await held.done;assert.deepEqual(result.data,{ok:true,applied:false,reason:'placement-changed'});assert.equal((await user.call('/api/session')).data.currentRoomId,roomId);assert.deepEqual(coordinates(f.app.presence.get(`${roomId}:${user.user.id}`)),before);
});

test('ARRIVAL-HTTP-23 conditional cleanup cannot mutate a denied room or an expired session',async t=>{
 const f=await fixture(t),owner=await f.user('Owner'),guest=await f.user('Guest'),joined=await enter(guest),expected=placementIdentity(joined.data.arrival);await owner.call('/api/rooms/other','PATCH',{public:false});assert.equal((await guest.call('/api/rooms/other/leave','POST',expected)).status,404);assert.equal((await guest.call('/api/session')).data.currentRoomId,'r');
 const held=delayed(f,guest,'/api/rooms/r/leave',expected);await held.ready;f.app.store.run('UPDATE sessions SET expires_at=? WHERE user_id=?',0,guest.user.id);held.finish();assert.equal((await held.done).status,401);assert.equal(f.app.store.get('SELECT current_room_id FROM sessions WHERE user_id=?',guest.user.id).current_room_id,'r');assert.deepEqual(coordinates(f.app.presence.get(`r:${guest.user.id}`)),coordinates(joined.data.arrival));
});

test('ARRIVAL-HTTP-24 declined conditional cleanup preserves participant, resident, media and accepted-follow state',async t=>{
 const f=await fixture(t),leader=await f.user('Leader'),follower=await f.user('Follower');await enter(leader);const joined=await enter(follower),sl=await events(t,f,leader),sf=await events(t,f,follower);await sl.wait(e=>e.event==='proximity-controls');await sf.wait(e=>e.event==='proximity-controls');
 assert.equal((await leader.call('/api/rooms/r/bots','POST',{clientOperationId:randomUUID(),config:{name:'Still resident',spawn:{x:8,z:0},radius:0,behavior:'idle'}})).status,201);
 await leader.call('/api/proximity-controls/action','POST',command(await control(leader,sl),'invite'));const invited=await control(follower,sf);assert.equal((await follower.call('/api/proximity-controls/action','POST',command(invited,'accept',{invitationId:invited.invitations[0].invitationId}))).status,200);
 const beforeControl=await control(follower,sf);assert.equal((await follower.call('/api/media/state','POST',{enabled:true,roomId:'r',memberId:beforeControl.memberId})).status,200);const beforeMedia=(await follower.call('/api/media')).data,beforeRoom=(await follower.call('/api/rooms/r')).data;
 const result=await follower.call('/api/rooms/r/leave','POST',{...placementIdentity(joined.data.arrival),admissionRevision:joined.data.arrival.admissionRevision+1});assert.equal(result.data.applied,false);
 const afterControl=await control(follower,sf);for(const key of ['connectionId','memberId','bubbleId','controlRevision','stateRevision','following'])assert.deepEqual(afterControl[key],beforeControl[key]);assert.deepEqual((await follower.call('/api/media')).data,beforeMedia);const afterRoom=(await follower.call('/api/rooms/r')).data;assert.deepEqual(afterRoom.presence,beforeRoom.presence);assert.deepEqual(afterRoom.bots,beforeRoom.bots);
});

test('ARRIVAL-HTTP-25 modern default entry admits a separately logged-in observer without relocating its controller or retiring consent',async t=>{
 const f=await fixture(t),leader=await f.user('Leader'),controller=await f.user('Controller');const username='arrival_enter_controller',password='Synthetic local fixture password';assert.equal((await controller.call('/api/account','POST',{username,password})).status,201);
 await enter(leader);const admitted=await enter(controller),sl=await events(t,f,leader),sc=await events(t,f,controller);await sl.wait(e=>e.event==='proximity-controls');await sc.wait(e=>e.event==='proximity-controls');
 await leader.call('/api/proximity-controls/action','POST',command(await control(leader,sl),'invite'));let context=await control(controller,sc);const accepted=(await controller.call('/api/proximity-controls/action','POST',command(context,'accept',{invitationId:context.invitations[0].invitationId}))).data.state;assert(accepted.following.controlling);
 assert.equal((await controller.call('/api/media/state','POST',{enabled:true,roomId:'r',memberId:accepted.memberId})).status,200);const motion={roomId:'r',x:2,z:0,admissionId:admitted.data.arrival.admissionId,connectionId:accepted.connectionId,followLeaseId:accepted.following.leaseId};assert.equal((await controller.call('/api/presence','POST',motion)).status,200);const before=coordinates(f.app.presence.get(`r:${controller.user.id}`));
 const observer=f.client(),login=await observer.call('/api/login','POST',{username,password});assert.equal(login.status,200);assert.equal(login.data.currentRoomId,null);observer.user=login.data.user;assert.equal(observer.user.id,controller.user.id);const so=await events(t,f,observer);
 const observed=await enter(observer,'r',{mode:'enter'});assert.equal(observed.status,200);assert.equal(observed.data.arrival.resumed,true);assert.deepEqual(coordinates(observed.data.arrival),before);assert.deepEqual(coordinates(f.app.presence.get(`r:${controller.user.id}`)),before);
 await so.wait(e=>e.event==='proximity-controls'&&e.data.roomId==='r'&&e.data.memberId===accepted.memberId);context=await control(controller,sc);assert.equal(context.connectionId,accepted.connectionId);assert.equal(context.following.leaseId,accepted.following.leaseId);assert.equal(context.following.controlling,true);assert.equal((await controller.call('/api/media')).data.enabled,true);assert.equal((await observer.call('/api/media')).data.enabled,false);
 const observing=await control(observer,so);assert.equal(observing.memberId,accepted.memberId);assert.equal(observing.following.controlling,false);assert.equal(observing.following.leaseId,null);
 assert.equal((await observer.call('/api/presence','POST',{roomId:'r',x:19,z:0})).data.code,'STALE_ARRIVAL');assert.equal((await enter(observer,'r',{})).status,200);assert.equal((await observer.call('/api/presence','POST',{roomId:'r',x:19,z:0})).data.code,'STALE_ARRIVAL');assert.equal((await controller.call('/api/presence','POST',motion)).status,200);assert.equal((await control(controller,sc)).following.leaseId,accepted.following.leaseId);
});

test('ARRIVAL-HTTP-26 modern default entry creates a guarded normal arrival and rejects named/action destination overrides',async t=>{
 const f=await fixture(t),user=await f.user('New session');const first=await enter(user,'other',{mode:'enter'});assert.equal(first.status,200);assert.equal(first.data.arrival.source,'default');assert.equal(first.data.arrival.resumed,false);assert(['cafe','stage'].includes(first.data.arrival.entry));
 assert.equal((await user.call('/api/presence','POST',{roomId:'other',x:1,z:1})).data.code,'STALE_ARRIVAL');assert.equal((await user.call('/api/presence','POST',{roomId:'other',x:1,z:1,admissionId:first.data.arrival.admissionId})).status,200);
 for(const body of [{mode:'enter',entry:'cafe'},{mode:'enter',sourceAction:identity}])assert.equal((await enter(user,'other',body)).status,400);assert.equal((await user.call('/api/session')).data.currentRoomId,'other');
 const explicit=await enter(user,'other',{mode:'travel',entry:'stage'});assert.equal(explicit.status,200);assert.notEqual(explicit.data.arrival.admissionId,first.data.arrival.admissionId);assert.equal(explicit.data.arrival.entry,'stage');
});
