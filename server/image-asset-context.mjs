import {initializeImageAssetSchema,createImageAssetRepository} from './image-asset-store.mjs';
import {createImageAssetService,createImageAssetHttpHandler,imageReferenceKey} from './image-assets.mjs';
import {validatePng} from './png-validation.mjs';
import {validateImageInstance,validateResolvedImageAsset} from '../src/image-asset-schema.js';
import {bindImageDefinitions} from '../src/image-asset-context.js';
import * as v from './validation.mjs';

const FULL_EDIT=['owner','admin','editor'];
const hasImages=scene=>Array.isArray(scene?.objects)&&scene.objects.some(object=>object?.type==='image');
function validatedDefinitions(definitions){
  const result=Object.create(null);
  for(const [key,value]of Object.entries(definitions))result[key]=validateResolvedImageAsset(value);
  return Object.freeze(result);
}

/** Host-owned adapter. No actor, room, session, or dimensions come from upload JSON. */
export function createRoomImageAssets({store,session,now,emitRoom,isPhysicalSizeEnabled=()=>false,assertCompatible=()=>{}}){
  initializeImageAssetSchema(store.db);
  const repo=createImageAssetRepository(store.db),epochs=new Map();
  const service=createImageAssetService({repo,now,validateImage:validatePng,isPhysicalSizeEnabled,
    resolveSession(token){
      const row=store.get('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?',token,now());
      return row?{userId:row.user_id,currentRoomId:row.current_room_id,expiresAt:row.expires_at,sessionEpoch:epochs.get(token)??0}:null;
    },
    authorizeRead({roomId,userId}){store.authorize(roomId,userId);return true;},
    authorizeManage({roomId,userId}){return FULL_EDIT.includes(store.authorize(roomId,userId).role);},
    isPinned({roomId,assetId,versionId}){
      const row=store.get('SELECT scene FROM rooms WHERE id=?',roomId);
      return !!row&&JSON.parse(row.scene).objects.some(object=>object?.type==='image'&&object.assetRef?.assetId===assetId&&object.assetRef?.versionId===versionId);
    },
    afterCommit(event){emitRoom(event.roomId,'image-assets',{...event});},
  });
  // This read projection is used only behind existing room authority. It is not
  // persisted, not accepted from scene JSON, and never grants placement rights.
  function definitions(roomId,scene){
    const result=Object.create(null);
    for(const raw of scene?.objects??[]){
      if(raw?.type!=='image')continue;
      const instance=validateImageInstance(raw),key=imageReferenceKey(instance.assetRef);
      if(Object.hasOwn(result,key))continue;
      const entry=repo.getVersion(roomId,instance.assetRef.assetId,instance.assetRef.versionId);
      if(!entry||!['active','archived'].includes(entry.status))v.fail(404,'IMAGE_NOT_FOUND','The image reference is unavailable in this room');
      result[key]=validateResolvedImageAsset(entry);
    }
    return Object.freeze(result);
  }
  store.imageDefinitions=definitions;
  const roomProjection=store.room.bind(store);
  store.room=(rowOrId,userId,includeScene=true)=>{
    const room=roomProjection(rowOrId,userId,includeScene);
    const imageDefinitions=includeScene?definitions(room.id,room.scene):Object.freeze(Object.create(null));
    if(includeScene)bindImageDefinitions(room.scene,imageDefinitions,room.id);
    return {...room,imageDefinitions};
  };
  return Object.freeze({
    handle:createImageAssetHttpHandler({service,assertCompatible,getIdentity(req){const live=session(req);return {userId:live.user_id,sessionIdentity:live.token_hash};}}),
    sessionChanged(token){epochs.set(token,(epochs.get(token)??0)+1);},
    sessionEpoch(token){return epochs.get(token)??0;},
    forgetSession(token){epochs.delete(token);},
    resolveScenePair({roomId,userId,token,before,next,expectedEpoch}){
      if(!store.db.isTransaction)throw new Error('Image scene authority requires the existing scene CAS transaction');
      // Preserve built-in-only room saves which historically require room edit
      // authority but not a joined media/image session.
      if(!hasImages(before)&&!hasImages(next))return {before:Object.freeze(Object.create(null)),next:Object.freeze(Object.create(null))};
      if(expectedEpoch!==(epochs.get(token)??0))v.fail(409,'IMAGE_SESSION_CHANGED','The room session changed while the scene save was pending');
      const context={roomId,userId,sessionIdentity:token};
      try{return {before:validatedDefinitions(service.resolveSceneReferences({...context,scene:before,allowArchived:true})),next:validatedDefinitions(service.resolveSceneReferences({...context,scene:next,previousScene:before}))};}
      catch(error){if(error.name==='ImageAssetValidationError')v.fail(400,error.code??'INVALID_SCENE',error.message);throw error;}
    },
  });
}
