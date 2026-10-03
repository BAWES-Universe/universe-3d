// Real loopback HTTP against SQLite. Scene operations use the public joined admission.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createGameServer} from '../server/app.mjs';
import {canonicalStringify, hashSceneContext, hashSceneObject, sceneOperationRequestIdentity} from '../src/scene-operations.js';
import {makePng} from '../fixtures/png-fixtures.mjs';

const desk = () => ({id:'desk',name:'Desk',x:-6,z:0,width:8,depth:8,action:'welcome',personalArea:{mode:'dynamic',allowedTags:[]}});
const scene = (areas = []) => ({version:1,theme:'garden',bounds:{width:32,depth:26},spawn:{x:0,z:10},objects:[],areas});
const item = (id, x = 6, z = 0, extra = {}) => ({id,type:'table',name:id,x,z,rotation:0,...extra});
const code = response => response.data?.error?.code ?? response.data?.code;
function ok(response, status = 200) {assert.equal(response.status,status,JSON.stringify(response));return response.data;}
const endpoint = room => `/api/rooms/${room.id}/scene/operations`;
const admission = arrival => Object.fromEntries(['admissionId','admissionEpoch','admissionRevision'].map(key=>[key,arrival[key]]));
const revisions = room => Object.fromEntries(room.personalAreas.map(area=>[area.areaId,area.revision]));
async function start(database = ':memory:') {
 let time = 1800000000000;
 const app = createGameServer({database,clock:()=>time,questsEnabled:false});
 const {port} = await app.listen(0),base = `http://127.0.0.1:${port}`;
 const client = (cookie = '') => ({cookie,admissions:new Map(),async call(path,method='GET',body) {
  const response = await fetch(base+path,{method,headers:{cookie:this.cookie,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  const next = response.headers.get('set-cookie');if(next)this.cookie=next.split(';')[0];
  return {status:response.status,data:await response.json()};
 }});
 const account = async (name,registered=false) => {
  const c=client();c.user=ok(await c.call('/api/session','POST',{name}),201).user;
  if(registered)ok(await c.call('/api/account','POST',{username:'ops_'+randomUUID().replaceAll('-','').slice(0,18),password:'local scene operations test password'}),201);
  return c;
 };
 return {app,port,base,client,account,advance:amount=>{time+=amount;}};
}
async function enter(client,room,mode='enter') {
 const response=ok(await client.call(`/api/rooms/${room.id}/join`,'POST',{mode}));
 client.admissions.set(room.id,admission(response.arrival));return response.room;
}
async function current(client,room) {return ok(await client.call(`/api/rooms/${room.id}`)).room;}
async function createRoom(owner,world,initial=scene()) {return ok(await owner.call('/api/rooms','POST',{worldId:world.id,name:'Scene operations '+randomUUID().slice(0,8),scene:initial}),201).room;}
async function setup(t,initial=scene(),{editor=true,registered=false}={}) {
 const f=await start();t.after(()=>f.app.close());
 const owner=await f.account('Manager'),alice=await f.account('Alice',registered);
 const world=ok(await owner.call('/api/worlds','POST',{name:'Scene operations world'}),201).world;
 const room=await createRoom(owner,world,initial);
 if(editor)ok(await owner.call(`/api/rooms/${room.id}/members/${alice.user.id}`,'PUT',{role:'editor'}));
 await enter(owner,room);await enter(alice,room);
 return {...f,owner,alice,world,room};
}
async function object(before,after) {return {kind:'object',id:(after??before).id,before:await hashSceneObject(before),after};}
function cell(before,after) {return {kind:'terrain',x:(after??before)[0],z:(after??before)[1],before,after};}
async function batch(client,room,base,operations,extra={}) {
 return {version:1,operationId:randomUUID(),baseRevision:base.revision,contextHash:await hashSceneContext(base.scene),operations,personalAreaRevisions:revisions(base),admission:client.admissions.get(room.id),...extra};
}
const post = (client,room,payload) => client.call(endpoint(room),'POST',payload);
async function put(client,room,mutate) {
 const base=await current(client,room),next=structuredClone(base.scene);mutate(next);
 return client.call(`/api/rooms/${room.id}/scene`,'PUT',{revision:base.revision,scene:next,personalAreaRevisions:revisions(base)});
}
function receipt(result,client,room,payload,revision) {
 assert.equal(result.receipt.version,1);assert.equal(result.receipt.operationId,payload.operationId);
 assert.equal(result.receipt.actorId,client.user.id);assert.equal(result.receipt.roomId,room.id);
 assert.equal(result.receipt.appliedRevision,revision);
 assert.equal(result.receipt.requestHash,createHash('sha256').update(canonicalStringify(sceneOperationRequestIdentity(room.id,payload))).digest('hex'));
}
async function unchanged(client,room,before) {
 const after=await current(client,room);assert.equal(after.revision,before.revision);assert.deepEqual(after.scene,before.scene);
}
async function claim(client,room) {
 const before=await current(client,room),area=before.personalAreas.find(value=>value.areaId==='desk');
 ok(await client.call('/api/presence','POST',{roomId:room.id,x:area.x,z:area.z,...client.admissions.get(room.id)}));
 return ok(await client.call(`/api/rooms/${room.id}/personal-areas/desk/claim`,'POST',{revision:area.revision,clientOperationId:randomUUID()})).room;
}
async function revoke(owner,room,handling='keep') {
 const before=await current(owner,room),area=before.personalAreas.find(value=>value.areaId==='desk');
 return ok(await owner.call(`/api/rooms/${room.id}/personal-areas/desk/revoke`,'POST',{revision:area.revision,roomRevision:before.revision,objectHandling:handling,clientOperationId:randomUUID()})).room;
}
function partial(t,f,client,room,payload) {
 let admitted;const ready=new Promise(resolve=>{admitted=resolve;}),authorize=f.app.store.authorize.bind(f.app.store);
 f.app.store.authorize=(...args)=>{const result=authorize(...args);if(args[1]===client.user.id)admitted();return result;};
 t.after(()=>{f.app.store.authorize=authorize;});
 const encoded=JSON.stringify(payload),split=Math.floor(encoded.length/2);let request;
 const result=new Promise((resolve,reject)=>{
  request=http.request(f.base+endpoint(room),{method:'POST',headers:{cookie:client.cookie,'content-type':'application/json','transfer-encoding':'chunked'}},response=>{
   let raw='';response.on('data',chunk=>{raw+=chunk;});response.on('end',()=>resolve({status:response.statusCode,data:JSON.parse(raw)}));
  });request.on('error',reject);request.write(encoded.slice(0,split));
 });
 t.after(()=>request.destroy());
 return {ready:Promise.race([ready,result.then(response=>assert.fail(`Request ended before body completion: ${JSON.stringify(response)}`))]),result,finish:()=>request.end(encoded.slice(split))};
}

test('scene operations HTTP: two stale clients merge disjoint objects and terrain, retaining canonical receipts',async t=>{
 const {owner,alice,room}=await setup(t),base=await current(owner,room);
 assert.deepEqual(base.sceneOperations,{version:1});assert.equal(Object.hasOwn(base.scene,'sceneOperations'),false);
 const left=item('left',-6),right=item('right',6);
 const a=await batch(owner,room,base,[await object(null,left),cell(null,[-8,5,'stone',false])]);
 const b=await batch(alice,room,base,[await object(null,right),cell(null,[7,5,'wood',false])]);
 const first=ok(await post(owner,room,a)),second=ok(await post(alice,room,b));
 assert.equal(first.duplicate,false);assert.equal(second.duplicate,false);receipt(first,owner,room,a,1);receipt(second,alice,room,b,2);
 assert.deepEqual(second.room.scene.objects,[left,right]);assert.deepEqual(second.room.scene.terrain.cells,[[-8,5,'stone',false],[7,5,'wood',false]]);
 const edited=await batch(owner,room,second.room,[await object(left,{...left,name:'A new name'}),cell([7,5,'wood',false],null)]);
 const updated=ok(await post(owner,room,edited)).room;assert.equal(updated.scene.objects[0].name,'A new name');assert.deepEqual(updated.scene.terrain.cells,[[-8,5,'stone',false]]);
});

for(const target of ['object','terrain'])test(`scene operations HTTP: stale ${target} conflict rejects the whole mixed batch atomically`,async t=>{
 const initial=scene();initial.objects=[item('shared',-6)];initial.terrain={version:1,cells:[[6,4,'stone',false]]};
 const {owner,alice,room}=await setup(t,initial),base=await current(owner,room);
 const firstChange=target==='object'?await object(initial.objects[0],{...initial.objects[0],name:'First'}):cell(initial.terrain.cells[0],[6,4,'wood',false]);
 const loserChange=target==='object'?await object(initial.objects[0],{...initial.objects[0],name:'Second'}):cell(initial.terrain.cells[0],[6,4,'soil',false]);
 const winner=ok(await post(owner,room,await batch(owner,room,base,[firstChange]))).room;
 const rejected=await post(alice,room,await batch(alice,room,base,[loserChange,await object(null,item('must-not-appear',6,-4)),cell(null,[8,5,'grass',false])]));
 assert.equal(rejected.status,409,JSON.stringify(rejected));assert.equal(code(rejected),'SCENE_OPERATION_CONFLICT');
 const descriptor=target==='object'?{kind:'object',id:'shared'}:{kind:'terrain',x:6,z:4};
 assert(rejected.data.conflicts.some(value=>Object.entries(descriptor).every(([key,val])=>value[key]===val)));
 assert.equal(rejected.data.room.revision,winner.revision);await unchanged(owner,room,winner);
});

for(const order of ['objects','object-first','terrain-first'])test(`scene operations HTTP: ${order} combined geometry is rechecked after a disjoint stale commit`,async t=>{
 const {owner,alice,room}=await setup(t),base=await current(owner,room);
 const solid=await object(null,item('solid',6.5,.5,{width:1,depth:1}));
 const other=order==='objects'?await object(null,item('overlap',6.5,.5,{width:1,depth:1})):cell(null,[6,0,'water',true]);
 const operations=order==='terrain-first'?[other,solid]:[solid,other];
 const saved=ok(await post(owner,room,await batch(owner,room,base,[operations[0]]))).room;
 const response=await post(alice,room,await batch(alice,room,base,[operations[1],cell(null,[-8,5,'stone',false])]));
 assert.equal(response.status,409,JSON.stringify(response));assert.equal(code(response),'SCENE_OPERATION_CONFLICT');assert(response.data.conflicts.length>0);await unchanged(owner,room,saved);
});

test('scene operations HTTP: legacy context changes fence stale operations without blocking disjoint legacy object writes',async t=>{
 const {owner,alice,room}=await setup(t),base=await current(alice,room);
 const pending=await batch(alice,room,base,[await object(null,item('pending',-6))]);
 ok(await put(owner,room,next=>{next.objects.push(item('legacy',6));}));
 const merged=ok(await post(alice,room,pending)).room;assert.deepEqual(merged.scene.objects.map(value=>value.id),['legacy','pending']);
 const stale=await batch(alice,room,merged,[cell(null,[4,4,'soil',false])]);
 const changed=ok(await put(owner,room,next=>{next.theme='assembly';})).room;
 const response=await post(alice,room,stale);assert.equal(response.status,409);assert.equal(code(response),'SCENE_OPERATION_CONFLICT');assert(response.data.conflicts.some(value=>value.kind==='context'));await unchanged(owner,room,changed);
});

test('scene operations HTTP: duplicate requests have one effect, changed semantic payload cannot reuse the ID',async t=>{
 const {owner,alice,room}=await setup(t),base=await current(owner,room),payload=await batch(owner,room,base,[await object(null,item('once',6))]);
 const results=await Promise.all([post(owner,room,payload),post(owner,room,payload)]);
 for(const result of results)ok(result);assert.deepEqual(results.map(value=>value.data.duplicate).sort(),[false,true]);
 assert.deepEqual(results[0].data.receipt,results[1].data.receipt);assert.equal((await current(owner,room)).revision,1);
 ok(await post(alice,room,await batch(alice,room,base,[cell(null,[-6,4,'wood',false])])));
 const retry=ok(await post(owner,room,payload));assert.equal(retry.duplicate,true);assert.equal(retry.room.revision,2);assert.equal(retry.receipt.appliedRevision,1);
 const changed=structuredClone(payload);changed.operations[0].after.name='Different semantic payload';
 const response=await post(owner,room,changed);assert.equal(response.status,409);assert.equal(code(response),'OPERATION_REUSED');assert.equal((await current(owner,room)).revision,2);
});

test('scene operations HTTP: receipts, scenes and replay survive SQLite restart; retries require a fresh admission',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'universe-scene-operations-')),database=join(directory,'game.sqlite');let f;
 t.after(async()=>{await f?.app.close();await rm(directory,{recursive:true,force:true});});
 f=await start(database);const owner=await f.account('Durable owner'),world=ok(await owner.call('/api/worlds','POST',{name:'Durable world'}),201).world,room=await createRoom(owner,world);
 const base=await enter(owner,room),payload=await batch(owner,room,base,[await object(null,item('durable',6)),cell(null,[-5,4,'stone',false])]);
 const saved=ok(await post(owner,room,payload)),cookie=owner.cookie;await f.app.close();f=null;f=await start(database);
 const recovered=f.client(cookie);recovered.user=owner.user;
 const invalid=await post(recovered,room,payload);assert.equal(invalid.status,409,JSON.stringify(invalid));
 const fresh=await enter(recovered,room);assert.deepEqual(fresh.scene,saved.room.scene);
 const newAdmission=recovered.admissions.get(room.id);assert.notEqual(newAdmission.admissionEpoch,payload.admission.admissionEpoch);
 const retry=ok(await post(recovered,room,{...payload,admission:newAdmission}));assert.equal(retry.duplicate,true);assert.deepEqual(retry.receipt,saved.receipt);assert.equal(retry.room.revision,1);
 const replay=ok(await recovered.call(endpoint(room)+'?after=0'));assert.equal(replay.mode,'replay');assert.equal(replay.cursor,1);assert.deepEqual(replay.snapshots,[{revision:1,scene:saved.room.scene}]);
});

