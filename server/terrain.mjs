import {hasRoomSession} from './public-guests.mjs';
import {isDeepStrictEqual} from 'node:util';
import {bindImageDefinitions} from '../src/image-asset-context.js';
import {canLeaveArrival} from '../src/editor-geometry.js';
import {contains,collisionBox} from '../src/worlds.js';
import {validateTerrain} from '../src/terrain.js';
import * as v from './validation.mjs';

/** Runs synchronously under the scene CAS write lock. All occupants and image
 * definitions come from current server authority, never request-body claims. */
export function validateTerrainSceneDelta({store,presence,residents=[],now,room,userId,before,next,beforeImages={},nextImages={}}){
 const terrainChanged=!isDeepStrictEqual(before.terrain,next.terrain);
 if(terrainChanged&&!store.roomCapabilities(room,userId).canEditScene)v.fail(403,'TERRAIN_FORBIDDEN','Only a full room editor can change terrain');
 try{validateTerrain(next.terrain,next.bounds);}catch(error){v.fail(400,error.code??'INVALID_TERRAIN',error.message);}
 const oldBlocked=new Set((before.terrain?.cells??[]).filter(cell=>cell[3]).map(([x,z])=>`${x},${z}`));
 const added=(next.terrain?.cells??[]).filter(([x,z,,blocked])=>blocked&&!oldBlocked.has(`${x},${z}`)).map(([x,z])=>({box:{x:x+.5,z:z+.5,width:1,depth:1},kind:'TERRAIN',details:{cell:[x,z]}}));
 const oldObjects=new Map(before.objects.map(object=>[object.id,object]));
 for(const object of next.objects){
  if(object.type!=='wall')continue;
  const box=collisionBox(object,next),old=oldObjects.get(object.id);
  if(old?.type==='wall'&&isDeepStrictEqual(box,collisionBox(old,before)))continue;
  if(![box.x,box.z,box.width,box.depth].every(Number.isFinite)||box.width<=0||box.depth<=0)v.fail(400,'INVALID_SCENE','Walls require finite coordinates and positive dimensions');
  if(Math.abs(box.x)+box.width/2>next.bounds.width/2||Math.abs(box.z)+box.depth/2>next.bounds.depth/2)v.fail(400,'WALL_OUTSIDE_ROOM','Keep the entire wall inside the room',{objectId:object.id});
  added.push({box,kind:'WALL',details:{objectId:object.id}});
 }
 if(!added.length)return;
 const timestamp=now();
 const people=[...presence.values()].filter(person=>person.roomId===room.id&&person.kind!=='bot'&&timestamp-person.lastSeen<60000
  &&Number.isFinite(person.x)&&Number.isFinite(person.z)
  &&hasRoomSession(store,person.userId,room.id,timestamp)
  &&store.canSeeRoom(room,person.userId));
 const activeResidents=residents.filter(person=>person.roomId===room.id&&person.kind==='bot'&&Number.isFinite(person.x)&&Number.isFinite(person.z));
 for(const {box,kind,details}of added){
  if(contains(box,next.spawn.x,next.spawn.z,.75))v.fail(400,`${kind}_BLOCKS_ARRIVAL`,'Leave clear space around the arrival point',details);
  if(people.some(person=>contains(box,person.x,person.z,.4)))v.fail(409,`${kind}_BLOCKS_PLAYER`,'Move this blocker away from players standing here',details);
  if(activeResidents.some(person=>contains(box,person.x,person.z,.4)))v.fail(409,`${kind}_BLOCKS_RESIDENT`,'Move this blocker away from residents standing here',details);
 }
 bindImageDefinitions(before,beforeImages,room.id);bindImageDefinitions(next,nextImages,room.id);
 if(canLeaveArrival(before)&&!canLeaveArrival(next))v.fail(400,`${added.some(value=>value.kind==='TERRAIN')?'TERRAIN':'WALL'}_BLOCKS_ROUTE`,'Leave a walking route out of the arrival point');
}
