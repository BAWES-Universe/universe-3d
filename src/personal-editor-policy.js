import {canRenderCompositionReference,compositionReferenceKey} from './composition-context.js';
import {canEditPersonalObject} from './personal-area-policy.js';
import {roomAllows} from './permissions.js';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function canBuildInRoom(room){return typeof room?.capabilities?.canBuild==='boolean'?room.capabilities.canBuild:roomAllows(room,'canEditScene');}
export function personalEditPolicy({room,user}){
 const sameRoomImage=item=>item?.type!=='image'||room?.imageDefinitions?.[`${item.assetRef?.assetId}:${item.assetRef?.versionId}`]?.definition.roomId===room?.id;
 const sameRoomComposition=item=>item?.type!=='composition'||canRenderCompositionReference(item.assetRef,room?.compositionDefinitions?.[compositionReferenceKey(item.assetRef)]);
 const allowed=item=>sameRoomImage(item)&&sameRoomComposition(item)&&!!user?.id&&(roomAllows(room,'canEditScene')||room?.capabilities?.canEditObjects===true)&&canEditPersonalObject(room,item,user.id,room?.imageDefinitions||{},room?.compositionDefinitions||{});
 const denial='Keep every changed object entirely inside a personal area you own';
 return {canEdit:canBuildInRoom(room),canEditItem:allowed,validateItem:(item,previous)=>!allowed(item)||previous&&!allowed(previous)?denial:null,
  validateChange(before,next){
   if(roomAllows(room,'canEditScene'))return null;
   if(!room?.capabilities?.canEditObjects||!before||!next)return 'Your object-editing permission changed';
   const {objects:oldItems,...oldMeta}=before,{objects:newItems,...newMeta}=next;
   if(!equal(oldMeta,newMeta))return 'Personal-area ownership allows object changes only, not room or area settings';
   const old=new Map((oldItems||[]).map(o=>[o.id,o])),fresh=new Map((newItems||[]).map(o=>[o.id,o]));
   for(const id of new Set([...old.keys(),...fresh.keys()])){const a=old.get(id),b=fresh.get(id);if(equal(a,b))continue;if(a&&!allowed(a)||b&&!allowed(b))return denial;}
   return null;
  },saveMetadata(){return{personalAreaRevisions:Object.fromEntries((room?.personalAreas||[]).map(a=>[a.areaId,a.revision]))};}
 };
}