test('scene operations HTTP: replay includes operation, legacy and personal-area writers, and never embeds capabilities',async t=>{
 const {owner,alice,room}=await setup(t,scene([desk()]),{editor:false,registered:true});
 const snapshots=[];let next=await claim(alice,room);snapshots.push({revision:next.revision,scene:next.scene});
 next=ok(await post(alice,room,await batch(alice,room,next,[await object(null,item('owned',-6,1,{type:'chair'}))]))).room;snapshots.push({revision:next.revision,scene:next.scene});
 next=ok(await put(owner,room,value=>{value.objects.push(item('legacy',6));})).room;snapshots.push({revision:next.revision,scene:next.scene});
 next=await revoke(owner,room,'remove-owned');snapshots.push({revision:next.revision,scene:next.scene});
 const replay=ok(await owner.call(endpoint(room)+'?after=0'));assert.equal(replay.mode,'replay');assert.equal(replay.after,0);assert.equal(replay.cursor,next.revision);assert.deepEqual(replay.snapshots,snapshots);
 for(const snapshot of replay.snapshots){assert.deepEqual(Object.keys(snapshot).sort(),['revision','scene']);for(const field of ['capabilities','personalAreas','imageDefinitions','presence','sceneOperations'])assert.equal(Object.hasOwn(snapshot.scene,field),false);}
 const caughtUp=ok(await alice.call(endpoint(room)+`?after=${next.revision}`));assert.equal(caughtUp.mode,'snapshot');assert.deepEqual(caughtUp.snapshots,[{revision:next.revision,scene:next.scene}]);assert.equal(caughtUp.room.capabilities.canBuild,false);
});

