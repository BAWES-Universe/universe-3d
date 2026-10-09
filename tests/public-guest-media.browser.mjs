/** Real browser WebRTC + actual public guest HTTP/SSE. Capture devices are synthetic. */
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import embedded from '@sparticuz/chromium';
import {Store} from '../server/store.mjs';
import {bootstrapOwner} from '../server/operator-accounts.mjs';
import {createGameServer} from '../server/app.mjs';
import {readRuntimeConfig} from '../server/runtime-config.mjs';
import {DEFAULT_PROXIMITY_CONFIG} from '../server/proximity-runtime-config.mjs';
const dir=await mkdtemp(join(tmpdir(),'guest-native-media-')),database=join(dir,'synthetic.sqlite');
const scene={version:1,theme:'garden',bounds:{width:24,depth:24},spawn:{x:0,z:0},objects:[],areas:[]},seeds=[{id:'world',name:'World',rooms:[{id:'commons',name:'Commons',scene}]}];
const store=new Store(database,seeds);await bootstrapOwner(store,{name:'Owner',username:'synthetic_owner',password:'synthetic media password'});store.close();
const free=http.createServer();await new Promise(r=>free.listen(0,'127.0.0.1',r));const port=free.address().port;await new Promise(r=>free.close(r));const base=`http://127.0.0.1:${port}`;
const config=readRuntimeConfig({UNIVERSE_MODE:'public',UNIVERSE_BIND_ADDRESS:'127.0.0.1',PORT:String(port),UNIVERSE_DB:database,UNIVERSE_ALLOWED_HOSTS:`127.0.0.1:${port}`,UNIVERSE_ALLOWED_ORIGINS:`https://127.0.0.1:${port}`,UNIVERSE_TLS_MODE:'external',UNIVERSE_COOKIE_SECURE:'always',UNIVERSE_REGISTRATION_MODE:'open'});
await build({stdin:{contents:`import {mountMedia} from './src/media.js';import './src/media.css';
const api=async(path,o={})=>{const response=await fetch(path,{method:o.method||'GET',headers:{'Content-Type':'application/json'},...(o.body?{body:JSON.stringify(o.body)}:{})});const value=await response.json();if(!response.ok)throw Object.assign(Error(value.message),{status:response.status,data:value});return value;};
const actor=await api('/api/session',{method:'POST',body:{name:'Synthetic guest'}});const joined=await api('/api/rooms/commons/join',{method:'POST',body:{}});window.state={user:actor.user,room:joined.room,position:{x:joined.arrival.x,z:joined.arrival.z},admissionId:joined.arrival.admissionId,ready:true};window.media=mountMedia({root:document.querySelector('main'),api,getState:()=>state,toast:console.log});
const stream=new EventSource('/api/events');for(const type of ['media-policy','media-signal','presence'])stream.addEventListener(type,event=>media.onEvent({type,data:JSON.parse(event.data)}));window.ready=true;`,resolveDir:resolve('.'),sourcefile:'native-media-fixture.js',loader:'js'},bundle:true,format:'esm',outfile:join(dir,'fixture.js')});
await writeFile(join(dir,'index.html'),'<!doctype html><link rel="stylesheet" href="/fixture.css"><style>main{position:fixed;bottom:16px;left:16px;right:16px}</style><main></main><script type="module" src="/fixture.js"></script>');
const app=createGameServer({database,seeds,dist:dir,runtimeConfig:{...config,allowedOrigins:[base]},...DEFAULT_PROXIMITY_CONFIG});await app.listen(port);
const browser=await chromium.launch({executablePath:await embedded.executablePath(),headless:true,args:['--no-sandbox','--no-zygote','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
const contexts=[],pages=[],result={
 syntheticCapture:true,nativePeerConnection:true,nativeTransportConnected:false,remoteAudioVideoVerified:false,
 observationLimitMs:20000,peers:[],lifecycle:[],errors:[],
 limits:['Chromium synthetic microphone/camera capture; real public guest HTTP/SSE and native WebRTC.',
  'Host-only ICE. No STUN/TURN, external provider, physical microphone/speaker, phone, or network handover is verified.']
};
// Observe native objects without changing capture, signaling, transport, or stats.
// Live references remain separate from the serializable diagnostic report.
function instrumentNativeMedia(){
 window.rtcConnections=[];window.rtcDiagnostics=[];window.capturedTracks=[];
 const Native=RTCPeerConnection;
 window.RTCPeerConnection=class extends Native{
  constructor(config){
   super(config);const row={index:rtcConnections.length,config:this.getConfiguration(),candidates:[],candidateErrors:[],states:[]};
   rtcConnections.push(this);rtcDiagnostics.push(row);
   const states=()=>row.states.push({atMs:performance.now(),connection:this.connectionState,iceConnection:this.iceConnectionState,iceGathering:this.iceGatheringState,signaling:this.signalingState});
   states();for(const event of ['connectionstatechange','iceconnectionstatechange','icegatheringstatechange','signalingstatechange'])this.addEventListener(event,states);
   this.addEventListener('icecandidate',event=>{if(event.candidate)row.candidates.push({type:event.candidate.type,protocol:event.candidate.protocol});});
   this.addEventListener('icecandidateerror',event=>row.candidateErrors.push({code:event.errorCode,text:event.errorText}));
  }
 };
 const getUserMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
 navigator.mediaDevices.getUserMedia=async constraints=>{
  const stream=await getUserMedia(constraints);capturedTracks.push(...stream.getTracks());return stream;
 };
 window.readMediaEvidence=async()=>{
  const trackInfo=track=>({id:track.id,kind:track.kind,label:track.label,readyState:track.readyState,enabled:track.enabled,muted:track.muted});
  const status=media.getStatus();
  const remoteTrackIds=new Set(status.peers.flatMap(peer=>Object.values(peer.streams).flatMap(stream=>stream.getTracks().map(track=>track.id))));
  const remoteElements=[...document.querySelectorAll('.media-peers audio,.media-peers video')]
   .filter(element=>element.srcObject?.getTracks().some(track=>remoteTrackIds.has(track.id)))
   .map(element=>({tag:element.tagName.toLowerCase(),muted:element.muted,paused:element.paused,ended:element.ended,
    readyState:element.readyState,currentTime:element.currentTime,videoWidth:element.videoWidth??null,videoHeight:element.videoHeight??null,
    visible:element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),
    inViewport:(()=>{const box=element.getBoundingClientRect();return box.width>0&&box.height>0&&box.bottom>0&&box.top<innerHeight&&box.right>0&&box.left<innerWidth;})(),tracks:element.srcObject.getTracks().map(trackInfo),
    playbackError:element.error?.message??null,playButtonVisible:!element.closest('.media-tile').querySelector('.media-play').hidden}));
  const connections=await Promise.all(rtcConnections.map(async(pc,index)=>{
   const row={index,connectionState:pc.connectionState,iceConnectionState:pc.iceConnectionState,
    iceGatheringState:pc.iceGatheringState,signalingState:pc.signalingState,
    transceivers:pc.getTransceivers().map(transceiver=>({mid:transceiver.mid,direction:transceiver.direction,currentDirection:transceiver.currentDirection,
     sender:transceiver.sender.track?trackInfo(transceiver.sender.track):null,receiver:transceiver.receiver.track?trackInfo(transceiver.receiver.track):null})),
    inbound:{audio:[],video:[]},outbound:{audio:[],video:[]},candidatePairs:[],statsError:null};
   if(pc.connectionState==='closed')return row;
   try{
    const stats=await pc.getStats();
    stats.forEach(report=>{
     const kind=report.kind||report.mediaType;
     if(['audio','video'].includes(kind)&&['inbound-rtp','outbound-rtp'].includes(report.type)&&!report.isRemote){
      const fields=['id','timestamp','ssrc','mid','trackIdentifier','codecId','packetsReceived','bytesReceived','packetsLost','framesReceived','framesDecoded','frameWidth','frameHeight','totalSamplesReceived','concealedSamples','packetsSent','bytesSent','framesEncoded'];
      row[report.type==='inbound-rtp'?'inbound':'outbound'][kind].push(Object.fromEntries(fields.filter(field=>report[field]!==undefined).map(field=>[field,report[field]])));
     }
     if(report.type==='candidate-pair')row.candidatePairs.push({state:report.state,nominated:report.nominated,bytesReceived:report.bytesReceived,bytesSent:report.bytesSent});
    });
   }catch(error){row.statsError=error.message;}
   return row;
  }));
  const live=track=>track.readyState==='live'&&track.enabled&&!track.muted;
  const transportConnected=connections.some(pc=>pc.connectionState==='connected')&&status.peers.some(peer=>peer.status==='connected');
  const audioPacketsReceived=connections.some(pc=>pc.connectionState==='connected'&&pc.inbound.audio.some(rtp=>rtp.packetsReceived>0&&rtp.bytesReceived>0));
  const videoFramesDecoded=connections.some(pc=>pc.connectionState==='connected'&&pc.inbound.video.some(rtp=>rtp.bytesReceived>0&&rtp.framesDecoded>0));
  const remoteAudioPlaying=remoteElements.some(element=>element.tag==='audio'&&!element.paused&&!element.muted&&element.readyState>=2&&element.tracks.some(track=>track.kind==='audio'&&live(track)));
  const remoteVideoDecoded=remoteElements.some(element=>element.tag==='video'&&element.visible&&element.inViewport&&!element.paused&&element.readyState>=2&&element.videoWidth>0&&element.videoHeight>0&&element.tracks.some(track=>track.kind==='video'&&live(track)));
  return {actorId:state.user.id,visibility:{state:document.visibilityState,hidden:document.hidden,focused:document.hasFocus()},
   joined:status.joined,joining:status.joining,iceTransport:status.iceTransport,iceServerCount:status.policy?.iceServers?.length??null,
   devices:Object.fromEntries(Object.entries(status.devices).map(([kind,device])=>[kind,{status:device.status,error:device.error,tracks:device.stream?.getTracks().map(trackInfo)||[]} ])),
   captureTracks:capturedTracks.map(trackInfo),rtcDiagnostics,connections,remoteElements,
   attachedMediaElementCount:[...document.querySelectorAll('audio,video')].filter(element=>element.srcObject).length,
   peers:status.peers.map(peer=>({id:peer.id,status:peer.status,candidateCount:peer.candidateCount,receivedBytes:peer.receivedBytes,sentBytes:peer.sentBytes,error:peer.error,
    remoteTracks:Object.fromEntries(Object.entries(peer.streams).map(([kind,stream])=>[kind,stream.getTracks().map(trackInfo)]))})),
   verification:{transportConnected,audioPacketsReceived,videoFramesDecoded,remoteAudioPlaying,remoteVideoDecoded,
    remoteAudioVideoVerified:transportConnected&&audioPacketsReceived&&videoFramesDecoded&&remoteAudioPlaying&&remoteVideoDecoded}};
 };
}
const readPeers=()=>Promise.all(pages.map(page=>page.evaluate(()=>readMediaEvidence())));
async function observeMedia(){
 const started=Date.now(),deadline=started+result.observationLimitMs;
 let snapshots,samples=0;
 // App counters refresh only every >3 seconds. Native connected state and
 // ontrack/live tracks alone do not establish received audio or decoded video.
 do{
  snapshots=await readPeers();samples++;
  if(snapshots.length===2&&snapshots.every(peer=>peer.verification.remoteAudioVideoVerified))break;
  const remaining=deadline-Date.now();if(remaining<=0)break;
  await new Promise(resolve=>setTimeout(resolve,Math.min(250,remaining)));
 }while(Date.now()<=deadline);
 return {elapsedMs:Date.now()-started,samples,peers:snapshots};
}
async function joinAndCapture(){
 for(const page of pages){
  await page.getByRole('button',{name:'Join audio',exact:true}).click();
  await page.waitForFunction(()=>media.getStatus().joined&&!media.getStatus().joining);
  for(const kind of ['microphone','camera']){
   await page.locator(`[data-media=${kind}]`).click();
   await page.waitForFunction(kind=>media.getStatus().devices[kind].status==='on',kind);
  }
 }
}
async function leaveAndVerify(label){
 for(const page of pages)await page.getByRole('button',{name:'Leave audio',exact:true}).click();
 for(const page of pages)await page.waitForFunction(()=>{
  const status=media.getStatus();
  return !status.joined&&!status.joining&&status.peers.length===0&&Object.values(status.devices).every(device=>device.status==='off'&&!device.stream)
   &&capturedTracks.length>=2&&capturedTracks.every(track=>track.readyState==='ended')&&rtcConnections.every(pc=>pc.connectionState==='closed');
 });
 const peers=await readPeers();result.lifecycle.push({phase:label,peers});
 for(const peer of peers){
  assert.equal(peer.joined,false,`${label}: guest must be opted out`);
  assert.equal(peer.captureTracks.every(track=>track.readyState==='ended'),true,`${label}: previously captured native tracks must end`);
  assert.equal(peer.connections.every(pc=>pc.connectionState==='closed'),true,`${label}: every native peer must close`);
  assert.equal(peer.attachedMediaElementCount,0,`${label}: all media elements must release streams`);
 }
}
await mkdir('evidence/guest-conversations',{recursive:true});
try{
 for(let i=0;i<2;i++){
  const context=await browser.newContext({viewport:{width:1000,height:700}});contexts.push(context);
  await context.addInitScript(instrumentNativeMedia);
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>result.errors.push(error.message));
  await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.ready);
  assert.equal(await page.evaluate(()=>state.user.ephemeralGuest),true);pages.push(page);
 }
 assert.notEqual(await pages[0].evaluate(()=>state.user.id),await pages[1].evaluate(()=>state.user.id),'Guests need separate real server identities');
 await joinAndCapture();
 const observed=await observeMedia();
 result.peers=observed.peers;result.observation={elapsedMs:observed.elapsedMs,samples:observed.samples};
 result.nativeTransportConnected=result.peers.length===2&&result.peers.every(peer=>peer.verification.transportConnected);
 result.remoteAudioVideoVerified=result.peers.length===2&&result.peers.every(peer=>peer.verification.remoteAudioVideoVerified);
 result.mediaOutcome=result.remoteAudioVideoVerified?'bidirectional-synthetic-media-verified':result.nativeTransportConnected?'transport-connected-media-unverified':'transport-and-media-unverified';
 await leaveAndVerify('first leave');
 // Rejoining is a new explicit gesture, but must not restart any old capture.
 for(const page of pages){
  await page.getByRole('button',{name:'Join audio',exact:true}).click();
  await page.waitForFunction(()=>media.getStatus().joined&&!media.getStatus().joining);
 }
 // Cover a normal media update tick after rejoining without toggling devices.
 await new Promise(resolve=>setTimeout(resolve,1300));
 const rejoined=await readPeers();result.lifecycle.push({phase:'rejoin without capture',peers:rejoined});
 for(let index=0;index<rejoined.length;index++){
  const peer=rejoined[index];
  assert.equal(peer.captureTracks.length,result.peers[index].captureTracks.length,'Rejoin must not request capture automatically');
  assert.equal(peer.captureTracks.every(track=>track.readyState==='ended'),true,'Rejoin must not revive old capture');
  assert.equal(Object.values(peer.devices).every(device=>device.status==='off'&&device.tracks.length===0),true,'Rejoin must keep devices off');
 }
 for(const page of pages)for(const kind of ['microphone','camera']){
  await page.locator(`[data-media=${kind}]`).click();
  await page.waitForFunction(kind=>media.getStatus().devices[kind].status==='on',kind);
 }
 const recaptured=await readPeers();result.lifecycle.push({phase:'explicit recapture',peers:recaptured});
 for(let index=0;index<recaptured.length;index++){
  const peer=recaptured[index],oldIds=new Set(result.peers[index].captureTracks.map(track=>track.id));
  assert.equal(peer.captureTracks.filter(track=>!oldIds.has(track.id)&&track.readyState==='live').length,2,'Explicit rejoin capture must own two fresh native tracks');
  assert.equal(peer.captureTracks.filter(track=>oldIds.has(track.id)).every(track=>track.readyState==='ended'),true,'Old tracks must remain ended after recapture');
 }
 await leaveAndVerify('final leave');
 result.captureLifecycleVerified=true;assert.deepEqual(result.errors,[]);
 console.log(JSON.stringify(result,null,2));
}catch(error){result.failure={name:error.name,message:error.message};throw error;}
finally{
 await writeFile('evidence/guest-conversations/native-media-result.json',JSON.stringify(result,null,2));
 for(const context of contexts)await context.close();await browser.close();await app.close();await rm(dir,{recursive:true,force:true});
}
