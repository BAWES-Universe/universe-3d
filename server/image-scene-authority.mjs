import {imageCollisionCells} from '../src/image-asset-geometry.js';
import {validateImageInstance} from '../src/image-asset-schema.js';
import {bindImageDefinitions} from '../src/image-asset-context.js';
import {canLeaveArrival} from '../src/editor-geometry.js';
import {contains} from '../src/worlds.js';
import * as v from './validation.mjs';

function geometryIdentity(object){
  if(object?.type!=='image')return null;
  const image=validateImageInstance(object);
  return JSON.stringify([image.assetRef.assetId,image.assetRef.versionId,image.x,image.z,image.rotation]);
}

/** Called synchronously inside the scene CAS using only DB-resolved metadata. */
export function validateImageSceneDelta({store,presence,now,room,before,next,beforeImages,nextImages}){
  const old=new Map(before.objects.map(object=>[object.id,object]));
  const changed=next.objects.filter(object=>object.type==='image'&&geometryIdentity(object)!==geometryIdentity(old.get(object.id)));
  if(!changed.length)return;
  const people=[...presence.values()].filter(person=>person.roomId===room.id&&now()-person.lastSeen<60000
    &&Number.isFinite(person.x)&&Number.isFinite(person.z)
    &&store.get('SELECT 1 FROM sessions WHERE user_id=? AND current_room_id=? AND expires_at>?',person.userId,room.id,now())
    &&store.canSeeRoom(room,person.userId));
  let changedColliders=false;
  for(const object of changed){
    const definition=nextImages[`${object.assetRef.assetId}:${object.assetRef.versionId}`];
    const cells=imageCollisionCells(definition,object);
    changedColliders ||= cells.length>0;
    if(cells.some(cell=>contains(cell,next.spawn.x,next.spawn.z,.75)))v.fail(400,'IMAGE_BLOCKS_ARRIVAL','Leave clear space around the arrival point',{objectId:object.id});
    if(cells.some(cell=>people.some(person=>contains(cell,person.x,person.z,.4))))v.fail(409,'IMAGE_BLOCKS_PLAYER','Move this image collision away from players standing here',{objectId:object.id});
  }
  if(changedColliders){
    // Context stays in a WeakMap and is never serialized into persisted scene JSON.
    bindImageDefinitions(before,beforeImages,room.id);bindImageDefinitions(next,nextImages,room.id);
    if(canLeaveArrival(before)&&!canLeaveArrival(next))v.fail(400,'IMAGE_BLOCKS_ROUTE','Leave a walking route out of the arrival point');
  }
}
