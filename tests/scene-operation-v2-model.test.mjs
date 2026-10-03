import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalStringify,sceneOperationContext,hashSceneContext,hashSceneArea,hashSceneField,sceneOperationRequestIdentity,validateSceneOperationBatch,applySceneOperations,sceneOperationTargets,sceneOperationDependencyView,hashSceneOperationDependencies} from '../src/scene-operations.js';
const area=(id,x=0)=>({id,name:id,x,z:0,width:2,depth:2,action:'welcome'});
const scene=()=>({version:1,theme:'garden',bounds:{width:32,depth:26},spawn:{x:0,z:10},objects:[],areas:[area('a'),area('b',4)],retained:{source:'original'}});
const batch=operations=>({version:2,operationId:'v2-change',baseRevision:4,contextHash:'a'.repeat(64),dependenciesHash:'b'.repeat(64),operations,admission:{admissionId:'joined',admissionEpoch:'epoch',admissionRevision:1}});
const digest=value=>createHash('sha256').update(canonicalStringify(value)).digest('hex');

test('v2 excludes only independently supported values; default v1 context and semantic identity stay exact',async()=>{
 const base=scene(),changed={...base,theme:'studio',bounds:{width:40,depth:40},spawn:{x:2,z:2},areas:[]};
 assert.deepEqual(sceneOperationContext(base,2),{version:1,retained:{source:'original'}});
 assert.equal(await hashSceneContext(base,2),await hashSceneContext(changed,2));
 assert.notEqual(await hashSceneContext(base),await hashSceneContext(changed));
 assert.equal(await hashSceneContext(base),digest(sceneOperationContext(base)));
 assert.notEqual(await hashSceneContext(base,2),await hashSceneContext({...base,retained:{source:'new'}},2));
 assert.notEqual(await hashSceneContext(base,2),await hashSceneContext({...base,version:2},2));
 const wire=batch([{kind:'scene',field:'theme',before:digest(base.theme),after:'studio'}]);
 assert.deepEqual(sceneOperationRequestIdentity('room',wire),{roomId:'room',version:2,baseRevision:4,contextHash:'a'.repeat(64),dependenciesHash:'b'.repeat(64),operations:wire.operations,personalAreaRevisions:null,dependenciesHash:'b'.repeat(64)});
 assert.notEqual(digest(sceneOperationRequestIdentity('room',wire)),digest(sceneOperationRequestIdentity('room',{...wire,version:1})));
});

test('area and field hashing preserve ordered actions, full values and absent fields',async()=>{
 const a={...area('a'),actions:[{id:'one',type:'message',text:'First'},{id:'two',type:'message',text:'Second'}]};
 assert.equal(await hashSceneArea(a),digest(a));assert.equal(await hashSceneArea(null),null);
 assert.notEqual(await hashSceneArea(a),await hashSceneArea({...a,actions:[...a.actions].reverse()}));
 assert.equal(await hashSceneField({},'theme'),null);assert.equal(await hashSceneField({theme:null},'theme'),digest(null));
 assert.equal(await hashSceneField(scene(),'bounds'),digest(scene().bounds));
});

test('v2 area replacements and field removals preserve array order and clone all values',()=>{
 const base=scene(),a={...area('a'),name:'Edited'},c=area('c',-4),d=area('d',6);
 const ops=[{kind:'area',id:'c',before:null,after:c},{kind:'area',id:'a',before:digest(base.areas[0]),after:a},{kind:'area',id:'d',before:null,after:d},{kind:'area',id:'b',before:digest(base.areas[1]),after:null},{kind:'scene',field:'theme',before:digest(base.theme),after:null}];
 assert.equal(validateSceneOperationBatch(batch(ops)).version,2);
 const merged=applySceneOperations(base,ops);assert.deepEqual(merged.areas.map(a=>a.id),['a','c','d']);assert.equal(Object.hasOwn(merged,'theme'),false);assert.equal(base.theme,'garden');
 merged.areas[1].name='Only merged';assert.equal(c.name,'c');assert.equal(base.areas[0].name,'a');
 assert.deepEqual(sceneOperationTargets(ops),[{kind:'area',id:'c'},{kind:'area',id:'a'},{kind:'area',id:'d'},{kind:'area',id:'b'},{kind:'scene',field:'theme'}]);
});

test('v2 rejects identity substitution, unknown scene or metadata targets, partial types and v1 extension use',()=>{
 const good={kind:'area',id:'a',before:'a'.repeat(64),after:area('a')};
 for(const operation of [{...good,after:area('other')},{...good,before:null,after:null},{...good,index:0},{kind:'scene',field:'public',before:null,after:false},{kind:'scene',field:'name',before:null,after:'Room'},{kind:'scene',field:'version',before:'a'.repeat(64),after:2},{kind:'scene',field:'bounds',before:'a'.repeat(64),after:null},{kind:'scene',field:'spawn',before:'a'.repeat(64),after:3},{kind:'scene',field:'theme',before:null,after:null}])assert.throws(()=>validateSceneOperationBatch(batch([operation])));
 assert.throws(()=>validateSceneOperationBatch({...batch([good]),version:1}));
 assert.throws(()=>validateSceneOperationBatch(batch([good,good])),{code:'DUPLICATE_SCENE_TARGET'});
 const theme={kind:'scene',field:'theme',before:'a'.repeat(64),after:'studio'};assert.throws(()=>validateSceneOperationBatch(batch([theme,theme])),{code:'DUPLICATE_SCENE_TARGET'});
 assert.throws(()=>validateSceneOperationBatch(batch(Array.from({length:101},(_,i)=>({kind:'area',id:'area'+i,before:null,after:area('area'+i)})))));
});


