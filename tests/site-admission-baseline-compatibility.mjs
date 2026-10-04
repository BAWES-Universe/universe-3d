// Run against an independently checked-out, unchanged, approved bc715 baseline:
// node tests/site-admission-baseline-compatibility.mjs /path/to/baseline
// No git fetch, host deployment, image publication or external traffic occurs.
import {createGameServer as current} from '../server/app.mjs';
import {Store} from '../server/store.mjs';
import {bootstrapOwner} from '../server/operator-accounts.mjs';
import {readRuntimeConfig} from '../server/runtime-config.mjs';
import {seedWorlds} from '../src/worlds.js';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import http from 'node:http';

assert(process.argv[2],'Pass the verified baseline checkout directory');
const baselineDirectory=resolve(process.argv[2]);
const baselineSha=execFileSync('git',['-C',baselineDirectory,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.equal(baselineSha,'bc715ff6ccc0c3d2537e4c003cb4a7bb82745a34');
assert.equal(execFileSync('git',['-C',baselineDirectory,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim(),'','Baseline tracked source must be unchanged');
const{createGameServer:baseline}=await import(pathToFileURL(join(baselineDirectory,'server/app.mjs')).href);
const directory=await mkdtemp(join(tmpdir(),'admission-downgrade-')),database=join(directory,'game.sqlite');let app;
const owner={name:'Compatibility owner',username:'compat_owner',password:'synthetic compatibility owner password'};
const friend={name:'Compatibility friend',username:'compat_friend',password:'synthetic compatibility friend password'};
const config=mode=>readRuntimeConfig({UNIVERSE_MODE:'public',UNIVERSE_BIND_ADDRESS:'127.0.0.1',PORT:'4190',UNIVERSE_DB:database,UNIVERSE_ALLOWED_HOSTS:'preview.example.test',UNIVERSE_ALLOWED_ORIGINS:'https://preview.example.test',UNIVERSE_TLS_MODE:'external',UNIVERSE_COOKIE_SECURE:'always',UNIVERSE_REGISTRATION_MODE:mode});
try{
 const store=new Store(database,seedWorlds);await bootstrapOwner(store,owner);store.close();
 app=current({database,seeds:seedWorlds,runtimeConfig:config('invite-only')});let port=(await app.listen(0)).port;
 const call=(path,body,cookie)=>new Promise((resolve,reject)=>{const bytes=body?JSON.stringify(body):undefined;const req=http.request({hostname:'127.0.0.1',port,path,method:body?'POST':'GET',headers:{Host:'preview.example.test',...(body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(bytes),Origin:'https://preview.example.test'}:{}),...(cookie?{Cookie:cookie}:{})}},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>{try{resolve({status:res.statusCode,cookie:res.headers['set-cookie']?.[0]?.split(';')[0],data:JSON.parse(text)});}catch(e){reject(e);}});});req.on('error',reject);req.end(bytes);});
 const logged=await call('/api/login',owner);assert.equal(logged.status,200);
 const op=()=>randomBytes(32).toString('base64url'),invite=await call('/api/site-invites',{clientOperationId:op()},logged.cookie);assert.equal(invite.status,201);
 const account=await call('/api/site-admission/redeem',{...friend,token:invite.data.token,clientOperationId:op()});assert.equal(account.status,201);assert.equal(account.cookie,undefined);
 const rowsBefore=app.store.get('SELECT COUNT(*) n FROM site_admission_invites').n;await app.close();app=null;
 app=baseline({database,seeds:seedWorlds,runtimeConfig:config('disabled')});port=(await app.listen(0)).port;
 const oldLogin=await call('/api/login',friend);assert.equal(oldLogin.status,200);assert.equal(oldLogin.data.user.account,true);
 assert.equal((await call('/api/access')).data.registration,false);
 assert.equal(app.store.get('SELECT COUNT(*) n FROM site_admission_invites').n,rowsBefore);
 assert.equal(app.store.get('SELECT COUNT(*) n FROM world_members WHERE user_id=?',oldLogin.data.user.id).n,0);
 await app.close();app=null;
 app=current({database,seeds:seedWorlds,runtimeConfig:config('invite-only')});port=(await app.listen(0)).port;
 assert.equal((await call('/api/login',friend)).status,200);assert.equal(app.store.get('SELECT COUNT(*) n FROM site_admission_invites WHERE redeemed_at IS NOT NULL').n,1);
 const result={baseline:baselineSha,result:'passed',scope:'Current admission tables and accounts survive old public disabled-mode startup/login and current public reopen; no external image-size changes included',checks:['no signup cookie','old public startup and login','old registration stays disabled','no implicit world membership','invite record retained','current public reopen and login'],hostedRollbackTested:false};
 await mkdir('evidence/site-admission',{recursive:true});await writeFile('evidence/site-admission/baseline-compatibility.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await app?.close();await rm(directory,{recursive:true,force:true});}
