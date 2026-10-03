/** Three-way scene reconciliation. This module never grants edit authority.
 * Pending requests are immutable transport snapshots, independent of the draft. */
import {canonicalStringify,sceneOperationContext,applySceneOperations,hashSceneObject,hashSceneContext,hashSceneArea,hashSceneField,SCENE_OPERATION_FIELDS,sceneOperationDependencyView,hashSceneOperationDependencies,sceneOperationRequestIdentity} from './scene-operations.js';
import {collisionBoxes,contains} from './worlds.js';
import {objectFootprint,footprintInside} from './personal-area-policy.js';
import {imageDefinitions,inheritImageDefinitions} from './image-asset-context.js';
import {canLeaveArrival,overlaps} from './editor-geometry.js';
import {validateArrivalGeometry} from './arrivals.js';
import {validateTerrain,terrainCollisionBoxes} from './terrain.js';

export const jsonSnapshot=value=>JSON.parse(JSON.stringify(value));
const sceneSnapshot=scene=>inheritImageDefinitions(scene,jsonSnapshot(scene));
export const equalSceneValue=(a,b)=>canonicalStringify(a)===canonicalStringify(b);
export const targetKey=target=>['object','area'].includes(target.kind)?target.kind+':'+target.id:target.kind==='terrain'?`terrain:${target.x},${target.z}`:target.kind==='scene'?'scene:'+target.field:target.kind;
const objects=scene=>new Map((scene.objects||[]).map(item=>[item.id,item]));
const areas=scene=>new Map((scene.areas||[]).map(item=>[item.id,item]));
const cells=scene=>new Map((scene.terrain?.cells||[]).map(cell=>[`${cell[0]},${cell[1]}`,cell]));
const valueAt=(scene,change)=>change.kind==='object'?objects(scene).get(change.id)??null:change.kind==='area'?areas(scene).get(change.id)??null:change.kind==='scene'?scene[change.field]??null:cells(scene).get(`${change.x},${change.z}`)??null;

/** before values here are full values; hashing happens only at the wire edge. */
export function sceneChanges(base,mine,{version=1}={}){
 base=sceneSnapshot(base);mine=sceneSnapshot(mine);
 const changes=[],oldObjects=objects(base),newObjects=objects(mine),oldCells=cells(base),newCells=cells(mine);
 for(const id of new Set([...oldObjects.keys(),...newObjects.keys()])){const before=oldObjects.get(id)??null,after=newObjects.get(id)??null;if(!equalSceneValue(before,after))changes.push({kind:'object',id,before,after});}
 for(const key of new Set([...oldCells.keys(),...newCells.keys()])){const before=oldCells.get(key)??null,after=newCells.get(key)??null;if(!equalSceneValue(before,after)){const [x,z]=key.split(',').map(Number);changes.push({kind:'terrain',x,z,before,after});}}
 if(version===2){
  const oldAreas=areas(base),newAreas=areas(mine);
  for(const id of new Set([...oldAreas.keys(),...newAreas.keys()])){const before=oldAreas.get(id)??null,after=newAreas.get(id)??null;if(!equalSceneValue(before,after))changes.push({kind:'area',id,before,after});}
  for(const field of SCENE_OPERATION_FIELDS){const before=base[field]??null,after=mine[field]??null;if(!equalSceneValue(before,after))changes.push({kind:'scene',field,before,after});}
 }
 const contextChanged=!equalSceneValue(sceneOperationContext(base,version),sceneOperationContext(mine,version));
 const applied=applySceneOperations(base,changes),objectOrderChanged=!equalSceneValue(applied.objects.map(o=>o.id),mine.objects.map(o=>o.id)),areaOrderChanged=version===2&&!equalSceneValue((applied.areas||[]).map(a=>a.id),(mine.areas||[]).map(a=>a.id)),orderChanged=objectOrderChanged||areaOrderChanged;
 return {changes,contextChanged,orderChanged,objectOrderChanged,areaOrderChanged,legacy:contextChanged||orderChanged};
}

/** A conservative merge. Unresolved conflicts return a candidate for review,
 * never permission to replace the live draft. Identical changes converge. */
