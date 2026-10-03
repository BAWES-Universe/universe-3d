import {TERRAIN_MATERIALS} from './terrain.js';

export const SCENE_OPERATION_VERSION = 1;
export const MAX_SCENE_OPERATION_TARGETS = 6096;
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
export function sceneOperationContext(scene) {
 return Object.fromEntries(Object.entries(scene).filter(([key])=>key!=='objects'&&key!=='terrain'));
}
async function hash(value) {
 const bytes=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalStringify(value)));
 return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export const hashSceneObject = object => object===null ? Promise.resolve(null) : hash(object);
export const hashSceneContext = scene => hash(sceneOperationContext(scene));

export function sceneOperationTargets(operations) {
 return operations.map(operation=>operation.kind==='object'?{kind:'object',id:operation.id}:{kind:'terrain',x:operation.x,z:operation.z});
}

/** Immutable identity of a requested commit; admission is a replaceable transport
 * fence and is deliberately excluded. Absent personal revisions normalize null. */
export function sceneOperationRequestIdentity(roomId,batch) {
 return {roomId,version:batch.version,baseRevision:batch.baseRevision,contextHash:batch.contextHash,
  operations:batch.operations,personalAreaRevisions:batch.personalAreaRevisions??null};
}
export function validateSceneOperationBatch(batch) {
 exact(batch,['version','operationId','baseRevision','contextHash','operations','personalAreaRevisions','admission'],'operation batch');
 if(batch.version!==1)invalid('Use scene operation version 1');
 if(!validId(batch.operationId))invalid('Use a valid operation ID');
 if(!Number.isSafeInteger(batch.baseRevision)||batch.baseRevision<0)invalid('Use a nonnegative base revision');
 if(typeof batch.contextHash!=='string'||!hashPattern.test(batch.contextHash))invalid('Use a canonical SHA-256 context hash');
 if(!Array.isArray(batch.operations)||!batch.operations.length||batch.operations.length>MAX_SCENE_OPERATION_TARGETS)invalid('Use 1–6096 operation targets');
 exact(batch.admission,['admissionId','admissionEpoch','admissionRevision'],'admission');
 if(!validId(batch.admission.admissionId)||!validId(batch.admission.admissionEpoch)||!Number.isSafeInteger(batch.admission.admissionRevision)||batch.admission.admissionRevision<1)invalid('Use the current joined admission');
 if(batch.personalAreaRevisions!==undefined){
  if(!record(batch.personalAreaRevisions)||Object.entries(batch.personalAreaRevisions).some(([id,revision])=>!validId(id)||!Number.isSafeInteger(revision)||revision<0))invalid('Invalid personal-area revisions');
 }
 let objects=0,terrain=0;const seen=new Set();
 for(const operation of batch.operations){
  if(!record(operation))invalid('Each operation must be an object');
  let target;
  if(operation.kind==='object'){
   exact(operation,['kind','id','before','after'],'object operation');
   if(!validId(operation.id)||operation.before!==null&&(typeof operation.before!=='string'||!hashPattern.test(operation.before)))invalid('Invalid object precondition');
   if(operation.after!==null&&(!record(operation.after)||operation.after.id!==operation.id))invalid('An object replacement must retain its target ID');
   if(operation.before===null&&operation.after===null)invalid('An absent object cannot be deleted');
   target=`object:${operation.id}`;objects++;
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
 if(objects>2000||terrain>4096)invalid('Use at most 2000 object and 4096 terrain targets');
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
 const terrain=operations.filter(operation=>operation.kind==='terrain');
 if(terrain.length){
  const cells=new Map((next.terrain?.cells??[]).map(cell=>[`${cell[0]},${cell[1]}`,cell]));
  for(const operation of terrain){const key=`${operation.x},${operation.z}`;if(operation.after===null)cells.delete(key);else cells.set(key,structuredClone(operation.after));}
  next.terrain={version:1,cells:[...cells.values()].sort((a,b)=>a[1]-b[1]||a[0]-b[0])};
 }
 return next;
}
