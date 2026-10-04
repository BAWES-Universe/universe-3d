import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGameServer} from '../server/app.mjs';
import {Store} from '../server/store.mjs';
import {bootstrapOwner} from '../server/operator-accounts.mjs';
import {readRuntimeConfig} from '../server/runtime-config.mjs';
import {seedWorlds} from '../src/worlds.js';
import {makePng} from '../fixtures/png-fixtures.mjs';

const ownerInput={name:'Synthetic admission owner',username:'admission_owner',password:'synthetic admission owner password only'};
const operation=()=>randomBytes(32).toString('base64url');
const envFor=(database,mode='invite-only')=>({UNIVERSE_MODE:'public',UNIVERSE_BIND_ADDRESS:'127.0.0.1',PORT:'4190',UNIVERSE_DB:database,UNIVERSE_ALLOWED_HOSTS:'preview.example.test',UNIVERSE_ALLOWED_ORIGINS:'https://preview.example.test',UNIVERSE_TLS_MODE:'external',UNIVERSE_COOKIE_SECURE:'always',UNIVERSE_REGISTRATION_MODE:mode});
function request(port,path,{method='GET',body,cookie,headers={},raw}={}){
 return new Promise((resolve,reject)=>{
  const bytes=raw??(body===undefined?undefined:JSON.stringify(body));
  const requestHeaders={Host:'preview.example.test',...(bytes===undefined?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(bytes)}),...(method==='GET'?{}:{Origin:'https://preview.example.test'}),...(cookie?{Cookie:cookie}:{}),...headers};
  for(const key of Object.keys(requestHeaders))if(requestHeaders[key]===undefined)delete requestHeaders[key];
  const req=http.request({hostname:'127.0.0.1',port,path,method,headers:requestHeaders},res=>{
   const chunks=[];res.on('data',part=>chunks.push(part));res.on('end',()=>{const bytes=Buffer.concat(chunks),text=bytes.toString('utf8');let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,data,text,bytes});});res.on('error',reject);
  });req.on('error',reject);req.end(bytes);
 });
}
async function fixture(t,mode='invite-only',siteAdmissionConfig){
 const directory=await mkdtemp(join(tmpdir(),'universe-admission-http-')),database=join(directory,'game.sqlite'),dist=join(directory,'dist');
 await mkdir(dist);await writeFile(join(dist,'join.html'),'<!doctype html><title>Invitation</title><main>Non-consuming landing</main>');
 const store=new Store(database,seedWorlds);const owner=await bootstrapOwner(store,ownerInput);store.close();
 const config=readRuntimeConfig(envFor(database,mode));let app=createGameServer({database,seeds:seedWorlds,runtimeConfig:config,dist,siteAdmissionConfig});let port=(await app.listen(0)).port;
 const f={get app(){return app;},owner,database,call:(path,options)=>request(port,path,options),async restart(){await app.close();app=createGameServer({database,seeds:seedWorlds,runtimeConfig:config,dist,siteAdmissionConfig});port=(await app.listen(0)).port;}};
 t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});return f;
}
async function login(f,input){const r=await f.call('/api/login',{method:'POST',body:input});assert.equal(r.status,200,r.text);assert.match(r.headers['set-cookie'][0],/; Secure/);return{user:r.data.user,cookie:r.headers['set-cookie'][0].split(';')[0]};}
async function mint(f,cookie){const r=await f.call('/api/site-invites',{method:'POST',cookie,body:{clientOperationId:operation(),label:'Synthetic friend'}});assert.equal(r.status,201,r.text);return r.data;}

