import {publicGuestsEnabled,assertPublicGuestRequest,requireGuestAccount,sessionPrincipal,sessionPrincipals,moveSession,deleteSession,hasRoomSession,publicGuestPerson} from './public-guests.mjs';
import {readPresenceMotion} from './presence-motion.mjs';
import {createImageClientProtocol,IMAGE_RELOAD_MESSAGE} from './image-client-protocol.mjs';
import {createArrivalService,readArrivalInput,readExpectedPlacement} from './arrivals.mjs';
import http from 'node:http';
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import {createStaticAssets} from './static-assets.mjs';
import { Store } from './store.mjs';
import * as v from './validation.mjs';
import { createMediaPolicy } from './media.mjs';
import {validateProximityMembershipConfig} from './proximity-authority.mjs';
import {createMediaIce,readIceRelayConfig,readIceBody} from './media-ice.mjs';
import {createProximityText,validateProximityTextConfig,readProximityTextBody} from './proximity-text.mjs';
import {createProximityControls,readControlBody} from './proximity-controls.mjs';
import {readProximityTypingBody} from './proximity-typing.mjs';
import {validateTerrainSceneDelta} from './terrain.mjs';
import { createQuestService } from './quests.mjs';
import { createRoomFileService } from './files.mjs';
import {validateAppearance} from '../src/avatar-spec.js';
import { createExpressionService } from './expressions.mjs';
import { createHierarchyService } from './hierarchy.mjs';
import {createPersonalAreaService} from './personal-areas.mjs';
import {validatePersonalScene} from './personal-area-store.mjs';
import {itemActions} from '../src/action-schema.js';
import {createActionAuthority,canonicalAreaActions} from './action-authority.mjs';
import {createResidentTurnService,unavailableResidentTest} from './resident-turns.mjs';
import {createBotService} from './bots.mjs';
import {readRuntimeConfig,createRequestSecurity} from './runtime-config.mjs';
import {createAccessGate} from './access-gate.mjs';
import {createRoomImageAssets} from './image-asset-context.mjs';
import {validateImageSceneDelta} from './image-scene-authority.mjs';
import {createSceneOperationService} from './scene-operations.mjs';
import {sceneOperationGeometryConflicts} from './scene-operation-geometry.mjs';
import {createSiteAdmission,readSiteAdmissionBody} from './site-admission.mjs';
import {createOpenSignup,assertOpenAccountSchema} from './open-signup.mjs';
import {normalizeEmail,validateAccountPassword} from './account-identity.mjs';
import {createSetupMode} from './setup-mode.mjs';
import {readSiteAdmissionConfig,validateSiteAdmissionConfig} from './site-admission-config.mjs';

const passwordHash = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const COOKIE = 'universe_session';
const SESSION_MS = 30 * 86400000;
const EDIT = ['owner', 'admin', 'editor'];
const MODERATE = ['owner', 'admin', 'moderator'];
const EMOJI = ['👍','❤️','😂','🎉','👋','✨','🔥','💯','👏','🤔','🙌','😮','😊','💜','✅','🎸','💃','🕺','🏳️'];
const STATUS = ['online','away','busy','dnd','invisible'];

