import {randomUUID} from 'node:crypto';
import {createBubbleModel} from './proximity/membership.mjs';
import {integer,invariant,validateConfig} from './proximity/policy.mjs';
import * as v from './validation.mjs';
import {createParticipantControlState,validateControlCommand} from './proximity-controls.mjs';
import {SILENT_MEDIA_MESSAGE} from '../src/media-policy-copy.js';

const CONFIG_KEYS=['enabled','membershipCeiling','p2pThreshold','downgradeDelayMs','minimumDistanceSource','groupRadiusSource','sourceUnitsPerWorldUnit','coordinateLimitWorld','memberTtlMs','maxRooms','maxMembersPerRoom','maxAccounts','maxMemberships','maxSessionsPerMember'];
const validatedConfigs=new WeakSet();
export function validateProximityMembershipConfig(input){
  if(validatedConfigs.has(input))return input;
  invariant(input&&typeof input==='object'&&!Array.isArray(input),'CONFIG_REQUIRED');
  invariant(input.enabled===true,'EXPLICIT_ENABLE_REQUIRED');
  invariant(Object.keys(input).every(key=>CONFIG_KEYS.includes(key)),'UNKNOWN_CONFIG_FIELD');
  const config=validateConfig({...input,meetingPolicy:'source-threshold'});
  integer(config.maxSessionsPerMember,'maxSessionsPerMember',1,16);
  for(const[key,max]of Object.entries({maxRooms:64,maxMembersPerRoom:256,maxAccounts:4096,maxMemberships:8192}))integer(config[key],key,1,max);
  // Presence and ICE currently use 60 seconds; this opt-in cannot extend that lease.
  invariant(config.memberTtlMs<=60000,'TTL_EXCEEDS_PRESENCE_LEASE');
  validatedConfigs.add(config);return config;
}
const inside=(area,p)=>Number.isFinite(area.x)&&Number.isFinite(area.z)&&Math.abs(p.x-area.x)<=area.width/2&&Math.abs(p.z-area.z)<=area.depth/2;
// Preserve the standalone area's ordering and existing status behavior. Source
// BUSY is not excluded: this explicit adaptation is NOT a source enum equivalence.
function contextFor(room,p,status){
  const areas=(room.scene.areas??[]).filter(area=>inside(area,p));
  const area=areas.find(a=>a.action==='silent')||areas.find(a=>a.action==='stage'||a.action==='audience')||areas.find(a=>a.action==='meeting');
  if(area?.action==='silent')return {kind:'silent',label:area.name||'Quiet area',canPublish:false,reason:SILENT_MEDIA_MESSAGE,group:area.id};
  if(area?.action==='stage'){const canPublish=['owner','admin','editor','moderator'].includes(room.role);return {kind:'stage',label:area.name||'Stage',canPublish,reason:canPublish?'Stage speakers can broadcast':'The room owner must grant editor or moderator access to speak on stage',group:area.meetingName||area.id};}
  if(area?.action==='audience')return {kind:'audience',label:area.name||'Audience',canPublish:false,reason:'Audience listens to stage speakers',group:area.meetingName||area.id};
  if(area?.action==='meeting')return {kind:'meeting',label:area.name||'Meeting',canPublish:true,reason:'Everyone in this meeting area can talk',group:area.meetingName||area.id};
  const blocked=['busy','dnd','invisible'].includes(status);
  return {kind:'proximity',label:'Nearby conversation',canPublish:!blocked,reason:blocked?'Nearby calls are paused for your current status':p.moving?'Stop near someone to start a conversation':'Nearby stationary players can talk',group:'proximity'};
}
const sourceStatus=status=>({online:'ONLINE',away:'AWAY',busy:'DENY_PROXIMITY_MEETING',dnd:'DO_NOT_DISTURB',invisible:'DENY_PROXIMITY_MEETING'})[status];

/** Server-only authority. No HTTP-provided identity/context/config is accepted.
 * Public API actors are accepted session records, revalidated against SQLite.
 * policyForAccount/refresh are host-only broadcasting seams, never request routes.
 */
