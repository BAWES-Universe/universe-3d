import test from 'node:test';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {Store} from '../server/store.mjs';
import {createGameServer} from '../server/app.mjs';
import {bootstrapOwner} from '../server/operator-accounts.mjs';
import {createAccessGate} from '../server/access-gate.mjs';
import {createOpenSignup} from '../server/open-signup.mjs';
import {readRuntimeConfig} from '../server/runtime-config.mjs';
import {publicGuestPerson} from '../server/public-guests.mjs';
import {createArrivalState} from '../src/arrival-state.js';
import {sceneOperationGeometryConflicts} from '../server/scene-operation-geometry.mjs';
import {validateTerrainSceneDelta} from '../server/terrain.mjs';
import {proximityFixture} from './fixtures/proximity-config.mjs';
import {makePng} from '../fixtures/png-fixtures.mjs';
const password='synthetic guest transition password';
const scene={version:1,theme:'garden',bounds:{width:24,depth:22},spawn:{x:0,z:6},areas:[{id:'welcome',name:'Welcome',x:5,z:0,width:2,depth:2,action:'welcome',start:{key:'welcome'}}],objects:[{id:'chair',type:'chair',x:2,z:6,rotation:0}]};
const seeds=[{id:'universe',name:'Synthetic',rooms:['commons','studio','private'].map(id=>({id,name:id,scene:structuredClone(scene)}))}];
const env=(database,mode='open',setup=false)=>({UNIVERSE_MODE:'public',UNIVERSE_BIND_ADDRESS:'127.0.0.1',PORT:'4190',UNIVERSE_DB:database,UNIVERSE_ALLOWED_HOSTS:'preview.example.test',UNIVERSE_ALLOWED_ORIGINS:'https://preview.example.test',UNIVERSE_TLS_MODE:'external',UNIVERSE_COOKIE_SECURE:'always',UNIVERSE_REGISTRATION_MODE:mode,UNIVERSE_SETUP_ONLY:setup?'1':'0'});
function request(port,path,{method='GET',body,cookie,headers={}}={}){return new Promise((resolve,reject)=>{const bytes=body===undefined?undefined:JSON.stringify(body);const req=http.request({hostname:'127.0.0.1',port,path,method,headers:{Host:'preview.example.test',...(method==='GET'?{}:{Origin:'https://preview.example.test'}),...(cookie?{Cookie:cookie}:{}),...(bytes===undefined?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(bytes)}),...headers}},res=>{const chunks=[];res.on('data',p=>chunks.push(p));res.on('end',()=>{const text=Buffer.concat(chunks).toString();let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,data,text,headers:res.headers,cookie:res.headers['set-cookie']?.[0].split(';')[0]});});});req.on('error',reject);req.end(bytes);});}
async function fixture(t,{mode='open',setup=false,proximity=false}={}){const dir=await mkdtemp(join(tmpdir(),'public-guest-')),database=join(dir,'synthetic.sqlite');let time=Date.now(),app,port,owner;if(!setup){const store=new Store(database,seeds);owner=await bootstrapOwner(store,{name:'Synthetic Owner',username:'synthetic_owner',password});store.run('UPDATE rooms SET public=0 WHERE id=?','private');store.close();}const config=readRuntimeConfig(env(database,mode,setup));const start=async()=>{app=createGameServer({database,seeds,runtimeConfig:config,clock:()=>time,...(proximity?{proximityMembershipConfig:proximityFixture,proximityTextConfig:{enabled:true}}:{})});port=(await app.listen(0)).port;};await start();t.after(async()=>{await app?.close();await rm(dir,{recursive:true,force:true});});return{get app(){return app;},get port(){return port;},owner,config,database,call:(path,options)=>request(port,path,options),advance:ms=>time+=ms,restart:async()=>{await app.close();app=null;await start();}};}
async function guest(f){const r=await f.call('/api/session',{method:'POST',body:{}});assert.equal(r.status,201,r.text);assert.equal(r.data.user.ephemeralGuest,true);assert.equal(r.data.user.account,false);return{...r,user:r.data.user};}
const as=(f,cookie)=>(path,method='GET',body)=>f.call(path,{method,body,cookie});
function unprivileged(f,id){for(const table of['universes','worlds','rooms'])assert.equal(f.app.store.get(`SELECT COUNT(*) n FROM ${table} WHERE owner_id=?`,id).n,0);for(const table of['members','world_members','accounts','users','sessions'])assert.equal(f.app.store.get(`SELECT COUNT(*) n FROM ${table} WHERE ${table==='users'?'id':'user_id'}=?`,id).n,0);}
const movement=(roomId,a,extra={})=>({roomId,admissionId:a.admissionId,admissionEpoch:a.admissionEpoch,admissionRevision:a.admissionRevision,x:a.x,z:a.z,y:0,grounded:true,verticalVelocity:0,moving:false,...extra});
async function owner(f){return f.call('/api/login',{method:'POST',body:{username:'synthetic_owner',password}});}

