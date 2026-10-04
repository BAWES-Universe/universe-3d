import {clientProtocolHeaders} from '../src/client-protocol.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds} from '../src/worlds.js';
import {makePng} from '../fixtures/png-fixtures.mjs';

// All HTTP requests and persisted records belong to fresh, local test servers.
const personalArea = (id = 'desk-a', x = -6) => ({id, name: id, x, z: 0, width: 8, depth: 8, action: 'welcome', personalArea: {mode: 'dynamic', allowedTags: []}});
const emptyScene = (areas = []) => ({version: 1, theme: 'garden', bounds: {width: 32, depth: 26}, spawn: {x: 0, z: 10}, objects: [], areas});
const reference = entry => ({assetId: entry.definition.assetId, versionId: entry.version.versionId});
const referenceKey = entry => `${entry.definition.assetId}:${entry.version.versionId}`;
const imagePath = (room, entry) => `/api/rooms/${room.id}/assets/${entry.definition.assetId}/versions/${entry.version.versionId}/image`;
const imageObject = (entry, id = 'placed-image', x = 6, z = 0, rotation = 0) => ({id, type: 'image', name: id, assetRef: reference(entry), x, z, rotation});
const uploadBody = (bytes = makePng(), draft = {name: '  Oak image  ', tags: 'Tree, green, TREE'}, operationId = randomUUID()) => ({draft, operationId, mediaType: 'image/png', pngBase64: bytes.toString('base64')});
const describe = response => JSON.stringify({status: response.status, data: response.data});

