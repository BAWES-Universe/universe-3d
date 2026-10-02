// Real in-memory SQLite admission/ACL tests; no browser, provider, or live media.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.mjs';
import {createMediaPolicy} from '../server/media.mjs';
import {createProximityMembershipAuthority,validateProximityMembershipConfig} from '../server/proximity-authority.mjs';
import {proximityFixture as config} from './fixtures/proximity-config.mjs';
const scene={version:1,theme:'garden',bounds:{width:100,depth:100},spawn:{x:0,z:0},objects:[],areas:[]};
const seeds=[{id:'world',name:'World',rooms:['r','other'].map(id=>({id,name:id,scene}))}];
function fixture(t,overrides={}){
 let time=100000;const store=new Store(':memory:',seeds,()=>time),presence=new Map();
 const authority=createProximityMembershipAuthority({store,presence,config:{...config,...overrides},now:()=>time});
 t.after(()=>{authority.close();store.close();});
 function add(name='A',fields={},user=null){user??=store.createUser(name,'0');const session={token_hash:randomUUID(),user_id:user.id,current_room_id:'r',expires_at:time+1000000};store.run('INSERT INTO sessions VALUES(?,?,?,?)',session.token_hash,user.id,session.expires_at,'r');presence.set(`r:${user.id}`,{id:user.id,userId:user.id,roomId:'r',name:user.name,x:0,z:0,moving:false,status:'online',lastSeen:time,...fields});return {user,session};}
 const policy=a=>authority.policy(a.session),consent=(a,value=true)=>authority.setConsent(a.session,value);
 return{store,presence,authority,add,policy,consent,get time(){return time;},advance(ms){time+=ms;},move(a,fields){Object.assign(presence.get(`r:${a.user.id}`),fields);},fresh(){for(const p of presence.values())p.lastSeen=time;},leave(a){store.run('UPDATE sessions SET current_room_id=NULL WHERE token_hash=?',a.session.token_hash);authority.refresh('r');},scene(areas){store.run('UPDATE rooms SET scene=? WHERE id=?',JSON.stringify({...scene,areas}),'r');},status(a,status){store.run('UPDATE users SET status=? WHERE id=?',status,a.user.id);}};
}
const ids=p=>p.conversationRecipients.map(x=>x.accountId);
const envelope=(p,to)=>({roomId:p.roomId,bubbleId:p.bubbleId,fromMemberId:p.memberId,toMemberId:p.p2pRecipients.find(x=>x.accountId===to.user.id).memberId,to:to.user.id,intentGeneration:p.transport.intentGeneration,mediaScope:p.mediaScope});
const code=value=>error=>error.code===value;
test('configuration is explicit, strict, immutable and cannot enable SFU',()=>{
 assert.throws(()=>validateProximityMembershipConfig());for(const bad of [{enabled:false},{p2pThreshold:0},{sfuAvailable:true},{meetingPolicy:'source-threshold'},{maxSessionsPerMember:0},{memberTtlMs:60001}])assert.throws(()=>validateProximityMembershipConfig({...config,...bad}));assert(Object.isFrozen(validateProximityMembershipConfig(config)));
});
test('all six eligible accounts count without consent; oversized mesh is blocked honestly',t=>{
 const f=fixture(t),members=Array.from({length:6},(_,i)=>f.add('Member '+i));const p=f.policy(members[0]);assert.equal(ids(p).length,5);assert.equal(p.transport.memberCount,6);assert.equal(p.transport.requiredTransport,'sfu');assert.equal(p.transport.blockedReason,'sfu-unavailable');assert.equal(p.transport.connectedTransport,null);assert.equal(p.transport.handoffComplete,false);assert.deepEqual(p.p2pRecipients,[]);assert.equal(p.enabled,false);
});
test('consent changes only AV recipients, preserving conversation/member/bubble identities',t=>{
 const f=fixture(t),a=f.add(),b=f.add('B'),c=f.add('C'),before=f.policy(a);f.consent(a);f.consent(b);let after=f.policy(a);assert.deepEqual(ids(after),ids(before));assert.equal(after.bubbleId,before.bubbleId);assert.equal(after.memberId,before.memberId);assert.equal(after.membershipRevision,before.membershipRevision);assert.deepEqual(after.p2pRecipients.map(x=>x.accountId),[b.user.id]);f.consent(b,false);assert.deepEqual(f.policy(a).p2pRecipients,[]);assert.equal(f.policy(c).transport.memberCount,3);
});
test('one account counts once but another tab cannot inherit policy/signal/receive consent',t=>{
 const f=fixture(t),a=f.add(),a2=f.add('A2',{},a.user),b=f.add('B');f.consent(a);f.consent(b);const p=f.policy(a);assert.equal(p.transport.memberCount,2);assert.equal(f.policy(a2).enabled,false);assert.deepEqual(f.policy(a2).p2pRecipients,[]);assert.throws(()=>f.authority.authorizeP2PSignal(a2.session,envelope(p,b)),code('MEDIA_FORBIDDEN'));const fromB=f.policy(b);assert.equal(f.authority.authorizeDelivery(a2.session,{...envelope(fromB,a),from:b.user.id}),false);assert.equal(f.authority.authorizeDelivery(a.session,{...envelope(fromB,a),from:b.user.id}),true);
});
test('last consenting session expiry removes edges but leaves a live nonconsenting account member',t=>{
 const f=fixture(t),a=f.add(),a2=f.add('A2',{},a.user),b=f.add('B');f.consent(a);f.consent(b);const before=f.policy(b);f.store.run('UPDATE sessions SET expires_at=? WHERE token_hash=?',f.time,a.session.token_hash);const after=f.policy(b);assert.equal(after.memberId,before.memberId);assert.deepEqual(ids(after),ids(before));assert.deepEqual(after.p2pRecipients,[]);assert.equal(f.policy(a2).enabled,false);assert.throws(()=>f.policy(a),code('AUTH_REQUIRED'));
});
test('last leave/rejoin creates new identities and cannot resurrect consent or stale signaling',t=>{
 const f=fixture(t),a=f.add(),b=f.add('B');f.consent(a);f.consent(b);const old=f.policy(a),oldSignal=envelope(old,b);f.leave(a);f.store.run('UPDATE sessions SET current_room_id=? WHERE token_hash=?','r',a.session.token_hash);const next=f.policy(a);assert.notEqual(next.memberId,old.memberId);assert.notEqual(next.bubbleId,old.bubbleId);assert.equal(next.enabled,false);f.consent(a);assert.throws(()=>f.authority.authorizeP2PSignal(a.session,oldSignal),code('STALE_SIGNAL_CONTEXT'));
});
test('partial tab leave retains member identity and only the leaving tab grant is retired',t=>{
 const f=fixture(t),a=f.add(),a2=f.add('A2',{},a.user),b=f.add('B');f.consent(a);f.consent(a2);f.consent(b);const before=f.policy(a2);f.leave(a);const after=f.policy(a2);assert.equal(after.memberId,before.memberId);assert.equal(after.bubbleId,before.bubbleId);assert.equal(after.enabled,true);assert.equal(after.p2pRecipients.length,1);
});
test('server-derived identity rejects actor override and ignores client-like presence context/consent',t=>{
 const f=fixture(t),a=f.add(),b=f.add('B',{context:{kind:'meeting'},mediaConsent:true,canPublish:true});assert.deepEqual(f.policy(a).p2pRecipients,[]);assert.throws(()=>f.authority.policy({...a.session,user_id:b.user.id}),code('AUTH_REQUIRED'));assert.throws(()=>f.authority.policy({...a.session,current_room_id:'other'}),code('AUTH_REQUIRED'));assert.equal(f.policy(a).transport.memberCount,2);
});
test('sessionless NPCs and stale presence do not become participants; admitted bot-like accounts can',t=>{
 const f=fixture(t),a=f.add(),b=f.add('B',{kind:'bot'});f.presence.set('r:npc',{userId:'npc',roomId:'r',kind:'bot',x:0,z:0,moving:false,lastSeen:f.time});assert.equal(f.policy(a).transport.memberCount,2);f.move(b,{lastSeen:f.time-60000});assert.deepEqual(ids(f.policy(a)),[]);assert.equal(f.authority.stats().memberships,1);
});
test('Silent beats overlapping meeting/stage, status is read from account, and reentry stays scoped',t=>{
 const f=fixture(t),a=f.add(),b=f.add('B');f.consent(a);f.consent(b);const before=f.policy(a);f.scene([{id:'meeting',action:'meeting',x:0,z:0,width:4,depth:4},{id:'silent',action:'silent',x:0,z:0,width:2,depth:2}]);let p=f.policy(a);assert.equal(p.context.kind,'silent');assert.equal(p.bubbleId,null);assert.deepEqual(ids(p),[]);f.scene([]);f.status(b,'dnd');assert.deepEqual(ids(f.policy(a)),[]);f.status(b,'online');p=f.policy(a);assert.notEqual(p.bubbleId,before.bubbleId);assert.equal(p.memberId,before.memberId);assert.equal(p.p2pRecipients.length,1);
});
for(const status of ['busy','dnd','invisible'])test(`${status} leaves proximity independently of consent`,t=>{const f=fixture(t),a=f.add(),b=f.add('B');f.consent(a);f.consent(b);f.status(b,status);assert.deepEqual(ids(f.policy(a)),[]);});
for(const action of ['meeting','stage','audience'])test(`${action} is excluded from this proximity-only lane`,t=>{const f=fixture(t),a=f.add(),b=f.add('B');f.scene([{id:'area',action,x:0,z:0,width:4,depth:4}]);const p=f.policy(a);assert.equal(p.context.kind,action);assert.deepEqual(ids(p),[]);assert.equal(p.transport,null);});
test('source-style barycenter grouping is bounded separately from P2P count',t=>{
 const f=fixture(t,{membershipCeiling:4,p2pThreshold:3}),a=f.add('A',{x:-1}),b=f.add('B',{x:1});const first=f.policy(a);const c=f.add('C',{x:3.01});assert.equal(f.policy(a).transport.memberCount,2);f.move(c,{x:3});assert.equal(f.policy(a).transport.memberCount,3);const d=f.add('D',{x:0});assert.equal(f.policy(a).transport.memberCount,4);assert.equal(f.policy(a).transport.blockedReason,'sfu-unavailable');assert.equal(f.policy(a).bubbleId,first.bubbleId);const e=f.add('E');assert.equal(f.policy(a).transport.memberCount,4);assert.equal(f.policy(e).bubbleId,null);
});
test('ACL revocation, TTL and authority-read failure remove cached recipient authorization',t=>{
 const f=fixture(t),a=f.add(),b=f.add('B');f.consent(a);f.consent(b);const old=f.policy(a),signal=envelope(old,b);f.store.run('INSERT INTO members(room_id,user_id,banned) VALUES(?,?,1)','r',b.user.id);assert.deepEqual(ids(f.policy(a)),[]);assert.throws(()=>f.authority.authorizeP2PSignal(a.session,signal));f.advance(60000);f.authority.sweep();assert.equal(f.authority.stats().memberships,0);assert.equal(f.authority.stats().grants,0);
});
test('read failure fails closed and recovered room cannot reuse old bubble or consent',t=>{
 const f=fixture(t),a=f.add(),b=f.add('B');f.consent(a);f.consent(b);const before=f.policy(a),original=f.store.roomRow.bind(f.store);f.store.roomRow=()=>{throw new Error('read failed');};assert.throws(()=>f.policy(a),/read failed/);assert.equal(f.authority.stats().memberships,0);assert.equal(f.authority.stats().grants,0);f.store.roomRow=original;const after=f.policy(a);assert.notEqual(after.bubbleId,before.bubbleId);assert.equal(after.enabled,false);
});
test('signal fences reject stale target/member/room/generation and never expose tokens',t=>{
 const f=fixture(t),a=f.add(),b=f.add('B');f.consent(a);f.consent(b);const p=f.policy(a),valid=envelope(p,b);assert.equal(f.authority.authorizeP2PSignal(a.session,valid).accountId,b.user.id);for(const bad of [{roomId:'other'},{bubbleId:'old'},{fromMemberId:'old'},{toMemberId:'old'},{intentGeneration:7},{to:a.user.id}])assert.throws(()=>f.authority.authorizeP2PSignal(a.session,{...valid,...bad}));const payload=JSON.stringify(p);assert(!payload.includes(a.session.token_hash));assert(!payload.includes('admissionId'));assert(!payload.includes('expires_at'));
});
test('session bounds and close fail closed',t=>{
 const f=fixture(t,{maxSessionsPerMember:1}),a=f.add(),b=f.add('B');f.policy(a);f.add('A2',{},a.user);assert.equal(f.policy(a).memberId,null);assert.equal(f.authority.stats().memberships,1);f.authority.close();assert.throws(()=>f.policy(b),code('SERVICE_CLOSED'));
});
test('AV scope rotates after withdraw/reconsent and oversized blocking without changing text identity',t=>{
 const f=fixture(t,{p2pThreshold:2}),a=f.add(),b=f.add('B');f.consent(a);f.consent(b);const before=f.policy(a),old=envelope(before,b);f.consent(a,false);f.consent(a);let after=f.policy(a);assert.equal(after.memberId,before.memberId);assert.equal(after.bubbleId,before.bubbleId);assert.notEqual(after.mediaScope,before.mediaScope);assert.throws(()=>f.authority.authorizeP2PSignal(a.session,old),code('STALE_MEDIA_SCOPE'));const enabled=after.mediaScope,c=f.add('C');assert.deepEqual(f.policy(a).p2pRecipients,[]);f.leave(c);after=f.policy(a);assert.equal(after.bubbleId,before.bubbleId);assert.notEqual(after.mediaScope,enabled);assert.equal(after.p2pRecipients.length,1);
});
test('future presence, nonfinite position and regressed clock clear rather than cache authority',t=>{
 const f=fixture(t),a=f.add(),b=f.add('B');f.consent(a);f.consent(b);f.move(b,{lastSeen:f.time+1});assert.throws(()=>f.policy(a),code('FUTURE_PRESENCE'));assert.equal(f.authority.stats().memberships,0);f.fresh();f.policy(a);f.move(b,{x:NaN});assert.throws(()=>f.policy(a),code('INVALID_x'));assert.equal(f.authority.stats().memberships,0);f.move(b,{x:0});f.policy(a);f.advance(-1);assert.throws(()=>f.policy(a),code('CLOCK_REGRESSED'));assert.equal(f.authority.stats().memberships,0);assert.equal(f.authority.stats().grants,0);assert.doesNotThrow(()=>f.authority.sweep());
});
test('banned/sessionless over-cap account cannot deny service to eligible members',t=>{
 const f=fixture(t,{maxSessionsPerMember:2}),a=f.add(),b=f.add('B'),bad=f.add('bad');f.store.run('INSERT INTO members(room_id,user_id,banned) VALUES(?,?,1)','r',bad.user.id);for(let i=0;i<5;i++)f.add('bad',{},bad.user);f.consent(a);f.consent(b);const p=f.policy(a);assert.equal(p.p2pRecipients.length,1);assert.equal(p.transport.memberCount,2);
});
test('captured refresh views cannot outlive a later authority transaction',t=>{
 const f=fixture(t),a=f.add(),b=f.add('B');const batch=f.authority.captureRoom('r');assert.equal(batch.policyForSession(a.session).transport.memberCount,2);f.authority.refresh('r');assert.throws(()=>batch.policyForAccount(b.user.id),code('STALE_POLICY_BATCH'));
});

test('one room refresh performs linear bounded Store reads instead of resyncing per recipient',t=>{
 const f=fixture(t);for(let i=0;i<30;i++)f.add('Member '+i);let reads=0;const original=f.store.all.bind(f.store);f.store.all=(...args)=>{reads++;return original(...args);};f.store.room=()=>{throw Error('Full room serialization must not run for proximity refresh');};const media=createMediaPolicy({store:f.store,presence:f.presence,now:()=>f.time,emitUser(){},proximityMembershipConfig:config});t.after(()=>media.close());media.refresh('r');assert(reads<=300,`30 media-off members required ${reads} Store.all reads`);
});
