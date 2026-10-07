/** Six reduced-MVP checks using real local API/SQLite and synthetic identities.
 * Browser input is native. Local HTTP is not hosted HTTPS or device acceptance. */
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {launch} from '../scripts/browser.mjs';
import {createGameServer} from '../server/app.mjs';
import {readRuntimeConfig} from '../server/runtime-config.mjs';
import {promoteSetupOwner} from '../server/setup-mode.mjs';
import {addReviewer} from '../server/operator-accounts.mjs';
import {seedWorlds} from '../src/worlds.js';

const folder=await mkdtemp(join(tmpdir(),'universe-open-signup-ui-')),database=join(folder,'site.sqlite'),out='evidence/open-signup';
await mkdir(out,{recursive:true});
const password='tenletters',checks=[],errors=[],requests=[],wireRequests=[];
// Ordinary signup now enters WebGL. Unload each verified scene before the next
// browser renders it, keeping session cookies for the later transport checks.
let app,browser,base,alice,bob,phone,game,ownerId,friendId;
const config=setup=>readRuntimeConfig({UNIVERSE_REGISTRATION_MODE:'open',UNIVERSE_SETUP_ONLY:setup?'1':'0'});
async function start(setup){app=createGameServer({database,seeds:seedWorlds,dist:new URL('../dist',import.meta.url).pathname,runtimeConfig:config(setup)});base='http://127.0.0.1:'+(await app.listen(0)).port;app.server.on('request',req=>wireRequests.push({path:req.url,referer:req.headers.referer}));}
async function pageFor(options={}){const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce',...options}),page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>requests.push({path:new URL(request.url()).pathname,url:request.url(),referer:request.headers().referer}));return{context,page};}
async function enter(page){await page.goto(base+'/signup.html',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__universe?.getState().ready||document.querySelector('#loading-view')?.hidden);await page.evaluate(()=>document.fonts.ready);}
async function signup(page,name,email,enterGame=false){await page.getByLabel('What should we call you?').fill(name);await page.getByLabel('Email',{exact:true}).fill(email);await page.locator('#signup-form').getByLabel('Password',{exact:true}).fill(password);await page.getByLabel('Confirm password',{exact:true}).fill(password);await page.getByLabel('Confirm password',{exact:true}).press('Enter');if(enterGame){await page.waitForFunction(()=>window.__universe?.getState().ready);return;}await page.locator('#signin-view').waitFor();assert.equal(await page.locator('#signup-password').inputValue(),'');assert.equal(await page.locator('#signup-confirm').inputValue(),'');}
async function login(page,identifier,enterGame=false){await page.locator('#signin-identifier').fill(identifier);await page.locator('#signin-password').fill(password);await page.locator('#signin-password').press('Enter');if(enterGame){await page.waitForFunction(()=>window.__universe?.getState().ready);return page.evaluate(()=>__universe.getState().user.id);}await page.locator('#account-view').waitFor();return page.locator('#account-id').inputValue();}
const check=async(name,run)=>{await run();checks.push({name,status:'passed'});console.log('PASS',name);};
try{
 await start(true);browser=await launch();alice=await pageFor();bob=await pageFor();
 await check('1. Two independent ordinary signups and separate email logins use the open account cap',async()=>{
  await enter(alice.page);assert.match(await alice.page.locator('.signup-disclosure').textContent(),/not verified.*no password reset.*Save your password/);assert.equal((await (await alice.context.request.get(base+'/api/signup')).json()).maxAccounts,10000);
  await alice.page.getByLabel('What should we call you?').fill('Synthetic Owner Candidate');await alice.page.getByLabel('Email',{exact:true}).fill('Creator+dev@Example.test');await alice.page.locator('#signup-form').getByLabel('Password',{exact:true}).fill(password);await alice.page.getByLabel('Confirm password',{exact:true}).fill(password+' mismatch');await alice.page.getByLabel('Confirm password',{exact:true}).press('Enter');await alice.page.getByText('Your passwords don’t match. Try them again.').waitFor();assert.equal(app.store.get('SELECT COUNT(*) AS n FROM accounts').n,0);
  assert.equal(await alice.page.locator('#signup-password').getAttribute('minlength'),'10');
  await alice.page.getByLabel('Confirm password',{exact:true}).fill(password);
  const rateLimit=route=>route.request().method()==='POST'?route.fulfill({status:429,contentType:'text/plain',body:'Too many attempts'}):route.continue();
  await alice.page.route('**/api/signup',rateLimit);await alice.page.getByLabel('Confirm password',{exact:true}).press('Enter');
  await alice.page.getByRole('alert').filter({hasText:'Too many attempts. Wait a minute'}).waitFor();assert.equal(app.store.get('SELECT COUNT(*) AS n FROM accounts').n,0);assert(await alice.page.locator('#signup-submit').isEnabled());assert.equal(await alice.page.locator('#signup-password').inputValue(),password);
  await alice.page.unroute('**/api/signup',rateLimit);
  await signup(alice.page,'Synthetic Owner Candidate','Creator+dev@Example.test');assert.equal((await alice.context.cookies()).length,0,'Signup does not create a session');ownerId=await login(alice.page,'  CREATOR+DEV@example.test  ');
  await enter(bob.page);await signup(bob.page,'Synthetic Friend','friend@example.test');friendId=await login(bob.page,'FRIEND@example.test');assert.notEqual(ownerId,friendId);
  assert.equal(app.store.get('SELECT COUNT(*) AS n FROM accounts').n,2);assert.match(ownerId,/^[a-f0-9-]{36}$/);await alice.page.screenshot({path:out+'/setup-account-desktop.png',fullPage:true});
 });
 await check('Signup validation and HTTP errors stay visible, retryable, and do not create accounts',async()=>{
  const trial=await pageFor();try{
   await enter(trial.page);const page=trial.page,before=app.store.get('SELECT COUNT(*) AS n FROM accounts').n;
   for(const id of ['signup-password','signup-confirm']){assert.equal(await page.locator('#'+id).getAttribute('minlength'),'10');assert.equal(await page.locator('#'+id).getAttribute('maxlength'),'256');}
   await page.getByLabel('What should we call you?').fill('Synthetic Validation');await page.getByLabel('Email',{exact:true}).fill('validation@example.test');
   for(const id of ['signup-password','signup-confirm']){await page.locator('#'+id).fill('ninechars');}
   await page.locator('#signup-confirm').press('Enter');assert(await page.locator('#signup-view').isVisible());assert.equal(await page.locator('#signup-password').evaluate(node=>node.validity.tooShort),true);
   for(const id of ['signup-password','signup-confirm'])await page.locator('#'+id).fill(password);
   const failures=[
    {status:429,contentType:'application/json',body:JSON.stringify({code:'RATE_LIMITED',message:'Synthetic rate limit'}),expected:/Too many attempts/},
    {status:429,contentType:'text/html',body:'<h1>Synthetic rate limit</h1>',expected:/Too many attempts/},
    {status:503,contentType:'text/html',body:'<h1>Synthetic unavailable</h1>',expected:/could not finish/},
    {status:503,contentType:'application/json',body:JSON.stringify({message:'Synthetic service unavailable'}),expected:/Synthetic service unavailable/},
    {status:400,contentType:'application/json',body:JSON.stringify({code:'INVALID_PASSWORD',message:'Use a unique 10–256 character password'}),expected:/10–256/},
    {status:201,contentType:'text/html',body:'<h1>Synthetic unreadable success</h1>',expected:/couldn’t confirm account creation/},
    ...['null','[]','{}','\"Synthetic invalid success\"'].map(body=>({status:201,contentType:'application/json',body,expected:/couldn’t confirm account creation/})),
   ];
   for(const failure of failures){
    const handler=route=>route.fulfill({status:failure.status,contentType:failure.contentType,body:failure.body});await page.route('**/api/signup',handler);
    await page.locator('#signup-confirm').press('Enter');await page.waitForFunction(()=>!document.querySelector('#signup-error').hidden&&!document.querySelector('#signup-submit').disabled);
    assert.match(await page.locator('#signup-error').textContent(),failure.expected);assert(await page.locator('#signup-view').isVisible());assert.equal(await page.locator('#signup-password').inputValue(),password);await page.unroute('**/api/signup',handler);
   }
   assert.equal(app.store.get('SELECT COUNT(*) AS n FROM accounts').n,before);
  }finally{await trial.context.close();}
 });
 await check('2. Private email storage never enters identity payloads or browser storage',async()=>{
  const me=await (await alice.context.request.get(base+'/api/setup/me')).json();assert.equal(me.accountId,ownerId);assert.equal(me.user.email,undefined);assert(!JSON.stringify(me).includes('@'));assert.match(me.user.username,/^u_[a-f0-9]+$/);
  for(const{page}of[alice,bob]){assert.deepEqual(await page.evaluate(()=>({local:Object.entries(localStorage),session:Object.entries(sessionStorage)})),{local:[],session:[]});assert.equal(new URL(page.url()).search,'');}
  assert(requests.every(request=>!request.url.includes('example.test')&&!request.url.includes('Example.test')),'Email never enters a request URL');
  assert(requests.filter(request=>request.path.startsWith('/api/')).every(request=>!request.referer));assert(wireRequests.filter(request=>request.path.startsWith('/api/')).every(request=>request.referer===undefined),'Actual API transport omits Referrer');
 });
 await check('3. Both setup accounts have no seed ownership or memberships and cannot enter the game',async()=>{
  for(const id of[ownerId,friendId]){for(const table of['universes','worlds','rooms'])assert.equal(app.store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id=?`,id).n,0);for(const table of['members','world_members'])assert.equal(app.store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`,id).n,0);}
  for(const path of['/','/main.js','/api/session','/api/events','/api/rooms/commons','/api/universes','/api/site-invites'])assert.equal((await alice.context.request.get(base+path)).status(),503,path);
  assert(await alice.page.locator('#enter-universe').isHidden());await alice.page.getByRole('button',{name:'Copy account ID'}).click();await alice.page.waitForFunction(()=>/copied|selected/.test(document.querySelector('#copy-status').textContent));assert.match(await alice.page.locator('#copy-status').textContent(),/copied|selected/);
 });
 await check('4. Pending setup and account identity survive restart; explicit synthetic promotion persists seed ownership',async()=>{
  const stored=app.store.get('SELECT salt,password_hash FROM accounts WHERE user_id=?',ownerId);await app.close();await start(true);await enter(alice.page);assert.equal(await alice.page.locator('#account-id').inputValue(),ownerId);assert.deepEqual(app.store.get('SELECT salt,password_hash FROM accounts WHERE user_id=?',ownerId),stored);
  promoteSetupOwner(app.store,ownerId);assert.equal(app.store.get('SELECT value FROM metadata WHERE key=?','operator-bootstrap-v1').value,ownerId);await app.close();await start(false);
  await enter(alice.page);await alice.page.waitForFunction(()=>window.__universe?.getState().ready);assert.equal(await alice.page.evaluate(()=>__universe.getState().user.id),ownerId);assert.equal(new URL(alice.page.url()).pathname,'/');await alice.page.goto('about:blank');assert.equal(app.store.get('SELECT value FROM metadata WHERE key=?','operator-bootstrap-v1').value,ownerId);
  for(const table of['universes','worlds','rooms'])assert.equal(app.store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id IS NULL OR owner_id!=?`,ownerId).n,0);
  const friend=await (await bob.context.request.get(base+'/api/setup/me')).json();assert.equal(friend.accountId,friendId);assert.equal(app.store.get('SELECT COUNT(*) AS n FROM world_members WHERE user_id=?',friendId).n,0);
 });
 await check('5. Setup cannot reopen; normal signup and legacy login stay usable by keyboard and narrow touch',async()=>{
  assert.throws(()=>createGameServer({database,seeds:seedWorlds,runtimeConfig:config(true)}),error=>error.code==='SETUP_ALREADY_INITIALIZED');
  const legacy=await addReviewer(app.store,{name:'Synthetic Legacy',username:'legacy_browser',password});await bob.page.goto(base+'/signup.html#room=studio&view=signin');await bob.page.locator('#signin-view').waitFor();assert(await bob.page.locator('#signin-continue').isVisible());await bob.page.locator('#signin-identifier').fill('legacy_browser');await bob.page.locator('#signin-password').fill('synthetic wrong password');await bob.page.locator('#signin-password').press('Enter');await bob.page.locator('#signin-error').waitFor();assert.equal((await(await bob.context.request.get(base+'/api/setup/me')).json()).accountId,friendId);assert(await bob.page.locator('#signin-view').isVisible());let releaseLogin,heldLogin;const held=new Promise(resolve=>heldLogin=resolve),released=new Promise(resolve=>releaseLogin=resolve);const holdLogin=async route=>{heldLogin();await released;await route.continue();};await bob.page.route('**/api/login',holdLogin);await bob.page.locator('#signin-password').fill(password);const switchSubmitted=bob.page.locator('#signin-password').press('Enter',{noWaitAfter:true});await Promise.race([held,new Promise((_,reject)=>setTimeout(()=>reject(Error('Replacement login request was not sent')),5000))]);assert(await bob.page.locator('#signin-continue').isHidden());assert.equal(await bob.page.locator('#signin-submit').isDisabled(),true);releaseLogin();await switchSubmitted;await bob.page.waitForFunction(()=>window.__universe?.getState().ready);assert.equal(await bob.page.evaluate(()=>__universe.getState().user.id),legacy.id);assert.equal(await bob.page.evaluate(()=>__universe.getState().room.id),'studio');await bob.page.unroute('**/api/login',holdLogin);await bob.page.goto('about:blank');
  phone=await pageFor({viewport:{width:320,height:700},isMobile:true,hasTouch:true});await enter(phone.page);assert.equal(await phone.page.evaluate(()=>document.documentElement.scrollWidth),320);const logo=await phone.page.locator('.signup-brand').boundingBox();assert.equal(logo.width/logo.height,2);
  for(const box of await phone.page.locator('#signup-view input,#signup-view button').evaluateAll(nodes=>nodes.filter(node=>node.getClientRects().length).map(node=>({height:node.getBoundingClientRect().height}))))assert(box.height>=44);
  await phone.page.screenshot({path:out+'/signup-320.png',fullPage:true});await signup(phone.page,'Synthetic Touch Friend','touch+one@example.test',true);assert.equal(new URL(phone.page.url()).pathname,'/');assert.equal(await phone.page.locator('#dock-build').isDisabled(),true);
  await phone.page.setViewportSize({width:640,height:360});assert.equal(await phone.page.evaluate(()=>document.documentElement.scrollWidth),640);await phone.page.screenshot({path:out+'/account-landscape.png',fullPage:true});await phone.page.goto('about:blank');
  game=await pageFor();await game.page.goto(base+'/',{waitUntil:'domcontentloaded'});await game.page.getByRole('link',{name:'Create an account',exact:true}).waitFor();await game.page.getByLabel('Email or username',{exact:true}).fill('FRIEND@example.test');await game.page.locator('#login-password').fill(password);await game.page.locator('#login-password').press('Enter');await game.page.waitForFunction(id=>window.__universe?.getState().ready&&window.__universe.getState().user.id===id,friendId);assert.equal(await game.page.locator('#dock-build').isDisabled(),true);await game.page.screenshot({path:out+'/ordinary-email-game-login.png'});await game.context.close();game=null;
 });
 await check('6. Local serving preserves admission headers and actual SSE heartbeat; hosted TLS/image digest remain operator checks',async()=>{
  const response=await alice.context.request.get(base+'/signup.html');assert.equal(response.headers()['cache-control'],'no-store');assert.equal(response.headers()['referrer-policy'],'no-referrer');assert.match(response.headers()['content-security-policy'],/default-src 'none'/);
  const cookie=(await alice.context.cookies()).find(cookie=>cookie.name==='universe_session');assert(cookie);
  const started=Date.now();const observed=await new Promise((resolve,reject)=>{let data='';const times=[];const request=http.get(base+'/api/events',{headers:{Cookie:cookie.name+'='+cookie.value}},response=>{assert.equal(response.statusCode,200);assert.equal(response.headers['x-accel-buffering'],'no');response.on('data',chunk=>{data+=chunk;if((data.match(/: heartbeat/g)||[]).length>times.length)times.push(Date.now()-started);if(times.length===2){clearTimeout(timer);request.destroy();resolve({times,interval:times[1]-times[0]});}});});const timer=setTimeout(()=>{request.destroy();reject(Error('Actual SSE heartbeats missing'));},33000);request.on('error',error=>{clearTimeout(timer);reject(error);});});assert(observed.interval>=14000&&observed.interval<22000);console.log('Local heartbeat interval',observed.interval,'ms');
  assert.deepEqual(errors,[]);
 });
}catch(error){process.exitCode=1;errors.push(error.stack);console.error(error);for(const [label,subject]of Object.entries({alice,bob,phone,game})){if(!subject)continue;await subject.page.screenshot({path:out+'/failure-'+label+'.png',fullPage:true}).catch(()=>{});console.error(label,await subject.page.evaluate(()=>({url:location.href,error:document.querySelector('#signin-error')?.textContent,state:window.__universe?{ready:__universe.getState().ready,user:__universe.getState().user?.id,room:__universe.getState().room?.id}:null})).catch(()=>null));}}
finally{await writeFile(out+'/results.json',JSON.stringify({checks,errors,limits:['Synthetic local HTTP accounts and SQLite only; no real account promotion','No hosted HTTPS, published digest, public-port or physical-phone verification']},null,2));await alice?.context.close();await bob?.context.close();await phone?.context.close();await game?.context.close();await browser?.close();await app?.close();await rm(folder,{recursive:true,force:true});}
