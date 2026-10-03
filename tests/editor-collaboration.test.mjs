import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileScenes,sceneChanges,rebaseHistory,createSceneOperationRequest,jsonSnapshot,reconciliationGeometryProblem,reconnectDraftReference} from '../src/editor-collaboration.js';
import {emptyScene} from '../src/worlds.js';
const item=(id,x=4)=>({id,type:'chair',name:id,x,z:4,rotation:0});
const scene=(objects=[],cells=[])=>({...emptyScene(),objects,terrain:{version:1,cells}});
const merge=(base,mine,server,options={})=>reconcileScenes({base,mine,server,...options});

test('disjoint additions and edits preserve both clients in either order',()=>{
 const base=scene([item('a'),item('b',-4)]),mine=jsonSnapshot(base),peer=jsonSnapshot(base);mine.objects[0].name='Mine';mine.objects.push(item('local',7));peer.objects[1].name='Peer';peer.objects.push(item('remote',-7));
 for(const [left,right]of [[mine,peer],[peer,mine]]){const result=merge(base,left,right);assert.equal(result.conflicts.length,0);assert.equal(result.scene.objects.find(o=>o.id==='a').name,'Mine');assert.equal(result.scene.objects.find(o=>o.id==='b').name,'Peer');assert.equal(result.scene.objects.length,4);}
});
test('terrain is reconciled per coordinate and exact conflicting tuples are retained',()=>{
 const base=scene([],[[-3,-3,'stone',false]]),mine=scene([],[[-3,-3,'wood',false],[4,4,'grass',false]]),peer=scene([],[[-3,-3,'water',true],[-4,-4,'soil',false]]),r=merge(base,mine,peer);
 assert.equal(r.conflicts.length,1);assert.equal(r.conflicts[0].key,'terrain:-3,-3');assert.deepEqual(r.conflicts[0].base,[-3,-3,'stone',false]);assert.deepEqual(r.conflicts[0].mine,[-3,-3,'wood',false]);assert.deepEqual(r.conflicts[0].server,[-3,-3,'water',true]);
 const chosen=merge(base,mine,peer,{choices:{'terrain:-3,-3':'server'}});assert.equal(chosen.conflicts.length,0);assert.deepEqual(chosen.scene.terrain.cells,[[-4,-4,'soil',false],[-3,-3,'water',true],[4,4,'grass',false]]);
});
test('same-object action ordering and delete versus edit require target review',()=>{
 const base=scene([{...item('a'),actions:[{id:'x'},{id:'y'}]}]),mine=jsonSnapshot(base),peer=scene();mine.objects[0].actions.reverse();
 const r=merge(base,mine,peer);assert.equal(r.conflicts[0].key,'object:a');assert.equal(r.conflicts[0].server,null);
 const resolved=merge(base,mine,peer,{choices:{'object:a':'mine'}});assert.deepEqual(resolved.scene.objects[0].actions,[{id:'y'},{id:'x'}]);assert.equal(resolved.conflicts.length,0);
});
test('same final target converges without a duplicate local change',()=>{const base=scene(),mine=scene([item('a')]);const r=merge(base,mine,mine);assert.equal(r.conflicts.length,0);assert.deepEqual(r.scene,mine);});
test('metadata changes are explicit while choosing mine retains independent peer objects',()=>{
 const base=scene([item('a')]),mine=jsonSnapshot(base),peer=scene([item('a'),item('peer',-4)]);mine.bounds.width=30;
 const r=merge(base,mine,peer);assert.equal(r.conflicts[0].kind,'context');assert.equal(sceneChanges(base,mine).legacy,true);
 const chosen=merge(base,mine,peer,{choices:{context:'mine'}});assert.equal(chosen.scene.bounds.width,30);assert.equal(chosen.scene.objects.length,2);assert.equal(chosen.legacy,true);
});
test('incoming context invalidates object preflight and requires explicit current context review',()=>{const base=scene(),mine=scene([item('a')]),peer=scene();peer.bounds.width=30;const r=merge(base,mine,peer);assert.equal(r.conflicts[0].kind,'context');const chosen=merge(base,mine,peer,{choices:{context:'mine'}});assert.equal(chosen.scene.bounds.width,30);assert.equal(chosen.conflicts.length,0);assert.equal(chosen.legacy,false);});
test('combined geometry cannot be accepted by choosing mine',()=>{
 const base=scene(),mine=scene([item('a')]),peer=scene([item('b')]),validate=s=>s.objects.length>1?'Overlaps b':null;
 for(const choices of [{},{geometry:'mine'}]){const r=merge(base,mine,peer,{validate,choices});assert.equal(r.conflicts[0].kind,'geometry');}
 const chosen=merge(base,mine,peer,{validate,choices:{geometry:'server'}});assert.equal(chosen.conflicts.length,0);assert.deepEqual(chosen.scene,peer);
});
test('peer addition survives every transformed undo/redo snapshot',()=>{
 const base=scene(),old=scene([item('mine')]),peer=scene([item('peer',-4)]),entries=[{scene:base,selected:null},{scene:old,selected:'mine'}];
 const r=rebaseHistory(entries,{base,server:peer});assert.equal(r.invalidated,false);assert.equal(r.entries[0].scene.objects[0].id,'peer');assert.deepEqual(r.entries[1].scene.objects.map(o=>o.id),['peer','mine']);
});
test('undo cannot resurrect a peer deletion or overwrite a peer rename',()=>{
 const base=scene([item('a')]),history=[{scene:scene([{...item('a'),name:'old'}])}];for(const peer of [scene(),scene([{...item('a'),name:'peer'}])]){const r=rebaseHistory(history,{base,server:peer});assert.equal(r.invalidated,true);assert.deepEqual(r.entries,[]);}
});
test('frozen request snapshot retains operation identity and optional transport JSON semantics',async()=>{
 const base=scene(),mine=scene([{...item('a'),optional:undefined}]),input={base,mine,baseRevision:1,operationId:'batch-a',admission:{admissionId:'a',admissionEpoch:'epoch',admissionRevision:1}};
 const request=await createSceneOperationRequest(input),before=JSON.stringify(request);mine.objects[0].name='later';input.admission.admissionId='new';assert.equal(JSON.stringify(request),before);assert.equal(request.operations[0].before,null);assert.equal(request.contextHash.length,64);assert.equal(Object.isFrozen(request.operations[0].after),true);
});
test('object reordering stays on whole-room CAS rather than silently changing order',()=>{const base=scene([item('a'),item('b')]),mine=scene([item('b'),item('a')]);assert.equal(sceneChanges(base,mine).legacy,true);});

