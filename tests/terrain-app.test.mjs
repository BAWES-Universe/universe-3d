import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createGameServer} from '../server/app.mjs';

const freshScene=(areas=[])=>({version:1,theme:'garden',bounds:{width:32,depth:26},spawn:{x:0,z:10},objects:[],areas});
const terrain=(...cells)=>({version:1,cells});
const describe=response=>JSON.stringify(response);
async function start(database=':memory:'){
 let time=Date.now();const app=createGameServer({database,clock:()=>time});const {port}=await app.listen(0);
 const client=(cookie='')=>({cookie,async call(path,method='GET',body){const response=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{Cookie:this.cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});const received=response.headers.get('set-cookie');if(received)this.cookie=received.split(';')[0];return{status:response.status,data:await response.json()};}});
 const account=async name=>{const c=client(),response=await c.call('/api/session','POST',{name});assert.equal(response.status,201,describe(response));c.user=response.data.user;return c;};
 return{app,port,client,account,advance:amount=>{time+=amount;}};
}
async function current(client,room){const result=await client.call(`/api/rooms/${room.id}`);assert.equal(result.status,200,describe(result));return result.data.room;}
async function joinRoom(client,room){const result=await client.call(`/api/rooms/${room.id}/join`,'POST',{});assert.equal(result.status,200,describe(result));return result.data.room;}
async function createRoom(owner,world,scene=freshScene()){const result=await owner.call('/api/rooms','POST',{worldId:world.id,name:'Terrain room',scene});assert.equal(result.status,201,describe(result));return result.data.room;}
async function setup(t,areas=[]){const f=await start();t.after(()=>f.app.close());const owner=await f.account('Terrain owner'),alice=await f.account('Terrain visitor');const world=(await owner.call('/api/worlds','POST',{name:'Terrain authority'})).data.world;const room=await createRoom(owner,world,freshScene(areas));await joinRoom(owner,room);return{...f,owner,alice,world,room};}
async function save(client,room,mutate,extra={}){const latest=await current(client,room),scene=structuredClone(latest.scene);mutate(scene);return client.call(`/api/rooms/${room.id}/scene`,'PUT',{revision:latest.revision,scene,personalAreaRevisions:Object.fromEntries(latest.personalAreas.map(area=>[area.areaId,area.revision])),...extra});}
async function rejected(client,room,mutate,status,code,extra={}){const before=await current(client,room),response=await save(client,room,mutate,extra);assert.equal(response.status,status,describe(response));if(code)assert.equal(response.data.code,code,describe(response));const after=await current(client,room);assert.equal(after.revision,before.revision);assert.deepEqual(after.scene,before.scene);return response;}

test('terrain HTTP: painting, repainting, erasing, scene CAS and SQLite restart preserve exact cells without migration',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'universe-terrain-'));let f; t.after(async()=>{await f?.app.close();await rm(directory,{recursive:true,force:true});});
 const database=join(directory,'game.sqlite');f=await start(database);const owner=await f.account('Durable terrain owner');const world=(await owner.call('/api/worlds','POST',{name:'Durable terrain'})).data.world;const room=await createRoom(owner,world);await joinRoom(owner,room);
 const schema=f.app.store.all("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name");
 const first=await save(owner,room,scene=>{scene.terrain=terrain([-2,0,'water',true],[0,0,'wood',false]);});assert.equal(first.status,200,describe(first));
 const stale=await owner.call(`/api/rooms/${room.id}/scene`,'PUT',{revision:0,scene:freshScene()});assert.equal(stale.status,409);assert.equal(stale.data.code,'REVISION_CONFLICT');
 const repainted=await save(owner,room,scene=>{scene.terrain=terrain([-2,0,'soil',false],[0,0,'wood',false]);});assert.equal(repainted.status,200);
 const erased=await save(owner,room,scene=>{scene.terrain=terrain([0,0,'wood',false]);});assert.equal(erased.status,200);
 const cookie=owner.cookie;await f.app.close();f=null;f=await start(database);const restored=await current(f.client(cookie),room);assert.deepEqual(restored.scene,erased.data.room.scene);assert.equal(restored.revision,3);
 assert.deepEqual(f.app.store.all("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name"),schema);
 assert.equal((await f.client(cookie).call(`/api/rooms/${room.id}/scene`,'PUT',{revision:restored.revision,scene:{...restored.scene,terrain:terrain()}})).status,200);
});

