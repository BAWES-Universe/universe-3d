// Controlled local promises, fake elapsed timers, tracks and peers only.
// These tests do not request devices, contact a relay, or prove production leakage.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const {createMediaSession} = await import(process.env.MEDIA_SOURCE || '../src/media.js');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const silentArea={id:'quiet',name:'Quiet',action:'silent',x:5,z:0,width:2,depth:2};
class Track {constructor(kind='audio'){this.kind=kind;this.readyState='live';}stop(){this.readyState='ended';}}
class Stream {constructor(tracks=[]){this.tracks=tracks;}getTracks(){return this.tracks;}}
class Peer {
 constructor(config){this.config=config;this.transceivers=[];this.connectionState='new';this.iceGatheringState='new';this.closed=false;Peer.instances.push(this);}
 addTransceiver(kind,{direction}){const value={kind,direction,sender:{track:null,async replaceTrack(track){this.track=track;}}};this.transceivers.push(value);return value;}
 getTransceivers(){return this.transceivers;}async createOffer(){return {type:'offer',sdp:'local-fixture'};}async setLocalDescription(value){this.localDescription=value;}close(){this.closed=true;}
}
Peer.instances=[];
function fixture({capture,screen}={}){
 let wall=100000,elapsed=0,serial=0,intercept,captureCalls=0;
 const state={user:{id:'a'},room:{id:'r',scene:{areas:[structuredClone(silentArea)]}},scene:{areas:[],objects:[]},position:{x:0,z:0},ready:true};
 let policy={selfId:'a',roomId:'r',enabled:false,context:{kind:'proximity',canPublish:true},peers:[{id:'b',canSend:true,canReceive:true}]};
 const calls=[],timers=new Map();
 const env={isSecureContext:true,RTCPeerConnection:Peer,MediaStream:Stream,AbortController,performance:{now:()=>elapsed},setTimeout(fn,delay){const id=++serial;timers.set(id,{fn,at:elapsed+delay});return id;},clearTimeout(id){timers.delete(id);},navigator:{mediaDevices:{getUserMedia(args){captureCalls++;return capture?capture(args):Promise.resolve(new Stream([new Track(args.video?'video':'audio')]));},getDisplayMedia(){captureCalls++;return screen?screen():Promise.resolve(new Stream([new Track('video')]));}}}};
 const api=async(path,options={})=>{calls.push({path,...options});const normal=()=>{if(path==='/api/media')return structuredClone(policy);if(path==='/api/media/state'){policy.enabled=options.body.enabled;return structuredClone(policy);}return {ok:true};};return intercept?intercept(path,options,normal):normal();};
 const session=createMediaSession({api,getState:()=>state,env,now:()=>wall});
 return {state,session,calls,timers,env,get policy(){return policy;},get captureCalls(){return captureCalls;},intercept(fn){intercept=fn;},set(changes){policy={...policy,...changes};},push(changes={}){policy={...policy,...changes};session.acceptPolicy(structuredClone(policy));},guard(){return session.checkLocalPolicy?.();},enter(){state.position={x:5,z:0};return this.guard();},exit(){state.position={x:0,z:0};return this.guard();},wall(value){wall=value;},elapse(ms){elapsed+=ms;},async advance(ms){elapsed+=ms;for(const[id,timer]of [...timers])if(timer.at<=elapsed){timers.delete(id);timer.fn();}await tick();}};
}
const mediaGets=f=>f.calls.filter(call=>call.path==='/api/media');

test('held current-policy GET has an 8s elapsed deadline; active tracks and peers stop despite clock rollback',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());await f.session.toggleDevice('microphone');await tick();const track=f.session.snapshot().devices.microphone.stream.getTracks()[0],peer=Peer.instances.at(-1),wait=deferred();
 f.intercept((path,o,normal)=>path==='/api/media'?wait.promise:normal());let done=false;const pending=f.session.refreshPolicy(true).then(value=>{done=true;return value;});f.wall(-999999);
 await f.advance(7999);assert.equal(track.readyState,'live');await f.advance(1);
 assert.equal(track.readyState,'ended','policy deadline must stop active capture');assert.equal(peer.closed,true);assert.equal(done,true,'a held GET cannot own refresh forever');assert.match(f.session.snapshot().policyError,/timed out/i);assert.equal(mediaGets(f).at(-1).signal.aborted,true);
 wait.resolve(f.policy);await pending;assert.equal(f.session.snapshot().peers.length,0);
});

