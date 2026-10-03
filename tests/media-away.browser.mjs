// Browser DOM/keyboard/touch + injected track/visibility fixtures only.
// Permissions-Policy denies physical capture; no real gUM/RTC or device consent.
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require('playwright-core');
const embeddedChromium=(await import(require.resolve('@sparticuz/chromium'))).default;
const server=createServer(async(req,res)=>{
 try {
  const path=new URL(req.url,'http://localhost').pathname;
  if(['/src/media.js','/src/media-away.js','/src/media-ice.js','/src/media-policy-copy.js','/src/media.css','/public/universe-tokens.css'].includes(path)){res.setHeader('Content-Type',path.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(new URL('..'+path,import.meta.url)));return;}
  res.setHeader('Permissions-Policy','microphone=(), camera=(), display-capture=()');res.setHeader('Content-Type','text/html');
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/public/universe-tokens.css"><link rel="stylesheet" href="/src/media.css"><style>body{margin:0;background:#16121e;color:#fff;font:14px Arial}#media{position:absolute;bottom:16px;left:12px;right:12px}#content{position:absolute;top:12px;left:12px;width:150px;height:50px}</style></head><body><iframe id="content" title="Embedded content" srcdoc="<button>Embedded button</button>"></iframe><div id="media"></div><script type="module">
import {mountMedia} from '/src/media.js';
let enabled=false;window.captureCalls=0;window.tracks=[];window.fixtureVisibility='visible';
Object.defineProperty(document,'visibilityState',{get:()=>window.fixtureVisibility,configurable:true});
class Track{constructor(){this.readyState='live';this.kind='audio';tracks.push(this)}stop(){this.readyState='ended'}}
class Stream{constructor(){this.tracks=[new Track()]}getTracks(){return this.tracks}removeTrack(track){this.tracks=this.tracks.filter(t=>t!==track)}}
Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{captureCalls++;return new Stream()},getDisplayMedia:async()=>{throw Error('Screen picker forbidden in fixture')}}});
Object.defineProperty(navigator,'permissions',{value:{query:async()=>({state:'granted'})}});
window.RTCPeerConnection=class{constructor(){throw Error('No peer transport expected')}};
const policy=()=>({selfId:'a',roomId:'r',enabled,context:{kind:'proximity',canPublish:true,group:'proximity',label:'Nearby conversation'},peers:[],awayPrivacy:{protocol:'media-away-v1',source:'legacy-media-graph',conversationActive:false,liveSessionActive:false,liveSessionSupported:false}});
const api=async(path,options={})=>{if(path==='/api/media/state')enabled=options.body.enabled;return policy()};
window.media=mountMedia({root:document.querySelector('#media'),api,getState:()=>({room:{id:'r'},user:{id:'a'},admissionId:'fixture-admission',ready:true})});
window.visibility=value=>{fixtureVisibility=value;document.dispatchEvent(new Event('visibilitychange'))};
</script></body></html>`);
 } catch(error){res.statusCode=500;res.end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}`,results=[],errors=[];