export function reconcileScenes({base,mine,server,choices={},validate=()=>null,forceReview=false,version=1}){
 base=sceneSnapshot(base);mine=sceneSnapshot(mine);server=sceneSnapshot(server);
 const delta=sceneChanges(base,mine,{version}),conflicts=[],operations=[];let dependencyProblem=null;
 const remoteContextChanged=!equalSceneValue(sceneOperationContext(base,version),sceneOperationContext(server,version));
 const localChanged=delta.changes.length||delta.legacy;
 const hasContextConflict=!!localChanged&&(remoteContextChanged||delta.legacy||forceReview)&&!equalSceneValue(base,server);
 if(hasContextConflict&&!choices.context)conflicts.push({kind:'context',key:'context',base:sceneOperationContext(base,version),mine:sceneOperationContext(mine,version),server:sceneOperationContext(server,version),reason:delta.legacy||forceReview?'Room settings, areas, import or item order require a whole-room review.':'Room settings or areas changed while you were building.'});
 if(version===2&&delta.changes.length)try{
  const dependencies=sceneOperationDependencyView(base,delta.changes,imageDefinitions(base)),current=sceneOperationDependencyView(server,delta.changes,imageDefinitions(server));
  if(!equalSceneValue(dependencies,current)&&!choices.dependencies)conflicts.push({kind:'dependencies',key:'dependencies',base:dependencies,mine:sceneOperationDependencyView(mine,delta.changes,imageDefinitions(mine)),server:current,reason:'Nearby areas, items, ground or room geometry changed. Review their combined behavior before keeping this draft.'});
 }catch(error){dependencyProblem=error.message||'The shared space could not be checked. Refresh its image definitions before reviewing.';}
 for(const change of delta.changes){
  const current=valueAt(server,change),key=targetKey(change);
  const conflict=!equalSceneValue(current,change.before)&&!equalSceneValue(current,change.after);
  if(conflict&&!choices[key])conflicts.push({...change,key,mine:change.after,base:change.before,server:current,reason:change.kind==='object'?'This item changed in both drafts.':change.kind==='area'?'This area changed in both drafts.':change.kind==='scene'?'This room setting changed in both drafts.':'This ground cell changed in both drafts.'});
  if(choices[key]==='server'||equalSceneValue(current,change.after))continue;
  operations.push({...change,before:current});
 }
 let scene=applySceneOperations(server,operations);
 if(delta.contextChanged&&(!hasContextConflict||choices.context==='mine')){
  const managed=version===2?['objects','terrain','areas',...SCENE_OPERATION_FIELDS]:['objects','terrain'];
  scene={...jsonSnapshot(sceneOperationContext(mine,version)),...Object.fromEntries(managed.filter(key=>Object.hasOwn(scene,key)).map(key=>[key,scene[key]]))};
 }
 for(const [key,changed]of [['objects',delta.objectOrderChanged],['areas',delta.areaOrderChanged]])if(changed&&(!hasContextConflict||choices.context==='mine')){const indexed=new Map(scene[key].map(item=>[item.id,item])),ordered=mine[key].map(item=>indexed.get(item.id)).filter(Boolean),included=new Set(ordered.map(item=>item.id));scene[key]=[...ordered,...scene[key].filter(item=>!included.has(item.id))];}
 if(choices.geometry==='server'||choices.dependencies==='server')scene=sceneSnapshot(server);
 const problem=choices.geometry==='server'||choices.dependencies==='server'?validate(scene,server):dependencyProblem||validate(scene,server);
 if(problem)conflicts.push({kind:'geometry',key:'geometry',base,mine,server,reason:typeof problem==='string'?problem:problem.reason});
 return {scene,conflicts,legacy:sceneChanges(server,scene,{version}).legacy,changes:delta.changes};
}

/** Recover intent after an admission change retires an unknown request. Later
 * edits (including Undo back to the old base) still express intent. Where the
 * server has advanced a pending target, compare that later edit to the submitted
 * value; unchanged server targets continue to compare against the old base. */
