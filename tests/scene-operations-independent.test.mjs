import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds} from '../src/worlds.js';
import {makePng} from '../fixtures/png-fixtures.mjs';

// Independent HTTP consumers: no operation-service or client-model imports.
// Fixtures, accounts, assets, databases, and sockets are disposable and local.
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
const sha=value=>createHash('sha256').update(canonical(value)).digest('hex');
const context=scene=>sha(Object.fromEntries(Object.entries(scene).filter(([key])=>!['objects','terrain'].includes(key))));
const chair=(id,x=6,z=0,extra={})=>({id,type:'chair',name:id,x,z,rotation:0,...extra});
const scene=(objects=[],areas=[])=>({version:1,theme:'garden',bounds:{width:32,depth:26},spawn:{x:0,z:10},objects,areas});
const area=(id='desk-a',x=-6)=>({id,name:id,x,z:0,width:8,depth:8,action:'welcome',personalArea:{mode:'dynamic',allowedTags:[]}});
const path=room=>`/api/rooms/${room.id}/scene/operations`;
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.data;};
const objectOp=(before,after)=>({kind:'object',id:(before??after).id,before:before?sha(before):null,after});
const terrainOp=(before,after)=>({kind:'terrain',x:(before??after)[0],z:(before??after)[1],before,after});
const clone=structuredClone;

