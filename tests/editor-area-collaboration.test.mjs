import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileScenes,sceneChanges,rebaseHistory,createSceneOperationRequest,jsonSnapshot,reconciliationGeometryProblem,reconnectDraftReference,conflictLabel,conflictValueLabel,sceneRequestHash} from '../src/editor-collaboration.js';
import {hashSceneArea,hashSceneField,hashSceneContext,validateSceneOperationBatch} from '../src/scene-operations.js';
import {emptyScene} from '../src/worlds.js';
const area=(id,x=-5)=>({id,name:id,x,z:-4,width:3,depth:3,action:'welcome'});
const item=(id,x=5)=>({id,type:'chair',name:id,x,z:-4,rotation:0});
const scene=(areas=[],objects=[])=>({...emptyScene(),areas,objects});
const merge=(base,mine,server,options={})=>reconcileScenes({base,mine,server,version:2,...options});
const validate=(candidate,current)=>reconciliationGeometryProblem(current,candidate);
const admission={admissionId:'joined',admissionEpoch:'process',admissionRevision:1};

test('v2 independently merges privacy area, room environment and peer objects in either order',()=>{
 const base=scene([area('a')]),mine=jsonSnapshot(base),server=jsonSnapshot(base);mine.areas[0].action='silent';mine.theme='studio';server.objects.push(item('peer'));server.areas.push(area('peer-area',8));
 for(const [left,right]of [[mine,server],[server,mine]]){const result=merge(base,left,right,{validate});assert.equal(result.conflicts.length,0);assert.equal(result.scene.areas.find(a=>a.id==='a').action,'silent');assert.equal(result.scene.theme,'studio');assert.equal(result.scene.objects[0].id,'peer');assert.equal(result.scene.areas.length,2);assert.equal(result.legacy,false);}
 assert.equal(sceneChanges(base,mine).legacy,true);assert.equal(sceneChanges(base,mine,{version:2}).legacy,false);
});
test('whole area identity conflicts retain action ordering, delete/edit and same-ID additions',()=>{
 const base=scene([{...area('a'),actions:[{id:'x',type:'message'},{id:'y',type:'link'}]}]),mine=jsonSnapshot(base),server=jsonSnapshot(base);mine.areas[0].actions.reverse();server.areas[0].name='Server name';
 for(const remote of [server,scene()]){const result=merge(base,mine,remote);assert.equal(result.conflicts[0].key,'area:a');assert.deepEqual(result.conflicts[0].mine.actions,mine.areas[0].actions);const kept=merge(base,mine,remote,{choices:{'area:a':'mine'}});assert.equal(kept.conflicts.length,0);assert.deepEqual(kept.scene.areas[0],mine.areas[0]);}
 assert.equal(merge(scene(),scene([area('same')]),scene([{...area('same'),action:'silent'}])).conflicts[0].key,'area:same');
 assert.equal(merge(base,mine,mine).conflicts.length,0);
});
test('scene fields merge by allowlisted identity with whole bounds and spawn values',()=>{
 const base=scene(),mine=jsonSnapshot(base),server=jsonSnapshot(base);mine.bounds.width=30;server.bounds.depth=24;server.theme='studio';server.objects.push(item('peer'));
 const result=merge(base,mine,server);assert.equal(result.conflicts.some(c=>c.key==='scene:bounds'),true);assert.deepEqual(result.conflicts.find(c=>c.key==='scene:bounds').base,{width:32,depth:26});
 const kept=merge(base,mine,server,{choices:{'scene:bounds':'mine',dependencies:'mine'},validate});assert.equal(kept.conflicts.length,0);assert.deepEqual(kept.scene.bounds,{width:30,depth:26});assert.equal(kept.scene.theme,'studio');assert.equal(kept.scene.objects[0].id,'peer');
 mine.spawn={x:1,z:7};server.spawn={x:0,z:6};assert.equal(merge(base,mine,server).conflicts.some(c=>c.key==='scene:spawn'),true);
});
test('unsupported metadata and explicit area/object reorder stay reviewed CAS',()=>{
 const base=scene([area('a'),area('b',8)],[item('a'),item('b',-8)]),mine=jsonSnapshot(base),server=jsonSnapshot(base);mine.hierarchyPrivacy='private';server.theme='studio';server.areas[0].name='Peer area';server.objects.push(item('peer',10));
 const result=merge(base,mine,server);assert.equal(result.conflicts[0].kind,'context');assert.equal(result.legacy,false);
 const kept=merge(base,mine,server,{choices:{context:'mine'}});assert.equal(kept.scene.hierarchyPrivacy,'private');assert.equal(kept.scene.theme,'studio');assert.equal(kept.scene.areas[0].name,'Peer area');assert.equal(kept.scene.objects.length,3);assert.equal(kept.legacy,true);
 for(const field of ['areas','objects']){const reordered=jsonSnapshot(base);reordered[field].reverse();assert.equal(sceneChanges(base,reordered,{version:2}).legacy,true);const chosen=merge(base,reordered,server,{choices:{context:'mine'}});assert.equal(chosen.scene[field][0].id,'b');assert.equal(chosen.scene.theme,'studio');assert.equal(chosen.scene.objects.length,3);}
});
test('combined bounds, arrival areas and peer objects fail closed without moving peers',()=>{
 const base=scene(),mine=jsonSnapshot(base),server=scene([],[item('peer',14)]);mine.bounds.width=20;
 const result=merge(base,mine,server,{validate});assert.equal(result.conflicts.some(c=>c.kind==='geometry'),true);assert.match(result.conflicts.find(c=>c.kind==='geometry').reason,/room edge/);assert.equal(merge(base,mine,server,{validate,choices:{geometry:'mine',dependencies:'mine'}}).conflicts.length,1);assert.deepEqual(merge(base,mine,server,{validate,choices:{geometry:'server',dependencies:'server'}}).scene,server);
 const start={...area('arrival',5),width:1,depth:1,start:{key:'landing'}};const arrival=scene([start]),occupied=scene([],[item('peer')]);assert.match(merge(base,arrival,occupied,{validate}).conflicts.find(c=>c.kind==='geometry').reason,/no safe landing/);
});
test('area and scene field history preserves independent peers and invalidates ambiguous snapshots',()=>{
 const base=scene([area('a')]),mine=jsonSnapshot(base),server=jsonSnapshot(base);mine.areas[0].action='silent';mine.theme='studio';server.objects.push(item('peer'));
 const entries=[{scene:base},{scene:mine}],rebased=rebaseHistory(entries,{base,server,version:2,validate});assert.equal(rebased.invalidated,false);for(const entry of rebased.entries)assert.equal(entry.scene.objects[0].id,'peer');assert.equal(rebased.entries[1].scene.areas[0].action,'silent');
 server.areas[0].action='meeting';assert.equal(rebaseHistory(entries,{base,server,version:2,validate}).invalidated,true);
});
test('v2 frozen wire request hashes full areas and supported fields and retains exact identity',async()=>{
 const base=scene([area('a')]),mine=jsonSnapshot(base);mine.areas[0].action='silent';mine.theme='studio';mine.spawn={x:1,z:7};
 const request=await createSceneOperationRequest({base,mine,version:2,baseRevision:7,operationId:'area-batch',admission});validateSceneOperationBatch(request);assert.equal(request.version,2);assert.equal(request.contextHash,await hashSceneContext(base,2));assert.equal(request.operations.find(o=>o.kind==='area').before,await hashSceneArea(base.areas[0]));assert.equal(request.operations.find(o=>o.field==='theme').before,await hashSceneField(base,'theme'));
 const identity=await sceneRequestHash('room',request),exact=JSON.stringify(request);mine.areas[0].name='Later';base.theme='assembly';assert.equal(JSON.stringify(request),exact);assert.equal(await sceneRequestHash('room',request),identity);assert.equal(Object.isFrozen(request.operations[0].after),true);
 await assert.rejects(()=>createSceneOperationRequest({base,mine,baseRevision:7,operationId:'legacy',admission}),/whole-room save/);
});
test('optional theme deletion is explicit and unknown room fields never become operation targets',async()=>{
 const base=scene(),mine=jsonSnapshot(base);delete mine.theme;const request=await createSceneOperationRequest({base,mine,version:2,baseRevision:1,operationId:'theme-delete',admission});validateSceneOperationBatch(request);assert.deepEqual(request.operations.map(o=>[o.kind,o.field,o.after]),[['scene','theme',null]]);
 mine.privacy='private';assert.equal(sceneChanges(base,mine,{version:2}).legacy,true);await assert.rejects(()=>createSceneOperationRequest({base,mine,version:2,baseRevision:1,operationId:'unsupported',admission}),/whole-room save/);
});
test('post-request area undo and field undo survive committed and uncommitted reconnects',()=>{
 const base=scene(),submitted=scene([area('a')]);submitted.theme='studio';
 for(const committed of [false,true]){const server=committed?jsonSnapshot(submitted):jsonSnapshot(base);server.objects.push(item('peer'));const reference=reconnectDraftReference({base,submitted,mine:base,server,version:2}),result=merge(reference,base,server);assert.equal(result.conflicts.length,0);assert.deepEqual(result.scene.areas,[]);assert.equal(result.scene.theme,base.theme);assert.equal(result.scene.objects[0].id,'peer');}
 const server=scene([{...area('a'),name:'Peer edit'}]);server.theme='assembly';const reference=reconnectDraftReference({base,submitted,mine:base,server,version:2}),result=merge(reference,base,server);assert.deepEqual(result.conflicts.map(c=>c.key),['area:a','scene:theme']);
});
test('review labels explain area behavior and room field values with retained exact JSON',()=>{
 assert.match(conflictLabel({kind:'area',id:'a',mine:area('a')}),/Area: a/);assert.equal(conflictLabel({kind:'scene',field:'theme'}),'Room environment');assert.equal(conflictValueLabel({width:24,depth:20},'scene','bounds'),'24 × 20 m');assert.equal(conflictValueLabel({x:1,z:2},'scene','spawn'),'(1, 2)');assert.match(conflictValueLabel({...area('a'),action:'silent',personalArea:{mode:'dynamic'},actions:[{type:'link'},{type:'message'}]},'area'),/On entry: silent[\s\S]*Personal space: dynamic[\s\S]*link → message/);assert.equal(conflictValueLabel(null,'scene','theme'),'Absent / deleted');
});