export function reconnectDraftReference({base,submitted,mine,server,version=1}){
 const advanced=sceneChanges(base,submitted,{version}).changes.filter(change=>!equalSceneValue(valueAt(mine,change),change.after)&&!equalSceneValue(valueAt(server,change),change.before));
 return applySceneOperations(base,advanced);
}

/** Transform local snapshots over a peer commit. If any undo/redo step is
 * ambiguous, drop the old stack rather than resurrecting somebody else's work. */
export function rebaseHistory(entries,{base,server,validate,version=1}){
 const next=[];
 for(const entry of entries){const rebased=reconcileScenes({base,mine:entry.scene,server,validate,version});if(rebased.conflicts.length)return {entries:[],invalidated:true};next.push({...entry,scene:rebased.scene});}
 return {entries:next,invalidated:false};
}

export async function createSceneOperationRequest({base,mine,baseRevision,operationId,admission,personalAreaRevisions,version=1}){
 if(![1,2].includes(version))throw new Error('Use a supported scene operation version.');
 base=sceneSnapshot(base);mine=sceneSnapshot(mine);const delta=sceneChanges(base,mine,{version});
 if(delta.legacy)throw new Error(version===2?'Unsupported room settings, imports and item/area order use the reviewed whole-room save.':'Room settings, areas and item order use the reviewed whole-room save.');
 if(delta.changes.length>(version===2?6199:6096))throw new Error('This save touches too many items, areas or ground cells. Export the draft before reducing it.');
 const operations=await Promise.all(delta.changes.map(async change=>({...change,before:change.kind==='object'?await hashSceneObject(change.before):change.kind==='area'?await hashSceneArea(change.before):change.kind==='scene'?await hashSceneField(base,change.field):change.before})));
 const request={version,operationId,baseRevision,contextHash:await hashSceneContext(base,version),...(version===2?{dependenciesHash:await hashSceneOperationDependencies(base,operations,imageDefinitions(base))}:{}),operations,...(personalAreaRevisions?{personalAreaRevisions:jsonSnapshot(personalAreaRevisions)}:{}),admission:jsonSnapshot(admission)};
 // Freeze nested data too: a retry must not pick up later edits or permissions.
 const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};return freeze(request);
}

export function conflictLabel(conflict){
 if(conflict.kind==='object')return (conflict.mine?.name||conflict.server?.name||conflict.base?.name||conflict.id)+' · '+conflict.id;
 if(conflict.kind==='area')return 'Area: '+(conflict.mine?.name||conflict.server?.name||conflict.base?.name||conflict.id)+' · '+conflict.id;
 if(conflict.kind==='dependencies')return 'Nearby areas and shared space';
 if(conflict.kind==='scene')return ({theme:'Room environment',bounds:'Room size',spawn:'Room arrival point'})[conflict.field]||'Room setting: '+conflict.field;
 if(conflict.kind==='terrain')return `Ground cell (${conflict.x}, ${conflict.z})`;
 return conflict.kind==='context'?'Room settings and areas':'Space and walking routes';
}
export function conflictValueLabel(value,kind,field){
 if(value===null)return 'Absent / deleted';
 if(kind==='dependencies')return Object.entries(value).filter(([key,entry])=>key!=='version'&&entry!==null).map(([key,entry])=>Array.isArray(entry)?`${entry.length} ${key}`:key==='bounds'?`Room: ${entry.width} × ${entry.depth} m`:key==='spawn'?`Arrival: (${entry.x}, ${entry.z})`:key).join(' · ')||'No nearby dependencies';
 if(kind==='scene')return field==='bounds'?`${value.width} × ${value.depth} m`:field==='spawn'?`(${value.x}, ${value.z})`:String(value);
 if(kind==='area')return [`${value.name||'Area'} · (${value.x}, ${value.z}) · ${value.width} × ${value.depth} m`,value.action?'On entry: '+value.action:null,value.personalArea?'Personal space: '+value.personalArea.mode:null,value.start?'Arrival: '+value.start.key+(value.start.isDefault?' (default)':''):null,value.actions?.length?'Actions: '+value.actions.map(action=>action.type).join(' → '):null].filter(Boolean).join('\n');
 if(kind==='terrain')return `${value[2]} · ${value[3]?'blocks walking':'walkable'}`;
 if(kind==='object')return [`${value.name||value.type} · (${value.x}, ${value.z}) · ${value.rotation||0}°`,value.text?'Description: '+value.text:null,value.actions?.length?'Actions: '+value.actions.map(action=>action.type).join(' → '):null,value.width||value.depth?`Size: ${value.width||'default'} × ${value.depth||'default'}`:null].filter(Boolean).join('\n');
 if(kind==='context'&&!value.bounds)return JSON.stringify(value,null,2);
 return kind==='geometry'?`${value.objects?.length||0} items · ${value.terrain?.cells?.length||0} ground cells`:`${value.bounds?.width} × ${value.bounds?.depth} m · ${value.areas?.length||0} areas · ${value.theme||'room'}`;
}

