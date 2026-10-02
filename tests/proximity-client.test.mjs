import test from 'node:test';
import assert from 'node:assert/strict';
import {createMediaSession,policyPeers} from '../src/media.js';
import {tick,deferred,Track,Stream,mediaEnvironment,policyFixture,incomingSignal,iceResponse} from './fixtures/proximity-media-client.mjs';
function fixture(t,self='a'){
 const f=mediaEnvironment(),calls=[],state={user:{id:self},room:{id:'r',scene:{areas:[]}},position:{x:0,z:0},ready:true};let policy=policyFixture(self,self==='a'?'z':'a'),intercept;
 const api=async(path,o={})=>{calls.push({path,...o});const normal=()=>{if(path==='/api/media')return structuredClone(policy);if(path==='/api/media/state'){policy={...policy,enabled:o.body.enabled};return structuredClone(policy);}if(path==='/api/media/ice')return iceResponse(policy,o.body.requestId,f.now());return{ok:true};};return intercept?intercept(path,o,normal):normal();};
 const session=createMediaSession({api,getState:()=>state,env:f.env,now:f.now});t.after(()=>session.destroy());
 return Object.assign(f,{session,calls,state,getPolicy:()=>policy,push(changes={}){policy={...policy,...changes};session.acceptPolicy(structuredClone(policy));},scope(changes){this.push({proximityMembership:{...policy.proximityMembership,...changes}});},interceptApi(fn){intercept=fn;}});
}
const sends=f=>f.calls.filter(c=>c.path==='/api/media/signal');
const current=f=>f.instances.filter(p=>!p.closed).at(-1);
test('scoped offers, candidates, answers and retry requests carry exact authorized member identities',async t=>{
 const f=fixture(t);await f.session.setJoined(true);await tick();const p=current(f);p.onicecandidate({candidate:{candidate:'synthetic'}});
 for(const call of sends(f)){const s=f.getPolicy().proximityMembership;assert.equal(call.body.bubbleId,s.bubbleId);assert.equal(call.body.fromMemberId,s.memberId);assert.equal(call.body.toMemberId,'member-z');assert.equal(call.body.intentGeneration,s.transport.intentGeneration);assert.equal(call.body.mediaScope,s.mediaScope);}
 assert.equal(sends(f).some(c=>c.body.description?.type==='offer'),true);assert.equal(sends(f).some(c=>c.body.candidate),true);
 const a=fixture(t,'z');await a.session.setJoined(true);await a.session.onSignal(incomingSignal(a.getPolicy(),{description:{type:'offer',sdp:'synthetic'}}));assert.equal(sends(a).at(-1).body.description.type,'answer');assert.equal(sends(a).at(-1).body.toMemberId,'member-a');await a.session.retry();assert.equal(sends(a).at(-1).body.request,'offer');assert.equal(sends(a).at(-1).body.fromMemberId,'member-z');
});
for(const field of ['bubbleId','fromMemberId','toMemberId','intentGeneration','mediaScope'])test(`wrong or missing incoming ${field} is rejected before GET/ICE/RTC work`,async t=>{
 const f=fixture(t,'z');await f.session.setJoined(true);const before=f.calls.length;for(const value of ['retired',undefined])await f.session.onSignal({...incomingSignal(f.getPolicy(),{description:{type:'offer',sdp:'synthetic'}}),[field]:value});assert.equal(f.calls.length,before);assert.equal(f.instances.length,0);
});
for(const change of ['memberId','bubbleId','mediaScope','intent','target','context','consent'])test(`${change} change retires peers with separately fenced local capture`,async t=>{
 const f=fixture(t);await f.session.setJoined(true);await f.session.toggleDevice('microphone');const stream=f.session.snapshot().devices.microphone.stream,p=current(f),wait=deferred();f.env.navigator.mediaDevices.getDisplayMedia=()=>wait.promise;const pending=f.session.toggleDevice('screen');
 if(['memberId','bubbleId','mediaScope'].includes(change))f.scope({[change]:'replacement'});
 if(change==='intent')f.scope({transport:{...f.getPolicy().proximityMembership.transport,intentGeneration:1}});
 if(change==='target')f.push({peers:[{...f.getPolicy().peers[0],memberId:'replacement-target'}]});
 if(change==='context')f.push({context:{kind:'meeting',group:'meeting',canPublish:true},proximityMembership:undefined});
 if(change==='consent')f.push({enabled:false});
 const localRetired=['memberId','context','consent'].includes(change);assert.equal(p.closed,true);assert.equal(stream.getTracks()[0].readyState,localRetired?'ended':'live');const track=new Track('video');wait.resolve(new Stream([track]));assert.equal(await pending,!localRetired);assert.equal(track.readyState,localRetired?'ended':'live');assert.equal(f.session.snapshot().devices.screen.status,localRetired?'off':'on');
});
test('revision, evaluation timestamp and display-name changes retain healthy peers and capture',async t=>{
 const f=fixture(t);await f.session.setJoined(true);await f.session.toggleDevice('microphone');const p=current(f),stream=f.session.snapshot().devices.microphone.stream,iceCalls=f.calls.filter(c=>c.path==='/api/media/ice').length;
 f.scope({membershipRevision:8,transport:{...f.getPolicy().proximityMembership.transport,evaluatedAt:999999}});f.push({peers:[{...f.getPolicy().peers[0],displayName:'Updated name'}]});await tick();assert.equal(current(f),p);assert.notEqual(p.closed,true);assert.equal(stream.getTracks()[0].readyState,'live');assert.equal(f.calls.filter(c=>c.path==='/api/media/ice').length,iceCalls);
});
for(const method of ['createOffer','setLocalDescription','setRemoteDescription','createAnswer','addIceCandidate','replaceTrack'])test(`late ${method} completion cannot affect replacement scope`,async t=>{
 const f=fixture(t, ['setRemoteDescription','createAnswer','addIceCandidate'].includes(method)?'z':'a'),wait=deferred(),entered=deferred();let held;
 f.intercept=(pc,name)=>{if(name===method&&!held){held=pc;entered.resolve();return wait.promise;}};
 const join=f.session.setJoined(true);await join;
 let pending;
 if(method==='setRemoteDescription'||method==='createAnswer')pending=f.session.onSignal(incomingSignal(f.getPolicy(),{description:{type:'offer',sdp:'old-offer'}}));
 if(method==='addIceCandidate'){await f.session.onSignal(incomingSignal(f.getPolicy(),{description:{type:'offer',sdp:'offer'}}));pending=f.session.onSignal(incomingSignal(f.getPolicy(),{candidate:{candidate:'old-candidate'}}));}
 if(method==='replaceTrack')pending=f.session.toggleDevice('microphone');
 await entered.promise;f.scope({mediaScope:'media-new'});assert.equal(held.closed,true);wait.resolve();await pending;await tick();const oldSends=sends(f).filter(c=>c.body.mediaScope==='media-1');if(['createOffer','setLocalDescription','setRemoteDescription','createAnswer'].includes(method))assert.equal(oldSends.length,0);assert.equal(f.session.snapshot().iceError,'');assert.equal(f.session.snapshot().devices.microphone.status,method==='replaceTrack'?'on':'off');
});
test('late ICE renewal never reconfigures or restarts retired peers',async t=>{
 const f=fixture(t);await f.session.setJoined(true);await tick();const p=current(f),oldPolicy=structuredClone(f.getPolicy()),wait=deferred();let oldRequest;
 f.interceptApi((path,o,normal)=>{if(path==='/api/media/ice'&&!oldRequest){oldRequest=o.body.requestId;return wait.promise;}return normal();});await f.advance(45000);f.scope({mediaScope:'media-new'});await tick();wait.resolve(iceResponse(oldPolicy,oldRequest,f.now()));await tick();assert.equal(p.closed,true);assert.equal(p.calls.filter(c=>c.name==='setConfiguration').length,0);assert.equal(p.calls.filter(c=>c.name==='createOffer').length,1);assert.equal(f.session.snapshot().iceError,'');
});
test('threshold blocks ICE/peers with honest SFU unavailable while keeping safe local capture separate',async t=>{
 const f=fixture(t);await f.session.setJoined(true);await f.session.toggleDevice('microphone');const p=current(f),stream=f.session.snapshot().devices.microphone.stream;
 f.scope({mediaScope:'blocked',transport:{...f.getPolicy().proximityMembership.transport,memberCount:6,p2pAllowed:false,requiredTransport:'sfu',selectionIntent:'sfu',blockedReason:'sfu-unavailable'}});const calls=f.calls.length,captures=f.captures.length;assert.equal(p.closed,true);assert.equal(stream.getTracks()[0].readyState,'live');assert.equal(await f.session.toggleDevice('camera'),true);await f.session.retry();assert.equal(f.calls.slice(calls).some(c=>c.path==='/api/media/ice'||c.path==='/api/media/signal'),false);assert.equal(f.captures.length,captures+1);assert.match(f.session.snapshot().transportNotice,/SFU unavailable.*6 members/);assert.equal(f.session.snapshot().policy.proximityMembership.conversationRecipients.length,1);assert.equal(f.session.snapshot().policy.proximityMembership.transport.connectedTransport,null);
});
test('early candidate queues cannot cross member identity or another sender reusing a connection ID',async t=>{
 const f=fixture(t,'z');await f.session.setJoined(true);await f.session.onSignal(incomingSignal(f.getPolicy(),{candidate:{candidate:'old'}}));f.scope({mediaScope:'new'});await f.session.onSignal(incomingSignal(f.getPolicy(),{description:{type:'offer',sdp:'offer'}}));assert.equal(current(f).calls.filter(c=>c.name==='addIceCandidate').length,0);
 const others=[...f.getPolicy().peers,{id:'b',memberId:'member-b',canSend:true,canReceive:true}];f.push({peers:others});await f.session.onSignal(incomingSignal(f.getPolicy(),{candidate:{candidate:'only-a'}}));await f.session.onSignal({...incomingSignal(f.getPolicy(),{description:{type:'offer',sdp:'offer-b'}}),from:'b',fromMemberId:'member-b'});assert.equal(current(f).calls.filter(c=>c.name==='addIceCandidate').length,0);
});
test('older GET scope cannot rewind a newer accepted SSE scope',async t=>{
 const f=fixture(t);await f.session.setJoined(true);await tick();const old=structuredClone(f.getPolicy()),wait=deferred();f.interceptApi((path,o,normal)=>path==='/api/media'?wait.promise:normal());const pending=f.session.refreshPolicy(true);f.scope({mediaScope:'new-sse-scope'});wait.resolve(old);await pending;await tick();assert.equal(f.session.snapshot().policy.proximityMembership.mediaScope,'new-sse-scope');assert.equal(f.instances.filter(p=>!p.closed).length,1);assert.equal(sends(f).at(-1).body.mediaScope,'new-sse-scope');
});
test('unknown/malformed opt-in protocol never falls through to legacy unscoped P2P',async t=>{
 const f=fixture(t);f.scope({protocol:'future-v9'});await f.session.setJoined(true);assert.equal(f.instances.length,0);assert.equal(await f.session.toggleDevice('microphone'),false);assert.deepEqual(policyPeers(f.getPolicy()),[]);assert.match(f.session.snapshot().transportNotice,/unsupported/);
});

