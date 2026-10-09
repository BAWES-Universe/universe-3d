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
async function fixture(t,{mode='open',setup=false,proximity=false,provider}={}){const dir=await mkdtemp(join(tmpdir(),'public-guest-')),database=join(dir,'synthetic.sqlite');let time=Date.now(),app,port,owner;if(!setup){const store=new Store(database,seeds);owner=await bootstrapOwner(store,{name:'Synthetic Owner',username:'synthetic_owner',password});store.run('UPDATE rooms SET public=0 WHERE id=?','private');store.close();}const config=readRuntimeConfig(env(database,mode,setup));const start=async()=>{app=createGameServer({database,seeds,runtimeConfig:config,clock:()=>time,publicResidentChatProvider:provider,...(proximity?{proximityMembershipConfig:proximityFixture,proximityTextConfig:{enabled:true}}:{})});port=(await app.listen(0)).port;};await start();t.after(async()=>{await app?.close();await rm(dir,{recursive:true,force:true});});return{get app(){return app;},get port(){return port;},owner,config,database,call:(path,options)=>request(port,path,options),advance:ms=>time+=ms,restart:async()=>{await app.close();app=null;await start();}};}
async function guest(f){const r=await f.call('/api/session',{method:'POST',body:{}});assert.equal(r.status,201,r.text);assert.equal(r.data.user.ephemeralGuest,true);assert.equal(r.data.user.account,false);return{...r,user:r.data.user};}
const as=(f,cookie)=>(path,method='GET',body)=>f.call(path,{method,body,cookie});
function unprivileged(f,id){for(const table of['universes','worlds','rooms'])assert.equal(f.app.store.get(`SELECT COUNT(*) n FROM ${table} WHERE owner_id=?`,id).n,0);for(const table of['members','world_members','accounts','users','sessions'])assert.equal(f.app.store.get(`SELECT COUNT(*) n FROM ${table} WHERE ${table==='users'?'id':'user_id'}=?`,id).n,0);}
const movement=(roomId,a,extra={})=>({roomId,admissionId:a.admissionId,admissionEpoch:a.admissionEpoch,admissionRevision:a.admissionRevision,x:a.x,z:a.z,y:0,grounded:true,verticalVelocity:0,moving:false,...extra});
async function owner(f){return f.call('/api/login',{method:'POST',body:{username:'synthetic_owner',password}});}