test('terrain HTTP: malformed/imported cells, geometry, duplicates and value budget fail atomically',async t=>{
 const {owner,world,room}=await setup(t);
 for(const bad of [null,{version:2,cells:[]},{version:1,cells:[],ownerId:'forged'},terrain([0,0,'stone','true']),terrain([.1,0,'stone',true]),terrain([16,0,'stone',true]),terrain([0,0,'lava',false]),terrain([0,0,'stone',false],[0,0,'wood',true]),terrain(...Array.from({length:4097},(_,i)=>[i%64-32,Math.floor(i/64)-32,'grass',false]))])await rejected(owner,room,scene=>{scene.terrain=bad;},400,'INVALID_TERRAIN');
 await rejected(owner,room,scene=>{scene.terrain=terrain([0,10,'water',true]);},400,'TERRAIN_BLOCKS_ARRIVAL');
 await rejected(owner,room,scene=>{scene.extra=Array.from({length:5000},()=>[1,2,3,4,5,6,7,8]);},400,'INVALID_INPUT');
 await rejected(owner,room,scene=>{scene.objects=[{id:'malformed-wall',type:'wall',x:0,z:0,width:'3'}];},400,'INVALID_INPUT');
 const imported=await owner.call('/api/rooms','POST',{worldId:world.id,name:'Bad imported ground',scene:{...freshScene(),terrain:terrain([0,10,'stone',true])}});assert.equal(imported.status,400);assert.equal(imported.data.code,'TERRAIN_BLOCKS_ARRIVAL');
});

test('terrain HTTP: complete 4096-cell terrain survives save/reload within shared scene budgets',async t=>{
 const {owner,room}=await setup(t),cells=Array.from({length:4096},(_,i)=>[i%64-32,Math.floor(i/64)-32,'grass',false]);
 const saved=await save(owner,room,scene=>{scene.bounds={width:100,depth:100};scene.terrain=terrain(...cells);});assert.equal(saved.status,200,describe(saved));
 const reloaded=await current(owner,room);assert.equal(reloaded.scene.terrain.cells.length,4096);assert.deepEqual(reloaded.scene.terrain.cells,cells);
 await rejected(owner,room,scene=>{scene.terrain.cells.push([32,0,'stone',false]);},400,'INVALID_TERRAIN');
});

test('terrain HTTP: ordinary guests and forged permission fields cannot write terrain',async t=>{
 const {owner,alice,room}=await setup(t);await joinRoom(alice,room);
 await rejected(alice,room,scene=>{scene.terrain=terrain([3,0,'soil',false]);},403,'ROOM_FORBIDDEN');
 await rejected(owner,room,scene=>{scene.terrain=terrain([3,0,'soil',false]);},400,'IMMUTABLE_FIELD',{canEditScene:true});
 assert.equal((await owner.call(`/api/rooms/${room.id}/members/${alice.user.id}`,'PUT',{role:'editor'})).status,200);
 assert.equal((await save(alice,room,scene=>{scene.terrain=terrain([3,0,'soil',false]);})).status,200);
});

test('terrain HTTP: scoped personal owner can edit ordinary walls but cannot forge terrain changes',async t=>{
 const area={id:'desk',name:'Desk',x:-6,z:0,width:8,depth:8,action:'welcome',personalArea:{mode:'dynamic',allowedTags:[]}};
 const {owner,alice,room}=await setup(t,[area]);assert.equal((await alice.call('/api/account','POST',{username:'terrain_'+randomUUID().replaceAll('-','').slice(0,16),password:'local terrain test password'})).status,201);
 let latest=await joinRoom(alice,room);await alice.call('/api/presence','POST',{roomId:room.id,x:-6,z:0});const claim=await alice.call(`/api/rooms/${room.id}/personal-areas/desk/claim`,'POST',{revision:latest.personalAreas[0].revision,clientOperationId:randomUUID()});assert.equal(claim.status,200,describe(claim));
 latest=await current(alice,room);assert.equal(latest.capabilities.canBuild,true);assert.equal(latest.capabilities.canEditScene,false);
 await rejected(alice,room,scene=>{scene.terrain=terrain([-8,0,'wood',false]);},403,'PERSONAL_AREA_ONLY');
 const wall=await save(alice,room,scene=>{scene.objects.push({id:'my-wall',type:'wall',x:-8,z:0,width:1,depth:.3,rotation:0});});assert.equal(wall.status,200,describe(wall));
 assert.equal((await current(owner,room)).scene.objects[0].id,'my-wall');
});

