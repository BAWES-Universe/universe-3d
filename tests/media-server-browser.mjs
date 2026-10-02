// Real cookie sessions + SSE signaling + native browser SDP negotiation, without device capture.
// No media packets or physical devices are claimed by this test.
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,readFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds} from '../src/worlds.js';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright-core'), embedded=(await import(require.resolve('@sparticuz/chromium'))).default;
const dir=await mkdtemp(join(tmpdir(),'universe-media-browser-')),results=[],errors=[];
await copyFile(new URL('../src/media.js',import.meta.url),join(dir,'media.js'));await copyFile(new URL('../src/media.css',import.meta.url),join(dir,'media.css'));
await writeFile(join(dir,'index.html'),'<link rel="stylesheet" href="/media.css"><div id="media"></div><script type="module" src="/harness.js"></script>');
await writeFile(join(dir,'harness.js'),`import {mountMedia} from './media.js';
window.api=async(path,{method='GET',body}={})=>{const r=await fetch(path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw Error(data.message||data.error);return data};
window.state={room:null};const profile=await api('/api/session',{method:'POST',body:{name:new URL(location.href).searchParams.get('name')||'Tester',woka:0}});state.user=profile.user;
window.enter=async(id)=>{const data=await api('/api/rooms/'+id+'/join',{method:'POST',body:{}});state.room=data.room;window.media?.update?.();};await enter('commons');
window.media=mountMedia({root:document.querySelector('#media'),api,getState:()=>state});window.events=new EventSource('/api/events');for(const type of ['media-policy','media-signal','presence'])events.addEventListener(type,event=>media.onEvent({type,data:JSON.parse(event.data)}));window.ready=true;`);
const app=createGameServer({database:':memory:',seeds:seedWorlds,dist:dir});const {port}=await app.listen(0);let browser;
try{
  browser=await chromium.launch({executablePath:await embedded.executablePath(),headless:true,args:['--no-sandbox','--no-zygote']});
  const pages=[];
  for(const name of ['Owner','Member']){
    const context=await browser.newContext();const page=await context.newPage();page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});page.on('console',m=>{if(m.type()==='error')console.error('BROWSER',m.text());});
    await page.addInitScript(()=>{const Native=RTCPeerConnection;window.nativePeers=[];window.RTCPeerConnection=new Proxy(Native,{construct(Target,args){const pc=new Target(...args);nativePeers.push(pc);return pc;}});window.captureAttempts=0;for(const name of ['getUserMedia','getDisplayMedia'])if(navigator.mediaDevices?.[name])navigator.mediaDevices[name]=()=>{captureAttempts++;throw Error('Capture prohibited in this signaling-only test');};});
    await page.goto(`http://127.0.0.1:${port}/?name=${name}`);await page.waitForFunction(()=>window.ready);pages.push(page);
  }
  const [a,b]=pages;assert.notEqual(await a.evaluate(()=>state.user.id),await b.evaluate(()=>state.user.id));
  for(const p of pages)await p.locator('.media-join').click();
  for(const p of pages)await p.waitForFunction(()=>nativePeers.some(pc=>pc.remoteDescription&&pc.localDescription),{timeout:12000});
  const roundtrip=await Promise.all(pages.map(p=>p.evaluate(()=>{const pc=nativePeers.find(pc=>pc.remoteDescription);return {local:pc.localDescription.type,remote:pc.remoteDescription.type,directions:pc.getTransceivers().map(t=>t.direction),status:media.getStatus().peers[0]?.status,candidates:media.getStatus().peers[0]?.candidateCount};})));
  assert.deepEqual(roundtrip.map(x=>x.local).sort(),['answer','offer']);for(const r of roundtrip)assert.deepEqual(r.directions,['sendrecv','sendrecv','sendrecv']);
  results.push({test:'Separate HttpOnly cookie guests negotiate native offer and answer over authorized server SSE',status:'pass',observations:roundtrip});
  // A quiet-area move must close both native transports after the policy event.
  await a.evaluate(()=>api('/api/presence',{method:'POST',body:{roomId:'commons',x:6,z:-3,moving:false}}));
  for(const p of pages)await p.waitForFunction(()=>media.getStatus().peers.length===0&&nativePeers.every(pc=>pc.connectionState==='closed'));
  results.push({test:'Authoritative quiet-area update closes both native peer connections',status:'pass'});
  for(const p of pages)await p.evaluate(()=>enter('assembly'));
  await a.evaluate(()=>api('/api/presence',{method:'POST',body:{roomId:'assembly',x:0,z:-7,moving:false}}));
  await b.evaluate(()=>api('/api/presence',{method:'POST',body:{roomId:'assembly',x:0,z:0,moving:false}}));
  for(const p of pages)await p.locator('.media-join').click();
  for(const p of pages)await p.waitForFunction(()=>nativePeers.some(pc=>pc.connectionState!=='closed'&&pc.remoteDescription&&pc.localDescription));
  const oneWay=await Promise.all(pages.map(p=>p.evaluate(()=>nativePeers.filter(pc=>pc.connectionState!=='closed').at(-1).getTransceivers().map(t=>t.direction))));
  assert.deepEqual(oneWay[0],['sendonly','sendonly','sendonly']);assert.deepEqual(oneWay[1],['recvonly','recvonly','recvonly']);
  results.push({test:'Role-validated native stage SDP is sendonly and audience SDP is recvonly',status:'pass',directions:oneWay});
  await b.evaluate(()=>enter('studio'));for(const p of pages)await p.waitForFunction(()=>media.getStatus().peers.length===0&&nativePeers.every(pc=>pc.connectionState==='closed'));
  results.push({test:'Room switch removes authorized graph and closes actual old-room transports',status:'pass'});
  for(const p of pages){assert.equal(await p.evaluate(()=>captureAttempts),0);await p.evaluate(()=>{media.destroy();events.close();});}
  assert.deepEqual(errors,[]);const report={type:'native-browser-authenticated-signaling',timestamp:new Date().toISOString(),browser:await browser.version(),results,errors,limits:['Device capture was prohibited by the test harness and never attempted.','This verifies native SDP negotiation and teardown only; zero ICE candidates were observed.','No successful audio, video, screen-sharing packets, physical devices, TURN relay, or multi-network transport are asserted.']};
  await writeFile(new URL('../evidence/media-server-browser.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser?.close();await app.close();await rm(dir,{recursive:true,force:true});}