test('held policy deadline immediately stops an acquired stream awaiting authorization, then ignores late success',async t=>{
 const track=new Track(),f=fixture({capture:()=>Promise.resolve(new Stream([track]))});t.after(()=>f.session.destroy());await f.session.setJoined(true);const wait=deferred();f.intercept((path,o,normal)=>path==='/api/media'?wait.promise:normal());const pending=f.session.toggleDevice('microphone');await tick();
 await f.advance(8000);assert.equal(track.readyState,'ended');assert.equal(f.session.snapshot().devices.microphone.status,'off');assert.match(f.session.snapshot().policyError,/timed out/i);wait.resolve(f.policy);assert.equal(await pending,false);
 f.intercept(null);await f.session.refreshPolicy(true);assert.equal(f.session.snapshot().policyError,'');assert.equal(f.session.snapshot().devices.microphone.status,'off');assert.equal(f.captureCalls,1);
});

for(const kind of ['microphone','camera','screen']){
 test(`local saved Silent guard stops active ${kind} and peers synchronously while authority GET is held`,async t=>{
  const f=fixture();t.after(()=>f.session.destroy());await f.session.toggleDevice(kind);await tick();const track=f.session.snapshot().devices[kind].stream.getTracks()[0],peer=Peer.instances.at(-1),wait=deferred();f.intercept((path,o,normal)=>path==='/api/media'?wait.promise:normal());void f.session.refreshPolicy(true);const calls=f.calls.length;
  f.enter();assert.equal(track.readyState,'ended','saved Silent must stop before its banner is rendered');assert.equal(peer.closed,true);assert.equal(f.session.snapshot().localSilent,true);assert.equal(f.session.snapshot().joined,true);assert.equal(f.session.snapshot().peers.length,0);
  for(let i=0;i<240;i++)f.guard();assert.equal(f.calls.length,calls,'frame guard is synchronous and sends no HTTP');assert.equal(await f.session.toggleDevice(kind),false);assert.equal(f.captureCalls,1);wait.resolve(f.policy);
 });
 test(`local Silent stops acquired pending ${kind} before a held GET resolves`,async t=>{
  const track=new Track(kind==='microphone'?'audio':'video'),capture=()=>Promise.resolve(new Stream([track])),f=fixture({capture,screen:capture});t.after(()=>f.session.destroy());await f.session.setJoined(true);const wait=deferred();f.intercept((path,o,normal)=>path==='/api/media'?wait.promise:normal());const pending=f.session.toggleDevice(kind);await tick();f.enter();
  assert.equal(track.readyState,'ended','acquired pending streams must stop synchronously');assert.equal(f.session.snapshot().devices[kind].status,'off');f.exit();f.intercept(null);await f.session.refreshPolicy(true);wait.resolve(f.policy);assert.equal(await pending,false);assert.equal(f.captureCalls,1);assert.equal(f.session.snapshot().devices[kind].status,'off');
 });
 test(`permission result for ${kind} arriving after local Silent exit never revives capture`,async t=>{
  const wait=deferred(),f=fixture({capture:()=>wait.promise,screen:()=>wait.promise});t.after(()=>f.session.destroy());await f.session.setJoined(true);const pending=f.session.toggleDevice(kind);f.enter();f.exit();await f.session.refreshPolicy(true);const track=new Track();wait.resolve(new Stream([track]));
  assert.equal(await pending,false);assert.equal(track.readyState,'ended');assert.equal(f.session.snapshot().devices[kind].status,'off');assert.equal(f.captureCalls,1);
 });
}