async function start(database = ':memory:') {
  const app = createGameServer({database, seeds: seedWorlds,imagePhysicalSizeEnabled:true});
  const {port} = await app.listen(0), base = `http://127.0.0.1:${port}`;
  const client = (cookie = '') => ({cookie, async call(path, method = 'GET', body, headers = {}) {
    const response = await fetch(base + path, {
      method, headers: clientProtocolHeaders({Cookie: this.cookie, ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers}),
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const bytes = Buffer.from(await response.arrayBuffer());
    return {status: response.status, headers: response.headers, bytes, data: bytes.length && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes) : undefined};
  }});
  const account = async (name, registered = false) => {
    const c = client(), response = await c.call('/api/session', 'POST', {name});
    assert.equal(response.status, 201, describe(response)); c.user = response.data.user;
    if (registered) assert.equal((await c.call('/api/account', 'POST', {username: 'img_' + randomUUID().replaceAll('-', '').slice(0, 20), password: 'local image test account password'})).status, 201);
    return c;
  };
  return {app, port, base, client, account};
}
async function joinRoom(client, room) {const response = await client.call(`/api/rooms/${room.id}/join`, 'POST', {}); assert.equal(response.status, 200, describe(response)); return response.data.room;}
async function latest(client, room) {const response = await client.call(`/api/rooms/${room.id}`); assert.equal(response.status, 200, describe(response)); return response.data.room;}
async function createRoom(owner, world, areas = [], name = 'Image test room') {
  const response = await owner.call('/api/rooms', 'POST', {worldId: world.id, name, scene: emptyScene(areas)});
  assert.equal(response.status, 201, describe(response)); return response.data.room;
}
async function setup(t, areas = []) {
  const f = await start(); t.after(() => f.app.close());
  const owner = await f.account('Image manager'), alice = await f.account('Image Alice', true), bob = await f.account('Image Bob');
  const created = await owner.call('/api/worlds', 'POST', {name: 'Image asset integration'});
  assert.equal(created.status, 201, describe(created)); const world = created.data.world;
  const room = await createRoom(owner, world, areas); await joinRoom(owner, room);
  return {...f, owner, alice, bob, world, room};
}
async function upload(client, room, body = uploadBody(), headers) {
  const response = await client.call(`/api/rooms/${room.id}/assets`, 'POST', body, headers);
  assert.equal(response.status, 201, describe(response)); return response.data;
}
async function save(client, room, mutate, extra = {}) {
  const current = await latest(client, room), scene = structuredClone(current.scene); mutate(scene);
  return client.call(`/api/rooms/${room.id}/scene`, 'PUT', {revision: current.revision, scene, personalAreaRevisions: Object.fromEntries(current.personalAreas.map(area => [area.areaId, area.revision])), ...extra});
}
async function claim(client, room, areaId = 'desk-a') {
  const current = await joinRoom(client, room), area = current.personalAreas.find(value => value.areaId === areaId);
  assert.equal((await client.call('/api/presence', 'POST', {roomId: room.id, x: area.x, z: area.z})).status, 200);
  const response = await client.call(`/api/rooms/${room.id}/personal-areas/${areaId}/claim`, 'POST', {revision: area.revision, clientOperationId: randomUUID()});
  assert.equal(response.status, 200, describe(response)); return response.data.room;
}
async function assertRejectedUnchanged(client, room, mutate, status = 400, extra = {}) {
  const before = await latest(client, room), response = await save(client, room, mutate, extra);
  assert.equal(response.status, status, describe(response));
  const after = await latest(client, room); assert.equal(after.revision, before.revision); assert.deepEqual(after.scene, before.scene);
}

function assertImageResponse(response, bytes, method = 'GET') {
  assert.equal(response.status, 200, describe(response));
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(response.bytes, method === 'HEAD' ? Buffer.alloc(0) : bytes);
}


import {imagePhysicalSize, normalizeImageAssetDraft, suggestImagePhysicalSize} from '../src/image-asset-schema.js';
import {resolveImagePlacement, imageAlphaHitTest} from '../src/image-asset-geometry.js';
import {bindImageDefinitions} from '../src/image-asset-context.js';
import {canStand} from '../src/worlds.js';

const square = makePng({width:1024,height:1024,pixel:(x,y)=>[240,30,220,x<256&&y<256?0:255]});
async function resize(client,room,entry,width,height=width,operationId=randomUUID()) {
 return client.call(`/api/rooms/${room.id}/assets/${entry.definition.assetId}/versions`,'POST',{operationId,expectedRevision:entry.revision,expectedVersionId:entry.version.versionId,setup:{depthPreset:entry.version.depthPreset,depthPivot:entry.version.depthPivot,collisionGrid:entry.version.collisionGrid,widthMetres:width,heightMetres:height}});
}
function good(response,status=201){assert.equal(response.status,status,describe(response));return response.data;}

test('physical size: same 1024px bytes at 1, 2, 4 metres, retained legacy, rotation, scaled collision and personal bounds',async t=>{
 const f=await setup(t,[personalArea()]),{owner,alice,room}=f;
 const grid=Array.from({length:32},(_,r)=>Array.from({length:32},(_,c)=>r>=16&&c>=16?1:0));
 const legacy=await upload(owner,room,uploadBody(square,{name:'High resolution',floating:false,collisionGrid:grid}));
 assert.deepEqual(imagePhysicalSize(legacy.version),{widthMetres:32,heightMetres:32});
 const original=JSON.stringify(legacy.version),versions=[];let current=legacy;
 for(const size of [1,2,4]){
  const next=good(await resize(owner,room,current,size)).entry;versions.push(next);current=next;
  assert.equal(next.version.sha256,legacy.version.sha256);assert.equal(next.version.widthPixels,1024);
  assertImageResponse(await owner.call(imagePath(room,next)),square);
  for(const rotation of [0,90,180,270]){
   const item=imageObject(next,'image',0,0,rotation),g=resolveImagePlacement(next,item);
   assert.equal(g.render.width,size);assert.equal(g.render.height,size);assert.equal(g.editBounds.width,size);assert.equal(g.collisionCells.length,256);
   assert.equal(g.collisionCells[0].width,size/32);assert.equal(g.pickDescriptor.pixelWidth,1024);
   const scene=emptyScene();scene.objects=[item];bindImageDefinitions(scene,{[referenceKey(next)]:next},room.id);
   const c=g.collisionCells[0];assert.equal(canStand(scene,c.x,c.z,0),false);assert.equal(canStand(scene,8,8,0),true);
  }
 }
 assert.equal(JSON.stringify(legacy.version),original);
 assert.equal(imageAlphaHitTest({width:2,height:2,alpha:[0,255,255,255]},{u:.1,v:.1}),false);
 assert.equal(imageAlphaHitTest({width:2,height:2,alpha:[0,255,255,255]},{u:.9,v:.9}),true);
 // Full legacy rectangle cannot fit this room even when almost all source cells are empty.
 await assertRejectedUnchanged(owner,room,s=>s.objects=[imageObject(legacy,'huge',0,0)]);
 await claim(alice,room);
 good(await alice.call('/api/presence','POST',{roomId:room.id,x:0,z:10}),200);
 good(await save(alice,room,s=>s.objects=[imageObject(versions[2],'mine',-6,0,90)]),200);
 await assertRejectedUnchanged(alice,room,s=>s.objects[0].x=-2.1,403);
 good(await save(alice,room,s=>s.objects.push(imageObject(versions[0],'copy',-8.5,-2))),200);
 const saved=(await latest(alice,room)).scene;
 good(await save(alice,room,s=>s.objects.pop()),200); // deletion/undo effect retains original pin
 good(await save(alice,room,s=>s.objects=saved.objects),200);
 assert.deepEqual((await latest(owner,room)).scene,(await latest(alice,room)).scene);
 await assertRejectedUnchanged(alice,room,s=>s.objects[0].widthMetres=.1,400);
 const stretched=good(await resize(owner,room,current,4,2)).entry;
 const rotated=resolveImagePlacement(stretched,imageObject(stretched,'r',0,0,90));
 assert.deepEqual([rotated.editBounds.width,rotated.editBounds.depth],[2,4]);
 assert.deepEqual([rotated.collisionCells[0].width,rotated.collisionCells[0].depth],[2/32,4/32]);
});

test('physical size: independent HTTP validation, exact retry identity, stale rejection, no-op and archive',async t=>{
 const {owner,alice,room}=await setup(t);
 const first=await upload(owner,room,uploadBody(square,{name:'Sized upload',widthMetres:1,heightMetres:1}));
 for(const value of [0,-1,64.1,null,'2']){
  assert.equal((await resize(owner,room,first,value)).status,400);
  const draft={name:'Invalid',widthMetres:value,heightMetres:1};assert.equal((await owner.call(`/api/rooms/${room.id}/assets`,'POST',uploadBody(square,draft))).status,400);
 }
 const body=uploadBody(square,{name:'Half dimension',widthMetres:2});assert.equal((await owner.call(`/api/rooms/${room.id}/assets`,'POST',body)).status,400);
 assert.equal((await resize(owner,room,first,1)).data.error.code,'IMAGE_SETUP_UNCHANGED');
 const second=good(await resize(owner,room,first,2,2,'resize-once'));
 assert.deepEqual(good(await resize(owner,room,first,2,2,'resize-once')),second);
 assert.equal((await resize(owner,room,first,4,4,'resize-once')).data.error.code,'IMAGE_OPERATION_CONFLICT');
 assert.equal((await resize(owner,room,first,4)).data.error.code,'IMAGE_REVISION_CONFLICT');
 await joinRoom(alice,room);assert.equal((await resize(alice,room,second.entry,4)).status,403);
 const archived=good(await owner.call(`/api/rooms/${room.id}/assets/${first.definition.assetId}`,'PATCH',{expectedRevision:2,status:'archived'}),200);
 assert.equal((await resize(owner,room,archived,4)).data.error.code,'IMAGE_ARCHIVED');
 assert.equal(good(await resize(owner,room,first,2,2,'resize-once')).published.versionId,second.published.versionId);
});

test('physical size: persistent old/new side by side, original bytes and pins survive server restart',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'image-physical-size-'));let f=await start(join(dir,'game.sqlite'));
 t.after(async()=>{await f.app.close();await rm(dir,{recursive:true,force:true});});
 let owner=await f.account('Size owner');const world=good(await owner.call('/api/worlds','POST',{name:'Size world'})).world;
 let room=await createRoom(owner,world);await joinRoom(owner,room);
 good(await save(owner,room,s=>s.bounds={width:80,depth:80}),200);
 const old=await upload(owner,room,uploadBody(square,{name:'Legacy'}));
 const resized=good(await resize(owner,room,old,2)).entry;
 good(await save(owner,room,s=>s.objects=[imageObject(old,'old',-18,0),imageObject(resized,'new',5,0)]),200);
 const before=await latest(owner,room),cookie=owner.cookie;
 await f.app.close();f=await start(join(dir,'game.sqlite'));owner=f.client(cookie);await joinRoom(owner,room);
 const after=await latest(owner,room);assert.deepEqual(after.scene,before.scene);
 for(const e of [old,resized]){assertImageResponse(await owner.call(imagePath(room,e)),square);assert.deepEqual(after.imageDefinitions[referenceKey(e)].version,e.version);}
});