for (const bad of [{memberId:null},{memberId:''},{bubbleId:undefined},{mediaScope:null},{membershipRevision:NaN},{transport:{intentGeneration:Infinity}},{transport:{intentGeneration:-1}},{transport:{intentGeneration:'1'}}]) test('malformed scoped identity/generation fails closed before capture or ICE',async t=>{
 const f=fixture(t),scope=f.getPolicy().proximityMembership;f.scope({...bad,...(bad.transport?{transport:{...scope.transport,...bad.transport}}:{})});await f.session.setJoined(true);assert.match(f.session.snapshot().policyError,/Invalid or unsupported/);assert.equal(await f.session.toggleDevice('microphone'),false);assert.equal(f.captures.length,0);assert.equal(f.instances.length,0);assert.equal(f.calls.some(c=>c.path==='/api/media/ice'),false);
});
test('target identity malformed, null scope and malformed peers fail closed without throwing',async t=>{
 for(const changes of [{proximityMembership:null},{peers:[null]},{peers:[{id:'z'}]},{peers:null},{peers:{}}]){const f=fixture(t);f.push(changes);await f.session.setJoined(true);assert.match(f.session.snapshot().policyError,/Invalid or unsupported/);assert.equal(f.instances.length,0);assert.equal(f.captures.length,0);}
});
test('lone valid member may opt in and explicitly capture without ICE or a claimed transport',async t=>{
 const f=fixture(t);f.push({peers:[],iceScope:undefined,proximityMembership:{...f.getPolicy().proximityMembership,bubbleId:null,membershipRevision:null,mediaScope:null,transport:null,conversationRecipients:[]}});await f.session.setJoined(true);assert.equal(f.session.snapshot().joined,true);assert.equal(f.session.snapshot().policyError,'');assert.equal(f.session.snapshot().iceTransport,null);assert.equal(f.instances.length,0);assert.equal(await f.session.toggleDevice('camera'),true);assert.equal(f.captures.length,1);assert.equal(f.calls.some(c=>c.path==='/api/media/ice'),false);
});
test('initial ICE continuation retired by a working replacement scope cannot publish a stale join warning',async t=>{
 const f=fixture(t),wait=deferred();let held,requestId,oldPolicy;f.interceptApi((path,o,normal)=>{if(path==='/api/media/ice'&&!held){held=true;requestId=o.body.requestId;oldPolicy=structuredClone(f.getPolicy());return wait.promise;}return normal();});const joining=f.session.setJoined(true);await tick();f.push({iceScope:'replacement-ice',proximityMembership:{...f.getPolicy().proximityMembership,mediaScope:'replacement-media'}});await joining;await tick();assert(current(f));assert.equal(f.session.snapshot().joined,true);assert.equal(f.session.snapshot().iceError,'');assert.equal(f.session.snapshot().notice,'');wait.resolve(iceResponse(oldPolicy,requestId,f.now()));await tick();assert.equal(f.session.snapshot().notice,'');assert.equal(f.session.snapshot().policy.proximityMembership.mediaScope,'replacement-media');
});