test('scene operations HTTP: replay retention returns a current snapshot for older cursors and contiguous recent revisions',async t=>{
 const {app,owner,room}=await setup(t),base=await current(owner,room),payload=await batch(owner,room,base,[await object(null,item('changing',6))]);
 const first=ok(await post(owner,room,payload));let latest=first.room;
 for(let i=0;i<65;i++)latest=ok(await put(owner,room,next=>{next.objects=[item('changing',6,0,{name:'Revision '+(i+2)})];})).room;
 assert.equal(app.store.get('SELECT COUNT(*) AS n FROM scene_operation_journal WHERE room_id=?',room.id).n,64);
 const tooOld=ok(await owner.call(endpoint(room)+'?after=0'));assert.equal(tooOld.mode,'snapshot');assert.equal(tooOld.cursor,66);assert.deepEqual(tooOld.snapshots,[{revision:66,scene:latest.scene}]);
 const recent=ok(await owner.call(endpoint(room)+'?after=64'));assert.equal(recent.mode,'replay');assert.deepEqual(recent.snapshots.map(value=>value.revision),[65,66]);assert.deepEqual(recent.snapshots[1].scene,latest.scene);
 const retry=ok(await post(owner,room,payload));assert.equal(retry.duplicate,true);assert.deepEqual(retry.receipt,first.receipt);assert.equal(retry.room.revision,66);assert.deepEqual(retry.room.scene,latest.scene);
});

