import {isDeepStrictEqual} from 'node:util';
import {bindImageDefinitions} from '../src/image-asset-context.js';
import {collisionBoxes,contains} from '../src/worlds.js';
import {objectFootprint} from '../src/personal-area-policy.js';
import {overlaps,canLeaveArrival} from '../src/editor-geometry.js';
import {terrainCollisionBoxes} from '../src/terrain.js';

/** Validate only geometry introduced by this commit against the complete final
 * world. Existing overlaps remain editable; final-scene swaps are simultaneous. */
export function sceneOperationGeometryConflicts({store,presence,residents=[],now,room,before,next,beforeImages,nextImages}) {
 bindImageDefinitions(before,beforeImages,room.id);bindImageDefinitions(next,nextImages,room.id);
 const old=new Map(before.objects.map(object=>[object.id,object]));
 const entries=next.objects.map(object=>({object,box:objectFootprint(object,nextImages),cells:collisionBoxes(next,object)}));
 const blocked=terrainCollisionBoxes(next.terrain);
 const previousBlocked=new Set((before.terrain?.cells??[]).filter(cell=>cell[3]).map(([x,z])=>`${x},${z}`));
 const newBlocked=blocked.filter(box=>!previousBlocked.has(`${box.x-.5},${box.z-.5}`));
 const conflicts=new Map(),add=target=>conflicts.set(JSON.stringify(target),target),objectTarget=object=>({kind:'object',id:object.id}),cellTarget=box=>({kind:'terrain',x:box.x-.5,z:box.z-.5});
 const timestamp=now(),people=[...presence.values()].filter(person=>person.roomId===room.id&&timestamp-person.lastSeen<60000&&Number.isFinite(person.x)&&Number.isFinite(person.z)&&store.get('SELECT 1 FROM sessions WHERE user_id=? AND current_room_id=? AND expires_at>?',person.userId,room.id,timestamp)&&store.canSeeRoom(room,person.userId));
 const occupants=[...people,...residents.filter(person=>person.kind==='bot'&&person.roomId===room.id&&Number.isFinite(person.x)&&Number.isFinite(person.z))];
 const introduced=[];
 for(const entry of entries){
  const {object,box,cells}=entry,prior=old.get(object.id),oldBox=prior?objectFootprint(prior,beforeImages):null,oldCells=prior?collisionBoxes(before,prior):[];
  if(!isDeepStrictEqual(box,oldBox)&&(![box.x,box.z,box.width,box.depth].every(Number.isFinite)||box.width<=0||box.depth<=0||Math.abs(box.x)+box.width/2>next.bounds.width/2+1e-8||Math.abs(box.z)+box.depth/2>next.bounds.depth/2+1e-8))add(objectTarget(object));
  if(isDeepStrictEqual(cells,oldCells)||!cells.length)continue;
  introduced.push(objectTarget(object));
  for(const other of entries)if(other.object.id!==object.id&&cells.some(cell=>other.cells.some(otherCell=>overlaps(cell,otherCell)))){add(objectTarget(object));add(objectTarget(other.object));}
  for(const other of blocked)if(cells.some(cell=>overlaps(cell,other))){add(objectTarget(object));add(cellTarget(other));}
  if(cells.some(cell=>contains(cell,next.spawn.x,next.spawn.z,.75)||occupants.some(person=>contains(cell,person.x,person.z,.4))))add(objectTarget(object));
 }
 for(const box of newBlocked){
  introduced.push(cellTarget(box));
  for(const entry of entries)if(entry.cells.some(cell=>overlaps(box,cell))){add(cellTarget(box));add(objectTarget(entry.object));}
 }
 if(introduced.length&&canLeaveArrival(before)&&!canLeaveArrival(next))for(const target of introduced)add(target);
 return [...conflicts.values()];
}
