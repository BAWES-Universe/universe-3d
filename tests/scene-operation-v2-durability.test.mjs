// Exercise v1 receipt migration and v2 recovery through public HTTP and real SQLite.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {makePng} from '../fixtures/png-fixtures.mjs';
import {createGameServer} from '../server/app.mjs';
import {hashSceneContext,hashSceneField,hashSceneOperationDependencies} from '../src/scene-operations.js';
const initial=()=>({version:1,theme:'garden',bounds:{width:32,depth:26},spawn:{x:0,z:10},objects:[],areas:[]});
const area=()=>({id:'personal',name:'Personal',x:-6,z:0,width:6,depth:6,action:'welcome',personalArea:{mode:'dynamic',allowedTags:[]}});
const ok=(result,status=200)=>{assert.equal(result.status,status,JSON.stringify(result));return result.data;};
const endpoint=room=>`/api/rooms/${room.id}/scene/operations`;
async function start(database=':memory:'){
 const app=createGameServer({database,questsEnabled:false}),{port}=await app.listen(0),url=`http://127.0.0.1:${port}`;
 const client=(cookie='')=>({cookie,async call(path,method='GET',body){
  const response=await fetch(url+path,{method,headers:{cookie:this.cookie,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  if(response.headers.get('set-cookie'))this.cookie=response.headers.get('set-cookie').split(';')[0];return{status:response.status,data:await response.json()};
 }});
 return{app,client};
}
async function setup(f){
 const owner=f.client();ok(await owner.call('/api/session','POST',{name:'Protocol owner'}),201);
 const world=ok(await owner.call('/api/worlds','POST',{name:'Durability world'}),201).world;
 const room=ok(await owner.call('/api/rooms','POST',{worldId:world.id,name:'Durable room',scene:initial()}),201).room;
 return{owner,room};
}
async function enter(owner,room){const result=ok(await owner.call(`/api/rooms/${room.id}/join`,'POST',{mode:'enter'}));owner.admission=Object.fromEntries(['admissionId','admissionEpoch','admissionRevision'].map(key=>[key,result.arrival[key]]));return result.room;}
async function batch(owner,base,operations,version=2,definitions=base.imageDefinitions??{}){return{version,operationId:randomUUID(),baseRevision:base.revision,contextHash:await hashSceneContext(base.scene,version),operations,admission:owner.admission,...(version===2?{dependenciesHash:await hashSceneOperationDependencies(base.scene,operations,definitions)}:{})};}
const durable=store=>Object.fromEntries(['rooms','personal_areas','personal_area_objects','scene_operation_receipts','scene_operation_journal'].map(table=>[table,store.all(`SELECT * FROM ${table} ORDER BY rowid`)]));

test('v1 receipt rows migrate unchanged and v2 receipt versions survive actual database reopen',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'scene-v2-migration-')),database=join(directory,'game.sqlite');let f=await start(database);
 t.after(async()=>{await f?.app.close();await rm(directory,{recursive:true,force:true});});
 const{owner,room}=await setup(f),base=await enter(owner,room);
 const v1=await batch(owner,base,[{kind:'object',id:'legacy',before:null,after:{id:'legacy',type:'chair',x:6,z:0}}],1),savedV1=ok(await owner.call(endpoint(room),'POST',v1)),cookie=owner.cookie;
 const original=f.app.store.get('SELECT actor_id,operation_id,room_id,request_hash,applied_revision FROM scene_operation_receipts WHERE operation_id=?',v1.operationId);
 const oldJournal=f.app.store.all('SELECT * FROM scene_operation_journal ORDER BY room_id,revision');await f.app.close();f=null;
 const db=new DatabaseSync(database);try{db.exec('ALTER TABLE scene_operation_receipts DROP COLUMN protocol_version');}finally{db.close();}
 f=await start(database);const restored=f.client(cookie),current=await enter(restored,room);
 const migrated=f.app.store.get('SELECT * FROM scene_operation_receipts WHERE operation_id=?',v1.operationId);assert.deepEqual({...migrated},{...original,protocol_version:1});assert.deepEqual(f.app.store.all('SELECT * FROM scene_operation_journal ORDER BY room_id,revision'),oldJournal);
 const recoveredV1=ok(await restored.call(endpoint(room),'POST',{...v1,admission:restored.admission}));assert.equal(recoveredV1.duplicate,true);assert.deepEqual(recoveredV1.receipt,savedV1.receipt);assert.equal(recoveredV1.room.revision,current.revision);
 const operations=[{kind:'area',id:'personal',before:null,after:area()},{kind:'scene',field:'theme',before:await hashSceneField(current.scene,'theme'),after:'studio'}];
 const v2=await batch(restored,current,operations),savedV2=ok(await restored.call(endpoint(room),'POST',v2));assert.equal(savedV2.receipt.version,2);
 await f.app.close();f=null;f=await start(database);const again=f.client(cookie);await enter(again,room);
 const recoveredV2=ok(await again.call(endpoint(room),'POST',{...v2,admission:again.admission}));assert.equal(recoveredV2.duplicate,true);assert.deepEqual(recoveredV2.receipt,savedV2.receipt);assert.equal(recoveredV2.room.revision,savedV2.room.revision);
 assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM personal_areas WHERE room_id=?',room.id).n,1);
 const replay=ok(await again.call(endpoint(room)+'?after=0'));assert.equal(replay.mode,'replay');assert.deepEqual(replay.snapshots.map(s=>s.revision),[1,2]);assert.deepEqual(replay.snapshots[1].scene,savedV2.room.scene);
 // Retrying a v2 ID as an otherwise valid v1 request must never become a new commit.
 const downgraded={...v1,operationId:v2.operationId,admission:again.admission};const rejected=await again.call(endpoint(room),'POST',downgraded);assert.equal(rejected.status,409);assert.equal(rejected.data.error?.code??rejected.data.code,'OPERATION_REUSED');
});

