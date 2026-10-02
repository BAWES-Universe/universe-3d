import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds} from '../src/worlds.js';

const area=(id,x=-6,mode='dynamic',tags=[])=>({id,name:id,x,z:0,width:8,depth:8,action:'welcome',personalArea:{mode,allowedTags:tags}});
const scene=(areas=[area('desk-a')])=>({version:1,theme:'garden',bounds:{width:32,depth:26},spawn:{x:0,z:10},objects:[],areas});
async function start(database=':memory:'){
  const app=createGameServer({database,seeds:seedWorlds});const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`;
  const client=()=>({cookie:'',async call(path,method='GET',body){const response=await fetch(base+path,{method,headers:{Cookie:this.cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});if(response.headers.get('set-cookie'))this.cookie=response.headers.get('set-cookie').split(';')[0];return{status:response.status,data:await response.json()};}});
  async function account(name,registered=true){const c=client();c.user=(await c.call('/api/session','POST',{name})).data.user;if(registered)assert.equal((await c.call('/api/account','POST',{username:'u_'+randomUUID().replaceAll('-','').slice(0,20),password:'local test account password'})).status,201);return c;}
  return{app,port,base,client,account};
}
async function setup(t,areas=[area('desk-a')]){
  const f=await start();t.after(()=>f.app.close());const owner=await f.account('Manager'),alice=await f.account('Alice'),bob=await f.account('Bob');
  const world=(await owner.call('/api/worlds','POST',{name:'Personal area world'})).data.world;
  const r=await owner.call('/api/rooms','POST',{worldId:world.id,name:'Desks',scene:scene(areas)});assert.equal(r.status,201,JSON.stringify(r));const room=r.data.room;
  return{...f,owner,alice,bob,world,room};
}
async function latest(c,r){return(await c.call(`/api/rooms/${r.id}`)).data.room;}
async function enter(c,r,areaId='desk-a'){await c.call(`/api/rooms/${r.id}/join`,'POST',{});const a=(await latest(c,r)).personalAreas.find(a=>a.areaId===areaId);assert.equal((await c.call('/api/presence','POST',{roomId:r.id,x:a.x,z:a.z})).status,200);}
async function claim(c,r,areaId='desk-a',extra={}){const current=await latest(c,r),a=current.personalAreas.find(a=>a.areaId===areaId);return c.call(`/api/rooms/${r.id}/personal-areas/${areaId}/claim`,'POST',{revision:a.revision,clientOperationId:randomUUID(),...extra});}
async function save(c,r,transform,extra={}){const current=await latest(c,r),next=structuredClone(current.scene);transform(next);return c.call(`/api/rooms/${r.id}/scene`,'PUT',{revision:current.revision,scene:next,personalAreaRevisions:Object.fromEntries(current.personalAreas.map(a=>[a.areaId,a.revision])),...extra});}
async function revoke(c,r,areaId='desk-a',handling='keep',extra={}){const current=await latest(c,r),a=current.personalAreas.find(a=>a.areaId===areaId);return c.call(`/api/rooms/${r.id}/personal-areas/${areaId}/revoke`,'POST',{revision:a.revision,roomRevision:current.revision,objectHandling:handling,clientOperationId:randomUUID(),...extra});}
const chair=(id,x=-6,z=0,extra={})=>({id,type:'chair',name:id,x,z,rotation:0,...extra});

test('EDIT-21 dynamic entry requires registered account, any world-local allowed tag; empty tags allow all accounts',async t=>{
  const f=await setup(t,[area('desk-a',-6,'dynamic',['artist','builder']),area('desk-open',6)]);const{owner,alice,bob,room,world}=f;
  const guest=await f.account('Anonymous',false);await enter(guest,room,'desk-open');assert.equal((await claim(guest,room,'desk-open')).data.code,'LOCAL_ACCOUNT_REQUIRED');
  await enter(alice,room);assert.equal((await claim(alice,room)).status,403);
  const otherWorld=(await owner.call('/api/worlds','POST',{name:'Other tags'})).data.world;await owner.call(`/api/worlds/${otherWorld.id}/members/${alice.user.id}`,'PUT',{role:'member',tags:['artist']});assert.equal((await claim(alice,room)).status,403);
  await owner.call(`/api/worlds/${world.id}/members/${alice.user.id}`,'PUT',{role:'member',tags:['builder']});assert.equal((await claim(alice,room)).status,200);
  await enter(bob,room,'desk-open');assert.equal((await claim(bob,room,'desk-open')).status,200);
  const owned=await latest(alice,room);assert.equal(owned.role,'member');assert.equal(owned.capabilities.canEditScene,false);assert.equal(owned.capabilities.canManageMembers,false);assert.equal(owned.capabilities.canBuild,true);assert.deepEqual(owned.capabilities.editableAreaIds,['desk-a']);
});

test('EDIT-21 atomic A/B claim race, durable decline and retry reconcile without resurrecting ownership',async t=>{
  const{owner,alice,bob,room}=await setup(t);await enter(alice,room);await enter(bob,room);
  const decline={revision:0,clientOperationId:'decline-once'};assert.equal((await alice.call(`/api/rooms/${room.id}/personal-areas/desk-a/decline`,'POST',decline)).status,200);
  assert.equal((await latest(alice,room)).personalAreas[0].declined,true);assert.equal((await latest(bob,room)).personalAreas[0].declined,false);
  const payload={revision:0,clientOperationId:'claim-once'};const responses=await Promise.all([alice.call(`/api/rooms/${room.id}/personal-areas/desk-a/claim`,'POST',payload),bob.call(`/api/rooms/${room.id}/personal-areas/desk-a/claim`,'POST',payload)]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  const winner=responses[0].status===200?alice:bob;const duplicate=await winner.call(`/api/rooms/${room.id}/personal-areas/desk-a/claim`,'POST',payload);assert.equal(duplicate.data.duplicate,true);
  assert.equal((await revoke(owner,room)).status,200);const stale=await winner.call(`/api/rooms/${room.id}/personal-areas/desk-a/claim`,'POST',payload);assert.equal(stale.status,200);assert.equal(stale.data.area.ownerId,null);assert.equal(stale.data.room.capabilities.canBuild,false);
  assert.equal((await winner.call(`/api/rooms/${room.id}/personal-areas/desk-a/claim`,'POST',{...payload,revision:2})).data.code,'OPERATION_REUSED');
  assert.equal((await winner.call(`/api/rooms/${room.id}/personal-areas/desk-a/claim`,'POST',{...payload,clientOperationId:'stale-new'})).status,409);
});

test('EDIT-21 owner may edit real bounded objects/actions, never room settings, others areas, foreign objects, or forged authority',async t=>{
  const{owner,alice,bob,room}=await setup(t,[area('desk-a'),area('desk-b',6)]);await enter(alice,room);assert.equal((await claim(alice,room)).status,200);await enter(bob,room,'desk-b');assert.equal((await claim(bob,room,'desk-b')).status,200);
  let result=await save(alice,room,s=>s.objects.push(chair('alice-chair',-6,0,{actions:[{id:'note',type:'message',message:'A working item',trigger:'interact'}]})));assert.equal(result.status,200,JSON.stringify(result));
  result=await save(alice,room,s=>{s.objects[0].name='A renamed chair';});assert.equal(result.status,200);
  for(const mutate of [s=>s.theme='assembly',s=>s.spawn.x=-6,s=>s.areas[0].name='Changed',s=>s.objects.push(chair('outside',12)),s=>s.objects.push(chair('partial-edge',-2.1)),s=>s.objects.push(chair('scale-bypass',-2.1,0,{scale:.01})),s=>s.objects.push(chair('size-bypass',-2.1,0,{type:'plant',width:.01,depth:.01,rotationY:90})),s=>{s.objects[0].x=6;},s=>s.objects.push(chair('rotated-edge',-3,0,{type:'table',width:6,depth:1,rotation:45}))])assert.equal((await save(alice,room,mutate)).status,403);
  assert.equal((await save(owner,room,s=>s.objects.push(chair('manager-chair',12)))).status,200);
  assert.equal((await save(alice,room,s=>{s.objects=s.objects.filter(o=>o.id!=='manager-chair');})).status,403);
  for(const mutate of [s=>{s.objects[0].ownerId=bob.user.id;},s=>{s.areas[0].personalArea.ownerId=alice.user.id;}])assert.equal((await save(alice,room,mutate)).status,400);
  assert.equal((await save(alice,room,s=>{s.objects[0].name='stale';},{personalAreaRevisions:{'desk-a':0}})).status,409);
  assert.equal((await save(alice,room,s=>{s.objects[0].name='forge';},{actorId:owner.user.id})).status,400);
  assert.equal((await alice.call(`/api/rooms/${room.id}`,'PATCH',{name:'No room grant'})).status,403);
  assert.equal((await alice.call(`/api/rooms/${room.id}/personal-areas/desk-b/assign`,'POST',{revision:1,userId:alice.user.id,clientOperationId:'forge-assign'})).status,403);
});

test('EDIT-21 overlapping personal areas do not grant access through another owner’s footprint',async t=>{
  const{owner,alice,bob,room}=await setup(t,[area('desk-a',-2,'static'),area('desk-b',2,'static')]);await enter(alice,room);await enter(bob,room,'desk-b');
  for(const [id,c]of [['desk-a',alice],['desk-b',bob]])assert.equal((await owner.call(`/api/rooms/${room.id}/personal-areas/${id}/assign`,'POST',{revision:0,userId:c.user.id,clientOperationId:randomUUID()})).status,200);
  const result=await save(alice,room,s=>s.objects.push(chair('safe',-4)));assert.equal(result.status,200,JSON.stringify(result));
  assert.equal((await save(alice,room,s=>s.objects.push(chair('overlap',0)))).status,403);
});

test('EDIT-21 static picker is scoped and registered-only; assignment grants no room or world authority',async t=>{
  const{owner,alice,bob,world,room}=await setup(t,[area('desk-a',-6,'static')]);
  assert.equal((await alice.call(`/api/rooms/${room.id}/personal-areas/accounts?query=Al`)).status,403);
  assert.equal((await owner.call(`/api/rooms/${room.id}/personal-areas/accounts?query=Al`)).data.users.length,0);
  assert.equal((await owner.call(`/api/rooms/${room.id}/personal-areas/desk-a/assign`,'POST',{revision:0,userId:alice.user.id,clientOperationId:'outside'})).status,400);
  await owner.call(`/api/worlds/${world.id}/members/${alice.user.id}`,'PUT',{role:'member'});
  assert.equal((await owner.call(`/api/rooms/${room.id}/personal-areas/accounts?query=Al`)).data.users[0].id,alice.user.id);
  assert.equal((await owner.call(`/api/rooms/${room.id}/personal-areas/desk-a/assign`,'POST',{revision:0,userId:alice.user.id,clientOperationId:'assign'})).status,200);
  assert.equal((await latest(alice,room)).capabilities.canEditScene,false);assert.equal((await latest(bob,room)).capabilities.canBuild,false);
  assert.equal((await claim(bob,room)).status,409);
  assert.equal((await revoke(owner,room)).status,200);assert.equal((await latest(alice,room)).personalAreas[0].mode,'static');assert.equal((await latest(alice,room)).personalAreas[0].canClaim,false);
});

test('EDIT-21 revoke keep/remove-owned are explicit and preserve manager/previous-owner objects',async t=>{
  const{app,owner,alice,bob,room}=await setup(t);await enter(alice,room);await claim(alice,room);await save(alice,room,s=>s.objects.push(chair('alice-item')));await save(owner,room,s=>s.objects.push(chair('manager-item',-7)));
  let current=await latest(owner,room);assert.equal(current.personalAreas[0].objectCount,2);assert.equal(current.personalAreas[0].ownedObjectCount,1);
  assert.equal((await owner.call(`/api/rooms/${room.id}/personal-areas/desk-a/revoke`,'POST',{revision:1,roomRevision:current.revision,clientOperationId:'no-choice'})).status,400);
  assert.equal((await revoke(owner,room,'desk-a','keep')).status,200);assert.equal((await latest(owner,room)).scene.objects.length,2);
  await enter(bob,room);await claim(bob,room);await save(bob,room,s=>s.objects.push(chair('bob-item',-5)));
  current=await latest(owner,room);assert.equal(current.personalAreas[0].objectCount,3);assert.equal(current.personalAreas[0].ownedObjectCount,1);
  const removed=await revoke(owner,room,'desk-a','remove-owned');assert.equal(removed.status,200);assert.deepEqual(removed.data.operation.removedObjectIds,['bob-item']);assert.deepEqual(removed.data.room.scene.objects.map(o=>o.id),['alice-item','manager-item']);
  assert.equal(app.store.get('SELECT COUNT(*) AS n FROM personal_area_objects WHERE room_id=?',room.id).n,2);
  assert.equal((await save(bob,room,s=>s.objects.push(chair('revoked')))).status,403);
});

test('EDIT-21 dynamic transfer is one atomic current-room operation and keeps old entities',async t=>{
  const{owner,alice,room,world}=await setup(t,[area('desk-a'),area('desk-b',6)]);await enter(alice,room);await claim(alice,room);await save(alice,room,s=>s.objects.push(chair('old-desk-item')));
  const elsewhere=(await owner.call('/api/rooms','POST',{worldId:world.id,name:'Another room',scene:scene()})).data.room;await enter(alice,elsewhere);await claim(alice,elsewhere);await enter(alice,room,'desk-b');
  const first=await claim(alice,room,'desk-b');assert.equal(first.data.code,'PERSONAL_AREA_TRANSFER_REQUIRED');assert.equal(first.data.ownedAreas[0].areaId,'desk-a');
  assert.equal((await claim(alice,room,'desk-b',{confirmedTransfer:true,roomRevision:0})).status,409);
  const current=await latest(alice,room);const transferred=await claim(alice,room,'desk-b',{confirmedTransfer:true,roomRevision:current.revision});assert.equal(transferred.status,200);assert.deepEqual(transferred.data.operation.transferredAreaIds,['desk-a']);assert.equal(transferred.data.room.personalAreas[0].ownerId,null);assert.equal(transferred.data.room.personalAreas[1].ownerId,alice.user.id);assert.equal(transferred.data.room.scene.objects[0].id,'old-desk-item');assert.equal(transferred.data.room.scene.areas[1].name,"Alice's personal space");assert.equal((await latest(alice,elsewhere)).personalAreas[0].ownerId,alice.user.id);
});

test('EDIT-21 stale manager warning cannot remove item committed before revoke',async t=>{
  const{owner,alice,room}=await setup(t);await enter(alice,room);await claim(alice,room);const warning=await latest(owner,room);await save(alice,room,s=>s.objects.push(chair('late-item')));
  assert.equal((await revoke(owner,room,'desk-a','remove-owned',{roomRevision:warning.revision})).status,409);const stillOwned=await latest(alice,room);assert.equal(stillOwned.personalAreas[0].ownerId,alice.user.id);assert.equal(stillOwned.scene.objects[0].id,'late-item');
});

function partialScene(port,cookie,roomId,payload){let request;const encoded=JSON.stringify(payload),mid=Math.floor(encoded.length/2);const result=new Promise((resolve,reject)=>{request=http.request({host:'127.0.0.1',port,path:`/api/rooms/${roomId}/scene`,method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json','Transfer-Encoding':'chunked'}},response=>{let raw='';response.on('data',b=>raw+=b);response.on('end',()=>resolve({status:response.statusCode,data:JSON.parse(raw)}));});request.on('error',reject);request.write(encoded.slice(0,mid));});return{finish:()=>request.end(encoded.slice(mid)),result};}
for(const mutation of ['revoke','private-ancestor','logout'])test(`EDIT-21 streamed object save reauthorizes after last-moment ${mutation}`,async t=>{
  const{app,port,owner,alice,room,world}=await setup(t);await enter(alice,room);await claim(alice,room);const current=await latest(alice,room);current.scene.objects.push(chair('inflight'));
  let admitted;const ready=new Promise(resolve=>admitted=resolve),authorize=app.store.authorize.bind(app.store);app.store.authorize=(roomId,userId,roles)=>{const answer=authorize(roomId,userId,roles);if(userId===alice.user.id)admitted();return answer;};
  const upload=partialScene(port,alice.cookie,room.id,{revision:current.revision,scene:current.scene,personalAreaRevisions:{'desk-a':1}});await ready;
  if(mutation==='revoke')await revoke(owner,room);if(mutation==='private-ancestor')await owner.call(`/api/worlds/${world.id}`,'PATCH',{public:false});if(mutation==='logout')await alice.call('/api/logout','POST',{});
  upload.finish();const response=await upload.result;assert.ok([401,403,404,409].includes(response.status),JSON.stringify(response));assert.equal((await latest(owner,room)).scene.objects.some(o=>o.id==='inflight'),false);
});

test('EDIT-21 claimed geometry cannot be changed/removed without explicit revoke; legacy full editors still save',async t=>{
  const{owner,alice,room}=await setup(t);await enter(alice,room);await claim(alice,room);
  for(const mutate of [s=>s.areas=[],s=>s.areas[0].x=0,s=>s.areas[0].personalArea.mode='static'])assert.equal((await save(owner,room,mutate)).data.code,'PERSONAL_AREA_CLAIMED');
  assert.equal((await save(owner,room,s=>s.objects.push(chair('full-editor-outside',12)),{personalAreaRevisions:undefined})).status,200);
  await revoke(owner,room);assert.equal((await save(owner,room,s=>s.areas=[])).status,200);assert.equal((await latest(owner,room)).personalAreas.length,0);
});

test('NAV desk resolves first current-room owned area in scene order, never caller identity or private ancestors',async t=>{
  const{owner,alice,bob,room,world}=await setup(t,[area('desk-z',6,'static'),area('desk-a',-6,'static')]);await enter(alice,room,'desk-z');
  for(const id of ['desk-a','desk-z'])await owner.call(`/api/rooms/${room.id}/personal-areas/${id}/assign`,'POST',{revision:0,userId:alice.user.id,clientOperationId:randomUUID()});
  const desk=(await alice.call('/api/desk')).data;assert.equal(desk.target.areaId,'desk-z');assert.equal(desk.target.x,6);assert.equal(desk.desks.length,2);
  assert.equal((await bob.call(`/api/desk?roomId=${room.id}&userId=${alice.user.id}`)).data.target,null);
  await owner.call(`/api/worlds/${world.id}`,'PATCH',{public:false});assert.equal((await alice.call(`/api/desk?roomId=${room.id}`)).status,404);assert.equal((await alice.call('/api/desk')).data.target,null);
});

test('EDIT-21 SQLite restart persists owners, operation receipts, declines, attribution and item handling',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'personal-areas-'));t.after(()=>rm(dir,{recursive:true,force:true}));const database=join(dir,'game.sqlite');let f=await start(database);const owner=await f.account('Owner'),alice=await f.account('Alice');
  const world=(await owner.call('/api/worlds','POST',{name:'Durable desk world'})).data.world,room=(await owner.call('/api/rooms','POST',{worldId:world.id,name:'Persistent desk',scene:scene([area('desk-a'),area('desk-b',6)])})).data.room;
  await enter(alice,room);const payload={revision:0,clientOperationId:'durable-claim'};assert.equal((await alice.call(`/api/rooms/${room.id}/personal-areas/desk-a/claim`,'POST',payload)).status,200);await save(alice,room,s=>s.objects.push(chair('durable-object')));await enter(alice,room,'desk-b');await alice.call(`/api/rooms/${room.id}/personal-areas/desk-b/decline`,'POST',{revision:0,clientOperationId:'durable-decline'});
  const oc=owner.cookie,ac=alice.cookie;await f.app.close();f=await start(database);t.after(()=>f.app.close());const recovered=f.client(),manager=f.client();recovered.cookie=ac;manager.cookie=oc;
  let current=await latest(recovered,room);assert.equal(current.personalAreas[0].ownerId,alice.user.id);assert.equal(current.personalAreas[1].declined,true);assert.equal(current.personalAreas[0].ownedObjectCount,1);assert.equal((await recovered.call(`/api/rooms/${room.id}/personal-areas/desk-a/claim`,'POST',payload)).data.duplicate,true);
  assert.equal((await revoke(manager,room,'desk-a','remove-owned')).status,200);current=await latest(recovered,room);assert.equal(current.scene.objects.length,0);assert.equal(current.personalAreas[0].ownerId,null);
});


test('EDIT-21 allowed-tag changes gate future claims but retain existing owner and current claim attribution',async t=>{
  const{owner,alice,room,world}=await setup(t,[area('desk-a',-6,'dynamic',['artist'])]);await owner.call(`/api/worlds/${world.id}/members/${alice.user.id}`,'PUT',{role:'member',tags:['artist']});await enter(alice,room);assert.equal((await claim(alice,room)).status,200);assert.equal((await save(alice,room,s=>s.objects.push(chair('owned-before-tags')))).status,200);
  await owner.call(`/api/worlds/${world.id}/members/${alice.user.id}`,'PUT',{role:'member',tags:[]});assert.equal((await latest(alice,room)).capabilities.canBuild,true);assert.equal((await save(owner,room,s=>s.areas[0].personalArea.allowedTags=['builder'])).status,200);
  const current=await latest(alice,room);assert.equal(current.personalAreas[0].ownerId,alice.user.id);assert.equal(current.personalAreas[0].ownedObjectCount,1);assert.equal((await save(alice,room,s=>s.objects[0].name='Still mine')).status,200);
  assert.equal((await revoke(owner,room,'desk-a','remove-owned')).status,200);assert.equal((await latest(owner,room)).scene.objects.length,0);assert.equal((await claim(alice,room)).status,403);
});

test('EDIT-21 committed placement versus revoke race has one winner and never drops unseen items',async t=>{
  const{owner,alice,room}=await setup(t);await enter(alice,room);await claim(alice,room);const current=await latest(alice,room),next=structuredClone(current.scene);next.objects.push(chair('racing-item'));
  const responses=await Promise.all([
    alice.call(`/api/rooms/${room.id}/scene`,'PUT',{revision:current.revision,scene:next,personalAreaRevisions:{'desk-a':1}}),
    owner.call(`/api/rooms/${room.id}/personal-areas/desk-a/revoke`,'POST',{revision:1,roomRevision:current.revision,objectHandling:'remove-owned',clientOperationId:'race-revoke'})
  ]);
  assert.equal(responses.filter(r=>r.status===200).length,1);assert.ok(responses.every(r=>[200,403,409].includes(r.status)));
  const fresh=await latest(owner,room);if(responses[0].status===200){assert.equal(fresh.personalAreas[0].ownerId,alice.user.id);assert.equal(fresh.scene.objects[0].id,'racing-item');}else{assert.equal(fresh.personalAreas[0].ownerId,null);assert.equal(fresh.scene.objects.length,0);}
});

test('EDIT-21 SSE revocation immediately carries personalized scoped capability loss',async t=>{
  const{base,owner,alice,room}=await setup(t);await enter(alice,room);await claim(alice,room);
  const abort=new AbortController(),response=await fetch(base+'/api/events',{headers:{Cookie:alice.cookie},signal:abort.signal}),events=[];let buffer='';const pending=(async()=>{try{for await(const chunk of response.body){buffer+=new TextDecoder().decode(chunk);let end;while((end=buffer.indexOf('\n\n'))!==-1){const part=buffer.slice(0,end);buffer=buffer.slice(end+2);const event=part.match(/^event: (.+)$/m)?.[1],raw=part.match(/^data: (.+)$/m)?.[1];if(event&&raw)events.push({event,data:JSON.parse(raw)});}}}catch{}})();t.after(async()=>{abort.abort();await pending;});
  await revoke(owner,room);for(let i=0;i<100&&!events.some(e=>e.event==='role'&&e.data.reason==='personal-area-revoke');i++)await new Promise(r=>setTimeout(r,5));
  const changed=events.find(e=>e.event==='role'&&e.data.reason==='personal-area-revoke');assert.ok(changed);assert.equal(changed.data.room.capabilities.canBuild,false);assert.equal(changed.data.room.capabilities.canEditScene,false);assert.equal(changed.data.room.personalAreas[0].ownerId,null);assert.equal(changed.data.recoverDraft,true);
});

test('EDIT-21 failed durable receipt rolls back both claim and room revision',async t=>{
  const{app,alice,room}=await setup(t);await enter(alice,room);const run=app.store.run.bind(app.store);app.store.run=(sql,...args)=>{if(sql.startsWith('INSERT INTO personal_area_operations'))throw new Error('Injected receipt failure');return run(sql,...args);};
  assert.equal((await claim(alice,room)).status,500);app.store.run=run;const current=await latest(alice,room);assert.equal(current.revision,0);assert.equal(current.personalAreas[0].revision,0);assert.equal(current.personalAreas[0].ownerId,null);assert.equal(current.scene.areas[0].name,'desk-a');assert.equal((await claim(alice,room)).status,200);
});