const reply=text=>({choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}]});
async function setupChat(t,{handler,enabled=true}={}){
 const requests=[],provider=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));res.setHeader('content-type','application/json');if(handler)return handler(req,res,requests);res.end(JSON.stringify(reply('A synthetic local reply.')));});
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));t.after(()=>{provider.closeAllConnections();provider.close();});
 const f=await fixture(t,{provider:enabled?{endpoint:`http://127.0.0.1:${provider.address().port}/v1/chat/completions`,model:'synthetic',timeoutMs:1500}:undefined}),signed=await owner(f),o=as(f,signed.cookie);await o('/api/rooms/commons/join','POST',{});
 const created=await o('/api/rooms/commons/bots','POST',{clientOperationId:'make-public-resident',config:{name:'Local guide',spawn:{x:0,z:6},responseRadius:4,privateInstructions:'MANAGER_ONLY_PRIVATE_927_SENTINEL'}});assert.equal(created.status,201,created.text);
 const g=await guest(f),call=as(f,g.cookie),joined=await call('/api/rooms/commons/join','POST',{});assert.equal(joined.status,200,joined.text);
 const path=`/api/rooms/commons/bots/${created.data.bot.id}/chat`;
 return{...f,app:f.app,requests,o,g,call,joined,path,bot:created.data.bot,post:(message='Hello',requestId=randomUUID(),extra={})=>call(path,'POST',{message,requestId,...extra})};
}
test('A guest gets an actual local-provider text reply; replay makes no second call and writes no guest identity/history',async t=>{
 const f=await setupChat(t),counts=()=>f.app.store.all("SELECT name FROM sqlite_master WHERE type='table'").map(({name})=>[name,f.app.store.get(`SELECT COUNT(*) n FROM "${name}"`).n]),before=counts();
 const capability=await f.call(f.path);assert.equal(capability.data.available,true);assert.equal(capability.data.voice,false);assert.equal(JSON.stringify(capability.data).includes('MANAGER_ONLY'),false);
 const id=randomUUID(),result=await f.post('Hello',id);assert.equal(result.status,200,result.text);assert.equal(result.data.text,'A synthetic local reply.');assert.equal(result.data.voice,false);assert.equal(f.requests.length,1);assert.equal(f.requests[0].tools,undefined);assert.equal(JSON.stringify(f.requests).includes('MANAGER_ONLY'),false);
 assert.equal((await f.post('Hello',id)).data.duplicate,true);assert.equal(f.requests.length,1);assert.equal((await f.post('Changed',id)).status,409);
 assert.equal((await f.post('Proxy',randomUUID(),{endpoint:'https://example.test'})).status,400);assert.equal(f.requests.length,1);
 assert.equal((await f.call(f.path.replace('/chat','/turns'),'POST',{message:'Tool'})).data.code,'GUEST_ACCOUNT_REQUIRED');assert.deepEqual(counts(),before);unprivileged(f,f.g.user.id);
});
test('Provider-free resident honestly reports unavailable, and range/auth boundaries hold',async t=>{
 const f=await setupChat(t,{enabled:false});assert.equal((await f.call(f.path)).data.available,false);assert.equal((await f.post()).status,503);assert.equal(f.requests.length,0);
 const a=f.joined.data.arrival;assert.equal((await f.call('/api/presence','POST',movement('commons',a,{x:10,z:-8}))).status,200);assert.equal((await f.call(f.path)).data.code,'BOT_OUT_OF_RANGE');
 assert.equal((await f.call('/api/rooms/private/join','POST',{})).status,404);
});
test('Player chat never exposes private instructions or permits provider tool output',async t=>{
 const f=await setupChat(t,{handler:(_req,res)=>res.end(JSON.stringify(reply('MANAGER_ONLY_PRIVATE_927_SENTINEL')))});const result=await f.post();assert.equal(result.status,502);assert.equal(JSON.stringify(result.data).includes('MANAGER_ONLY'),false);
});
test('Leaving during a provider reply revokes the reply and rejoining cannot reuse its visit',async t=>{
 let entered;const started=new Promise(r=>entered=r);let respond;
 const f=await setupChat(t,{handler:(_req,res)=>{respond=()=>res.end(JSON.stringify(reply('Late reply')));entered();}});
 const pending=f.post();await started;await f.call('/api/rooms/commons/leave','POST',{});respond();const result=await pending;assert([401,403,409,502].includes(result.status));assert.equal(JSON.stringify(result.data).includes('Late reply'),false);
 await f.call('/api/rooms/commons/join','POST',{});assert.equal((await f.call(f.path)).status,200);
});
test('Public bot replies enforce six per minute without resetting on request IDs',async t=>{
 const f=await setupChat(t);for(let i=0;i<6;i++)assert.equal((await f.post('Hi '+i)).status,200);assert.equal((await f.post('Seventh')).status,429);assert.equal(f.requests.length,6);
});
test('Provider tool calls cannot reach resident movement tools',async t=>{
 const f=await setupChat(t,{handler:(_req,res)=>res.end(JSON.stringify({choices:[{index:0,message:{role:'assistant',content:null,tool_calls:[{id:'attempt',type:'function',function:{name:'pause',arguments:'{}'}}]},finish_reason:'tool_calls'}]}))});
 const before=f.app.store.get('SELECT COUNT(*) n FROM bot_operations').n;assert.equal((await f.post()).status,502);assert.equal(f.app.store.get('SELECT COUNT(*) n FROM bot_operations').n,before);
});
test('A mute/unmute edge retires the pending reply even when permission returns',async t=>{
 let entered,respond;const started=new Promise(r=>entered=r);
 const f=await setupChat(t,{handler:(_req,res)=>{respond=()=>res.end(JSON.stringify(reply('Must not return after mute')));entered();}});
 const pending=f.post();await started;assert.equal((await f.o('/api/rooms/commons/moderate','POST',{userId:f.g.user.id,action:'mute'})).status,200);await f.o('/api/rooms/commons/moderate','POST',{userId:f.g.user.id,action:'unmute'});respond();const result=await pending;assert.equal(result.status,502);assert.equal(JSON.stringify(result.data).includes('Must not return'),false);
});
test('Disabling a bot during a pending reply revokes it before delivery',async t=>{
 let entered,respond;const started=new Promise(r=>entered=r);
 const f=await setupChat(t,{handler:(_req,res)=>{respond=()=>res.end(JSON.stringify(reply('Disabled reply')));entered();}});
 const pending=f.post();await started;const changed=await f.o(f.path.replace('/chat',''),'PATCH',{clientOperationId:'disable-pending',revision:f.bot.revision,patch:{respondToPlayers:false}});assert.equal(changed.status,200,changed.text);respond();const result=await pending;assert([403,409,502].includes(result.status));assert.equal(JSON.stringify(result.data).includes('Disabled reply'),false);
});