test('local Silent exit grants nothing: stale GET and allowed push cannot replace a fresh post-exit fetch',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());await f.session.toggleDevice('camera');const wait=deferred();f.intercept((path,o,normal)=>path==='/api/media'?wait.promise:normal());const old=f.session.refreshPolicy(true);f.enter();f.exit();f.push();await tick();
 assert.equal(f.session.snapshot().peers.length,0);assert.equal(f.session.snapshot().awaitingPolicy,true);assert.match(f.session.snapshot().policyError,/confirm/i);assert.equal(await f.session.toggleDevice('camera'),false);assert.equal(f.captureCalls,1);
 wait.resolve(f.policy);await old;assert.equal(f.session.snapshot().peers.length,0);f.intercept(null);await f.session.refreshPolicy(true);await tick();assert.equal(f.session.snapshot().awaitingPolicy,false);assert.equal(f.session.snapshot().peers.length,1);assert.equal(f.session.snapshot().devices.camera.status,'off');assert.equal(f.captureCalls,1);assert.equal(await f.session.toggleDevice('camera'),true);
});

test('local Silent guard uses only committed room geometry, including overlap and boundary; draft edits cannot grant',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());await f.session.setJoined(true);f.state.scene.areas=[{...silentArea,x:0}];f.guard();assert.equal(f.session.snapshot().peers.length,1,'unsaved draft does not become authority');
 f.state.room.scene.areas.unshift({...silentArea,id:'meeting',action:'meeting'});f.state.position={x:4,z:1};f.guard();assert.equal(f.session.snapshot().peers.length,0);assert.equal(f.session.snapshot().localSilent,true);f.state.scene.areas=[];f.guard();f.push();assert.equal(f.session.snapshot().localSilent,true);assert.equal(f.session.snapshot().peers.length,0,'draft removal never overrides saved Silent');
});

test('initial saved Silent blocks explicit join and all device prompts even without a server policy',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());f.state.position={x:5,z:0};assert.equal(await f.session.setJoined(true),false);assert.equal(await f.session.toggleDevice('camera'),false);assert.equal(f.captureCalls,0);assert.equal(f.calls.length,0);assert.equal(f.session.snapshot().joined,false);
});

for(const change of ['room','account','revoked','destroy'])test(`local ${change} retirement stops pending acquired capture and ignores held policy completion`,async t=>{
 const track=new Track(),f=fixture({capture:()=>Promise.resolve(new Stream([track]))});t.after(()=>f.session.destroy());await f.session.setJoined(true);const wait=deferred();f.intercept((path,o,normal)=>path==='/api/media'?wait.promise:normal());const pending=f.session.toggleDevice('microphone');await tick();
 if(change==='room')f.state.room={id:'other',scene:{areas:[]}};if(change==='account')f.state.user={id:'b'};if(change==='revoked')f.state.ready=false;if(change==='destroy')f.session.destroy();else f.guard();
 assert.equal(track.readyState,'ended');assert.equal(f.session.snapshot().joined,false);wait.resolve(f.policy);assert.equal(await pending,false);assert.equal(f.session.snapshot().peers.length,0);
});

test('push retirement clears obsolete timeout; a newer healthy policy is not stopped by the old deadline',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());await f.session.toggleDevice('microphone');const track=f.session.snapshot().devices.microphone.stream.getTracks()[0],wait=deferred();f.intercept((path,o,normal)=>path==='/api/media'?wait.promise:normal());const old=f.session.refreshPolicy(true);f.push();await f.advance(8000);assert.equal(track.readyState,'live');assert.equal(f.session.snapshot().policyError,'');assert.equal(f.session.snapshot().peers.length,1);wait.reject(Error('late network failure'));await old;
});

test('wrong current-policy identity stops active capture, and a restored policy never restarts it',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());await f.session.toggleDevice('camera');const track=f.session.snapshot().devices.camera.stream.getTracks()[0];f.intercept((path,o,normal)=>path==='/api/media'?{...f.policy,selfId:'other'}:normal());await f.session.refreshPolicy(true);assert.equal(track.readyState,'ended');assert.match(f.session.snapshot().policyError,/account/i);f.intercept(null);await f.session.refreshPolicy(true);assert.equal(f.session.snapshot().devices.camera.status,'off');assert.equal(f.captureCalls,1);
});