async function start(database=':memory:',separateProcess=false){
  let app,child,port;
  if(separateProcess){
    const script=`import {createGameServer} from './server/app.mjs'; import {seedWorlds} from './src/worlds.js'; const app=createGameServer({database:process.argv[1],seeds:seedWorlds}); const {port}=await app.listen(0); process.send({port}); process.on('message',async()=>{await app.close();process.exit(0)});`;
    child=spawn(process.execPath,['--input-type=module','-e',script,database],{cwd:new URL('..',import.meta.url),stdio:['ignore','ignore','pipe','ipc']});
    let stderr='';child.stderr.on('data',part=>stderr+=part);
    port=await new Promise((resolve,reject)=>{child.once('message',m=>resolve(m.port));child.once('error',reject);child.once('exit',code=>reject(new Error(`Local test process exited ${code}: ${stderr}`)));});
  }else{app=createGameServer({database,seeds:seedWorlds});({port}=await app.listen(0));}
  const base=`http://127.0.0.1:${port}`;
  const client=(cookie='')=>({cookie,async call(route,method='GET',body){
    const response=await fetch(base+route,{method,headers:{Cookie:this.cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
    if(response.headers.get('set-cookie'))this.cookie=response.headers.get('set-cookie').split(';')[0];
    const raw=await response.text();return{status:response.status,data:raw?JSON.parse(raw):undefined};
  }});
  async function account(name,registered=false){const c=client();c.user=ok(await c.call('/api/session','POST',{name}),201).user;if(registered)ok(await c.call('/api/account','POST',{username:'u_'+randomUUID().replaceAll('-','').slice(0,20),password:'synthetic local fixture password'}),201);return c;}
  let closed=false;async function close(){if(closed)return;closed=true;if(child){const exited=once(child,'exit');child.send('stop');await exited;}else await app.close();}
  return{app,child,port,base,client,account,close};
}
async function enter(c,room){const result=ok(await c.call(`/api/rooms/${room.id}/join`,'POST',{}));assert.ok(result.arrival?.admissionId,JSON.stringify(result));c.admission=Object.fromEntries(['admissionId','admissionEpoch','admissionRevision'].map(key=>[key,result.arrival[key]]));return result.room;}
async function latest(c,room){return ok(await c.call(`/api/rooms/${room.id}`)).room;}
async function setup(t,{initial=scene(),personal=false,separateProcess=false,database=':memory:',privateWorld=false}={}){
  const f=await start(database,separateProcess);t.after(f.close);
  const owner=await f.account('Owner',personal),editor=await f.account('Editor',personal),reader=await f.account('Reader',personal);
  const world=ok(await owner.call('/api/worlds','POST',{name:'Independent scene fixtures',public:!privateWorld}),201).world;
  const room=ok(await owner.call('/api/rooms','POST',{worldId:world.id,name:'Operation fixtures',scene:initial,public:!privateWorld}),201).room;
  if(privateWorld)ok(await owner.call(`/api/worlds/${world.id}/members/${editor.user.id}`,'PUT',{role:'member'}));
  ok(await owner.call(`/api/rooms/${room.id}/members/${editor.user.id}`,'PUT',{role:personal?'member':'editor'}));
  await enter(owner,room);await enter(editor,room);if(!privateWorld)await enter(reader,room);
  return{...f,owner,editor,reader,world,room};
}
function batch(c,room,operations,extra={}){return{version:1,operationId:randomUUID(),baseRevision:room.revision,contextHash:context(room.scene),operations,admission:clone(c.admission),...extra};}
async function post(c,room,payload){return c.call(path(room),'POST',payload);}
async function legacy(c,room,mutate){const before=await latest(c,room),next=clone(before.scene);mutate(next);return c.call(`/api/rooms/${room.id}/scene`,'PUT',{revision:before.revision,scene:next,personalAreaRevisions:Object.fromEntries(before.personalAreas.map(a=>[a.areaId,a.revision]))});}
async function replay(c,room,after=0){return c.call(path(room)+`?after=${after}`);}
function conflict(r){assert.equal(r.status,409,JSON.stringify(r));assert.equal(r.data.code,'SCENE_OPERATION_CONFLICT');assert.ok(r.data.room&&Array.isArray(r.data.conflicts)&&r.data.conflicts.length);return r.data;}
async function samePersisted(c,room,before){const after=await latest(c,room);assert.equal(after.revision,before.revision);assert.deepEqual(after.scene,before.scene);return after;}

for(const pair of ['object-object','terrain-terrain','object-terrain'])for(const reverse of [false,true])test(`independent HTTP disjoint ${pair} same base survives ${reverse?'reverse':'forward'} order`,async t=>{
  const{owner,editor,room}=await setup(t);const initial=await latest(owner,room);
  const choices={object:()=>objectOp(null,chair('first',-6)),terrain:()=>terrainOp(null,[-6,-6,'stone',false])};
  const [left,right]=pair.split('-');const a=batch(owner,initial,[choices[left]()]);
  const b=batch(editor,initial,[right==='object'?objectOp(null,chair('second',6)):terrainOp(null,[6,6,'wood',false])]);
  for(const[c,payload]of reverse?[[editor,b],[owner,a]]:[[owner,a],[editor,b]]){const result=ok(await post(c,room,payload));assert.equal(result.duplicate,false);assert.equal(result.receipt.actorId,c.user.id);assert.equal(result.receipt.roomId,room.id);assert.equal(result.receipt.operationId,payload.operationId);}
  const current=await latest(owner,room);assert.equal(current.revision,2);assert.equal(current.scene.objects.length+(current.scene.terrain?.cells.length??0),2);
  const journal=ok(await replay(editor,room));assert.equal(journal.mode,'replay');assert.deepEqual(journal.snapshots.map(s=>s.revision),[1,2]);assert.deepEqual(journal.snapshots.at(-1).scene,current.scene);
});

for(const scenario of ['same-object','delete-update','duplicate-add','same-cell'])test(`independent HTTP ${scenario} conflict rejects entire mixed batch`,async t=>{
  const old=chair('shared',-6),initial=scenario==='duplicate-add'?scene():scene([old]);if(scenario==='same-cell')initial.terrain={version:1,cells:[[-6,-6,'grass',false]]};
  const{owner,editor,room}=await setup(t,{initial});const before=await latest(owner,room);
  const first=scenario==='same-cell'?terrainOp(initial.terrain.cells[0],[-6,-6,'stone',false]):objectOp(scenario==='duplicate-add'?null:old,scenario==='delete-update'?null:{...old,name:'Owner value'});
  const second=scenario==='same-cell'?terrainOp(initial.terrain.cells[0],[-6,-6,'wood',false]):objectOp(scenario==='duplicate-add'?null:old,{...old,name:'Editor value'});
  ok(await post(owner,room,batch(owner,before,[first])));const saved=await latest(owner,room);
  const r=conflict(await post(editor,room,batch(editor,before,[objectOp(null,chair('must-rollback',6)),second])));assert.equal(r.room.revision,saved.revision);await samePersisted(owner,room,saved);
});

test('independent canonical object hashing ignores key insertion order and preserves action-array ordering',async t=>{
  const old=chair('ordered',-6,0,{actions:[{id:'a',type:'message',message:'A'},{id:'b',type:'message',message:'B'}]});const{owner,room}=await setup(t,{initial:scene([old])});
  let current=await latest(owner,room);const reordered=Object.fromEntries(Object.entries(old).reverse());
  ok(await post(owner,room,batch(owner,current,[objectOp(reordered,{...old,name:'Canonical'})])));
  current=await latest(owner,room);const wrong=clone(current.scene.objects[0]);wrong.actions.reverse();conflict(await post(owner,room,batch(owner,current,[objectOp(wrong,{...wrong,name:'Wrong order'})])));await samePersisted(owner,room,current);
});

test('independent combined geometry rejects collision atomically while a rename preserves grandfathered overlap',async t=>{
  const old=chair('old',-6),overlap=chair('overlap',-6);const{owner,editor,room}=await setup(t,{initial:scene([old,overlap])});let current=await latest(owner,room);
  ok(await post(owner,room,batch(owner,current,[objectOp(old,{...old,name:'Legacy overlap renamed'})])));
  current=await latest(owner,room);const first=batch(owner,current,[objectOp(null,chair('peer',6))]),second=batch(editor,current,[objectOp(null,chair('rollback-safe',0,0)),objectOp(null,chair('collides',6))]);
  ok(await post(owner,room,first));const saved=await latest(owner,room);const rejected=await post(editor,room,second);assert.ok([400,409].includes(rejected.status),JSON.stringify(rejected));await samePersisted(owner,room,saved);
});

for(const order of ['legacy-first','operations-first'])test(`independent legacy scene CAS interoperates ${order}`,async t=>{
  const{owner,editor,room}=await setup(t);const initial=await latest(owner,room),oldScene=clone(initial.scene);oldScene.objects.push(chair('legacy',-6));const operation=batch(editor,initial,[objectOp(null,chair('operation',6))]);
  if(order==='legacy-first'){ok(await owner.call(`/api/rooms/${room.id}/scene`,'PUT',{revision:initial.revision,scene:oldScene}));ok(await post(editor,room,operation));assert.equal((await latest(owner,room)).scene.objects.length,2);}
  else{ok(await post(editor,room,operation));assert.equal((await owner.call(`/api/rooms/${room.id}/scene`,'PUT',{revision:initial.revision,scene:oldScene})).status,409);assert.deepEqual((await latest(owner,room)).scene.objects.map(o=>o.id),['operation']);}
});

test('independent context change fences stale operations and an exact ABA value is deliberately admissible',async t=>{
  const old=chair('aba',-6);const{owner,editor,room}=await setup(t,{initial:scene([old])});const initial=await latest(owner,room),stale=batch(editor,initial,[objectOp(old,{...old,name:'Eventually applied'})]);
  ok(await legacy(owner,room,s=>s.objects[0].name='Intermediate'));ok(await legacy(owner,room,s=>s.objects[0]=clone(old)));ok(await post(editor,room,stale));
  const beforeMetadata=await latest(editor,room),fenced=batch(editor,beforeMetadata,[objectOp(null,chair('context-reject',6))]);ok(await legacy(owner,room,s=>s.theme='assembly'));
  const latestRoom=await latest(owner,room);conflict(await post(editor,room,fenced));await samePersisted(owner,room,latestRoom);
});

test('independent duplicate concurrent commit, lost response, later peer commit, and semantic retry have one effect',async t=>{
  const{port,owner,editor,room}=await setup(t);const initial=await latest(owner,room),payload=batch(owner,initial,[objectOp(null,chair('once',-6))]);
  const responses=await Promise.all([post(owner,room,payload),post(owner,room,payload)]);responses.forEach(r=>ok(r));assert.deepEqual(responses.map(r=>r.data.duplicate).sort(),[false,true]);assert.deepEqual(responses[0].data.receipt,responses[1].data.receipt);
  const lost=batch(editor,await latest(editor,room),[objectOp(null,chair('lost-response',6))]);
  // Drop the socket as soon as response headers arrive. No response body or
  // receipt reaches this independent client, which must retry the same ID.
  await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:path(room),method:'POST',headers:{Cookie:editor.cookie,'Content-Type':'application/json'}},response=>{response.destroy();resolve();});req.on('error',reject);req.end(JSON.stringify(lost));});
  ok(await post(owner,room,batch(owner,await latest(owner,room),[terrainOp(null,[6,6,'stone',false])])));
  const before=await latest(owner,room);await enter(editor,room);const retry=clone(lost);retry.admission=clone(editor.admission);retry.operations=retry.operations.map(op=>Object.fromEntries(Object.entries(op).reverse()));
  const repeated=ok(await post(editor,room,retry));assert.equal(repeated.duplicate,true);assert.equal(repeated.receipt.appliedRevision,2);assert.equal(repeated.room.revision,3);await samePersisted(owner,room,before);
  const changed=clone(retry);changed.operations[0].after.name='Changed payload';assert.equal((await post(editor,room,changed)).status,409);await samePersisted(owner,room,before);
});

