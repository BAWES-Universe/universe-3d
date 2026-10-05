import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {scryptSync} from 'node:crypto';
import {validateAccountPassword} from '../server/account-identity.mjs';
import {bootstrapOwner,addReviewer} from '../server/operator-accounts.mjs';
import {Store} from '../server/store.mjs';
import {seedWorlds} from '../src/worlds.js';
import {createGameServer} from '../server/app.mjs';
import {readRuntimeConfig} from '../server/runtime-config.mjs';

// Entirely synthetic inputs, never hosted accounts or tester credentials.
const minimum='tenletters',maximum='x'.repeat(256);
const invalid=[null,9,'x'.repeat(9),'x'.repeat(257),' '+minimum,minimum+' ',minimum+'\n','ten\tletters','ten\x7fletters'];
test('shared creation validator accepts 10–256 and rejects controls/outer whitespace; browser hints agree',async()=>{
 for(const value of [minimum,maximum,'two useful words'])assert.equal(validateAccountPassword(value),value);
 for(const value of invalid)assert.throws(()=>validateAccountPassword(value),e=>e.code==='INVALID_PASSWORD');
 for(let code=0;code<32;code++)assert.throws(()=>validateAccountPassword(minimum+String.fromCharCode(code)),e=>e.code==='INVALID_PASSWORD');
 for(const file of ['public/signup.html','public/join.html']){
  const source=await readFile(file,'utf8');
  for(const id of ['signup-password','signup-confirm'])assert.match(source,new RegExp('id="'+id+'"[^>]*minlength="10" maxlength="256"'));
  assert.match(source,/10–256/);assert.doesNotMatch(source,/minlength="16"|16–256/);
 }
});
function assertHash(store,username,password){const row=store.get('SELECT * FROM accounts WHERE username=?',username);assert.equal(Buffer.from(row.salt,'hex').length,16);assert.equal(Buffer.from(row.password_hash,'hex').length,64);assert.equal(row.password_hash,scryptSync(password,row.salt,64).toString('hex'));return row;}
test('offline owner and reviewer use shared boundaries and preserve salted scrypt',async()=>{
 const store=new Store(':memory:',seedWorlds);try{
  for(const password of invalid)await assert.rejects(()=>bootstrapOwner(store,{name:'Synthetic owner',username:'owner',password}),e=>e.code==='INVALID_PASSWORD');
  await bootstrapOwner(store,{name:'Synthetic owner',username:'owner',password:minimum});
  for(const password of invalid)await assert.rejects(()=>addReviewer(store,{name:'Synthetic reviewer',username:'reviewer',password}),e=>e.code==='INVALID_PASSWORD');
  await addReviewer(store,{name:'Synthetic reviewer',username:'reviewer',password:maximum});
  assert.notEqual(assertHash(store,'owner',minimum).salt,assertHash(store,'reviewer',maximum).salt);
 }finally{store.close();}
});
async function appFor(t,env={}){const app=createGameServer({database:':memory:',seeds:seedWorlds,runtimeConfig:readRuntimeConfig(env)});const {port}=await app.listen(0);t.after(()=>app.close());return{app,async call(path,body,cookie){const response=await fetch('http://127.0.0.1:'+port+path,{method:'POST',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(body)});return{status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};}};}
test('local creation rejects invalid raw values, accepts 10 and 256, and preserves username login',async t=>{
 const f=await appFor(t),guest=await f.call('/api/session',{name:'Synthetic local'});
 for(const password of invalid){const bad=await f.call('/api/account',{username:'synthetic_local',password},guest.cookie);assert.equal(bad.status,400,JSON.stringify(bad));assert.equal(bad.body.code,'INVALID_PASSWORD');}
 for(const [username,password,cookie]of[['synthetic_local',minimum,guest.cookie],['synthetic_max',maximum,(await f.call('/api/session',{name:'Synthetic maximum'})).cookie]]){
  const saved=await f.call('/api/account',{username,password},cookie);assert.equal(saved.status,201,JSON.stringify(saved));assertHash(f.app.store,username,password);
  assert.equal((await f.call('/api/login',{username,password})).status,200);
 }
});
test('open signup accepts 10 and 256, rejects 9/257/control/outer whitespace, and preserves email login',async t=>{
 const f=await appFor(t,{UNIVERSE_REGISTRATION_MODE:'open',UNIVERSE_SETUP_ONLY:'1'});
 for(const password of invalid){const bad=await f.call('/api/signup',{name:'Synthetic invalid',email:'invalid@example.test',password});assert.equal(bad.status,400,JSON.stringify(bad));assert.equal(bad.body.code,'INVALID_PASSWORD');}
 // Invalid attempts retain the real rate limit; use a fresh isolated server for accepted boundaries.
 const accepted=await appFor(t,{UNIVERSE_REGISTRATION_MODE:'open',UNIVERSE_SETUP_ONLY:'1'});
 for(const [email,password]of[['min@example.test',minimum],['max@example.test',maximum]]){
  const saved=await accepted.call('/api/signup',{name:'Synthetic boundary',email,password});assert.equal(saved.status,201,JSON.stringify(saved));
  const row=accepted.app.store.get('SELECT username FROM accounts WHERE email=?',email);assertHash(accepted.app.store,row.username,password);
  for(const body of [{email:' '+email.toUpperCase()+' ',password},{username:row.username,password}])assert.equal((await accepted.call('/api/login',body)).status,200);
 }
});
