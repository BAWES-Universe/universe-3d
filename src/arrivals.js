// Native arrival regions use metres, not the source map editor's pixel margin.
import {canStand} from './worlds.js';
export const ENTRY_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const ARRIVAL_LIMITS = Object.freeze({radius:.35,inset:.45,spacing:.8,regionCandidates:257,spawnCandidates:257,spawnRadius:8});
const fail=(code,message,details={})=>{throw Object.assign(new Error(message),{code,...details});};
export function validateEntryKey(value){if(typeof value!=='string'||!ENTRY_KEY_RE.test(value))fail('INVALID_ENTRY','Use an arrival key of 1–64 lowercase letters, numbers, hyphens or underscores, starting with a letter or number');return value;}
export function entryCatalog(scene){return(scene.areas??[]).filter(area=>area.start).map(area=>({key:area.start.key,areaId:area.id,name:area.name,isDefault:area.start.isDefault===true}));}
export function validateStarts(scene){
 const seen=new Set();
 for(const area of scene.areas??[]){
  if(area.start===undefined)continue;
  const start=area.start;
  if(!start||typeof start!=='object'||Array.isArray(start)||Object.keys(start).some(key=>!['key','isDefault'].includes(key)))fail('INVALID_START','Arrival settings accept only key and isDefault');
  validateEntryKey(start.key);
  if(seen.has(start.key))fail('DUPLICATE_ENTRY','Arrival keys must be unique in this room');seen.add(start.key);
  if(start.isDefault!==undefined&&typeof start.isDefault!=='boolean')fail('INVALID_START','Default arrival must be true or false');
  if(![area.x,area.z,area.width,area.depth].every(Number.isFinite)||area.width<ARRIVAL_LIMITS.inset*2||area.depth<ARRIVAL_LIMITS.inset*2)fail('INVALID_START_BOUNDS','An arrival region must be at least 0.9 × 0.9 metres');
  if(Math.abs(area.x)+area.width/2>scene.bounds.width/2||Math.abs(area.z)+area.depth/2>scene.bounds.depth/2)fail('INVALID_START_BOUNDS','Keep the entire arrival region inside the room');
 }
 return scene;
}
function radicalInverse(value,base){let result=0,fraction=1/base;while(value>0){result+=(value%base)*fraction;value=Math.floor(value/base);fraction/=base;}return result;}
export function arrivalCandidates(scene,area=null){
 const result=[];
 if(area){
  const width=area.width-2*ARRIVAL_LIMITS.inset,depth=area.depth-2*ARRIVAL_LIMITS.inset;
  if(width<0||depth<0)return result;
  result.push({x:area.x,z:area.z});
  // Fixed low-discrepancy samples are shared with save validation. Bounds and work
  // are predictable, including a narrow/tiny region. A missed slot fails closed.
  for(let i=1;i<ARRIVAL_LIMITS.regionCandidates;i++)result.push({x:area.x+(radicalInverse(i,2)-.5)*width,z:area.z+(radicalInverse(i,3)-.5)*depth});
 }else{
  result.push({x:scene.spawn.x,z:scene.spawn.z});
  for(let i=1;i<ARRIVAL_LIMITS.spawnCandidates;i++){
   const radius=ARRIVAL_LIMITS.spawnRadius*Math.sqrt(i/(ARRIVAL_LIMITS.spawnCandidates-1)),angle=i*2.399963229728653;
   result.push({x:scene.spawn.x+Math.cos(angle)*radius,z:scene.spawn.z+Math.sin(angle)*radius});
  }
 }
 return result;
}
function hashSeed(seed){let n=2166136261;for(const c of String(seed)){n^=c.charCodeAt(0);n=Math.imul(n,16777619);}return n>>>0;}
/** Pure bounded placement. Caller supplies only freshly authorized occupancy and
 * binds canonical image definitions on scene before invoking this function. */
export function resolveArrival(scene,{entry,occupants=[],seed=0,validation=false}={}){
 if(entry!==undefined)validateEntryKey(entry);
 const named=entry===undefined?null:(scene.areas??[]).find(area=>area.start?.key===entry);
 const defaults=(scene.areas??[]).filter(area=>area.start?.isDefault===true);
 const areas=named?[named]:defaults.length?defaults:[null],offset=hashSeed(seed)%areas.length;
 let safeGeometry=false,attempted=0;
 for(let n=0;n<areas.length;n++){
  const area=areas[(offset+n)%areas.length],candidates=arrivalCandidates(scene,area),shift=area&&!validation?hashSeed(`${seed}:position`)%candidates.length:0;
  for(let i=0;i<candidates.length;i++){
   const point=candidates[(shift+i)%candidates.length];attempted++;
   if(!canStand(scene,point.x,point.z,ARRIVAL_LIMITS.radius))continue;
   safeGeometry=true;
   if(occupants.some(person=>Number.isFinite(person.x)&&Number.isFinite(person.z)&&Math.hypot(person.x-point.x,person.z-point.z)<ARRIVAL_LIMITS.spacing))continue;
   return {...point,requestedEntry:entry??null,entry:area?.start.key??null,areaId:area?.id??null,source:named?'named':area?'default':'spawn',fallback:entry!==undefined&&!named?'unknown-entry':null,resumed:false};
  }
 }
 fail(safeGeometry?'ARRIVAL_OCCUPIED':'ARRIVAL_BLOCKED',safeGeometry?'This arrival is crowded. Try again shortly or choose another arrival.':'This arrival has no safe landing. Ask a room editor to clear it or choose another arrival.',{entry:entry??null,attempted});
}
/** Every configured entry stays usable after any scene edit. No occupancy in
 * authoring validation: transient people must not prevent saving a valid start. */
export function validateArrivalGeometry(scene){
 validateStarts(scene);
 for(const area of scene.areas??[])if(area.start)resolveArrival(scene,{entry:area.start.key,validation:true});
 // Legacy scenes retain bounded nearby fallback, including an obstructed spawn.
 resolveArrival(scene,{validation:true});
 return scene;
}