test('public invite-only keeps bootstrap, guest, legacy registration, request security and private page boundaries',async t=>{
 const f=await fixture(t),owner=await login(f,ownerInput);
 const policy=await f.call('/api/access');assert.equal(policy.data.inviteRegistration,true);assert.equal(policy.data.guestCreation,false);assert.equal(policy.data.registration,false);assert.equal(policy.data.siteAdmission.canManage,false);
 assert.equal((await f.call('/api/access',{cookie:owner.cookie})).data.siteAdmission.canManage,true);
 for(const path of ['/api/session','/api/account']){const r=await f.call(path,{method:'POST',cookie:owner.cookie,body:{name:'No implicit account'}});if(path==='/api/account')assert.equal(r.data.code,'REGISTRATION_DISABLED');else assert.equal(r.data.user.id,owner.user.id);}
 assert.equal((await f.call('/api/session',{method:'POST',body:{name:'No guest'}})).data.code,'GUEST_CREATION_DISABLED');
 const minted=await mint(f,owner.cookie),token=minted.token;assert.match(token,/^[A-Za-z0-9_-]{43}$/);
 for(const headers of [{Host:'evil.test','X-Forwarded-Host':'preview.example.test'},{Origin:'https://evil.test'},{Origin:'https://preview.example.test.evil.test'},{Origin:undefined},{'Sec-Fetch-Site':'cross-site'}]){
  const r=await f.call('/api/site-admission/check',{method:'POST',body:{token},headers});assert.equal(r.status,403,r.text);
 }
 const external={'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document','Sec-Fetch-User':'?1'};
 const page=await f.call('/join.html',{headers:external});assert.equal(page.status,200);assert.equal(page.headers['cache-control'],'no-store');assert.equal(page.headers['referrer-policy'],'no-referrer');assert.match(page.headers['content-security-policy'],/default-src 'none'/);assert.equal(page.headers['set-cookie'],undefined);
 for(const path of ['/','/api/access','/api/site-admission/check','/join.html?invite=not-a-token'])assert.equal((await f.call(path,{headers:external})).status,403);
 assert.equal((await f.call('/join.html',{headers:{...external,'Sec-Fetch-Dest':'iframe'}})).status,403);
 const check=await f.call('/api/site-admission/check',{method:'POST',body:{token}});assert.equal(check.status,200,check.text);
 const forbidden=await f.call('/api/site-admission/check',{method:'POST',raw:JSON.stringify({token}),headers:{'Content-Type':'text/plain'}});assert.equal(forbidden.status,415);
 for(const r of [policy,check])assert.equal(r.text.includes(token),false);
});

test('default disabled cannot admit accounts or expose owner management and factory ignores ambient opt-in',async t=>{
 const f=await fixture(t,'disabled'),owner=await login(f,ownerInput);
 assert.equal((await f.call('/api/access',{cookie:owner.cookie})).data.inviteRegistration,false);
 for(const path of ['/api/site-invites','/api/site-admission/check','/api/site-admission/redeem'])assert.notEqual((await f.call(path,{method:'POST',cookie:owner.cookie,body:{clientOperationId:operation(),token:'x'.repeat(43)}})).status,201);
 assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM accounts').n,1);
 const previous=process.env.UNIVERSE_REGISTRATION_MODE;let local;
 try{process.env.UNIVERSE_REGISTRATION_MODE='invite-only';local=createGameServer({seeds:seedWorlds});}finally{if(previous===undefined)delete process.env.UNIVERSE_REGISTRATION_MODE;else process.env.UNIVERSE_REGISTRATION_MODE=previous;}
 t.after(()=>local.close());const{port}=await local.listen(0);const r=await request(port,'/api/access',{headers:{Host:`127.0.0.1:${port}`}});assert.equal(r.data.inviteRegistration,false);assert.equal(r.data.guestCreation,true);
});

test('bounded admission attempts return a safe Retry-After and do not disclose a submitted bearer',async t=>{
 const f=await fixture(t,'invite-only',{enabled:true,checkPerMinute:2}),owner=await login(f,ownerInput),invite=await mint(f,owner.cookie);
 for(let i=0;i<2;i++)assert.equal((await f.call('/api/site-admission/check',{method:'POST',body:{token:invite.token}})).status,200);
 const limited=await f.call('/api/site-admission/check',{method:'POST',body:{token:invite.token}});assert.equal(limited.status,429);assert.equal(limited.headers['retry-after'],'60');assert.equal(limited.text.includes(invite.token),false);
 assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM accounts').n,1);
});

