/** Real HTTP/SQLite + native other-site clicks, signup and room entry.
 * Public authority stays active. Only its configured Origin is loopback HTTP
 * in this isolated fixture; production config continues to require HTTPS.
 * No request interception, certificate bypass or synthetic browser headers.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Store} from '../server/store.mjs';
import {bootstrapOwner} from '../server/operator-accounts.mjs';
import {createGameServer} from '../server/app.mjs';
import {readRuntimeConfig} from '../server/runtime-config.mjs';
import {launch} from '../scripts/browser.mjs';
const out=process.env.UNIVERSE_SHARED_ENTRY_EVIDENCE||'evidence/shared-entry-browser';await mkdir(out,{recursive:true});
const dist=resolve('dist'),folder=await mkdtemp(join(tmpdir(),'universe-shared-entry-')),database=join(folder,'synthetic.sqlite'),password='synthetic shared entry password';
const scene={version:1,theme:'garden',bounds:{width:24,depth:22},spawn:{x:0,z:6},areas:[{id:'welcome',name:'Welcome point',x:5,z:0,width:2,depth:2,action:'welcome',start:{key:'welcome'}}],objects:[]};
const seeds=[{id:'universe',name:'Synthetic Universe',rooms:['commons','studio','private'].map(id=>({id,name:id==='studio'?'Friend Studio':id==='private'?'Private Studio':'Commons',scene:structuredClone(scene)}))}];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function snapshot(){return{head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(),trackedChanges:execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim(),diffSha256:hash(execFileSync('git',['diff','HEAD'])),guardSha256:hash(await readFile('server/runtime-config.mjs')),bundleSha256:hash(await readFile(join(dist,'main.js'))),signupSha256:hash(await readFile(join(dist,'signup.js')))};}
const sourceBefore=await snapshot(),checks=[],wire=[],errors=[];let browser,context,page,app,driver,base,driverBase;
const pass=name=>{checks.push({name,status:'passed'});console.log('PASS',name);};
async function freePort(){const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function fresh(mobile=false){await context?.close();context=await browser.newContext({viewport:mobile?{width:320,height:700}:{width:1280,height:900},hasTouch:mobile,isMobile:mobile,reducedMotion:'reduce'});page=await context.newPage();page.setDefaultTimeout(45000);page.on('pageerror',e=>errors.push(e.message));}
const readJson=async response=>{try{return await response.json();}catch{return null;}};
async function link(target,mobile=false){await page.goto(driverBase+'/?target='+encodeURIComponent(target),{waitUntil:'domcontentloaded'});const start=wire.length;const [response]=await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),mobile?page.locator('#shared').tap():page.locator('#shared').click()]);const request=wire.slice(start).find(r=>r.path===target&&r.headers['sec-fetch-dest']==='document');assert(request,'Server observed native target document');assert.equal(request.headers['sec-fetch-site'],'cross-site');assert.equal(request.headers['sec-fetch-mode'],'navigate');assert.equal(request.headers['sec-fetch-user'],'?1');assert.equal(request.headers.origin,undefined);return{response,request};}
async function signup(email,mobile=false){await page.locator('#open-signup').waitFor();if(mobile)await page.locator('#open-signup').tap();else await page.locator('#open-signup').press('Enter');await page.locator('#signup-view').waitFor();await page.locator('#signup-name').fill('Synthetic shared-link friend');await page.locator('#signup-email').fill(email);await page.locator('#signup-password').fill(password);await page.locator('#signup-confirm').fill(password);if(mobile)await page.locator('#signup-submit').tap();else await page.locator('#signup-confirm').press('Enter');}
async function ready(room){await page.waitForFunction(room=>window.__universe?.getState().ready&&window.__universe.getState().room?.id===room,room);return page.evaluate(()=>__universe.getState());}
function assertOrdinary(id){for(const table of['universes','worlds','rooms'])assert.equal(app.store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id=?`,id).n,0);assert.equal(app.store.get('SELECT COUNT(*) AS n FROM world_members WHERE user_id=?',id).n,0);assert.equal(app.store.get('SELECT COUNT(*) AS n FROM members WHERE user_id=? AND granted=1',id).n,0);}
try{
 const store=new Store(database,seeds);await bootstrapOwner(store,{name:'Synthetic owner',username:'synthetic_owner',password});store.run('UPDATE rooms SET public=0 WHERE id=?','private');store.close();
 const port=await freePort();base=`http://127.0.0.1:${port}`;
 const productionConfig=readRuntimeConfig({UNIVERSE_MODE:'public',UNIVERSE_BIND_ADDRESS:'127.0.0.1',PORT:String(port),UNIVERSE_DB:database,UNIVERSE_ALLOWED_HOSTS:`127.0.0.1:${port}`,UNIVERSE_ALLOWED_ORIGINS:`https://127.0.0.1:${port}`,UNIVERSE_TLS_MODE:'external',UNIVERSE_COOKIE_SECURE:'always',UNIVERSE_REGISTRATION_MODE:'open'});
 // The sole test-fixture override enables native HTTP Origin on loopback.
 // The guard, public access gate, Secure cookies and real APIs are unmodified.
 const runtimeConfig=Object.freeze({...productionConfig,allowedOrigins:Object.freeze([base])});
 app=createGameServer({database,seeds,dist,runtimeConfig});await app.listen(port);
 app.server.on('request',(req,res)=>{const row={method:req.method,path:req.url,headers:Object.fromEntries(['host','origin','referer','sec-fetch-site','sec-fetch-mode','sec-fetch-dest','sec-fetch-user'].filter(key=>req.headers[key]!==undefined).map(key=>[key,req.headers[key]])),cookiePresent:!!req.headers.cookie};wire.push(row);res.on('finish',()=>row.status=res.statusCode);});
 driver=http.createServer((req,res)=>{const target=new URL(req.url,'http://localhost').searchParams.get('target')||'/';const escaped=(base+target).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><h1>A friend shared a place</h1><a id="shared" href="${escaped}">Open shared Universe</a>${req.url==='/resources'?`<iframe src="${base}/"></iframe><img src="${base}/signup.js"><script src="${base}/signup.js"></script>`:''}${req.url==='/automatic'?`<script>setTimeout(()=>location.href=${JSON.stringify(base+'/')},250)</script>`:''}<form method="post" action="${base}/api/signup"><button id="post">Cross-site form</button></form>`);});await new Promise(resolve=>driver.listen(0,'127.0.0.1',resolve));driverBase=`http://localhost:${driver.address().port}`;browser=await launch();
 for(const mobile of[false,true])for(const named of[false,true]){
  await fresh(mobile);const target=named?'/?room=studio&entry=welcome':'/',room=named?'studio':'commons',email=`${mobile?'touch':'desktop'}-${named?'named':'root'}@example.test`,start=wire.length;
  const {response,request}=await link(target,mobile);assert.equal(response.status(),200,`External ${target} must reach the real shell`);assert.equal(request.cookiePresent,false);await signup(email,mobile);const state=await ready(room);assertOrdinary(state.user.id);assert.equal(state.user.id,app.store.get('SELECT user_id FROM accounts WHERE email=?',email).user_id);
  if(named){assert.equal(state.destination.entry,'welcome');assert(state.position.x>4,'Requested named arrival selected');}
  const mutations=wire.slice(start).filter(r=>r.method==='POST');assert.equal(mutations.filter(r=>r.path==='/api/signup').length,1);assert.equal(mutations.filter(r=>r.path==='/api/login').length,1);assert.equal(mutations.some(r=>r.path==='/api/session'),false);for(const mutation of mutations){assert.equal(mutation.headers.origin,base);assert.equal(mutation.headers['sec-fetch-site'],'same-origin');}
  const session=(await context.cookies()).find(cookie=>cookie.name==='universe_session');assert(session);assert.equal(session.httpOnly,true);assert.equal(session.secure,true);assert.equal(session.sameSite,'Strict');
  await page.screenshot({path:out+`/${mobile?'touch':'desktop'}-${named?'named-arrival':'root'}-entered.png`});
  if(!mobile&&named){const prior=state.user.id;await page.reload();assert.equal((await ready(room)).user.id,prior);const again=await link(target);assert.equal(again.response.status(),200);assert.equal((await ready(room)).user.id,prior);assert.equal(again.request.cookiePresent,false,'Strict session is absent from cross-site entry request');assert.equal(await page.evaluate(async()=> (await fetch('/api/rooms/private',{credentials:'same-origin'})).status),404);}
  pass(`${mobile?'Touch 320px':'Desktop'} external ${named?'named room':'root'} link → fresh signup → existing login → intended room; no privilege grants`);
 }
 await fresh(true);assert.equal((await link('/?room=private&entry=welcome',true)).response.status(),200);await signup('private-link@example.test',true);await page.locator('#places').waitFor();assert.equal(await page.evaluate(()=>__universe.getState().ready),false);const privateIdentity=app.store.get('SELECT user_id FROM accounts WHERE email=?','private-link@example.test').user_id;assertOrdinary(privateIdentity);assert.equal(await page.evaluate(async()=> (await fetch('/api/rooms/private',{credentials:'same-origin'})).status),404);pass('External private-room link reaches signup but never grants room access');
 await fresh();for(const target of['/index.html','/index.html?room=studio&entry=welcome']){const {response}=await link(target);assert.equal(response.status(),200);await page.locator('#open-signup').waitFor();}pass('Explicit canonical index and named destination aliases load the real shell');
 for(const target of['/?room=a&room=b','/?room=a&entry=b&entry=c','/?room=a&unknown=b','/?room=a&invite=token','/?entry=welcome','/?room=','/?room=a&entry=Upper','/%69ndex.html','/signup.html?room=studio','/api/session','/signup.js']){const {response}=await link(target);assert.equal(response.status(),403,target);assert.equal((await readJson(response)).code,'ORIGIN_REJECTED');}pass('Native negative links reject duplicate/malformed/unknown/capability queries, encoded aliases, signup queries, API and resource documents');
 let start=wire.length;await page.goto(driverBase+'/resources',{waitUntil:'load'});const resources=wire.slice(start).filter(r=>['iframe','image','script'].includes(r.headers['sec-fetch-dest']));assert.equal(resources.length,3);resources.forEach(r=>assert.equal(r.status,403));
 await page.goto(driverBase+'/',{waitUntil:'domcontentloaded'});start=wire.length;await page.evaluate(async url=>{try{await fetch(url);}catch{}},base+'/api/session');assert.equal(wire.slice(start).find(r=>r.path==='/api/session').status,403);
 const [post]=await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),page.locator('#post').click()]);assert.equal(post.status(),403);
 await fresh();const automatic=page.waitForResponse(response=>response.url()===base+'/');start=wire.length;await page.goto(driverBase+'/automatic',{waitUntil:'domcontentloaded'});assert.equal((await automatic).status(),403);assert.equal(wire.slice(start).find(r=>r.path==='/').headers['sec-fetch-user'],undefined);pass('Native frame/resource/fetch/form and unactivated navigation boundaries remain rejected');
 assert.deepEqual(errors,[]);
}catch(error){process.exitCode=1;checks.push({status:'failed',error:error.stack});console.error(error);await page?.screenshot({path:out+'/failure.png',fullPage:true}).catch(()=>{});}
finally{
 await context?.close();await browser?.close();await new Promise(resolve=>driver?driver.close(resolve):resolve());await app?.close();const sourceAfter=await snapshot();if(JSON.stringify(sourceBefore)!==JSON.stringify(sourceAfter)){process.exitCode=1;checks.push({status:'failed',error:'Source or build changed during native test'});}
 await writeFile(out+'/results.json',JSON.stringify({checks,errors,sourceBefore,sourceAfter,wire,fixture:{base,driverBase,mode:'public',registrationMode:'open',setupOnly:false,override:'allowedOrigins=[actual loopback HTTP origin]; production readRuntimeConfig HTTPS validation untouched',cookieSecure:'always'},limits:['Synthetic SQLite and native Chromium on loopback HTTP only','Public-mode guard and all auth/access APIs real; only test fixture Origin matches loopback HTTP','No request interception, certificate warning bypass, browser trust change, hosted TLS or physical-device certification']},null,2));await rm(folder,{recursive:true,force:true});
}
