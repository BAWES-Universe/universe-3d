import http from 'node:http';
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { Store } from './store.mjs';
import * as v from './validation.mjs';
import { createMediaPolicy } from './media.mjs';
import { createQuestService } from './quests.mjs';
import { createRoomFileService } from './files.mjs';
import {validateAppearance} from '../src/avatar-spec.js';
import { createExpressionService } from './expressions.mjs';
import { createHierarchyService } from './hierarchy.mjs';
import {createPersonalAreaService} from './personal-areas.mjs';
import {validatePersonalScene} from './personal-area-store.mjs';
import {createActionAuthority} from './action-authority.mjs';
import {createBotService} from './bots.mjs';
import {readRuntimeConfig,createRequestSecurity} from './runtime-config.mjs';
import {createAccessGate} from './access-gate.mjs';
import {createRoomImageAssets} from './image-asset-context.mjs';
import {validateImageSceneDelta} from './image-scene-authority.mjs';

const passwordHash = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const COOKIE = 'universe_session';
const SESSION_MS = 30 * 86400000;
const EDIT = ['owner', 'admin', 'editor'];
const MODERATE = ['owner', 'admin', 'moderator'];
const EMOJI = ['👍','❤️','😂','🎉','👋','✨','🔥','💯','👏','🤔','🙌','😮','😊','💜','✅','🎸','💃','🕺','🏳️'];
const STATUS = ['online','away','busy','dnd','invisible'];
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2','.glb':'model/gltf-binary','.mp3':'audio/mpeg','.ogg':'audio/ogg','.wav':'audio/wav','.mp4':'video/mp4' };