test('nearby area behavior versus object or terrain edit requires symmetric explicit review',()=>{
 const base=scene([area('quiet')]),privacy=jsonSnapshot(base),object=jsonSnapshot(base),terrain=jsonSnapshot(base);privacy.areas[0].action='silent';object.objects.push(item('inside',-5));terrain.terrain={version:1,cells:[[-5,-4,'stone',false]]};
 for(const peer of [object,terrain])for(const [mine,server]of [[privacy,peer],[peer,privacy]]){const result=merge(base,mine,server,{validate});assert.equal(result.conflicts.some(c=>c.kind==='dependencies'),true);const accepted=merge(base,mine,server,{validate,choices:{dependencies:'mine'}});assert.equal(accepted.conflicts.length,0);assert.equal(accepted.scene.areas[0].action,'silent');assert.equal(peer===object?accepted.scene.objects.length:accepted.scene.terrain.cells.length,1);assert.deepEqual(merge(base,mine,server,{validate,choices:{dependencies:'server'}}).scene,server);}
});
test('overlapping area edits require review while disjoint areas and existing overlaps stay independent',()=>{
 const base=scene([area('a'),area('b',-4)]),mine=jsonSnapshot(base),server=jsonSnapshot(base);mine.areas[0].action='silent';server.areas[1].action='meeting';
 for(const [left,right]of [[mine,server],[server,mine]])assert.equal(merge(base,left,right).conflicts.some(c=>c.kind==='dependencies'),true);
 assert.equal(merge(base,mine,base).conflicts.length,0);
 const far=scene([area('a'),area('b',8)]),left=jsonSnapshot(far),right=jsonSnapshot(far);left.areas[0].action='silent';right.areas[1].action='meeting';assert.equal(merge(far,left,right).conflicts.length,0);
});
test('bounds or spawn versus independent geometry requires review in both arrival orders',()=>{
 const base=scene(),object=scene([],[item('peer')]);for(const field of ['bounds','spawn']){const mine=jsonSnapshot(base);mine[field]=field==='bounds'?{width:30,depth:24}:{x:1,z:7};for(const [left,right]of [[mine,object],[object,mine]]){const result=merge(base,left,right,{validate});assert.equal(result.conflicts.some(c=>c.kind==='dependencies'),true);assert.equal(merge(base,left,right,{validate,choices:{dependencies:'mine'}}).conflicts.length,0);}}
});