// Real public-mode HTTP/SSE, synthetic durable owner and process-local guests.
async function events(t,f,g){
 const rows=[],waiters=new Set();let buffer='';
 const req=http.get({hostname:'127.0.0.1',port:f.port,path:'/api/events',headers:{Host:'preview.example.test',Cookie:g.cookie}},res=>res.on('data',bytes=>{
  buffer+=bytes;let end;while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);const event=block.match(/^event: (.+)$/m)?.[1],data=block.match(/^data: (.+)$/m)?.[1];if(event&&data){rows.push({event,data:JSON.parse(data)});for(const check of waiters)check();}}
 }));
 t.after(()=>req.destroy());
 const wait=(predicate,after=0)=>new Promise((resolve,reject)=>{const check=()=>{const row=rows.slice(after).find(predicate);if(row){clearTimeout(timer);waiters.delete(check);resolve(row);}};const timer=setTimeout(()=>{waiters.delete(check);reject(Error('SSE did not receive expected event'));},3000);waiters.add(check);check();});
 await wait(e=>e.event==='hello');return{rows,wait,close:()=>req.destroy()};
}
async function context(call,stream){await stream.wait(e=>e.event==='proximity-text-context');const epoch=stream.rows.filter(e=>e.event==='proximity-text-context').at(-1).data.connectionEpoch;const r=await call('/api/proximity-text?connectionEpoch='+epoch);assert.equal(r.status,200,r.text);return r.data;}
const envelope=(p,text)=>({requestId:randomUUID(),text,...Object.fromEntries(['connectionEpoch','roomId','bubbleId','memberId','membershipRevision'].map(key=>[key,p[key]]))});
const permanent=f=>f.app.store.all("SELECT name FROM main.sqlite_master WHERE type='table' ORDER BY name").map(({name})=>({name,rows:f.app.store.all(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`)}));

test('Two public guests exchange real bubble text with devices off; room/private/persistence boundaries survive',async t=>{
 const f=await fixture(t,{proximity:true}),signed=await owner(f),o=as(f,signed.cookie),before=permanent(f),a=await guest(f),b=await guest(f),ac=as(f,a.cookie),bc=as(f,b.cookie);
 for(const call of[ac,bc])assert.equal((await call('/api/rooms/commons/join','POST',{})).status,200);
 const sa=await events(t,f,a),sb=await events(t,f,b),p=await context(ac,sa);assert.equal(p.canSend,true);assert.equal(p.recipientCount,1);
 for(const call of[ac,bc])assert.equal((await call('/api/media')).data.enabled,false);
 const typing={...Object.fromEntries(['connectionEpoch','roomId','bubbleId','memberId','membershipRevision'].map(key=>[key,p[key]])),sequence:1,isTyping:true};assert.equal((await ac('/api/proximity-text/typing','POST',typing)).status,200);await sb.wait(e=>e.event==='proximity-typing');
 const sent=await ac('/api/proximity-text/messages','POST',envelope(p,'Hello from a guest'));assert.equal(sent.status,201,sent.text);
 const received=await sb.wait(e=>e.event==='proximity-text-message');assert.equal(received.data.text,'Hello from a guest');assert.equal(received.data.author.id,a.user.id);
 assert.equal((await bc('/api/proximity-text/messages','POST',envelope(await context(bc,sb),'Hello back'))).status,201);await sa.wait(e=>e.event==='proximity-text-message'&&e.data.text==='Hello back');
 assert.equal((await ac('/api/rooms/private/join','POST',{})).status,404);
 assert.equal((await ac('/api/rooms/commons/messages','POST',{text:'Cannot persist'})).data.code,'GUEST_ACCOUNT_REQUIRED');
 assert.deepEqual(permanent(f),before);unprivileged(f,a.user.id);unprivileged(f,b.user.id);
 assert.equal((await o('/api/rooms/commons/moderate','POST',{userId:a.user.id,action:'mute'})).status,200);
 assert.equal((await ac('/api/proximity-text/messages','POST',envelope(await context(ac,sa),'Blocked'))).status,403);
});

test('A guest and registered person join/leave real authorized media and fence old signaling after rejoin',async t=>{
 const f=await fixture(t,{proximity:true}),a=await guest(f),signed=await owner(f),ac=as(f,a.cookie),bc=as(f,signed.cookie);
 for(const call of[ac,bc])assert.equal((await call('/api/rooms/commons/join','POST',{})).status,200);
 const mediaReceiver=await events(t,f,signed);
 let pa=(await ac('/api/media')).data,pb=(await bc('/api/media')).data;
 assert.equal(pa.proximityMembership.conversationRecipients[0].accountId,signed.data.user.id);assert.equal(pa.enabled,false);
 for(const[call,p]of[[ac,pa],[bc,pb]])assert.equal((await call('/api/media/state','POST',{roomId:'commons',memberId:p.proximityMembership.memberId,enabled:true})).status,200);
 pa=(await ac('/api/media')).data;pb=(await bc('/api/media')).data;assert.equal(pa.peers.length,1);assert.equal(pb.peers.length,1);assert(pa.iceScope);
 const s=pa.proximityMembership,signal={roomId:'commons',to:signed.data.user.id,connectionId:'synthetic-local-connection',bubbleId:s.bubbleId,fromMemberId:s.memberId,toMemberId:pa.peers[0].memberId,intentGeneration:s.transport.intentGeneration,mediaScope:s.mediaScope,request:'offer'};
 assert.equal((await ac('/api/media/signal','POST',signal)).status,200);
 assert.equal((await mediaReceiver.wait(e=>e.event==='media-signal')).data.from,a.user.id);
 const iceBody={scope:pa.iceScope,requestId:randomUUID()};assert.equal((await ac('/api/media/ice','POST',iceBody)).status,200);
 assert.equal((await ac('/api/media/signal','POST',{...signal,to:'unrelated-person'})).status,403);
 assert.equal((await ac('/api/media/state','POST',{roomId:'commons',memberId:s.memberId,enabled:false})).status,200);assert.equal((await ac('/api/media/signal','POST',signal)).status,403);
 assert.equal((await ac('/api/rooms/commons/leave','POST',{})).status,200);assert.equal((await bc('/api/media')).data.peers.length,0);assert([403,409].includes((await ac('/api/media/ice','POST',iceBody)).status));
 assert.equal((await ac('/api/rooms/commons/join','POST',{})).status,200);assert.equal((await ac('/api/media')).data.enabled,false);
 assert.equal((await ac('/api/media/state','POST',{roomId:'commons',memberId:s.memberId,enabled:true})).status,403);
 unprivileged(f,a.user.id);
});

test('Guest leave/rejoin and SSE reconnect reject old text envelopes without replaying history',async t=>{
 const f=await fixture(t,{proximity:true}),a=await guest(f),b=await guest(f),ac=as(f,a.cookie),bc=as(f,b.cookie);
 for(const call of[ac,bc])await call('/api/rooms/commons/join','POST',{});
 const sa=await events(t,f,a),sb=await events(t,f,b),old=envelope(await context(ac,sa),'Old');
 await ac('/api/rooms/commons/leave','POST',{});assert([403,409].includes((await ac('/api/proximity-text/messages','POST',old)).status));
 await ac('/api/rooms/commons/join','POST',{});assert([403,409].includes((await ac('/api/proximity-text/messages','POST',old)).status));
 const current=envelope(await context(ac,sa),'After rejoin');assert.equal((await ac('/api/proximity-text/messages','POST',current)).status,201);await sb.wait(e=>e.event==='proximity-text-message');
 sa.close();await new Promise(resolve=>setTimeout(resolve,30));const next=await events(t,f,a);const nextContext=await context(ac,next);assert.notEqual(nextContext.connectionEpoch,current.connectionEpoch);assert.equal(next.rows.filter(e=>e.event==='proximity-text-message').length,0);
 assert.equal((await ac('/api/proximity-text/messages','POST',current)).status,409);
 assert.equal((await ac('/api/proximity-text/messages','POST',envelope(nextContext,'After reconnect'))).status,201);
 assert.equal((await ac('/api/session')).data.user.id,a.user.id);
 await ac('/api/logout','POST',{});assert.equal((await ac('/api/proximity-text/messages','POST',envelope(nextContext,'After logout'))).status,401);assert.equal(f.app.store.user(a.user.id),undefined);
});
test('Expired guest lease cannot send text, media consent, signaling or request ICE',async t=>{
 const f=await fixture(t,{proximity:true}),a=await guest(f),b=await guest(f),ac=as(f,a.cookie),bc=as(f,b.cookie);
 for(const call of[ac,bc])await call('/api/rooms/commons/join','POST',{});
 const stream=await events(t,f,a),p=await context(ac,stream),media=(await ac('/api/media')).data;await ac('/api/media/state','POST',{roomId:'commons',memberId:media.proximityMembership.memberId,enabled:true});const ice=(await ac('/api/media')).data.iceScope;
 f.advance(86400001);
 for(const[path,body]of[['/api/proximity-text/messages',envelope(p,'Expired')],['/api/media/state',{roomId:'commons',memberId:media.proximityMembership.memberId,enabled:true}],['/api/media/signal',{roomId:'commons',to:b.user.id,connectionId:'expired',request:'offer'}],['/api/media/ice',{scope:ice,requestId:randomUUID()}]])assert.equal((await ac(path,'POST',body)).status,401,path);
});
