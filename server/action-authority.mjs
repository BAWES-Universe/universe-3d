/** Resolves only committed room actions at the moment of an interaction. */
import {fail,id,integer,oneOf,record} from './validation.mjs';
import {itemActions} from '../src/action-schema.js';
import {contains,collisionBox} from '../src/worlds.js';
export function canonicalAreaActions(area){
 const legacy=[];
 if(area.action==='link'&&area.url)legacy.push({id:'legacy-area-link',type:'link',url:area.url,label:area.name,mode:'tab',trigger:'enter'});
 if(area.action==='teleport'&&area.target)legacy.push({id:'legacy-area-target',type:'teleport',target:area.target,label:area.name,trigger:'enter'});
 return [...legacy,...(area.actions||[])];
}
export function createActionAuthority({store,presence,body,send,now=Date.now}){
 async function handle({req,res,path,method,userId,session}){
  const match=path.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/actions\/resolve$/);
  if(!match||method!=='POST')return false;
  const roomId=id(match[1]),input=record(await body(req));
  const current=store.get('SELECT * FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?',session.token_hash,userId,now());
  if(!current)fail(401,'AUTH_REQUIRED','Sign in again before using this action');
  if(current.current_room_id!==roomId)fail(409,'ROOM_CHANGED','Return to this room before using the item');
  store.authorize(roomId,userId);
  const row=store.roomRow(roomId),revision=integer(input.revision,'revision');
  if(row.revision!==revision)fail(409,'SCENE_CHANGED','This room changed. Open the item again.',{revision:row.revision});
  const entityType=oneOf(input.entityType,['item','area'],'entity type'),entityId=id(input.entityId,'entity id'),actionId=id(input.actionId,'action id');
  const scene=JSON.parse(row.scene),entity=(entityType==='item'?scene.objects:scene.areas||[]).find(e=>e.id===entityId);
  if(!entity)fail(404,'ITEM_REMOVED','This item is no longer here');
  const person=presence.get(roomId+':'+userId);
  if(!person||now()-person.lastSeen>=60000)fail(409,'POSITION_UNCONFIRMED','Your room position needs to reconnect');
  if(entityType==='area'&&!contains(entity,person.x,person.z))fail(403,'OUTSIDE_AREA','Enter this area to use its action');
  if(entityType==='item'){
   const box=collisionBox(entity),dx=Math.max(Math.abs(person.x-box.x)-box.width/2,0),dz=Math.max(Math.abs(person.z-box.z)-box.depth/2,0);
   if(Math.hypot(dx,dz)>2.7)fail(403,'ITEM_TOO_FAR','Move closer to this item');
  }
  const action=(entityType==='item'?itemActions(entity):canonicalAreaActions(entity)).find(a=>a.id===actionId);
  if(!action)fail(404,'ACTION_REMOVED','This action is no longer available');
  const canonical=structuredClone(action);
  const file=typeof canonical.url==='string'&&canonical.url.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/files\/([A-Za-z0-9_-]+)$/);
  if(file){
   if(file[1]!==roomId)fail(404,'FILE_NOT_FOUND','This attachment is not in this room');
   const document=store.get('SELECT id,name,size,content_type FROM room_files WHERE room_id=? AND id=? AND deleted_at IS NULL',roomId,file[2]);
   if(!document)fail(404,'FILE_NOT_FOUND','This attachment is no longer available');
   canonical.document={id:document.id,name:document.name,size:document.size,contentType:document.content_type};canonical.mode='download';
  }
  if(canonical.type==='teleport'){
   const target=store.roomRow(canonical.target);if(!store.canSeeRoom(target,userId))fail(404,'DESTINATION_UNAVAILABLE','That destination is not available to you');
  }
  send(res,200,{roomId,revision:row.revision,entityType,entity:{id:entity.id,name:entity.name||entity.type,text:entity.text||''},action:canonical});return true;
 }
 return {handle};
}