for(const failTable of ['scene_operation_receipts','scene_operation_journal'])test(`v2 ${failTable} failure rolls back area registration, mixed scene edits and identity`,async t=>{
 const f=await start();t.after(()=>f.app.close());const{owner,room}=await setup(f),base=await enter(owner,room);
 const operations=[{kind:'area',id:'personal',before:null,after:area()},{kind:'object',id:'item',before:null,after:{id:'item',type:'chair',x:6,z:0}},{kind:'terrain',x:8,z:5,before:null,after:[8,5,'wood',false]},{kind:'scene',field:'theme',before:await hashSceneField(base.scene,'theme'),after:'studio'}];
 const payload=await batch(owner,base,operations),snapshot=durable(f.app.store);
 f.app.store.db.exec(`CREATE TEMP TRIGGER fail_v2 BEFORE INSERT ON ${failTable} BEGIN SELECT RAISE(ABORT,'Injected v2 durability failure'); END`);
 const rejected=await owner.call(endpoint(room),'POST',payload);f.app.store.db.exec('DROP TRIGGER fail_v2');assert.equal(rejected.status,500);assert.deepEqual(durable(f.app.store),snapshot);
 const saved=ok(await owner.call(endpoint(room),'POST',payload));assert.equal(saved.duplicate,false);assert.equal(saved.room.revision,base.revision+1);assert.equal(saved.receipt.version,2);assert.equal(saved.room.personalAreas.length,1);
 const retry=ok(await owner.call(endpoint(room),'POST',payload));assert.equal(retry.duplicate,true);assert.deepEqual(retry.receipt,saved.receipt);
});


for(const first of ['image','area'])test(`v2 full transparent image dependencies resolve authoritatively in ${first}-first order`,async t=>{
 const f=await start();t.after(()=>f.app.close());const{owner,room}=await setup(f),base=await enter(owner,room);
 const entry=ok(await owner.call(`/api/rooms/${room.id}/assets`,'POST',{operationId:randomUUID(),draft:{name:'Transparent full footprint',tags:[]},mediaType:'image/png',pngBase64:makePng({width:96,height:64,pixel:()=>[0,0,0,0]}).toString('base64')}),201);
 const ref={assetId:entry.definition.assetId,versionId:entry.version.versionId},definitions={[`${ref.assetId}:${ref.versionId}`]:entry};
 const image={kind:'object',id:'transparent',before:null,after:{id:'transparent',type:'image',assetRef:ref,x:6,z:0,rotation:0}};
 // Full image rectangle reaches x=7.5 despite every pixel being transparent;
 // this area starts at the same boundary. Opacity cannot erase its dependency.
 const areaOp={kind:'area',id:'neighbor',before:null,after:{id:'neighbor',name:'Neighbor',x:8.5,z:0,width:2,depth:2,action:'silent'}};
 const operations={image,area:areaOp},second=first==='image'?'area':'image';
 const a=await batch(owner,base,[operations[first]],2,definitions),b=await batch(owner,base,[operations[second]],2,definitions);
 const saved=ok(await owner.call(endpoint(room),'POST',a)),effects=durable(f.app.store);
 const rejected=await owner.call(endpoint(room),'POST',b);assert.equal(rejected.status,409,JSON.stringify(rejected));assert(rejected.data.conflicts.some(c=>c.kind==='dependencies'));assert.deepEqual(durable(f.app.store),effects);
 const reviewed=await batch(owner,saved.room,[operations[second]],2,definitions),merged=ok(await owner.call(endpoint(room),'POST',reviewed));
 assert.equal(merged.room.scene.objects.length,1);assert.equal(merged.room.scene.areas.length,1);assert.equal(merged.receipt.version,2);
});