test('scene operations HTTP: migrating a legacy database seeds only its current scene revision and resumes replay',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'universe-scene-baseline-')),database=join(directory,'game.sqlite');let f;
 t.after(async()=>{await f?.app.close();await rm(directory,{recursive:true,force:true});});
 f=await start(database);const owner=await f.account('Migration owner'),world=ok(await owner.call('/api/worlds','POST',{name:'Existing world'}),201).world,room=await createRoom(owner,world);
 const cookie=owner.cookie;await f.app.close();f=null;
 // Remove only the newly introduced schema from this temporary test database,
 // leaving a pre-operation room whose earlier scene revisions never existed here.
 const legacy=new DatabaseSync(database),baseline=scene();baseline.objects=[item('existing',6)];
 try {
  legacy.exec('DROP TRIGGER scene_operation_journal_insert; DROP TRIGGER scene_operation_journal_update; DROP TABLE scene_operation_journal; DROP TABLE scene_operation_receipts;');
  legacy.prepare('UPDATE rooms SET revision=?,scene=? WHERE id=?').run(41,JSON.stringify(baseline),room.id);
 } finally {legacy.close();}
 f=await start(database);const recovered=f.client(cookie);recovered.user=owner.user;await enter(recovered,room);
 const old=ok(await recovered.call(endpoint(room)+'?after=0'));assert.equal(old.mode,'snapshot');assert.equal(old.cursor,41);assert.deepEqual(old.snapshots,[{revision:41,scene:baseline}]);
 assert.deepEqual(f.app.store.all('SELECT revision FROM scene_operation_journal WHERE room_id=?',room.id).map(row=>row.revision),[41]);
 const next=ok(await put(recovered,room,value=>{value.objects[0].name='After migration';})).room;
 const replay=ok(await recovered.call(endpoint(room)+'?after=40'));assert.equal(replay.mode,'replay');assert.deepEqual(replay.snapshots,[{revision:41,scene:baseline},{revision:42,scene:next.scene}]);
});

