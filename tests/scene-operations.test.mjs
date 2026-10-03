import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalStringify,sceneOperationContext,hashSceneObject,hashSceneContext,sceneOperationRequestIdentity,validateSceneOperationBatch,applySceneOperations} from '../src/scene-operations.js';
import {Store} from '../server/store.mjs';
import {replaySceneOperations} from '../server/scene-operation-store.mjs';
const scene=()=>({version:1,bounds:{width:40,depth:30},spawn:{x:0,z:0},objects:[{id:'a',type:'chair',x:3,z:3},{id:'b',type:'chair',x:6,z:3}],areas:[]});
const batch=()=>({version:1,operationId:'op',baseRevision:0,contextHash:'a'.repeat(64),operations:[{kind:'object',id:'new',before:null,after:{id:'new',type:'chair',x:8,z:8}}],admission:{admissionId:'arrival',admissionEpoch:'epoch',admissionRevision:1}});

test('canonical object hashes ignore record-key order and preserve ordered actions and unknown metadata',async()=>{
 const a={id:'a',actions:[{id:'one',text:'α'},{id:'two',text:'x'}],custom:{z:2,a:1}},b={custom:{a:1,z:2},actions:[{text:'α',id:'one'},{text:'x',id:'two'}],id:'a'};
 assert.equal(await hashSceneObject(a),await hashSceneObject(b));assert.equal(await hashSceneObject(a),createHash('sha256').update(canonicalStringify(a)).digest('hex'));
 assert.notEqual(await hashSceneObject(a),await hashSceneObject({...a,actions:[...a.actions].reverse()}));assert.equal(await hashSceneObject(null),null);
 const base=scene();assert.equal(await hashSceneContext(base),await hashSceneContext({...base,objects:[],terrain:{version:1,cells:[]}}));assert.notEqual(await hashSceneContext(base),await hashSceneContext({...base,custom:'new'}));assert.deepEqual(Object.keys(sceneOperationContext(base)),['version','bounds','spawn','areas']);
});

test('apply replaces in place, appends in declared order, sorts cells, and does not mutate inputs',()=>{
 const base=scene(),original=structuredClone(base),operations=[{kind:'object',id:'z',before:null,after:{id:'z'}},{kind:'object',id:'a',before:'hash',after:{id:'a',name:'renamed'}},{kind:'object',id:'y',before:null,after:{id:'y'}},{kind:'object',id:'b',before:'hash',after:null},{kind:'terrain',x:2,z:1,before:null,after:[2,1,'wood',false]},{kind:'terrain',x:1,z:-1,before:null,after:[1,-1,'soil',false]}];
 const next=applySceneOperations(base,operations);assert.deepEqual(next.objects.map(o=>o.id),['a','z','y']);assert.equal(next.objects[0].name,'renamed');assert.deepEqual(next.terrain.cells,[[1,-1,'soil',false],[2,1,'wood',false]]);assert.deepEqual(base,original);next.objects[1].name='changed';assert.equal(operations[0].after.name,undefined);
});

test('batch schema rejects identity substitution, duplicates, malformed hashes, no-op cells, and unknown envelope fields',()=>{
 for(const mutate of [b=>b.operations[0].after.id='different',b=>b.operations.push(b.operations[0]),b=>b.operations[0].before='bad',b=>b.actorId='forged',b=>b.operations=[],b=>b.operations=[{kind:'terrain',x:0,z:0,before:[0,0,'grass',false],after:[0,0,'grass',false]}],b=>b.operations=[{kind:'terrain',x:0,z:0,before:null,after:[1,0,'grass',true]}],b=>b.admission.extra=true]){const b=batch();mutate(b);assert.throws(()=>validateSceneOperationBatch(b));}
 assert.equal(validateSceneOperationBatch(batch()).version,1);
 const a=batch(),b={...a,admission:{...a.admission,admissionRevision:2}};assert.deepEqual(sceneOperationRequestIdentity('r',a),sceneOperationRequestIdentity('r',b));assert.equal(sceneOperationRequestIdentity('r',a).personalAreaRevisions,null);
});

test('schema accepts full 6096 target budget and rejects either category overflow',()=>{
 const b=batch();b.operations=Array.from({length:2000},(_,i)=>({kind:'object',id:'o'+i,before:null,after:{id:'o'+i,type:'chair',x:0,z:0}}));b.operations.push(...Array.from({length:4096},(_,i)=>({kind:'terrain',x:i%64,z:Math.floor(i/64),before:null,after:[i%64,Math.floor(i/64),'grass',false]})));
 assert.equal(validateSceneOperationBatch(b).operations.length,6096);const overflow=batch();overflow.operations=Array.from({length:2001},(_,i)=>({kind:'object',id:'o'+i,before:null,after:{id:'o'+i}}));assert.throws(()=>validateSceneOperationBatch(overflow));
});

test('journal migration retains current baseline; trigger snapshots and bounded fallback use only scene data',()=>{
 const store=new Store(':memory:',[{id:'w',name:'World',rooms:[{id:'r',name:'Room',scene:scene()}]}]);try{
  const user=store.createUser('Owner','0');assert.equal(store.all('SELECT * FROM scene_operation_journal').length,1);
  for(let i=0;i<67;i++)store.run('UPDATE rooms SET revision=revision+1,scene=? WHERE id=?',JSON.stringify({...scene(),theme:'theme'+i}),'r');
  assert.equal(store.all('SELECT * FROM scene_operation_journal').length,64);
  let replay=replaySceneOperations(store,'r',user.id,65);assert.equal(replay.mode,'replay');assert.deepEqual(replay.snapshots.map(s=>s.revision),[66,67]);assert.deepEqual(Object.keys(replay.snapshots[0]),['revision','scene']);
  replay=replaySceneOperations(store,'r',user.id,0);assert.equal(replay.mode,'snapshot');assert.equal(replay.snapshots[0].revision,67);
  store.run('DELETE FROM scene_operation_journal WHERE revision=?',66);assert.equal(replaySceneOperations(store,'r',user.id,65).mode,'snapshot');assert.equal(replaySceneOperations(store,'r',user.id,68).mode,'snapshot');
 }finally{store.close();}
});