for(const kind of ['microphone','camera'])test(`one ${kind} click obtains fresh consent before opening capture`,async t=>{
 const f=fixture(t),wait=deferred();f.push({});let started=false;f.interceptApi(async(path,o,normal)=>{if(path==='/api/media/state'&&o.body.enabled&&!started){started=true;await wait.promise;const result=normal();f.scope({mediaScope:'own-grant'});return result;}return normal();});const result=f.session.toggleDevice(kind);assert.equal(f.captures.length,0);assert.equal(f.session.snapshot().devices[kind].status,'requesting');wait.resolve();assert.equal(await result,true);assert.equal(f.captures.length,1);assert.equal(f.session.snapshot().devices[kind].status,'on');assert.equal(f.session.snapshot().policy.proximityMembership.mediaScope,'own-grant');
});
for(const change of ['room','actor','silent','admission','cancel'])test(`${change} during device join cannot open a later capture prompt`,async t=>{
 const f=fixture(t),wait=deferred();f.push({});let started=false;f.interceptApi(async(path,o,normal)=>{if(path==='/api/media/state'&&o.body.enabled&&!started){started=true;const result=normal();f.scope({mediaScope:'own-grant'});await wait.promise;return result;}return normal();});const pending=f.session.toggleDevice('camera');await tick();assert.equal(f.captures.length,0);
 if(change==='room'){f.state.room={id:'other'};f.session.checkLocalPolicy();}if(change==='actor'){f.state.user={id:'other'};f.session.checkLocalPolicy();}if(change==='silent')f.push({context:{kind:'silent',canPublish:false},proximityMembership:undefined,peers:[]});if(change==='admission')f.scope({memberId:'new-admission'});if(change==='cancel')assert.equal(await f.session.toggleDevice('camera'),false);
 wait.resolve();assert.equal(await pending,false);assert.equal(f.captures.length,0);assert.equal(f.session.snapshot().devices.camera.status,'off');
});
test('screen sharing explains Join first and never opens a picker before opt-in',async t=>{
 const f=fixture(t);f.push({});assert.equal(await f.session.toggleDevice('screen'),false);assert.equal(f.captures.length,0);assert.match(f.session.snapshot().notice,/Join audio before sharing/);assert.equal(f.calls.some(c=>c.body?.enabled),false);await f.session.setJoined(true);assert.equal(await f.session.toggleDevice('screen'),true);assert.equal(f.captures.length,1);
});
test('observed proximity-v1 cannot downgrade on missing scope, while meeting and a new legacy room still work',async t=>{
 const f=fixture(t);await f.session.setJoined(true);await tick();const old=current(f);f.push({proximityMembership:undefined});await tick();assert.equal(old.closed,true);assert.equal(current(f),undefined);assert.match(f.session.snapshot().policyError,/Missing proximity media scope/);assert.equal(await f.session.toggleDevice('microphone'),false);assert.equal(f.captures.length,0);
 f.push({context:{kind:'meeting',group:'m',canPublish:true}});await tick();assert(current(f));assert.equal(f.session.snapshot().policyError,'');assert.equal(sends(f).at(-1).body.bubbleId,undefined);
 f.state.room={id:'legacy'};f.session.checkLocalPolicy();f.push({roomId:'legacy',enabled:false,context:{kind:'proximity',canPublish:true}});await f.session.setJoined(true);assert.equal(f.session.snapshot().policyError,'');assert(current(f));
});

