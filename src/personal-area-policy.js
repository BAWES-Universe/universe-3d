// Shared geometry only. Ownership and permission are always decided by the server.
import {CATALOG} from './worlds.js';
export function objectFootprint(object){
  const spec=CATALOG[object?.type];if(!spec)return null;
  // The renderer/collision model uses width/depth and does not apply scale.
  // Never let an inert client scale shrink an authoritative footprint.
  const declaredWidth=object.width??spec.width,declaredDepth=object.depth??spec.depth;
  if(typeof declaredWidth!=='number'||typeof declaredDepth!=='number')return null;
  // Some procedural models have fixed-size parts independent of width/depth.
  // A client cannot shrink its authorization footprint below the catalogue size.
  const width=Math.max(spec.width,declaredWidth),depth=Math.max(spec.depth,declaredDepth);
  const radians=(object.rotation??0)*Math.PI/180,c=Math.abs(Math.cos(radians)),s=Math.abs(Math.sin(radians));
  return{x:object.x,z:object.z,width:width*c+depth*s,depth:width*s+depth*c};
}
export function footprintInside(area,box){return !!box&&[box.x,box.z,box.width,box.depth].every(Number.isFinite)&&box.width>0&&box.depth>0&&Math.abs(box.x-area.x)+box.width/2<=area.width/2+1e-8&&Math.abs(box.z-area.z)+box.depth/2<=area.depth/2+1e-8;}
export function footprintsOverlap(a,b){return !!a&&!!b&&Math.abs(a.x-b.x)<(a.width+b.width)/2-1e-8&&Math.abs(a.z-b.z)<(a.depth+b.depth)/2-1e-8;}
export function editablePersonalArea(areas,object,userId){
  const box=objectFootprint(object);if(!box)return null;
  if(areas.some(a=>a.ownerId&&a.ownerId!==userId&&footprintsOverlap(a,box)))return null;
  return areas.find(a=>a.ownerId===userId&&a.canEditObjects!==false&&footprintInside(a,box))??null;
}
export function canEditPersonalObject(room,object,userId){return !!room?.capabilities?.canEditScene||!!editablePersonalArea(room?.personalAreas??[],object,userId);}
