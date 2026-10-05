import {isDeepStrictEqual} from 'node:util';
import {bindImageDefinitions} from '../src/image-asset-context.js';
import {compositionDefinitions} from '../src/composition-context.js';
import {collisionBoxes,contains} from '../src/worlds.js';
import {objectFootprint,footprintInside} from '../src/personal-area-policy.js';
import {overlaps,canLeaveArrival} from '../src/editor-geometry.js';
import {terrainCollisionBoxes} from '../src/terrain.js';

/** Validate only geometry introduced by this commit against the complete final
 * world. Existing overlaps remain editable; final-scene swaps are simultaneous. */
export function sceneOperationGeometryConflicts({store,presence,residents=[],now,room,before,next,beforeImages,nextImages}) {
 bindImageDefinitions(before,beforeImages,room.id);bindImageDefinitions(next,nextImages,room.id);
 const beforeCompositions=compositionDefinitions(before),nextCompositions=compositionDefinitions(next);
 const old=new Map(before.objects.map(object=>[object.id,object]));
 const entries=next.objects.map(object=>({object,box:objectFootprint(object,nextImages,nextCompositions),cells:collisionBoxes(next,object)}));
 const blocked=terrainCollisionBoxes(next.terrain);
 const previousBlocked=new Set((before.terrain?.cells??[]).filter(cell=>cell[3]).map(([x,z])=>`${x},${z}`));
 const newBlocked=blocked.filter(box=>!previousBlocked.has(`${box.x-.5},${box.z-.5}`));
 const conflicts=new Map(),add=target=>conflicts.set(JSON.stringify(target),target),objectTarget=object=>({kind:'object',id:object.id}),cellTarget=box=>({kind:'terrain',x:box.x-.5,z:box.z-.5});
 const boundsChanged=!isDeepStrictEqual(before.bounds,next.bounds),spawnChanged=!isDeepStrictEqual(before.spawn,next.spawn),roomBox={x:0,z:0,width:next.bounds.width,depth:next.bounds.depth};
 const boundsTarget={kind:'scene',field:'bounds'},spawnTarget={kind:'scene',field:'spawn'};
 const timestamp=now(),people=[...presence.values()].filter(person=>person.roomId===room.id&&timestamp-person.lastSeen<60000&&Number.isFinite(person.x)&&Number.isFinite(person.z)&&store.get('SELECT 1 FROM sessions WHERE user_id=? AND current_room_id=? AND expires_at>?',person.userId,room.id,timestamp)&&store.canSeeRoom(room,person.userId));
 const occupants=[...people,...residents.filter(person=>person.kind==='bot'&&person.roomId===room.id&&Number.isFinite(person.x)&&Number.isFinite(person.z))];
 if(boundsChanged&&occupants.some(person=>!footprintInside(roomBox,{x:person.x,z:person.z,width:.8,depth:.8})))add(boundsTarget);
 const introduced=[];
 for(const entry of entries){
  const {object,box,cells}=entry,prior=old.get(object.id),oldBox=prior?objectFootprint(prior,beforeImages,beforeCompositions):null,oldCells=prior?collisionBoxes(before,prior):[];
  if((boundsChanged||!isDeepStrictEqual(box,oldBox))&&!footprintInside(roomBox,box)){add(objectTarget(object));if(boundsChanged)add(boundsTarget);}
  if(spawnChanged&&cells.some(cell=>contains(cell,next.spawn.x,next.spawn.z,.75))){add(objectTarget(object));add(spawnTarget);}
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
 const oldAreas=new Map((before.areas??[]).map(area=>[area.id,area]));
 for(const area of next.areas??[]){
  const prior=oldAreas.get(area.id),box={x:area.x,z:area.z,width:area.width,depth:area.depth},oldBox=prior?{x:prior.x,z:prior.z,width:prior.width,depth:prior.depth}:null;
  if((boundsChanged||!isDeepStrictEqual(box,oldBox))&&!footprintInside(roomBox,box)){add({kind:'area',id:area.id});if(boundsChanged)add(boundsTarget);}
 }
 // An explicitly selected spawn must be usable even when the legacy spawn was
 // already trapped. Only an unchanged old route can be grandfathered.
 if((spawnChanged||(introduced.length||boundsChanged)&&canLeaveArrival(before))&&!canLeaveArrival(next)){
  for(const target of introduced)add(target);
  if(boundsChanged)add(boundsTarget);if(spawnChanged)add(spawnTarget);
 }
 return [...conflicts.values()];
}
