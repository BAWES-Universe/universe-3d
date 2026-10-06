import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readRuntimeConfig,createRequestSecurity} from '../server/runtime-config.mjs';
import {createGameServer} from '../server/app.mjs';
import {Store} from '../server/store.mjs';
import {bootstrapOwner} from '../server/operator-accounts.mjs';
import {seedWorlds} from '../src/worlds.js';
const environment=database=>({UNIVERSE_MODE:'public',UNIVERSE_BIND_ADDRESS:'127.0.0.1',PORT:'4190',UNIVERSE_DB:database,UNIVERSE_ALLOWED_HOSTS:'preview.example.test',UNIVERSE_ALLOWED_ORIGINS:'https://preview.example.test',UNIVERSE_TLS_MODE:'external',UNIVERSE_COOKIE_SECURE:'always',UNIVERSE_REGISTRATION_MODE:'open'});
const navigation={'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document','sec-fetch-user':'?1'};
const allowed=['/','/index.html','/?room=commons','/index.html?room=studio','/?room=studio&entry=welcome','/index.html?room=Room_1-2&entry=arrival_1-2','/?room='+'a'.repeat(80)+'&entry='+'a'.repeat(64)];
const forbidden=['/?','/index.html?','/?entry=welcome','/?room=','/?room=a&entry=','/?room=a&room=b','/?room=a&entry=b&entry=c','/?room=a&other=b','/?room=a&invite=token','/?invite=token','/?email=private@example.test','/?room=a&role=owner','/?room=a&next=https://evil.test','/?room=a&','/?room=a&&entry=b','/?entry=b&room=a','/?%72oom=a','/?room=%61','/?room=a%26entry=b','/?room=a+b','/?room=a/b','/?room=..','/?room='+'a'.repeat(81),'/?room=a&entry='+'a'.repeat(65),'/?room=a&entry=Upper','/?room=a&entry=_a','/?room=a&entry=-a','/?room=a#fragment','/index.html/','//','//index.html','/%69ndex.html','/a/../','/./','/unknown','/signup.html?room=a','/join.html?invite=token','/api/session','/api/signup','/api/rooms/commons','/signup.js','/style.css','/assets/logo.png','http://preview.example.test/','https://preview.example.test/','/\n','/\r','/?room=a\n'];
const config=readRuntimeConfig(environment('/synthetic/shared-entry.sqlite'));
const request=(url,headers={},method='GET')=>({method,url,headers:{host:'preview.example.test',...navigation,...headers},socket:{}});
const rejects=(guard,req,code='ORIGIN_REJECTED')=>assert.throws(()=>guard.assertRequest(req),error=>error.status===403&&error.code===code,`${req.method} ${req.url}`);
test('public open ready shell permits only canonical user-activated root and generated room destinations',()=>{
 const guard=createRequestSecurity(config);for(const url of allowed)assert.doesNotThrow(()=>guard.assertRequest(request(url)),url);
 for(const url of forbidden)rejects(guard,request(url));
});
test('safe document exception never admits methods, APIs, embedding, resource fetches or missing activation',()=>{
 const guard=createRequestSecurity(config);
 for(const url of allowed){for(const method of['HEAD','OPTIONS','POST','PUT','PATCH','DELETE'])rejects(guard,request(url,{origin:'https://preview.example.test'},method));
  for(const dest of['iframe','frame','object','embed','script','style','image','empty',undefined,'Document'])rejects(guard,request(url,{'sec-fetch-dest':dest}));
  for(const mode of['cors','no-cors','same-origin','websocket',undefined,'Navigate'])rejects(guard,request(url,{'sec-fetch-mode':mode}));
  for(const activation of[undefined,'?0','true','1',''])rejects(guard,request(url,{'sec-fetch-user':activation}));
 }
});
test('new shell entry preserves mode, setup, Host, Origin, forwarded and cookie security boundaries',()=>{
 for(const mode of['disabled','invite-only','local-open']){const guard=createRequestSecurity({...config,registrationMode:mode});for(const url of allowed)rejects(guard,request(url));}
 for(const changed of[{mode:'local'},{setupOnly:true}]){const guard=createRequestSecurity({...config,...changed});for(const url of allowed)rejects(guard,request(url));}
 const guard=createRequestSecurity(config);
 for(const url of allowed){for(const host of['evil.test','preview.example.test.evil.test','preview.example.test:4190','preview.example.test.',undefined])rejects(guard,request(url,{host,'x-forwarded-host':'preview.example.test',forwarded:'host=preview.example.test'}),'HOST_REJECTED');
  rejects(guard,{...request(url),rawHeaders:['Host','preview.example.test','Host','preview.example.test']},'HOST_REJECTED');
  for(const origin of['https://evil.test','http://preview.example.test','null','https://preview.example.test/',undefined]){if(origin===undefined)assert.doesNotThrow(()=>guard.assertRequest(request(url)));else rejects(guard,request(url,{origin,'x-forwarded-proto':'https'}));}
  assert.doesNotThrow(()=>guard.assertRequest(request(url,{origin:'https://preview.example.test'})));
  assert.equal(guard.secureCookie(request(url)),true);
 }
 const two=createRequestSecurity({...config,allowedHosts:['preview.example.test','other.example.test'],allowedOrigins:['https://preview.example.test','https://other.example.test']});rejects(two,request('/',{origin:'https://other.example.test'}));
});
test('existing signup/invite, direct and same-origin policy remains intact',()=>{
 const guard=createRequestSecurity(config);guard.assertRequest(request('/signup.html'));
 rejects(guard,request('/join.html'));
 const invite=createRequestSecurity({...config,registrationMode:'invite-only'});invite.assertRequest(request('/join.html'));rejects(invite,request('/signup.html'));
 for(const site of['same-origin','same-site','none',undefined])guard.assertRequest(request('/',{'sec-fetch-site':site}));
 for(const method of['POST','PUT','PATCH','DELETE']){
  const req=request('/api/session',{'sec-fetch-site':'same-origin'},method);rejects(guard,req,'ORIGIN_REQUIRED');guard.assertRequest({...req,headers:{...req.headers,origin:'https://preview.example.test'}});
 }
});
test('actual public HTTP shell entry is static and cannot bypass revalidation, auth, guest or readiness gates',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'shared-entry-security-')),database=join(directory,'db.sqlite'),dist=join(directory,'dist');await mkdir(dist);await writeFile(join(dist,'index.html'),'<!doctype html><title>Public shell fixture</title>');
 const store=new Store(database,seedWorlds);await bootstrapOwner(store,{name:'Synthetic owner',username:'synthetic_owner',password:'synthetic shared entry password'});store.close();
 const app=createGameServer({database,dist,seeds:seedWorlds,runtimeConfig:readRuntimeConfig(environment(database))});const port=(await app.listen(0)).port;t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
 const call=(url,options={})=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:options.port??port,path:url,method:options.method||'GET',headers:{Host:'preview.example.test',...options.headers}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,text,data});});});req.on('error',reject);req.end(options.body);});
 const before=app.store.get('SELECT COUNT(*) AS n FROM accounts').n;
 for(const url of allowed){const response=await call(url,{headers:navigation});assert.equal(response.status,200,url);assert.match(response.text,/Public shell fixture/);assert.equal(response.headers['set-cookie'],undefined);assert.equal(response.headers['cache-control'],'no-cache');assert.equal(response.headers['x-frame-options'],'DENY');assert.match(response.headers['content-security-policy'],/frame-ancestors 'none'/);
  const cached=await call(url,{headers:{...navigation,'If-None-Match':response.headers.etag}});assert.equal(cached.status,304);
  for(const extra of[{'sec-fetch-dest':'iframe'},{'sec-fetch-mode':'cors'},{'sec-fetch-user':'?0'}])assert.equal((await call(url,{headers:{...navigation,...extra,'If-None-Match':response.headers.etag}})).status,403);
 }
 // The existing URL parser rejects raw // before request security (500).
 // Keep that unrelated malformed-request behavior; the guard itself rejects it.
 for(const url of forbidden.filter(url=>!/[\r\n]/.test(url)))assert.equal((await call(url,{headers:navigation})).status,url==='//'?500:403,url);
 assert.equal((await call('/api/session')).data.code,'AUTH_REQUIRED');
 assert.equal((await call('/api/rooms/commons')).status,401);
 assert.equal((await call('/api/session',{method:'POST',headers:{Origin:'https://preview.example.test','Content-Type':'application/json'},body:'{}'})).data.code,'GUEST_CREATION_DISABLED');
 for(const url of['/api/signup','/api/login','/api/rooms/commons/join'])assert.equal((await call(url,{method:'POST',headers:{...navigation,Origin:'https://preview.example.test','Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal(app.store.get('SELECT COUNT(*) AS n FROM accounts').n,before);assert.equal(app.store.get('SELECT COUNT(*) AS n FROM sessions').n,0);
 const setupDb=join(directory,'setup.sqlite'),setup=createGameServer({database:setupDb,dist,seeds:seedWorlds,runtimeConfig:readRuntimeConfig({...environment(setupDb),UNIVERSE_SETUP_ONLY:'1'})});t.after(()=>setup.close());const setupPort=(await setup.listen(0)).port;
 assert.equal((await call('/',{port:setupPort})).status,503);
 assert.equal((await call('/',{port:setupPort,headers:navigation})).status,403);
});
