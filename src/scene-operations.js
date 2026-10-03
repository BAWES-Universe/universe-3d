import {TERRAIN_MATERIALS} from './terrain.js';
import {objectFootprint} from './personal-area-policy.js';
import {imageDefinitions} from './image-asset-context.js';

export const SCENE_OPERATION_VERSION = 1;
export const SCENE_OPERATION_VERSION_V2 = 2;
export const SCENE_OPERATION_FIELDS = Object.freeze(['theme','bounds','spawn']);
export const MAX_SCENE_OPERATION_TARGETS = 6096;
export const MAX_SCENE_OPERATION_TARGETS_V2 = 6199;
const idPattern = /^[A-Za-z0-9_-]{1,80}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (message, code = 'INVALID_SCENE_OPERATIONS') => {const error = new Error(message);error.code = code;throw error;};
const exact = (value, keys, label) => {
 if(!record(value)||Object.keys(value).some(key=>!keys.includes(key)))invalid(`Invalid ${label} fields`);
};
const validId = value => typeof value === 'string' && idPattern.test(value);

/** Canonical JSON only: sorted record keys; array order is semantically significant.
 * The bounded traversal also rejects unsupported values before hashing. */
export function canonicalStringify(value) {
 let count=0;
 const visit=(item,depth)=>{
  if(++count>150000||depth>24)invalid('Data structure is too complex');
  if(item===null||typeof item==='boolean'||typeof item==='string')return JSON.stringify(item);
  if(typeof item==='number'&&Number.isFinite(item))return JSON.stringify(item);
  if(Array.isArray(item))return '['+item.map(child=>visit(child,depth+1)).join(',')+']';
  if(record(item))return '{'+Object.keys(item).sort().map(key=>{
   if(['__proto__','constructor','prototype'].includes(key))invalid('Unsafe object key');
   return JSON.stringify(key)+':'+visit(item[key],depth+1);
  }).join(',')+'}';
  invalid('Only JSON values can be canonicalized');
 };
 return visit(value,0);
}
export function sceneOperationContext(scene,version=1) {
 return Object.fromEntries(Object.entries(scene).filter(([key])=>key!=='objects'&&key!=='terrain'&&(version!==2||key!=='areas'&&!SCENE_OPERATION_FIELDS.includes(key))));
}
async function hash(value) {
 const bytes=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalStringify(value)));
 return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export const hashSceneObject = object => object===null ? Promise.resolve(null) : hash(object);
export const hashSceneArea = hashSceneObject;
export const hashSceneField = (scene,field) => Object.hasOwn(scene,field) ? hash(scene[field]) : Promise.resolve(null);
export const hashSceneContext = (scene,version=1) => hash(sceneOperationContext(scene,version));

/** Conservative spatial read set. Order is significant for areas and objects;
 * touching edges count so newly overlapping policy cannot slip past a stale edit.
 * Definitions are resolved projection data, never client-authored scene fields. */
