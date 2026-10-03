import {randomUUID} from 'node:crypto';
import * as v from './validation.mjs';

export const PROXIMITY_CONTROLS = Object.freeze({protocol:'proximity-controls-v1',invitationTtlMs:30000,maxInvitationsPerRoom:256,maxReceiptsPerRoom:256,maxOperationsPerMinute:120,maxPendingPresencePerSession:8,maxPendingPresenceRequests:1024});
const BASE=['action','operationId','connectionId','roomId','memberId','bubbleId','membershipRevision','controlRevision','stateRevision'];
const EXTRA={lock:['locked'],invite:[],accept:['invitationId'],decline:['invitationId'],stop:[],preferences:['ignoreRequests']};
const opaque=value=>typeof value==='string'&&/^[A-Za-z0-9:_-]{1,200}$/.test(value);
export function validateControlCommand(value){
  v.record(value);const extra=typeof value.action==='string'&&Object.hasOwn(EXTRA,value.action)?EXTRA[value.action]:null;
  if(!extra||Object.keys(value).length!==BASE.length+extra.length||Object.keys(value).some(k=>![...BASE,...extra].includes(k)))v.fail(400,'INVALID_CONTROL_COMMAND');
  for(const key of ['operationId','connectionId','roomId','memberId'])if(!opaque(value[key]))v.fail(400,'INVALID_CONTROL_COMMAND');
  if(value.bubbleId!==null&&!opaque(value.bubbleId))v.fail(400,'INVALID_CONTROL_COMMAND');
  for(const key of ['membershipRevision','controlRevision'])if(value[key]!==null&&(!Number.isSafeInteger(value[key])||value[key]<0))v.fail(400,'INVALID_CONTROL_COMMAND');
  if(!Number.isSafeInteger(value.stateRevision)||value.stateRevision<0)v.fail(400,'INVALID_CONTROL_COMMAND');
  if(value.action==='lock')v.boolean(value.locked,'locked');
  if(value.action==='preferences')v.boolean(value.ignoreRequests,'ignoreRequests');
  if(['accept','decline'].includes(value.action)&&!opaque(value.invitationId))v.fail(400,'INVALID_CONTROL_COMMAND');
  return value;
}
export async function readControlBody(req){
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))v.fail(415,'JSON_REQUIRED');
  const length=req.headers['content-length'];if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>4096))v.fail(413,'CONTROL_BODY_TOO_LARGE');
  const raw=await new Promise((resolve,reject)=>{
    const chunks=[];let size=0;const cleanup=()=>{clearTimeout(timer);for(const[event,fn]of [['data',data],['end',end],['aborted',abort],['error',abort]])req.off(event,fn);};
    const fail=(status,code)=>{cleanup();req.resume();reject(new v.HttpError(status,code));};
    const data=chunk=>{size+=chunk.length;if(size>4096)return fail(413,'CONTROL_BODY_TOO_LARGE');chunks.push(chunk);};
    const end=()=>{cleanup();resolve(Buffer.concat(chunks).toString('utf8'));};const abort=()=>fail(400,'CONTROL_BODY_ABORTED');
    const timer=setTimeout(()=>fail(408,'CONTROL_BODY_TIMEOUT'),2000);timer.unref?.();req.on('data',data);req.on('end',end);req.on('aborted',abort);req.on('error',abort);
  });
  let parsed;try{parsed=JSON.parse(raw);}catch{v.fail(400,'INVALID_JSON');}return validateControlCommand(parsed);
}

/** Trusted synchronous control state. Only proximity-authority may call this
 * core after revalidating accepted sessions and synchronizing room admission. */