test('current-policy network rejection invalidates unresolved permission prompts before recovery',async t=>{
 const wait=deferred(),f=fixture({capture:()=>wait.promise});t.after(()=>f.session.destroy());await f.session.setJoined(true);const pending=f.session.toggleDevice('camera');f.intercept((path,o,normal)=>path==='/api/media'?Promise.reject(Error('offline')):normal());await f.session.refreshPolicy(true);f.intercept(null);await f.session.refreshPolicy(true);const track=new Track();wait.resolve(new Stream([track]));assert.equal(await pending,false);assert.equal(track.readyState,'ended');assert.equal(f.captureCalls,1);
});

test('main area reconciliation invokes its synchronous deny guard before publishing the Silent banner',async()=>{
 const path=process.env.MAIN_SOURCE || new URL('../src/main.js',import.meta.url),source=await readFile(path,'utf8');const start=source.indexOf('function updateAreas('),end=source.indexOf('\nasync function sendPresence',start);const order=[];
 const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,new Proxy({}, {set(target,key,value){if(id==='area-message'&&key==='textContent')order.push('banner');target[key]=value;return true;}}));return nodes.get(id);};
 const ctx={state:{scene:{areas:[silentArea],objects:[]},user:{id:'a'},position:{x:5,z:0},ready:true,online:true},media:{checkLocalPolicy(){order.push('guard');}},contains:()=>true,areaActions:null,personalAreas:null,botEditor:null,building:false,modalOpen:()=>false,isTyping:()=>false,currentAreas:null,activeMediaArea:areas=>areas[0],mediaAreaLabel:()=>'',mediaAreaMessage:()=>'',nearby:null,$};
 vm.runInNewContext(source.slice(start,end)+';updateAreas();',ctx);assert.deepEqual(order,['guard','banner']);
});


test('late GET is rejected using monotonic elapsed time even when its timer callback has not run',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());await f.session.toggleDevice('camera');const track=f.session.snapshot().devices.camera.stream.getTracks()[0],wait=deferred();f.intercept((path,o,normal)=>path==='/api/media'?wait.promise:normal());const pending=f.session.refreshPolicy(true);
 f.elapse(9000);f.wall(-1);wait.resolve(f.policy);await pending;assert.equal(track.readyState,'ended');assert.match(f.session.snapshot().policyError,/timed out/i);assert.equal(f.session.snapshot().peers.length,0);
});

test('manual retry after policy timeout restores listening without a stale warning or automatic capture',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());await f.session.toggleDevice('camera');const wait=deferred();f.intercept((path,o,normal)=>path==='/api/media'?wait.promise:normal());void f.session.refreshPolicy(true);await f.advance(8000);assert.match(f.session.snapshot().policyError,/timed out/i);assert.equal(await f.session.toggleDevice('camera'),false);
 f.intercept(null);await f.session.retry();assert.equal(f.session.snapshot().policyError,'');assert.equal(f.session.snapshot().devices.camera.error,'');assert.equal(f.session.snapshot().notice,'');assert.equal(f.session.snapshot().peers.length,1);assert.equal(f.captureCalls,1);wait.resolve(f.policy);
});

test('clicks while local exit awaits confirmation leave no stale paused warning after fresh policy',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());await f.session.setJoined(true);f.enter();f.exit();assert.equal(await f.session.setJoined(true),false);assert.equal(await f.session.toggleDevice('camera'),false);await f.session.refreshPolicy(true);
 assert.equal(f.session.snapshot().policyError,'');assert.equal(f.session.snapshot().notice,'');assert.equal(f.session.snapshot().devices.camera.error,'');assert.equal(f.captureCalls,0);
});