test('physical size: aspect-preserving useful defaults and strict numeric metadata',()=>{
 assert.deepEqual(suggestImagePhysicalSize(1024,1024,{width:32,depth:26}),{widthMetres:2,heightMetres:2});
 assert.deepEqual(suggestImagePhysicalSize(1024,512,{width:4,depth:8}),{widthMetres:1,heightMetres:.5});
 for(const dimensions of [[1,2048],[2048,1]]){
  const suggested=suggestImagePhysicalSize(...dimensions);
  assert.doesNotThrow(()=>normalizeImageAssetDraft({name:'Extreme',...suggested},{width:dimensions[0],height:dimensions[1],byteLength:100,mediaType:'image/png'}));
 }
});

import {hashSceneContext} from '../src/scene-operations.js';
test('physical size: two independent stale clients converge; operation geometry rejects overlaps and room-edge overflow',async t=>{
 const {owner,alice,room}=await setup(t);
 good(await owner.call(`/api/rooms/${room.id}/members/${alice.user.id}`,'PUT',{role:'editor'}),200);
 const grid=Array.from({length:32},()=>Array(32).fill(1));
 const e=await upload(owner,room,uploadBody(square,{name:'Solid two metre',floating:false,collisionGrid:grid,widthMetres:2,heightMetres:2}));
 const admissions=new Map();
 for(const c of [owner,alice]){const response=good(await c.call(`/api/rooms/${room.id}/join`,'POST',{}),200);admissions.set(c,Object.fromEntries(['admissionId','admissionEpoch','admissionRevision'].map(k=>[k,response.arrival[k]])));}
 const base=await latest(owner,room);
 async function request(c,object,current=base){return c.call(`/api/rooms/${room.id}/scene/operations`,'POST',{version:1,operationId:randomUUID(),baseRevision:current.revision,contextHash:await hashSceneContext(current.scene),operations:[{kind:'object',id:object.id,before:null,after:object}],personalAreaRevisions:{},admission:admissions.get(c)});}
 good(await request(owner,imageObject(e,'a',-4,0)),200);
 good(await request(alice,imageObject(e,'b',4,0,90)),200);
 assert.deepEqual((await latest(owner,room)).scene,(await latest(alice,room)).scene);
 const current=await latest(owner,room);
 const overlap=await request(owner,imageObject(e,'overlap',4.5,0),current);assert.equal(overlap.status,409,describe(overlap));
 const edge=await request(owner,imageObject(e,'edge',15.1,0),current);assert(edge.status>=400,describe(edge));
 assert.deepEqual((await latest(owner,room)).scene,current.scene);
});
