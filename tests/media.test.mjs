// Unit tests use deliberately injected browser fakes. They are not device or live transport proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMediaSession, mediaCapabilities, describeMediaError, peerDirection, policyPeers} from '../src/media.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve,reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
class Track { constructor(kind='audio'){this.kind=kind;this.readyState='live';this.stopped=0;this.muted=false;} stop(){this.readyState='ended';this.stopped++;} }
class Stream { constructor(tracks=[]){this.tracks=tracks;} getTracks(){return this.tracks;} }
class Peer {
  constructor(config){this.config=config;this.transceivers=[];this.connectionState='new';this.iceGatheringState='new';this.candidates=[];this.closed=false;this.stats=[];Peer.instances.push(this);}
  addTransceiver(kind,{direction}={}){const t={kind,direction,mid:String(this.transceivers.length),sender:{track:null,async replaceTrack(track){this.track=track;}}};this.transceivers.push(t);return t;}
  getTransceivers(){return this.transceivers;}
  async createOffer(){return {type:'offer',sdp:'unit-test-offer'};}
  async createAnswer(){return {type:'answer',sdp:'unit-test-answer'};}
  async setLocalDescription(description){this.localDescription=description;}
  async setRemoteDescription(description){this.remoteDescription=description;if(description.type==='offer'&&!this.transceivers.length)for(const k of ['audio','video','video'])this.addTransceiver(k,{direction:'sendrecv'});}
  async addIceCandidate(c){this.candidates.push(c);}
  async getStats(){return this.stats;}
  close(){this.closed=true;this.connectionState='closed';}
}
Peer.instances=[];
function fixture({self='a',peers=[],capture,screen,policy:policyExtra={}}={}){
  let room='r'; const calls=[]; let serverPolicy={selfId:self,roomId:room,enabled:false,context:{kind:'proximity',canPublish:true},peers,...policyExtra};
  let devicesCalls=0,displayCalls=0;
  const timers = new Map(); let tid=0;
  const env={isSecureContext:true,RTCPeerConnection:Peer,MediaStream:Stream,navigator:{mediaDevices:{getUserMedia:args=>{devicesCalls++;return capture?capture(args):Promise.resolve(new Stream([new Track(args.video?'video':'audio')]));},getDisplayMedia:args=>{displayCalls++;return screen?screen(args):Promise.resolve(new Stream([new Track('video')]));}}},crypto:{randomUUID:()=>`conn-${++tid}`},setTimeout:fn=>{const id=++tid;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)};
  const api=async(path,options={})=>{calls.push({path,...options});if(path==='/api/media')return structuredClone(serverPolicy);if(path==='/api/media/state'){serverPolicy.enabled=options.body.enabled;return structuredClone(serverPolicy);}return {ok:true};};
  const session=createMediaSession({api,getState:()=>({room:{id:room}}),env});
  return {session,env,calls,timers,get devicesCalls(){return devicesCalls;},get displayCalls(){return displayCalls;},set policy(p){serverPolicy={...serverPolicy,...p};},get policy(){return serverPolicy;},room(value){room=value;serverPolicy.roomId=value;serverPolicy.enabled=false;}};
}