for(const completion of ['before','after'])test(`pre-opt-in GET completing ${completion} the join POST cannot cancel deliberate opt-in`,async t=>{
 const f=fixture();t.after(()=>f.session.destroy());const read=deferred(),write=deferred(),disabled=structuredClone(f.policy);let heldRead=true;
 f.intercept((path,o,normal)=>path==='/api/media'&&heldRead?(heldRead=false,read.promise):path==='/api/media/state'&&o.body.enabled?write.promise.then(normal):normal());
 const preJoin=f.session.refreshPolicy(true),join=f.session.setJoined(true);
 if(completion==='before'){read.resolve(disabled);await preJoin;write.resolve();}else{write.resolve();await tick();read.resolve(disabled);}
 assert.equal(await join,true);await preJoin;assert.equal(f.session.snapshot().joined,true);assert.equal(f.session.snapshot().policy.enabled,true);assert.equal(f.session.snapshot().notice,'');assert.equal(f.captureCalls,0);
});

test('late pre-Silent prompt cannot overwrite a deliberate fresh post-exit capture',async t=>{
 const old=deferred(),fresh=deferred();let attempts=0;const f=fixture({capture:()=>[old,fresh][attempts++].promise});t.after(()=>f.session.destroy());await f.session.setJoined(true);const first=f.session.toggleDevice('camera');f.enter();f.exit();await f.session.refreshPolicy(true);const second=f.session.toggleDevice('camera'),newTrack=new Track('video');fresh.resolve(new Stream([newTrack]));assert.equal(await second,true);
 const oldTrack=new Track('video');old.resolve(new Stream([oldTrack]));assert.equal(await first,false);assert.equal(oldTrack.readyState,'ended');assert.equal(newTrack.readyState,'live');assert.equal(f.session.snapshot().devices.camera.stream.getTracks()[0],newTrack);
});

test('pending join completion after local Silent entry does not restore opt-in or capture',async t=>{
 const join=deferred(),track=new Track(),f=fixture({capture:()=>Promise.resolve(new Stream([track]))});t.after(()=>f.session.destroy());f.intercept((path,o,normal)=>path==='/api/media/state'&&o.body.enabled?join.promise.then(normal):normal());const pending=f.session.toggleDevice('microphone');await tick();assert.equal(f.session.snapshot().joining,true);f.enter();assert.equal(track.readyState,'ended');f.exit();await f.session.refreshPolicy(true);join.resolve();assert.equal(await pending,false);assert.equal(f.session.snapshot().joined,false);assert.equal(f.session.snapshot().joining,false);assert.equal(f.session.snapshot().peers.length,0);
});


test('ordinary policy pushes cannot starve post-exit GET confirmation or replace newer pushed recipients',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());await f.session.setJoined(true);f.enter();f.exit();const wait=deferred(),fetched=structuredClone(f.policy);f.intercept((path,o,normal)=>path==='/api/media'?wait.promise:normal());const confirm=f.session.refreshPolicy(true);
 for(let i=0;i<5;i++){f.elapse(100);f.push({peers:[{id:'c',canSend:true,canReceive:true}]});assert.equal(mediaGets(f).at(-1).signal.aborted,false);assert.equal(f.session.snapshot().peers.length,0);}
 wait.resolve(fetched);await confirm;assert.equal(f.session.snapshot().awaitingPolicy,false);assert.deepEqual(f.session.snapshot().policy.peers.map(p=>p.id),['c']);assert.deepEqual(f.session.snapshot().peers.map(p=>p.id),['c']);assert.equal(f.captureCalls,0);
});

for(const change of [{context:{kind:'silent',canPublish:false},peers:[]},{context:{kind:'meeting',group:'new-meeting-scope',canPublish:true}}])test(`post-exit GET never overrides newer ${change.context.kind==='meeting'?'context group':'pushed denial'}`,async t=>{
 const f=fixture();t.after(()=>f.session.destroy());await f.session.setJoined(true);f.enter();f.exit();const wait=deferred(),fetched=structuredClone(f.policy);f.intercept((path,o,normal)=>path==='/api/media'?wait.promise:normal());const confirm=f.session.refreshPolicy(true);f.push(change);wait.resolve(fetched);await confirm;
 assert.equal(f.session.snapshot().awaitingPolicy,true);assert.equal(f.session.snapshot().policy.context.kind,change.context?.kind||'proximity');if(change.context.group)assert.equal(f.session.snapshot().policy.context.group,change.context.group);assert.equal(f.session.snapshot().peers.length,0);
});