test('independent real Node process restart keeps receipts and journal and accepts refreshed admission only',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'scene-independent-'));t.after(()=>rm(dir,{recursive:true,force:true}));const database=join(dir,'world.sqlite');
  const f=await setup(t,{database,separateProcess:true});const initial=await latest(f.owner,f.room),payload=batch(f.owner,initial,[objectOp(null,chair('durable',-6))]);const first=ok(await post(f.owner,f.room,payload));const cookie=f.owner.cookie,pid=f.child.pid;await f.close();
  const restarted=await start(database,true);t.after(restarted.close);assert.notEqual(restarted.child.pid,pid);const recovered=restarted.client(cookie);recovered.user=f.owner.user;
  assert.ok([401,403,409].includes((await post(recovered,f.room,payload)).status));await enter(recovered,f.room);const retry=ok(await post(recovered,f.room,{...payload,admission:recovered.admission}));assert.equal(retry.duplicate,true);assert.deepEqual(retry.receipt,first.receipt);assert.equal(retry.room.revision,1);const journal=ok(await replay(recovered,f.room));assert.equal(journal.cursor,1);assert.deepEqual(journal.snapshots.map(s=>s.revision),[1]);
});

test('independent actor and room receipt boundaries deny replay or cached success without current authority',async t=>{
  const{owner,editor,reader,world,room}=await setup(t,{privateWorld:true});const initial=await latest(owner,room),payload=batch(owner,initial,[objectOp(null,chair('private-once',-6))]);ok(await post(owner,room,payload));
  for(const route of [path(room),path(room)+'?after=0']){const denied=await reader.call(route,route.includes('?')?'GET':'POST',route.includes('?')?undefined:payload);assert.ok([401,403,404,409].includes(denied.status));assert.equal(denied.data.room,undefined);assert.equal(denied.data.receipt,undefined);assert.equal(denied.data.snapshots,undefined);}
  const actorCopy={...payload,admission:editor.admission};const collision=await post(editor,room,actorCopy);assert.equal(collision.status,409);assert.equal(collision.data.receipt,undefined);
  const other=ok(await owner.call('/api/rooms','POST',{worldId:world.id,name:'Other private room',scene:scene(),public:false}),201).room;await enter(owner,other);const copied={...payload,admission:owner.admission};const otherResult=await post(owner,other,copied);assert.equal(otherResult.status,409);assert.equal(otherResult.data.receipt,undefined);
  await enter(owner,room);const editorPayload=batch(editor,await latest(editor,room),[objectOp(null,chair('editor-once',6))]);ok(await post(editor,room,editorPayload));ok(await owner.call(`/api/rooms/${room.id}/members/${editor.user.id}`,'DELETE'));
  ok(await owner.call(`/api/worlds/${world.id}/members/${editor.user.id}`,'DELETE'));
  const denied=await post(editor,room,editorPayload);assert.ok([401,403,404,409].includes(denied.status));assert.equal(denied.data.receipt,undefined);const readDenied=await replay(editor,room);assert.ok([401,403,404,409].includes(readDenied.status));assert.equal(readDenied.data.snapshots,undefined);
});