export function sceneOperationDependencyView(scene,operations,definitions=imageDefinitions(scene)) {
 const structural=operations.some(operation=>operation.kind!=='scene'||operation.field!=='theme');
 const view={version:1,bounds:structural?scene.bounds:null,spawn:structural?scene.spawn:null,areas:[],objects:[],terrain:[]};
 if(!structural)return view;
 const objectIds=new Set(operations.filter(operation=>operation.kind==='object').map(operation=>operation.id));
 const areaIds=new Set(operations.filter(operation=>operation.kind==='area').map(operation=>operation.id));
 const cellIds=new Set(operations.filter(operation=>operation.kind==='terrain').map(operation=>`${operation.x},${operation.z}`));
 const objects=new Map(scene.objects.map(object=>[object.id,object])),areas=new Map((scene.areas??[]).map(area=>[area.id,area]));
 const wide=operations.some(operation=>operation.kind==='scene'&&['bounds','spawn'].includes(operation.field)),regions=[],areaRegions=[],mediaGroups=new Set();
 const mediaGroup=area=>['meeting','stage','audience'].includes(area.action)?area.meetingName||area.id:null;
 const box=value=>{
  if(!value||![value.x,value.z,value.width,value.depth].every(Number.isFinite)||value.width<=0||value.depth<=0)invalid('Resolve valid geometry before building scene dependencies','SCENE_DEPENDENCY_GEOMETRY');
  return {x:value.x,z:value.z,width:value.width,depth:value.depth};
 };
 const footprint=object=>box(objectFootprint(object,definitions));
 const touches=(a,b)=>Math.abs(a.x-b.x)<=(a.width+b.width)/2+1e-8&&Math.abs(a.z-b.z)<=(a.depth+b.depth)/2+1e-8;
 for(const operation of operations){
  if(operation.kind==='area')for(const area of [areas.get(operation.id),operation.after].filter(Boolean)){const region=box(area);regions.push(region);areaRegions.push(region);const group=mediaGroup(area);if(group!==null)mediaGroups.add(group);}
  else if(operation.kind==='object')for(const object of [objects.get(operation.id),operation.after].filter(Boolean))regions.push(footprint(object));
  else if(operation.kind==='terrain')regions.push(box({x:operation.x+.5,z:operation.z+.5,width:1,depth:1}));
 }
 for(const area of scene.areas??[])if(!areaIds.has(area.id)&&(wide||mediaGroups.has(mediaGroup(area))||regions.some(region=>touches(region,box(area)))))view.areas.push(area);
 if(wide||areaRegions.length){
  for(const object of scene.objects)if(!objectIds.has(object.id)&&(wide||areaRegions.some(region=>touches(region,footprint(object)))))view.objects.push(object);
  for(const cell of scene.terrain?.cells??[])if(!cellIds.has(`${cell[0]},${cell[1]}`)&&(wide||areaRegions.some(region=>touches(region,{x:cell[0]+.5,z:cell[1]+.5,width:1,depth:1}))))view.terrain.push(cell);
  view.terrain.sort((a,b)=>a[1]-b[1]||a[0]-b[0]);
 }
 return view;
}
export const hashSceneOperationDependencies = (scene,operations,definitions=imageDefinitions(scene)) => hash(sceneOperationDependencyView(scene,operations,definitions));

export function sceneOperationTargets(operations) {
 return operations.map(operation=>operation.kind==='object'||operation.kind==='area'?{kind:operation.kind,id:operation.id}:operation.kind==='scene'?{kind:'scene',field:operation.field}:{kind:'terrain',x:operation.x,z:operation.z});
}

/** Immutable identity of a requested commit; admission is a replaceable transport
 * fence and is deliberately excluded. Absent personal revisions normalize null. */
