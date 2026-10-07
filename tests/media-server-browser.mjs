// Real cookie sessions + SSE signaling + native browser SDP negotiation, without device capture.
// No media packets or physical devices are claimed by this test.
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds} from '../src/worlds.js';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright-core'), embedded=(await import(require.resolve('@sparticuz/chromium'))).default;
const dir=await mkdtemp(join(tmpdir(),'universe-media-browser-')),results=[],errors=[],pages=[];
const reportPath=process.env.MEDIA_BROWSER_REPORT||new URL('../evidence/media-server-browser.json',import.meta.url);
let phase='setup',failure=null,browser,controlledOrdering;
for(const file of ['media-away.js','media-ice.js','media-policy-copy.js','media.css'])await copyFile(new URL('../src/'+file,import.meta.url),join(dir,file));
await copyFile(process.env.MEDIA_SOURCE||new URL('../src/media.js',import.meta.url),join(dir,'media.js'));
await writeFile(join(dir,'index.html'),'<link rel="stylesheet" href="/media.css"><div id="media"></div><script type="module" src="/harness.js"></script>');
await writeFile(join(dir,'harness.js'),`import {mountMedia} from './media.js';
window.lifecycle=[];
window.describe=()=>{const s=window.media?.getStatus?.();return s?{roomId:s.roomId,joined:s.joined,joining:s.joining,policyError:s.policyError,iceError:s.iceError,awaitingPolicy:s.awaitingPolicy,localSilent:s.localSilent,enabled:s.policy?.enabled,context:s.policy?.context,peerIds:s.policy?.peers?.map(p=>p.id),peers:s.peers.map(p=>({id:p.id,status:p.status,error:p.error,candidateCount:p.candidateCount}))}:null;};
window.record=(event,details={})=>{lifecycle.push({at:performance.now(),event,...details,status:describe()});if(lifecycle.length>1200)lifecycle.shift();};
window.api=async(path,{method='GET',body}={})=>{
 record('api:start',{path,method,enabled:body?.enabled,connectionId:body?.connectionId,descriptionType:body?.description?.type});
 const r=await fetch(path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await r.json();
 record('api:response',{path,statusCode:r.status,enabled:data.enabled});if(!r.ok)throw Error(data.message||data.error);
 // Hold only a local response continuation, after the real server authorized
 // consent. SSE and native offer creation stay live; there is no synthetic SDP.
 if(window.holdConsent&&path==='/api/media/state'&&body?.enabled){
  window.holdConsent=false;window.consentHeld=true;record('consent:held');
  await new Promise(resolve=>window.releaseConsent=()=>{record('consent:released');window.consentHeld=false;resolve();});
 }
 return data;
};
window.state={room:null};const profile=await api('/api/session',{method:'POST',body:{name:new URL(location.href).searchParams.get('name')||'Tester',woka:0}});state.user=profile.user;
window.enter=async(id)=>{const data=await api('/api/rooms/'+id+'/join',{method:'POST',body:{}});state.room=data.room;window.media?.update?.();};await enter('commons');
window.media=mountMedia({root:document.querySelector('#media'),api,getState:()=>state});window.events=new EventSource('/api/events');
for(const type of ['media-policy','media-signal','presence'])events.addEventListener(type,event=>{
 const data=JSON.parse(event.data);record('sse:'+type,{roomId:data.roomId,from:data.from,connectionId:data.connectionId,descriptionType:data.description?.type,enabled:data.enabled});
 if(type==='media-signal'&&data.description?.type==='offer'&&window.consentHeld){window.offerDuringHeldConsent=true;window.heldOfferStatus=describe();}
 media.onEvent({type,data});
});window.ready=true;`);
const app=createGameServer({database:':memory:',seeds:seedWorlds,dist:dir});const {port}=await app.listen(0);
try{
 browser=await chromium.launch({executablePath:await embedded.executablePath(),headless:true,args:['--no-sandbox','--no-zygote']});
 for(const name of ['Owner','Member']){
  const context=await browser.newContext(),page=await context.newPage();pages.push(page);
  page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
  page.on('console',m=>{if(m.type()==='error')console.error('BROWSER',m.text());});
  await page.addInitScript(()=>{
   const Native=RTCPeerConnection;window.nativePeers=[];
   window.RTCPeerConnection=new Proxy(Native,{construct(Target,args){
    const pc=new Target(...args),index=nativePeers.length;nativePeers.push(pc);window.record?.('rtc:construct',{index});
    for(const method of ['createOffer','createAnswer','setLocalDescription','setRemoteDescription']){
     const original=pc[method].bind(pc);pc[method]=async(...args)=>{
      window.record?.('rtc:'+method+':start',{index,descriptionType:args[0]?.type});
      try{const result=await original(...args);window.record?.('rtc:'+method+':end',{index,local:pc.localDescription?.type,remote:pc.remoteDescription?.type,signalingState:pc.signalingState});return result;}
      catch(error){window.record?.('rtc:'+method+':error',{index,error:error.message});throw error;}
     };
    }
    const close=pc.close.bind(pc);pc.close=()=>{window.record?.('rtc:close',{index});return close();};return pc;
   }});
   window.captureAttempts=0;for(const name of ['getUserMedia','getDisplayMedia'])if(navigator.mediaDevices?.[name])navigator.mediaDevices[name]=()=>{captureAttempts++;throw Error('Capture prohibited in this signaling-only test');};
  });
  await page.goto(`http://127.0.0.1:${port}/?name=${name}`);await page.waitForFunction(()=>window.ready&&events.readyState===1);
 }
 const [a,b]=pages,ids=await Promise.all(pages.map(p=>p.evaluate(()=>state.user.id)));
 assert.notEqual(ids[0],ids[1]);
 const offerer=pages[ids[0]<ids[1]?0:1],answerer=pages[ids[0]<ids[1]?1:0];
 phase='initial native SDP';
 for(const p of pages)await p.locator('.media-join').click();
 for(const p of pages)await p.waitForFunction(()=>nativePeers.some(pc=>pc.remoteDescription&&pc.localDescription),null,{timeout:12000});
 const roundtrip=await Promise.all(pages.map(p=>p.evaluate(()=>{const pc=nativePeers.find(pc=>pc.remoteDescription);return {local:pc.localDescription.type,remote:pc.remoteDescription.type,directions:pc.getTransceivers().map(t=>t.direction),status:media.getStatus().peers[0]?.status,candidates:media.getStatus().peers[0]?.candidateCount};})));
 assert.deepEqual(roundtrip.map(x=>x.local).sort(),['answer','offer']);for(const r of roundtrip)assert.deepEqual(r.directions,['sendrecv','sendrecv','sendrecv']);
 results.push({test:'Separate HttpOnly cookie guests negotiate native offer and answer over authorized server SSE',status:'pass',observations:roundtrip});
 phase='quiet-area teardown';
 await a.evaluate(()=>api('/api/presence',{method:'POST',body:{roomId:'commons',x:6,z:-3,moving:false}}));
 for(const p of pages)await p.waitForFunction(()=>media.getStatus().peers.length===0&&nativePeers.every(pc=>pc.connectionState==='closed'));
 results.push({test:'Authoritative quiet-area update closes both native peer connections',status:'pass'});
 phase='assembly room change';
 for(const p of pages)await p.evaluate(()=>enter('assembly'));
 await a.evaluate(()=>api('/api/presence',{method:'POST',body:{roomId:'assembly',x:0,z:-7,moving:false}}));
 await b.evaluate(()=>api('/api/presence',{method:'POST',body:{roomId:'assembly',x:0,z:0,moving:false}}));
 phase='offer arrives before answerer consent acknowledgement';
 await answerer.evaluate(()=>{window.holdConsent=true;record('control:hold-next-consent');});
 await offerer.locator('.media-join').click();await offerer.waitForFunction(()=>media.getStatus().joined&&!media.getStatus().joining);
 await answerer.locator('.media-join').click();
 await answerer.waitForFunction(()=>window.consentHeld&&window.offerDuringHeldConsent,null,{timeout:12000});
 controlledOrdering=await answerer.evaluate(()=>({atOffer:heldOfferStatus,beforeRelease:describe(),activeNativePeers:nativePeers.filter(pc=>pc.connectionState!=='closed').length}));
 assert.equal(controlledOrdering.atOffer.joined,false);assert.equal(controlledOrdering.atOffer.joining,true);assert.equal(controlledOrdering.atOffer.enabled,true);
 assert.equal(controlledOrdering.activeNativePeers,0,'Pending consent must not start native transport');
 await answerer.evaluate(()=>releaseConsent());
 phase='second active native SDP after delayed consent';
 // Original active-peer/two-description assertion, without retry or extra timeout.
 for(const p of pages)await p.waitForFunction(()=>nativePeers.some(pc=>pc.connectionState!=='closed'&&pc.remoteDescription&&pc.localDescription));
 results.push({test:'Native offer delivered during pending join negotiates after acknowledgement without retry or capture',status:'pass',observations:controlledOrdering});
 const oneWay=await Promise.all(pages.map(p=>p.evaluate(()=>nativePeers.filter(pc=>pc.connectionState!=='closed').at(-1).getTransceivers().map(t=>t.direction))));
 assert.deepEqual(oneWay[0],['sendonly','sendonly','sendonly']);assert.deepEqual(oneWay[1],['recvonly','recvonly','recvonly']);
 results.push({test:'Role-validated native stage SDP is sendonly and audience SDP is recvonly',status:'pass',directions:oneWay});
 phase='final room teardown';
 await b.evaluate(()=>enter('studio'));for(const p of pages)await p.waitForFunction(()=>media.getStatus().peers.length===0&&nativePeers.every(pc=>pc.connectionState==='closed'));
 results.push({test:'Room switch removes authorized graph and closes actual old-room transports',status:'pass'});
 for(const p of pages)assert.equal(await p.evaluate(()=>captureAttempts),0);
 assert.deepEqual(errors,[]);phase='complete';
}catch(error){failure={phase,name:error.name,message:error.message};throw error;}
finally{
 try{
  const diagnostics=await Promise.all(pages.map(async page=>{
   try{return await page.evaluate(()=>({status:describe(),captureAttempts,lifecycle,peers:nativePeers.map(pc=>({state:pc.connectionState,signalingState:pc.signalingState,local:pc.localDescription?.type,remote:pc.remoteDescription?.type,directions:pc.getTransceivers().map(t=>t.direction)}))}));}
   catch(error){return {unavailable:error.message};}
  }));
  const report={type:'native-browser-authenticated-signaling',timestamp:new Date().toISOString(),browser:await browser?.version(),phase,failure,results,errors,diagnostics,limits:['Device capture was prohibited by the test harness and never attempted.','This verifies native SDP negotiation and teardown only; no media packets or ICE connectivity are asserted.','No successful audio, video, screen-sharing packets, physical devices, TURN relay, or multi-network transport are asserted.']};
  await writeFile(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,diagnostics:diagnostics.map(({lifecycle,...summary})=>({...summary,lifecycleEvents:lifecycle?.length}))},null,2));
 }finally{
  for(const page of pages)await page.evaluate(()=>{window.media?.destroy?.();window.events?.close?.();}).catch(()=>{});
  await browser?.close();await app.close();await rm(dir,{recursive:true,force:true});
 }
}
