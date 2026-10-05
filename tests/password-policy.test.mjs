import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {scryptSync} from 'node:crypto';
import {PASSWORD_MIN_LENGTH,PASSWORD_MAX_LENGTH,validAccountPassword} from '../src/password-policy.js';
import {validateAccountPassword} from '../server/account-identity.mjs';
import {bootstrapOwner,addReviewer} from '../server/operator-accounts.mjs';
import {Store} from '../server/store.mjs';
import {seedWorlds} from '../src/worlds.js';
import {createGameServer} from '../server/app.mjs';
import {readRuntimeConfig} from '../server/runtime-config.mjs';

const minimum='tenletters',maximum='x'.repeat(256);
const invalid=[null,9,'x'.repeat(9),'x'.repeat(257),' '+minimum,minimum+' ',minimum+'\n','ten\tletters','ten\x7fletters'];
test('one 10–256 creation policy rejects controls/outer whitespace and keeps browser hints aligned',async()=>{
 assert.equal(PASSWORD_MIN_LENGTH,10);assert.equal(PASSWORD_MAX_LENGTH,256);
 for(const value of [minimum,maximum,'two useful words']){assert(validAccountPassword(value));assert.equal(validateAccountPassword(value),value);}
 for(const value of invalid){assert.equal(validAccountPassword(value),false);assert.throws(()=>validateAccountPassword(value),e=>e.code==='INVALID_PASSWORD');}
 for(const file of ['public/signup.html','public/join.html']){const source=await readFile(file,'utf8');assert.match(source,new RegExp('minlength="'+PASSWORD_MIN_LENGTH+'"'));assert.match(source,new RegExp(PASSWORD_MIN_LENGTH+'–'+PASSWORD_MAX_LENGTH));assert.doesNotMatch(source,/minlength="16"|16–256/);}
});
test('offline bootstrap and reviewer use the same minimum, maximum and salted hash',async()=>{
 const store=new Store(':memory:',seedWorlds);try{
  await assert.rejects(()=>bootstrapOwner(store,{name:'Synthetic owner',username:'owner',password:'123456789'}),e=>e.code==='INVALID_PASSWORD');
  await bootstrapOwner(store,{name:'Synthetic owner',username:'owner',password:minimum});
  await addReviewer(store,{name:'Synthetic reviewer',username:'reviewer',password:maximum});
  for(const [username,password]of[['owner',minimum],['reviewer',maximum]]){const row=store.get('SELECT * FROM accounts WHERE username=?',username);assert.equal(row.password_hash,scryptSync(password,row.salt,64).toString('hex'));}
  assert.notEqual(store.get('SELECT salt FROM accounts WHERE username=?','owner').salt,store.get('SELECT salt FROM accounts WHERE username=?','reviewer').salt);
 }finally{store.close();}
});
async function appFor(t,env={}){const app=createGameServer({database:':memory:',seeds:seedWorlds,runtimeConfig:readRuntimeConfig(env)});const {port}=await app.listen(0);t.after(()=>app.close());return{app,async call(path,body,cookie){const response=await fetch('http://127.0.0.1:'+port+path,{method:'POST',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(body)});return{status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};}};}
test('legacy local account rejects lossy whitespace, accepts ten characters, then signs in with identifier and username',async t=>{
 const f=await appFor(t),guest=await f.call('/api/session',{name:'Synthetic local'});
 for(const password of invalid.filter(v=>typeof v==='string')){const bad=await f.call('/api/account',{username:'synthetic_local',password},guest.cookie);assert.equal(bad.status,400,JSON.stringify(bad));assert.equal(bad.body.code,'INVALID_PASSWORD');}
 const saved=await f.call('/api/account',{username:'synthetic_local',password:minimum},guest.cookie);assert.equal(saved.status,201);
 for(const key of ['identifier','username'])assert.equal((await f.call('/api/login',{[key]:'synthetic_local',password:minimum})).status,200);
 assert.equal((await f.call('/api/login',{identifier:'synthetic_local',username:'someone_else',password:minimum})).body.code,'INVALID_IDENTIFIER');
});
test('open signup accepts 10 and 256; identifier, email and username email aliases remain compatible',async t=>{
 const f=await appFor(t,{UNIVERSE_REGISTRATION_MODE:'open',UNIVERSE_SETUP_ONLY:'1'});
 for(const [email,password]of[['min@example.test',minimum],['max@example.test',maximum]]){
  const saved=await f.call('/api/signup',{name:'Synthetic boundary',email,password});assert.equal(saved.status,201,JSON.stringify(saved));
  for(const key of ['identifier','email','username']){const login=await f.call('/api/login',{[key]:' '+email.toUpperCase()+' ',password});assert.equal(login.status,200,JSON.stringify(login));}
 }
});
