// Controlled promises, stream/peer fakes only. No browser device or network access.
import test from 'node:test';
import assert from 'node:assert/strict';
const {createMediaSession} = await import(process.env.MEDIA_SOURCE || '../src/media.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve,reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
class Track { constructor(kind='audio'){this.kind=kind;this.readyState='live';this.stopped=0;} stop(){this.readyState='ended';this.stopped++;} }
class Stream { constructor(tracks=[]){this.tracks=tracks;} getTracks(){return this.tracks;} }
class Peer {
 constructor(){this.transceivers=[];this.connectionState='new';this.iceGatheringState='new';this.closed=false;this.candidates=[];Peer.instances.push(this);}
 addTransceiver(kind,{direction}={}){const t={kind,direction,sender:{track:null,async replaceTrack(track){this.track=track;}}};this.transceivers.push(t);return t;}
 getTransceivers(){return this.transceivers;} async createOffer(){return {type:'offer',sdp:'fixture'};} async setLocalDescription(d){this.localDescription=d;} async setRemoteDescription(d){this.remoteDescription=d;if(!this.transceivers.length)for(const k of ['audio','video','video'])this.addTransceiver(k,{direction:'sendrecv'});} async createAnswer(){return {type:'answer',sdp:'fixture'};} async addIceCandidate(candidate){this.candidates.push(candidate);} close(){this.closed=true;}
}
Peer.instances=[];
function fixture({capture,screen,self='a',peers=[]}={}) {
 const state={user:{id:self},room:{id:'r'}},calls=[];
 let policy={selfId:self,roomId:'r',enabled:false,context:{kind:'proximity',canPublish:true},peers};
 let interceptor,deviceCalls=0,screenCalls=0;
 const env={isSecureContext:true,RTCPeerConnection:Peer,MediaStream:Stream,setTimeout:()=>0,clearTimeout(){},navigator:{mediaDevices:{getUserMedia:args=>{deviceCalls++;return capture?capture(args):Promise.resolve(new Stream([new Track(args.video?'video':'audio')]));},getDisplayMedia:()=>{screenCalls++;return screen?screen():Promise.resolve(new Stream([new Track('video')]));}}}};
 const api=async(path,options={})=>{calls.push({path,...options});const normal=()=>{if(path==='/api/media')return structuredClone(policy);if(path==='/api/media/state'){policy={...policy,enabled:options.body.enabled};return structuredClone(policy);}return {ok:true};};return interceptor?interceptor(path,options,normal):normal();};
 const session=createMediaSession({api,getState:()=>state,env});
 return{session,state,calls,get policy(){return policy;},get deviceCalls(){return deviceCalls;},get screenCalls(){return screenCalls;},intercept(fn){interceptor=fn;},push(changes){policy={...policy,...changes};session.acceptPolicy(structuredClone(policy));},setPolicy(changes){policy={...policy,...changes};}};
}
const silent={context:{kind:'silent',canPublish:false},peers:[]};
const allowed={context:{kind:'proximity',canPublish:true},peers:[]};
for(const kind of ['microphone','camera','screen']) {
 test(`Silent entry invalidates pending ${kind}; exit never resumes its capture`,async t=>{
  const wait=deferred(),f=fixture({capture:()=>wait.promise,screen:()=>wait.promise});t.after(()=>f.session.destroy());await f.session.setJoined(true);
  const pending=f.session.toggleDevice(kind);f.push(silent);
  assert.equal(f.session.snapshot().devices[kind].status,'off');f.push(allowed);assert.equal(f.session.snapshot().devices[kind].error,'');
  const track=new Track(kind==='microphone'?'audio':'video');wait.resolve(new Stream([track]));
  assert.equal(await pending,false);assert.equal(track.readyState,'ended');assert.equal(f.session.snapshot().devices[kind].status,'off');
 });
 test(`Late ${kind} permission success cannot replace a deliberate post-exit request`,async t=>{
  const waits=[deferred(),deferred()];let count=0;const capture=()=>waits[count++].promise;const f=fixture({capture,screen:capture});t.after(()=>f.session.destroy());await f.session.setJoined(true);
  const old=f.session.toggleDevice(kind);f.push(silent);f.push(allowed);const newer=f.session.toggleDevice(kind);
  const newTrack=new Track();waits[1].resolve(new Stream([newTrack]));assert.equal(await newer,true);
  const oldTrack=new Track();waits[0].resolve(new Stream([oldTrack]));assert.equal(await old,false);
  assert.equal(oldTrack.readyState,'ended');assert.equal(newTrack.readyState,'live');assert.equal(f.session.snapshot().devices[kind].stream.getTracks()[0],newTrack);assert.equal(f.session.snapshot().devices[kind].status,'on');
 });
 test(`Late ${kind} capture rejection cannot overwrite newer device state`,async t=>{
  const waits=[deferred(),deferred()];let count=0;const capture=()=>waits[count++].promise;const f=fixture({capture,screen:capture});t.after(()=>f.session.destroy());await f.session.setJoined(true);
  const old=f.session.toggleDevice(kind);f.push(silent);f.push(allowed);const newer=f.session.toggleDevice(kind);
  waits[1].resolve(new Stream([new Track()]));assert.equal(await newer,true);waits[0].reject(new Error('old permission failed'));assert.equal(await old,false);assert.equal(f.session.snapshot().devices[kind].status,'on');assert.equal(f.session.snapshot().devices[kind].error,'');
 });
 test(`Late ${kind} policy continuation cannot overwrite a newer post-exit stream`,async t=>{
  const waits=[deferred(),deferred()],policyWait=deferred();let count=0;const capture=()=>waits[count++].promise;const f=fixture({capture,screen:capture});t.after(()=>f.session.destroy());await f.session.setJoined(true);
  const oldPolicy=structuredClone(f.policy);let hold=true;f.intercept((path,options,normal)=>path==='/api/media'&&hold?policyWait.promise:normal());
  const old=f.session.toggleDevice(kind),oldTrack=new Track();waits[0].resolve(new Stream([oldTrack]));await tick();
  f.push(silent);f.push(allowed);hold=false;
  const newer=f.session.toggleDevice(kind),newTrack=new Track();waits[1].resolve(new Stream([newTrack]));
  policyWait.resolve(oldPolicy);assert.equal(await old,false);assert.equal(await newer,true);assert.equal(oldTrack.readyState,'ended');assert.equal(newTrack.readyState,'live');assert.equal(f.session.snapshot().devices[kind].status,'on');
 });
 test(`Active ${kind} stops immediately, and retained opt-in restores only listening eligibility`,async t=>{
  const peer={id:'b',canSend:true,canReceive:true};const f=fixture({peers:[peer]});t.after(()=>f.session.destroy());await f.session.toggleDevice(kind);await tick();const track=f.session.snapshot().devices[kind].stream.getTracks()[0];
  f.push(silent);assert.equal(track.readyState,'ended');assert.equal(f.session.snapshot().peers.length,0);assert.equal(await f.session.toggleDevice(kind),false);
  const calls=f.deviceCalls+f.screenCalls;f.push({...allowed,peers:[peer]});await tick();assert.equal(f.session.snapshot().joined,true);assert.equal(f.session.snapshot().devices[kind].status,'off');assert.equal(f.deviceCalls+f.screenCalls,calls);assert.equal(f.session.snapshot().peers.length,1);
  assert.equal(await f.session.toggleDevice(kind),true);assert.equal(f.deviceCalls+f.screenCalls,calls+1);
 });
}
test('Older same-room GET cannot replace newer pushed Silent authority or return it as accepted',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());await f.session.setJoined(true);const wait=deferred(),stale={...f.policy,peers:[{id:'b',canSend:true,canReceive:true}]};f.intercept((path,o,normal)=>path==='/api/media'?wait.promise:normal());
 const refresh=f.session.refreshPolicy(true);f.push(silent);wait.resolve(stale);const result=await refresh;
 assert.equal(f.session.snapshot().policy.context.kind,'silent');assert.equal(result.context.kind,'silent');assert.equal(f.session.snapshot().peers.length,0);
});
test('Older GET rejection cannot erase a newer pushed policy or close newer eligible peers',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());await f.session.setJoined(true);const wait=deferred();f.intercept((path,o,normal)=>path==='/api/media'?wait.promise:normal());const refresh=f.session.refreshPolicy(true);
 f.push({...allowed,peers:[{id:'b',canSend:true,canReceive:true}]});wait.reject(new Error('stale network failure'));await refresh;assert.equal(f.session.snapshot().policyError,'');assert.equal(f.session.snapshot().peers.length,1);
});
test('Old-room refresh cannot block a new-room request, or clear its in-flight owner',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());await f.session.setJoined(true);const old=deferred(),newer=deferred();let count=0;f.intercept((path,o,normal)=>path==='/api/media'?[old,newer][count++].promise:normal());const stale=f.session.refreshPolicy(true);
 f.state.room={id:'other'};f.setPolicy({roomId:'other',enabled:false});const update=f.session.update();assert.equal(count,2);
 old.resolve({selfId:'a',roomId:'r',enabled:true,...allowed});await stale;const same=f.session.refreshPolicy(true);assert.equal(count,2);
 newer.resolve(f.policy);await Promise.all([update,same]);assert.equal(f.session.snapshot().roomId,'other');assert.equal(f.session.snapshot().policy.roomId,'other');
});
test('Known Silent policy blocks direct join as well as capture, and exit permits an explicit join',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());f.push(silent);assert.equal(await f.session.setJoined(true),false);assert.equal(f.calls.some(c=>c.body?.enabled===true),false);assert.equal(await f.session.toggleDevice('camera'),false);assert.equal(f.deviceCalls,0);
 f.push(allowed);assert.equal(f.session.snapshot().notice,'');assert.equal(await f.session.setJoined(true),true);assert.equal(f.session.snapshot().joined,true);
});
test('Audience denial transition also invalidates pending capture even after publishing is restored',async t=>{
 const wait=deferred(),f=fixture({capture:()=>wait.promise});t.after(()=>f.session.destroy());await f.session.setJoined(true);const pending=f.session.toggleDevice('microphone');f.push({context:{kind:'audience',canPublish:false}});f.push(allowed);const track=new Track();wait.resolve(new Stream([track]));assert.equal(await pending,false);assert.equal(track.readyState,'ended');
});
test('Busy proximity remains distinct from Silent and permits joining without capture',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());f.push({context:{kind:'proximity',canPublish:false,reason:'Nearby calls are paused for your current status'},peers:[]});assert.equal(await f.session.setJoined(true),true);assert.equal(await f.session.toggleDevice('microphone'),false);assert.equal(f.deviceCalls,0);assert.match(f.session.snapshot().devices.microphone.error,/current status/);assert.doesNotMatch(f.session.snapshot().devices.microphone.error,/Audience/);
});
test('Wrong-identity push cannot modify authority in the same room',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());await f.session.setJoined(true);f.session.acceptPolicy({...f.policy,selfId:'different-account',...silent});assert.equal(f.session.snapshot().policy.context.kind,'proximity');
});
test('Same-room account change stops old devices and invalidates previous refresh',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());await f.session.toggleDevice('camera');const track=f.session.snapshot().devices.camera.stream.getTracks()[0];f.state.user={id:'b'};f.setPolicy({selfId:'b',enabled:false});await f.session.update();assert.equal(track.readyState,'ended');assert.equal(f.session.snapshot().joined,false);assert.equal(f.session.snapshot().policy.selfId,'b');
});
test('Accepted push releases obsolete GET ownership; its finally cannot clear the newer GET',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());await f.session.setJoined(true);const waits=[deferred(),deferred()];let count=0;f.intercept((path,o,normal)=>path==='/api/media'?waits[count++].promise:normal());const old=f.session.refreshPolicy(true);f.push(silent);const newer=f.session.refreshPolicy(true);assert.equal(count,2);
 waits[0].resolve({...f.policy,...allowed});await old;const same=f.session.refreshPolicy(true);assert.equal(count,2);assert.equal(f.session.snapshot().policy.context.kind,'silent');waits[1].resolve(f.policy);await Promise.all([newer,same]);assert.equal(f.session.snapshot().policy.context.kind,'silent');
});
test('Late capture waiting for join cannot overwrite a fresh post-exit request',async t=>{
 const waits=[deferred(),deferred()],join=deferred();let count=0;const f=fixture({capture:()=>waits[count++].promise});t.after(()=>f.session.destroy());let held=true;f.intercept((path,options,normal)=>path==='/api/media/state'&&options.body.enabled&&held?join.promise:normal());
 const old=f.session.toggleDevice('camera'),oldTrack=new Track();waits[0].resolve(new Stream([oldTrack]));await tick();f.push(silent);f.push({...allowed,enabled:true});held=false;join.resolve(f.policy);await tick();const newer=f.session.toggleDevice('camera'),newTrack=new Track();waits[1].resolve(new Stream([newTrack]));assert.equal(await old,false);assert.equal(await newer,true);assert.equal(oldTrack.readyState,'ended');assert.equal(newTrack.readyState,'live');assert.equal(f.session.snapshot().devices.camera.status,'on');
});

test('Silent clears early ICE buffers before receiving a later deliberate connection',async t=>{
 const peer={id:'a',canSend:true,canReceive:true},f=fixture({self:'z',peers:[peer]});t.after(()=>f.session.destroy());await f.session.setJoined(true);
 await f.session.onSignal({roomId:'r',from:'a',connectionId:'same-connection',candidate:{candidate:'stale-before-silent'}});
 f.push(silent);f.push({...allowed,peers:[peer]});await f.session.onSignal({roomId:'r',from:'a',connectionId:'same-connection',description:{type:'offer',sdp:'fixture'}});assert.deepEqual(Peer.instances.at(-1).candidates,[]);
});
