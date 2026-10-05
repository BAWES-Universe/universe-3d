import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGameServer} from '../server/app.mjs';
import {FURNITURE_LIMITS} from '../server/furniture.mjs';
import {FURNITURE_CAPABILITY} from '../server/furniture-client-protocol.mjs';
import {hashSceneContext,hashSceneObject,hashSceneOperationDependencies} from '../src/scene-operations.js';
import {navigationPolicy} from '../server/bot-navigation.mjs';
import {makePng} from '../fixtures/png-fixtures.mjs';

const scene=(areas=[])=>({version:1,theme:'garden',bounds:{width:32,depth:26},spawn:{x:0,z:10},objects:[],areas});
const desk=()=>({id:'desk',name:'Desk',x:-6,z:0,width:8,depth:8,action:'welcome',personalArea:{mode:'dynamic',allowedTags:[]}});
const document=(overrides={})=>({format:'universe-asset-workshop',version:1,asset:{id:'local-asset',revision:1,name:'My furniture'},materials:[{id:'mint',name:'Mint',color:'#2dd4bf',roughness:.75,textureRef:null}],groups:[],components:[{id:'part',name:'Seat',shape:'box',position:[0,.5,0],rotation:[0,0,0,1],size:[1,1,1],materialId:'mint',groupId:null,collision:'box'}],...overrides});
const object=(asset,id='placed',x=6,z=0)=>({id,type:'composition',name:'Custom furniture',x,z,rotation:0,assetRef:{assetId:asset.assetId,revision:asset.revision}});
const endpoint=room=>`/api/rooms/${room.id}/furniture`;
const code=r=>r.data?.code??r.data?.error?.code??r.data?.error;
function ok(r,status=200){assert.equal(r.status,status,JSON.stringify(r));return r.data;}
async function start(database=':memory:'){
 let time=1800000000000;const app=createGameServer({database,clock:()=>time,questsEnabled:false});
 const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`;
 const client=(cookie='',capable=true)=>({cookie,capable,async call(path,method='GET',body,headers={}){
  const r=await fetch(base+path,{method,headers:{cookie:this.cookie,...(this.capable?{'X-Universe-Client-Capabilities':`image-physical-size-v1 ${FURNITURE_CAPABILITY}`}:{ }),...(body===undefined?{}:{'content-type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const next=r.headers.get('set-cookie');if(next)this.cookie=next.split(';')[0];return{status:r.status,data:await r.json()};
 }});
 const account=async(name,registered=false)=>{const c=client();c.user=ok(await c.call('/api/session','POST',{name}),201).user;if(registered)ok(await c.call('/api/account','POST',{username:'f_'+randomUUID().replaceAll('-','').slice(0,20),password:'Local furniture test password 2026'}),201);return c;};
 return{app,port,base,client,account,advance:ms=>time+=ms};
}
async function room(owner,world,initial=scene()){return ok(await owner.call('/api/rooms','POST',{worldId:world.id,name:'Furniture '+randomUUID().slice(0,8),scene:initial}),201).room;}
async function enter(c,r,mode='enter'){const result=ok(await c.call(`/api/rooms/${r.id}/join`,'POST',{mode}));c.admission=Object.fromEntries(['admissionId','admissionEpoch','admissionRevision'].map(key=>[key,result.arrival[key]]));return result.room;}
async function current(c,r){return ok(await c.call(`/api/rooms/${r.id}`)).room;}
async function publish(c,r,definition=document(),operationId=randomUUID()){return ok(await c.call(endpoint(r),'POST',{definition,operationId}),201).asset;}
async function save(c,r,change){const before=await current(c,r),next=structuredClone(before.scene);change(next);return c.call(`/api/rooms/${r.id}/scene`,'PUT',{revision:before.revision,scene:next,personalAreaRevisions:Object.fromEntries(before.personalAreas.map(a=>[a.areaId,a.revision]))});}
async function setup(t,initial=scene()){
 const f=await start();t.after(()=>f.app.close());const owner=await f.account('Owner'),alice=await f.account('Alice',true),bob=await f.account('Bob');
 const world=ok(await owner.call('/api/worlds','POST',{name:'Furniture world'}),201).world,r=await room(owner,world,initial);await enter(owner,r);
 return{...f,owner,alice,bob,world,room:r};
}
async function unchanged(c,r,before){const after=await current(c,r);assert.equal(after.revision,before.revision);assert.deepEqual(after.scene,before.scene);}
function partial(t,f,c,path,method,payload){
 let ready;const admitted=new Promise(resolve=>ready=resolve),original=f.app.store.authorize.bind(f.app.store);
 f.app.store.authorize=(...args)=>{const result=original(...args);if(args[1]===c.user.id)ready();return result;};t.after(()=>{f.app.store.authorize=original;});
 const encoded=JSON.stringify(payload),split=Math.floor(encoded.length/2);let req;
 const result=new Promise((resolve,reject)=>{req=http.request(f.base+path,{method,headers:{cookie:c.cookie,'content-type':'application/json','transfer-encoding':'chunked','X-Universe-Client-Capabilities':`image-physical-size-v1 ${FURNITURE_CAPABILITY}`}},res=>{let raw='';res.on('data',x=>raw+=x);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw)}));});req.on('error',reject);req.write(encoded.slice(0,split));});t.after(()=>req.destroy());
 return{ready:Promise.race([admitted,result.then(r=>assert.fail(JSON.stringify(r)))]),result,finish:()=>req.end(encoded.slice(split))};
}

test('furniture: generated room-owned identity, immutable pins, CAS and durable idempotency survive restart',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'universe-workshop-'));let f; t.after(async()=>{if(f)await f.app.close();await rm(dir,{recursive:true,force:true});});const database=join(dir,'world.sqlite');f=await start(database);
 const owner=await f.account('Durable owner'),world=ok(await owner.call('/api/worlds','POST',{name:'Durable world'}),201).world,r=await room(owner,world);await enter(owner,r);
 const draft=document();draft.asset={id:'client-forged-id',revision:987,name:'Original'};draft.materials[0].textureRef={assetId:'inert-texture',versionId:'inert-version',slot:'baseColor'};
 const payload={definition:draft,operationId:'durable-create'},first=ok(await owner.call(endpoint(r),'POST',payload),201),asset=first.asset;
 assert.notEqual(asset.assetId,draft.asset.id);assert.equal(asset.revision,1);assert.equal(asset.roomId,r.id);assert.equal(asset.authorId,owner.user.id);assert.equal(asset.definition.asset.id,asset.assetId);assert.equal(asset.definition.asset.revision,1);assert.deepEqual(asset.definition.materials[0].textureRef,draft.materials[0].textureRef);
 assert.deepEqual(ok(await owner.call(endpoint(r),'POST',payload)),{...first,duplicate:true});
 const placed=ok(await save(owner,r,s=>s.objects.push(object(asset)))).room,key=`${asset.assetId}:1`;
 assert.deepEqual(placed.compositionDefinitions[key],asset.definition);assert.equal(Object.hasOwn(placed.scene,'compositionDefinitions'),false);
 const revised=structuredClone(draft);revised.components[0].size=[2,1,1];const update={definition:revised,revision:1,operationId:'durable-update'};
 const second=ok(await owner.call(endpoint(r)+`/${asset.assetId}`,'PUT',update));assert.equal(second.asset.revision,2);assert.deepEqual((await current(owner,r)).compositionDefinitions[key],asset.definition);
 assert.equal(code(await owner.call(endpoint(r)+`/${asset.assetId}`,'PUT',{...update,operationId:'stale-update'})),'FURNITURE_REVISION_CONFLICT');
 assert.equal(code(await owner.call(endpoint(r),'POST',{...payload,definition:revised})),'OPERATION_REUSED');
 assert.throws(()=>f.app.store.run('UPDATE room_furniture_revisions SET definition=? WHERE room_id=?','{}',r.id),/immutable/);
 const cookie=owner.cookie;await f.app.close();f=await start(database);const restored=f.client(cookie);restored.user=owner.user;await enter(restored,r,'resume');
 assert.deepEqual((await current(restored,r)).compositionDefinitions[key],asset.definition);assert.deepEqual(ok(await restored.call(endpoint(r),'POST',payload)),{...first,duplicate:true});assert.deepEqual(ok(await restored.call(endpoint(r)+`/${asset.assetId}`,'PUT',update)),{...second,duplicate:true});
 assert.equal(ok(await restored.call(endpoint(r))).assets[0].revision,2);
 const old=f.client(cookie,false);assert.equal((await old.call(`/api/rooms/${r.id}`)).status,426);
});

test('furniture: current roles, room scope, exact schemas and publication validity are authoritative',async t=>{
 const {owner,alice,bob,room:r,world}=await setup(t),asset=await publish(owner,r);await enter(alice,r);await enter(bob,r);
 assert.equal((await alice.call(endpoint(r),'POST',{definition:document(),operationId:randomUUID()})).status,403);
 ok(await owner.call(`/api/rooms/${r.id}/members/${alice.user.id}`,'PUT',{role:'editor'}));const edited=ok(await alice.call(endpoint(r)+`/${asset.assetId}`,'PUT',{definition:document(),revision:1,operationId:randomUUID()})).asset;assert.equal(edited.authorId,owner.user.id);
 const other=await room(owner,world);await enter(owner,other);const foreign=await publish(owner,other);await enter(owner,r);
 assert.equal(code(await save(owner,r,s=>s.objects.push(object(foreign)))),'FURNITURE_NOT_FOUND');
 const invalid=[d=>d.extra='script',d=>d.components[0].script='run()',d=>d.components[0].size=[-1,1,1],d=>d.components[0].rotation=[0,0,0,2],d=>d.components[0].position=[32,0,0],d=>d.components=[]];
 for(const mutate of invalid){const draft=document();mutate(draft);assert.equal((await owner.call(endpoint(r),'POST',{definition:draft,operationId:randomUUID()})).status,400);}
 assert.equal((await owner.call(endpoint(r),'POST',{definition:document(),operationId:randomUUID(),authorId:bob.user.id})).status,400);
 const before=await current(owner,r);
 for(const [field,value]of [['definition',document()],['width',.1],['y',3],['collision','none'],['actions',[]]])assert.equal((await save(owner,r,s=>s.objects.push({...object(asset),[field]:value}))).status,400);
 assert.equal((await save(owner,r,s=>{s.compositionDefinitions={[asset.assetId+':1']:asset.definition};})).status,400);
 await unchanged(owner,r,before);
});

test('furniture: archived pins remain movable but new placements and removed-pin resurrection fail',async t=>{
 const {owner,room:r}=await setup(t),asset=await publish(owner,r);ok(await save(owner,r,s=>s.objects.push(object(asset))));
 const payload={revision:1,operationId:'archive'},archived=ok(await owner.call(endpoint(r)+`/${asset.assetId}/archive`,'POST',payload));assert.equal(archived.asset.status,'archived');assert.deepEqual(ok(await owner.call(endpoint(r)+`/${asset.assetId}/archive`,'POST',payload)),{...archived,duplicate:true});
 ok(await save(owner,r,s=>s.objects[0].x=7));assert.equal(code(await save(owner,r,s=>s.objects.push(object(asset,'duplicate',-6)))),'FURNITURE_ARCHIVED');
 ok(await save(owner,r,s=>s.objects=[]));assert.equal(code(await save(owner,r,s=>s.objects.push(object(asset)))),'FURNITURE_ARCHIVED');
 assert.equal(code(await owner.call(endpoint(r)+`/${asset.assetId}`,'PUT',{definition:document(),revision:1,operationId:randomUUID()})),'FURNITURE_ARCHIVED');assert.equal(ok(await owner.call(endpoint(r))).assets[0].status,'archived');
});

test('furniture: full decorative footprint controls personal-area placement, editing and attribution',async t=>{
 const {owner,alice,room:r}=await setup(t,scene([desk()]));const draft=document();draft.components[0].size=[6,1,2];draft.components[0].collision='none';const asset=await publish(owner,r,draft);
 const joined=await enter(alice,r),a=joined.personalAreas[0];ok(await alice.call('/api/presence','POST',{roomId:r.id,x:a.x,z:a.z,...alice.admission}));ok(await alice.call(`/api/rooms/${r.id}/personal-areas/desk/claim`,'POST',{revision:a.revision,clientOperationId:randomUUID()}));
 let saved=ok(await save(alice,r,s=>s.objects.push(object(asset,'owned',-5,3)))).room;assert.equal(saved.personalAreas[0].objectCount,1);assert.equal(saved.personalAreas[0].ownedObjectCount,1);
 assert.equal((await save(alice,r,s=>s.objects[0].x=-4.99)).status,403);assert.equal((await save(alice,r,s=>s.objects[0].rotation=90)).status,403);
 ok(await save(owner,r,s=>s.objects[0].x=-1));assert.equal((await save(alice,r,s=>s.objects=[])).status,403);assert.equal((await save(alice,r,s=>s.objects[0].x=-5)).status,403);
 ok(await save(owner,r,s=>s.objects[0].x=-5));const beforeRevoke=await current(owner,r),area=beforeRevoke.personalAreas[0];
 const revoked=ok(await owner.call(`/api/rooms/${r.id}/personal-areas/desk/revoke`,'POST',{revision:area.revision,roomRevision:beforeRevoke.revision,objectHandling:'remove-owned',clientOperationId:randomUUID()}));
 assert.deepEqual(revoked.operation.removedObjectIds,['owned']);assert.equal(revoked.room.scene.objects.length,0);assert.equal(ok(await owner.call(endpoint(r))).assets.length,1);
});

test('furniture: authoritative rotated geometry protects bounds, spawn, players, terrain and resident navigation',async t=>{
 const {owner,bob,room:r,app}=await setup(t);const draft=document();draft.components[0].position=[1,8,0];draft.components[0].size=[2,3,1];const asset=await publish(owner,r,draft);
 assert.equal(code(await save(owner,r,s=>s.objects.push(object(asset,'edge',15,0)))),'COMPOSITION_OUTSIDE_ROOM');
 assert.equal(code(await save(owner,r,s=>s.objects.push(object(asset,'spawn',-1,10)))),'COMPOSITION_BLOCKS_ARRIVAL');
 await enter(bob,r);ok(await bob.call('/api/presence','POST',{roomId:r.id,x:6,z:0,...bob.admission}));assert.equal(code(await save(owner,r,s=>s.objects.push(object(asset,'person',5,0)))),'COMPOSITION_BLOCKS_OCCUPANT');
 ok(await save(owner,r,s=>s.terrain={version:1,cells:[[-6,0,'stone',true]]}));assert.equal(code(await save(owner,r,s=>s.objects.push(object(asset,'terrain',-7,0)))),'COMPOSITION_BLOCKS_TERRAIN');
 const saved=ok(await save(owner,r,s=>s.objects.push(object(asset,'solid',-2,0)))).room;const bound=app.store.room(r.id,owner.user.id).scene,allowed=navigationPolicy(bound,{spawn:{x:0,z:0},radius:100});assert.equal(allowed({x:-1,z:0}),false);assert.equal(allowed({x:3,z:0}),true);assert.equal(saved.scene.objects[0].assetRef.revision,1);
});

for(const variant of ['role-revoked','role-restored','private-ancestor','travel-back','same-room-reentry','kick','ban','expired','logout'])test(`furniture: streamed ${variant} fences mutation before receipt or commit`,async t=>{
 const f=await setup(t),{owner,alice,room:r,world,app}=f;ok(await owner.call(`/api/rooms/${r.id}/members/${alice.user.id}`,'PUT',{role:'editor'}));await enter(alice,r);
 const other=await room(owner,world),payload={definition:document(),operationId:randomUUID()},pending=partial(t,f,alice,endpoint(r),'POST',payload);await pending.ready;
 if(variant.startsWith('role')){ok(await owner.call(`/api/rooms/${r.id}/members/${alice.user.id}`,'DELETE'));if(variant==='role-restored')ok(await owner.call(`/api/rooms/${r.id}/members/${alice.user.id}`,'PUT',{role:'editor'}));}
 if(variant==='private-ancestor'){ok(await owner.call(`/api/rooms/${r.id}/members/${alice.user.id}`,'DELETE'));ok(await owner.call(`/api/worlds/${world.id}`,'PATCH',{public:false}));}
 if(variant==='kick'||variant==='ban')ok(await owner.call(`/api/rooms/${r.id}/moderate`,'POST',{userId:alice.user.id,action:variant}));
 if(variant==='expired')f.advance(30*86400000+1);
 if(variant==='travel-back'){await enter(alice,other);await enter(alice,r);}
 if(variant==='same-room-reentry')await enter(alice,r,'travel');
 if(variant==='logout')ok(await alice.call('/api/logout','POST',{}));
 pending.finish();const result=await pending.result;assert.ok([401,403,404,409].includes(result.status),JSON.stringify(result));assert.equal(app.store.get('SELECT COUNT(*) AS count FROM room_furniture_revisions').count,0);assert.equal(app.store.get('SELECT COUNT(*) AS count FROM room_furniture_receipts').count,0);
});

test('furniture: scene CAS streaming is fenced across fresh admission and role changes',async t=>{
 const f=await setup(t),{owner,room:r}=f,asset=await publish(owner,r),before=await current(owner,r),next=structuredClone(before.scene);next.objects.push(object(asset));
 const pending=partial(t,f,owner,`/api/rooms/${r.id}/scene`,'PUT',{revision:before.revision,scene:next});await pending.ready;await enter(owner,r,'travel');pending.finish();assert.equal(code(await pending.result),'STALE_ARRIVAL');await unchanged(owner,r,before);
});

test('furniture: concurrent CAS revisions have exactly one winner and retry is one effect',async t=>{
 const {owner,room:r,app}=await setup(t),asset=await publish(owner,r),path=endpoint(r)+`/${asset.assetId}`,a={definition:document(),revision:1,operationId:'race-a'},b={definition:document(),revision:1,operationId:'race-b'};
 const results=await Promise.all([owner.call(path,'PUT',a),owner.call(path,'PUT',b)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);const winner=results[0].status===200?a:b;assert.equal(ok(await owner.call(path,'PUT',winner)).duplicate,true);assert.equal(app.store.get('SELECT COUNT(*) AS count FROM room_furniture_revisions').count,2);
});

test('furniture: revisions, library cardinality and aggregate scene budgets fail atomically',async t=>{
 const {owner,room:r,app}=await setup(t),draft=document();draft.components[0].collision='none';const asset=await publish(owner,r,draft);
 for(let revision=1;revision<FURNITURE_LIMITS.revisionsPerAsset;revision++)ok(await owner.call(endpoint(r)+`/${asset.assetId}`,'PUT',{definition:draft,revision,operationId:randomUUID()}));
 assert.equal(code(await owner.call(endpoint(r)+`/${asset.assetId}`,'PUT',{definition:draft,revision:FURNITURE_LIMITS.revisionsPerAsset,operationId:randomUUID()})),'FURNITURE_LIBRARY_BUDGET');
 const before=await current(owner,r);assert.equal(code(await save(owner,r,s=>{s.objects=Array.from({length:FURNITURE_LIMITS.instances+1},(_,i)=>object(asset,`count-${i}`));})),'FURNITURE_SCENE_BUDGET');await unchanged(owner,r,before);
 const many=document();many.components=Array.from({length:128},(_,i)=>({...many.components[0],id:`part-${i}`,collision:'none'}));const dense=await publish(owner,r,many);
 assert.equal(code(await save(owner,r,s=>{s.objects=Array.from({length:17},(_,i)=>object(dense,`mesh-${i}`));})),'FURNITURE_SCENE_BUDGET');
 const costly=document();costly.components=Array.from({length:124},(_,i)=>({...costly.components[0],id:`sphere-${i}`,shape:'sphere',collision:'none'}));const round=await publish(owner,r,costly);
 assert.equal(code(await save(owner,r,s=>{s.objects=Array.from({length:5},(_,i)=>object(round,`triangle-${i}`));})),'FURNITURE_SCENE_BUDGET');
 for(let i=3;i<FURNITURE_LIMITS.assets;i++)await publish(owner,r,draft);
 const counts=app.store.get('SELECT COUNT(*) AS count FROM room_furniture_revisions');assert.equal(code(await owner.call(endpoint(r),'POST',{definition:draft,operationId:randomUUID()})),'FURNITURE_LIBRARY_BUDGET');assert.deepEqual(app.store.get('SELECT COUNT(*) AS count FROM room_furniture_revisions'),counts);
});

test('furniture: scene operations preserve definitions, enforce archive on placement and expose collision conflicts',async t=>{
 const {owner,room:r}=await setup(t),asset=await publish(owner,r),base=await current(owner,r),placed=object(asset);
 const payload={version:1,operationId:randomUUID(),baseRevision:base.revision,contextHash:await hashSceneContext(base.scene),operations:[{kind:'object',id:placed.id,before:null,after:placed}],personalAreaRevisions:{},admission:owner.admission};
 const committed=ok(await owner.call(`/api/rooms/${r.id}/scene/operations`,'POST',payload));assert.deepEqual(committed.room.compositionDefinitions[asset.assetId+':1'],asset.definition);assert.equal(ok(await owner.call(`/api/rooms/${r.id}/scene/operations`,'POST',payload)).duplicate,true);
 ok(await owner.call(endpoint(r)+`/${asset.assetId}/archive`,'POST',{revision:1,operationId:randomUUID()}));const updated={...payload,operationId:randomUUID(),baseRevision:committed.room.revision,operations:[{kind:'object',id:placed.id,before:await hashSceneObject(placed),after:{...placed,x:7}}]};ok(await owner.call(`/api/rooms/${r.id}/scene/operations`,'POST',updated));
 const duplicate={...payload,operationId:randomUUID(),operations:[{kind:'object',id:'new-pin',before:null,after:{...placed,id:'new-pin',x:-6}}]};assert.equal(code(await owner.call(`/api/rooms/${r.id}/scene/operations`,'POST',duplicate)),'FURNITURE_ARCHIVED');
});

test('furniture: first placement retires legacy streams, blocks old writes and leaves legacy rooms available',async t=>{
 const f=await setup(t),{owner,bob,room:r,world}=f,other=await room(owner,world),asset=await publish(owner,r);await enter(bob,r);const legacy=f.client(bob.cookie,false),oldRoom=await current(legacy,r);assert.equal(oldRoom.scene.objects.length,0);
 const controller=new AbortController();t.after(()=>controller.abort());const response=await fetch(f.base+'/api/events',{headers:{cookie:bob.cookie},signal:controller.signal}),reader=response.body.getReader();let events='';const read=(async()=>{for(;;){const{done,value}=await reader.read();if(done)return events;events+=new TextDecoder().decode(value);}})();
 ok(await save(owner,r,s=>s.objects.push(object(asset))));const retired=await read;assert.match(retired,/CLIENT_RELOAD_REQUIRED/);assert.match(retired,/custom furniture/);assert.doesNotMatch(retired,/"type":"composition"/);
 assert.equal((await legacy.call(`/api/rooms/${r.id}/scene`,'PUT',{revision:1,scene:oldRoom.scene})).status,426);assert.equal((await legacy.call(`/api/rooms/${r.id}`)).status,426);assert.equal((await legacy.call(`/api/rooms/${other.id}`)).status,200);assert.equal((await legacy.call(endpoint(other))).status,426);
 const before=await current(owner,r);ok(await save(owner,r,s=>s.objects=[]));assert.equal((await legacy.call(`/api/rooms/${r.id}`)).status,426);assert.equal(before.scene.objects.length,1);
});


test('furniture: aggregate stored bytes and historical triangle ceilings include prior revisions',async t=>{
 for(const budget of ['bytes','triangles']){
  const f=await start();t.after(()=>f.app.close());const owner=await f.account('Budget owner'),world=ok(await owner.call('/api/worlds','POST',{name:'Quota world'}),201).world,r=await room(owner,world);await enter(owner,r);
  const draft=document(),count=budget==='triangles'?124:128;
  draft.components=Array.from({length:count},(_,i)=>({...draft.components[0],id:`part-${i}`,name:budget==='bytes'?'界'.repeat(80):'Sphere',shape:budget==='triangles'?'sphere':'box',collision:'none',groupId:budget==='bytes'?`group-${Math.floor(i/2)}`:null}));
  if(budget==='bytes')draft.groups=Array.from({length:64},(_,i)=>({id:`group-${i}`,name:'界'.repeat(80)}));
  let asset=null,accepted=0,rejected;
  for(let attempt=0;attempt<=FURNITURE_LIMITS.roomRevisions;attempt++){
   const create=!asset||asset.revision>=FURNITURE_LIMITS.revisionsPerAsset;
   const response=await owner.call(endpoint(r)+(create?'':`/${asset.assetId}`),create?'POST':'PUT',{definition:draft,...(create?{}:{revision:asset.revision}),operationId:randomUUID()});
   if(response.status===413){rejected=response;break;}
   asset=ok(response,create?201:200).asset;accepted++;
  }
  assert.ok(rejected,'A bounded library must eventually reject');assert.equal(code(rejected),'FURNITURE_LIBRARY_BUDGET');
  const totals=f.app.store.get('SELECT COUNT(*) AS count,SUM(byte_length) AS bytes,SUM(triangles) AS triangles FROM room_furniture_revisions');assert.equal(totals.count,accepted);assert.ok(totals.bytes<=FURNITURE_LIMITS.roomDefinitionBytes);assert.ok(totals.triangles<=FURNITURE_LIMITS.roomDefinitionTriangles);
  const last=f.app.store.get('SELECT byte_length,triangles FROM room_furniture_revisions ORDER BY rowid DESC LIMIT 1');assert.ok(budget==='bytes'?totals.bytes+last.byte_length>FURNITURE_LIMITS.roomDefinitionBytes:totals.triangles+last.triangles>FURNITURE_LIMITS.roomDefinitionTriangles);
 }
});

test('furniture: v2 dependency hashes use immutable composition geometry during nearby area changes',async t=>{
 const {owner,room:r}=await setup(t),asset=await publish(owner,r),base=await current(owner,r),placed=object(asset),operations=[{kind:'object',id:placed.id,before:null,after:placed}],definitions={[asset.assetId+':1']:asset.definition};
 const request={version:2,operationId:randomUUID(),baseRevision:base.revision,contextHash:await hashSceneContext(base.scene,2),dependenciesHash:await hashSceneOperationDependencies(base.scene,operations,{},definitions),operations,personalAreaRevisions:{},admission:owner.admission};
 const committed=ok(await owner.call(`/api/rooms/${r.id}/scene/operations`,'POST',request));assert.equal(committed.room.scene.objects[0].type,'composition');
 const after={...placed,x:7},move=[{kind:'object',id:placed.id,before:await hashSceneObject(placed),after}],stale={...request,operationId:randomUUID(),baseRevision:committed.room.revision,contextHash:await hashSceneContext(committed.room.scene,2),dependenciesHash:await hashSceneOperationDependencies(committed.room.scene,move,{},definitions),operations:move};
 ok(await save(owner,r,s=>s.areas.push({id:'nearby',name:'Nearby area',x:7,z:0,width:2,depth:2,action:'welcome'})));
 const conflict=await owner.call(`/api/rooms/${r.id}/scene/operations`,'POST',stale);assert.equal(code(conflict),'SCENE_OPERATION_CONFLICT');assert.ok(conflict.data.conflicts?.some(c=>c.kind==='dependencies')||conflict.data.details?.conflicts?.some(c=>c.kind==='dependencies'),JSON.stringify(conflict));
});


test('furniture: reverse legacy edits and operation commits cannot overlap existing composition colliders',async t=>{
 const {owner,room:r}=await setup(t),asset=await publish(owner,r);ok(await save(owner,r,s=>s.objects.push(object(asset))));const before=await current(owner,r);
 const chair={id:'reverse-chair',name:'Chair',type:'chair',x:6,z:0,rotation:0};
 assert.equal(code(await save(owner,r,s=>s.objects.push(chair))),'COMPOSITION_OVERLAP');await unchanged(owner,r,before);
 assert.equal(code(await save(owner,r,s=>s.terrain={version:1,cells:[[6,0,'stone',true]]})),'COMPOSITION_BLOCKS_TERRAIN');await unchanged(owner,r,before);
 assert.equal(code(await save(owner,r,s=>s.spawn={x:6,z:0})),'COMPOSITION_BLOCKS_ARRIVAL');await unchanged(owner,r,before);
 for(const operation of [{kind:'object',id:chair.id,before:null,after:chair},{kind:'terrain',x:6,z:0,before:null,after:[6,0,'stone',true]}]){
  const payload={version:1,operationId:randomUUID(),baseRevision:before.revision,contextHash:await hashSceneContext(before.scene),operations:[operation],personalAreaRevisions:{},admission:owner.admission};
  const result=await owner.call(`/api/rooms/${r.id}/scene/operations`,'POST',payload);assert.equal(result.status,409,JSON.stringify(result));await unchanged(owner,r,before);
 }
 // A simultaneous deletion removes the restriction; nonblocking ground and
 // decorative components are allowed underneath other furniture.
 ok(await save(owner,r,s=>{s.objects=[];s.terrain={version:1,cells:[[6,0,'stone',true]]};}));
 ok(await save(owner,r,s=>{s.terrain={version:1,cells:[]};s.objects=[object(asset),{...chair,id:'other-a',x:-6},{...chair,id:'other-b',x:-6}];}));
 ok(await save(owner,r,s=>{s.objects.find(o=>o.id==='other-a').name='Keep unrelated legacy overlap';}));
 const decorative=document();decorative.components[0].collision='none';const decor=await publish(owner,r,decorative);ok(await save(owner,r,s=>s.objects.push(object(decor,'decor',-6))));
});


test('furniture: both trusted image and composition contexts bind before mixed geometry authority',async t=>{
 const {owner,room:r}=await setup(t),asset=await publish(owner,r),image=ok(await owner.call(`/api/rooms/${r.id}/assets`,'POST',{draft:{name:'Solid image',floating:false,collisionGrid:[[1]]},operationId:randomUUID(),mediaType:'image/png',pngBase64:makePng({width:32,height:32}).toString('base64')}),201);
 const picture={id:'mixed-image',name:'Image',type:'image',x:-6,z:0,rotation:0,assetRef:{assetId:image.definition.assetId,versionId:image.version.versionId}};
 ok(await save(owner,r,s=>s.objects.push(picture,object(asset))));const before=await current(owner,r);
 assert.equal(code(await save(owner,r,s=>s.objects.find(o=>o.id==='placed').x=-6)),'COMPOSITION_OVERLAP');await unchanged(owner,r,before);
 assert.equal(code(await save(owner,r,s=>s.objects.find(o=>o.id==='mixed-image').x=6)),'COMPOSITION_OVERLAP');await unchanged(owner,r,before);
});