export function createParticipantControlState({config,model,presence}){
  const rooms=new Map();let connectionAlive=()=>false;
  const get=roomId=>rooms.get(roomId);
  const touch=(room,ids=[],bubbleIds=[])=>{
    for(const id of new Set(ids)){const m=room.members.get(id);if(m)m.revision++;}
    for(const id of new Set(bubbleIds.filter(Boolean))){const b=room.bubbles.get(id);if(b)b.revision++;}
  };
  const bubbleOf=(room,accountId)=>room.modelMembers?.get(accountId)?.bubbleId??null;
  const removeInvite=(room,invite)=>{room.invitations.delete(invite.id);touch(room,[invite.leaderId,invite.recipientId],[invite.bubbleId]);};
  const removeRelation=(room,followerId)=>{const relation=room.following.get(followerId);if(!relation)return;room.following.delete(followerId);const member=room.members.get(followerId);if(member)member.motionRevision++;touch(room,[followerId,relation.leaderId],[bubbleOf(room,followerId),bubbleOf(room,relation.leaderId)]);};
  function syncAdmissions(roomId,admissions,records,at){
    let room=get(roomId);if(!room){room={members:new Map(),bubbles:new Map(),invitations:new Map(),following:new Map(),receipts:new Map(),snapshot:null};rooms.set(roomId,room);}
    const byId=new Map(records.map(record=>[record.accountId,record]));
    const next=new Map();for(const[accountId,a]of admissions){const old=room.members.get(accountId);next.set(accountId,old?.admissionId===a.admissionId?{...old,tokens:a.tokens,name:byId.get(accountId).name}:{admissionId:a.admissionId,tokens:a.tokens,name:byId.get(accountId).name,revision:0,motionRevision:0,ignoreRequests:false,rateStart:at,rateCount:0});}
    room.members=next;
    const valid=(id,admission,token)=>{const m=next.get(id);return m?.admissionId===admission&&(!token||m.tokens.has(token));};
    for(const[followerId,r]of room.following)if(!valid(followerId,r.followerAdmission,r.followerToken)||!valid(r.leaderId,r.leaderAdmission,r.leaderToken))removeRelation(room,followerId);
    for(const inv of room.invitations.values())if(inv.expiresAt<=at||!valid(inv.leaderId,inv.leaderAdmission,inv.leaderToken)||!valid(inv.recipientId,inv.recipientAdmission))removeInvite(room,inv);
    for(const[key,receipt]of room.receipts)if(receipt.expiresAt<=at||!valid(receipt.accountId,receipt.admissionId,receipt.token))room.receipts.delete(key);
    if(!next.size){rooms.delete(roomId);return records;}
    return records.map(record=>({...record,followLeaderId:room.following.get(record.accountId)?.leaderId??null}));
  }
  function observe(roomId,snapshot){
    const room=get(roomId);if(!room)return;room.snapshot=snapshot;room.modelMembers=new Map(snapshot.members.map(member=>[member.accountId,member]));
    const bubbles=new Map();for(const bubble of snapshot.bubbles)bubbles.set(bubble.bubbleId,{...bubble,revision:room.bubbles.get(bubble.bubbleId)?.revision??0});room.bubbles=bubbles;
    // Ordinary invitations expire when either participant leaves the originating
    // bubble. Accepted room/admission consent deliberately survives such exits.
    for(const inv of room.invitations.values())if(bubbleOf(room,inv.leaderId)!==inv.bubbleId||bubbleOf(room,inv.recipientId)!==inv.bubbleId)removeInvite(room,inv);
  }
  const person=(room,id)=>({accountId:id,memberId:room.modelMembers.get(id)?.memberId??null,name:room.members.get(id)?.name??'Player'});
  function state(roomId,accountId,connectionId,at){
    const room=get(roomId),member=room?.members.get(accountId),modelMember=room?.modelMembers?.get(accountId),bubble=room?.bubbles.get(modelMember?.bubbleId);
    if(!member||!modelMember)return {protocol:PROXIMITY_CONTROLS.protocol,available:true,connectionId,roomId,accountId,memberId:null,bubbleId:null,membershipRevision:null,controlRevision:null,stateRevision:null,locked:false,full:false,participants:[],canLock:false,canInvite:false,ignoreRequests:false,invitations:[],outgoingInvitations:[],following:null,followers:[],serverTime:at,limits:{invitationTtlMs:PROXIMITY_CONTROLS.invitationTtlMs,sourceUnitsPerWorldUnit:config.sourceUnitsPerWorldUnit,memberTtlMs:config.memberTtlMs}};
    const following=room.following.get(accountId),leader=following&&person(room,following.leaderId);
    return {protocol:PROXIMITY_CONTROLS.protocol,available:true,connectionId,roomId,accountId,memberId:modelMember.memberId,bubbleId:bubble?.bubbleId??null,membershipRevision:bubble?.membershipRevision??null,controlRevision:bubble?.revision??null,stateRevision:member.revision,locked:bubble?.locked??false,full:!!bubble&&bubble.memberIds.length>=config.membershipCeiling,participants:bubble?bubble.accountIds.map(id=>person(room,id)):[],canLock:!!bubble,canInvite:!!bubble&&!following,ignoreRequests:member.ignoreRequests,
      invitations:[...room.invitations.values()].filter(i=>i.recipientId===accountId).map(i=>({invitationId:i.id,leaderId:i.leaderId,leaderMemberId:person(room,i.leaderId).memberId,leaderName:person(room,i.leaderId).name,expiresAt:i.expiresAt})),
      outgoingInvitations:[...room.invitations.values()].filter(i=>i.leaderId===accountId).map(i=>({invitationId:i.id,recipientId:i.recipientId,recipientMemberId:person(room,i.recipientId).memberId,recipientName:person(room,i.recipientId).name,expiresAt:i.expiresAt})),
      following:following?{leaderId:leader.accountId,leaderMemberId:leader.memberId,leaderName:leader.name,leaderPresence:(({x,z,lastSeen,moving})=>({x,z,lastSeen,moving}))(presence.get(`${roomId}:${leader.accountId}`)),leaseId:following.connectionId===connectionId?following.leaseId:null,controlling:following.connectionId===connectionId&&connectionAlive(following.connectionId,following.followerToken),controllerConnected:connectionAlive(following.connectionId,following.followerToken)}:null,
      followers:[...room.following].filter(([,r])=>r.leaderId===accountId).map(([id])=>person(room,id)),serverTime:at,limits:{invitationTtlMs:PROXIMITY_CONTROLS.invitationTtlMs,sourceUnitsPerWorldUnit:config.sourceUnitsPerWorldUnit,memberTtlMs:config.memberTtlMs}};
  }
  function command(session,body,at,fence){
    const room=get(session.current_room_id),accountId=session.user_id,member=room?.members.get(accountId),current=state(session.current_room_id,accountId,body.connectionId,at);
    if(!connectionAlive(body.connectionId,session.token_hash))v.fail(409,'STALE_CONTROL_CONNECTION');
    if(!member||!current.memberId)v.fail(403,'MEMBERSHIP_REQUIRED');
    if(body.roomId!==current.roomId||body.memberId!==current.memberId)v.fail(409,'STALE_CONTROL_ADMISSION');
    const key=`${accountId}:${body.operationId}`,fingerprint=JSON.stringify(Object.keys(body).sort().map(key=>[key,body[key]])),receipt=room.receipts.get(key);
    if(receipt){if(receipt.token!==session.token_hash||receipt.fingerprint!==fingerprint)v.fail(409,'CONTROL_OPERATION_REUSED');return {duplicate:true};}
    if(fence&&(!fence.connectionIds.includes(body.connectionId)||['roomId','memberId','bubbleId','membershipRevision','controlRevision','stateRevision'].some(key=>body[key]!==fence[key])))v.fail(409,'STALE_CONTROL_CONTEXT');
    for(const key of ['bubbleId','membershipRevision','controlRevision','stateRevision'])if(body[key]!==current[key])v.fail(409,'STALE_CONTROL_CONTEXT');
    if(at-member.rateStart>=60000){member.rateStart=at;member.rateCount=0;}
    // Explicit stops remain available even when invitation/control spam is limited.
    if(body.action!=='stop'&&member.rateCount>=PROXIMITY_CONTROLS.maxOperationsPerMinute)v.fail(429,'CONTROL_RATE_LIMIT');
    const bubble=room.bubbles.get(current.bubbleId);
    if(['lock','invite','accept','decline'].includes(body.action)&&!bubble)v.fail(403,'BUBBLE_REQUIRED');
    if(body.action==='lock'){model.setLocked(current.roomId,current.bubbleId,body.locked);bubble.locked=body.locked;touch(room,[accountId],[current.bubbleId]);}
    if(body.action==='invite'){
      if(room.following.has(accountId))v.fail(409,'FOLLOW_CYCLE_OR_CHAIN');
      const recipients=bubble.accountIds.filter(id=>id!==accountId&&!room.members.get(id).ignoreRequests&&![...room.invitations.values()].some(i=>i.leaderId===accountId&&i.recipientId===id));
      if(room.invitations.size+recipients.length>PROXIMITY_CONTROLS.maxInvitationsPerRoom)v.fail(429,'CONTROL_INVITATION_LIMIT');
      for(const id of recipients){const target=room.members.get(id),invitationId=randomUUID();room.invitations.set(invitationId,{id:invitationId,leaderId:accountId,leaderAdmission:member.admissionId,leaderToken:session.token_hash,recipientId:id,recipientAdmission:target.admissionId,bubbleId:current.bubbleId,expiresAt:at+PROXIMITY_CONTROLS.invitationTtlMs});}
      touch(room,[accountId,...recipients],[current.bubbleId]);
    }
    if(['accept','decline'].includes(body.action)){
      const inv=room.invitations.get(body.invitationId);if(!inv||inv.recipientId!==accountId||inv.recipientAdmission!==member.admissionId||inv.bubbleId!==current.bubbleId)v.fail(403,'FOLLOW_INVITATION_REQUIRED');
      if(body.action==='accept'){
        if(member.ignoreRequests||inv.leaderId===accountId||room.following.has(inv.leaderId))v.fail(409,'FOLLOW_CYCLE_OR_CHAIN');
        // Selecting another leader stops the old leader's entire following group;
        // no previous follower is reassigned without an individual acceptance.
        const oldLeaders=new Set([...room.following].filter(([id,r])=>bubble.accountIds.includes(id)||bubble.accountIds.includes(r.leaderId)).map(([,r])=>r.leaderId));
        for(const[id,r]of [...room.following])if((oldLeaders.has(r.leaderId)&&r.leaderId!==inv.leaderId)||id===accountId)removeRelation(room,id);
        if([...room.following].some(([,r])=>r.leaderId===accountId))v.fail(409,'FOLLOW_CYCLE_OR_CHAIN');
        member.motionRevision++;
        room.following.set(accountId,{leaderId:inv.leaderId,leaderAdmission:inv.leaderAdmission,leaderToken:inv.leaderToken,followerAdmission:member.admissionId,followerToken:session.token_hash,connectionId:body.connectionId,leaseId:randomUUID()});
        for(const other of [...room.invitations.values()])if(other.recipientId===accountId||(oldLeaders.has(other.leaderId)&&other.leaderId!==inv.leaderId))removeInvite(room,other);
        touch(room,[accountId,inv.leaderId],[current.bubbleId]);
      }else removeInvite(room,inv);
    }
    if(body.action==='stop'){
      for(const[id,r]of [...room.following])if(id===accountId||r.leaderId===accountId)removeRelation(room,id);
      for(const inv of [...room.invitations.values()])if(inv.leaderId===accountId||inv.recipientId===accountId)removeInvite(room,inv);
      // Increment even if already stopped: this fences a delayed prior acceptance.
      touch(room,[accountId],[current.bubbleId]);
    }
    if(body.action==='preferences'){
      member.ignoreRequests=body.ignoreRequests;if(body.ignoreRequests)for(const inv of [...room.invitations.values()])if(inv.recipientId===accountId)removeInvite(room,inv);
      touch(room,[accountId],[current.bubbleId]);
    }
    member.rateCount++;while(room.receipts.size>=PROXIMITY_CONTROLS.maxReceiptsPerRoom)room.receipts.delete(room.receipts.keys().next().value);
    room.receipts.set(key,{accountId,admissionId:member.admissionId,token:session.token_hash,fingerprint,expiresAt:at+120000});return {duplicate:false};
  }
  function beginPresence(session){const m=get(session.current_room_id)?.members.get(session.user_id);return {admissionId:m?.admissionId??null,motionRevision:m?.motionRevision??0};}
  function checkPresenceFence(session,fence){if(fence){const current=beginPresence(session);if(current.admissionId!==fence.admissionId||current.motionRevision!==fence.motionRevision)v.fail(409,'STALE_CONTROL_MOVEMENT');}}
  function authorizePresence(session,body,fence){
    checkPresenceFence(session,fence);
    const r=get(session.current_room_id)?.following.get(session.user_id);
    if(r){if(r.followerToken!==session.token_hash||r.connectionId!==body.connectionId||r.leaseId!==body.followLeaseId||!connectionAlive(r.connectionId,r.followerToken))v.fail(409,'FOLLOW_CONTROLLED_ELSEWHERE');}
    else if(body.followLeaseId!==undefined)v.fail(409,'STALE_FOLLOW_LEASE');
  }
  return {beginPresence,checkPresenceFence,hasFollowing(roomId,accountId){return get(roomId)?.following.has(accountId)??false;},syncAdmissions,observe,state,command,authorizePresence,setConnectionLookup(fn){connectionAlive=fn;},forgetRoom(roomId){rooms.delete(roomId);},close(){rooms.clear();},stats(){return{controlRooms:rooms.size,controlInvitations:[...rooms.values()].reduce((n,r)=>n+r.invitations.size,0),controlRelations:[...rooms.values()].reduce((n,r)=>n+r.following.size,0),controlReceipts:[...rooms.values()].reduce((n,r)=>n+r.receipts.size,0)};}};
}

