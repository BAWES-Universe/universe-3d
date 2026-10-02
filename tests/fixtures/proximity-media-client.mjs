// Synthetic browser-shaped peers/tracks only. No physical device or packet proof.
export const tick = () => new Promise(resolve => setImmediate(resolve));
export function deferred() { let resolve,reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; }
export class Track { constructor(kind='audio'){this.kind=kind;this.readyState='live';} stop(){this.readyState='ended';} }
export class Stream { constructor(tracks=[]){this.tracks=tracks;} getTracks(){return this.tracks;} }
export function mediaEnvironment() {
 const instances=[],captures=[],timers=new Map();let id=0,time=100000,intercept;
 class Peer {
  constructor(config){this.config=config;this.transceivers=[];this.connectionState='new';this.iceGatheringState='new';this.signalingState='stable';this.calls=[];instances.push(this);}
  async step(name,data,action){this.calls.push({name,data});if(intercept)await intercept(this,name,data);return action?.();}
  addTransceiver(kind,{direction}){const pc=this,t={kind,direction,sender:{track:null,async replaceTrack(track){await pc.step('replaceTrack',track);this.track=track;}}};this.transceivers.push(t);return t;}
  getTransceivers(){return this.transceivers;}
  createOffer(options){return this.step('createOffer',options,()=>({type:'offer',sdp:'synthetic-offer'}));}
  createAnswer(){return this.step('createAnswer',null,()=>({type:'answer',sdp:'synthetic-answer'}));}
  setLocalDescription(d){return this.step('setLocalDescription',d,()=>{this.localDescription=d;});}
  setRemoteDescription(d){return this.step('setRemoteDescription',d,()=>{this.remoteDescription=d;if(!this.transceivers.length)for(const kind of ['audio','video','video'])this.addTransceiver(kind,{direction:'sendrecv'});});}
  addIceCandidate(c){return this.step('addIceCandidate',c);}
  setConfiguration(config){this.calls.push({name:'setConfiguration'});this.config=config;}
  close(){this.closed=true;this.connectionState='closed';}
 }
 const f={instances,captures,timers,now:()=>time,set intercept(fn){intercept=fn;},async advance(ms){time+=ms;for(const[key,t]of [...timers])if(t.at<=time){timers.delete(key);t.fn();}await tick();}};
 const capture=async options=>{const stream=new Stream([new Track(options.video?'video':'audio')]);captures.push(stream);return stream;};
 f.env={AbortController,RTCPeerConnection:Peer,MediaStream:Stream,isSecureContext:true,performance:{now:()=>time},crypto:{randomUUID:()=>`synthetic-${String(++id).padStart(20,'0')}`},setTimeout(fn,ms){const key=++id;timers.set(key,{fn,at:time+ms});return key;},clearTimeout(key){timers.delete(key);},navigator:{mediaDevices:{getUserMedia:capture,getDisplayMedia:capture}}};return f;
}
export const policyFixture = (self='a', other='z') => ({selfId:self,roomId:'r',enabled:false,iceScope:'ice-1',iceRequired:true,context:{kind:'proximity',group:'proximity',canPublish:true},peers:[{id:other,memberId:`member-${other}`,canSend:true,canReceive:true}],proximityMembership:{protocol:'proximity-v1',memberId:`member-${self}`,bubbleId:'bubble-1',membershipRevision:1,mediaScope:'media-1',conversationRecipients:[{accountId:other,memberId:`member-${other}`}],transport:{selectionIntent:'p2p',requiredTransport:'p2p',intentGeneration:0,p2pAllowed:true,memberCount:2,blockedReason:null,connectedTransport:null,handoffComplete:false}}});
export const incomingSignal = (policy, data={request:'offer'}) => ({roomId:policy.roomId,from:policy.peers[0].id,connectionId:'remote-connection',bubbleId:policy.proximityMembership.bubbleId,fromMemberId:policy.peers[0].memberId,toMemberId:policy.proximityMembership.memberId,intentGeneration:policy.proximityMembership.transport.intentGeneration,mediaScope:policy.proximityMembership.mediaScope,...data});
export const iceResponse = (policy,requestId,now) => ({scope:policy.iceScope,requestId,roomId:policy.roomId,selfId:policy.selfId,issuedAt:now,expiresAt:now+60000,renewAt:now+45000,transport:'host-only',iceServers:[]});