test('terrain HTTP: new blockers protect current human occupants; repaint and erase do not create stale collision',async t=>{
 const {owner,alice,room}=await setup(t);await joinRoom(alice,room);await alice.call('/api/presence','POST',{roomId:room.id,x:6.5,z:.5});
 await rejected(owner,room,scene=>{scene.terrain=terrain([6,0,'water',true]);},409,'TERRAIN_BLOCKS_PLAYER');
 assert.equal((await save(owner,room,scene=>{scene.terrain=terrain([6,0,'water',false]);})).status,200);
 await rejected(owner,room,scene=>{scene.terrain=terrain([6,0,'water',true]);},409,'TERRAIN_BLOCKS_PLAYER');
 await alice.call('/api/presence','POST',{roomId:room.id,x:8,z:0});assert.equal((await save(owner,room,scene=>{scene.terrain=terrain([6,0,'stone',true]);})).status,200);
 await alice.call('/api/presence','POST',{roomId:room.id,x:6.5,z:.5});assert.equal((await save(owner,room,scene=>{scene.terrain=terrain([6,0,'wood',true]);})).status,200);
 assert.equal((await save(owner,room,scene=>{scene.terrain=terrain();})).status,200);
});

test('terrain HTTP: expired, departed and newly unauthorized presence cannot veto a safe edit',async t=>{
 const {owner,alice,world,room,advance}=await setup(t);await joinRoom(alice,room);await alice.call('/api/presence','POST',{roomId:room.id,x:6.5,z:.5});advance(60001);
 assert.equal((await save(owner,room,scene=>{scene.terrain=terrain([6,0,'water',true]);})).status,200);
 await save(owner,room,scene=>{scene.terrain=terrain();});await alice.call('/api/presence','POST',{roomId:room.id,x:6.5,z:.5});await alice.call(`/api/rooms/${room.id}/leave`,'POST',{});
 assert.equal((await save(owner,room,scene=>{scene.terrain=terrain([6,0,'water',true]);})).status,200);
 await save(owner,room,scene=>{scene.terrain=terrain();});await joinRoom(alice,room);await alice.call('/api/presence','POST',{roomId:room.id,x:6.5,z:.5});assert.equal((await owner.call(`/api/worlds/${world.id}`,'PATCH',{public:false})).status,200);
 assert.equal((await save(owner,room,scene=>{scene.terrain=terrain([6,0,'water',true]);})).status,200);
});

test('terrain HTTP: active residents are protected and new resident spawns use terrain collision',async t=>{
 const {owner,room}=await setup(t),path=`/api/rooms/${room.id}/bots`;
 const made=await owner.call(path,'POST',{clientOperationId:randomUUID(),config:{name:'Ground resident',spawn:{x:6.5,z:.5},radius:0}});assert.equal(made.status,201,describe(made));
 const before=(await owner.call(`/api/rooms/${room.id}`)).data.bots;assert.equal(before.length,1);
 await rejected(owner,room,scene=>{scene.terrain=terrain([6,0,'stone',true]);},409,'TERRAIN_BLOCKS_RESIDENT');
 const after=(await owner.call(`/api/rooms/${room.id}`)).data.bots;assert.deepEqual(after.map(({x,z})=>({x,z})),before.map(({x,z})=>({x,z})));
 assert.equal((await save(owner,room,scene=>{scene.terrain=terrain([-6,0,'water',true]);})).status,200);
 const blocked=await owner.call(path,'POST',{clientOperationId:randomUUID(),config:{name:'Blocked resident',spawn:{x:-5.5,z:.5}}});assert.equal(blocked.status,400);assert.equal(blocked.data.code,'BOT_SPAWN_BLOCKED');
});

test('terrain HTTP: final terrain cell cannot close a previously open arrival route',async t=>{
 const {owner,room}=await setup(t),cells=[];
 for(let z=-2;z<=2;z++)for(const x of [-2,2])cells.push([x,z,'water',true]);
 for(const x of [-1,0,1])cells.push([x,-2,'water',true]);for(const x of [-1,1])cells.push([x,2,'water',true]);
 const opened=await save(owner,room,scene=>{scene.spawn={x:.5,z:.5};scene.terrain=terrain(...cells);});assert.equal(opened.status,200,describe(opened));
 await rejected(owner,room,scene=>{scene.terrain.cells.push([0,2,'water',true]);},400,'TERRAIN_BLOCKS_ROUTE');
});

