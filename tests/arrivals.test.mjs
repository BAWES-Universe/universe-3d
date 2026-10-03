import test from 'node:test';
import assert from 'node:assert/strict';
import {ARRIVAL_LIMITS,entryCatalog,validateStarts,validateArrivalGeometry,resolveArrival,arrivalCandidates} from '../src/arrivals.js';
import {validateActions,itemActions} from '../src/action-schema.js';
import {canStand} from '../src/worlds.js';
import {bindImageDefinitions} from '../src/image-asset-context.js';
import {normalizeImageAssetDraft,validateImageDefinition} from '../src/image-asset-schema.js';
const start=(key,x=0,z=0,isDefault=false)=>({id:`area-${key}`,name:`Display ${key}`,action:'welcome',x,z,width:4,depth:4,start:{key,isDefault}});
const scene=(areas=[])=>({bounds:{width:30,depth:30},spawn:{x:0,z:10},objects:[],areas});
test('ARRIVAL-01 stable keys are independent of area labels and ordinary behavior; duplicates and forged settings reject',()=>{
 const s=scene([start('cafe'),start('stage',6,0,true)]);s.areas[0].action='teleport';s.areas[0].target='another';validateStarts(s);
 assert.deepEqual(entryCatalog(s).map(e=>e.key),['cafe','stage']);s.areas[0].name='Renamed café';assert.equal(entryCatalog(s)[0].key,'cafe');
 for(const bad of ['',null,'UPPER',' space','a.b','a#b','a/b','-first','x'.repeat(65)]){const copy=structuredClone(s);copy.areas[0].start.key=bad;assert.throws(()=>validateStarts(copy),{code:'INVALID_ENTRY'});}
 for(const patch of [{key:'stage'},{ownerId:'forged'},{isDefault:'yes'}]){const copy=structuredClone(s);Object.assign(copy.areas[0].start,patch);assert.throws(()=>validateStarts(copy));}
});
test('ARRIVAL-02 named entries outrank every default; unknown valid keys report fallback and every default remains selectable',()=>{
 const s=scene([start('cafe',-5,0,true),start('stage',5,0,true),start('door',0,5)]),seen=new Set();
 for(let seed=0;seed<40;seed++){assert.equal(resolveArrival(s,{entry:'door',seed}).entry,'door');seen.add(resolveArrival(s,{seed}).entry);const fallback=resolveArrival(s,{entry:'deleted',seed});assert.equal(fallback.fallback,'unknown-entry');assert.equal(fallback.requestedEntry,'deleted');assert.equal(fallback.source,'default');}
 assert.deepEqual([...seen].sort(),['cafe','stage']);const legacy=resolveArrival(scene(),{entry:'deleted'});assert.equal(legacy.source,'spawn');assert.equal(legacy.entry,null);assert.equal(legacy.fallback,'unknown-entry');
});
test('ARRIVAL-03 all finite candidates stay inset in the selected region and preserve the shared collision predicate',()=>{
 const area=start('tiny');area.width=.9;area.depth=.9;const tiny=scene([area]);assert.equal(arrivalCandidates(tiny,area).length,ARRIVAL_LIMITS.regionCandidates);assert.deepEqual(resolveArrival(tiny,{entry:'tiny'}).x,0);
 for(const patch of [{width:.89},{x:14.8},{x:NaN},{depth:Infinity}]){const copy=structuredClone(tiny);Object.assign(copy.areas[0],patch);assert.throws(()=>validateStarts(copy));}
 const s=scene([start('room-edge',12,0)]);s.objects.push({id:'wall',type:'wall',x:12,z:0,width:3,depth:.3,rotation:90});
 for(let seed=0;seed<100;seed++){const p=resolveArrival(s,{entry:'room-edge',seed}),a=s.areas[0];assert(Math.abs(p.x-a.x)<=a.width/2-ARRIVAL_LIMITS.inset);assert(Math.abs(p.z-a.z)<=a.depth/2-ARRIVAL_LIMITS.inset);assert(canStand(s,p.x,p.z,ARRIVAL_LIMITS.radius));}
});
test('ARRIVAL-04 named blocked regions never spill into another default; crowd failures are bounded and distinct',()=>{
 const s=scene([start('blocked'),start('other',7,0,true)]);s.objects=[{id:'blocker',type:'table',x:0,z:0,width:6,depth:6}];
 assert.throws(()=>resolveArrival(s,{entry:'blocked'}),error=>error.code==='ARRIVAL_BLOCKED'&&error.attempted===ARRIVAL_LIMITS.regionCandidates);assert.throws(()=>validateArrivalGeometry(s),{code:'ARRIVAL_BLOCKED'});
 const tiny=scene([{...start('single'),width:.9,depth:.9}]);assert.throws(()=>resolveArrival(tiny,{entry:'single',occupants:[{x:0,z:0}]}),error=>error.code==='ARRIVAL_OCCUPIED'&&error.attempted===ARRIVAL_LIMITS.regionCandidates);
});
test('ARRIVAL-05 collision samples include blocked water/cliff terrain and current image collision cells',()=>{
 const s=scene([start('terrain')]);s.terrain={version:1,cells:[[-1,-1,'water',true],[0,-1,'stone',true]]};
 for(let seed=0;seed<30;seed++){const p=resolveArrival(s,{entry:'terrain',seed});assert(canStand(s,p.x,p.z,ARRIVAL_LIMITS.radius));}
 const stamp='2026-10-03T00:00:00.000Z',definition={schemaVersion:1,assetId:'asset',roomId:'room',createdBy:'user',createdAt:stamp,originKind:'upload'},version={...normalizeImageAssetDraft({name:'Panel',floating:false,collisionGrid:[[0,0],[1,0]]},{width:64,height:64,byteLength:200,mediaType:'image/png'}),schemaVersion:1,assetId:'asset',roomId:'room',versionId:'v1',sequence:1,sha256:'f'.repeat(64),createdBy:'user',createdAt:stamp},entry={...validateImageDefinition(definition,version),status:'active'};
 s.objects=[{id:'image',type:'image',assetRef:{assetId:'asset',versionId:'v1'},x:0,z:0,rotation:90}];bindImageDefinitions(s,{'asset:v1':entry},'room');
 for(let seed=0;seed<30;seed++){const p=resolveArrival(s,{entry:'terrain',seed});assert(canStand(s,p.x,p.z,ARRIVAL_LIMITS.radius));}
 const unresolved=structuredClone(s);assert.throws(()=>resolveArrival(unresolved,{entry:'terrain'}),{code:'ARRIVAL_BLOCKED'});
});
test('ARRIVAL-06 sequential placement enforces .8m spacing without unbounded retries',()=>{
 const s=scene([start('busy')]),occupants=[];
 for(let seed=0;seed<10;seed++){const p=resolveArrival(s,{entry:'busy',seed,occupants});for(const other of occupants)assert(Math.hypot(p.x-other.x,p.z-other.z)>=ARRIVAL_LIMITS.spacing);occupants.push(p);}
});
test('ARRIVAL-07 teleport action schema and legacy normalization preserve entry and reject entry substitution fields',()=>{
 const action={id:'travel',type:'teleport',target:'room',entry:'cafe'};assert.equal(validateActions([action])[0],action);assert.equal(itemActions({target:'room',entry:'cafe'})[0].entry,'cafe');
 for(const bad of [{...action,entry:''},{...action,entry:'Café'},{...action,destination:{room:'room'}},{id:'message',type:'message',entry:'cafe'}])assert.throws(()=>validateActions([bad]));
});