test('scene operations HTTP: private room replay and writes enforce current access without disclosing snapshots',async t=>{
 const {owner,alice,room}=await setup(t,scene(),{editor:false}),base=await current(alice,room),payload=await batch(alice,room,base,[await object(null,item('unauthorized'))]);
 const denied=await post(alice,room,payload);assert.equal(denied.status,403);await unchanged(owner,room,base);
 ok(await owner.call(`/api/rooms/${room.id}`,'PATCH',{public:false}));
 for(const response of [await alice.call(endpoint(room)+'?after=0'),await post(alice,room,payload)]){assert.equal(response.status,404,JSON.stringify(response));assert.equal(response.data.room,undefined);assert.equal(response.data.snapshots,undefined);}
});

for(const mutation of ['role-revoked','private-ancestor','travel','same-room-reentry','logout'])test(`scene operations HTTP: streamed ${mutation} rechecks authority and admission before commit`,{timeout:15000},async t=>{
 const f=await setup(t),{owner,alice,room,world}=f,base=await current(alice,room),payload=await batch(alice,room,base,[await object(null,item('in-flight'))]);
 const pending=partial(t,f,alice,room,payload);await pending.ready;
 if(mutation==='role-revoked')ok(await owner.call(`/api/rooms/${room.id}/members/${alice.user.id}`,'PUT',{role:'member'}));
 if(mutation==='private-ancestor'){ok(await owner.call(`/api/rooms/${room.id}/members/${alice.user.id}`,'DELETE'));ok(await owner.call(`/api/worlds/${world.id}`,'PATCH',{public:false}));}
 if(mutation==='travel'){const other=await createRoom(owner,world);await enter(alice,other,'travel');}
 if(mutation==='same-room-reentry')await enter(alice,room,'travel');
 if(mutation==='logout')ok(await alice.call('/api/logout','POST',{}));
 pending.finish();const response=await pending.result;assert([401,403,404,409].includes(response.status),JSON.stringify(response));await unchanged(owner,room,base);
});

