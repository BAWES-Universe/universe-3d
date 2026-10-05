import {isDeepStrictEqual} from 'node:util';
import {resolveCompositionPlacement} from '../src/composition-geometry.js';
import {bindCompositionDefinitions} from '../src/composition-context.js';
import {canLeaveArrival,overlaps} from '../src/editor-geometry.js';
import {contains,collisionBoxes} from '../src/worlds.js';
import {terrainCollisionBoxes} from '../src/terrain.js';
import * as v from './validation.mjs';

/** Shared conservative X/Z policy: full footprint grants edits; only authored
 * collision boxes block walking. Vertical pass-under physics is not supported. */
export function validateCompositionSceneDelta({store,presence,residents=[],now,room,before,next,beforeCompositions={},nextCompositions={}}){
 bindCompositionDefinitions(before,beforeCompositions,room.id);bindCompositionDefinitions(next,nextCompositions,room.id);
 const old=new Map(before.objects.map(object=>[object.id,object]));
 const compositions=next.objects.filter(object=>object.type==='composition');
 if(!compositions.length)return;
 const placed=compositions.map(object=>({object,cells:collisionBoxes(next,object)}));
 // Reverse edits must respect existing compositions too. Restrict this extra
 // policy to newly introduced/changed colliders so legacy overlaps elsewhere
 // keep their existing behavior. Final-scene removal/moves are simultaneous.
 for(const other of next.objects){
  if(other.type==='composition')continue;
  const cells=collisionBoxes(next,other),prior=old.get(other.id),oldCells=prior?collisionBoxes(before,prior):[];
  if(!cells.length||isDeepStrictEqual(cells,oldCells))continue;
  if(placed.some(entry=>entry.cells.some(cell=>cells.some(otherCell=>overlaps(cell,otherCell)))))v.fail(409,'COMPOSITION_OVERLAP','Move this solid object away from custom furniture',{objectId:other.id});
 }
 const oldBlocked=new Set((before.terrain?.cells??[]).filter(cell=>cell[3]).map(([x,z])=>`${x},${z}`));
 for(const [x,z,,blocked]of next.terrain?.cells??[]){
  if(!blocked||oldBlocked.has(`${x},${z}`))continue;
  const box={x:x+.5,z:z+.5,width:1,depth:1};
  if(placed.some(entry=>entry.cells.some(cell=>overlaps(cell,box))))v.fail(409,'COMPOSITION_BLOCKS_TERRAIN','Keep blocked ground away from custom furniture',{cell:[x,z]});
 }
 if(!isDeepStrictEqual(before.spawn,next.spawn)&&placed.some(entry=>entry.cells.some(cell=>contains(cell,next.spawn.x,next.spawn.z,.75))))v.fail(400,'COMPOSITION_BLOCKS_ARRIVAL','Keep the arrival point clear of custom furniture');
 const changed=next.objects.filter(object=>object.type==='composition'&&(!isDeepStrictEqual(object.assetRef,old.get(object.id)?.assetRef)||['type','x','z','rotation'].some(k=>object[k]!==old.get(object.id)?.[k])));
 if(!changed.length)return;
 const timestamp=now(),people=[...presence.values()].filter(person=>person.roomId===room.id&&timestamp-person.lastSeen<60000&&Number.isFinite(person.x)&&Number.isFinite(person.z)&&store.get('SELECT 1 FROM sessions WHERE user_id=? AND current_room_id=? AND expires_at>?',person.userId,room.id,timestamp)&&store.canSeeRoom(room,person.userId));
 const occupants=[...people,...residents.filter(person=>person.kind==='bot'&&person.roomId===room.id&&Number.isFinite(person.x)&&Number.isFinite(person.z))];
 const terrain=terrainCollisionBoxes(next.terrain);let changedColliders=false;
 for(const object of changed){
  const definition=nextCompositions[`${object.assetRef.assetId}:${object.assetRef.revision}`],cells=resolveCompositionPlacement(definition,object).collisionCells;
  changedColliders ||= cells.length>0;
  if(cells.some(cell=>contains(cell,next.spawn.x,next.spawn.z,.75)))v.fail(400,'COMPOSITION_BLOCKS_ARRIVAL','Leave clear space around the arrival point',{objectId:object.id});
  if(cells.some(cell=>occupants.some(person=>contains(cell,person.x,person.z,.4))))v.fail(409,'COMPOSITION_BLOCKS_OCCUPANT','Move this furniture away from players and residents standing here',{objectId:object.id});
  if(cells.some(cell=>terrain.some(other=>overlaps(cell,other))))v.fail(409,'COMPOSITION_BLOCKS_TERRAIN','Move this furniture away from blocked ground',{objectId:object.id});
  if(next.objects.some(other=>other.id!==object.id&&cells.some(cell=>collisionBoxes(next,other).some(otherCell=>overlaps(cell,otherCell)))))v.fail(409,'COMPOSITION_OVERLAP','Move this furniture away from other solid objects',{objectId:object.id});
 }
 if(changedColliders&&canLeaveArrival(before)&&!canLeaveArrival(next))v.fail(400,'COMPOSITION_BLOCKS_ROUTE','Leave a walking route out of the arrival point');
}