export function sceneOperationRequestIdentity(roomId,batch) {
 return {roomId,version:batch.version,baseRevision:batch.baseRevision,contextHash:batch.contextHash,
  operations:batch.operations,personalAreaRevisions:batch.personalAreaRevisions??null,...(batch.version===2?{dependenciesHash:batch.dependenciesHash}:{})};
}
export function validateSceneOperationBatch(batch) {
 exact(batch,['version','operationId','baseRevision','contextHash','operations','personalAreaRevisions','admission',...(batch?.version===2?['dependenciesHash']:[])],'operation batch');
 if(batch.version!==1&&batch.version!==2)invalid('Use scene operation version 1 or 2');
 if(!validId(batch.operationId))invalid('Use a valid operation ID');
 if(!Number.isSafeInteger(batch.baseRevision)||batch.baseRevision<0)invalid('Use a nonnegative base revision');
 if(typeof batch.contextHash!=='string'||!hashPattern.test(batch.contextHash))invalid('Use a canonical SHA-256 context hash');
 if(batch.version===2&&(typeof batch.dependenciesHash!=='string'||!hashPattern.test(batch.dependenciesHash)))invalid('Use a canonical SHA-256 dependencies hash');
 const limit=batch.version===2?MAX_SCENE_OPERATION_TARGETS_V2:MAX_SCENE_OPERATION_TARGETS;
 if(!Array.isArray(batch.operations)||!batch.operations.length||batch.operations.length>limit)invalid(`Use 1–${limit} operation targets`);
 exact(batch.admission,['admissionId','admissionEpoch','admissionRevision'],'admission');
 if(!validId(batch.admission.admissionId)||!validId(batch.admission.admissionEpoch)||!Number.isSafeInteger(batch.admission.admissionRevision)||batch.admission.admissionRevision<1)invalid('Use the current joined admission');
 if(batch.personalAreaRevisions!==undefined){
  if(!record(batch.personalAreaRevisions)||Object.entries(batch.personalAreaRevisions).some(([id,revision])=>!validId(id)||!Number.isSafeInteger(revision)||revision<0))invalid('Invalid personal-area revisions');
 }
 let objects=0,terrain=0,areas=0;const seen=new Set();
 for(const operation of batch.operations){
  if(!record(operation))invalid('Each operation must be an object');
  let target;
  if(operation.kind==='object'||batch.version===2&&operation.kind==='area'){
   exact(operation,['kind','id','before','after'],`${operation.kind} operation`);
   if(!validId(operation.id)||operation.before!==null&&(typeof operation.before!=='string'||!hashPattern.test(operation.before)))invalid(`Invalid ${operation.kind} precondition`);
   if(operation.after!==null&&(!record(operation.after)||operation.after.id!==operation.id))invalid(`An ${operation.kind} replacement must retain its target ID`);
   if(operation.before===null&&operation.after===null)invalid(`An absent ${operation.kind} cannot be deleted`);
   target=`${operation.kind}:${operation.id}`;if(operation.kind==='object')objects++;else areas++;
  }else if(batch.version===2&&operation.kind==='scene'){
   exact(operation,['kind','field','before','after'],'scene field operation');
   if(!SCENE_OPERATION_FIELDS.includes(operation.field))invalid('Use an explicitly supported scene field');
   if(operation.before!==null&&(typeof operation.before!=='string'||!hashPattern.test(operation.before)))invalid('Invalid scene field precondition');
   if(operation.after===undefined||operation.after===null&&(operation.field!=='theme'||operation.before===null))invalid('Only an existing optional theme can be removed');
   if(operation.after!==null&&(operation.field==='theme'?typeof operation.after!=='string':!record(operation.after)))invalid('Use the complete scene field value');
   target=`scene:${operation.field}`;
  }else if(operation.kind==='terrain'){
   exact(operation,['kind','x','z','before','after'],'terrain operation');
   if(!Number.isSafeInteger(operation.x)||!Number.isSafeInteger(operation.z))invalid('Use integer terrain coordinates');
   for(const cell of [operation.before,operation.after])if(cell!==null&&(!Array.isArray(cell)||cell.length!==4||cell[0]!==operation.x||cell[1]!==operation.z||!TERRAIN_MATERIALS.includes(cell[2])||typeof cell[3]!=='boolean'))invalid('Terrain values must match their target coordinate');
   if(canonicalStringify(operation.before)===canonicalStringify(operation.after))invalid('Terrain operations must change a cell');
   target=`terrain:${operation.x},${operation.z}`;terrain++;
  }else invalid('Unknown operation kind');
  if(seen.has(target))invalid('Each target may appear only once','DUPLICATE_SCENE_TARGET');
  seen.add(target);
 }
 if(objects>2000||terrain>4096||areas>100)invalid('Use at most 2000 object, 4096 terrain and 100 area targets');
 canonicalStringify(batch);
 return batch;
}

/** Hash-neutral merge. Callers validate preconditions against the current scene.
 * Objects retain order; additions append in the declared operation order. */
export function applySceneOperations(scene,operations) {
 const next=structuredClone(scene),objects=new Map(operations.filter(operation=>operation.kind==='object').map(operation=>[operation.id,operation]));
 const existing=new Set(next.objects.map(object=>object.id));
 next.objects=next.objects.flatMap(object=>objects.has(object.id)?objects.get(object.id).after===null?[]:[structuredClone(objects.get(object.id).after)]:[object]);
 for(const operation of operations)if(operation.kind==='object'&&!existing.has(operation.id)&&operation.after!==null)next.objects.push(structuredClone(operation.after));
 const areaOperations=operations.filter(operation=>operation.kind==='area');
 if(areaOperations.length){
  const areas=new Map(areaOperations.map(operation=>[operation.id,operation])),existingAreas=new Set((next.areas??[]).map(area=>area.id));
  next.areas=(next.areas??[]).flatMap(area=>areas.has(area.id)?areas.get(area.id).after===null?[]:[structuredClone(areas.get(area.id).after)]:[area]);
  for(const operation of areaOperations)if(!existingAreas.has(operation.id)&&operation.after!==null)next.areas.push(structuredClone(operation.after));
 }
 for(const operation of operations)if(operation.kind==='scene'){if(operation.after===null)delete next[operation.field];else next[operation.field]=structuredClone(operation.after);}
 const terrain=operations.filter(operation=>operation.kind==='terrain');
 if(terrain.length){
  const cells=new Map((next.terrain?.cells??[]).map(cell=>[`${cell[0]},${cell[1]}`,cell]));
  for(const operation of terrain){const key=`${operation.x},${operation.z}`;if(operation.after===null)cells.delete(key);else cells.set(key,structuredClone(operation.after));}
  next.terrain={version:1,cells:[...cells.values()].sort((a,b)=>a[1]-b[1]||a[0]-b[0])};
 }
 return next;
}