test('post-exit GET still times out under continuous allowed policy pushes',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());await f.session.setJoined(true);f.enter();f.exit();const wait=deferred();f.intercept((path,o,normal)=>path==='/api/media'?wait.promise:normal());const confirm=f.session.refreshPolicy(true);for(let i=0;i<8;i++){f.push();await f.advance(1000);}assert.match(f.session.snapshot().policyError,/timed out/i);await confirm;
 assert.equal(f.session.snapshot().awaitingPolicy,true);assert.match(f.session.snapshot().policyError,/timed out/i);f.push();assert.match(f.session.snapshot().policyError,/timed out/i);assert.equal(f.session.snapshot().peers.length,0);wait.resolve(f.policy);
});


test('server opt-out retires held confirmation ownership so the next current refresh is not blocked',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());await f.session.setJoined(true);f.enter();f.exit();const wait=deferred();f.intercept((path,o,normal)=>path==='/api/media'?wait.promise:normal());const old=f.session.refreshPolicy(true),count=mediaGets(f).length;f.push({enabled:false});assert.equal(mediaGets(f).at(-1).signal.aborted,true);f.intercept(null);await f.session.refreshPolicy(true);
 assert.equal(mediaGets(f).length,count+1);assert.equal(f.session.snapshot().joined,false);assert.equal(f.session.snapshot().awaitingPolicy,false);wait.resolve(f.policy);await old;assert.equal(f.session.snapshot().peers.length,0);assert.equal(await f.session.setJoined(true),true);
});

test('new saved Silent geometry stops capture despite a dirty retained editor base and held policy GET',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());f.state.room.revision=1;const draft=f.state.scene;await f.session.toggleDevice('camera');const track=f.session.snapshot().devices.camera.stream.getTracks()[0],wait=deferred();f.intercept((path,o,normal)=>path==='/api/media'?wait.promise:normal());void f.session.refreshPolicy(true);
 const saved={id:'r',revision:2,scene:{areas:[{...silentArea,x:0}]}};assert.equal(f.session.acceptCommittedRoom?.(saved,'a'),true);assert.equal(track.readyState,'ended');assert.equal(f.session.snapshot().localSilent,true);assert.equal(f.session.snapshot().peers.length,0);assert.equal(f.state.room.revision,1);assert.equal(f.state.scene,draft,'dirty draft is retained');
 saved.scene.areas[0].x=100;f.guard();assert.equal(f.session.snapshot().localSilent,true,'mutating a received DTO cannot mutate copied authority');wait.resolve(f.policy);
});

test('newer saved Silent removal requires fresh policy; older/equal scenes and the retained editor base cannot restore it',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());f.state.room.revision=1;await f.session.setJoined(true);assert.equal(f.session.acceptCommittedRoom?.({id:'r',revision:2,scene:{areas:[{...silentArea,x:0}]}},'a'),true);
 assert.equal(f.session.acceptCommittedRoom?.({id:'r',revision:3,scene:{areas:[]}},'a'),true);assert.equal(f.session.snapshot().localSilent,false);assert.equal(f.session.snapshot().awaitingPolicy,true);assert.equal(f.session.snapshot().peers.length,0);
 for(const revision of [2,3])assert.equal(f.session.acceptCommittedRoom?.({id:'r',revision,scene:{areas:[{...silentArea,x:0}]}},'a'),false);f.guard();assert.equal(f.session.snapshot().localSilent,false);await f.session.refreshPolicy(true);assert.equal(f.session.snapshot().peers.length,1);assert.equal(f.captureCalls,0);
});