test('terrain HTTP: ordinary wall tool geometry protects arrival, humans, residents and unchanged legacy walls',async t=>{
 const {owner,alice,room}=await setup(t);await joinRoom(alice,room);await alice.call('/api/presence','POST',{roomId:room.id,x:6.5,z:.5});
 const wall={id:'wall-draw',type:'wall',x:6.5,z:.5,width:2,depth:.3,rotation:0};
 await rejected(owner,room,scene=>{scene.objects.push(wall);},409,'WALL_BLOCKS_PLAYER');
 await rejected(owner,room,scene=>{scene.objects.push({...wall,x:0,z:10});},400,'WALL_BLOCKS_ARRIVAL');
 await rejected(owner,room,scene=>{scene.objects.push({...wall,x:15.5});},400,'WALL_OUTSIDE_ROOM');
 await alice.call('/api/presence','POST',{roomId:room.id,x:8,z:0});assert.equal((await save(owner,room,scene=>{scene.objects.push(wall);})).status,200);
 await alice.call('/api/presence','POST',{roomId:room.id,x:6.5,z:.5});assert.equal((await save(owner,room,scene=>{scene.objects[0].name='Unchanged wall geometry';})).status,200);
 await rejected(owner,room,scene=>{scene.objects[0].width=3;},409,'WALL_BLOCKS_PLAYER');
 const made=await owner.call(`/api/rooms/${room.id}/bots`,'POST',{clientOperationId:randomUUID(),config:{name:'Wall resident',spawn:{x:-6,z:0},radius:0}});assert.equal(made.status,201,describe(made));
 await rejected(owner,room,scene=>{scene.objects.push({...wall,id:'resident-wall',x:-6,z:0});},409,'WALL_BLOCKS_RESIDENT');
});

test('terrain HTTP: final ordinary wall cannot close the arrival route',async t=>{
 const {owner,room}=await setup(t);const wall=(id,x,z,width,depth)=>({id,type:'wall',x,z,width,depth,rotation:0});
 const opened=await save(owner,room,scene=>{scene.spawn={x:0,z:0};scene.objects=[wall('left',-2,0,.3,4.3),wall('right',2,0,.3,4.3),wall('north',0,-2,4.3,.3),wall('southleft',-1.5,2,1,.3),wall('southright',1.5,2,1,.3)];});assert.equal(opened.status,200,describe(opened));
 await rejected(owner,room,scene=>{scene.objects.push(wall('lastwall',0,2,2,.3));},400,'WALL_BLOCKS_ROUTE');
});

test('terrain HTTP: role revoked during a streamed scene body is rechecked before commit',{timeout:15000},async t=>{
 const {app,port,owner,alice,room}=await setup(t);assert.equal((await owner.call(`/api/rooms/${room.id}/members/${alice.user.id}`,'PUT',{role:'editor'})).status,200);const latest=await joinRoom(alice,room),scene={...latest.scene,terrain:terrain([6,0,'soil',false])};
 let admitted;const admission=new Promise(resolve=>{admitted=resolve;}),authorize=app.store.authorize.bind(app.store);app.store.authorize=(...args)=>{const value=authorize(...args);if(args[1]===alice.user.id)admitted();return value;};t.after(()=>{app.store.authorize=authorize;});
 const encoded=JSON.stringify({revision:latest.revision,scene}),split=Math.floor(encoded.length/2);let request;
 const result=new Promise((resolve,reject)=>{request=http.request({host:'127.0.0.1',port,path:`/api/rooms/${room.id}/scene`,method:'PUT',headers:{Cookie:alice.cookie,'Content-Type':'application/json','Transfer-Encoding':'chunked'}},response=>{let raw='';response.on('data',chunk=>{raw+=chunk;});response.on('end',()=>resolve({status:response.statusCode,data:JSON.parse(raw)}));});request.on('error',reject);request.write(encoded.slice(0,split));});t.after(()=>request.destroy());
 await Promise.race([admission,result.then(response=>assert.fail(`Ended before admission: ${describe(response)}`))]);assert.equal((await owner.call(`/api/rooms/${room.id}/members/${alice.user.id}`,'PUT',{role:'member'})).status,200);request.end(encoded.slice(split));const response=await result;assert.equal(response.status,403,describe(response));
 const after=await current(owner,room);assert.equal(after.revision,latest.revision);assert.deepEqual(after.scene,latest.scene);
});
