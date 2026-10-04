import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGameServer} from '../server/app.mjs';
import {Store} from '../server/store.mjs';
import {bootstrapOwner} from '../server/operator-accounts.mjs';
import {readRuntimeConfig} from '../server/runtime-config.mjs';
import {seedWorlds} from '../src/worlds.js';
import {CLIENT_CAPABILITIES_HEADER,IMAGE_PHYSICAL_SIZE_CAPABILITY} from '../src/client-protocol.js';

const owner={name:'Synthetic format owner',username:'format_owner',password:'synthetic format password only'};
const capability={[CLIENT_CAPABILITIES_HEADER]:IMAGE_PHYSICAL_SIZE_CAPABILITY};
const operation=()=>randomBytes(32).toString('base64url');
function request(port,path,{method='GET',body,cookie,headers={}}={}){
 return new Promise((resolve,reject)=>{
  const bytes=body===undefined?undefined:JSON.stringify(body);
  const req=http.request({hostname:'127.0.0.1',port,path,method,headers:{Host:'format.example.test',...(bytes===undefined?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(bytes)}),...(method==='GET'?{}:{Origin:'https://format.example.test'}),...(cookie?{Cookie:cookie}:{}),...headers}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{const text=Buffer.concat(chunks).toString();let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,data,headers:res.headers,text});});
  });req.on('error',reject);req.end(bytes);
 });
}
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'universe-admission-format-')),database=join(directory,'game.sqlite');
 const store=new Store(database,seedWorlds);await bootstrapOwner(store,owner);store.close();
 const runtimeConfig=readRuntimeConfig({UNIVERSE_MODE:'public',UNIVERSE_BIND_ADDRESS:'127.0.0.1',UNIVERSE_DB:database,UNIVERSE_ALLOWED_HOSTS:'format.example.test',UNIVERSE_ALLOWED_ORIGINS:'https://format.example.test',UNIVERSE_TLS_MODE:'external',UNIVERSE_COOKIE_SECURE:'always',UNIVERSE_REGISTRATION_MODE:'invite-only'});
 let app,port;
 const f={get app(){return app;},call:(path,options)=>request(port,path,options),async restart(enabled){if(app)await app.close();app=createGameServer({database,seeds:seedWorlds,runtimeConfig,imagePhysicalSizeEnabled:enabled});port=(await app.listen(0)).port;}};
 await f.restart(true);t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});return f;
}
async function login(f,input=owner){const result=await f.call('/api/login',{method:'POST',body:input});assert.equal(result.status,200,result.text);return {cookie:result.headers['set-cookie'][0].split(';')[0],user:result.data.user};}
async function mint(f,cookie){const result=await f.call('/api/site-invites',{method:'POST',cookie,body:{clientOperationId:operation(),label:'Synthetic format friend'}});assert.equal(result.status,201,result.text);return result.data.token;}

test('capable admission session reads coexist with a required image reader without granting site or place access',async t=>{
 const f=await fixture(t),signedOwner=await login(f);
 const obsolete=await f.call('/api/session',{cookie:signedOwner.cookie});assert.equal(obsolete.status,426);assert.equal(obsolete.data.code,'CLIENT_RELOAD_REQUIRED');
 const current=await f.call('/api/session',{cookie:signedOwner.cookie,headers:capability});assert.equal(current.status,200,current.text);assert.equal(current.data.siteAdmission.canManage,true);assert.equal(current.data.imagePhysicalSize.required,true);
 assert.equal((await f.call('/api/session',{headers:capability})).status,401,'Capability is not authentication');
 const token=await mint(f,signedOwner.cookie),input={token,clientOperationId:operation(),username:'format_friend',name:'Synthetic format friend',password:'synthetic format friend password'};
 assert.equal((await f.call('/api/site-admission/check',{method:'POST',body:{token}})).status,200);
 const redeemed=await f.call('/api/site-admission/redeem',{method:'POST',body:input});assert.equal(redeemed.status,201,redeemed.text);assert.equal(redeemed.headers['set-cookie'],undefined);
 const retry=await f.call('/api/site-admission/redeem',{method:'POST',body:input});assert.equal(retry.status,200);assert.equal(retry.data.duplicate,true);
 const friend=await login(f,input),session=await f.call('/api/session',{cookie:friend.cookie,headers:capability});assert.equal(session.status,200,session.text);assert.equal(session.data.siteAdmission.canManage,false);
 assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM world_members WHERE user_id=?',friend.user.id).n,0);
 assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM members WHERE user_id=?',friend.user.id).n,0);
 assert.equal((await f.call('/api/site-invites',{cookie:friend.cookie,headers:capability})).status,403);
 assert.equal((await f.call('/api/rooms/commons',{cookie:friend.cookie})).status,426,'Admission exemption never spreads to room data');
});

test('admission session capability survives writes-off restart while the persistent reader requirement stays enforced',async t=>{
 const f=await fixture(t),signedOwner=await login(f),token=await mint(f,signedOwner.cookie);
 await f.restart(false);
 const session=await f.call('/api/session',{cookie:signedOwner.cookie,headers:capability});assert.equal(session.status,200,session.text);assert.equal(session.data.siteAdmission.canManage,true);assert.equal(session.data.imagePhysicalSize.enabled,false);assert.equal(session.data.imagePhysicalSize.required,true);
 assert.equal((await f.call('/api/session',{cookie:signedOwner.cookie})).status,426);
 assert.equal((await f.call('/api/site-admission/check',{method:'POST',body:{token}})).status,200);
 assert.deepEqual((await f.call('/api/client-protocol')).data.storageCompatibility,{version:1,requiredReaderCapabilities:[IMAGE_PHYSICAL_SIZE_CAPABILITY]});
});

test('adding a capability declaration cannot weaken Host, Origin, Fetch Metadata or owner-only invite checks',async t=>{
 const f=await fixture(t),signedOwner=await login(f),token=await mint(f,signedOwner.cookie);
 for(const headers of [{Host:'untrusted.example.test'},{Origin:'https://untrusted.example.test'},{'Sec-Fetch-Site':'cross-site'}]){
  const result=await f.call('/api/site-admission/check',{method:'POST',body:{token},headers:{...capability,...headers}});assert.equal(result.status,403,result.text);
 }
 assert.equal((await f.call('/api/site-invites',{method:'POST',headers:capability,body:{clientOperationId:operation()}})).status,401);
 assert.equal((await f.call('/api/session?capabilities=image-physical-size-v1',{cookie:signedOwner.cookie})).status,426,'EventSource query declaration is not an API-wide exception');
});