function partial(port,cookie,route,payload){const encoded=JSON.stringify(payload),split=Math.floor(encoded.length/2);let request;const result=new Promise((resolve,reject)=>{request=http.request({host:'127.0.0.1',port,path:route,method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','Transfer-Encoding':'chunked'}},response=>{let raw='';response.on('data',part=>raw+=part);response.on('end',()=>resolve({status:response.statusCode,data:raw?JSON.parse(raw):undefined}));});request.on('error',reject);request.write(encoded.slice(0,split));});return{result,finish:()=>request.end(encoded.slice(split)),destroy:()=>request.destroy()};}
for(const mutation of ['role-revoke','archive','logout','travel-away-back'])test(`independent streamed operation rechecks ${mutation}`,{timeout:15000},async t=>{
  const{app,port,owner,editor,room,world}=await setup(t);const initial=await latest(editor,room);let observed;const admitted=new Promise(resolve=>observed=resolve),authorize=app.store.authorize.bind(app.store);app.store.authorize=(...args)=>{const answer=authorize(...args);if(args[1]===editor.user.id)observed();return answer;};t.after(()=>app.store.authorize=authorize);
  const upload=partial(port,editor.cookie,path(room),batch(editor,initial,[objectOp(null,chair('must-never-commit',6))]));t.after(upload.destroy);await Promise.race([admitted,upload.result.then(r=>assert.fail('Ended before streamed body: '+JSON.stringify(r)))]);
  if(mutation==='role-revoke')ok(await owner.call(`/api/rooms/${room.id}/members/${editor.user.id}`,'PUT',{role:'member'}));
  if(mutation==='archive')ok(await owner.call(`/api/rooms/${room.id}`,'DELETE',{}));
  if(mutation==='logout')ok(await editor.call('/api/logout','POST',{}));
  if(mutation==='travel-away-back'){const other=ok(await owner.call('/api/rooms','POST',{worldId:world.id,name:'Travel room',scene:scene()}),201).room;await enter(editor,other);await enter(editor,room);}
  upload.finish();const denied=await upload.result;assert.ok([401,403,404,409].includes(denied.status),JSON.stringify(denied));assert.equal(app.store.roomRow(room.id).revision,initial.revision);assert.deepEqual(JSON.parse(app.store.roomRow(room.id).scene),initial.scene);
});

test('independent malformed operation targets, unsafe fields, duplicate targets, and oversized bodies leave no writes',async t=>{
  const{owner,room}=await setup(t);const initial=await latest(owner,room),op=objectOp(null,chair('valid',6));
  const invalid=[{operations:[op,op]},{operations:[{...op,after:{...op.after,id:'different'}}]},{operations:[{...op,before:'not-a-hash'}]},{operations:[{kind:'terrain',x:0,z:0,before:null,after:[1,0,'stone',false]}]},{operations:[{...op,unexpected:true}]},{actorId:'forged'},{operations:[objectOp(null,chair('unsafe',6,0,{actions:[{id:'bad',type:'link',url:'javascript:alert(1)'}]}))]}];
  for(const change of invalid){const response=await post(owner,room,batch(owner,initial,[op],change));assert.equal(response.status,400,JSON.stringify(response));await samePersisted(owner,room,initial);}
  const oversized=batch(owner,initial,[objectOp(null,chair('huge',6,0,{text:'x'.repeat(610000)}))]);assert.equal((await post(owner,room,oversized)).status,413);await samePersisted(owner,room,initial);
});

async function claim(c,room,areaId='desk-a'){
  const current=await latest(c,room),a=current.personalAreas.find(a=>a.areaId===areaId);ok(await c.call('/api/presence','POST',{roomId:room.id,x:a.x,z:a.z}));
  return ok(await c.call(`/api/rooms/${room.id}/personal-areas/${areaId}/claim`,'POST',{revision:a.revision,clientOperationId:randomUUID()}));
}
async function revoke(c,room,areaId='desk-a',objectHandling='keep'){
  const current=await latest(c,room),a=current.personalAreas.find(a=>a.areaId===areaId);
  return ok(await c.call(`/api/rooms/${room.id}/personal-areas/${areaId}/revoke`,'POST',{revision:a.revision,roomRevision:current.revision,objectHandling,clientOperationId:randomUUID()}));
}
const areaRevisions=room=>Object.fromEntries(room.personalAreas.map(a=>[a.areaId,a.revision]));

test('independent scoped operations enforce both footprints, current area revisions, terrain rights, and atomic provenance',async t=>{
  const{app,owner,editor,reader,room}=await setup(t,{personal:true,initial:scene([],[area(),area('desk-b',6)])});await claim(editor,room);await claim(reader,room,'desk-b');
  let current=await latest(editor,room);const owned=chair('owned',-6,-2);ok(await post(editor,room,batch(editor,current,[objectOp(null,owned)],{personalAreaRevisions:areaRevisions(current)})));
  const provenance=app.store.get('SELECT * FROM personal_area_objects WHERE room_id=? AND object_id=?',room.id,owned.id);assert.equal(provenance.creator_id,editor.user.id);assert.equal(provenance.area_id,'desk-a');
  ok(await legacy(owner,room,s=>s.objects.push(chair('foreign',12))));current=await latest(editor,room);
  const attacks=[
    objectOp(owned,{...owned,x:6}),
    objectOp(current.scene.objects.find(o=>o.id==='foreign'),chair('foreign',-5)),
    objectOp(null,chair('partial',-2.1)),
    objectOp(null,chair('rotated',-3,0,{type:'table',width:6,depth:1,rotation:45})),
    terrainOp(null,[-6,-6,'stone',false]),
  ];
  for(const bad of attacks){const response=await post(editor,room,batch(editor,current,[objectOp(null,chair('atomic',-8,-2)),bad],{personalAreaRevisions:areaRevisions(current)}));assert.equal(response.status,403,JSON.stringify(response));await samePersisted(owner,room,current);assert.equal(app.store.get('SELECT COUNT(*) AS n FROM personal_area_objects WHERE room_id=?',room.id).n,1);}
  const stale=await post(editor,room,batch(editor,current,[objectOp(owned,{...owned,name:'Stale grant'})],{personalAreaRevisions:{'desk-a':0}}));assert.equal(stale.status,409);await samePersisted(owner,room,current);
});

test('independent claim, operation, legacy PUT and revoke share continuous replay; retention reset keeps old receipts',async t=>{
  const{owner,editor,room}=await setup(t,{personal:true,initial:scene([],[area()])});await claim(editor,room);let current=await latest(editor,room);
  const oldReceipt=batch(editor,current,[objectOp(null,chair('claimed',-6,-2))],{personalAreaRevisions:areaRevisions(current)});const original=ok(await post(editor,room,oldReceipt));
  ok(await legacy(owner,room,s=>s.objects.push(chair('manager',6))));await revoke(owner,room,'desk-a','remove-owned');current=await latest(owner,room);
  assert.equal(current.revision,4);const continuous=ok(await replay(owner,room));assert.equal(continuous.mode,'replay');assert.deepEqual(continuous.snapshots.map(s=>s.revision),[1,2,3,4]);assert.deepEqual(continuous.snapshots.at(-1).scene,current.scene);
  // A full editor can make an old receipt visible again without restoring the
  // old claimed object or changing its original receipt's applied revision.
  ok(await owner.call(`/api/rooms/${room.id}/members/${editor.user.id}`,'PUT',{role:'editor'}));
  for(let i=0;i<66;i++)ok(await legacy(owner,room,s=>s.objects.find(o=>o.id==='manager').name='Journal '+i));
  current=await latest(owner,room);const reset=ok(await replay(owner,room,0));assert.equal(reset.mode,'snapshot');assert.equal(reset.cursor,current.revision);assert.equal(reset.snapshots.length,1);assert.equal(reset.snapshots[0].revision,current.revision);assert.deepEqual(reset.snapshots[0].scene,current.scene);
  const recent=ok(await replay(owner,room,current.revision-2));assert.equal(recent.mode,'replay');assert.deepEqual(recent.snapshots.map(s=>s.revision),[current.revision-1,current.revision]);
  const repeated=ok(await post(editor,room,oldReceipt));assert.equal(repeated.duplicate,true);assert.deepEqual(repeated.receipt,original.receipt);assert.equal(repeated.room.revision,current.revision);assert.equal(repeated.room.scene.objects.some(o=>o.id==='claimed'),false);
});

test('independent scoped streamed operation rejects a concurrent tag-policy revision without undoing ownership',{timeout:15000},async t=>{
  const{app,port,owner,editor,room}=await setup(t,{personal:true,initial:scene([],[area()])});await claim(editor,room);const current=await latest(editor,room);
  let resolve;const admitted=new Promise(done=>resolve=done),original=app.store.authorize.bind(app.store);app.store.authorize=(...args)=>{const result=original(...args);if(args[1]===editor.user.id)resolve();return result;};t.after(()=>app.store.authorize=original);
  const pending=partial(port,editor.cookie,path(room),batch(editor,current,[objectOp(null,chair('stale-policy',-6,-2))],{personalAreaRevisions:areaRevisions(current)}));t.after(pending.destroy);await Promise.race([admitted,pending.result.then(r=>assert.fail(JSON.stringify(r)))]);
  ok(await legacy(owner,room,s=>s.areas[0].personalArea.allowedTags=['new-tag']));const changed=await latest(owner,room);assert.equal(changed.personalAreas[0].ownerId,editor.user.id);pending.finish();assert.equal((await pending.result).status,409);await samePersisted(owner,room,changed);
});

test('independent provenance failure rolls back scene, receipt and replay so the same request can succeed once',async t=>{
  const{app,owner,editor,room}=await setup(t,{personal:true,initial:scene([],[area()])});await claim(editor,room);const initial=await latest(editor,room),payload=batch(editor,initial,[objectOp(null,chair('rolled-back',-6,-2))],{personalAreaRevisions:areaRevisions(initial)}),beforeReplay=ok(await replay(owner,room));
  const record=app.store.recordPersonalObjects.bind(app.store);let called=false;app.store.recordPersonalObjects=(...args)=>{record(...args);called=true;throw new Error('Independent injected failure after provenance write');};
  const response=await post(editor,room,payload);app.store.recordPersonalObjects=record;assert.equal(response.status,500);assert.equal(called,true);await samePersisted(owner,room,initial);assert.equal(app.store.get('SELECT COUNT(*) AS n FROM personal_area_objects WHERE room_id=?',room.id).n,0);assert.deepEqual(ok(await replay(owner,room)),beforeReplay);
  const recovered=ok(await post(editor,room,payload));assert.equal(recovered.duplicate,false);assert.equal(recovered.receipt.appliedRevision,initial.revision+1);assert.equal(app.store.get('SELECT COUNT(*) AS n FROM personal_area_objects WHERE room_id=?',room.id).n,1);
});

test('independent archived image pins survive edits, reject cloning, and replay contains no historical metadata projections',async t=>{
  const{owner,editor,reader,room,world}=await setup(t);const entry=ok(await owner.call(`/api/rooms/${room.id}/assets`,'POST',{operationId:randomUUID(),draft:{name:'Secret asset metadata',tags:['sensitive-old-tag']},mediaType:'image/png',pngBase64:makePng().toString('base64')}),201);
  const image={id:'pinned',type:'image',name:'Instance',assetRef:{assetId:entry.definition.assetId,versionId:entry.version.versionId},x:6,z:0,rotation:0};
  let current=await latest(owner,room);ok(await post(owner,room,batch(owner,current,[objectOp(null,image)])));
  const asset=`/api/rooms/${room.id}/assets/${entry.definition.assetId}`;ok(await owner.call(asset,'PATCH',{expectedRevision:entry.revision,status:'archived'}));
  current=await latest(editor,room);const moved={...image,x:5,name:'Retained pinned instance'};ok(await post(editor,room,batch(editor,current,[objectOp(image,moved)])));
  current=await latest(editor,room);const cloneResponse=await post(editor,room,batch(editor,current,[objectOp(null,{...moved,id:'clone',x:-6})]));assert.equal(cloneResponse.status,409);await samePersisted(owner,room,current);
  ok(await post(editor,room,batch(editor,current,[objectOp(moved,null)])));const journal=ok(await replay(reader,room));assert.equal(journal.room.imageDefinitions?.[`${entry.definition.assetId}:${entry.version.versionId}`],undefined);
  for(const snapshot of journal.snapshots){assert.deepEqual(Object.keys(snapshot).sort(),['revision','scene']);assert.equal(Object.hasOwn(snapshot.scene,'imageDefinitions'),false);assert.equal(JSON.stringify(snapshot).includes('Secret asset metadata'),false);assert.equal(JSON.stringify(snapshot).includes('sensitive-old-tag'),false);}
  assert.equal((await reader.call(asset+`/versions/${entry.version.versionId}/image`)).status,404);
  current=await latest(editor,room);assert.equal((await post(editor,room,batch(editor,current,[objectOp(null,moved)]))).status,409);
  const other=ok(await owner.call('/api/rooms','POST',{worldId:world.id,name:'Cross-room assets',scene:scene()}),201).room;await enter(owner,other);const cross=await post(owner,other,batch(owner,other,[objectOp(null,image)]));assert.ok([400,404,409].includes(cross.status),JSON.stringify(cross));assert.equal((await latest(owner,other)).scene.objects.length,0);
});

async function acceptBuild(c,room){const available=ok(await c.call('/api/quests')).available,quest=available.find(q=>q.kind==='build');assert.ok(quest);ok(await c.call('/api/quests/accept','POST',{roomId:room.id,definitionId:quest.id,version:quest.version}),201);}
function durableEffects(store,room){return Object.fromEntries(['scene_operation_receipts','scene_operation_journal','personal_area_objects','quest_observations','quest_attempts','quest_grants','quest_applications'].map(table=>[table,store.all(`SELECT * FROM ${table} ORDER BY rowid`)]));}
for(const table of ['scene_operation_receipts','scene_operation_journal'])test(`independent SQLite ${table} abort rolls back every durable effect`,async t=>{
  const{app,owner,room}=await setup(t);await acceptBuild(owner,room);const initial=await latest(owner,room),effects=durableEffects(app.store,room),payload=batch(owner,initial,[objectOp(null,chair('failure',6))]);
  app.store.db.exec(`CREATE TEMP TRIGGER independent_abort BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'Independent injected transaction failure'); END`);
  const rejected=await post(owner,room,payload);app.store.db.exec('DROP TRIGGER independent_abort');assert.equal(rejected.status,500);await samePersisted(owner,room,initial);assert.deepEqual(durableEffects(app.store,room),effects);
  const successful=ok(await post(owner,room,payload));assert.equal(successful.duplicate,false);assert.equal(successful.room.revision,initial.revision+1);assert.equal(ok(await owner.call('/api/quests')).stampCount,1);
});

async function stream(base,c){
  const abort=new AbortController(),response=await fetch(base+'/api/events',{headers:{Cookie:c.cookie},signal:abort.signal}),events=[];assert.equal(response.status,200);let raw='',waiters=[];
  const reading=(async()=>{try{for await(const chunk of response.body){raw+=new TextDecoder().decode(chunk);let index;while((index=raw.indexOf('\n\n'))>=0){const part=raw.slice(0,index);raw=raw.slice(index+2);const event=part.match(/^event: (.+)$/m)?.[1],data=part.match(/^data: (.+)$/m)?.[1];if(event&&data){const value={event,data:JSON.parse(data)};events.push(value);for(const waiter of waiters.splice(0))waiter();}}}}catch(error){if(!abort.signal.aborted)throw error;}})();
  return{events,async wait(predicate){for(;;){const found=events.find(predicate);if(found)return found;await new Promise(resolve=>waiters.push(resolve));}},async close(){abort.abort();await reading;}};
}
test('independent duplicate commits emit one scene event and one build quest grant',{timeout:15000},async t=>{
  const{app,base,owner,editor,room}=await setup(t);await acceptBuild(owner,room);const s=await stream(base,editor);t.after(s.close);await s.wait(e=>e.event==='hello');
  const current=await latest(owner,room),payload=batch(owner,current,[objectOp(null,chair('one-broadcast',6))]);const replies=await Promise.all([post(owner,room,payload),post(owner,room,payload)]);replies.forEach(r=>ok(r));
  const firstEffects=durableEffects(app.store,room);ok(await post(owner,room,payload));assert.deepEqual(durableEffects(app.store,room),firstEffects);assert.equal(ok(await owner.call('/api/quests')).stampCount,1);
  // A later message on the same event stream is a deterministic barrier after
  // all earlier scene writes; no arbitrary sleep stands in for delivery.
  ok(await owner.call(`/api/rooms/${room.id}/messages`,'POST',{text:'Independent SSE barrier'}),201);await s.wait(e=>e.event==='message'&&JSON.stringify(e.data).includes('Independent SSE barrier'));
  const scenes=s.events.filter(e=>e.event==='scene');assert.equal(scenes.length,1);assert.equal(scenes[0].data.cursor,1);assert.equal(scenes[0].data.room.revision,1);assert.equal(scenes[0].data.room.role,'editor');
});

test('independent missing journal revision and future cursor explicitly reset to the latest snapshot',async t=>{
  const{app,owner,room}=await setup(t);for(let i=0;i<3;i++)ok(await legacy(owner,room,s=>s.theme='theme-'+i));const latestRoom=await latest(owner,room);app.store.run('DELETE FROM scene_operation_journal WHERE room_id=? AND revision=?',room.id,2);
  for(const after of [0,1,999]){const result=ok(await replay(owner,room,after));assert.equal(result.mode,'snapshot');assert.equal(result.after,after);assert.equal(result.cursor,3);assert.deepEqual(result.snapshots,[{revision:3,scene:latestRoom.scene}]);}
  const tail=ok(await replay(owner,room,2));assert.equal(tail.mode,'replay');assert.deepEqual(tail.snapshots,[{revision:3,scene:latestRoom.scene}]);const empty=ok(await replay(owner,room,3));assert.equal(empty.mode,'replay');assert.deepEqual(empty.snapshots,[]);
  for(const cursor of ['-1','1.5','Infinity','9007199254740992'])assert.equal((await owner.call(path(room)+'?after='+cursor)).status,400);
});

test('independent operation geometry protects current occupants and named start regions',async t=>{
  const startArea={id:'entry',name:'Named entry',x:0,z:0,width:2,depth:2,action:'welcome',start:{key:'entry',isDefault:false}};
  const{owner,editor,room}=await setup(t,{initial:scene([],[startArea])});ok(await editor.call('/api/presence','POST',{roomId:room.id,x:6.5,z:6.5}));const current=await latest(owner,room);
  for(const op of [terrainOp(null,[6,6,'water',true]),objectOp(null,chair('on-player',6.5,6.5)),objectOp(null,chair('blocks-entry',0,0,{type:'table',width:6,depth:6}))]){const rejected=await post(owner,room,batch(owner,current,[op,objectOp(null,chair('must-stay-absent',-6))]));assert.ok([400,409].includes(rejected.status),JSON.stringify(rejected));await samePersisted(owner,room,current);}
});

test('independent full-editor placement cannot hide an edge overrun with tiny dimensions or arbitrary rotation',async t=>{
  const legacyEdge=chair('legacy-edge',15.9,5);const{owner,room}=await setup(t,{initial:scene([legacyEdge])});let current=await latest(owner,room);ok(await post(owner,room,batch(owner,current,[objectOp(legacyEdge,{...legacyEdge,name:'Still editable'})])));current=await latest(owner,room);
  for(const item of [chair('tiny',15.9,0,{scale:.01,width:.01,depth:.01}),chair('rotated',14.8,0,{type:'table',width:2,depth:2,rotation:45})]){const response=await post(owner,room,batch(owner,current,[objectOp(null,item)]));assert.ok([400,409].includes(response.status),JSON.stringify(response));await samePersisted(owner,room,current);}
});

test('independent public admission cannot replay content removed while private; editor replay follows current role',async t=>{
  const{owner,editor,account,world,room}=await setup(t,{privateWorld:true});const privateItem=chair('removed-private-content',-6,0,{text:'PRIVATE_HISTORY_SENTINEL_8ac54',url:'https://example.invalid/private-history-token-8ac54'});
  let current=await latest(owner,room);ok(await post(owner,room,batch(owner,current,[objectOp(null,privateItem)])));current=await latest(owner,room);ok(await post(owner,room,batch(owner,current,[objectOp(privateItem,null)])));
  ok(await owner.call(`/api/worlds/${world.id}`,'PATCH',{public:true}));ok(await owner.call(`/api/rooms/${room.id}`,'PATCH',{public:true}));const guest=await account('Fresh public guest');await enter(guest,room);current=await latest(guest,room);assert.equal(current.revision,2);
  const safeSnapshot=async c=>{for(const after of [0,1,2,999]){const result=ok(await replay(c,room,after));assert.equal(result.mode,'snapshot');assert.equal(result.cursor,2);assert.deepEqual(result.snapshots,[{revision:2,scene:current.scene}]);const encoded=JSON.stringify(result);assert.equal(encoded.includes('PRIVATE_HISTORY_SENTINEL_8ac54'),false);assert.equal(encoded.includes('private-history-token-8ac54'),false);}};
  await safeSnapshot(guest);let history=ok(await replay(editor,room,0));assert.equal(history.mode,'replay');assert.deepEqual(history.snapshots.map(s=>s.revision),[1,2]);assert.equal(history.snapshots[0].scene.objects[0].text,privateItem.text);assert.equal(history.snapshots[0].scene.objects[0].url,privateItem.url);
  ok(await owner.call(`/api/rooms/${room.id}/members/${editor.user.id}`,'PUT',{role:'member'}));assert.equal((await latest(editor,room)).capabilities.canEditScene,false);await safeSnapshot(editor);
  ok(await owner.call(`/api/rooms/${room.id}/members/${editor.user.id}`,'PUT',{role:'editor'}));history=ok(await replay(editor,room,0));assert.equal(history.mode,'replay');assert.equal(history.snapshots[0].scene.objects[0].text,privateItem.text);
});

test('independent personal-area owner receives only the current scene snapshot',async t=>{
  const{owner,editor,room}=await setup(t,{personal:true,initial:scene([],[area()])});await claim(editor,room);let current=await latest(editor,room);const item=chair('prior-scoped-item',-6,-2,{text:'Old scoped text'});ok(await post(editor,room,batch(editor,current,[objectOp(null,item)],{personalAreaRevisions:areaRevisions(current)})));current=await latest(editor,room);ok(await post(editor,room,batch(editor,current,[objectOp(item,null)],{personalAreaRevisions:areaRevisions(current)})));current=await latest(editor,room);
  assert.equal(current.capabilities.canBuild,true);assert.equal(current.capabilities.canEditScene,false);const limited=ok(await replay(editor,room,0));assert.equal(limited.mode,'snapshot');assert.deepEqual(limited.snapshots,[{revision:current.revision,scene:current.scene}]);assert.equal(JSON.stringify(limited).includes('Old scoped text'),false);const full=ok(await replay(owner,room,0));assert.equal(full.mode,'replay');assert.equal(full.snapshots.some(s=>s.scene.objects.some(o=>o.text==='Old scoped text')),true);
});

test('independent replay byte budget counts Unicode UTF-8 bytes and resets only an oversized range',async t=>{
  const{owner,room}=await setup(t);const padding=Array.from({length:20},()=> '🪐'.repeat(4500));for(let i=0;i<3;i++)ok(await legacy(owner,room,s=>{s.padding=padding;s.theme='byte-budget-'+i;}));
  const current=await latest(owner,room),bytes=Buffer.byteLength(JSON.stringify(current.scene));assert.ok(bytes*2<1024*1024);assert.ok(bytes*3>1024*1024);assert.ok(JSON.stringify(current.scene).length*3<1024*1024,'Fixture distinguishes UTF-8 byte accounting from JS code units');
  const over=ok(await replay(owner,room,0));assert.equal(over.mode,'snapshot');assert.deepEqual(over.snapshots,[{revision:3,scene:current.scene}]);const under=ok(await replay(owner,room,1));assert.equal(under.mode,'replay');assert.deepEqual(under.snapshots.map(s=>s.revision),[2,3]);assert.deepEqual(under.snapshots.at(-1).scene,current.scene);
});
