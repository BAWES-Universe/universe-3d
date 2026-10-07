import {collisionBox} from './worlds.js';

const EPSILON=1e-8;
const clean=value=>Math.round(value*1e10)/1e10;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));

function wallAxis(item){
 if(item?.type!=='wall'||![item.x,item.z,item.rotation??0].every(Number.isFinite))return null;
 const turn=(item.rotation??0)/90;
 if(Math.abs(turn-Math.round(turn))>EPSILON)return null;
 const box=collisionBox(item);
 if(![box.width,box.depth].every(value=>Number.isFinite(value)&&value>0))return null;
 return {box,vertical:Math.abs(Math.round(turn)%2)===1};
}

// Propose only exact touching faces. Walls remain ordinary independent objects:
// no overlap exception, saved join metadata, peer mutation or invisible filler.
// The editor must still validate each candidate against the entire current scene.
export function wallSnapCandidates(scene,item,{excludeId=item?.id,tolerance=.6}={}){
 const axis=wallAxis(item);if(!axis||!Number.isFinite(tolerance)||tolerance<0)return [];
 const {box,vertical}=axis,candidates=[],seen=new Set();
 const add=(x,z,target,kind)=>{
  x=clean(x);z=clean(z);const distance=Math.hypot(x-item.x,z-item.z);
  if(distance>tolerance+EPSILON)return;
  const key=x+','+z+','+(target.id??'');if(seen.has(key))return;seen.add(key);
  candidates.push({item:{...item,x,z},targetId:target.id??null,kind,distance});
 };
 for(const target of scene?.objects||[]){
  if(target===item||excludeId!=null&&target.id===excludeId)continue;
  const other=wallAxis(target);if(!other)continue;const b=other.box;
  if(vertical===other.vertical){
   // Collinear ends, never snap two parallel walls side-by-side.
   if(vertical)for(const sign of [-1,1])add(b.x,b.z+sign*(b.depth+box.depth)/2,target,'straight');
   else for(const sign of [-1,1])add(b.x+sign*(b.width+box.width)/2,b.z,target,'straight');
   continue;
  }
  if(vertical){
   // This wall's end meets the other wall's long face, including L and T joins.
   if(b.width+EPSILON>=box.width)for(const sign of [-1,1])add(clamp(box.x,b.x-(b.width-box.width)/2,b.x+(b.width-box.width)/2),b.z+sign*(b.depth+box.depth)/2,target,'corner');
   // The other wall's end may instead meet this wall's long face.
   if(box.depth+EPSILON>=b.depth)for(const sign of [-1,1])add(b.x+sign*(b.width+box.width)/2,clamp(box.z,b.z-(box.depth-b.depth)/2,b.z+(box.depth-b.depth)/2),target,'corner');
  }else{
   if(b.depth+EPSILON>=box.depth)for(const sign of [-1,1])add(b.x+sign*(b.width+box.width)/2,clamp(box.z,b.z-(b.depth-box.depth)/2,b.z+(b.depth-box.depth)/2),target,'corner');
   if(box.width+EPSILON>=b.width)for(const sign of [-1,1])add(clamp(box.x,b.x-(box.width-b.width)/2,b.x+(box.width-b.width)/2),b.z+sign*(b.depth+box.depth)/2,target,'corner');
  }
 }
 // Stable ties are geometric, independent of remote scene object ordering.
 return candidates.sort((a,b)=>clean(a.distance)-clean(b.distance)||a.item.x-b.item.x||a.item.z-b.item.z||String(a.targetId).localeCompare(String(b.targetId)));
}
