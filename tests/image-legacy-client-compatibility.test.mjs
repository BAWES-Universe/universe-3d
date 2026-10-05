/** The exact old schema remains strict; the current server retires its stream
 * before publishing dimensions. No incompatible fields are stripped. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createGameServer} from '../server/app.mjs';
import {emptyScene} from '../src/worlds.js';
import {bindImageDefinitions, imageGeometry} from '../src/image-asset-context.js';
import {makePng} from '../fixtures/png-fixtures.mjs';
const legacyUrl=new URL('./fixtures/image-asset-schema-bc715.js',import.meta.url);
const contextSource=(await readFile(new URL('../src/image-asset-context.js',import.meta.url),'utf8'))
 .replace("'./composition-context.js'",JSON.stringify(new URL('../src/composition-context.js',import.meta.url).href))
 .replace("'./image-asset-schema.js'",JSON.stringify(legacyUrl.href))
 .replace("'./image-asset-geometry.js'",JSON.stringify(new URL('../src/image-asset-geometry.js',import.meta.url).href));
const legacyContext=await import('data:text/javascript;base64,'+Buffer.from(contextSource).toString('base64'));

test('legacy SSE retires before sized peer data; the pinned old schema still rejects new fields',async t=>{
 const app=createGameServer(),address=await app.listen(0),base=`http://127.0.0.1:${address.port}`;
 const abort=new AbortController();let cookie='';
 t.after(async()=>{abort.abort();await app.close();});
 async function call(path,method='GET',body){const response=await fetch(base+path,{method,headers:{Cookie:cookie,'X-Universe-Client-Capabilities':'image-physical-size-v1',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];const data=await response.json();assert(response.ok,JSON.stringify(data));return data;}
 await call('/api/session','POST',{name:'Old and new tab fixture'});
 const world=(await call('/api/worlds','POST',{name:'Compatibility fixture'})).world;
 const room=(await call('/api/rooms','POST',{worldId:world.id,name:'Compatibility room',scene:emptyScene()})).room;
 await call(`/api/rooms/${room.id}/join`,'POST',{});
 // The old URL has no per-tab capability. A current sibling shares this cookie.
 const stream=await fetch(base+'/api/events',{headers:{Cookie:cookie},signal:abort.signal});assert.equal(stream.status,200);
 const reader=stream.body.getReader();let buffered='';
 async function event(type){while(true){const delimiter=buffered.indexOf('\n\n');if(delimiter>=0){const chunk=buffered.slice(0,delimiter);buffered=buffered.slice(delimiter+2);if(chunk.includes('event: '+type+'\n'))return JSON.parse(chunk.split('\n').find(line=>line.startsWith('data: ')).slice(6));continue;}const next=await reader.read();assert.equal(next.done,false);buffered+=Buffer.from(next.value).toString();}}
 await event('hello');
 app.setImagePhysicalSizeEnabledForTest(true);
 const retired=await event('access-revoked');assert.equal(retired.code,'CLIENT_RELOAD_REQUIRED');assert.equal(retired.recoverDraft,true);assert.equal(retired.roomId,room.id);assert.equal((await event('access-revoked')).roomId,null);assert.equal((await reader.read()).done,true,'old stream ends before any sized scene');assert(!buffered.includes('widthMetres'));
 const bytes=makePng({width:1024,height:1024});
 const entry=await call(`/api/rooms/${room.id}/assets`,'POST',{operationId:'size-gate',draft:{name:'Sized peer asset',widthMetres:2,heightMetres:2,depthPreset:'floor'},mediaType:'image/png',pngBase64:bytes.toString('base64')});
 const latest=(await call(`/api/rooms/${room.id}`)).room;
 const object={id:'sized-peer-object',type:'image',assetRef:{assetId:entry.definition.assetId,versionId:entry.version.versionId},x:0,z:0,rotation:0};
 await call(`/api/rooms/${room.id}/scene`,'PUT',{revision:latest.revision,scene:{...latest.scene,objects:[object]}});
 const envelope=await call(`/api/rooms/${room.id}`);assert.equal(envelope.room.id,room.id);
 assert.equal(Object.values(envelope.room.imageDefinitions)[0].version.widthMetres,2,'capable authorized response preserves authoritative dimensions');
 const parsed=JSON.parse(JSON.stringify(envelope));let reconciled=false;
 assert.throws(()=>{legacyContext.bindImageDefinitions(parsed.room.scene,parsed.room.imageDefinitions,room.id);reconciled=true;},error=>error.code==='UNSUPPORTED_IMAGE_FIELD'&&error.field==='version.widthMetres');
 assert.equal(reconciled,false,'old main handleEvent exits before editor.receiveScene');
 bindImageDefinitions(envelope.room.scene,envelope.room.imageDefinitions,room.id);
 const geometry=imageGeometry(envelope.room.scene,object);assert.equal(geometry.render.width,2);assert.equal(geometry.editBounds.width,2);
});

test('legacy schema fixture keeps its exact baseline bytes',async()=>{
 assert.equal(createHash('sha256').update(await readFile(legacyUrl)).digest('hex'),'65f0dcda4475ecf83d3a2d5960eb72daa0daae6a8baa0b1d1c8c0463b00de122');
});