test('committed Silent cache rejects other rooms/accounts/malformed revisions and clears on room/account lifecycle',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());f.state.room.revision=1;await f.session.setJoined(true);const saved={id:'r',revision:10,scene:{areas:[{...silentArea,x:0}]}};
 assert.equal(f.session.acceptCommittedRoom?.(saved,'other'),false);assert.equal(f.session.acceptCommittedRoom?.({...saved,id:'other'},'a'),false);for(const revision of [-1,NaN,1.5,'11'])assert.equal(f.session.acceptCommittedRoom?.({...saved,revision},'a'),false);assert.equal(f.session.snapshot().peers.length,1);
 assert.equal(f.session.acceptCommittedRoom?.(saved,'a'),true);f.state.room={id:'other',revision:1,scene:{areas:[]}};f.guard();assert.equal(f.session.snapshot().localSilent,false);assert.equal(f.session.snapshot().joined,false);
 f.state.room={id:'r',revision:1,scene:{areas:[]}};f.state.user={id:'b'};f.guard();assert.equal(f.session.snapshot().localSilent,false);assert.equal(f.session.acceptCommittedRoom?.(saved,'a'),false);assert.equal(f.session.acceptCommittedRoom?.({...saved,revision:2},'b'),true);assert.equal(f.session.snapshot().localSilent,true);
});

test('scene and guarded reconnect hooks capture committed authority before editor draft reconciliation',async()=>{
 const path=process.env.MAIN_SOURCE || new URL('../src/main.js',import.meta.url),source=await readFile(path,'utf8');
 assert.match(source,/const eventActorId=state\.user\?\.id/);assert.match(source,/if\(eventActorId!==state.user\?\.id\)return/);assert.match(source,/handleEvent\(\{type,data,actorId:eventActorId\}\)/);
 const reconnect=source.slice(source.indexOf('function connectEvents'),source.indexOf('async function refreshCatalog'));assert.ok(reconnect.indexOf('accountId!==state.user?.id')<reconnect.indexOf('media?.acceptCommittedRoom(data.room,accountId)'));assert.ok(reconnect.indexOf('media?.acceptCommittedRoom(data.room,accountId)')<reconnect.indexOf('editor.receiveScene(data.room)'));
 const scene=source.match(/if\(type==='scene'&&thisRoom&&state.ready\)\{[^\n]+/)[0];assert.ok(scene.indexOf('media?.acceptCommittedRoom(data.room,event.actorId)')<scene.indexOf('editor.receiveScene(data.room)'));
});

test('actual scene-event handler denies new saved Silent before dirty editor preserves its draft',async t=>{
 const f=fixture();t.after(()=>f.session.destroy());f.state.room.revision=1;const draft=f.state.scene;await f.session.toggleDevice('camera');const track=f.session.snapshot().devices.camera.stream.getTracks()[0],wait=deferred();f.intercept((path,o,normal)=>path==='/api/media'?wait.promise:normal());void f.session.refreshPolicy(true);
 const path=process.env.MAIN_SOURCE || new URL('../src/main.js',import.meta.url),source=await readFile(path,'utf8'),start=source.indexOf('function handleEvent('),end=source.indexOf('\nfunction rememberSurface',start),order=[];
 const ctx={state:f.state,event:{type:'scene',actorId:'a',data:{roomId:'r',room:{id:'r',revision:2,scene:{areas:[{...silentArea,x:0}]}}}},media:{acceptCommittedRoom:(room,actor)=>f.session.acceptCommittedRoom(room,actor),onEvent(){}},editor:{cancelGesture(){},receiveScene(){order.push(track.readyState);}},imageLibrary:null,updateTitle(){},social:{onEvent(){}},quests:null,places:null,express:null};
 vm.runInNewContext(source.slice(start,end)+';handleEvent(event);',ctx);assert.deepEqual(order,['ended']);assert.equal(f.state.room.revision,1);assert.equal(f.state.scene,draft);assert.equal(f.session.snapshot().localSilent,true);assert.equal(f.session.snapshot().peers.length,0);wait.resolve(f.policy);
});