test('scene operations HTTP: scoped personal builders retain object provenance and cannot paint terrain or cross their area',async t=>{
 const {owner,alice,room}=await setup(t,scene([desk()]),{editor:false,registered:true});let base=await claim(alice,room);
 const placed=item('my-chair',-6,1,{type:'chair'}),payload=await batch(alice,room,base,[await object(null,placed)]);
 base=ok(await post(alice,room,payload)).room;assert.equal(base.personalAreas[0].ownedObjectCount,1);assert.equal(base.capabilities.canEditScene,false);
 const stale=await post(alice,room,await batch(alice,room,base,[await object(placed,{...placed,name:'Stale ownership revision'})],{personalAreaRevisions:{desk:0}}));
 assert.equal(stale.status,409,JSON.stringify(stale));await unchanged(owner,room,base);
 for(const operations of [[cell(null,[-8,2,'wood',false])],[await object(null,item('outside',10))]]){
  const response=await post(alice,room,await batch(alice,room,base,operations));assert.equal(response.status,403,JSON.stringify(response));await unchanged(owner,room,base);
 }
 const removed=await revoke(owner,room,'remove-owned');assert.deepEqual(removed.scene.objects,[]);
 const retry=await post(alice,room,payload);assert.equal(retry.status,403,JSON.stringify(retry));await unchanged(owner,room,removed);
});

test('scene operations HTTP: archived image pins remain editable but stale new references cannot be added or resurrected',async t=>{
 const {owner,room}=await setup(t);
 const entry=ok(await owner.call(`/api/rooms/${room.id}/assets`,'POST',{operationId:randomUUID(),draft:{name:'Scene operation image'},mediaType:'image/png',pngBase64:makePng().toString('base64')}),201);
 const pin={id:'image',type:'image',name:'Pinned',assetRef:{assetId:entry.definition.assetId,versionId:entry.version.versionId},x:6,z:0,rotation:0};
 let base=await current(owner,room),saved=ok(await post(owner,room,await batch(owner,room,base,[await object(null,pin)]))).room;
 const staleNew=await batch(owner,room,saved,[await object(null,{...pin,id:'copy',x:-6})]);
 ok(await owner.call(`/api/rooms/${room.id}/assets/${entry.definition.assetId}`,'PATCH',{expectedRevision:entry.revision,status:'archived'}));
 const denied=await post(owner,room,staleNew);assert.equal(denied.status,409);assert.equal(code(denied),'IMAGE_ARCHIVED');await unchanged(owner,room,saved);
 base=await current(owner,room);const changed={...pin,name:'Retained archived pin',x:7};
 saved=ok(await post(owner,room,await batch(owner,room,base,[await object(pin,changed)]))).room;assert.equal(saved.scene.objects[0].name,changed.name);
 saved=ok(await post(owner,room,await batch(owner,room,saved,[await object(changed,null)]))).room;
 const resurrect=await post(owner,room,await batch(owner,room,saved,[await object(null,pin)]));assert.equal(resurrect.status,409);assert.equal(code(resurrect),'IMAGE_ARCHIVED');await unchanged(owner,room,saved);
});

