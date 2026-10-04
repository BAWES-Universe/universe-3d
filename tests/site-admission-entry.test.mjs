import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {bootstrapOwner} from '../server/operator-accounts.mjs';
import {seedWorlds} from '../src/worlds.js';

const listenProbe='data:text/javascript,'+encodeURIComponent(`import{Server}from'node:net';const original=Server.prototype.listen;Server.prototype.listen=function(...args){process.send?.({type:'test-listen-attempt'});return Reflect.apply(original,this,args);};`);
async function setup(t){const dir=await mkdtemp(join(tmpdir(),'site-admission-entry-'));t.after(()=>rm(dir,{recursive:true,force:true}));return join(dir,'fixture.sqlite');}
function child(t,database,env={}){
 const processChild=fork(new URL('../server.mjs',import.meta.url),[],{cwd:new URL('..',import.meta.url),execArgv:['--import',listenProbe],env:{PORT:'0',UNIVERSE_DB:database,...env},stdio:['ignore','pipe','pipe','ipc']});
 let output='';const messages=[];processChild.stdout.on('data',x=>output+=x);processChild.stderr.on('data',x=>output+=x);
 const exited=new Promise((resolve,reject)=>{processChild.once('error',reject);processChild.once('exit',(code,signal)=>resolve({code,signal}));});
 const ready=new Promise((resolve,reject)=>{processChild.on('message',message=>{messages.push(message);if(message.type==='ready')resolve(message);});exited.then(({code})=>reject(Error(`entry exited ${code}: ${output}`)),reject);});ready.catch(()=>{});
 t.after(async()=>{if(processChild.exitCode===null&&processChild.signalCode===null)processChild.kill('SIGTERM');await exited;});
 return{ready,exited,messages,output:()=>output};
}
test('process entry parses opt-in and nonsecret bounds; no ambient factory dependency is needed',async t=>{
 const database=await setup(t),store=new Store(database,seedWorlds);await bootstrapOwner(store,{name:'Synthetic process owner',username:'process_owner',password:'synthetic process owner password only'});store.close();
 const running=child(t,database,{UNIVERSE_REGISTRATION_MODE:'invite-only',UNIVERSE_SITE_INVITE_TTL_MS:'7200000',UNIVERSE_SITE_MAX_ACTIVE_INVITES:'7',UNIVERSE_SITE_MAX_ACCOUNTS:'9'}),{port}=await running.ready;
 const response=await fetch(`http://127.0.0.1:${port}/api/access`);assert.equal(response.status,200);const policy=await response.json();assert.equal(policy.inviteRegistration,true);assert.equal(policy.guestCreation,false);assert.equal(policy.registration,false);assert.equal(policy.siteAdmission.inviteTtlMs,7200000);assert.equal(policy.siteAdmission.maxActiveInvites,7);assert.equal(policy.siteAdmission.maxAccounts,9);
 const guest=await fetch(`http://127.0.0.1:${port}/api/session`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'No guest claim'})});assert.equal(guest.status,403);assert.equal((await guest.json()).code,'GUEST_CREATION_DISABLED');
});
for(const env of [
 {UNIVERSE_REGISTRATION_MODE:'open-public'},
 {UNIVERSE_REGISTRATION_MODE:'invite-only',UNIVERSE_SITE_MAX_ACCOUNTS:'0'},
 {UNIVERSE_REGISTRATION_MODE:'invite-only',UNIVERSE_SITE_INVITE_TTL_MS:'NaN'},
 {UNIVERSE_SITE_ADMISSION_ENABLED:'true'},
])test(`invalid admission configuration fails before any listening attempt: ${Object.keys(env).join(',')}`,async t=>{
 const database=await setup(t),running=child(t,database,env);assert.notEqual((await running.exited).code,0);assert.equal(running.messages.some(m=>m.type==='test-listen-attempt'),false);
});
test('public invite-only still refuses missing offline owner before listening',async t=>{
 const database=await setup(t),running=child(t,database,{UNIVERSE_MODE:'public',UNIVERSE_REGISTRATION_MODE:'invite-only',UNIVERSE_BIND_ADDRESS:'127.0.0.1',PORT:'4190',UNIVERSE_ALLOWED_HOSTS:'preview.example.test',UNIVERSE_ALLOWED_ORIGINS:'https://preview.example.test',UNIVERSE_TLS_MODE:'external',UNIVERSE_COOKIE_SECURE:'always'});
 assert.notEqual((await running.exited).code,0);assert.equal(running.messages.some(m=>m.type==='test-listen-attempt'),false);assert.match(running.output(),/offline operator-owned account/);
});