/** SSE identities identify individual tabs even when they share one cookie. */
export function createProximityControls({media,store,sse,now}){
  const streams=new Map(),pendingPresence=new Map();let pendingPresenceCount=0;
  const live=(id,token)=>{const item=streams.get(id);return !!item&&item.token===token&&!item.client.res.destroyed&&!item.client.res.writableEnded;};
  media.setControlConnectionLookup(live);
  const disabled=()=>({protocol:PROXIMITY_CONTROLS.protocol,available:false,reason:'disabled'});
  function connection(session,id){if(!opaque(id)||!live(id,session.token_hash))v.fail(409,'STALE_CONTROL_CONNECTION');return id;}
  function context(session,id=null){return media.controlState(session,id===null?null:connection(session,id));}
  function register(token,client){const id=randomUUID();streams.set(id,{token,client});client.controlConnectionId=id;refresh();}
  function refresh(roomId,captured){
    const grouped=new Map();
    for(const[id,{token,client}]of streams){
      if(!live(id,token)){streams.delete(id);continue;}
      const session=store.get('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?',token,now());
      if(roomId&&session?.current_room_id!==roomId)continue;
      if(!session?.current_room_id){sse(client.res,'proximity-controls',{...disabled(),reason:'outside-room',connectionId:id});continue;}
      const list=grouped.get(session.current_room_id)??[];list.push({id,client,session});grouped.set(session.current_room_id,list);
    }
    for(const[id,list]of grouped){
      let batch;try{batch=id===roomId&&captured?captured:media.captureControlRoom(id);}catch{}
      for(const{id,client,session}of list){
        let state;try{state=batch.controlForSession(session,id);}catch{state={...disabled(),reason:'unavailable',connectionId:id};}
        sse(client.res,'proximity-controls',state);
      }
    }
  }
  function begin(session){return {...context(session),connectionIds:[...streams].filter(([,item])=>item.token===session.token_hash).map(([id])=>id)};}
  function action(session,body,fence){connection(session,body.connectionId);const result=media.controlAction(session,body,fence);refresh(session.current_room_id);return{ok:true,...result,state:context(session,body.connectionId)};}
  function beginPresence(session){
    const records=pendingPresence.get(session.token_hash)??new Set();if(records.size>=PROXIMITY_CONTROLS.maxPendingPresencePerSession||pendingPresenceCount>=PROXIMITY_CONTROLS.maxPendingPresenceRequests)v.fail(429,'CONTROL_PRESENCE_LIMIT');
    const fence={token:session.token_hash,retired:false};records.add(fence);pendingPresence.set(session.token_hash,records);pendingPresenceCount++;return fence;
  }
  function checkPresence(session,fence){if(!fence||fence.retired||fence.token!==session.token_hash)v.fail(409,'STALE_CONTROL_MOVEMENT');}
  function endPresence(fence){const records=pendingPresence.get(fence?.token);if(records?.delete(fence))pendingPresenceCount--;if(records&&!records.size)pendingPresence.delete(fence.token);}
  function retire(token){
    for(const fence of pendingPresence.get(token)??[])fence.retired=true;
    for(const[id,item]of [...streams])if(item.token===token){streams.delete(id);const next=randomUUID();item.client.controlConnectionId=next;streams.set(next,item);sse(item.client.res,'proximity-controls',{...disabled(),reason:'room-transition',connectionId:next});}
  }
  return {context,register,refresh,begin,action,retire,beginPresence,checkPresence,endPresence,disconnect(client){streams.delete(client.controlConnectionId);refresh();},close(){streams.clear();for(const records of pendingPresence.values())for(const fence of records)fence.retired=true;pendingPresence.clear();pendingPresenceCount=0;}};
}
