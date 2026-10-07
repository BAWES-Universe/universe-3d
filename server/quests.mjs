import { createHash, randomUUID } from 'node:crypto';
import * as v from './validation.mjs';
import { canStand, findPath, contains } from '../src/worlds.js';

// Independent local service. These private stamps have no currency, public rank,
// entitlement, partner authority or source-stack/Orbit identity semantics.
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
const inside = (area,p) => !!p && contains(area,p.x,p.z);
const EDIT = ['owner','admin','editor'];
export function createQuestService({store,presence,media,emitUser,now,enabled=true}) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS quest_preferences(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,declined_at INTEGER,invitation_seen_at INTEGER,tracked_attempt_id TEXT,signin_dismissed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS quest_attempts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,room_id TEXT NOT NULL,definition_id TEXT NOT NULL,version TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,objective TEXT NOT NULL,target TEXT,status TEXT NOT NULL DEFAULT 'accepted',accepted_at INTEGER NOT NULL,accepted_sequence INTEGER NOT NULL,completed_at INTEGER,UNIQUE(user_id,definition_id,version));
    CREATE INDEX IF NOT EXISTS quest_attempts_actor ON quest_attempts(user_id,status);
    CREATE TABLE IF NOT EXISTS quest_observations(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,room_id TEXT NOT NULL,kind TEXT NOT NULL,observed_at INTEGER NOT NULL,evidence TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS quest_applications(observation_id TEXT NOT NULL REFERENCES quest_observations(id),attempt_id TEXT NOT NULL REFERENCES quest_attempts(id),PRIMARY KEY(observation_id,attempt_id));
    CREATE TABLE IF NOT EXISTS quest_grants(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,attempt_id TEXT NOT NULL REFERENCES quest_attempts(id),rule TEXT NOT NULL,granted_at INTEGER NOT NULL,notice_claimed_at INTEGER,UNIQUE(attempt_id,rule));
  `);
  const bubbles=new Map();
  function preferences(userId) {
    store.run('INSERT OR IGNORE INTO quest_preferences(user_id) VALUES(?)',userId);
    const row=store.get('SELECT * FROM quest_preferences WHERE user_id=?',userId);
    return {declined:row.declined_at!==null,invitationSeen:row.invitation_seen_at!==null,trackedAttemptId:row.tracked_attempt_id,signInDismissed:!!row.signin_dismissed};
  }
  function pointFor(area,scene,origin) {
    // Offer only local named regions with a reachable, collision-free target.
    const choices=[{x:Math.round(area.x*2)/2,z:Math.round(area.z*2)/2}];
    for(let ring=.5;ring<=Math.min(Math.max(area.width,area.depth)/2,8);ring+=.5)
      for(let angle=0;angle<Math.PI*2;angle+=Math.PI/8)choices.push({x:Math.round((area.x+Math.cos(angle)*ring)*2)/2,z:Math.round((area.z+Math.sin(angle)*ring)*2)/2});
    const candidates=choices.filter(p=>inside(area,p)&&canStand(scene,p.x,p.z));
    // A handful of nearest candidates is enough for these bounded local layouts.
    candidates.sort((a,b)=>Math.hypot(a.x-area.x,a.z-area.z)-Math.hypot(b.x-area.x,b.z-area.z));
    for(const p of candidates.slice(0,16))if(Math.hypot(origin.x-p.x,origin.z-p.z)<.6||findPath(scene,origin,p).length)return p;
    return null;
  }
  function exitFor(area,scene,origin) {
    // Guidance must lead outside before returning; walking to the area centre
    // while already inside can never satisfy the post-acceptance entry rule.
    const xs=[origin.x,area.x,area.x-area.width/2,area.x+area.width/2];
    const zs=[origin.z,area.z,area.z-area.depth/2,area.z+area.depth/2];
    const choices=[...xs.flatMap(x=>[{x,z:area.z-area.depth/2-.6},{x,z:area.z+area.depth/2+.6}]),...zs.flatMap(z=>[{x:area.x-area.width/2-.6,z},{x:area.x+area.width/2+.6,z}])]
      .map(p=>({x:Math.round(p.x*2)/2,z:Math.round(p.z*2)/2}))
      .filter(p=>!inside(area,p)&&canStand(scene,p.x,p.z));
    choices.sort((a,b)=>Math.hypot(a.x-origin.x,a.z-origin.z)-Math.hypot(b.x-origin.x,b.z-origin.z));
    return choices.find(p=>findPath(scene,origin,p).length)||null;
  }
  function definition(kind,roomId,title,objective,target=null) {
    const key=kind==='explore'?`${kind}:${roomId}:${target.areaId}`:`${kind}:${roomId}`;
    return {id:'quest-'+hash(key),version:hash({kind,title,objective,target:target?.area||null}),kind,roomId,title,objective,target,reward:'A private '+({explore:'Explorer',build:'Builder',meet:'Connection'}[kind])+' stamp'};
  }
  function roomDefinitions(userId,roomId) {
    if(!enabled||!roomId)return [];
    const room=store.room(roomId,userId);store.authorize(roomId,userId);
    const p=presence.get(`${roomId}:${userId}`);if(!p||now()-p.lastSeen>=60000)return [];
    const result=[];
    for(const area of room.scene.areas||[]) {
      if(!area.name?.trim()||['teleport','link'].includes(area.action))continue;
      const point=pointFor(area,room.scene,p);if(!point)continue;
      // An entry objective is impossible if the entire reachable room is inside
      // the target. Require at least one collision-free exit edge when inside.
      if(inside(area,p)) {
        if(!exitFor(area,room.scene,p))continue;
      }
      // Version follows semantic target identity/geometry, never transient walking position.
      const target={roomId,areaId:area.id,label:area.name,...point,area:{id:area.id,name:area.name,x:area.x,z:area.z,width:area.width,depth:area.depth}};
      result.push(definition('explore',roomId,'Explore '+area.name,`Walk into ${area.name}. If you are already there, step outside and return.`,target));
    }
    if(EDIT.includes(room.role)&&room.scene.objects.length<2000)result.push(definition('build',roomId,'Try building','Open Build, place a new object, and save the room. Moving an existing object does not count.'));
    const policy=media.policy(userId,roomId);
    if(policy.enabled&&policy.context.kind==='proximity'&&policy.peers.some(peer=>peer.canSend&&peer.canReceive))result.push(definition('meet',roomId,'Meet someone','Exchange a 👋 wave with a real player in the same nearby conversation. Both waves must happen after you accept.'));
    return result;
  }
  function currentTarget(row,currentRoomId) {
    if(row.status!=='accepted')return {available:true,target:row.target?JSON.parse(row.target):null};
    if(row.room_id!==currentRoomId)return {available:false,reason:'Return to the room where you accepted this quest',target:null};
    let room;try{store.authorize(row.room_id,row.user_id);room=store.room(row.room_id,row.user_id);}catch{return {available:false,reason:'This room is no longer accessible',target:null};}
    if(row.kind==='build')return {available:EDIT.includes(room.role),reason:EDIT.includes(room.role)?null:'Editor access is required to finish',target:null,guidance:{phase:'build-and-save',instruction:'Place a new object in Build, then choose Save room.',detail:'Moving an existing object or leaving an unsaved draft does not count.'}};
    if(row.kind==='meet') {
      const policy=media.policy(row.user_id,row.room_id);
      const ready=policy.enabled&&policy.context.kind==='proximity'&&policy.peers.some(p=>p.canSend&&p.canReceive);
      if(!ready)return {available:false,reason:'Meet a real player nearby and both enable Connect, then exchange 👋 waves',target:null};
      reconcileRoom(row.room_id);
      let progress={completed:0,total:2,ownWave:false,otherWave:false};
      for(const bubble of bubbles.values()) {
        if(bubble.roomId!==row.room_id||!bubble.people.includes(row.user_id))continue;
        const ownWave=(bubble.greetings.get(row.user_id)?.sequence||0)>row.accepted_sequence;
        const otherWave=(bubble.greetings.get(bubble.people.find(id=>id!==row.user_id))?.sequence||0)>row.accepted_sequence;
        if(Number(ownWave)+Number(otherWave)>progress.completed)progress={completed:Number(ownWave)+Number(otherWave),total:2,ownWave,otherWave};
      }
      return {available:true,reason:null,target:null,progress,guidance:{phase:progress.ownWave?'waiting-for-wave':'send-wave',instruction:progress.ownWave?'Waiting for the other player to wave back.':progress.otherWave?'Wave back: More → Express → 👋.':'Send a wave: More → Express → 👋.',detail:'Both real players must keep Connect on and stay in the same nearby conversation. No microphone or camera is needed.'}};
    }
    const target=JSON.parse(row.target),area=room.scene.areas?.find(a=>a.id===target.areaId);
    const same=area&&['id','name','x','z','width','depth'].every(k=>area[k]===target.area[k]);
    if(!same)return {available:false,reason:'The target was changed or removed. You can set this quest aside.',target:null};
    const p=presence.get(`${row.room_id}:${row.user_id}`),leave=p&&inside(area,p),point=p&&(leave?exitFor(area,room.scene,p):pointFor(area,room.scene,p));
    return point?{available:true,target:{...target,...point},guidance:{phase:leave?'leave-area':'enter-area',instruction:leave?`Step outside ${area.name} first.`:`Walk into ${area.name}.`,detail:leave?'You accepted while already inside. Walk outside, then return to finish.':'Enter the marked area to finish. Your stamp is awarded automatically.'}}:{available:false,reason:'The target is not reachable from here',target:null};
  }
  function state(userId,roomId) {
    if(!enabled||store.isPublicGuest(userId))return {enabled:false,scope:'standalone-local',available:[],attempts:[],tracked:null,stampCount:0};
    const prefs=preferences(userId);
    const rows=store.all('SELECT a.*,g.id AS stamp_id,g.granted_at FROM quest_attempts a LEFT JOIN quest_grants g ON g.attempt_id=a.id WHERE a.user_id=? ORDER BY a.accepted_at DESC,a.rowid DESC',userId);
    const attempts=rows.map(row=>({id:row.id,definitionId:row.definition_id,version:row.version,roomId:row.room_id,kind:row.kind,title:row.title,objective:row.objective,status:row.status,acceptedAt:row.accepted_at,completedAt:row.completed_at,stampId:row.stamp_id||null,tracked:prefs.trackedAttemptId===row.id,...currentTarget(row,roomId)}));
    let available=[];if(roomId){try{available=roomDefinitions(userId,roomId).filter(d=>!rows.some(a=>a.definition_id===d.id&&a.version===d.version));}catch(e){if(e.status!==403&&e.status!==404)throw e;}}
    return {enabled:true,scope:'standalone-local',preferences:prefs,available,attempts,tracked:attempts.find(a=>a.tracked&&a.status==='accepted')||null,stampCount:attempts.filter(a=>a.stampId).length,pendingNotices:store.get('SELECT count(*) AS count FROM quest_grants WHERE user_id=? AND notice_claimed_at IS NULL',userId).count};
  }
  function notify(userIds) {for(const id of new Set(userIds))emitUser(id,'quest',{changed:true});}
  function changePreferences(userId,b) {
    preferences(userId);
    if(b.declined!==undefined){if(b.declined!==true)v.fail(400,'INVALID_INPUT','A declined invitation cannot be reset');store.run('UPDATE quest_preferences SET declined_at=COALESCE(declined_at,?) WHERE user_id=?',now(),userId);}
    if(b.invitationSeen!==undefined){v.boolean(b.invitationSeen,'invitationSeen');if(b.invitationSeen)store.run('UPDATE quest_preferences SET invitation_seen_at=COALESCE(invitation_seen_at,?) WHERE user_id=?',now(),userId);}
    if(b.signInDismissed!==undefined){v.boolean(b.signInDismissed,'signInDismissed');store.run('UPDATE quest_preferences SET signin_dismissed=? WHERE user_id=?',+b.signInDismissed,userId);}
    if(b.trackedAttemptId!==undefined){const attempt=b.trackedAttemptId;if(attempt!==null){v.id(attempt,'trackedAttemptId');if(!store.get("SELECT 1 FROM quest_attempts WHERE id=? AND user_id=? AND status='accepted'",attempt,userId))v.fail(404,'QUEST_NOT_FOUND');}store.run('UPDATE quest_preferences SET tracked_attempt_id=? WHERE user_id=?',attempt,userId);}
    notify([userId]);
  }
  function accept(userId,roomId,b) {
    if(!enabled)v.fail(503,'QUESTS_DISABLED');if(!roomId||b.roomId!==roomId)v.fail(403,'JOIN_REQUIRED','Join the quest’s room first');
    const id=v.id(b.definitionId,'definitionId'),version=v.id(b.version,'version');
    const previous=store.get('SELECT * FROM quest_attempts WHERE user_id=? AND definition_id=? AND version=?',userId,id,version);
    if(previous)return {attemptId:previous.id,duplicate:true};
    const def=roomDefinitions(userId,roomId).find(d=>d.id===id&&d.version===version);
    if(!def)v.fail(409,'QUEST_UNAVAILABLE','This quest is no longer available. Refresh the options.');
    const attemptId=randomUUID();
    store.transaction(()=>{preferences(userId);store.run('INSERT INTO quest_attempts(id,user_id,room_id,definition_id,version,kind,title,objective,target,accepted_at,accepted_sequence) VALUES(?,?,?,?,?,?,?,?,?,?,?)',attemptId,userId,roomId,id,version,def.kind,def.title,def.objective,def.target?JSON.stringify(def.target):null,now(),store.get('SELECT COALESCE(MAX(sequence),0) AS n FROM quest_observations').n);store.run('UPDATE quest_preferences SET tracked_attempt_id=?,invitation_seen_at=COALESCE(invitation_seen_at,?) WHERE user_id=?',attemptId,now(),userId);});
    notify([userId]);return {attemptId,duplicate:false};
  }
  function archive(userId,attemptId) {
    v.id(attemptId,'attemptId');if(!store.get('SELECT 1 FROM quest_attempts WHERE id=? AND user_id=?',attemptId,userId))v.fail(404,'QUEST_NOT_FOUND');
    store.transaction(()=>{store.run("UPDATE quest_attempts SET status='archived' WHERE id=? AND user_id=? AND status='accepted'",attemptId,userId);store.run('UPDATE quest_preferences SET tracked_attempt_id=NULL WHERE user_id=? AND tracked_attempt_id=?',userId,attemptId);});notify([userId]);
  }
  function observation(userId,roomId,kind,evidence,occurrenceId=randomUUID()) {
    store.run('INSERT OR IGNORE INTO quest_observations(id,user_id,room_id,kind,observed_at,evidence) VALUES(?,?,?,?,?,?)',occurrenceId,userId,roomId,kind,now(),JSON.stringify(evidence));return store.get('SELECT * FROM quest_observations WHERE id=?',occurrenceId);
  }
  function complete(row,obs) {
    if(row.status!=='accepted'||obs.sequence<=row.accepted_sequence||row.user_id!==obs.user_id||row.room_id!==obs.room_id)return false;
    const changed=store.run("UPDATE quest_attempts SET status='completed',completed_at=? WHERE id=? AND user_id=? AND status='accepted'",now(),row.id,row.user_id);if(!changed.changes)return false;
    store.run('INSERT OR IGNORE INTO quest_applications(observation_id,attempt_id) VALUES(?,?)',obs.id,row.id);
    store.run('INSERT OR IGNORE INTO quest_grants(id,user_id,attempt_id,rule,granted_at) VALUES(?,?,?,?,?)',randomUUID(),row.user_id,row.id,'private-stamp-v1',now());
    store.run('UPDATE quest_preferences SET tracked_attempt_id=NULL WHERE user_id=? AND tracked_attempt_id=?',row.user_id,row.id);return true;
  }
  function observeMovement(userId,roomId,old,next) {
    if(!enabled||!old||old.roomId!==roomId||now()-old.lastSeen>=60000)return;
    const room=store.room(roomId,userId);if(!canStand(room.scene,next.x,next.z))return;
    const rows=store.all("SELECT * FROM quest_attempts WHERE user_id=? AND room_id=? AND kind='explore' AND status='accepted'",userId,roomId),changed=[];
    store.transaction(()=>{for(const row of rows){const target=JSON.parse(row.target),area=room.scene.areas?.find(a=>a.id===target.areaId);if(!area||!['id','name','x','z','width','depth'].every(k=>area[k]===target.area[k])||inside(area,old)||!inside(area,next))continue;const obs=observation(userId,roomId,'area-entry',{areaId:area.id});if(complete(row,obs))changed.push(userId);}});notify(changed);
  }
  // Called INSIDE the same transaction as an authorized scene CAS. Only accepted,
  // newly introduced instance identities count; a move/failed save cannot award.
  function observeBuild(userId,roomId,before,after,revision) {
    if(!enabled)return [];store.authorize(roomId,userId,EDIT);
    const prior=new Set(before.objects.map(o=>o.id)),added=after.objects.filter(o=>!prior.has(o.id));if(!added.length)return [];
    const rows=store.all("SELECT * FROM quest_attempts WHERE user_id=? AND room_id=? AND kind='build' AND status='accepted'",userId,roomId);if(!rows.length)return [];
    const obs=observation(userId,roomId,'authorized-placement',{objectIds:added.map(o=>o.id),revision},`placement:${roomId}:${revision}:${userId}`),changed=[];for(const row of rows)if(complete(row,obs))changed.push(userId);return changed;
  }
  function reconcileRoom(roomId) {
    if(!enabled||!roomId)return;
    const active=new Set();
    for(const p of presence.values()) {
      if(p.roomId!==roomId||now()-p.lastSeen>=60000)continue;
      let policy;try{policy=media.policy(p.userId,roomId);}catch{continue;}
      if(!policy.enabled||policy.context.kind!=='proximity')continue;
      for(const peer of policy.peers)if(peer.canSend&&peer.canReceive){const people=[p.userId,peer.id].sort(),key=roomId+':'+people.join(':');active.add(key);if(!bubbles.has(key))bubbles.set(key,{id:randomUUID(),roomId,people,greetings:new Map()});}
    }
    for(const [key,bubble] of bubbles)if(bubble.roomId===roomId&&!active.has(key))bubbles.delete(key);
  }
  function disconnected(userId,roomId) {for(const [key,bubble]of bubbles)if(bubble.people.includes(userId)&&(!roomId||bubble.roomId===roomId))bubbles.delete(key);}
  function observeWave(userId,roomId,emoji) {
    if(!enabled||emoji!=='👋')return;reconcileRoom(roomId);const changed=[];
    store.transaction(()=>{for(const bubble of bubbles.values()) {
      if(bubble.roomId!==roomId||!bubble.people.includes(userId))continue;
      const active=store.all("SELECT * FROM quest_attempts WHERE room_id=? AND kind='meet' AND status='accepted' AND user_id IN (?,?)",roomId,...bubble.people);if(!active.length)continue;
      // Partial progress is server-observed too. Let both affected quest logs
      // refresh after a wave, without awarding anything before reciprocity.
      changed.push(...active.map(row=>row.user_id));
      const obs=observation(userId,roomId,'reciprocal-wave',{bubbleId:bubble.id});bubble.greetings.set(userId,obs);
      for(const row of active){const own=bubble.greetings.get(row.user_id),other=bubble.greetings.get(bubble.people.find(id=>id!==row.user_id));if(own&&other&&own.sequence>row.accepted_sequence&&other.sequence>row.accepted_sequence){const receipt=observation(row.user_id,roomId,'reciprocal-wave-completed',{bubbleId:bubble.id,participants:bubble.people,waveObservationIds:[own.id,other.id]},`meet:${bubble.id}:${row.id}`);if(complete(row,receipt))changed.push(row.user_id);}}
    }});notify(changed);
  }
  function claimNotices(userId) {
    if(!enabled)return {notices:[]};return store.transaction(()=>{const notices=store.all('SELECT g.id,a.id AS attemptId,a.title,a.kind FROM quest_grants g JOIN quest_attempts a ON a.id=g.attempt_id WHERE g.user_id=? AND g.notice_claimed_at IS NULL ORDER BY g.granted_at LIMIT 10',userId);for(const notice of notices)store.run('UPDATE quest_grants SET notice_claimed_at=? WHERE id=? AND user_id=? AND notice_claimed_at IS NULL',now(),notice.id,userId);return {notices};});
  }
  return {state,accept,archive,changePreferences,observeMovement,observeBuild,observeWave,reconcileRoom,disconnected,claimNotices,notify};
}