test('renaming grandfathered overlaps survives independent rebase without introducing new geometry',()=>{
 const base=scene([item('a'),item('b')]),mine=jsonSnapshot(base),peer=jsonSnapshot(base);mine.objects[0].name='Renamed';mine.objects[0].text='Description';mine.objects[0].color='#abcdef';peer.objects.push(item('peer',-4));
 assert.equal(reconciliationGeometryProblem(base,mine),null);const rebased=merge(base,mine,peer,{validate:(candidate,current)=>reconciliationGeometryProblem(current,candidate)});assert.equal(rebased.conflicts.length,0);assert.equal(rebased.scene.objects[0].name,'Renamed');assert.equal(rebased.scene.objects.length,3);
 const moved=jsonSnapshot(base);moved.objects[0].x+=.1;assert.match(reconciliationGeometryProblem(base,moved),/Overlaps b/);
});
test('room-edge validation uses full rotated footprint even for non-solid objects',()=>{
 const base=scene(),next=scene([{id:'rug',type:'rug',name:'Diagonal rug',x:13.8,z:-4,width:4,depth:3,rotation:0}]);assert.equal(reconciliationGeometryProblem(base,next),null);next.objects[0].rotation=45;assert.match(reconciliationGeometryProblem(base,next),/whole item inside the room edge/);
});

test('reconnect retains post-request undo intent for committed, uncommitted and ambiguous targets',()=>{
 const base=scene(),submitted=scene([item('mine')]),mine=scene(),peer=item('peer',-4);
 for(const server of [scene([peer]),scene([item('mine'),peer])]){const reference=reconnectDraftReference({base,submitted,mine,server}),result=merge(reference,mine,server);assert.equal(result.conflicts.length,0);assert.deepEqual(result.scene.objects.map(o=>o.id),['peer']);}
 const server=scene([{...item('mine'),name:'Peer changed my item'},peer]),reference=reconnectDraftReference({base,submitted,mine,server}),result=merge(reference,mine,server);assert.equal(result.conflicts[0].key,'object:mine');assert.equal(result.conflicts[0].mine,null);
});