test('another member AV-scope change during own authorized join does not invalidate local capture intent',async t=>{
 const f=fixture(t),wait=deferred();f.push({});let held=false;f.interceptApi(async(path,o,normal)=>{if(path==='/api/media/state'&&o.body.enabled&&!held){held=true;const result=normal();f.scope({mediaScope:'own-grant'});await wait.promise;return result;}return normal();});const pending=f.session.toggleDevice('camera');await tick();f.scope({mediaScope:'peer-change'});assert.equal(f.captures.length,0);wait.resolve();assert.equal(await pending,true);assert.equal(f.captures.length,1);
});
for(const change of ['room','actor','admission'])test(`queued enable never runs after ${change} ownership changes`,async t=>{
 const f=fixture(t),wait=deferred();f.push({});let first=true;f.interceptApi(async(path,o,normal)=>{if(path==='/api/media/state'&&o.body.enabled&&first){first=false;const result=normal();await wait.promise;return result;}return normal();});const firstJoin=f.session.setJoined(true);await tick();const leave=f.session.setJoined(false),rejoin=f.session.setJoined(true);if(change==='room'){f.state.room={id:'other'};f.session.checkLocalPolicy();}if(change==='actor'){f.state.user={id:'other'};f.session.checkLocalPolicy();}if(change==='admission')f.scope({memberId:'replacement'});wait.resolve();await Promise.all([firstJoin,leave,rejoin]);assert.equal(f.calls.filter(c=>c.path==='/api/media/state'&&c.body.enabled).length,1);assert.equal(f.captures.length,0);assert.equal(f.session.snapshot().joined,false);
});
test('retired initial peer ICE wait does not discard an independently authorized one-click capture intent',async t=>{
 const f=fixture(t),wait=deferred();f.push({});let held=false;f.interceptApi((path,o,normal)=>{if(path==='/api/media/ice'&&!held){held=true;return wait.promise;}return normal();});const capture=f.session.toggleDevice('camera');await tick();assert.equal(held,true);assert.equal(f.captures.length,0);f.push({iceScope:'peer-new-ice',proximityMembership:{...f.getPolicy().proximityMembership,mediaScope:'peer-new-media'}});assert.equal(await capture,true);assert.equal(f.captures.length,1);assert.equal(f.session.snapshot().devices.camera.status,'on');assert.equal(f.session.snapshot().notice,'');
});
for(const kind of ['microphone','camera'])test(`unknown policy delays ${kind} capture and second click cancels before the first GET completes`,async t=>{
 const f=fixture(t),wait=deferred();f.interceptApi((path,o,normal)=>path==='/api/media'?wait.promise:normal());const first=f.session.toggleDevice(kind);assert.equal(f.captures.length,0);assert.equal(await f.session.toggleDevice(kind),false);wait.resolve(f.getPolicy());assert.equal(await first,false);assert.equal(f.captures.length,0);assert.equal(f.calls.some(c=>c.body?.enabled),false);
});
test('unknown policy never opens screen picker or requests consent before Join-first guidance',async t=>{
 const f=fixture(t);assert.equal(await f.session.toggleDevice('screen'),false);assert.equal(f.captures.length,0);assert.equal(f.calls.length,0);assert.match(f.session.snapshot().notice,/Join audio before sharing/);
});
test('independent mic and camera clicks share one pending join and each capture once after consent',async t=>{
 const f=fixture(t),wait=deferred();f.push({});f.interceptApi(async(path,o,normal)=>{const result=normal();if(path==='/api/media/state'&&o.body.enabled){f.scope({mediaScope:'grant'});await wait.promise;}return result;});const mic=f.session.toggleDevice('microphone');await tick();const camera=f.session.toggleDevice('camera');assert.equal(f.captures.length,0);wait.resolve();assert.deepEqual(await Promise.all([mic,camera]),[true,true]);assert.equal(f.captures.length,2);assert.equal(f.calls.filter(c=>c.path==='/api/media/state'&&c.body.enabled).length,1);
});
test('cancel then re-request during a shared join keeps only the newest capture intent',async t=>{
 const f=fixture(t),wait=deferred();f.push({});f.interceptApi(async(path,o,normal)=>{const result=normal();if(path==='/api/media/state'&&o.body.enabled){f.scope({mediaScope:'grant'});await wait.promise;}return result;});const old=f.session.toggleDevice('camera');await tick();assert.equal(await f.session.toggleDevice('camera'),false);const latest=f.session.toggleDevice('camera');wait.resolve();assert.equal(await old,false);assert.equal(await latest,true);assert.equal(f.captures.length,1);
});

for(const field of ['enabled','canPublish','canSend','canReceive'])for(const value of [undefined,'true','false'])test(`proximity-v1 ${field} must be boolean (${value===undefined?'missing':JSON.stringify(value)})`,async t=>{
 const f=fixture(t);await f.session.setJoined(true);await f.session.toggleDevice('microphone');const peer=current(f),track=f.session.snapshot().devices.microphone.stream.getTracks()[0];
 const changes=field==='enabled'?{enabled:value}:field==='canPublish'?{context:{...f.getPolicy().context,canPublish:value}}:{peers:[{...f.getPolicy().peers[0],[field]:value}]};f.push(changes);assert.match(f.session.snapshot().policyError,/Invalid or unsupported/);assert.equal(peer.closed,true);assert.equal(track.readyState,'ended');assert.deepEqual(policyPeers(f.getPolicy()),[]);const calls=f.calls.length,captures=f.captures.length;assert.equal(await f.session.toggleDevice('camera'),false);await f.session.onSignal(incomingSignal(f.getPolicy(),{candidate:{candidate:'must-not-apply'}}));assert.equal(f.calls.length,calls);assert.equal(f.captures.length,captures);
});