test('capability support is not treated as permission or verified transport',()=>{
  assert.equal(mediaCapabilities({}).devices,false);
  assert.match(mediaCapabilities({}).deviceReason,/HTTPS/);
  const s=fixture();assert.equal(s.session.snapshot().joined,false);assert.equal(s.devicesCalls,0);assert.equal(s.displayCalls,0);s.session.destroy();
});
test('role direction and peer graph are only taken from server policy',()=>{
  assert.equal(peerDirection({canSend:true,canReceive:false}),'sendonly');
  assert.equal(peerDirection({canSend:false,canReceive:true}),'recvonly');
  assert.deepEqual(policyPeers({selfId:'a',peers:[{id:'a',canSend:true},{id:'b',canReceive:true},{id:'x'},{id:'b',canSend:true,canReceive:true}]}),[{id:'b',canSend:true,canReceive:true}]);
});
test('device denial is reported and never joins or creates an outgoing track',async()=>{
  const f=fixture({capture:async()=>{throw Object.assign(new Error('denied'),{name:'NotAllowedError'});}});
  assert.equal(await f.session.toggleDevice('microphone'),false);assert.equal(f.devicesCalls,1);
  assert.equal(f.session.snapshot().devices.microphone.status,'error');assert.match(f.session.snapshot().devices.microphone.error,/not allowed/);
  assert.equal(f.calls.filter(c=>c.path.endsWith('/state')).length,0);f.session.destroy();
});
test('capture is requested synchronously from the gesture before policy fetch',async()=>{
  const wait=deferred(); const f=fixture({screen:()=>wait.promise});const promise=f.session.toggleDevice('screen');
  assert.equal(f.displayCalls,1);assert.equal(f.calls.length,0);
  const track=new Track('video');wait.resolve(new Stream([track]));assert.equal(await promise,true);
  assert.equal(f.session.snapshot().devices.screen.status,'on');f.session.destroy();assert.equal(track.readyState,'ended');
});
test('leaving stops all local devices and closes real-API-shaped peer lifecycles',async()=>{
  const f=fixture({peers:[{id:'b',canSend:true,canReceive:true}]});await f.session.toggleDevice('microphone');await tick();
  const stream=f.session.snapshot().devices.microphone.stream, pc=Peer.instances.at(-1);
  assert.deepEqual(pc.config,{iceServers:[]});assert.equal(pc.getTransceivers().length,3);assert.equal(pc.getTransceivers()[0].sender.track,stream.getTracks()[0]);
  assert.equal(f.calls.some(c=>c.path.endsWith('/signal')&&c.body.description?.type==='offer'),true);
  await f.session.setJoined(false);assert.equal(pc.closed,true);assert.equal(stream.getTracks()[0].readyState,'ended');assert.equal(f.session.snapshot().peers.length,0);assert.equal(f.timers.size,0);f.session.destroy();
});
test('pending permission response cannot resurrect devices after destroy',async()=>{
  const wait=deferred(),f=fixture({capture:()=>wait.promise});const promise=f.session.toggleDevice('camera');f.session.destroy();const track=new Track('video');wait.resolve(new Stream([track]));
  assert.equal(await promise,false);assert.equal(track.readyState,'ended');assert.equal(f.calls.some(c=>c.body?.enabled===true),false);
});
test('second click cancels a pending permission response and stops the late stream',async()=>{
  const wait=deferred(),f=fixture({capture:()=>wait.promise});const first=f.session.toggleDevice('camera');assert.equal(await f.session.toggleDevice('camera'),false);
  const track=new Track('video');wait.resolve(new Stream([track]));assert.equal(await first,false);assert.equal(track.readyState,'ended');assert.equal(f.session.snapshot().devices.camera.status,'off');f.session.destroy();
});
test('room switch stops devices and tears down transports; late signals cannot cross room',async()=>{
  const f=fixture({peers:[{id:'b',canSend:true,canReceive:true}]});await f.session.toggleDevice('camera');await tick();const oldStream=f.session.snapshot().devices.camera.stream,pc=Peer.instances.at(-1),before=Peer.instances.length;
  f.room('other');await f.session.update();assert.equal(f.session.snapshot().joined,false);assert.equal(pc.closed,true);assert.equal(oldStream.getTracks()[0].readyState,'ended');
  await f.session.onSignal({roomId:'r',from:'b',connectionId:'late',description:{type:'offer',sdp:'late'}});assert.equal(Peer.instances.length,before);f.session.destroy();
});
test('pending capture is stopped when the server revokes publishing role',async()=>{
  const wait=deferred(),f=fixture({capture:()=>wait.promise});await f.session.setJoined(true);const pending=f.session.toggleDevice('microphone');
  f.policy={context:{kind:'audience',canPublish:false}};const track=new Track();wait.resolve(new Stream([track]));assert.equal(await pending,false);assert.equal(track.readyState,'ended');assert.equal(f.session.snapshot().devices.microphone.status,'off');f.session.destroy();
});
test('quiet-zone and role updates stop capture and remove now-forbidden peers',async()=>{
  const f=fixture({peers:[{id:'b',canSend:true,canReceive:true}]});await f.session.toggleDevice('microphone');await tick();const track=f.session.snapshot().devices.microphone.stream.getTracks()[0],pc=Peer.instances.at(-1);
  f.policy={context:{kind:'silent',canPublish:false},peers:[]};await f.session.refreshPolicy(true);assert.equal(track.readyState,'ended');assert.equal(pc.closed,true);assert.equal(f.session.snapshot().peers.length,0);assert.equal(await f.session.toggleDevice('microphone'),false);assert.equal(f.devicesCalls,1);f.session.destroy();
});
test('audience SDP is recvonly and no outgoing device is captured',async()=>{
  const f=fixture({self:'a',peers:[{id:'b',canSend:false,canReceive:true}],policy:{context:{kind:'audience',canPublish:false}}});await f.session.setJoined(true);await tick();const pc=Peer.instances.at(-1);
  assert.deepEqual(pc.transceivers.map(t=>t.direction),['recvonly','recvonly','recvonly']);assert.equal(await f.session.toggleDevice('camera'),false);assert.equal(f.devicesCalls,0);f.session.destroy();
});
test('answerer accepts only authorized server graph peer and buffers early ICE',async()=>{
  const f=fixture({self:'z',peers:[{id:'a',canSend:true,canReceive:true}]});await f.session.setJoined(true);const before=Peer.instances.length;
  await f.session.onSignal({roomId:'r',from:'intruder',connectionId:'x',description:{type:'offer',sdp:'x'}});assert.equal(Peer.instances.length,before);
  await f.session.onSignal({roomId:'r',from:'a',connectionId:'valid',candidate:{candidate:'unit-ice'}});
  await f.session.onSignal({roomId:'r',from:'a',connectionId:'valid',description:{type:'offer',sdp:'x'}});const pc=Peer.instances.at(-1);
  assert.equal(pc.localDescription.type,'answer');assert.equal(pc.candidates.length,1);assert.equal(pc.candidates[0].candidate,'unit-ice');f.session.destroy();
});
test('transport failure reports zero ICE honestly and retry closes previous transport',async()=>{
  const f=fixture({peers:[{id:'b',canSend:true,canReceive:true}]});await f.session.setJoined(true);await tick();const pc=Peer.instances.at(-1);pc.iceGatheringState='complete';pc.onicegatheringstatechange();
  assert.match(f.session.snapshot().peers[0].error,/No local ICE candidates/);for(const fn of [...f.timers.values()])fn();assert.equal(f.session.snapshot().peers[0].status,'failed');
  await f.session.retry();assert.equal(pc.closed,true);assert.notEqual(Peer.instances.at(-1),pc);assert.equal(f.session.snapshot().peers[0].status,'connecting');f.session.destroy();
});
test('server opt-out revocation stops a local stream instead of leaving a hidden capture',async()=>{
  const f=fixture();await f.session.toggleDevice('camera');const track=f.session.snapshot().devices.camera.stream.getTracks()[0];f.policy={enabled:false};await f.session.refreshPolicy(true);
  assert.equal(f.session.snapshot().joined,false);assert.equal(track.readyState,'ended');f.session.destroy();
});
test('capture error names have useful recovery text',()=>{
  assert.match(describeMediaError({name:'NotFoundError'},'camera'),/No camera/);
  assert.match(describeMediaError({name:'NotReadableError'},'microphone'),/Another application/);
  assert.match(describeMediaError({name:'AbortError'},'screen'),/cancelled/);
});
test('pushed server policy silences immediately and rejects policies for other rooms',async()=>{
  const f=fixture({peers:[{id:'b',canSend:true,canReceive:true}]});await f.session.toggleDevice('microphone');await tick();const track=f.session.snapshot().devices.microphone.stream.getTracks()[0],pc=Peer.instances.at(-1);
  f.session.acceptPolicy({...f.policy,roomId:'other',context:{kind:'silent',canPublish:false},peers:[]});assert.equal(track.readyState,'live');
  f.session.acceptPolicy({...f.policy,context:{kind:'silent',canPublish:false},peers:[]});assert.equal(track.readyState,'ended');assert.equal(pc.closed,true);f.session.destroy();
});