export function createGameServer({ database = ':memory:', seeds = [], dist = resolve('dist'), runtimeConfig = readRuntimeConfig({}), host = runtimeConfig.host, clock = Date.now, questsEnabled = true, residentTurnOptions, iceRelayConfig = readIceRelayConfig({}), proximityMembershipConfig, proximityTextConfig, proximityTypingTimers, siteAdmissionConfig = readSiteAdmissionConfig({UNIVERSE_REGISTRATION_MODE:runtimeConfig.registrationMode}), imagePhysicalSizeEnabled = runtimeConfig.imagePhysicalSizeEnabled ?? false } = {}) {
  // The reusable test/server factory never inherits ambient deployment env.
  // The process entry point alone parses it and passes this explicit contract.
  if(host!==runtimeConfig.host)throw new Error('Configure the bind address through runtimeConfig');
  siteAdmissionConfig=validateSiteAdmissionConfig(siteAdmissionConfig);
  if(siteAdmissionConfig.enabled!==(runtimeConfig.registrationMode==='invite-only')||(siteAdmissionConfig.registrationMode==='open')!==(runtimeConfig.registrationMode==='open'))throw new Error('Site admission configuration must match the explicit registration mode');
  if(proximityMembershipConfig!==undefined)proximityMembershipConfig=validateProximityMembershipConfig(proximityMembershipConfig);
  if(proximityTextConfig!==undefined)proximityTextConfig=validateProximityTextConfig(proximityTextConfig,proximityMembershipConfig);
  const store = new Store(database, seeds, clock, {claimUnownedOnCreate:runtimeConfig.mode==='local'&&runtimeConfig.registrationMode==='local-open'});
  const accessGate=createAccessGate({store,config:runtimeConfig});
  let setup;
  try{if(runtimeConfig.registrationMode==='open')assertOpenAccountSchema(store);setup=createSetupMode({store,config:runtimeConfig,accessGate});}catch(error){store.close();throw error;}
  const requestSecurity=createRequestSecurity(runtimeConfig,{listeningPort:()=>server.address()?.port});
  const serveStatic=createStaticAssets({dist});
  const connections = new Map(),responseRequests=new WeakMap(),streamCapabilities=new WeakMap(),streamScopes=new WeakMap();
  let imageProtocol=null;
  const presence = new Map();
  const rates = new Map();
  const sessionRoles=new Map();
  let closed = false, residentTurns=null, proximityControls=null;
  const now = () => clock();
  try{imageProtocol=createImageClientProtocol({store,enabled:imagePhysicalSizeEnabled,onChange:status=>{
    for(const clients of connections.values())for(const client of clients){if(!streamCapabilities.get(client.res)&&imageProtocol.isRequired())retireIncompatibleStream(client.res);else rawSse(client.res,'client-protocol',status);}
  }});}catch(error){store.close();throw error;}
  const arrivals=createArrivalService({store,presence,now,residents:(roomId,options)=>bots.arrivalOccupants(roomId,options)});
  function limit(key, max, span = 60000) {
    const t = now(); let bucket = rates.get(key);
    if (!bucket || bucket.start + span < t) { bucket = { start: t, n: 0 }; rates.set(key,bucket); }
    if (++bucket.n > max) v.fail(429, 'RATE_LIMITED', 'Please slow down and try again shortly');
  }
  function send(res, status, data, headers = {}) {
    if (res.destroyed || res.writableEnded) return;
    if(!setup.active&&status<400&&responseRequests.has(res))imageProtocol?.assertRequest(responseRequests.get(res));
    res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers }); res.end(JSON.stringify(data));
  }
  function rawSse(res,event,data){if(!res.destroyed&&!res.writableEnded)res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);}
  function retireIncompatibleStream(res,scope=streamScopes.get(res)){
    if(res.destroyed||res.writableEnded)return;
    if(!res.headersSent)res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
    const live=scope?.token?sessionPrincipal(store,scope.token,now()):null;
    const rooms=new Set([live?.current_room_id,scope?.roomId].filter(roomId=>typeof roomId==='string'&&roomId));
    const retirement={code:'CLIENT_RELOAD_REQUIRED',reason:IMAGE_RELOAD_MESSAGE,recoverDraft:true,...imageProtocol.status()};
    // The old arrival buffer recognizes only a matching room, so deny known
    // pending-room commits before the global fallback retires the visible UI.
    for(const roomId of rooms)rawSse(res,'access-revoked',{...retirement,roomId});
    rawSse(res,'access-revoked',{...retirement,roomId:null});res.end();
  }
  function sse(res,event,data){if(imageProtocol?.isRequired()&&!streamCapabilities.get(res)){retireIncompatibleStream(res);return;}rawSse(res,event,data);}

  function emitUser(userId,event,data) { for (const [token,clients] of connections) { const session=sessionPrincipal(store,token,now()); if(session?.user_id===userId)for(const client of clients)sse(client.res,event,data); } }
  function emitRoom(roomId,event,data) {
    for (const [token, clients] of connections) {
      const session = sessionPrincipal(store,token,now());
      if (!session || session.current_room_id !== roomId) continue;
      const row = store.roomRow(roomId); if (!store.canSeeRoom(row,session.user_id)) continue;
      const room=data.room?store.room(row,session.user_id,!!data.room.scene):null;
      let delivered=room?{...data,room,...(event==='scene'?{cursor:room.revision}:{})}:data;
      if(store.isPublicGuest(session.user_id)){
        if(event==='message')continue;
        if(event==='members')delivered={...delivered,members:guestPresence(roomId,session.user_id)};
        if(event==='presence')delivered={...delivered,presence:guestPresence(roomId,session.user_id)};
        if(event==='image-assets'&&!JSON.parse(row.scene).objects.some(o=>o.type==='image'&&o.assetRef?.assetId===data.assetId))continue;
      }
      for (const client of clients) sse(client.res,event,delivered);
    }
  }
  function getPresence(roomId) { return [...presence.values()].filter(p => p.roomId === roomId && now() - p.lastSeen < 60000); }
  function guestPresence(roomId,selfId){const row=store.roomRow(roomId);return getPresence(roomId).filter(p=>hasRoomSession(store,p.userId,roomId,now())&&store.canSeeRoom(row,p.userId)).map(p=>publicGuestPerson(p,selfId));}
  function snapshot(roomId,userId) { const guest=store.isPublicGuest(userId),visible=guest?guestPresence(roomId,userId):null;return { room:store.room(roomId,userId),members:guest?visible:store.members(roomId),presence:guest?visible:getPresence(roomId),bots:bots.snapshot(roomId),botPermissions:bots.capabilities(roomId,userId),messages:guest?[]:store.messages(roomId,userId) }; }
  function broadcastPresence(roomId) { if (roomId) { bots.reconcileRoom(roomId);emitRoom(roomId,'presence',{roomId,presence:getPresence(roomId)}); media.refresh(roomId,batch=>proximityControls?.refresh(roomId,batch)); proximityText?.refresh(roomId); quests.reconcileRoom(roomId); } }
  function putPresence(userId,roomId,fields = {}) {
    store.authorize(roomId,userId);
    const key = `${roomId}:${userId}`, old = presence.get(key) || {};
    let accepted={};
    if((!old.admissionId||now()-old.lastSeen>=60000)&&!fields.admissionId){const prepared=arrivals.prepare(roomId,userId,{resume:true});const arrival=arrivals.commit(roomId,userId,prepared);accepted={x:arrival.x,z:arrival.z,admissionId:arrival.admissionId,admissionEpoch:arrival.admissionEpoch,admissionRevision:arrival.admissionRevision,...(!arrival.resumed?{y:0,verticalVelocity:0,grounded:true,seatId:null,seatHeight:0,moving:false,running:false,velocity:{x:0,z:0},emote:null}:{})};}
    presence.set(key,{...store.user(userId),roomId,moving:false,emote:null,...old,...accepted,...fields,id:userId,userId,roomId,lastSeen:now()});
    broadcastPresence(roomId);
  }
  function leave(token,userId) {
    arrivals.retire(token);
    ice.retire(token);proximityText?.retire(token);proximityControls?.retire(token);
    const old = sessionPrincipal(store,token,now(),false)?.current_room_id;
    moveSession(store,token,null);
    images.sessionChanged(token);residentTurns?.sessionChanged(token);
    if (old && !hasRoomSession(store,userId,old,now(),token)) presence.delete(`${old}:${userId}`);
    if(!presence.has(`${old}:${userId}`))expressions.clear(old,userId);quests.disconnected(userId,old); media.leave(userId,old); broadcastPresence(old);
  }
  function cookie(token, req, clear = false, guest = false) { return `${COOKIE}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict${guest&&!clear?'':`; Max-Age=${clear ? 0 : SESSION_MS / 1000}`}${requestSecurity.secureCookie(req) ? '; Secure' : ''}`; }
  function createSession(userId,req,res) {
    const token = randomBytes(32).toString('base64url'), tokenHash = digest(token);
    const guest=store.isPublicGuest(userId);
    if(guest)store.publicGuestSessions.set(tokenHash,{token_hash:tokenHash,user_id:userId,expires_at:store.publicGuestProfiles.get(userId).expires_at,current_room_id:null});
    else store.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',tokenHash,userId,now()+SESSION_MS);
    res.setHeader('Set-Cookie',cookie(token,req,false,guest)); return { token_hash: tokenHash,user_id:userId,current_room_id:null };
  }
  function retireSession(s){
    leave(s.token_hash,s.user_id);deleteSession(store,s.token_hash);
    for(const client of connections.get(s.token_hash)||[])client.res.end();connections.delete(s.token_hash);sessionRoles.delete(s.token_hash);images.forgetSession(s.token_hash);
  }
  function retireGuest(id){
    for(const s of sessionPrincipals(store,{userId:id,active:false}))retireSession(s);
    store.deletePublicGuest(id);
  }
  function pruneGuests(){for(const id of store.expiredPublicGuests())retireGuest(id);}
  function session(req, required = true) {
    if(!setup.active)imageProtocol?.assertRequest(req);
    const token = String(req.headers.cookie || '').split(';').map(p => p.trim()).find(p => p.startsWith(`${COOKIE}=`))?.slice(COOKIE.length+1);
    const row = token && /^[A-Za-z0-9_-]{43}$/.test(token) ? sessionPrincipal(store,digest(token),now()) : null;
    if(row&&store.isPublicGuest(row.user_id)&&!publicGuestsEnabled(runtimeConfig))v.fail(401,'AUTH_REQUIRED','Guest access is unavailable');
    if (!row && required) v.fail(401,'AUTH_REQUIRED',runtimeConfig.mode==='public'?'Explore as a guest or sign in first':'Create a guest profile or sign in first');
    if(row?.current_room_id){let permitted=false;try{permitted=store.canSeeRoom(store.roomRow(row.current_room_id),row.user_id);}catch{}if(!permitted){const old=row.current_room_id;moveSession(store,row.token_hash,null);images.sessionChanged(row.token_hash);arrivals.retire(row.token_hash);proximityText?.retire(row.token_hash);proximityControls?.retire(row.token_hash);residentTurns?.sessionChanged(row.token_hash);ice.retire(row.token_hash);row.current_room_id=null;sessionRoles.delete(row.token_hash);presence.delete(`${old}:${row.user_id}`);}}
    return row;
  }
  function sessionState(s) { return { user:store.user(s.user_id),worlds:store.worlds(s.user_id),rooms:store.worlds(s.user_id).flatMap(w => w.rooms),currentRoomId:s.current_room_id,siteAdmission:siteAdmission.publicPolicy(s),...imageProtocol.status() }; }
  function join(roomId,s,input={}) {
    readArrivalInput(input);
    if(input.mode==='resume'&&s.current_room_id!==roomId)v.fail(409,'RESUME_CONTEXT_CHANGED','Your room changed. Choose a destination before travelling again.');
    let entry=input.entry;
    if(input.sourceAction){
      const source=input.sourceAction;
      const resolved=actionAuthority.resolveCanonical({roomId:source.roomId,userId:s.user_id,session:s,input:source});
      if(resolved.action.type!=='teleport')v.fail(400,'INVALID_TRAVEL_ACTION','Choose a saved travel action');
      if(resolved.action.target!==roomId||input.entry!==undefined&&input.entry!==resolved.action.entry)v.fail(409,'DESTINATION_MISMATCH','The saved action has a different destination. Open it again.');
      entry=resolved.action.entry;
    }
    store.authorize(roomId,s.user_id);if(!store.isPublicGuest(s.user_id))media.assertAdmission(s,roomId);
    const explicitTravel=input.mode==='travel'||entry!==undefined||!!input.sourceAction;
    const preserve=input.mode==='resume'&&s.current_room_id===roomId;
    const sibling=hasRoomSession(store,s.user_id,roomId,now(),s.token_hash);
    // The entire prepare/commit path is synchronous: subsequent admissions see
    // this accepted position, while failures happen before source retirement.
    const prepared=arrivals.prepare(roomId,s.user_id,{entry,resume:preserve||!explicitTravel&&!!sibling,strict:explicitTravel||['resume','enter'].includes(input.mode),sessionToken:s.token_hash,retiringAccountId:explicitTravel&&presence.has(`${roomId}:${s.user_id}`)?s.user_id:null});
    // Position is account-wide. Explicit relocation of an already visible actor
    // must retire its destination admission, including a sibling controller's
    // follow lease, before moving that shared avatar. Other people stay put.
    if(explicitTravel&&presence.has(`${roomId}:${s.user_id}`)){
      const related=sessionPrincipals(store,{userId:s.user_id,roomId});
      for(const {token_hash:token}of related){arrivals.retire(token);proximityControls?.retire(token);proximityText?.retire(token);ice.retire(token);}
      presence.delete(`${roomId}:${s.user_id}`);expressions.clear(roomId,s.user_id);quests.disconnected(s.user_id,roomId);media.leave(s.user_id,roomId);broadcastPresence(roomId);
    }
    const arrival=arrivals.commit(roomId,s.user_id,prepared,s.token_hash);
    if(!preserve||!arrival.resumed)leave(s.token_hash,s.user_id);
    moveSession(store,s.token_hash,roomId);
    sessionRoles.set(s.token_hash,store.role(store.roomRow(roomId),s.user_id));
    putPresence(s.user_id,roomId,{x:arrival.x,z:arrival.z,admissionId:arrival.admissionId,admissionEpoch:arrival.admissionEpoch,admissionRevision:arrival.admissionRevision,...(!arrival.resumed?{y:0,verticalVelocity:0,grounded:true,seatId:null,seatHeight:0,moving:false,running:false,velocity:{x:0,z:0},emote:null}:{})});
    emitRoom(roomId,'members',{roomId,members:store.members(roomId)});
    return {...snapshot(roomId,s.user_id),arrival};
  }
  async function body(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) v.fail(415,'JSON_REQUIRED','Use Content-Type: application/json');
    const chunks=[]; let n=0;
    for await (const chunk of req) { n+=chunk.length; if (n>600000) v.fail(413,'TOO_LARGE','Request is too large'); chunks.push(chunk); }
    imageProtocol?.assertRequest(req);
    try { const result=v.record(JSON.parse(Buffer.concat(chunks).toString('utf8')));const path=new URL(req.url,'http://127.0.0.1').pathname;if(!(req.method==='POST'&&['/api/session','/api/login'].includes(path)))session(req);return result; } catch(e) { if(e.status) throw e; v.fail(400,'INVALID_JSON','The request body is not valid JSON'); }
  }
  function originCheck(req) {
    requestSecurity.assertRequest(req);
  }
  function dmAllowed(actorId,targetId) {
    if(store.isPublicGuest(actorId)||store.isPublicGuest(targetId))requireGuestAccount();
    if (actorId===targetId || !store.user(targetId)) v.fail(404,'USER_NOT_FOUND','Choose another player');
    const rooms=new Set(store.all('SELECT a.current_room_id AS room_id FROM sessions a JOIN sessions b ON b.current_room_id=a.current_room_id WHERE a.user_id=? AND b.user_id=? AND a.expires_at>? AND b.expires_at>?',actorId,targetId,now(),now()).map(r=>r.room_id));
    for(const r of store.all('SELECT r.id AS room_id FROM rooms r JOIN world_members a ON a.world_id=r.world_id JOIN world_members b ON b.world_id=r.world_id WHERE a.user_id=? AND b.user_id=?',actorId,targetId))rooms.add(r.room_id);
    const shared=[...rooms].some(id=>{try{const r=store.roomRow(id);return store.canSeeRoom(r,actorId)&&store.canSeeRoom(r,targetId);}catch{return false;}});
    if (!shared) v.fail(403,'DM_FORBIDDEN','You must share a room or world membership to send a direct message');
  }
  function dmMessage(row) { return { id:row.id,userId:row.sender_id,senderId:row.sender_id,recipientId:row.recipient_id,author:store.user(row.sender_id),text:row.text,createdAt:row.created_at }; }
  function emitMediaUser(userId,event,data) {
    if(event==='media-policy')ice.observe(userId,data);
    if(event==='media-policy'&&data.proximityAuthorityUnavailable)proximityText?.typing.invalidateRoom(data.roomId);
    for(const [token,clients] of connections) {
      const session=sessionPrincipal(store,token,now());
      if(!session || session.user_id!==userId || session.current_room_id!==data.roomId)continue;
      if(event==='media-signal'&&!media.authorizeDelivery(session,data))continue;
      const scoped=event==='media-policy'&&proximityMembershipConfig!==undefined&&data.roomId&&!data.proximityAuthorityUnavailable?media.policy(userId,data.roomId,session):data;
      for(const client of clients)sse(client.res,event,event==='media-policy'?ice.decorate(session,scoped):data);
    }
  }
  const media=createMediaPolicy({store,presence,emitUser:emitMediaUser,now,proximityMembershipConfig});
  const proximityText=proximityTextConfig?createProximityText({store,media,connections,sse,now,typingTimers:proximityTypingTimers}):null;
  proximityControls=proximityMembershipConfig?createProximityControls({media,store,sse,now}):null;
  const ice=createMediaIce({config:iceRelayConfig,store,presence,media,now});
  const quests=createQuestService({store,presence,media,emitUser,now,enabled:questsEnabled});
  const expressions=createExpressionService({store,presence,emitRoom,now,limit});
  const files=createRoomFileService({store,now,send,session});
  const images=createRoomImageAssets({store,session,now,emitRoom,isPhysicalSizeEnabled:()=>imageProtocol?.isEnabled()===true,assertCompatible:req=>imageProtocol?.assertRequest(req)});

  function policyChanged(reason,force={}) {
    residentTurns?.policyChanged();
    const affected=new Set(),revoked=new Set();
    for(const s of sessionPrincipals(store,{joined:true})){
      const roomId=s.current_room_id;let row,role;try{row=store.roomRow(roomId);role=store.role(row,s.user_id);}catch{}
      const forced=force.userId===s.user_id&&force.worldId===row?.world_id;
      if(!row||!store.canSeeRoom(row,s.user_id)||forced){
        moveSession(store,s.token_hash,null);images.sessionChanged(s.token_hash);arrivals.retire(s.token_hash);proximityText?.retire(s.token_hash);proximityControls?.retire(s.token_hash);residentTurns?.sessionChanged(s.token_hash);ice.retire(s.token_hash);sessionRoles.delete(s.token_hash);presence.delete(`${roomId}:${s.user_id}`);affected.add(roomId);
        const key=`${roomId}:${s.user_id}`;if(!revoked.has(key)){revoked.add(key);quests.disconnected(s.user_id,roomId);expressions.clear(roomId,s.user_id);emitUser(s.user_id,'access-revoked',{roomId,reason,recoverDraft:true});emitUser(s.user_id,'media-policy',{selfId:s.user_id,roomId:null,enabled:false,context:{kind:'none',label:'Access ended',canPublish:false,reason:'Room access changed'},peers:[],iceServers:[]});}
      }else{
        const oldRole=sessionRoles.get(s.token_hash);sessionRoles.set(s.token_hash,role);const room=store.room(row,s.user_id);
        emitUser(s.user_id,'role',{roomId,role,room,capabilities:room.capabilities,recoverDraft:EDIT.includes(oldRole)&&!EDIT.includes(role)});affected.add(roomId);
      }
    }
    for(const key of revoked){const split=key.lastIndexOf(':');media.leave(key.slice(split+1),key.slice(0,split));}
    for(const roomId of affected)broadcastPresence(roomId);
    for(const id of new Set(sessionPrincipals(store).map(s=>s.user_id)))emitUser(id,'catalog',{reason});
  }
  const bots=createBotService({store,presence,body,send,session,emitRoom,now,onChanged:(roomId,botId)=>residentTurns?.botChanged(roomId,botId),residentTest:()=>residentTurns?.catalog()??unavailableResidentTest()});
  try{if(residentTurnOptions!==undefined)residentTurns=createResidentTurnService({store,bots,session,body,send,now,options:residentTurnOptions});}catch(error){bots.close();store.close();throw error;}
  const hierarchy=createHierarchyService({store,now,body,send,changed:policyChanged,emitUser});
  const personalAreas=createPersonalAreaService({store,presence,body,send,session,emitRoom,emitUser,now});
  const actionAuthority=createActionAuthority({store,presence,body,send,now,captureFence:arrivals.captureFence,checkFence:arrivals.checkFence});
  // Both write protocols use this complete synchronous validation/provenance
  // chain while holding the same SQLite write lock.
  function commitScene({row,userId,live,before,next,personalAreaRevisions,imageSessionEpoch,validateGeometry=false,validateDependencies,conflict}) {
    const roomId=row.id;
    if(!store.roomCapabilities(row,userId).canBuild)v.fail(403,'ROOM_FORBIDDEN','You do not have permission to build in this room');
    const resolvedImages=images.resolveScenePair({roomId,userId,token:live.token_hash,before,next,expectedEpoch:imageSessionEpoch});
    const encoded=v.scene(next,resolvedImages.next);validatePersonalScene(next);
    store.validatePersonalObjectDelta(row,userId,before,next,personalAreaRevisions,resolvedImages.before,resolvedImages.next);
    validateDependencies?.(resolvedImages);
    validateImageSceneDelta({store,presence,now,room:row,before,next,beforeImages:resolvedImages.before,nextImages:resolvedImages.next});
    validateTerrainSceneDelta({store,presence,residents:bots.snapshot(roomId),now,room:row,userId,before,next,beforeImages:resolvedImages.before,nextImages:resolvedImages.next});
    arrivals.validateScene(next,resolvedImages.next,roomId);
    if(validateGeometry){
      const conflicts=sceneOperationGeometryConflicts({store,presence,residents:bots.snapshot(roomId),now,room:row,before,next,beforeImages:resolvedImages.before,nextImages:resolvedImages.next});
      if(conflicts.length)conflict(conflicts);
    }
    store.syncPersonalAreas(roomId,before,next);
    store.run('UPDATE rooms SET scene=?,revision=revision+1 WHERE id=? AND revision=?',encoded,roomId,row.revision);
    store.recordPersonalObjects(roomId,userId,before,next,resolvedImages.next);
    const room=store.room(roomId,userId),questChanges=EDIT.includes(room.role)?quests.observeBuild(userId,roomId,before,room.scene,room.revision):[];
    return {room,questChanges};
  }
  function afterSceneCommit(roomId,userId,room,questChanges) {
    quests.notify(questChanges);
    emitRoom(roomId,'scene',{roomId,room,actorId:userId});bots.reconcileRoom(roomId);media.refresh(roomId,batch=>proximityControls?.refresh(roomId,batch));proximityText?.refresh(roomId);quests.reconcileRoom(roomId);
  }
  const sceneOperations=createSceneOperationService({store,session,arrivals,images,body,send,commitScene,afterCommit:afterSceneCommit});
  const siteAdmission=createSiteAdmission({store,config:siteAdmissionConfig,now,session,send});
  const openSignup=createOpenSignup({store,config:siteAdmissionConfig,setup,session,send,limitSignup:siteAdmission.limitSignup});
  const server=http.createServer(async(req,res) => {
    responseRequests.set(res,req);
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','same-origin'); res.setHeader('X-Frame-Options','DENY');
    try {
      const url=new URL(req.url,'http://127.0.0.1'); const path=url.pathname; const method=req.method;
      originCheck(req);
      setup.assertRequest(req,path,url);
      if (!path.startsWith('/api/')) return await serveStatic(req,res,path);
      if(!setup.active)imageProtocol.assertRequest(req);
      if(path==='/api/client-protocol'&&method==='GET')return send(res,200,imageProtocol.status());
      if(path==='/api/health'&&method==='GET') return send(res,200,{ok:true,persistence:'sqlite',identity:'httpOnly-session',scope:runtimeConfig.mode==='public'?'standalone-private-preview':'standalone-local'});
      if(path==='/api/access'&&method==='GET')return send(res,200,{...accessGate.publicPolicy(),openSignup:runtimeConfig.registrationMode==='open',openRegistration:runtimeConfig.registrationMode==='open',setupOnly:setup.active,inviteRegistration:siteAdmissionConfig.enabled,siteAdmission:siteAdmission.publicPolicy(session(req,false))});
      if(await openSignup.handle({req,res,path,method,url}))return;
      if(path==='/api/setup/me'&&method==='GET'){if(runtimeConfig.registrationMode!=='open')v.fail(404,'NOT_FOUND','API endpoint not found');const me=session(req);if(!store.user(me.user_id)?.account)v.fail(401,'AUTH_REQUIRED','Sign in to an account first');return send(res,200,{accountId:me.user_id,user:store.user(me.user_id),setupOnly:setup.active});}
      if(await siteAdmission.handle({req,res,path,method,url}))return;
      if(path==='/api/session'&&method==='POST') {
        limit(`guest:${req.socket.remoteAddress}`,60);
        const b=await body(req); const existing=session(req,false);
        if(existing) return send(res,200,sessionState(existing));
        accessGate.assertGuestCreationAllowed();
        if(publicGuestsEnabled(runtimeConfig)){
          if(Object.keys(b).some(key=>!['name','appearance','woka'].includes(key)))v.fail(400,'INVALID_INPUT','Unexpected guest fields');
          pruneGuests();
          const user=store.createPublicGuest(b.name===undefined||b.name===''?null:v.text(b.name,'name',40),b.appearance!==undefined?JSON.stringify(validateAppearance(b.appearance)):v.woka(b.woka??0));
          let result;try{result=sessionState(createSession(user.id,req,res));}catch(error){store.deletePublicGuest(user.id);throw error;}
          return send(res,201,result);
        }
        const user=store.createUser(v.text(b.name ?? 'Explorer','name',40),b.appearance!==undefined?JSON.stringify(validateAppearance(b.appearance)):v.woka(b.woka ?? 0));
        return send(res,201,sessionState(createSession(user.id,req,res)));
      }
      if(path==='/api/login'&&method==='POST') {
        limit(`login:${req.socket.remoteAddress}`,12);
        const b=await readSiteAdmissionBody(req);
        const supplied=b.identifier??b.email??b.username;
        if(b.identifier!==undefined&&[b.email,b.username].some(value=>value!==undefined&&value!==b.identifier))v.fail(400,'INVALID_IDENTIFIER','Supply one email or username identifier');
        const emailLogin=runtimeConfig.registrationMode==='open'&&(b.email!==undefined||(typeof supplied==='string'&&supplied.includes('@')));
        const identifier=emailLogin?normalizeEmail(supplied):v.text(supplied,'username',32).toLowerCase();
        const password=v.text(b.password,'password',256);
        const account=store.get(emailLogin?'SELECT * FROM accounts WHERE email=?':'SELECT * FROM accounts WHERE username=?',identifier);
        const result=await passwordHash(password,account?.salt || '00000000000000000000000000000000',64);
        if(!account || !timingSafeEqual(Buffer.from(account.password_hash,'hex'),result)) v.fail(401,'INVALID_CREDENTIALS','Incorrect sign-in details');
        const old=session(req,false);if(old){if(store.isPublicGuest(old.user_id))retireGuest(old.user_id);else retireSession(old);}
        const signedIn=createSession(account.user_id,req,res);
        return send(res,200,setup.active?{user:store.user(account.user_id),accountId:account.user_id,setupOnly:true}:{...sessionState(signedIn),accountId:account.user_id,setupOnly:false});
      }
      const s=session(req); const userId=s.user_id;
      if(path==='/api/events'&&method==='GET'&&imageProtocol.isRequired()&&!imageProtocol.accepts(req))return retireIncompatibleStream(res,{token:s.token_hash,roomId:s.current_room_id});
      limit(`requests:${s.token_hash}`,1200);
      if(store.isPublicGuest(userId)){
        assertPublicGuestRequest(method,path);
        const image=path.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/assets\/([A-Za-z0-9_-]+)\/versions\/([A-Za-z0-9_-]+)\/image$/),file=path.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/files\/([A-Za-z0-9_-]+)$/);
        if(image||file){const roomId=(image||file)[1],scene=JSON.parse(store.authorize(roomId,userId).row.scene);if(s.current_room_id!==roomId)v.fail(403,'JOIN_REQUIRED');
          if(image&&!scene.objects.some(o=>o.type==='image'&&o.assetRef?.assetId===image[2]&&o.assetRef?.versionId===image[3]))v.fail(404,'IMAGE_NOT_FOUND','This image is not displayed in this room');
          if(file&&![...scene.objects.flatMap(itemActions),...(scene.areas??[]).flatMap(canonicalAreaActions)].some(a=>a.type==='link'&&a.url===path))v.fail(404,'FILE_NOT_FOUND','This document is not shared in this room');
        }
        const empty={ '/api/invitations':'invitations','/api/memberships':'memberships','/api/stars':'rooms','/api/conversations':'conversations' };
        if(method==='GET'&&empty[path])return send(res,200,{[empty[path]]:[]});
        if(method==='GET'&&path==='/api/proximity-controls')return send(res,200,{protocol:'proximity-controls-v1',available:false,reason:'disabled',accountRequired:true});
        if(method==='GET'&&path==='/api/proximity-text')return send(res,200,{protocol:'proximity-text-v1',available:false,canSend:false,reason:'disabled',accountRequired:true});
      }
      if(await images.handle(req,res))return;
      imageProtocol.assertRequest(req);
      if(await personalAreas.handle({req,res,path,method,userId,url}))return;
      imageProtocol.assertRequest(req);
      if(await actionAuthority.handle({req,res,path,method,userId,session:s}))return;
      imageProtocol.assertRequest(req);
      if(residentTurns&&await residentTurns.handle({req,res,path,method,userId}))return;
      imageProtocol.assertRequest(req);
      if(!residentTurns&&/^\/api\/rooms\/[A-Za-z0-9_-]+\/bots\/[A-Za-z0-9_-]+\/turns(?:\/|$)/.test(path)){store.authorize(path.split('/')[3],userId);if(!bots.capabilities(path.split('/')[3],userId).canManage)v.fail(403,'BOT_FORBIDDEN');v.fail(503,'RESIDENT_PROVIDER_UNAVAILABLE','No local test provider is configured');}
      if(await bots.handle({req,res,path,method,userId,session:s}))return;
      imageProtocol.assertRequest(req);
      if(await hierarchy.handle({req,res,path,method,userId,url}))return;
      imageProtocol.assertRequest(req);
      if(await files.handle({req,res,path,method,userId,url}))return;
      imageProtocol.assertRequest(req);
      if(path==='/api/quests'&&method==='GET')return send(res,200,quests.state(userId,s.current_room_id));
      if(path==='/api/quests/preferences'&&method==='PATCH'){const b=await body(req);quests.changePreferences(userId,b);return send(res,200,quests.state(userId,s.current_room_id));}
      if(path==='/api/quests/accept'&&method==='POST'){const b=await body(req);const result=quests.accept(userId,s.current_room_id,b);return send(res,result.duplicate?200:201,{...result,...quests.state(userId,s.current_room_id)});}
      if(path==='/api/quests/archive'&&method==='POST'){const b=await body(req);quests.archive(userId,b.attemptId);return send(res,200,quests.state(userId,s.current_room_id));}
      if(path==='/api/quests/notices/claim'&&method==='POST'){await body(req);return send(res,200,quests.claimNotices(userId));}
      if(path==='/api/session'&&method==='GET') return send(res,200,sessionState(s));
      if((path==='/api/session'||path==='/api/me')&&method==='PATCH') {
        const b=await body(req), user=store.user(userId);
        const name=b.name===undefined?user.name:v.text(b.name,'name',40), woka=b.appearance!==undefined?JSON.stringify(validateAppearance(b.appearance)):b.woka===undefined?JSON.stringify(user.woka):v.woka(b.woka),status=b.status===undefined?user.status:v.oneOf(b.status,STATUS,'status');
        store.run('UPDATE users SET name=?,woka=?,status=? WHERE id=?',name,woka,status,userId);
        for(const p of presence.values()) if(p.userId===userId){Object.assign(p,store.user(userId));broadcastPresence(p.roomId);emitRoom(p.roomId,'members',{roomId:p.roomId,members:store.members(p.roomId)});}
        return send(res,200,{user:store.user(userId)});
      }
      if(path==='/api/account'&&method==='POST') {
        accessGate.assertRegistrationAllowed();
        limit(`register:${req.socket.remoteAddress}`,12);
        const b=await body(req); const username=v.text(b.username,'username',32).toLowerCase();
        if(!/^[a-z0-9_]{3,32}$/.test(username)) v.fail(400,'INVALID_USERNAME','Use 3–32 lowercase letters, numbers or underscores');
        const password=validateAccountPassword(b.password);
        if(store.user(userId).account) v.fail(409,'ALREADY_REGISTERED','This profile already has an account');
        if(store.get('SELECT 1 FROM accounts WHERE username=?',username)) v.fail(409,'USERNAME_TAKEN','That username is already used');
        const salt=randomBytes(16).toString('hex'), hash=await passwordHash(password,salt,64);
        imageProtocol.assertRequest(req);
        try{store.run('INSERT INTO accounts(username,user_id,salt,password_hash) VALUES(?,?,?,?)',username,userId,salt,hash.toString('hex'));}catch{v.fail(409,'USERNAME_TAKEN','That username is already used');}
        return send(res,201,{user:store.user(userId)});
      }
      if(path==='/api/logout'&&method==='POST') { if(store.isPublicGuest(userId))retireGuest(userId);else retireSession(s); return send(res,200,{ok:true},{'Set-Cookie':cookie('',req,true)}); }
      if(await sceneOperations(req,res,url,s))return;
      imageProtocol.assertRequest(req);
      let match;
      match=path.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)(?:\/(join|entries|leave|scene|messages|emote|moderate|invites|expression|expressions))?$/);
      if(match) {
        const roomId=match[1],action=match[2];
        if(action==='join'&&method==='POST'){const fence=arrivals.captureFence(s);const b=!req.headers['transfer-encoding']&&(!req.headers['content-length']||req.headers['content-length']==='0')?{}:await body(req);readArrivalInput(b);if(b.mode==='resume'&&session(req).current_room_id!==roomId)v.fail(409,'RESUME_CONTEXT_CHANGED','Your room changed. Choose a destination before travelling again.');const live=arrivals.checkFence(s,fence);return send(res,200,join(roomId,live,b));}
        if(action==='entries'&&method==='GET')return send(res,200,arrivals.catalog(roomId,userId));
        const auth=store.authorize(roomId,userId);
        if(!action&&method==='GET') return send(res,200,snapshot(roomId,userId));
        if(action==='leave'&&method==='POST'){
          const fence=arrivals.captureFence(s),b=!req.headers['transfer-encoding']&&(!req.headers['content-length']||req.headers['content-length']==='0')?{}:await body(req),expected=readExpectedPlacement(b);
          if(expected){
            const live=session(req);
            if(!arrivals.matchesPlacement(live,roomId,expected,fence))return send(res,200,{ok:true,applied:false,reason:'placement-changed'});
            leave(live.token_hash,userId);return send(res,200,{ok:true,applied:true});
          }
          leave(s.token_hash,userId);return send(res,200,{ok:true});
        }
        if(action==='expression'&&method==='POST'){const b=await body(req),active=session(req);const result=expressions.post(roomId,userId,active.current_room_id,b);return send(res,result.duplicate?200:201,result);}
        if(action==='expressions'&&method==='GET')return send(res,200,expressions.list(roomId,userId,session(req).current_room_id));
        if(action==='scene'&&method==='PUT') {
          const imageSessionEpoch=images.sessionEpoch(s.token_hash);
          const b=await body(req);if(!store.roomCapabilities(store.authorize(roomId,userId).row,userId).canBuild)v.fail(403,'ROOM_FORBIDDEN','You do not have permission to build in this room');for(const key of Object.keys(b))if(!['revision','scene','personalAreaRevisions'].includes(key))v.fail(400,'IMMUTABLE_FIELD',`${key} cannot be set here`);v.integer(b.revision,'revision');
          // Re-check room and scoped ownership after body streaming, under the same
          // SQLite write lock as CAS, geometry validation and provenance writes.
          const result=store.transaction(()=>{
            const live=session(req);if(live.user_id!==userId)v.fail(401,'AUTH_REQUIRED');
            const {row}=store.authorize(roomId,userId),before=JSON.parse(row.scene);
            if(row.revision!==b.revision)v.fail(409,'REVISION_CONFLICT','The room changed. Review the latest scene before saving.',{room:store.room(roomId,userId)});
            return commitScene({row,userId,live,before,next:b.scene,personalAreaRevisions:b.personalAreaRevisions,imageSessionEpoch});
          });
          afterSceneCommit(roomId,userId,result.room,result.questChanges);return send(res,200,{room:result.room});
        }
        if(action==='messages'&&method==='GET'&&store.isPublicGuest(userId))return send(res,200,{messages:[],hasMore:false,nextCursor:null});
        if(action==='messages'&&method==='GET') { const before=url.searchParams.has('before')?Number(url.searchParams.get('before')):Number.MAX_SAFE_INTEGER;v.integer(before,'before');return send(res,200,store.messagesPage(roomId,userId,{before,cursor:url.searchParams.get('cursor')})); }
        if(action==='messages'&&method==='POST') {
          limit(`chat:${userId}`,40);const b=await body(req);const fresh=store.authorize(roomId,userId);if(fresh.member?.muted_until>now())v.fail(403,'MUTED','You are temporarily muted in this room');
          const content=v.text(b.text,'message',2000),operation=b.clientOperationId===undefined?null:v.id(b.clientOperationId,'clientOperationId');
          if(operation){const prior=store.get('SELECT * FROM messages WHERE user_id=? AND client_operation_id=?',userId,operation);if(prior){if(prior.room_id!==roomId||prior.text!==content)v.fail(409,'OPERATION_REUSED','This operation ID has already been used for another message');return send(res,200,{message:store.message(prior,userId),duplicate:true});}}
          const messageId=randomUUID();store.run('INSERT INTO messages(id,room_id,user_id,text,created_at,client_operation_id) VALUES(?,?,?,?,?,?)',messageId,roomId,userId,content,now(),operation);const message=store.message(store.get('SELECT * FROM messages WHERE id=?',messageId),userId);
          emitRoom(roomId,'message',{roomId,message});return send(res,201,{message});
        }
        if(action==='emote'&&method==='POST') {const fence=arrivals.captureFence(s),b=await body(req),live=arrivals.checkFence(s,fence);if(live.current_room_id!==roomId)v.fail(403,'JOIN_REQUIRED');const person=presence.get(`${roomId}:${userId}`);if(!person||now()-person.lastSeen>=60000)v.fail(409,'POSITION_UNCONFIRMED','Resume this room before sending an emote');const emote=v.text(b.emoji??b.emote,'emote',32);putPresence(userId,roomId,{emote,emoteAt:now()});quests.observeWave(userId,roomId,emote);return send(res,200,{ok:true});}
        if(action==='moderate'&&method==='POST') {
          const b=await body(req);const targetId=v.id(b.userId,'userId'),actionName=v.oneOf(b.action,['mute','unmute','kick','ban','unban'],'action');store.authorize(roomId,userId,MODERATE);const targetRole=store.role(auth.row,targetId);
          if(!store.user(targetId))v.fail(404,'USER_NOT_FOUND');if(targetId===userId||['owner','admin'].includes(targetRole)||(!['owner','admin'].includes(auth.role)&&targetRole==='moderator'))v.fail(403,'PROTECTED_MEMBER','You cannot moderate this player');
          const guestTarget=store.isPublicGuest(targetId);let guestModeration;
          if(guestTarget){const key=`${roomId}:${targetId}`;guestModeration=store.publicGuestModeration.get(key)??{room_id:roomId,user_id:targetId,role:'member',granted:0,banned:0,muted_until:0};store.publicGuestModeration.set(key,guestModeration);}
          else store.run('INSERT OR IGNORE INTO members(room_id,user_id,role,granted) VALUES(?,?,?,0)',roomId,targetId,'member');
          if(actionName==='mute'||actionName==='unmute'){const minutes=b.minutes===undefined?10:v.integer(b.minutes,'minutes',1,1440),until=actionName==='mute'?now()+minutes*60000:0;if(guestTarget)guestModeration.muted_until=until;else store.run('UPDATE members SET muted_until=? WHERE room_id=? AND user_id=?',until,roomId,targetId);}
          if(actionName==='ban'||actionName==='unban'){if(guestTarget)guestModeration.banned=+(actionName==='ban');else store.run('UPDATE members SET banned=? WHERE room_id=? AND user_id=?',+(actionName==='ban'),roomId,targetId);}
          if(actionName==='kick'||actionName==='ban'){const retiredSessions=sessionPrincipals(store,{roomId,userId:targetId,active:false});emitUser(targetId,'moderation',{roomId,action:actionName,userId:targetId,actorId:userId});retiredSessions.forEach(s=>moveSession(store,s.token_hash,null));residentTurns?.policyChanged();presence.delete(`${roomId}:${targetId}`);ice.retireUser(targetId);for(const{token_hash:token}of retiredSessions){arrivals.retire(token);proximityText?.retire(token);proximityControls?.retire(token);}expressions.clear(roomId,targetId);media.leave(targetId,roomId);emitUser(targetId,'media-policy',{selfId:targetId,roomId:null,enabled:false,context:{kind:'none',canPublish:false},peers:[],iceServers:[]});broadcastPresence(roomId);}
          proximityText?.refresh();proximityControls?.refresh();emitRoom(roomId,'members',{roomId,members:store.members(roomId)});return send(res,200,{ok:true,members:store.members(roomId)});
        }
      }
      match=path.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/members\/([A-Za-z0-9_-]+)$/);
      if(match&&['PUT','DELETE'].includes(method)) {
        const [_,roomId,targetId]=match,b=method==='PUT'?await body(req):{};const auth=store.authorize(roomId,userId,['owner','admin']);
        if(method==='PUT'&&store.isPublicGuest(targetId))requireGuestAccount();if(targetId===auth.row.universe_owner)v.fail(409,'PROTECTED_OWNER');if(!store.user(targetId))v.fail(404,'USER_NOT_FOUND');
        if(method==='DELETE')store.run('UPDATE members SET granted=0,role=? WHERE room_id=? AND user_id=?','member',roomId,targetId);
        else {const role=v.oneOf(b.role,['member','editor','moderator'],'role');store.run('INSERT INTO members(room_id,user_id,role,granted) VALUES(?,?,?,1) ON CONFLICT(room_id,user_id) DO UPDATE SET role=excluded.role,granted=1',roomId,targetId,role);}
        policyChanged('room-grant-changed');emitRoom(roomId,'members',{roomId,members:store.members(roomId)});return send(res,200,{members:store.members(roomId)});
      }
      match=path.match(/^\/api\/messages\/([A-Za-z0-9_-]+)(?:\/(reactions))?$/);
      if(match&&['PATCH','DELETE','POST'].includes(method)) {
        const row=store.get('SELECT * FROM messages WHERE id=?',match[1]);if(!row)v.fail(404,'MESSAGE_NOT_FOUND');const auth=store.authorize(row.room_id,userId);
        if(match[2]==='reactions'&&method==='POST'){const b=await body(req),emoji=v.oneOf(b.emoji,EMOJI,'emoji');if(row.deleted)v.fail(409,'MESSAGE_DELETED');const existing=store.get('SELECT 1 FROM reactions WHERE message_id=? AND user_id=? AND emoji=?',row.id,userId,emoji);if(existing)store.run('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?',row.id,userId,emoji);else store.run('INSERT INTO reactions(message_id,user_id,emoji) VALUES(?,?,?)',row.id,userId,emoji);}
        else if(!match[2]&&method==='PATCH'){if(row.user_id!==userId)v.fail(403,'AUTHOR_REQUIRED');if(row.deleted)v.fail(409,'MESSAGE_DELETED');const b=await body(req);store.authorize(row.room_id,userId);store.run('UPDATE messages SET text=?,edited_at=? WHERE id=?',v.text(b.text,'message',2000),now(),row.id);}
        else if(!match[2]&&method==='DELETE'){if(row.user_id!==userId&&!MODERATE.includes(auth.role))v.fail(403,'AUTHOR_REQUIRED');store.run('UPDATE messages SET text=?,deleted=1,edited_at=? WHERE id=?','',now(),row.id);store.run('DELETE FROM reactions WHERE message_id=?',row.id);}
        else v.fail(405,'METHOD_NOT_ALLOWED');
        const message=store.message(store.get('SELECT * FROM messages WHERE id=?',row.id),userId);emitRoom(row.room_id,'message',{roomId:row.room_id,message});return send(res,200,{message});
      }
      if(path==='/api/users'&&method==='GET')return send(res,200,{users:s.current_room_id?(store.isPublicGuest(userId)?guestPresence(s.current_room_id,userId):store.members(s.current_room_id)):[]});
      if(path==='/api/conversations'&&method==='GET') {const messages=store.all('SELECT * FROM direct_messages WHERE sender_id=? OR recipient_id=? ORDER BY created_at DESC LIMIT 1000',userId,userId),seen=new Set(),conversations=[];for(const m of messages){const peerId=m.sender_id===userId?m.recipient_id:m.sender_id;if(seen.has(peerId))continue;seen.add(peerId);conversations.push({user:store.user(peerId),userId:peerId,lastMessage:dmMessage(m)});}return send(res,200,{conversations});}
      match=path.match(/^\/api\/dm\/([A-Za-z0-9_-]+)\/messages$/);
      if(match&&['GET','POST'].includes(method)) {
        const targetId=match[1];const history=method==='GET'&&store.get('SELECT 1 FROM direct_messages WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?) LIMIT 1',userId,targetId,targetId,userId);if(!history)dmAllowed(userId,targetId);
        if(method==='GET')return send(res,200,{messages:store.all('SELECT * FROM (SELECT * FROM direct_messages WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?) ORDER BY created_at DESC LIMIT 100) ORDER BY created_at',userId,targetId,targetId,userId).map(dmMessage)});
        limit(`dm:${userId}`,30);const b=await body(req);dmAllowed(userId,targetId);const content=v.text(b.text,'message',2000),operation=b.clientOperationId===undefined?null:v.id(b.clientOperationId,'clientOperationId');if(operation){const prior=store.get('SELECT * FROM direct_messages WHERE sender_id=? AND client_operation_id=?',userId,operation);if(prior){if(prior.recipient_id!==targetId||prior.text!==content)v.fail(409,'OPERATION_REUSED');return send(res,200,{message:dmMessage(prior),duplicate:true});}}const messageId=randomUUID();store.run('INSERT INTO direct_messages(id,sender_id,recipient_id,text,created_at,client_operation_id) VALUES(?,?,?,?,?,?)',messageId,userId,targetId,content,now(),operation);const message=dmMessage(store.get('SELECT * FROM direct_messages WHERE id=?',messageId));emitUser(userId,'dm',{message});emitUser(targetId,'dm',{message});return send(res,201,{message});
      }
      if(path==='/api/presence'&&method==='POST') {
        const arrivalFence=arrivals.captureFence(s);
        const requestFence=proximityControls?.beginPresence(s);
        try{
        const isGuest=store.isPublicGuest(userId),motionFence=isGuest?null:media.beginControlledPresence(s);
        const b=await body(req),roomId=v.id(b.roomId),live=arrivals.checkFence(s,arrivalFence);arrivals.authorizeMovement(live,b);store.authorize(roomId,userId);if(live.current_room_id!==roomId||s.current_room_id!==live.current_room_id)v.fail(403,'JOIN_REQUIRED');proximityControls?.checkPresence(live,requestFence);if(isGuest){if(b.followLeaseId!==undefined)v.fail(409,'STALE_FOLLOW_LEASE');}else media.authorizeControlledPresence(live,b,motionFence);
        const fields={};for(const k of ['x','z'])if(b[k]!==undefined)fields[k]=v.finite(b[k],k);if(b.direction!==undefined)fields.direction=v.integer(b.direction,'direction',0,3);if(b.moving!==undefined)fields.moving=v.boolean(b.moving,'moving');if(b.running!==undefined)fields.running=v.boolean(b.running,'running');if(b.velocity!==undefined){v.record(b.velocity,'velocity');fields.velocity={x:v.finite(b.velocity.x,'velocity.x',-32,32),z:v.finite(b.velocity.z,'velocity.z',-32,32)};}if(b.rotation!==undefined)fields.rotation=v.finite(b.rotation,'rotation');if(b.status!==undefined)fields.status=v.oneOf(b.status,STATUS,'status');if(b.emote!==undefined)fields.emote=b.emote===null||b.emote===''?null:v.text(b.emote,'emote',32);
        const movementScene=store.room(roomId,userId).scene;Object.assign(fields,readPresenceMotion(b,{scene:movementScene,previous:presence.get(`${roomId}:${userId}`),presence,userId,roomId,now:now()}));const bounds=movementScene.bounds;if(bounds){for(const [axis,dim]of[['x','width'],['z','depth']])if(fields[axis]!==undefined&&Number.isFinite(bounds[dim])&&Math.abs(fields[axis])>bounds[dim]/2+1)v.fail(400,'OUT_OF_BOUNDS','Position is outside the room');}
        const previous=presence.get(`${roomId}:${userId}`);if(fields.emote&&fields.emote!==previous?.emote)fields.emoteAt=now();putPresence(userId,roomId,fields);expressions.movement(roomId,userId,previous,presence.get(`${roomId}:${userId}`));quests.observeMovement(userId,roomId,previous,presence.get(`${roomId}:${userId}`));if(fields.emote&&fields.emote!==previous?.emote)quests.observeWave(userId,roomId,fields.emote);return send(res,200,{ok:true,presence:presence.get(`${roomId}:${userId}`)});
        }finally{proximityControls?.endPresence(requestFence);}
      }
      if(path==='/api/proximity-controls'&&method==='GET')return send(res,200,proximityControls?proximityControls.context(s,url.searchParams.get('connectionId')):{protocol:'proximity-controls-v1',available:false,reason:'disabled'});
      if(path==='/api/proximity-controls/action'&&method==='POST'){if(!proximityControls)v.fail(404,'PROXIMITY_CONTROLS_DISABLED');const fence=proximityControls.begin(s),b=await readControlBody(req),live=session(req);if(live.token_hash!==s.token_hash||live.user_id!==userId||live.current_room_id!==s.current_room_id)v.fail(409,'STALE_CONTROL_ADMISSION');const result=proximityControls.action(live,b,fence);media.refresh(live.current_room_id);proximityText?.refresh(live.current_room_id);return send(res,200,result);}
      if(path==='/api/proximity-text'&&method==='GET')return send(res,200,proximityText?proximityText.context(s,url.searchParams.get('connectionEpoch')):{protocol:'proximity-text-v1',available:false,canSend:false,reason:'disabled'});
      if(path==='/api/proximity-text/messages'&&method==='POST'){if(!proximityText)v.fail(404,'PROXIMITY_TEXT_DISABLED');const batch=proximityText.begin(s),b=await readProximityTextBody(req),live=session(req);if(live.token_hash!==s.token_hash||live.user_id!==userId||live.current_room_id!==s.current_room_id)v.fail(409,'STALE_PROXIMITY_TEXT_CONTEXT');const result=proximityText.send(live,b,batch);return send(res,result.duplicate?200:201,result);}
      if(path==='/api/proximity-text/typing'&&method==='POST'){if(!proximityText)v.fail(404,'PROXIMITY_TEXT_DISABLED');const batch=proximityText.typing.begin(s),b=await readProximityTypingBody(req),live=session(req);if(live.token_hash!==s.token_hash||live.user_id!==userId||live.current_room_id!==s.current_room_id)v.fail(409,'STALE_PROXIMITY_TEXT_CONTEXT');return send(res,200,proximityText.typing.update(live,b,batch));}
      if(path==='/api/media'&&method==='GET')return send(res,200,ice.decorate(s,media.policy(userId,s.current_room_id,s)));
      if(path==='/api/media/state'&&method==='POST'){const fence=arrivals.captureFence(s),b=await body(req);const live=session(req);v.boolean(b.enabled,'enabled');
        // A delayed body must not rebind an old gesture to the session's new room.
        // Configured proximity additionally binds the current own admission.
        if((proximityMembershipConfig!==undefined||b.roomId!==undefined)&&b.roomId!==live.current_room_id)v.fail(403,'STALE_MEDIA_CONTEXT','Media consent belongs to a different room');
        if(proximityMembershipConfig!==undefined){const before=media.policy(userId,live.current_room_id,live),memberId=before.proximityMembership?.memberId;if((before.context.kind==='proximity'||b.memberId!==undefined)&&(!memberId||b.memberId!==memberId))v.fail(403,'STALE_MEDIA_ADMISSION','Media consent belongs to a different admission');}
        arrivals.checkFence(s,fence);ice.optIn(live,b.enabled);const policy=media.state(userId,live.current_room_id,b.enabled,live);quests.reconcileRoom(live.current_room_id);return send(res,200,ice.decorate(live,policy));}
      if(path==='/api/media/ice'&&method==='POST'){ice.begin(s);const b=await readIceBody(req),live=session(req);if(live.token_hash!==s.token_hash||live.user_id!==userId)v.fail(401,'AUTH_REQUIRED');return send(res,200,ice.issue(live,b),{'Pragma':'no-cache'});}
      if(path==='/api/media/signal'&&method==='POST'){limit(`signal:${userId}`,240);const b=await body(req);const live=session(req);return send(res,200,media.signal(userId,live.current_room_id,b,live));}
      if(path==='/api/signal')v.fail(410,'USE_MEDIA_SIGNAL','Use the area-authorized /api/media/signal endpoint');
      if(path==='/api/events'&&method==='GET') {
        const live=session(req);let reconnectArrival=null;const previous=presence.get(`${live.current_room_id}:${userId}`);if(live.current_room_id&&(!previous?.admissionId||now()-previous.lastSeen>=60000)){if(!store.isPublicGuest(userId))media.assertAdmission(live,live.current_room_id);reconnectArrival=arrivals.prepare(live.current_room_id,userId,{resume:true});}
        let clients=connections.get(s.token_hash);if(!clients){clients=new Set();connections.set(s.token_hash,clients);}if(clients.size>=4)v.fail(429,'TOO_MANY_CONNECTIONS');
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write(': connected\n\n');
        streamCapabilities.set(res,imageProtocol.accepts(req));streamScopes.set(res,{token:live.token_hash,roomId:live.current_room_id});
        const client={res,userId};clients.add(client);quests.disconnected(userId,s.current_room_id);sse(res,'hello',{user:store.user(userId),currentRoomId:s.current_room_id,serverTime:now(),arrivalEpoch:arrivals.epoch,...imageProtocol.status()});if(live.current_room_id){const fields=reconnectArrival?arrivals.commit(live.current_room_id,userId,reconnectArrival):null;sessionRoles.set(live.token_hash,store.role(store.roomRow(live.current_room_id),userId));putPresence(userId,live.current_room_id,fields?{x:fields.x,z:fields.z,admissionId:fields.admissionId,admissionEpoch:fields.admissionEpoch,admissionRevision:fields.admissionRevision,...(!fields.resumed?{y:0,verticalVelocity:0,grounded:true,seatId:null,seatHeight:0,moving:false,running:false,velocity:{x:0,z:0},emote:null}:{})}:{});sse(res,'bots',{roomId:live.current_room_id,bots:bots.snapshot(live.current_room_id)});}
        if(!store.isPublicGuest(userId)){proximityText?.register(s.token_hash,client);proximityControls?.register(s.token_hash,client);}
        req.on('close',()=>{proximityControls?.disconnect(client);proximityText?.disconnect(client);quests.disconnected(userId,s.current_room_id);clients.delete(client);if(!clients.size)connections.delete(s.token_hash);});return;
      }
      v.fail(404,'NOT_FOUND','API endpoint not found');
    } catch(e) { if(e.status===429&&Number.isSafeInteger(e.retryAfter)&&e.retryAfter>=1&&e.retryAfter<=60)res.setHeader('Retry-After',String(e.retryAfter));if(e.status)send(res,e.status,{error:e.code,code:e.code,message:e.message,...e.details});else{console.error('Request failed:',e);send(res,500,{error:'SERVER_ERROR',code:'SERVER_ERROR',message:'The server could not complete the request'});} }
  });
  const heartbeat=setInterval(()=>{
    if(closed)return;expressions.prune();ice.prune();media.sweep();proximityText?.refresh();proximityControls?.refresh();
    for(const [token,clients] of connections){if(!sessionPrincipal(store,token,now())){for(const client of clients)client.res.end();connections.delete(token);}else for(const client of clients)if(!client.res.destroyed)client.res.write(': heartbeat\n\n');}
    arrivals.sweep();
    const changed=new Set();for(const[key,p]of presence)if(now()-p.lastSeen>60000){presence.delete(key);changed.add(p.roomId);}for(const room of changed)broadcastPresence(room);
    for(const[key,bucket]of rates)if(now()-bucket.start>120000)rates.delete(key);
    pruneGuests();store.run('DELETE FROM sessions WHERE expires_at<?',now());
  },15000);heartbeat.unref();
  server.requestTimeout=15000;server.headersTimeout=10000;
  return {server,store,presence,setImagePhysicalSizeEnabledForTest:value=>imageProtocol.setEnabledForTest(value),listen(port=runtimeConfig.port){setup.assertReady();return new Promise((resolve,reject)=>{const onError=error=>reject(error);server.once('error',onError);server.listen(port,host,()=>{server.off('error',onError);resolve(server.address());});});},async close(){closed=true;await residentTurns?.close();bots.close();proximityControls?.close();proximityText?.close();media.close();clearInterval(heartbeat);for(const clients of connections.values())for(const client of clients)client.res.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();}};
}