test('v2 symmetric spatial dependencies retain old/new neighbors, inclusive cells, media groups and exclusions',async()=>{
 const base=scene();base.areas=[area('old-neighbor',2),area('new-neighbor',10),area('far',-10),{...area('linked',-12),action:'audience',meetingName:'same'}];
 base.objects=[{id:'inside',type:'chair',x:0,z:0},{id:'far-object',type:'chair',x:-12,z:0}];base.terrain={version:1,cells:[[9,0,'wood',false],[1,0,'stone',false],[-10,0,'grass',false]]};
 const move={kind:'area',id:'moving',before:null,after:{...area('moving',0),action:'stage',meetingName:'same'}};
 const view=sceneOperationDependencyView(base,[move]);assert.deepEqual(view.areas.map(a=>a.id),['old-neighbor','linked']);assert.deepEqual(view.objects.map(o=>o.id),['inside']);assert.deepEqual(view.terrain,[[1,0,'stone',false]]);
 assert.equal(await hashSceneOperationDependencies(base,[move]),digest(view));
 const remote={...base,areas:[...base.areas,area('phantom',0)]};assert.notEqual(await hashSceneOperationDependencies(base,[move]),await hashSceneOperationDependencies(remote,[move]));
 const both=[move,{kind:'area',id:'old-neighbor',before:'a'.repeat(64),after:area('old-neighbor',2)},{kind:'object',id:'inside',before:'a'.repeat(64),after:null},{kind:'terrain',x:1,z:0,before:[1,0,'stone',false],after:null}];
 const excluded=sceneOperationDependencyView(base,both);assert.deepEqual(excluded.areas.map(a=>a.id),['linked']);assert.deepEqual(excluded.objects,[]);assert.deepEqual(excluded.terrain,[]);
 const objectChange={kind:'object',id:'inside',before:'a'.repeat(64),after:{...base.objects[0],x:10}};
 assert.deepEqual(sceneOperationDependencyView(base,[objectChange]).areas.map(a=>a.id),['new-neighbor']);
 const beforeMove={...base,areas:[...base.areas,area('moving',0)]};assert.deepEqual(sceneOperationDependencyView(beforeMove,[{...move,after:area('moving',10)}]).areas.map(a=>a.id),['old-neighbor','new-neighbor']);
});

test('v2 structural changes depend on all remaining scene contents and theme has an empty read set',()=>{
 const base=scene();base.objects=[{id:'image',type:'image',assetRef:{assetId:'missing',versionId:'missing'},x:0,z:0,rotation:0}];
 const theme={kind:'scene',field:'theme',before:'a'.repeat(64),after:'studio'};
 assert.deepEqual(sceneOperationDependencyView(base,[theme]),{version:1,bounds:null,spawn:null,areas:[],objects:[],terrain:[]});
 const bounds={kind:'scene',field:'bounds',before:'a'.repeat(64),after:{width:40,depth:40}};
 assert.deepEqual(sceneOperationDependencyView(base,[bounds]).objects,base.objects);
 assert.throws(()=>sceneOperationDependencyView(base,[{kind:'area',id:'new',before:null,after:area('new')}]),{code:'SCENE_DEPENDENCY_GEOMETRY'});
 const body=batch([theme]);delete body.dependenciesHash;assert.throws(()=>validateSceneOperationBatch(body));
 assert.throws(()=>validateSceneOperationBatch({...batch([theme]),version:1}));
});

test('a newly selected spawn needs an exit even when a different legacy spawn was trapped',async()=>{
 const {sceneOperationGeometryConflicts}=await import('../server/scene-operation-geometry.mjs');
 const cage=x=>[{id:`n${x}`,type:'wall',x,z:1,width:3,depth:.3},{id:`s${x}`,type:'wall',x,z:-1,width:3,depth:.3},{id:`w${x}`,type:'wall',x:x-1,z:0,width:3,depth:.3,rotation:90},{id:`e${x}`,type:'wall',x:x+1,z:0,width:3,depth:.3,rotation:90}];
 const before={...scene(),spawn:{x:0,z:0},objects:[...cage(0),...cage(8)]};
 const check=next=>sceneOperationGeometryConflicts({store:{},presence:new Map(),now:()=>0,room:{id:'room'},before,next,beforeImages:{},nextImages:{}});
 assert.deepEqual(check({...before,theme:'studio'}),[]);
 assert.deepEqual(check({...before,spawn:{x:8,z:0}}),[{kind:'scene',field:'spawn'}]);
 assert.deepEqual(check({...before,spawn:{x:0,z:6}}),[]);
});

test('retained bounds metadata cannot shift the authoritative room containment origin',async()=>{
 const {sceneOperationGeometryConflicts}=await import('../server/scene-operation-geometry.mjs');
 const before=scene(),next={...before,bounds:{...before.bounds,x:1},objects:[{id:'overrun',type:'chair',x:15.9,z:0}]};
 const conflicts=sceneOperationGeometryConflicts({store:{},presence:new Map(),now:()=>0,room:{id:'room'},before,next,beforeImages:{},nextImages:{}});
 assert(conflicts.some(c=>c.kind==='object'&&c.id==='overrun'));assert(conflicts.some(c=>c.kind==='scene'&&c.field==='bounds'));
});
