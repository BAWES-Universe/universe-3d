import {screenDirection} from './motion.js';
import {CATALOG,collisionBox,collisionBoxes,contains,canStand} from './worlds.js';

import {applyTerrainRect,validateTerrain,terrainCollisionBoxes} from './terrain.js';

import {inheritImageDefinitions} from './image-asset-context.js';

export function snapPoint(point,step=1){
 if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.z))return null;
 return {x:Math.round(point.x/step)*step,z:Math.round(point.z/step)*step};
}
export function footprint(item,scene){return item.type&&item.type!=='area'?collisionBox(item,scene):{x:item.x,z:item.z,width:item.width||4,depth:item.depth||4};}
export function overlaps(a,b,padding=-.00001){return Math.abs(a.x-b.x)<(a.width+b.width)/2+padding&&Math.abs(a.z-b.z)<(a.depth+b.depth)/2+padding;}
// A cheap local flood protects the arrival from being boxed in by the last wall.
export function canLeaveArrival(scene){
 const start=scene.spawn;if(!start||!canStand(scene,start.x,start.z,.34))return false;
 const queue=[{x:0,z:0}],seen=new Set(['0,0']);
 for(let i=0;i<queue.length&&i<169;i++){
  const p=queue[i];if(Math.max(Math.abs(p.x),Math.abs(p.z))>=5)return true;
  for(const [dx,dz]of [[1,0],[-1,0],[0,1],[0,-1]]){const x=p.x+dx,z=p.z+dz,key=x+','+z;if(seen.has(key))continue;seen.add(key);if(canStand(scene,start.x+x*.5,start.z+z*.5,.34))queue.push({x,z});}
 }
 return false;
}
export function validatePlacement(scene,item,{excludeId=item.id,position=null}={}){
 if(!scene?.bounds)return {valid:false,reason:'Open a room to start building'};
 let box;try{box=footprint(item,scene);}catch{return {valid:false,reason:'This custom asset revision is unavailable. Refresh the library'};}
 if(![box.x,box.z,box.width,box.depth].every(Number.isFinite)||box.width<=0||box.depth<=0)return {valid:false,reason:'Use a positive size and valid coordinates'};
 if(Math.abs(box.x)+box.width/2>scene.bounds.width/2+.001||Math.abs(box.z)+box.depth/2>scene.bounds.depth/2+.001)return {valid:false,reason:'Keep the whole item inside the room edge'};
 const isArea=!item.type||item.type==='area';
 if(isArea){if(!excludeId&&scene.areas.length>=100)return {valid:false,reason:'This room already has 100 areas'};return {valid:true,reason:'Areas may overlap furniture and each other'};}
 if(!CATALOG[item.type]&&item.type!=='image'&&item.type!=='composition')return {valid:false,reason:'Choose an item from the furniture tray'};
 if(!excludeId&&scene.objects.length>=2000)return {valid:false,reason:'This room already has 2,000 items'};
 let cells;try{cells=collisionBoxes(scene,item);}catch{return {valid:false,reason:'Resolve this custom asset revision before placing it'};}if(!cells.length)return {valid:true,reason:item.type==='rug'?'Rugs can go underneath furniture':'Ready to place'};
 let collision;try{collision=scene.objects.find(o=>o.id!==excludeId&&collisionBoxes(scene,o).some(other=>cells.some(cell=>overlaps(cell,other))));}catch{return {valid:false,reason:'Resolve every custom asset revision before editing this scene'};}
 if(collision)return {valid:false,reason:'Overlaps '+(collision.name||CATALOG[collision.type]?.name||'another item')};
 if(terrainCollisionBoxes(scene.terrain).some(other=>cells.some(cell=>overlaps(cell,other))))return {valid:false,reason:'Keep solid items off blocked terrain'};
 if(scene.spawn&&cells.some(cell=>contains(cell,scene.spawn.x,scene.spawn.z,.75)))return {valid:false,reason:'Leave a clear space around the arrival point'};
 if(position&&cells.some(cell=>contains(cell,position.x,position.z,.4)))return {valid:false,reason:'Move this away from where you’re standing'};
 if(scene.spawn&&Math.abs(box.x-scene.spawn.x)<box.width/2+3&&Math.abs(box.z-scene.spawn.z)<box.depth/2+3){
  const next=inheritImageDefinitions(scene,{...scene,objects:[...scene.objects.filter(o=>o.id!==excludeId),item]});
  if(canLeaveArrival(scene)&&!canLeaveArrival(next))return {valid:false,reason:'Leave a walking route out of the arrival point'};
 }
 return {valid:true,reason:'Ready to place'};
}

export function screenGridStep(key,angle,step=1){const dir=screenDirection({x:key==='arrowright'?1:key==='arrowleft'?-1:0,z:key==='arrowdown'?1:key==='arrowup'?-1:0},angle);return{x:Math.round(dir.x)*step,z:Math.round(dir.z)*step};}

// A stroke is a pure preview until the editor commits its resulting terrain once.
export function validateTerrainEdit(scene,rect,options,{position=null}={}){
 if(!scene?.bounds)return {valid:false,reason:'Open a room to start building'};
 let terrain;try{terrain=applyTerrainRect(scene.terrain,rect,options);validateTerrain(terrain,scene.bounds);}catch(error){return {valid:false,reason:error.message||'This terrain stroke is outside the room or cell budget'};}
 const previous=new Set((scene.terrain?.cells||[]).filter(cell=>cell[3]).map(cell=>cell[0]+','+cell[1]));
 const blockers=terrainCollisionBoxes(terrain).filter(box=>!previous.has((box.x-.5)+','+(box.z-.5)));
 if(scene.spawn&&blockers.some(box=>contains(box,scene.spawn.x,scene.spawn.z,.75)))return {valid:false,reason:'Leave a clear space around the arrival point'};
 if(position&&blockers.some(box=>contains(box,position.x,position.z,.4)))return {valid:false,reason:'Move this away from where you’re standing'};
 if(blockers.length){
  let collision;try{collision=scene.objects.find(object=>collisionBoxes(scene,object).some(cell=>blockers.some(box=>overlaps(cell,box))));}catch{return {valid:false,reason:'Resolve every custom asset revision before editing this scene'};}
  if(collision)return {valid:false,reason:'Overlaps '+(collision.name||CATALOG[collision.type]?.name||'another item')};
 }
 const next=inheritImageDefinitions(scene,{...scene,terrain});
 if(blockers.length&&canLeaveArrival(scene)&&!canLeaveArrival(next))return {valid:false,reason:'Leave a walking route out of the arrival point'};
 return {valid:true,reason:options.erase?'Restore the original ground':options.blocked?'Blocks walking':'Walkable terrain',terrain};
}

// Draw walls with the same object geometry, IDs, transforms and undo as furniture.
export function wallFromStroke(from,to,rotation=0){
 const start=snapPoint(from),end=snapPoint(to);if(!start||!end)return null;
 const dx=end.x-start.x,dz=end.z-start.z,vertical=Math.abs(dz)>Math.abs(dx)||(dx===0&&dz===0&&rotation%180===90);
 return {type:'wall',name:'Wall',x:vertical?start.x:(start.x+end.x)/2,z:vertical?(start.z+end.z)/2:start.z,width:Math.max(1,Math.abs(vertical?dz:dx)),depth:.3,rotation:vertical?90:0};
}