test('moving a legacy trapped spawn into another trap requires a clear escape',()=>{
 const walls=(x,z,prefix)=>[{id:prefix+'n',type:'wall',name:'North wall',x,z:z-1,width:3,depth:.3,rotation:0},{id:prefix+'s',type:'wall',name:'South wall',x,z:z+1,width:3,depth:.3,rotation:0},{id:prefix+'w',type:'wall',name:'West wall',x:x-1,z,width:3,depth:.3,rotation:90},{id:prefix+'e',type:'wall',name:'East wall',x:x+1,z,width:3,depth:.3,rotation:90}];
 const base=scene([], [...walls(0,7,'old'),...walls(7,-4,'new')]),next=jsonSnapshot(base);next.spawn={x:7,z:-4};assert.equal(reconciliationGeometryProblem(base,base),null);assert.match(reconciliationGeometryProblem(base,next),/clear walking route/);
});

import {bindImageDefinitions} from '../src/image-asset-context.js';
import {normalizeImageAssetDraft,validateImageDefinition} from '../src/image-asset-schema.js';
test('dependency hashing retains authorized image footprint bindings and unresolved images fail closed',async()=>{
 const stamp='2026-10-03T00:00:00.000Z',definition={schemaVersion:1,assetId:'image',roomId:'r',createdBy:'actor',createdAt:stamp,originKind:'upload'},version={...normalizeImageAssetDraft({name:'Wide image',floating:true},{width:128,height:64,byteLength:100,mediaType:'image/png'}),schemaVersion:1,assetId:'image',roomId:'r',versionId:'v1',sequence:1,sha256:'a'.repeat(64),createdBy:'actor',createdAt:stamp},definitions={'image:v1':{...validateImageDefinition(definition,version),status:'active'}};
 const image={id:'picture',type:'image',assetRef:{assetId:'image',versionId:'v1'},name:'Picture',x:-5,z:-4,rotation:0},base=scene([area('a')],[image]),mine=jsonSnapshot(base),server=jsonSnapshot(base);mine.areas[0].action='silent';server.objects[0].name='Peer image';for(const value of [base,mine,server])bindImageDefinitions(value,definitions,'r');
 const result=merge(base,mine,server);assert.deepEqual(result.conflicts.map(c=>c.kind),['dependencies']);assert.equal(merge(base,mine,server,{choices:{dependencies:'mine'}}).conflicts.length,0);
 const request=await createSceneOperationRequest({base,mine,version:2,baseRevision:1,operationId:'image-area',admission});assert.equal(request.dependenciesHash.length,64);assert.equal(Object.hasOwn(request,'imageDefinitions'),false);validateSceneOperationBatch(request);
 const unresolved=merge(jsonSnapshot(base),jsonSnapshot(mine),jsonSnapshot(server));assert.equal(unresolved.conflicts[0].kind,'geometry');assert.match(unresolved.conflicts[0].reason,/geometry/);assert.equal(merge(jsonSnapshot(base),jsonSnapshot(mine),jsonSnapshot(server),{choices:{geometry:'mine'}}).conflicts.length,1);
 await assert.rejects(()=>createSceneOperationRequest({base:jsonSnapshot(base),mine:jsonSnapshot(mine),version:2,baseRevision:1,operationId:'missing-image',admission}),/geometry/);
});


test('retained bounds metadata cannot shift the centered room-edge check',()=>{
 const base=scene(),next=scene([],[{id:'outside',type:'rug',name:'Outside rug',x:20,z:0,width:2,depth:2,rotation:0}]);next.bounds={...base.bounds,x:20,z:0};assert.match(reconciliationGeometryProblem(base,next),/whole item inside the room edge/);
 const areaOnly=scene([{...area('outside',20),z:0}]);areaOnly.bounds={...base.bounds,x:20,z:0};assert.match(reconciliationGeometryProblem(base,areaOnly),/whole area inside the room edge/);
});