export async function sceneRequestHash(roomId,request){
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalStringify(sceneOperationRequestIdentity(roomId,request))));
 return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
}

/** Compare actual geometry, not names/actions/color. A legacy overlap is not a
 * newly introduced collider and must remain editable. Callers bind authorized
 * image definitions on both snapshots before invoking this pure check. */
export function reconciliationGeometryProblem(before,next){
 try{
  validateArrivalGeometry(next);validateTerrain(next.terrain,next.bounds);
  const old=objects(before),oldImages=imageDefinitions(before),nextImages=imageDefinitions(next);
  const entries=next.objects.map(item=>({item,box:objectFootprint(item,nextImages),cells:collisionBoxes(next,item)}));
  const blocked=terrainCollisionBoxes(next.terrain),oldBlocked=new Set((before.terrain?.cells||[]).filter(c=>c[3]).map(c=>`${c[0]},${c[1]}`));
  const newBlocked=blocked.filter(c=>!oldBlocked.has(`${c.x-.5},${c.z-.5}`));
  const boundsChanged=!equalSceneValue(before.bounds,next.bounds),spawnChanged=!equalSceneValue(before.spawn,next.spawn),roomBox={x:0,z:0,width:next.bounds.width,depth:next.bounds.depth};let introduced=!!newBlocked.length;
  for(const entry of entries){
   const {item,box,cells}=entry,prior=old.get(item.id),oldBox=prior?objectFootprint(prior,oldImages):null,oldCells=prior?collisionBoxes(before,prior):[];
   if((boundsChanged||!equalSceneValue(box,oldBox))&&!footprintInside(roomBox,box))return (item.name||item.type)+': Keep the whole item inside the room edge';
   const changed=!equalSceneValue(cells,oldCells);
   if(changed&&cells.length){
    introduced=true;
    const collision=entries.find(other=>other.item.id!==item.id&&cells.some(cell=>other.cells.some(otherCell=>overlaps(cell,otherCell))));
    if(collision)return (item.name||item.type)+': Overlaps '+(collision.item.name||collision.item.type);
    if(cells.some(cell=>blocked.some(other=>overlaps(cell,other))))return (item.name||item.type)+': Keep solid items off blocked terrain';
   }
   if((changed||spawnChanged)&&cells.some(cell=>contains(cell,next.spawn.x,next.spawn.z,.75)))return (item.name||item.type)+': Leave a clear space around the arrival point';
   if(cells.some(cell=>newBlocked.some(other=>overlaps(cell,other))))return (item.name||item.type)+': Keep solid items off blocked terrain';
  }
  for(const area of next.areas||[]){const oldArea=(before.areas||[]).find(a=>a.id===area.id),box={x:area.x,z:area.z,width:area.width,depth:area.depth},prior=oldArea?{x:oldArea.x,z:oldArea.z,width:oldArea.width,depth:oldArea.depth}:null;if((boundsChanged||!equalSceneValue(box,prior))&&!footprintInside(roomBox,box))return (area.name||'Area')+': Keep the whole area inside the room edge';}
  if(newBlocked.some(box=>contains(box,next.spawn.x,next.spawn.z,.75)))return 'Leave a clear space around the arrival point';
  if((spawnChanged||introduced&&canLeaveArrival(before))&&!canLeaveArrival(next))return 'Leave a clear walking route from the arrival point.';
  return null;
 }catch(error){return error.message;}
}