export function createProximityMembershipAuthority({config:input,store,presence,now=Date.now,onInvalidate=()=>{}}){
  const config=validateProximityMembershipConfig(input);
  invariant(store&&presence instanceof Map&&typeof now==='function','AUTHORITY_REQUIRED');
  const epoch=randomUUID(),model=createBubbleModel({config,epoch});
  const admissions=new Map(),grants=new Map(),contexts=new Map(),scopes=new Map();
  const controls=createParticipantControlState({config,model,presence});
  let sequence=0,closed=false,lastTime=0,transaction=0;
  const assertOpen=()=>invariant(!closed,'SERVICE_CLOSED');
  function time(){
    assertOpen();
    try{const value=now();integer(value,'nowMs');invariant(value>=lastTime,'CLOCK_REGRESSED');lastTime=value;return value;}
    catch(error){for(const roomId of [...admissions.keys()]){clearRoom(roomId);onInvalidate(roomId);}throw error;}
  }
  function clearRoom(roomId){transaction++;controls.forgetRoom(roomId);model.forgetRoom(roomId);admissions.delete(roomId);contexts.delete(roomId);scopes.delete(roomId);for(const[token,grant]of grants)if(grant.roomId===roomId)grants.delete(token);}
  function liveActor(accepted,at){
    if(!accepted||typeof accepted.token_hash!=='string')v.fail(401,'AUTH_REQUIRED');
    const current=store.get('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?',accepted.token_hash,at);
    if(!current||current.user_id!==accepted.user_id||current.current_room_id!==accepted.current_room_id)v.fail(401,'AUTH_REQUIRED');
    if(!current.current_room_id)v.fail(403,'JOIN_REQUIRED');
    try{store.authorize(current.current_room_id,current.user_id);}catch(error){if(!error.status){clearRoom(current.current_room_id);onInvalidate(current.current_room_id);}throw error;}
    return current;
  }
  function sync(roomId,at){
    transaction++;
    for(const[id,records]of admissions){
      for(const[accountId,a]of records)if(at-a.lastSeen>=config.memberTtlMs){records.delete(accountId);contexts.get(id)?.delete(accountId);for(const[token,g]of grants)if(g.roomId===id&&g.accountId===accountId)grants.delete(token);}
      if(!records.size)clearRoom(id);
    }
    v.id(roomId,'roomId');
    try{
      const row=store.roomRow(roomId),scene=JSON.parse(row.scene),old=admissions.get(roomId)??new Map(),next=new Map(),nextContexts=new Map();
      const members=[];
      for(const[key,p]of presence){
        if(p.roomId!==roomId||key!==`${roomId}:${p.userId}`)continue;
        const accountId=p.userId,user=store.get('SELECT id,status FROM users WHERE id=?',accountId);
        if(!user||!store.canSeeRoom(row,accountId))continue;
        integer(p.lastSeen,'lastSeen');invariant(p.lastSeen<=at,'FUTURE_PRESENCE');
        if(at-p.lastSeen>=config.memberTtlMs)continue;
        const sessions=store.all('SELECT token_hash FROM sessions WHERE current_room_id=? AND user_id=? AND expires_at>? LIMIT ?',roomId,accountId,at,config.maxSessionsPerMember+1);
        // An over-cap or unadmitted account is excluded, never a room-wide DoS.
        if(!sessions.length||sessions.length>config.maxSessionsPerMember)continue;
        const tokens=new Set(sessions.map(s=>s.token_hash));
        const role=(scene.areas??[]).some(a=>a.action==='stage'&&inside(a,p))?store.role(row,accountId):null;
        const context=contextFor({scene,role},p,user.status),status=sourceStatus(user.status);
        invariant(status,'INVALID_status');
        const previous=old.get(accountId);
        const continuous=previous&&at-previous.lastSeen<config.memberTtlMs&&[...tokens].some(token=>previous.tokens.has(token));
        const admissionId=continuous?previous.admissionId:`${epoch}:admission:${integer(++sequence,'sequence',1)}`;
        next.set(accountId,{admissionId,tokens,lastSeen:p.lastSeen});nextContexts.set(accountId,context);
        const mediaConsent=[...tokens].some(token=>{const g=grants.get(token);return g?.roomId===roomId&&g.accountId===accountId&&g.admissionId===admissionId;});
        members.push({accountId,admissionId,name:store.get('SELECT name FROM users WHERE id=?',accountId)?.name??'Player',x:p.x,z:p.z,moving:p.moving,lastSeenMs:p.lastSeen,status,context:{kind:context.kind==='proximity'?'proximity':'silent'},mediaConsent,canPublish:context.canPublish===true,followLeaderId:null});
      }
      const trustedMembers=controls.syncAdmissions(roomId,next,members,at);
      const result=model.syncRoom({roomId,members:trustedMembers,nowMs:at,sfuAvailable:false});
      controls.observe(roomId,result);
      if(next.size){admissions.set(roomId,next);contexts.set(roomId,nextContexts);}else{admissions.delete(roomId);contexts.delete(roomId);}
      for(const[token,g]of grants)if(g.roomId===roomId){const a=next.get(g.accountId);if(!a||a.admissionId!==g.admissionId||!a.tokens.has(token))grants.delete(token);}
      const priorScopes=scopes.get(roomId)??new Map(),nextScopes=new Map();
      for(const bubble of result.bubbles){
        const signature=JSON.stringify([bubble.memberIds,bubble.transport.p2pAllowed,bubble.transport.intentGeneration,bubble.accountIds.map(accountId=>[accountId,[...next.get(accountId).tokens].filter(token=>grants.get(token)?.admissionId===next.get(accountId).admissionId).sort()])]);
        const previous=priorScopes.get(bubble.bubbleId);
        nextScopes.set(bubble.bubbleId,previous?.signature===signature?previous:{signature,mediaScope:randomUUID()});
      }
      if(nextScopes.size)scopes.set(roomId,nextScopes);else scopes.delete(roomId);
      return result;
    }catch(error){clearRoom(roomId);onInvalidate(roomId);throw error;}
  }
  function refresh(roomId){return sync(roomId,time());}
  function view(accountId,roomId,at,token){
    const admission=admissions.get(roomId)?.get(accountId);
    if(!admission)return {roomId,accountId,memberId:null,bubbleId:null,membershipRevision:null,enabled:false,context:{kind:'none',label:'Offline',canPublish:false,reason:'Waiting for player presence'},conversationRecipients:[],mediaRecipients:[],p2pRecipients:[],transport:null};
    const result=model.view(roomId,accountId,admission.admissionId,at);
    const consent=token===undefined?[...admission.tokens].some(t=>grants.get(t)?.admissionId===admission.admissionId):grants.get(token)?.admissionId===admission.admissionId&&admission.tokens.has(token);
    return {...result,mediaScope:scopes.get(roomId)?.get(result.bubbleId)?.mediaScope??null,enabled:!!consent,context:{...contexts.get(roomId).get(accountId)},...(!consent?{mediaRecipients:[],p2pRecipients:[]}:{})};
  }
  function captureRoom(roomId){
    const at=time();sync(roomId,at);const captured=transaction;
    const current=()=>{assertOpen();invariant(captured===transaction,'STALE_POLICY_BATCH');};
    return Object.freeze({
      policyForAccount(accountId){current();return view(accountId,roomId,at);},
      policyForSession(accepted){current();const s=liveActor(accepted,time());if(s.current_room_id!==roomId)v.fail(403,'ROOM_MISMATCH');return view(s.user_id,roomId,at,s.token_hash);},
      controlForSession(accepted,connectionId){current();const s=liveActor(accepted,time());if(s.current_room_id!==roomId)v.fail(403,'ROOM_MISMATCH');return {...controls.state(roomId,s.user_id,connectionId,at),snapshotRevision:captured};},
    });
  }
  function assertAdmission(accepted,roomId){
    const at=time();v.id(roomId,'roomId');
    const s=store.get('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?',accepted?.token_hash,at);
    if(!s||s.user_id!==accepted.user_id)v.fail(401,'AUTH_REQUIRED');store.authorize(roomId,s.user_id);
    const count=store.get('SELECT COUNT(*) AS n FROM sessions WHERE current_room_id=? AND user_id=? AND expires_at>? AND token_hash!=?',roomId,s.user_id,at,s.token_hash).n;
    if(count>=config.maxSessionsPerMember)v.fail(429,'PROXIMITY_SESSION_LIMIT');
    const pairs=new Map();
    for(const p of presence.values()){
      if(at-p.lastSeen>=config.memberTtlMs||!store.get('SELECT 1 FROM sessions WHERE current_room_id=? AND user_id=? AND expires_at>? AND token_hash!=?',p.roomId,p.userId,at,s.token_hash))continue;
      let allowed=false;try{allowed=store.canSeeRoom(store.roomRow(p.roomId),p.userId);}catch{}if(allowed)pairs.set(`${p.roomId}:${p.userId}`,{roomId:p.roomId,accountId:p.userId});
    }
    pairs.set(`${roomId}:${s.user_id}`,{roomId,accountId:s.user_id});
    const records=[...pairs.values()];
    if(records.filter(p=>p.roomId===roomId).length>config.maxMembersPerRoom||records.length>config.maxMemberships||new Set(records.map(p=>p.roomId)).size>config.maxRooms||new Set(records.map(p=>p.accountId)).size>config.maxAccounts)v.fail(429,'PROXIMITY_CAPACITY');
  }
  function policy(accepted){const at=time(),s=liveActor(accepted,at);sync(s.current_room_id,at);return view(s.user_id,s.current_room_id,at,s.token_hash);}
  function policyForAccount(accountId,roomId){const at=time();store.authorize(roomId,accountId);sync(roomId,at);return view(accountId,roomId,at);}
  function setConsent(accepted,value){
    v.boolean(value,'enabled');const at=time(),s=liveActor(accepted,at);sync(s.current_room_id,at);
    const a=admissions.get(s.current_room_id)?.get(s.user_id);
    if(value&&!a)v.fail(403,'MEMBERSHIP_REQUIRED');
    if(value)grants.set(s.token_hash,{roomId:s.current_room_id,accountId:s.user_id,admissionId:a.admissionId});else grants.delete(s.token_hash);
    sync(s.current_room_id,at);return view(s.user_id,s.current_room_id,at,s.token_hash);
  }
  function authorizeP2PSignal(accepted,envelope){
    const p=policy(accepted);
    if(!envelope||envelope.roomId!==p.roomId||envelope.bubbleId!==p.bubbleId||envelope.fromMemberId!==p.memberId||!p.bubbleId)v.fail(403,'STALE_SIGNAL_CONTEXT');
    if(envelope.mediaScope!==p.mediaScope)v.fail(403,'STALE_MEDIA_SCOPE');
    if(envelope.intentGeneration!==p.transport?.intentGeneration)v.fail(403,'STALE_TRANSPORT_INTENT');
    const peer=p.p2pRecipients.find(peer=>peer.accountId===envelope.to&&peer.memberId===envelope.toMemberId);
    if(!peer)v.fail(403,'MEDIA_FORBIDDEN');
    return {...peer,bubbleId:p.bubbleId,fromMemberId:p.memberId,intentGeneration:p.transport.intentGeneration,mediaScope:p.mediaScope};
  }
  function authorizeDelivery(accepted,envelope){
    try{const p=policy(accepted);return p.enabled&&p.roomId===envelope.roomId&&p.bubbleId===envelope.bubbleId&&p.memberId===envelope.toMemberId&&p.transport?.intentGeneration===envelope.intentGeneration&&p.mediaScope===envelope.mediaScope&&p.p2pRecipients.some(peer=>peer.accountId===envelope.from&&peer.memberId===envelope.fromMemberId);}catch{return false;}
  }
  function sweep(){
    let at;try{at=time();}catch{return [];}const results=[];
    for(const roomId of [...admissions.keys()]){try{results.push(sync(roomId,at));}catch(error){results.push({roomId,events:[],error:error.code??'AUTHORITY_READ_FAILED'});}}
    // A sweep rechecks authority, not just elapsed time. No policy read renews TTL.
    model.tick(at);return results;
  }
  function controlState(accepted,connectionId){const at=time(),s=liveActor(accepted,at);sync(s.current_room_id,at);return {...controls.state(s.current_room_id,s.user_id,connectionId,at),snapshotRevision:transaction};}
  function controlAction(accepted,body,fence){validateControlCommand(body);const at=time(),s=liveActor(accepted,at);sync(s.current_room_id,at);const result=controls.command(s,body,at,fence);sync(s.current_room_id,at);return result;}
  function beginControlledPresence(accepted){return controls.beginPresence(accepted);}
  function authorizeControlledPresence(accepted,body,fence){const at=time(),s=liveActor(accepted,at);controls.checkPresenceFence(s,fence);if(!controls.hasFollowing(s.current_room_id,s.user_id)&&body.followLeaseId===undefined)return;sync(s.current_room_id,at);controls.authorizePresence(s,body,fence);}
  function close(){controls.close();model.clear();admissions.clear();contexts.clear();grants.clear();scopes.clear();closed=true;}
  return Object.freeze({controlState,controlAction,beginControlledPresence,authorizeControlledPresence,setControlConnectionLookup:controls.setConnectionLookup,refresh,captureRoom,assertAdmission,policy,policyForAccount,setConsent,authorizeP2PSignal,authorizeDelivery,sweep,forgetRoom(roomId){assertOpen();clearRoom(roomId);},close,stats(){return{...model.stats(),...controls.stats(),grants:grants.size};}});
}