export function createGameServer({ database = ':memory:', seeds = [], dist = resolve('dist'), runtimeConfig = readRuntimeConfig({}), host = runtimeConfig.host, clock = Date.now, questsEnabled = true } = {}) {
  // The reusable test/server factory never inherits ambient deployment env.
  // The process entry point alone parses it and passes this explicit contract.
  if(host!==runtimeConfig.host)throw new Error('Configure the bind address through runtimeConfig');
  const store = new Store(database, seeds, clock, {claimUnownedOnCreate:runtimeConfig.mode==='local'});
  const accessGate=createAccessGate({store,config:runtimeConfig});
  try{accessGate.assertReady();}catch(error){store.close();throw error;}
  const requestSecurity=createRequestSecurity(runtimeConfig,{listeningPort:()=>server.address()?.port});
  const connections = new Map();
  const presence = new Map();
  const rates = new Map();
  const sessionRoles=new Map();
  let closed = false;
  const now = () => clock();
  function limit(key, max, span = 60000) {
    const t = now(); let bucket = rates.get(key);
    if (!bucket || bucket.start + span < t) { bucket = { start: t, n: 0 }; rates.set(key,bucket); }
    if (++bucket.n > max) v.fail(429, 'RATE_LIMITED', 'Please slow down and try again shortly');
  }
  function send(res, status, data, headers = {}) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers }); res.end(JSON.stringify(data));
  }
  function sse(res, event, data) { if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  function emitUser(userId,event,data) { for (const [token,clients] of connections) { const session=store.get('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?',token,now()); if(session?.user_id===userId)for(const client of clients)sse(client.res,event,data); } }
  function emitRoom(roomId,event,data) {
    for (const [token, clients] of connections) {
      const session = store.get('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?', token,now());
      if (!session || session.current_room_id !== roomId) continue;
      const row = store.roomRow(roomId); if (!store.canSeeRoom(row,session.user_id)) continue;
      for (const client of clients) sse(client.res,event,data.room?{...data,room:store.room(row,session.user_id,!!data.room.scene)}:data);
    }
  }
  function getPresence(roomId) { return [...presence.values()].filter(p => p.roomId === roomId && now() - p.lastSeen < 60000); }
  function snapshot(roomId,userId) { return { room:store.room(roomId,userId),members:store.members(roomId),presence:getPresence(roomId),bots:bots.snapshot(roomId),botPermissions:bots.capabilities(roomId,userId),messages:store.messages(roomId,userId) }; }
  function broadcastPresence(roomId) { if (roomId) { bots.reconcileRoom(roomId);emitRoom(roomId,'presence',{roomId,presence:getPresence(roomId)}); media.refresh(roomId); quests.reconcileRoom(roomId); } }
  function putPresence(userId,roomId,fields = {}) {
    store.authorize(roomId,userId);
    const key = `${roomId}:${userId}`, old = presence.get(key) || {};
    const spawn = store.room(roomId,userId).scene.spawn || { x:0,z:0 };
    presence.set(key,{...store.user(userId),roomId,x:spawn.x || 0,z:spawn.z || 0,moving:false,emote:null,...old,...fields,id:userId,userId,roomId,lastSeen:now()});
    broadcastPresence(roomId);
  }
  function leave(token,userId) {
    const old = store.get('SELECT current_room_id FROM sessions WHERE token_hash=?',token)?.current_room_id;
    store.run('UPDATE sessions SET current_room_id=NULL WHERE token_hash=?', token);
    images.sessionChanged(token);
    if (old && !store.get('SELECT 1 FROM sessions WHERE user_id=? AND current_room_id=? AND token_hash!=? AND expires_at>?',userId,old,token,now())) presence.delete(`${old}:${userId}`);
    if(!presence.has(`${old}:${userId}`))expressions.clear(old,userId);quests.disconnected(userId,old); media.leave(userId,old); broadcastPresence(old);
  }
  function cookie(token, req, clear = false) { return `${COOKIE}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_MS / 1000}${requestSecurity.secureCookie(req) ? '; Secure' : ''}`; }
  function createSession(userId,req,res) {
    const token = randomBytes(32).toString('base64url'), tokenHash = digest(token);
    store.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',tokenHash,userId,now()+SESSION_MS);
    res.setHeader('Set-Cookie',cookie(token,req)); return { token_hash: tokenHash,user_id:userId,current_room_id:null };
  }
  function session(req, required = true) {
    const token = String(req.headers.cookie || '').split(';').map(p => p.trim()).find(p => p.startsWith(`${COOKIE}=`))?.slice(COOKIE.length+1);
    const row = token && /^[A-Za-z0-9_-]{43}$/.test(token) ? store.get('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?',digest(token),now()) : null;
    if (!row && required) v.fail(401,'AUTH_REQUIRED',runtimeConfig.mode==='public'?'Sign in with an operator-provisioned account first':'Create a guest profile or sign in first');
    if(row?.current_room_id){let permitted=false;try{permitted=store.canSeeRoom(store.roomRow(row.current_room_id),row.user_id);}catch{}if(!permitted){const old=row.current_room_id;store.run('UPDATE sessions SET current_room_id=NULL WHERE token_hash=?',row.token_hash);images.sessionChanged(row.token_hash);row.current_room_id=null;sessionRoles.delete(row.token_hash);presence.delete(`${old}:${row.user_id}`);}}
    return row;
  }
  function sessionState(s) { return { user:store.user(s.user_id),worlds:store.worlds(s.user_id),rooms:store.worlds(s.user_id).flatMap(w => w.rooms),currentRoomId:s.current_room_id }; }
  function join(roomId,s) {
    store.authorize(roomId,s.user_id);
    leave(s.token_hash,s.user_id);
    store.run('UPDATE sessions SET current_room_id=? WHERE token_hash=?',roomId,s.token_hash);
    sessionRoles.set(s.token_hash,store.role(store.roomRow(roomId),s.user_id));
    putPresence(s.user_id,roomId);
    emitRoom(roomId,'members',{roomId,members:store.members(roomId)});
    return snapshot(roomId,s.user_id);
  }
  async function body(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) v.fail(415,'JSON_REQUIRED','Use Content-Type: application/json');
    const chunks=[]; let n=0;
    for await (const chunk of req) { n+=chunk.length; if (n>600000) v.fail(413,'TOO_LARGE','Request is too large'); chunks.push(chunk); }
    try { const result=v.record(JSON.parse(Buffer.concat(chunks).toString('utf8')));const path=new URL(req.url,'http://127.0.0.1').pathname;if(!(req.method==='POST'&&['/api/session','/api/login'].includes(path)))session(req);return result; } catch(e) { if(e.status) throw e; v.fail(400,'INVALID_JSON','The request body is not valid JSON'); }
  }
  function originCheck(req) {
    requestSecurity.assertRequest(req);
  }
  function dmAllowed(actorId,targetId) {
    if (actorId===targetId || !store.user(targetId)) v.fail(404,'USER_NOT_FOUND','Choose another player');
    const rooms=new Set(store.all('SELECT a.current_room_id AS room_id FROM sessions a JOIN sessions b ON b.current_room_id=a.current_room_id WHERE a.user_id=? AND b.user_id=? AND a.expires_at>? AND b.expires_at>?',actorId,targetId,now(),now()).map(r=>r.room_id));
    for(const r of store.all('SELECT r.id AS room_id FROM rooms r JOIN world_members a ON a.world_id=r.world_id JOIN world_members b ON b.world_id=r.world_id WHERE a.user_id=? AND b.user_id=?',actorId,targetId))rooms.add(r.room_id);
    const shared=[...rooms].some(id=>{try{const r=store.roomRow(id);return store.canSeeRoom(r,actorId)&&store.canSeeRoom(r,targetId);}catch{return false;}});
    if (!shared) v.fail(403,'DM_FORBIDDEN','You must share a room or world membership to send a direct message');
  }
  function dmMessage(row) { return { id:row.id,userId:row.sender_id,senderId:row.sender_id,recipientId:row.recipient_id,author:store.user(row.sender_id),text:row.text,createdAt:row.created_at }; }
  function emitMediaUser(userId,event,data) {
    for(const [token,clients] of connections) {
      const session=store.get('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?',token,now());
      if(!session || session.user_id!==userId || session.current_room_id!==data.roomId)continue;
      for(const client of clients)sse(client.res,event,data);
    }
  }
  const media=createMediaPolicy({store,presence,emitUser:emitMediaUser,now});
  const quests=createQuestService({store,presence,media,emitUser,now,enabled:questsEnabled});
  const expressions=createExpressionService({store,presence,emitRoom,now,limit});
  const files=createRoomFileService({store,now,send,session});
  const images=createRoomImageAssets({store,session,now,emitRoom});
  function policyChanged(reason,force={}) {
    const affected=new Set(),revoked=new Set();
    for(const s of store.all('SELECT * FROM sessions WHERE current_room_id IS NOT NULL AND expires_at>?',now())){
      const roomId=s.current_room_id;let row,role;try{row=store.roomRow(roomId);role=store.role(row,s.user_id);}catch{}
      const forced=force.userId===s.user_id&&force.worldId===row?.world_id;
      if(!row||!store.canSeeRoom(row,s.user_id)||forced){
        store.run('UPDATE sessions SET current_room_id=NULL WHERE token_hash=?',s.token_hash);images.sessionChanged(s.token_hash);sessionRoles.delete(s.token_hash);presence.delete(`${roomId}:${s.user_id}`);affected.add(roomId);
        const key=`${roomId}:${s.user_id}`;if(!revoked.has(key)){revoked.add(key);quests.disconnected(s.user_id,roomId);expressions.clear(roomId,s.user_id);emitUser(s.user_id,'access-revoked',{roomId,reason,recoverDraft:true});emitUser(s.user_id,'media-policy',{selfId:s.user_id,roomId:null,enabled:false,context:{kind:'none',label:'Access ended',canPublish:false,reason:'Room access changed'},peers:[],iceServers:[]});}
      }else{
        const oldRole=sessionRoles.get(s.token_hash);sessionRoles.set(s.token_hash,role);const room=store.room(row,s.user_id);
        emitUser(s.user_id,'role',{roomId,role,room,capabilities:room.capabilities,recoverDraft:EDIT.includes(oldRole)&&!EDIT.includes(role)});affected.add(roomId);
      }
    }
    for(const key of revoked){const split=key.lastIndexOf(':');media.leave(key.slice(split+1),key.slice(0,split));}
    for(const roomId of affected)broadcastPresence(roomId);
    for(const s of store.all('SELECT DISTINCT user_id FROM sessions WHERE expires_at>?',now()))emitUser(s.user_id,'catalog',{reason});
  }
  const bots=createBotService({store,presence,body,send,session,emitRoom,now});
  const hierarchy=createHierarchyService({store,now,body,send,changed:policyChanged,emitUser});
  const personalAreas=createPersonalAreaService({store,presence,body,send,session,emitRoom,emitUser,now});
  const actionAuthority=createActionAuthority({store,presence,body,send,now});
  const server=http.createServer(async(req,res) => {
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','same-origin'); res.setHeader('X-Frame-Options','DENY');
    try {
      const url=new URL(req.url,'http://127.0.0.1'); const path=url.pathname; const method=req.method;
      originCheck(req);
      if (!path.startsWith('/api/')) {
        if (!['GET','HEAD'].includes(method)) v.fail(405,'METHOD_NOT_ALLOWED');
        const requested=decodeURIComponent(path), rel=requested==='/'?'index.html':requested.slice(1);
        if (rel.split('/').some(part=>part==='..'||part.startsWith('.'))) v.fail(404,'NOT_FOUND');
        let filename=resolve(dist,rel); if(filename!==resolve(dist) && !filename.startsWith(resolve(dist)+sep)) v.fail(404,'NOT_FOUND');
        try { if (!(await stat(filename)).isFile()) v.fail(404,'NOT_FOUND'); } catch(e) { if(!extname(rel)) filename=resolve(dist,'index.html'); else v.fail(404,'NOT_FOUND'); }
        const bytes=await readFile(filename);
        res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https:; media-src 'self' blob: https:; connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-src https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
        res.writeHead(200,{'Content-Type':MIME[extname(filename)] || 'application/octet-stream','Cache-Control':'no-cache'}); res.end(method==='HEAD'?undefined:bytes); return;
      }
      if(path==='/api/health'&&method==='GET') return send(res,200,{ok:true,persistence:'sqlite',identity:'httpOnly-session',scope:runtimeConfig.mode==='public'?'standalone-private-preview':'standalone-local'});
      if(path==='/api/access'&&method==='GET')return send(res,200,accessGate.publicPolicy());
      if(path==='/api/session'&&method==='POST') {
        limit(`guest:${req.socket.remoteAddress}`,60);
        const b=await body(req); const existing=session(req,false);
        if(existing) return send(res,200,sessionState(existing));
        accessGate.assertGuestCreationAllowed();
        const user=store.createUser(v.text(b.name ?? 'Explorer','name',40),b.appearance!==undefined?JSON.stringify(validateAppearance(b.appearance)):v.woka(b.woka ?? 0));
        return send(res,201,sessionState(createSession(user.id,req,res)));
      }
      if(path==='/api/login'&&method==='POST') {
        limit(`login:${req.socket.remoteAddress}`,12);
        const b=await body(req); const username=v.text(b.username,'username',32).toLowerCase();
        const password=v.text(b.password,'password',256);
        const account=store.get('SELECT * FROM accounts WHERE username=?',username);
        const result=await passwordHash(password,account?.salt || '00000000000000000000000000000000',64);
        if(!account || !timingSafeEqual(Buffer.from(account.password_hash,'hex'),result)) v.fail(401,'INVALID_CREDENTIALS','Incorrect username or password');
        const old=session(req,false); if(old){leave(old.token_hash,old.user_id);store.run('DELETE FROM sessions WHERE token_hash=?',old.token_hash);}
        return send(res,200,sessionState(createSession(account.user_id,req,res)));
      }
      const s=session(req); const userId=s.user_id;
      limit(`requests:${s.token_hash}`,1200);
      if(await images.handle(req,res))return;
      if(await personalAreas.handle({req,res,path,method,userId,url}))return;
      if(await actionAuthority.handle({req,res,path,method,userId,session:s}))return;
      if(await bots.handle({req,res,path,method,userId,session:s}))return;
      if(await hierarchy.handle({req,res,path,method,userId,url}))return;
      if(await files.handle({req,res,path,method,userId,url}))return;
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
        const password=v.text(b.password,'password',256); if(password.length<10) v.fail(400,'WEAK_PASSWORD','Use at least 10 characters');
        if(store.user(userId).account) v.fail(409,'ALREADY_REGISTERED','This profile already has an account');
        if(store.get('SELECT 1 FROM accounts WHERE username=?',username)) v.fail(409,'USERNAME_TAKEN','That username is already used');
        const salt=randomBytes(16).toString('hex'), hash=await passwordHash(password,salt,64);
        try{store.run('INSERT INTO accounts(username,user_id,salt,password_hash) VALUES(?,?,?,?)',username,userId,salt,hash.toString('hex'));}catch{v.fail(409,'USERNAME_TAKEN','That username is already used');}
        return send(res,201,{user:store.user(userId)});
      }
      if(path==='/api/logout'&&method==='POST') { leave(s.token_hash,userId); store.run('DELETE FROM sessions WHERE token_hash=?',s.token_hash); for(const c of connections.get(s.token_hash)||[])c.res.end();connections.delete(s.token_hash); return send(res,200,{ok:true},{'Set-Cookie':cookie('',req,true)}); }
      let match;
      match=path.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)(?:\/(join|leave|scene|messages|emote|moderate|invites|expression|expressions))?$/);
      if(match) {
        const roomId=match[1],action=match[2];
        if(action==='join'&&method==='POST') return send(res,200,join(roomId,s));
        const auth=store.authorize(roomId,userId);
        if(!action&&method==='GET') return send(res,200,snapshot(roomId,userId));
        if(action==='leave'&&method==='POST'){leave(s.token_hash,userId);return send(res,200,{ok:true});}
        if(action==='expression'&&method==='POST'){const b=await body(req),active=session(req);const result=expressions.post(roomId,userId,active.current_room_id,b);return send(res,result.duplicate?200:201,result);}
        if(action==='expressions'&&method==='GET')return send(res,200,expressions.list(roomId,userId,session(req).current_room_id));
        if(action==='scene'&&method==='PUT') {
          const imageSessionEpoch=images.sessionEpoch(s.token_hash);
          const b=await body(req);if(!store.roomCapabilities(store.authorize(roomId,userId).row,userId).canBuild)v.fail(403,'ROOM_FORBIDDEN','You do not have permission to build in this room');for(const key of Object.keys(b))if(!['revision','scene','personalAreaRevisions'].includes(key))v.fail(400,'IMMUTABLE_FIELD',`${key} cannot be set here`);v.integer(b.revision,'revision');
          // Re-check room and scoped ownership after body streaming, under the same
          // SQLite write lock as CAS, geometry validation and provenance writes.
          let questChanges=[];const room=store.transaction(()=>{
            const live=session(req);if(live.user_id!==userId)v.fail(401,'AUTH_REQUIRED');
            const {row}=store.authorize(roomId,userId),before=JSON.parse(row.scene);
            if(row.revision!==b.revision)v.fail(409,'REVISION_CONFLICT','The room changed. Review the latest scene before saving.',{room:store.room(roomId,userId)});
            const resolvedImages=images.resolveScenePair({roomId,userId,token:live.token_hash,before,next:b.scene,expectedEpoch:imageSessionEpoch});
            const encoded=v.scene(b.scene,resolvedImages.next);validatePersonalScene(b.scene);
            store.validatePersonalObjectDelta(row,userId,before,b.scene,b.personalAreaRevisions,resolvedImages.before,resolvedImages.next);
            validateImageSceneDelta({store,presence,now,room:row,before,next:b.scene,beforeImages:resolvedImages.before,nextImages:resolvedImages.next});
            store.syncPersonalAreas(roomId,before,b.scene);
            store.run('UPDATE rooms SET scene=?,revision=revision+1 WHERE id=? AND revision=?',encoded,roomId,b.revision);
            store.recordPersonalObjects(roomId,userId,before,b.scene,resolvedImages.next);
            const saved=store.room(roomId,userId);if(EDIT.includes(saved.role))questChanges=quests.observeBuild(userId,roomId,before,saved.scene,saved.revision);return saved;
          });quests.notify(questChanges);
          emitRoom(roomId,'scene',{roomId,room,actorId:userId});bots.reconcileRoom(roomId);media.refresh(roomId);quests.reconcileRoom(roomId);return send(res,200,{room});
        }
        if(action==='messages'&&method==='GET') { const before=url.searchParams.has('before')?Number(url.searchParams.get('before')):Number.MAX_SAFE_INTEGER;v.integer(before,'before');return send(res,200,store.messagesPage(roomId,userId,{before,cursor:url.searchParams.get('cursor')})); }
        if(action==='messages'&&method==='POST') {
          limit(`chat:${userId}`,40);const b=await body(req);const fresh=store.authorize(roomId,userId);if(fresh.member?.muted_until>now())v.fail(403,'MUTED','You are temporarily muted in this room');
          const content=v.text(b.text,'message',2000),operation=b.clientOperationId===undefined?null:v.id(b.clientOperationId,'clientOperationId');
          if(operation){const prior=store.get('SELECT * FROM messages WHERE user_id=? AND client_operation_id=?',userId,operation);if(prior){if(prior.room_id!==roomId||prior.text!==content)v.fail(409,'OPERATION_REUSED','This operation ID has already been used for another message');return send(res,200,{message:store.message(prior,userId),duplicate:true});}}
          const messageId=randomUUID();store.run('INSERT INTO messages(id,room_id,user_id,text,created_at,client_operation_id) VALUES(?,?,?,?,?,?)',messageId,roomId,userId,content,now(),operation);const message=store.message(store.get('SELECT * FROM messages WHERE id=?',messageId),userId);
          emitRoom(roomId,'message',{roomId,message});return send(res,201,{message});
        }
        if(action==='emote'&&method==='POST') {const b=await body(req);if(s.current_room_id!==roomId)v.fail(403,'JOIN_REQUIRED');const emote=v.text(b.emoji??b.emote,'emote',32);putPresence(userId,roomId,{emote,emoteAt:now()});quests.observeWave(userId,roomId,emote);return send(res,200,{ok:true});}
        if(action==='moderate'&&method==='POST') {
          const b=await body(req);const targetId=v.id(b.userId,'userId'),actionName=v.oneOf(b.action,['mute','unmute','kick','ban','unban'],'action');store.authorize(roomId,userId,MODERATE);const targetRole=store.role(auth.row,targetId);
          if(!store.user(targetId))v.fail(404,'USER_NOT_FOUND');if(targetId===userId||['owner','admin'].includes(targetRole)||(!['owner','admin'].includes(auth.role)&&targetRole==='moderator'))v.fail(403,'PROTECTED_MEMBER','You cannot moderate this player');
          store.run('INSERT OR IGNORE INTO members(room_id,user_id,role,granted) VALUES(?,?,?,0)',roomId,targetId,'member');
          if(actionName==='mute'||actionName==='unmute'){const minutes=b.minutes===undefined?10:v.integer(b.minutes,'minutes',1,1440);store.run('UPDATE members SET muted_until=? WHERE room_id=? AND user_id=?',actionName==='mute'?now()+minutes*60000:0,roomId,targetId);}
          if(actionName==='ban'||actionName==='unban')store.run('UPDATE members SET banned=? WHERE room_id=? AND user_id=?',+(actionName==='ban'),roomId,targetId);
          if(actionName==='kick'||actionName==='ban'){emitUser(targetId,'moderation',{roomId,action:actionName,userId:targetId,actorId:userId});store.run('UPDATE sessions SET current_room_id=NULL WHERE current_room_id=? AND user_id=?',roomId,targetId);presence.delete(`${roomId}:${targetId}`);expressions.clear(roomId,targetId);media.leave(targetId,roomId);emitUser(targetId,'media-policy',{selfId:targetId,roomId:null,enabled:false,context:{kind:'none',canPublish:false},peers:[],iceServers:[]});broadcastPresence(roomId);}
          emitRoom(roomId,'members',{roomId,members:store.members(roomId)});return send(res,200,{ok:true,members:store.members(roomId)});
        }
      }
      match=path.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/members\/([A-Za-z0-9_-]+)$/);
      if(match&&['PUT','DELETE'].includes(method)) {
        const [_,roomId,targetId]=match,b=method==='PUT'?await body(req):{};const auth=store.authorize(roomId,userId,['owner','admin']);
        if(targetId===auth.row.universe_owner)v.fail(409,'PROTECTED_OWNER');if(!store.user(targetId))v.fail(404,'USER_NOT_FOUND');
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
      if(path==='/api/users'&&method==='GET')return send(res,200,{users:s.current_room_id?store.members(s.current_room_id):[]});
      if(path==='/api/conversations'&&method==='GET') {const messages=store.all('SELECT * FROM direct_messages WHERE sender_id=? OR recipient_id=? ORDER BY created_at DESC LIMIT 1000',userId,userId),seen=new Set(),conversations=[];for(const m of messages){const peerId=m.sender_id===userId?m.recipient_id:m.sender_id;if(seen.has(peerId))continue;seen.add(peerId);conversations.push({user:store.user(peerId),userId:peerId,lastMessage:dmMessage(m)});}return send(res,200,{conversations});}
      match=path.match(/^\/api\/dm\/([A-Za-z0-9_-]+)\/messages$/);
      if(match&&['GET','POST'].includes(method)) {
        const targetId=match[1];const history=method==='GET'&&store.get('SELECT 1 FROM direct_messages WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?) LIMIT 1',userId,targetId,targetId,userId);if(!history)dmAllowed(userId,targetId);
        if(method==='GET')return send(res,200,{messages:store.all('SELECT * FROM (SELECT * FROM direct_messages WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?) ORDER BY created_at DESC LIMIT 100) ORDER BY created_at',userId,targetId,targetId,userId).map(dmMessage)});
        limit(`dm:${userId}`,30);const b=await body(req);dmAllowed(userId,targetId);const content=v.text(b.text,'message',2000),operation=b.clientOperationId===undefined?null:v.id(b.clientOperationId,'clientOperationId');if(operation){const prior=store.get('SELECT * FROM direct_messages WHERE sender_id=? AND client_operation_id=?',userId,operation);if(prior){if(prior.recipient_id!==targetId||prior.text!==content)v.fail(409,'OPERATION_REUSED');return send(res,200,{message:dmMessage(prior),duplicate:true});}}const messageId=randomUUID();store.run('INSERT INTO direct_messages(id,sender_id,recipient_id,text,created_at,client_operation_id) VALUES(?,?,?,?,?,?)',messageId,userId,targetId,content,now(),operation);const message=dmMessage(store.get('SELECT * FROM direct_messages WHERE id=?',messageId));emitUser(userId,'dm',{message});emitUser(targetId,'dm',{message});return send(res,201,{message});
      }
      if(path==='/api/presence'&&method==='POST') {
        const b=await body(req),roomId=v.id(b.roomId);store.authorize(roomId,userId);if(s.current_room_id!==roomId)v.fail(403,'JOIN_REQUIRED');
        const fields={};for(const k of ['x','z'])if(b[k]!==undefined)fields[k]=v.finite(b[k],k);if(b.direction!==undefined)fields.direction=v.integer(b.direction,'direction',0,3);if(b.moving!==undefined)fields.moving=v.boolean(b.moving,'moving');if(b.running!==undefined)fields.running=v.boolean(b.running,'running');if(b.velocity!==undefined){v.record(b.velocity,'velocity');fields.velocity={x:v.finite(b.velocity.x,'velocity.x',-32,32),z:v.finite(b.velocity.z,'velocity.z',-32,32)};}if(b.rotation!==undefined)fields.rotation=v.finite(b.rotation,'rotation');if(b.status!==undefined)fields.status=v.oneOf(b.status,STATUS,'status');if(b.emote!==undefined)fields.emote=b.emote===null||b.emote===''?null:v.text(b.emote,'emote',32);
        const bounds=store.room(roomId,userId).scene.bounds;if(bounds){for(const [axis,dim]of[['x','width'],['z','depth']])if(fields[axis]!==undefined&&Number.isFinite(bounds[dim])&&Math.abs(fields[axis])>bounds[dim]/2+1)v.fail(400,'OUT_OF_BOUNDS','Position is outside the room');}
        const previous=presence.get(`${roomId}:${userId}`);putPresence(userId,roomId,fields);expressions.movement(roomId,userId,previous,presence.get(`${roomId}:${userId}`));quests.observeMovement(userId,roomId,previous,presence.get(`${roomId}:${userId}`));if(fields.emote&&fields.emote!==previous?.emote)quests.observeWave(userId,roomId,fields.emote);return send(res,200,{ok:true,presence:presence.get(`${roomId}:${userId}`)});
      }
      if(path==='/api/media'&&method==='GET')return send(res,200,media.policy(userId,s.current_room_id));
      if(path==='/api/media/state'&&method==='POST'){const b=await body(req);const policy=media.state(userId,session(req).current_room_id,b.enabled);quests.reconcileRoom(s.current_room_id);return send(res,200,policy);}
      if(path==='/api/media/signal'&&method==='POST'){limit(`signal:${userId}`,240);const b=await body(req);return send(res,200,media.signal(userId,session(req).current_room_id,b));}
      if(path==='/api/signal')v.fail(410,'USE_MEDIA_SIGNAL','Use the area-authorized /api/media/signal endpoint');
      if(path==='/api/events'&&method==='GET') {
        let clients=connections.get(s.token_hash);if(!clients){clients=new Set();connections.set(s.token_hash,clients);}if(clients.size>=4)v.fail(429,'TOO_MANY_CONNECTIONS');
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write(': connected\n\n');
        const client={res,userId};clients.add(client);quests.disconnected(userId,s.current_room_id);sse(res,'hello',{user:store.user(userId),currentRoomId:s.current_room_id,serverTime:now()});const live=session(req);if(live.current_room_id){sessionRoles.set(live.token_hash,store.role(store.roomRow(live.current_room_id),userId));putPresence(userId,live.current_room_id);sse(res,'bots',{roomId:live.current_room_id,bots:bots.snapshot(live.current_room_id)});}
        req.on('close',()=>{quests.disconnected(userId,s.current_room_id);clients.delete(client);if(!clients.size)connections.delete(s.token_hash);});return;
      }
      v.fail(404,'NOT_FOUND','API endpoint not found');
    } catch(e) { if(e.status)send(res,e.status,{error:e.code,code:e.code,message:e.message,...e.details});else{console.error('Request failed:',e);send(res,500,{error:'SERVER_ERROR',code:'SERVER_ERROR',message:'The server could not complete the request'});} }
  });
  const heartbeat=setInterval(()=>{
    if(closed)return;expressions.prune();
    for(const [token,clients] of connections){if(!store.get('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?',token,now())){for(const client of clients)client.res.end();connections.delete(token);}else for(const client of clients)if(!client.res.destroyed)client.res.write(': heartbeat\n\n');}
    const changed=new Set();for(const[key,p]of presence)if(now()-p.lastSeen>60000){presence.delete(key);changed.add(p.roomId);}for(const room of changed)broadcastPresence(room);
    for(const[key,bucket]of rates)if(now()-bucket.start>120000)rates.delete(key);
    store.run('DELETE FROM sessions WHERE expires_at<?',now());
  },15000);heartbeat.unref();
  server.requestTimeout=15000;server.headersTimeout=10000;
  return {server,store,presence,listen(port=runtimeConfig.port){accessGate.assertReady();return new Promise((resolve,reject)=>{const onError=error=>reject(error);server.once('error',onError);server.listen(port,host,()=>{server.off('error',onError);resolve(server.address());});});},async close(){closed=true;bots.close();clearInterval(heartbeat);for(const clients of connections.values())for(const client of clients)client.res.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();}};
}