test('scene operations HTTP: changed full rotated and procedural footprints stay inside bounds; grandfathered geometry may be renamed',async t=>{
 const f=await setup(t),base=await current(f.owner,f.room);
 for(const added of [item('undersized',15,0,{width:.1,depth:.1}),item('rotated',14.8,0,{rotation:45})]){
  const response=await post(f.owner,f.room,await batch(f.owner,f.room,base,[await object(null,added)]));
  assert.equal(response.status,409,JSON.stringify(response));assert.equal(code(response),'SCENE_OPERATION_CONFLICT');assert.deepEqual(response.data.conflicts,[{kind:'object',id:added.id}]);await unchanged(f.owner,f.room,base);
 }
 // Existing legacy geometry retains its authority contract. Non-geometry changes
 // do not newly forbid an old footprint merely because this route is introduced.
 const legacy=item('legacy-edge',15,0,{width:.1,depth:.1});ok(await put(f.owner,f.room,next=>next.objects.push(legacy)));
 const prior=await current(f.owner,f.room),renamed={...legacy,name:'Retained footprint'};
 const saved=ok(await post(f.owner,f.room,await batch(f.owner,f.room,prior,[await object(legacy,renamed)])));
 assert.equal(saved.room.scene.objects[0].name,'Retained footprint');
});

test('scene operations HTTP: near-limit scenes fall back atomically when replay exceeds its byte budget',async t=>{
 const initial={...scene(),retainedMetadata:Array.from({length:30},()=> 'é'.repeat(8000))},f=await setup(t,initial);
 for(let i=1;i<=2;i++)ok(await put(f.owner,f.room,next=>{next.theme='theme'+i;}));
 const within=ok(await f.owner.call(endpoint(f.room)+'?after=0'));
 assert.equal(within.mode,'replay');assert.deepEqual(within.snapshots.map(entry=>entry.revision),[1,2]);
 ok(await put(f.owner,f.room,next=>{next.theme='theme3';}));
 const fallback=ok(await f.owner.call(endpoint(f.room)+'?after=0'));
 assert.equal(fallback.mode,'snapshot');assert.equal(fallback.cursor,3);assert.deepEqual(fallback.snapshots,[{revision:3,scene:fallback.room.scene}]);
 const shorter=ok(await f.owner.call(endpoint(f.room)+'?after=1'));
 assert.equal(shorter.mode,'replay');assert.deepEqual(shorter.snapshots.map(entry=>entry.revision),[2,3]);
 assert.equal(f.app.store.get('SELECT COUNT(*) AS count FROM scene_operation_journal WHERE room_id=?',f.room.id).count,4);
});

test('scene operations HTTP: new public readers cannot replay removed private content while full editors can',async t=>{
 const f=await setup(t);ok(await f.owner.call(`/api/rooms/${f.room.id}`,'PATCH',{public:false}));
 const privateText='Previously private planning notes',privateUrl='https://example.test/private-draft';
 ok(await put(f.owner,f.room,next=>next.objects.push(item('private-note',6,0,{text:privateText,url:privateUrl}))));
 ok(await put(f.owner,f.room,next=>{next.objects=[];}));
 ok(await f.owner.call(`/api/rooms/${f.room.id}`,'PATCH',{public:true}));
 const guest=await f.account('New public reader'),publicReplay=ok(await guest.call(endpoint(f.room)+'?after=0'));
 assert.equal(publicReplay.mode,'snapshot');assert.equal(publicReplay.snapshots.length,1);
 assert.equal(JSON.stringify(publicReplay).includes(privateText),false);assert.equal(JSON.stringify(publicReplay).includes(privateUrl),false);
 const editorReplay=ok(await f.alice.call(endpoint(f.room)+'?after=0'));
 assert.equal(editorReplay.mode,'replay');assert.deepEqual(editorReplay.snapshots.map(entry=>entry.revision),[1,2]);assert.equal(editorReplay.snapshots[0].scene.objects[0].text,privateText);
});