let browser;
try {
 browser=await chromium.launch({executablePath:await embeddedChromium.executablePath(),headless:true,args:['--no-sandbox','--no-zygote','--single-process']});
 const mobile=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true,userAgent:'Mozilla iPhone'});
 mobile.on('pageerror',e=>errors.push(e.message));
 await mobile.addInitScript(()=>Object.defineProperty(navigator,'platform',{get:()=> 'iPhone'}));
 await mobile.goto(url);await mobile.waitForFunction(()=>media.getStatus().policy);
 await mobile.getByRole('button',{name:'Media connection details',exact:true}).tap();
 const checkbox=mobile.getByRole('checkbox',{name:'Keep my microphone on while away'});
 assert.equal(await checkbox.isChecked(),false);await checkbox.focus();await checkbox.press('Space');assert.equal(await checkbox.isChecked(),true);
 assert.equal(await mobile.evaluate(()=>localStorage.getItem('phoneMicrophonePrivacySettings')),'true');
 await checkbox.press('Space');assert.equal(await checkbox.isChecked(),false);await mobile.locator('.media-away-choice').tap();assert.equal(await checkbox.isChecked(),true);await mobile.locator('.media-away-choice').tap();assert.equal(await checkbox.isChecked(),false);
 const size=await mobile.locator('.media-away-choice').boundingBox();assert(size.height>=48);assert(await mobile.locator('.media-away-help').isVisible());
 results.push({test:'Phone OFF default, independent storage, keyboard Space and touch label toggle',status:'pass',labelHeight:size.height});
 await mobile.getByRole('button',{name:'Media connection details',exact:true}).tap();
 await mobile.locator('[data-media="microphone"]').tap();await mobile.waitForFunction(()=>media.getStatus().devices.microphone.status==='on');
 await mobile.evaluate(()=>window.dispatchEvent(new Event('blur')));await mobile.frameLocator('#content').getByRole('button').tap();
 await mobile.getByRole('button',{name:'Media connection details',exact:true}).tap();assert.equal(await mobile.evaluate(()=>captureCalls),1);assert.equal(await mobile.evaluate(()=>tracks[0].readyState),'live');assert.equal(await mobile.evaluate(()=>media.getStatus().awayPrivacy.away),false);
 results.push({test:'Native DOM blur, iframe focus and expanded panel do not stop capture',status:'pass'});
 await mobile.evaluate(()=>visibility('hidden'));assert.equal(await mobile.evaluate(()=>tracks[0].readyState),'ended');assert.equal(await mobile.evaluate(()=>media.getStatus().awayPrivacy.away),true);
 await mobile.evaluate(()=>visibility('visible'));await mobile.waitForFunction(()=>media.getStatus().devices.microphone.status==='on'&&captureCalls===2);
 results.push({test:'Injected hidden/visible lifecycle stops tracks and restores still-requested microphone',status:'pass'});
 await mkdir(new URL('../evidence/',import.meta.url),{recursive:true});
 await mobile.screenshot({path:new URL('../evidence/media-away-phone.png',import.meta.url).pathname});
 await mobile.reload();await mobile.waitForFunction(()=>media.getStatus().policy);await mobile.getByRole('button',{name:'Media connection details',exact:true}).tap();assert.equal(await checkbox.isChecked(),false);assert.equal(await mobile.evaluate(()=>captureCalls),0);results.push({test:'Explicit phone OFF persists across reload; media does not start',status:'pass'});
 const desktop=await browser.newPage({viewport:{width:1100,height:760}});desktop.on('pageerror',e=>errors.push(e.message));await desktop.goto(url);await desktop.waitForFunction(()=>media.getStatus().policy);await desktop.getByRole('button',{name:'Media connection details',exact:true}).click();assert.equal(await desktop.getByRole('checkbox',{name:'Keep my microphone on while away'}).isChecked(),true);await desktop.screenshot({path:new URL('../evidence/media-away-desktop.png',import.meta.url).pathname});results.push({test:'Desktop native-source default remains ON',status:'pass'});
 await mobile.evaluate(()=>media.destroy());assert.equal(await mobile.locator('#media').textContent(),'');assert.deepEqual(errors,[]);
 const report={type:'synthetic-browser-media-away',timestamp:new Date().toISOString(),browser:await browser.version(),results,errors,limits:['Device capture APIs and permission responses are injected deterministic fixtures; Permissions-Policy denies real capture.','Visibility is injected. This does not establish physical phone/iPad/Android background behavior, OS indicators, phone calls or browser retention.','No live-session/SFU/relay connection is created or claimed.','Native keyboard, touch label interaction, iframe focus, CSS layout and DOM disposal are exercised.']};
 await writeFile(new URL('../evidence/media-away-browser.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
