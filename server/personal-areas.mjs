import * as v from './validation.mjs';
import {contains} from '../src/worlds.js';
import {footprintInside,objectFootprint} from '../src/personal-area-policy.js';
const FULL_EDIT=['owner','admin','editor'];
export function createPersonalAreaService({store,presence,body,send,session,emitRoom,emitUser,now}){
  function areaState(roomId,areaId,userId){const area=store.personalAreas(roomId,userId).find(a=>a.areaId===areaId);if(!area)v.fail(404,'PERSONAL_AREA_NOT_FOUND','This personal area is unavailable');return area;}
  function scopedAccounts(roomId){return store.members(roomId).filter(u=>u.account).map(u=>({id:u.id,name:u.name,username:u.username}));}
  function broadcast(roomId,userId,reason){
    const room=store.room(roomId,userId);emitRoom(roomId,'scene',{roomId,room,actorId:userId,reason});
    // emitRoom personalizes room capabilities for each recipient. Scene events are
    // also sent to unjoined sessions of affected users by emitUser below.
    for(const row of store.all('SELECT DISTINCT user_id FROM sessions WHERE current_room_id=? AND expires_at>?',roomId,now())){
      if(!store.canSeeRoom(store.roomRow(roomId),row.user_id))continue;
      const ownRoom=store.room(roomId,row.user_id);emitUser(row.user_id,'role',{roomId,role:ownRoom.role,room:ownRoom,capabilities:ownRoom.capabilities,recoverDraft:!ownRoom.capabilities.canBuild,reason});
    }
  }
  return{async handle({req,res,path,method,userId,url}){
    const respond=(status,data)=>{send(res,status,data);return true;};
    if(path==='/api/desk'&&method==='GET'){
      const roomId=url.searchParams.has('roomId')?v.id(url.searchParams.get('roomId'),'roomId'):session(req).current_room_id;
      if(!roomId)return respond(200,{roomId:null,target:null,desks:[]});
      store.authorize(roomId,userId);
      const room=store.room(roomId,userId),desks=room.personalAreas.filter(a=>a.isOwner).map(a=>({roomId,worldId:room.worldId,universeId:room.universeId,roomName:room.name,areaId:a.areaId,name:a.name,areaName:a.name,x:a.x,z:a.z,revision:a.revision,roomRevision:room.revision}));
      return respond(200,{roomId,target:desks[0]??null,desks});
    }
    const match=path.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/personal-areas(?:\/([A-Za-z0-9_-]+)(?:\/(claim|decline|assign|revoke))?)?$/);
    if(!match)return false;
    const roomId=match[1],areaId=match[2],action=match[3];
    store.authorize(roomId,userId);
    if(method==='GET'&&!areaId)return respond(200,{room:store.room(roomId,userId),personalAreas:store.personalAreas(roomId,userId)});
    if(method==='GET'&&areaId==='accounts'&&!action){
      store.authorize(roomId,userId,FULL_EDIT);const q=(url.searchParams.get('query')??'').trim().toLowerCase();if(q.length<2||q.length>80)v.fail(400,'SEARCH_REQUIRED','Enter 2–80 characters to find an account in this room or world');
      return respond(200,{users:scopedAccounts(roomId).filter(u=>u.name.toLowerCase().includes(q)||u.username.toLowerCase().includes(q)).slice(0,50),scope:'room-world-local-accounts'});
    }
    if(method!=='POST'||!action)return false;
    const b=await body(req);
    const allowed=new Set(['revision','clientOperationId',...(action==='claim'?['confirmedTransfer','roomRevision']:[]),...(action==='assign'?['userId']:[]),...(action==='revoke'?['roomRevision','objectHandling']:[])]);
    for(const key of Object.keys(b))if(!allowed.has(key))v.fail(400,'IMMUTABLE_FIELD',`${key} cannot be set here`);
    const revision=v.integer(b.revision,'revision'),operation=v.id(b.clientOperationId,'clientOperationId');
    const payload=JSON.stringify({roomId,areaId,action,revision,userId:b.userId??null,roomRevision:b.roomRevision??null,confirmedTransfer:b.confirmedTransfer??false,objectHandling:b.objectHandling??null});
    let duplicate=false,changed=false,result;
    store.transaction(()=>{
      // No await between fresh cookie/access validation, ownership reads and writes.
      const live=session(req);if(live.user_id!==userId)v.fail(401,'AUTH_REQUIRED');
      const {row}=store.authorize(roomId,userId);
      const previous=store.get('SELECT * FROM personal_area_operations WHERE user_id=? AND operation_id=?',userId,operation);
      if(previous){if(previous.payload!==payload)v.fail(409,'OPERATION_REUSED','This operation ID was already used for different content');duplicate=true;result=JSON.parse(previous.result);return;}
      const area=areaState(roomId,areaId,userId);
      if(area.revision!==revision)v.fail(409,'PERSONAL_AREA_CONFLICT','This personal area changed. Refresh before trying again.',{area,room:store.room(roomId,userId)});
      if(action==='assign'||action==='revoke')store.authorize(roomId,userId,FULL_EDIT);
      const scene=JSON.parse(row.scene);let sceneChanged=false,transferred=[];
      if(action==='claim'||action==='decline'){
        if(!store.user(userId)?.account)v.fail(403,'LOCAL_ACCOUNT_REQUIRED','Create or sign in to a local account before claiming a personal area');
        if(area.ownerId)v.fail(409,'PERSONAL_AREA_CLAIMED','This personal area already has an owner',{area,room:store.room(roomId,userId)});
        if(!area.canClaim)v.fail(403,'PERSONAL_AREA_INELIGIBLE','You do not have an allowed tag in this world');
        const position=presence.get(`${roomId}:${userId}`);
        if(live.current_room_id!==roomId||!position||now()-position.lastSeen>60000||!contains(area,position.x,position.z))v.fail(403,'PERSONAL_AREA_ENTRY_REQUIRED','Walk into this personal area to claim or decline it');
        if(action==='decline'){
          store.run('INSERT INTO personal_area_declines(room_id,area_id,user_id,revision,created_at) VALUES(?,?,?,?,?) ON CONFLICT(room_id,area_id,user_id) DO UPDATE SET revision=excluded.revision,created_at=excluded.created_at',roomId,areaId,userId,revision,now());
        }else{
          if(b.confirmedTransfer!==undefined)v.boolean(b.confirmedTransfer,'confirmedTransfer');
          transferred=store.personalAreas(row,userId).filter(a=>a.isOwner&&a.areaId!==areaId);
          if(transferred.length){
            if(!b.confirmedTransfer)v.fail(409,'PERSONAL_AREA_TRANSFER_REQUIRED','Claiming this area releases your other personal areas in this room and keeps their objects. Continue?',{ownedAreas:transferred,area,room:store.room(roomId,userId)});
            v.integer(b.roomRevision,'roomRevision');if(b.roomRevision!==row.revision)v.fail(409,'REVISION_CONFLICT','The room changed. Review the transfer before confirming.',{room:store.room(roomId,userId)});
            for(const prior of transferred){store.run('UPDATE personal_areas SET owner_id=NULL,revision=revision+1,updated_at=? WHERE room_id=? AND area_id=?',now(),roomId,prior.areaId);scene.areas.find(a=>a.id===prior.areaId).name='This is a personal area. Do you want to make it yours ?';}
          }
          store.run('UPDATE personal_areas SET owner_id=?,revision=revision+1,updated_at=? WHERE room_id=? AND area_id=?',userId,now(),roomId,areaId);scene.areas.find(a=>a.id===areaId).name=`${store.user(userId).name}'s personal space`;sceneChanged=true;changed=true;
        }
      }else if(action==='assign'){
        if(area.mode!=='static')v.fail(409,'STATIC_PERSONAL_AREA_REQUIRED','Change this area to static mode before assigning an owner');
        if(area.ownerId)v.fail(409,'PERSONAL_AREA_CLAIMED','Revoke the current owner before assigning another account');
        const target=v.id(b.userId,'userId');if(!scopedAccounts(roomId).some(u=>u.id===target))v.fail(400,'SCOPED_ACCOUNT_REQUIRED','Choose a registered local account already in this room or world');
        store.authorize(roomId,target);
        store.run('UPDATE personal_areas SET owner_id=?,revision=revision+1,updated_at=? WHERE room_id=? AND area_id=?',target,now(),roomId,areaId);scene.areas.find(a=>a.id===areaId).name=`${store.user(target).name}'s personal space`;sceneChanged=true;changed=true;
      }else{
        const handling=v.oneOf(b.objectHandling,['keep','remove-owned'],'objectHandling');v.integer(b.roomRevision,'roomRevision');
        if(b.roomRevision!==row.revision)v.fail(409,'REVISION_CONFLICT','The room changed. Review the current objects before revoking.',{room:store.room(roomId,userId)});
        if(!area.ownerId)v.fail(409,'PERSONAL_AREA_UNCLAIMED','This personal area is already unclaimed');
        if(handling==='remove-owned'){
          const owned=new Set(store.all('SELECT object_id FROM personal_area_objects WHERE room_id=? AND area_id=? AND creator_id=? AND claim_revision=?',roomId,areaId,area.ownerId,area.revision).map(o=>o.object_id));
          const removed=scene.objects.filter(o=>owned.has(o.id)&&footprintInside(area,objectFootprint(o)));const ids=new Set(removed.map(o=>o.id));scene.objects=scene.objects.filter(o=>!ids.has(o.id));
          for(const id of ids)store.run('DELETE FROM personal_area_objects WHERE room_id=? AND object_id=?',roomId,id);
          sceneChanged=ids.size>0;result={removedObjectIds:[...ids]};
        }
        store.run('UPDATE personal_areas SET owner_id=NULL,revision=revision+1,updated_at=? WHERE room_id=? AND area_id=?',now(),roomId,areaId);scene.areas.find(a=>a.id===areaId).name='This is a personal area. Do you want to make it yours ?';sceneChanged=true;changed=true;
      }
      if(changed)store.run('UPDATE rooms SET scene=?,revision=revision+1 WHERE id=?',sceneChanged?JSON.stringify(scene):row.scene,roomId);
      result={action,appliedRevision:action==='decline'?revision:revision+1,objectHandling:b.objectHandling??null,transferredAreaIds:transferred.map(a=>a.areaId),removedObjectIds:result?.removedObjectIds??[]};
      store.run('INSERT INTO personal_area_operations(user_id,operation_id,payload,result,created_at) VALUES(?,?,?,?,?)',userId,operation,payload,JSON.stringify(result),now());
    });
    if(changed)broadcast(roomId,userId,`personal-area-${action}`);
    const room=store.room(roomId,userId),area=room.personalAreas.find(a=>a.areaId===areaId)??null;
    return respond(200,{room,area,duplicate,operation:result});
  }};
}