test('two link holders choose passwords, log in normally, retain separate places and receive only explicit world grants across restart',async t=>{
 const f=await fixture(t),owner=await login(f,ownerInput),friends=[];
 for(const username of ['synthetic_friend_a','synthetic_friend_b']){
  const invite=await mint(f,owner.cookie),input={token:invite.token,clientOperationId:operation(),username,name:username,password:`synthetic ${username} password only`};
  const created=await f.call('/api/site-admission/redeem',{method:'POST',body:input});assert.equal(created.status,201,created.text);assert.equal(created.headers['set-cookie'],undefined);assert.equal(created.data.loginRequired,true);
  const retry=await f.call('/api/site-admission/redeem',{method:'POST',body:input});assert.equal(retry.status,200,retry.text);assert.equal(retry.headers['set-cookie'],undefined);assert.equal(retry.data.duplicate,true);
  const account=await login(f,input);friends.push({...account,input,invite});
  assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM world_members WHERE user_id=?',account.user.id).n,0);assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM members WHERE user_id=?',account.user.id).n,0);
  assert.equal((await f.call('/api/site-invites',{cookie:account.cookie})).status,403);
 }
 const[a,b]=friends;
 async function createPlace(friend){
  const call=(path,body)=>f.call(path,{method:'POST',cookie:friend.cookie,body});
  const u=await call('/api/universes',{name:friend.user.name,public:false});assert.equal(u.status,201,u.text);
  const w=await call('/api/worlds',{universeId:u.data.universe.id,name:'Private world',public:false});assert.equal(w.status,201,w.text);
  const r=await call('/api/rooms',{worldId:w.data.world.id,name:'Private room',public:false});assert.equal(r.status,201,r.text);return{universe:u.data.universe,world:w.data.world,room:r.data.room};
 }
 a.place=await createPlace(a);b.place=await createPlace(b);
 assert.equal((await f.call(`/api/rooms/${a.place.room.id}`,{cookie:b.cookie})).status,404);
 // Owning an entire universe still grants no authority over site admission.
 assert.equal((await f.call('/api/site-invites',{method:'POST',cookie:a.cookie,body:{clientOperationId:operation()}})).status,403);
 const invitation=await f.call(`/api/worlds/${a.place.world.id}/invitations`,{method:'POST',cookie:a.cookie,body:{userId:b.user.id,role:'editor',clientOperationId:operation()}});assert.equal(invitation.status,201,invitation.text);
 assert.equal((await f.call(`/api/invitations/${invitation.data.invitation.id}/accept`,{method:'POST',cookie:b.cookie,body:{}})).status,200);
 const joined=await f.call(`/api/rooms/${a.place.room.id}/join`,{method:'POST',cookie:b.cookie,body:{}});assert.equal(joined.status,200,joined.text);assert.equal(joined.data.room.role,'editor');
 const png=makePng(),upload=await f.call(`/api/rooms/${a.place.room.id}/assets`,{method:'POST',cookie:b.cookie,body:{draft:{name:'Friend image'},operationId:operation(),mediaType:'image/png',pngBase64:png.toString('base64')}});assert.equal(upload.status,201,upload.text);
 const assetRef={assetId:upload.data.definition.assetId,versionId:upload.data.version.versionId},imagePath=`/api/rooms/${a.place.room.id}/assets/${assetRef.assetId}/versions/${assetRef.versionId}/image`;
 const scene=structuredClone(joined.data.room.scene);scene.objects.push({id:'friend-authored-chair',type:'chair',x:4,z:4,rotation:0});
 scene.objects.push({id:'friend-image',type:'image',assetRef,x:8,z:4,rotation:0});
 const saved=await f.call(`/api/rooms/${a.place.room.id}/scene`,{method:'PUT',cookie:b.cookie,body:{revision:joined.data.room.revision,scene}});assert.equal(saved.status,200,saved.text);
 await f.restart();const afterA=await login(f,a.input),afterB=await login(f,b.input);
 assert.equal((await f.call(`/api/rooms/${a.place.room.id}`,{cookie:afterB.cookie})).data.room.scene.objects.some(o=>o.id==='friend-authored-chair'),true);
 assert.equal((await f.call(`/api/rooms/${a.place.room.id}/join`,{method:'POST',cookie:afterB.cookie,body:{}})).status,200);
 const restoredImage=await f.call(imagePath,{cookie:afterB.cookie});assert.equal(restoredImage.status,200,restoredImage.text);assert.equal(restoredImage.bytes.equals(png),true,'Committed PNG bytes survive restart');
 assert.equal((await f.call(`/api/rooms/${b.place.room.id}`,{cookie:afterB.cookie})).data.room.ownerId,b.user.id);
 const removed=await f.call(`/api/worlds/${a.place.world.id}/members/${b.user.id}`,{method:'DELETE',cookie:afterA.cookie});assert.equal(removed.status,200,removed.text);
 assert.equal((await f.call(`/api/rooms/${a.place.room.id}`,{cookie:afterB.cookie})).status,404);
 const revokedImage=await f.call(imagePath,{cookie:afterB.cookie});assert.equal(revokedImage.status,401);assert.equal(revokedImage.data.error.code,'IMAGE_SESSION');
 assert.equal((await f.call(`/api/rooms/${b.place.room.id}`,{cookie:afterB.cookie})).status,200);
 assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM accounts').n,3);
});
