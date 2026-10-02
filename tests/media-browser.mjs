// Native Chromium negative/lifecycle test against an isolated local API harness.
// getUserMedia is browser-denied before clicking. No devices, screen consent, or external ICE provider are used.
// This verifies browser permission denial and genuine SDP/teardown, NOT two-device transport.
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright-core');
const embeddedChromium=(await import(require.resolve('@sparticuz/chromium'))).default;
const results=[],signals=[];let enabled=false;
const policy=()=>({selfId:'a',roomId:'r',enabled,context:{kind:'proximity',label:'Nearby conversation',canPublish:true,reason:'Stop near someone to connect'},peers:enabled?[{id:'b',displayName:'Test peer',canSend:true,canReceive:true}]:[],iceServers:[]});
const server=createServer(async(req,res)=>{
  try {
    const path=new URL(req.url,'http://localhost').pathname;let data='';for await(const c of req)data+=c;
    if(['/src/media.js','/src/media-ice.js','/src/media.css','/src/media-policy-copy.js'].includes(path)){res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':'text/css');res.end(await readFile(new URL('..'+path,import.meta.url)));return;}
    if(path==='/api/media'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(policy()));return;}
    if(path==='/api/media/state'){enabled=JSON.parse(data).enabled;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(policy()));return;}
    if(path==='/api/media/signal'){signals.push(JSON.parse(data));res.setHeader('Content-Type','application/json');res.end('{"ok":true}');return;}
    res.setHeader('Permissions-Policy','microphone=(), camera=()');res.setHeader('Content-Type','text/html');res.end(`<!doctype html><html><head><link rel="stylesheet" href="/src/media.css"><style>body{background:#100c18;font-family:Arial;margin:0}#media{position:absolute;bottom:28px;left:28px}</style></head><body><div id="media"></div><script type="module">import {mountMedia} from '/src/media.js';const api=async(path,{method='GET',body}={})=>{const r=await fetch(path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error('HTTP '+r.status);return r.json()};window.media=mountMedia({root:document.querySelector('#media'),api,getState:()=>({room:{id:'r'}})});</script></body></html>`);
  }catch(e){res.statusCode=500;res.end(e.message);}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser=await chromium.launch({executablePath:await embeddedChromium.executablePath(),headless:true,args:['--no-sandbox','--no-zygote','--single-process']});
  const page=await browser.newPage({viewport:{width:1100,height:700}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{const Native=RTCPeerConnection;window.nativePeers=[];window.RTCPeerConnection=new Proxy(Native,{construct(Target,args){const pc=new Target(...args);window.nativePeers.push(pc);return pc;}});});
  // Permissions-Policy on this isolated harness denies capture before any device prompt.
  await page.goto(url);await page.waitForFunction(()=>window.media?.getStatus().policy);
  assert.equal(await page.evaluate(()=>nativePeers.length),0);results.push({test:'No capture or peer transport on load',status:'pass'});
  await page.locator('[data-media="microphone"]').click();
  await page.waitForFunction(()=>window.media.getStatus().devices.microphone.status==='error');
  const denial=await page.evaluate(()=>window.media.getStatus().devices.microphone);
  assert.equal(denial.stream,null);assert.match(denial.error,/not allowed|No microphone was found|could not start/);assert.equal(enabled,false);results.push({test:'Native Chromium capture request rejected; no stream and no call join',status:'pass',observedError:denial.error,permission:await page.evaluate(async()=>(await navigator.permissions.query({name:'microphone'})).state)});
  await page.locator('.media-join').click();await page.waitForFunction(()=>window.nativePeers.length===1);await page.waitForTimeout(600);
  assert.equal(signals.some(s=>s.description?.type==='offer'),true);const offer=signals.find(s=>s.description?.type==='offer');assert.equal((offer.description.sdp.match(/^m=/gm)||[]).length,3);
  const observed=await page.evaluate(()=>({configuration:nativePeers[0].getConfiguration(),transceivers:nativePeers[0].getTransceivers().map(t=>({direction:t.direction,track:t.sender.track})),status:media.getStatus().peers[0]}));
  assert.deepEqual(observed.configuration.iceServers,[]);assert(observed.transceivers.every(t=>t.track===null));results.push({test:'Real RTCPeerConnection creates 3-slot SDP without capturing devices',status:'pass',localCandidates:observed.status.candidateCount,iceGathering:observed.status.gathering});
  await page.locator('.media-details-toggle').click();await page.screenshot({path:new URL('../evidence/media-native-browser.png',import.meta.url).pathname});
  await page.locator('.media-join').click();await page.waitForFunction(()=>window.nativePeers[0].connectionState==='closed');assert.equal(await page.evaluate(()=>window.media.getStatus().peers.length),0);results.push({test:'Leave closes actual RTCPeerConnection and removes peers',status:'pass'});
  await page.evaluate(()=>window.media.destroy());assert.equal(await page.locator('#media').textContent(),'');assert.deepEqual(errors,[]);results.push({test:'Unmount removes media DOM without page errors',status:'pass'});
  await mkdir(new URL('../evidence/',import.meta.url),{recursive:true});
  const report={type:'native-browser-negative-and-lifecycle',timestamp:new Date().toISOString(),browser:await browser.version(),results,limits:['Microphone/camera are denied by Permissions-Policy on this test harness; no real or fake capture device is used.','No screen-share consent was requested.','The local API harness is isolated and synthetic; server authority has separate backend integration tests.','No two-browser or physical-device transport success is asserted.'],signals:signals.filter(s=>s.description).map(s=>({type:s.description.type,mSections:(s.description.sdp.match(/^m=/gm)||[]).length})),errors};
  await writeFile(new URL('../evidence/media-native-browser.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
