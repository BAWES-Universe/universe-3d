// Real native WebRTC configuration/SDP probe. No app renderer or device capture.
// Only the FIRST 43–45s ICE renewal timer in each browser is shortened; all
// network requests, the 8s request timeout, expiry, clocks and RTC calls are real.
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,copyFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {createGameServer} from '../server/app.mjs';
import {readIceRelayConfig} from '../server/media-ice.mjs';
import {seedWorlds} from '../src/worlds.js';
import {proximityFixture} from './fixtures/proximity-config.mjs';

const require=createRequire(import.meta.url);
const {chromium}=require('playwright-core');
const embedded=(await import(require.resolve('@sparticuz/chromium'))).default;
const dir=await mkdtemp(join(tmpdir(),'universe-ice-native-'));
const results=[],pageErrors=[];
// Fresh, synthetic, process-local material. Never log/store this or issued credentials.
const syntheticSecret=randomBytes(48).toString('base64url');
const urls=['stun:127.0.0.1:9','turn:127.0.0.1:9?transport=udp'];
const iceRelayConfig=readIceRelayConfig({MEDIA_STUN_URLS:urls[0],MEDIA_TURN_URLS:urls[1],MEDIA_TURN_SHARED_SECRET:syntheticSecret,MEDIA_ICE_TTL_SECONDS:'60',MEDIA_ICE_RENEWAL_SECONDS:'45'});
for(const file of ['media.js','media-ice.js','media-away.js','media-policy-copy.js'])await copyFile(new URL('../src/'+file,import.meta.url),join(dir,file));
await writeFile(join(dir,'index.html'),'<!doctype html><meta charset="utf-8"><title>Native ICE signaling probe</title><script type="module" src="/harness.js"></script>');
await writeFile(join(dir,'harness.js'),String.raw`
import {createMediaSession} from './media.js';
window.issued=[];window.signals=[];window.sse={open:false,policy:0,signal:0};
window.api=async(path,{method='GET',body,signal}={})=>{
 const response=await fetch(path,{method,signal,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 const data=await response.json();
 if(!response.ok)throw Error(path+': '+response.status+' '+(data.code||data.error||'request failed'));
 if(path==='/api/media/ice')issued.push(data);
 if(path==='/api/media/signal')signals.push({direction:'out',type:body.description?.type||body.request||'candidate',connectionId:body.connectionId,scope:{bubbleId:body.bubbleId,fromMemberId:body.fromMemberId,toMemberId:body.toMemberId,intentGeneration:body.intentGeneration,mediaScope:body.mediaScope}});
 return data;
};
window.state={room:null};state.user=(await api('/api/session',{method:'POST',body:{name:new URL(location.href).searchParams.get('name'),woka:0}})).user;
window.enter=async id=>{state.room=(await api('/api/rooms/'+id+'/join',{method:'POST',body:{}})).room;state.position={...state.room.scene.spawn};await window.media?.update();};
await enter('commons');
window.media=createMediaSession({api,getState:()=>state});
window.move=async(x,z)=>{await api('/api/presence',{method:'POST',body:{roomId:state.room.id,x,z,moving:false}});state.position={x,z};await media.update();};
window.events=new EventSource('/api/events');
events.onopen=()=>sse.open=true;
events.addEventListener('media-policy',event=>{sse.policy++;media.acceptPolicy(JSON.parse(event.data));});
events.addEventListener('media-signal',event=>{const data=JSON.parse(event.data);sse.signal++;signals.push({direction:'in',type:data.description?.type||data.request||'candidate',connectionId:data.connectionId});void media.onSignal(data);});
window.current=()=>nativePeers.filter(p=>p.connectionState!=='closed').at(-1);
window.negotiated=()=>{const p=current();return p&&p.localDescription&&p.remoteDescription&&p.signalingState==='stable';};
window.configurationMatches=(pc,latest=false)=>{
 const actual=pc.getConfiguration().iceServers;
 return (latest?[issued.at(-1)]:issued).some(issue=>issue&&issue.iceServers.length===actual.length&&issue.iceServers.every((expected,i)=>JSON.stringify(expected.urls)===JSON.stringify(actual[i].urls)&&['username','credential'].every(key=>(expected[key]||'')===(actual[i][key]||''))));
};
window.probe=()=>({
 issued:issued.length,captureAttempts,scaledRenewals:scaledRenewals.length,
 sse:{...sse},peerCount:nativePeers.length,
 peers:nativePeers.map(pc=>({closed:pc.connectionState==='closed',configurationMatches:configurationMatches(pc),setConfiguration:pc.probe.setConfiguration,initialConfigurationMatched:pc.probe.initialConfigurationMatched,restartOffers:pc.probe.restartOffers,localTypes:pc.probe.local.map(d=>d.type),remoteTypes:pc.probe.remote.map(d=>d.type)})),
 signalCounts:signals.reduce((out,s)=>{const key=s.direction+':'+s.type;out[key]=(out[key]||0)+1;return out;},{}),
 policyError:media.snapshot().policyError,iceError:media.snapshot().iceError,
 credentialFreeSnapshot:issued.every(issue=>issue.iceServers.every(server=>!server.username||(!JSON.stringify(media.snapshot()).includes(server.username)&&!JSON.stringify(media.snapshot()).includes(server.credential))))
});
window.ready=true;
`);
const app=createGameServer({database:':memory:',seeds:seedWorlds,dist:dir,iceRelayConfig,proximityMembershipConfig:proximityFixture});
const {port}=await app.listen(0);
let browser,phase='launch';
const pages=[];
const pass=(test,observations)=>results.push({test,status:'pass',...(observations?{observations}:{})});
const waitNegotiated=()=>Promise.all(pages.map(page=>page.waitForFunction(()=>negotiated(),null,{timeout:12000})));
const allClosed=()=>Promise.all(pages.map(page=>page.waitForFunction(()=>media.snapshot().peers.length===0&&nativePeers.every(pc=>pc.connectionState==='closed'),null,{timeout:10000})));
try {
 browser=await chromium.launch({executablePath:await embedded.executablePath(),headless:true,args:['--no-sandbox','--no-zygote']});
 for(const name of ['Native A','Native B']){
  const context=await browser.newContext();const page=await context.newPage();pages.push(page);
  page.on('pageerror',error=>pageErrors.push(error.name));
  await page.addInitScript(()=>{
   window.captureAttempts=0;
   for(const name of ['getUserMedia','getDisplayMedia'])if(navigator.mediaDevices)Object.defineProperty(navigator.mediaDevices,name,{value:()=>{captureAttempts++;throw Error('Device capture prohibited in native ICE probe');},configurable:true});
   const nativeTimeout=window.setTimeout.bind(window);window.scaledRenewals=[];window.renewalDelay=2000;
   window.setTimeout=(callback,delay,...args)=>{
    if(delay>=43000&&delay<=45000&&scaledRenewals.length===0){scaledRenewals.push({requested:delay,actual:renewalDelay});return nativeTimeout(callback,renewalDelay,...args);}
    return nativeTimeout(callback,delay,...args);
   };
   const Native=RTCPeerConnection;window.nativePeers=[];
   const ufrags=description=>[...new Set([...description.sdp.matchAll(/^a=ice-ufrag:([^\r\n]+)/gm)].map(match=>match[1]))];
   window.RTCPeerConnection=new Proxy(Native,{construct(Target,args){
    const pc=new Target(...args);nativePeers.push(pc);pc.probe={local:[],remote:[],setConfiguration:0,restartOffers:0,initialConfigurationMatched:configurationMatches(pc,true)};
    const createOffer=pc.createOffer.bind(pc),setLocal=pc.setLocalDescription.bind(pc),setRemote=pc.setRemoteDescription.bind(pc),setConfig=pc.setConfiguration.bind(pc);
    pc.createOffer=async options=>{if(options?.iceRestart)pc.probe.restartOffers++;return createOffer(options);};
    pc.setConfiguration=config=>{setConfig(config);pc.probe.setConfiguration++;if(!configurationMatches(pc,true))throw Error('Native configuration differs from latest authorized issue');};
    pc.setLocalDescription=async description=>{await setLocal(description);pc.probe.local.push({type:pc.localDescription.type,ufrags:ufrags(pc.localDescription)});};
    pc.setRemoteDescription=async description=>{await setRemote(description);pc.probe.remote.push({type:pc.remoteDescription.type,ufrags:ufrags(pc.remoteDescription)});};
    return pc;
   }});
  });
  await page.goto('http://127.0.0.1:'+port+'/?name='+encodeURIComponent(name));
  await page.waitForFunction(()=>window.ready&&sse.open);
 }
 phase='separate cookie sessions';
 const ids=await Promise.all(pages.map(page=>page.evaluate(()=>state.user.id)));
 assert.equal(ids[0]!==ids[1],true,'Guests need distinct server identities');
 const cookieSets=await Promise.all(pages.map(page=>page.context().cookies()));
 assert.equal(cookieSets.every(set=>set.some(cookie=>cookie.httpOnly)),true,'Sessions must use HttpOnly cookies');
 assert.equal(cookieSets[0].some(a=>cookieSets[1].some(b=>a.name===b.name&&a.value!==b.value)),true,'Contexts must have isolated session cookies');
 const offerer=pages[ids[0]<ids[1]?0:1],answerer=pages[ids[0]<ids[1]?1:0];
 await offerer.evaluate(()=>renewalDelay=2000);await answerer.evaluate(()=>renewalDelay=5000);
 await Promise.all(pages.map(page=>page.evaluate(()=>media.setJoined(true))));
 await waitNegotiated();
 phase='initial authorized configuration';
 const initial=await Promise.all(pages.map(page=>page.evaluate(()=>({nativeConfigurationMatches:configurationMatches(current()),consumedTwoServers:current().getConfiguration().iceServers.length===2,hasRelayCredential:current().getConfiguration().iceServers.some(server=>server.urls.some(url=>url.startsWith('turn:'))&&typeof server.username==='string'&&server.username.length>0&&typeof server.credential==='string'&&server.credential.length>0),directions:current().getTransceivers().map(t=>t.direction),local:current().localDescription.type,remote:current().remoteDescription.type,sseSignalCount:sse.signal,policyHasScope:!!media.snapshot().policy?.iceScope}))));
 for(const row of initial){assert.equal(row.nativeConfigurationMatches,true);assert.equal(row.consumedTwoServers,true);assert.equal(row.hasRelayCredential,true);assert.equal(row.policyHasScope,true);assert.deepEqual(row.directions,['sendrecv','sendrecv','sendrecv']);assert.equal(row.sseSignalCount>0,true);}
 assert.deepEqual(initial.map(row=>row.local).sort(),['answer','offer']);
 const scopedSignals=await Promise.all(pages.map(page=>page.evaluate(()=>({protocol:media.snapshot().policy.proximityMembership?.protocol,allScoped:signals.filter(s=>s.direction==='out').every(s=>s.scope&&s.scope.bubbleId&&s.scope.fromMemberId&&s.scope.toMemberId&&Number.isSafeInteger(s.scope.intentGeneration)&&s.scope.mediaScope)}))));
 for(const row of scopedSignals){assert.equal(row.protocol,'proximity-v1');assert.equal(row.allScoped,true);}
 pass('Opt-in proximity-v1 envelopes attach bubble, sender/target member, intent and AV scope to native outgoing signals',scopedSignals);
 pass('Two isolated HttpOnly cookie sessions consume authorized ICE configuration and negotiate native SDP over real server SSE',initial);
 for(const page of pages)await page.evaluate(()=>window.firstPeer=current());
 phase='offerer renewal';
 await offerer.waitForFunction(()=>firstPeer.probe.setConfiguration>=1&&firstPeer.probe.restartOffers>=1&&firstPeer.probe.local.length>=2&&firstPeer.probe.remote.length>=2&&firstPeer.signalingState==='stable',null,{timeout:12000});
 const offererRestart=await offerer.evaluate(()=>({sameNativePeer:current()===firstPeer,configurationMatches:configurationMatches(firstPeer,true),setConfiguration:firstPeer.probe.setConfiguration,iceRestartOffers:firstPeer.probe.restartOffers,localUfragChanged:JSON.stringify(firstPeer.probe.local[0].ufrags)!==JSON.stringify(firstPeer.probe.local[1].ufrags),remoteUfragChanged:JSON.stringify(firstPeer.probe.remote[0].ufrags)!==JSON.stringify(firstPeer.probe.remote[1].ufrags),allDescriptionsHaveUfrag:[...firstPeer.probe.local,...firstPeer.probe.remote].every(d=>d.ufrags.length>0),renewedCredentialChanged:issued[0].iceServers[1].credential!==issued[1].iceServers[1].credential}));
 for(const name of ['sameNativePeer','configurationMatches','localUfragChanged','remoteUfragChanged','allDescriptionsHaveUfrag','renewedCredentialChanged'])assert.equal(offererRestart[name],true,name);
 pass('Offerer renewal calls native setConfiguration and createOffer({iceRestart:true}); actual local and remote SDP ICE ufrags change',offererRestart);
 phase='answerer renewal';
 await answerer.waitForFunction(()=>firstPeer.probe.setConfiguration>=1&&signals.some(s=>s.direction==='out'&&s.type==='restart')&&firstPeer.probe.local.length>=3&&firstPeer.probe.remote.length>=3&&firstPeer.signalingState==='stable',null,{timeout:12000});
 await offerer.waitForFunction(()=>firstPeer.probe.restartOffers>=2&&firstPeer.probe.remote.length>=3&&firstPeer.signalingState==='stable',null,{timeout:12000});
 const answererRestart=await answerer.evaluate(()=>({sameNativePeer:current()===firstPeer,configurationMatches:configurationMatches(firstPeer,true),setConfiguration:firstPeer.probe.setConfiguration,iceRestartOffers:firstPeer.probe.restartOffers,onlyAnswers:firstPeer.probe.local.every(d=>d.type==='answer'),sentRestart:signals.some(s=>s.direction==='out'&&s.type==='restart'),localUfragChanged:JSON.stringify(firstPeer.probe.local[1].ufrags)!==JSON.stringify(firstPeer.probe.local[2].ufrags),remoteUfragChanged:JSON.stringify(firstPeer.probe.remote[1].ufrags)!==JSON.stringify(firstPeer.probe.remote[2].ufrags)}));
 for(const name of ['sameNativePeer','configurationMatches','onlyAnswers','sentRestart','localUfragChanged','remoteUfragChanged'])assert.equal(answererRestart[name],true,name);
 assert.equal(answererRestart.iceRestartOffers,0);
 pass('Answerer renewal requests restart through authorized SSE; only elected offerer creates restart offers and answerer returns native answers',answererRestart);
 phase='room teardown';
 for(const page of pages)await page.evaluate(()=>window.oldScope=media.snapshot().policy.iceScope);
 await pages[1].evaluate(()=>enter('studio'));await allClosed();
 const roomOldScopeStatus=await pages[1].evaluate(async()=>{const response=await fetch('/api/media/ice',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:oldScope,requestId:crypto.randomUUID()})});return response.status;});
 assert.equal(roomOldScopeStatus,403);
 pass('Room change closes both actual old-room peer connections and server rejects the old ICE scope',{oldScopeStatus:roomOldScopeStatus});
 await pages[0].evaluate(()=>enter('studio'));
 await Promise.all(pages.map(page=>page.evaluate(()=>media.setJoined(true))));await waitNegotiated();
 for(const page of pages)await page.evaluate(()=>{window.beforeScopePeer=current();window.beforeScope=media.snapshot().policy.iceScope;});
 phase='same-room scope teardown';
 await pages[0].evaluate(()=>move(0,-1));await allClosed();
 const areaOldScope=await pages[0].evaluate(async()=>{const response=await fetch('/api/media/ice',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:beforeScope,requestId:crypto.randomUUID()})});return {status:response.status,changed:media.snapshot().policy.iceScope!==beforeScope,context:media.snapshot().policy.context.kind};});
 assert.equal(areaOldScope.status,403);assert.equal(areaOldScope.changed,true);assert.equal(areaOldScope.context,'meeting');
 await pages[1].evaluate(()=>move(0,-1));await waitNegotiated();
 const newScopePeers=await Promise.all(pages.map(page=>page.evaluate(()=>({oldClosed:beforeScopePeer.connectionState==='closed',newNativePeer:current()!==beforeScopePeer,configurationMatches:configurationMatches(current()),scopeChanged:media.snapshot().policy.iceScope!==beforeScope}))));
 for(const row of newScopePeers)for(const value of Object.values(row))assert.equal(value,true);
 pass('Same-room proximity-to-meeting scope change closes old native transports, rejects retired scope, and authorizes replacement peers',{oldScopeStatus:areaOldScope.status,peers:newScopePeers});
 phase='Silent teardown';
 for(const page of pages)await page.evaluate(()=>enter('commons'));
 await Promise.all(pages.map(page=>page.evaluate(()=>media.setJoined(true))));await waitNegotiated();
 for(const page of pages)await page.evaluate(()=>window.preSilentScope=media.snapshot().policy.iceScope);
 await pages[0].evaluate(()=>move(6,-3));await allClosed();
 const silent=await pages[0].evaluate(async()=>{const response=await fetch('/api/media/ice',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:preSilentScope,requestId:crypto.randomUUID()})});return {oldScopeStatus:response.status,context:media.snapshot().policy.context.kind,scopeRemoved:!media.snapshot().policy.iceScope,localSilent:media.snapshot().localSilent};});
 assert.equal(silent.oldScopeStatus,403);assert.equal(silent.context,'silent');assert.equal(silent.scopeRemoved,true);assert.equal(silent.localSilent,true);
 pass('Authoritative Silent entry retires authorization, removes ICE scope, and closes both actual peer connections',silent);
 phase='dock pending-join cancellation';
 await pages[0].evaluate(async()=>{
  const {mountMedia}=await import('./media.js');const root=document.createElement('div');root.id='cancel-join-probe';document.body.append(root);
  const state={user:{id:'dock-user'},room:{id:'dock-room',scene:{areas:[]}},ready:true};
  const policy={selfId:'dock-user',roomId:'dock-room',enabled:false,context:{kind:'proximity',canPublish:true},peers:[],iceRequired:true,proximityMembership:{protocol:'proximity-v1',memberId:'dock-member',bubbleId:null,membershipRevision:null,mediaScope:null,conversationRecipients:[],transport:null}};
  window.dockCalls=[];window.dockConsent=false;let resolve;const gate=new Promise(r=>resolve=r);window.releaseDockJoin=resolve;
  const api=async(path,o={})=>{if(path==='/api/media/state'){dockCalls.push(o.body.enabled);dockConsent=o.body.enabled;policy.enabled=o.body.enabled;if(o.body.enabled)await gate;}return structuredClone(policy);};
  window.dockProbe=mountMedia({root,api,getState:()=>state});
 });
 await pages[0].waitForFunction(()=>dockProbe.getStatus().policy);
 await pages[0].locator('#cancel-join-probe .media-join').click();
 await pages[0].waitForFunction(()=>dockCalls.length===1&&dockProbe.getStatus().joining);
 const cancelControl=await pages[0].locator('#cancel-join-probe .media-join').evaluate(button=>({label:button.textContent,enabled:!button.disabled}));
 assert.equal(cancelControl.label,'Cancel joining');assert.equal(cancelControl.enabled,true);
 await pages[0].locator('#cancel-join-probe .media-join').click();
 const pendingCancelled=await pages[0].evaluate(()=>!dockProbe.getStatus().joined&&!dockProbe.getStatus().joining&&dockCalls.length===1);
 assert.equal(pendingCancelled,true);
 await pages[0].evaluate(()=>releaseDockJoin());
 await pages[0].waitForFunction(()=>dockCalls.length===2&&!dockConsent);
 const dockResult=await pages[0].evaluate(()=>({calls:[...dockCalls],joined:dockProbe.getStatus().joined,captureAttempts}));
 assert.deepEqual(dockResult.calls,[true,false]);assert.equal(dockResult.joined,false);assert.equal(dockResult.captureAttempts,0);
 await pages[0].evaluate(()=>{dockProbe.destroy();document.querySelector('#cancel-join-probe').remove();});
 pass('Real dock Cancel joining remains clickable and stops pending join; synthetic consent writes finish enable then disable without capture',{...cancelControl,...dockResult});
 phase='final safety and leak checks';
 const summaries=await Promise.all(pages.map(page=>page.evaluate(()=>probe())));
 for(const summary of summaries){assert.equal(summary.captureAttempts,0);assert.equal(summary.scaledRenewals,1);assert.equal(summary.credentialFreeSnapshot,true);assert.equal(summary.policyError,'');assert.equal(summary.iceError,'');assert.equal(summary.peers.every(peer=>peer.closed&&peer.configurationMatches&&peer.initialConfigurationMatched),true);}
 assert.deepEqual(pageErrors,[]);
 pass('Capture prohibited and never attempted; credential-free session snapshots; all created native connections closed',{captureAttempts:summaries.map(summary=>summary.captureAttempts),closedNativePeers:summaries.map(summary=>summary.peerCount),pageErrors:pageErrors.length});
 const report={type:'native-browser-proximity-v1-authorized-ice-and-restart',status:'pass',timestamp:new Date().toISOString(),browser:await browser.version(),launchArgs:['--no-sandbox','--no-zygote'],renderer:'Standalone media modules only; no 3D/app renderer',configuredUrls:urls,config:{ttlSeconds:60,renewalSeconds:45,secret:'Fresh synthetic random value generated per run; omitted'},timerAdaptation:'Only first 43000–45000 ms ICE renewal timer per context shortened to 2000 ms (offerer) or 5000 ms (answerer). Request timeouts, expiry timers, clocks and native RTC methods unchanged.',results,summaries,limits:['Device capture prohibited; zero getUserMedia/getDisplayMedia attempts.','Only loopback discard-port STUN/TURN URLs. No real relay service, real credentials, deployment or external provider.','Opt-in proximity-v1 native authorized configuration, actual SDP ICE-ufrag changes, cookie/SSE signaling and teardown are verified.','No TURN allocation, working connection, media packets, physical-device capture or multi-network traversal is claimed.']};
 const serialized=JSON.stringify(report,null,2);
 assert.equal(serialized.includes(syntheticSecret),false,'Synthetic secret must not appear in evidence');
 await mkdir(new URL('../evidence/',import.meta.url),{recursive:true});
 await writeFile(new URL('../evidence/proximity-client-native-browser.json',import.meta.url),serialized+'\n');
 console.log(serialized);
} catch(error) {
 // Avoid credential-bearing dumps from browser objects or response bodies.
 console.error(JSON.stringify({status:'fail',phase,error:error.name,message:String(error.message).replaceAll(syntheticSecret,'[redacted]'),completedResults:results},null,2));
 throw Error('Native ICE browser verification failed at: '+phase);
} finally {
 for(const page of pages)if(!page.isClosed())await page.evaluate(()=>{window.media?.destroy();window.events?.close();}).catch(()=>{});
 await browser?.close();await app.close();await rm(dir,{recursive:true,force:true});
}
