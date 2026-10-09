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
await writeFile(join(dir,'index.html'),'<!doctype html><link rel="stylesheet" href="/fixture.css"><main></main><script type="module" src="/fixture.js"></script>');
const app=createGameServer({database,seeds,dist:dir,runtimeConfig:{...config,allowedOrigins:[base]},...DEFAULT_PROXIMITY_CONFIG});await app.listen(port);
const browser=await chromium.launch({executablePath:await embedded.executablePath(),headless:true,args:['--no-sandbox','--no-zygote','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});const contexts=[],pages=[],result={syntheticCapture:true,nativePeerConnection:true,remoteAudioVideoVerified:false,peers:[],errors:[]};
await mkdir('evidence/guest-conversations',{recursive:true});
try{
 for(let i=0;i<2;i++){const context=await browser.newContext({viewport:{width:1000,height:700}});contexts.push(context);await context.addInitScript(()=>{window.rtcDiagnostics=[];const Native=RTCPeerConnection;window.RTCPeerConnection=class extends Native{constructor(config){super(config);const row={config:this.getConfiguration(),candidates:[],candidateErrors:[],states:[]};rtcDiagnostics.push(row);this.addEventListener('icecandidate',e=>{if(e.candidate)row.candidates.push({type:e.candidate.type,protocol:e.candidate.protocol});});this.addEventListener('icecandidateerror',e=>row.candidateErrors.push({code:e.errorCode,text:e.errorText}));this.addEventListener('icegatheringstatechange',()=>row.states.push(this.iceGatheringState));}};});const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>result.errors.push(e.message));await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.ready);assert.equal(await page.evaluate(()=>state.user.ephemeralGuest),true);pages.push(page);}
 for(const page of pages){await page.getByRole('button',{name:'Join audio',exact:true}).click();await page.waitForFunction(()=>media.getStatus().joined);await page.locator('[data-media=microphone]').click();await page.locator('[data-media=camera]').click();}
 // Bounded transport outcome window; this is evidence, not a fabricated pass.
 await Promise.all(pages.map(page=>page.waitForFunction(()=>media.getStatus().peers.some(p=>p.status==='connected'),null,{timeout:20000}).catch(()=>{})));
 for(const page of pages){const status=await page.evaluate(()=>{const s=media.getStatus();return{rtcDiagnostics,iceTransport:s.iceTransport,iceServerCount:s.policy?.iceServers?.length??null,localTracks:Object.fromEntries(Object.entries(s.devices).map(([kind,d])=>[kind,d.stream?.getTracks().map(t=>({kind:t.kind,readyState:t.readyState,enabled:t.enabled}))??[]])),devices:s.devices,peers:s.peers.map(p=>({id:p.id,status:p.status,candidateCount:p.candidateCount,receivedBytes:p.receivedBytes,remoteKinds:Object.entries(p.streams||{}).filter(([,stream])=>stream?.getTracks?.().length).map(([kind])=>kind),error:p.error})),remoteTracks:[...document.querySelectorAll('video,audio')].filter(el=>!el.muted&&el.srcObject).flatMap(el=>el.srcObject.getTracks().map(t=>({kind:t.kind,readyState:t.readyState})))};});result.peers.push(status);}
 result.remoteAudioVideoVerified=result.peers.every(p=>p.peers.some(peer=>peer.status==='connected'&&peer.receivedBytes>0)&&p.remoteTracks.some(t=>t.kind==='audio'&&t.readyState==='live')&&p.remoteTracks.some(t=>t.kind==='video'&&t.readyState==='live'));
 console.log(JSON.stringify(result,null,2));assert.deepEqual(result.errors,[]);
 for(const page of pages){await page.getByRole('button',{name:'Leave audio',exact:true}).click();assert.equal(await page.evaluate(()=>media.getStatus().joined),false);}
}finally{await writeFile('evidence/guest-conversations/native-media-result.json',JSON.stringify(result,null,2));for(const context of contexts)await context.close();await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
