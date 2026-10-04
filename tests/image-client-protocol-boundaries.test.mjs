/** Independent protocol boundaries: partial HTTP bodies, capability isolation,
 * immutable image version/scene data, and compatible-runtime rollback. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGameServer} from '../server/app.mjs';
import {Store} from '../server/store.mjs';
import {initializeImageAssetSchema,createImageAssetRepository} from '../server/image-asset-store.mjs';
import {createImageAssetService} from '../server/image-assets.mjs';
import {validatePng} from '../server/png-validation.mjs';
import {emptyScene} from '../src/worlds.js';
import {hashSceneContext,hashSceneObject} from '../src/scene-operations.js';
import {makePng} from '../fixtures/png-fixtures.mjs';
const capability='image-physical-size-v1',header={'X-Universe-Client-Capabilities':capability};
const initial={...emptyScene(),objects:[{id:'a',type:'chair',name:'Original',x:-4,z:-3,rotation:0}]};
const seeds=[{id:'world',name:'Protocol test',rooms:[{id:'room',name:'Protocol room',scene:initial}]}];
const code=value=>value.code??value.error?.code??value.error;
async function fixture(t,options={}){
 let app=createGameServer({seeds,questsEnabled:false,...options});const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`;let cookie='';
 t.after(()=>app.close());
 async function call(path,method='GET',body,capable=true){const response=await fetch(base+path,{method,signal:AbortSignal.timeout(10000),headers:{Connection:'close',Cookie:cookie,...(capable?header:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return{status:response.status,body:await response.json()};}
 async function ok(...args){const result=await call(...args);assert(result.status<400,JSON.stringify(result));return result.body;}
 await ok('/api/session','POST',{name:'Synthetic boundary owner'},false);const joined=await ok('/api/rooms/room/join','POST',{},true);
 return{get app(){return app;},port,base,call,ok,get cookie(){return cookie;},joined,async restart(enabled){await app.close();app=createGameServer({seeds,questsEnabled:false,...options,imagePhysicalSizeEnabled:enabled});await app.listen(port);}};
}
async function partial(f,path,method,body,capable=false){
 const encoded=JSON.stringify(body);let respond,fail,observed;const completed=new Promise((resolve,reject)=>{respond=resolve;fail=reject;}),seen=new Promise(resolve=>{observed=resolve;});
 const listener=req=>{if(req.url===path&&req.method===method)observed();};f.app.server.on('request',listener);
 const req=http.request(f.base+path,{method,headers:{Cookie:f.cookie,'Content-Type':'application/json','Content-Length':Buffer.byteLength(encoded),...(capable?header:{})}},response=>{let bytes='';response.setEncoding('utf8');response.on('data',chunk=>bytes+=chunk);response.on('end',()=>respond({status:response.statusCode,body:JSON.parse(bytes)}));});
 req.on('error',fail);req.setTimeout(10000,()=>req.destroy(Error('partial request timed out')));req.write(encoded.slice(0,-1));await seen;f.app.server.off('request',listener);
 return{complete:()=>{req.end(encoded.slice(-1));return completed;}};
}
async function stream(f,capable){
 const abort=new AbortController(),response=await fetch(f.base+'/api/events'+(capable?'?capabilities='+capability:''),{headers:{Cookie:f.cookie},signal:abort.signal});assert.equal(response.status,200);let buffered='';const reader=response.body.getReader(),events=[];
 const next=async()=>{for(;;){const index=buffered.indexOf('\n\n');if(index>=0){const raw=buffered.slice(0,index);buffered=buffered.slice(index+2);const type=raw.split('\n').find(line=>line.startsWith('event: '))?.slice(7),data=raw.split('\n').find(line=>line.startsWith('data: '))?.slice(6);if(type&&data){const event={type,data:JSON.parse(data)};events.push(event);return event;}continue;}const part=await reader.read();if(part.done)return null;buffered+=Buffer.from(part.value).toString();}};
 const until=async type=>{for(let i=0;i<40;i++){const event=await next();assert(event,'Stream ended before '+type);if(event.type===type)return event;}throw Error('Too many events before '+type);};
 return{next,until,events,close:()=>abort.abort()};
}

test('queued legacy scene and scene-operation bodies cannot commit after activation',async t=>{
 for(const kind of ['cas','operations'])await t.test(kind,async t=>{
  const f=await fixture(t),next=structuredClone(initial);next.objects[0].name='Queued obsolete write';
  const body=kind==='cas'?{revision:0,scene:next}:{version:1,operationId:'queued-old-operation',baseRevision:0,contextHash:await hashSceneContext(initial),operations:[{kind:'object',id:'a',before:await hashSceneObject(initial.objects[0]),after:next.objects[0]}],admission:{admissionId:f.joined.arrival.admissionId,admissionEpoch:f.joined.arrival.admissionEpoch,admissionRevision:f.joined.arrival.admissionRevision}};
  const pending=await partial(f,'/api/rooms/room/scene'+(kind==='operations'?'/operations':''),kind==='cas'?'PUT':'POST',body);
  f.app.setImagePhysicalSizeEnabledForTest(true);const result=await pending.complete();assert.equal(result.status,426);assert.equal(code(result.body),'CLIENT_RELOAD_REQUIRED');
  const room=(await f.ok('/api/rooms/room')).room;assert.equal(room.revision,0);assert.deepEqual(room.scene,initial);assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM scene_operation_receipts').n,0);
 });
});

test('old and current EventSources sharing a cookie remain independent and never strip sized geometry',async t=>{
 const f=await fixture(t),old=await stream(f,false),current=await stream(f,true);t.after(()=>{old.close();current.close();});await old.until('hello');await current.until('hello');
 f.app.setImagePhysicalSizeEnabledForTest(true);
 const retirement=await old.until('access-revoked');assert.equal(retirement.data.roomId,'room');assert.equal(retirement.data.recoverDraft,true);assert.equal(retirement.data.code,'CLIENT_RELOAD_REQUIRED');assert.match(retirement.data.reason,/reload/i);assert.equal((await old.next()).data.roomId,null,'Global retirement follows the targeted in-flight arrival denial');assert.equal(await old.next(),null,'Old stream closes before any newly enabled content');
 const policy=await current.until('client-protocol');assert.deepEqual(policy.data.imagePhysicalSize,{enabled:true,required:true,capability});
 const png=makePng({width:64,height:32}),entry=await f.ok('/api/rooms/room/assets','POST',{operationId:'current-sized-image',draft:{name:'Dimension authority',widthMetres:4,heightMetres:2,depthPreset:'floor'},mediaType:'image/png',pngBase64:png.toString('base64')});
 const next=structuredClone(initial);next.objects.push({id:'sized',type:'image',assetRef:{assetId:entry.definition.assetId,versionId:entry.version.versionId},x:3,z:0,rotation:0});
 const committed=(await f.ok('/api/rooms/room/scene','PUT',{revision:0,scene:next})).room;
 const pushed=(await current.until('scene')).data.room;assert.deepEqual(pushed.imageDefinitions,committed.imageDefinitions);assert.equal(Object.values(pushed.imageDefinitions)[0].version.widthMetres,4);assert.equal(Object.values(pushed.imageDefinitions)[0].version.heightMetres,2);
 for(const path of ['/api/session','/api/rooms/room','/api/rooms/room/assets']){const result=await f.call(path,'GET',undefined,false);assert.equal(result.status,426,path);assert.equal(code(result.body),'CLIENT_RELOAD_REQUIRED');assert(!JSON.stringify(result.body).includes('widthMetres'));}
 const binary=await fetch(f.base+`/api/rooms/room/assets/${entry.definition.assetId}/versions/${entry.version.versionId}/image`,{headers:{Cookie:f.cookie},signal:AbortSignal.timeout(10000)});assert.equal(binary.status,200,'Authenticated PNG bytes have no geometry metadata and keep their ordinary ACL');assert.deepEqual(Buffer.from(await binary.arrayBuffer()),png);
 const untrusted=await f.call('/api/rooms/room?capabilities='+capability,'GET',undefined,false);assert.equal(untrusted.status,426,'Capability query applies only to EventSource');
 const reconnect=await stream(f,false);t.after(()=>reconnect.close());assert.equal((await reconnect.next()).data.roomId,'room');assert.equal((await reconnect.next()).data.roomId,null);assert.equal(await reconnect.next(),null);
 const stillJoined=await f.ok('/api/session');assert.equal(stillJoined.currentRoomId,'room','Revoking an old sibling must not retire the shared session');
});

test('queued old upload cannot finish after its reader protocol is retired',async t=>{
 const f=await fixture(t),png=makePng({width:32,height:32});
 const pending=await partial(f,'/api/rooms/room/assets','POST',{operationId:'queued-old-upload',draft:{name:'Queued old PNG',depthPreset:'floor'},mediaType:'image/png',pngBase64:png.toString('base64')},false);
 f.app.setImagePhysicalSizeEnabledForTest(true);const result=await pending.complete();assert.equal(result.status,426);assert.equal(code(result.body),'CLIENT_RELOAD_REQUIRED');assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM room_image_asset_versions').n,0);
});

test('a capable upload waiting for its body fails closed when sizing is switched off',async t=>{
 const f=await fixture(t,{imagePhysicalSizeEnabled:true}),png=makePng({width:32,height:32});
 const pending=await partial(f,'/api/rooms/room/assets','POST',{operationId:'disable-during-body',draft:{name:'Deferred size',widthMetres:3,heightMetres:3,depthPreset:'floor'},mediaType:'image/png',pngBase64:png.toString('base64')},true);
 f.app.setImagePhysicalSizeEnabledForTest(false);const result=await pending.complete();assert.equal(result.status,409);assert.equal(code(result.body),'IMAGE_PHYSICAL_SIZE_DISABLED');assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM room_image_asset_versions').n,0);
});

test('persisted minimum reader survives compatible-runtime disable and keeps immutable dimensions',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'image-protocol-boundary-')),f=await fixture(t,{database:join(directory,'state.sqlite'),imagePhysicalSizeEnabled:true}),png=makePng({width:32,height:32});
 const entry=await f.ok('/api/rooms/room/assets','POST',{operationId:'persisted-size',draft:{name:'Persistent dimensions',widthMetres:2,heightMetres:2,depthPreset:'floor'},mediaType:'image/png',pngBase64:png.toString('base64')});
 const before=f.app.store.get('SELECT version_json,sha256,byte_length,bytes FROM room_image_asset_versions WHERE version_id=?',entry.version.versionId);
 await f.restart(false);const protocol=await f.ok('/api/client-protocol'),status=protocol.imagePhysicalSize;assert.deepEqual(protocol.storageCompatibility,{version:1,requiredReaderCapabilities:[capability]});assert.deepEqual(status,{enabled:false,required:true,capability});
 const after=f.app.store.get('SELECT version_json,sha256,byte_length,bytes FROM room_image_asset_versions WHERE version_id=?',entry.version.versionId);assert.deepEqual(after,before);
 assert.equal((await f.call('/api/rooms/room','GET',undefined,false)).status,426);const current=await f.ok('/api/rooms/room/assets');assert.equal(current.entries[0].version.widthMetres,2);
});


test('startup recognizes valid existing sized data without removing or rewriting any floor',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'image-existing-sized-')),database=join(directory,'state.sqlite');
 // Construct a new synthetic database through its repository/service contract.
 // This represents an earlier sizing writer and never deletes an existing floor.
 const store=new Store(database,seeds);initializeImageAssetSchema(store.db);const user=store.createUser('Synthetic earlier writer','0'),repo=createImageAssetRepository(store.db);
 const service=createImageAssetService({repo,authorizeRead:()=>true,authorizeManage:()=>true,resolveSession:()=>({userId:user.id,currentRoomId:'room',expiresAt:Date.now()+60000}),validateImage:validatePng,isPhysicalSizeEnabled:()=>true});
 const entry=await service.create({roomId:'room',userId:user.id,sessionIdentity:'synthetic-writer-session',operationId:'earlier-valid-size',draft:{name:'Earlier sized artwork',widthMetres:5,heightMetres:3,depthPreset:'floor'},mediaType:'image/png',bytes:makePng({width:64,height:32})});
 assert.equal(store.get('SELECT value FROM metadata WHERE key=?','image_physical_size_protocol_floor'),undefined);
 const before=store.get('SELECT version_json,sha256,byte_length,bytes FROM room_image_asset_versions WHERE version_id=?',entry.version.versionId);store.close();
 const f=await fixture(t,{database,imagePhysicalSizeEnabled:false}),protocol=await f.ok('/api/client-protocol');
 assert.deepEqual(protocol.imagePhysicalSize,{enabled:false,required:true,capability});assert.deepEqual(protocol.storageCompatibility,{version:1,requiredReaderCapabilities:[capability]});
 assert.equal(f.app.store.get('SELECT value FROM metadata WHERE key=?','image_physical_size_protocol_floor').value,capability);
 assert.deepEqual(f.app.store.get('SELECT version_json,sha256,byte_length,bytes FROM room_image_asset_versions WHERE version_id=?',entry.version.versionId),before);
 assert.equal((await f.call('/api/rooms/room','GET',undefined,false)).status,426);
});

test('retirement denies current and captured stream rooms before the global fallback',async t=>{
 const f=await fixture(t),old=await stream(f,false);t.after(()=>old.close());await old.until('hello');
 const other=(await f.ok('/api/rooms','POST',{worldId:'world',name:'Synthetic next room',scene:emptyScene()})).room;
 await f.ok('/api/rooms/'+other.id+'/join','POST',{});f.app.setImagePhysicalSizeEnabledForTest(true);
 const events=[await old.until('access-revoked'),await old.next(),await old.next()];assert.deepEqual(events.map(event=>event.data.roomId),[other.id,'room',null]);
 for(const event of events){assert.equal(event.type,'access-revoked');assert.equal(event.data.code,'CLIENT_RELOAD_REQUIRED');assert(!JSON.stringify(event).includes('widthMetres'));}
 assert.equal(await old.next(),null);assert.equal((await f.ok('/api/session')).currentRoomId,other.id,'Retiring one old stream never revokes the shared session membership');
});
