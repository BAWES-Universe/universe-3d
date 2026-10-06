/** Real open-registration server, explicit synthetic owner, actual app UI.
 * Mutation flows use native keyboard/touch. Network holds/faults test recovery;
 * read-only state/SQLite diagnostics verify identity and access boundaries.
 * Local HTTP and touch emulation do not certify hosted TLS or physical phones.
 */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Store} from '../server/store.mjs';
import {bootstrapOwner} from '../server/operator-accounts.mjs';
import {createGameServer} from '../server/app.mjs';
import {readRuntimeConfig} from '../server/runtime-config.mjs';
import {launch} from '../scripts/browser.mjs';
const out=process.env.UNIVERSE_ONBOARDING_EVIDENCE||'evidence/onboarding-continuation';await mkdir(out,{recursive:true});
const dist=resolve(process.env.UNIVERSE_ONBOARDING_DIST||'dist'),folder=await mkdtemp(join(tmpdir(),'universe-onboarding-')),password='synthetic onboarding password';
const scene={version:1,theme:'garden',bounds:{width:24,depth:22},spawn:{x:0,z:6},areas:[{id:'welcome',name:'Welcome point',x:5,z:0,width:2,depth:2,action:'welcome',start:{key:'welcome'}}],objects:[]};
const seeds=[{id:'universe',name:'Synthetic Universe',rooms:['commons','studio','private'].map(id=>({id,name:id==='studio'?'Friend Studio':id==='private'?'Private Studio':'Commons',scene:structuredClone(scene)}))}];
const browser=await launch(),checks=[],errors=[],dataHashes=[];let app,page,context,base,index=0;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const pass=name=>{checks.push({name,status:'passed'});console.log('PASS',name);};
async function fixture(setup=false){
 if(app){const path=app.databasePath;await app.close();dataHashes.push({fixture:index,sha256:hash(await readFile(path))});app=null;}
 const database=join(folder,String(++index)+'.sqlite');
 if(!setup){const store=new Store(database,seeds);await bootstrapOwner(store,{name:'Synthetic owner',username:'synthetic_owner',password});store.run('UPDATE rooms SET public=0 WHERE id=?','private');store.close();}
 app=createGameServer({database,seeds,dist,runtimeConfig:readRuntimeConfig({UNIVERSE_REGISTRATION_MODE:'open',UNIVERSE_SETUP_ONLY:setup?'1':'0'})});app.databasePath=database;base='http://127.0.0.1:'+(await app.listen(0)).port;
}
async function fresh(mobile=false){await context?.close();context=await browser.newContext({viewport:mobile?{width:320,height:700}:{width:1280,height:900},hasTouch:mobile,isMobile:mobile,reducedMotion:'reduce'});page=await context.newPage();page.setDefaultTimeout(60000);page.on('pageerror',e=>errors.push(e.message));return page;}
async function form(email){await page.locator('#signup-view').waitFor();await page.locator('#signup-name').fill('Synthetic friend');await page.locator('#signup-email').fill(email);await page.locator('#signup-password').fill(password);await page.locator('#signup-confirm').fill(password);}
async function submit(mobile=false){if(mobile)await page.locator('#signup-submit').tap();else await page.locator('#signup-confirm').press('Enter');}
async function ready(room='studio'){await page.waitForFunction(room=>window.__universe?.getState().ready&&window.__universe.getState().room.id===room,room);}
async function noEscalation(email){const id=app.store.get('SELECT user_id FROM accounts WHERE email=?',email).user_id;for(const table of['universes','worlds','rooms'])assert.equal(app.store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id=?`,id).n,0);assert.equal(app.store.get('SELECT COUNT(*) AS n FROM world_members WHERE user_id=?',id).n,0);assert.equal(app.store.get('SELECT COUNT(*) AS n FROM members WHERE user_id=? AND granted=1',id).n,0);return id;}
async function screenshot(name){await page.screenshot({path:out+'/'+name+'.png',fullPage:true});}
try{
 await fixture();
 for(const mobile of [false,true]){
  await fresh(mobile);const email=(mobile?'touch':'keyboard')+'@example.test',requests=[];page.on('request',request=>requests.push({path:new URL(request.url()).pathname,url:request.url(),method:request.method()}));
  await page.goto(base+'/?room=studio&entry=welcome');await page.locator('#open-signup').waitFor();
  const link=await page.locator('#open-signup').getAttribute('href');assert.equal(link,'/signup.html#room=studio&entry=welcome','Create account must preserve the original destination');
  if(mobile)await page.locator('#open-signup').tap();else await page.locator('#open-signup').press('Enter');await form(email);
  assert.equal(await page.locator('#signup-submit').textContent(),'Create account & enter');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),mobile?320:1280);
  if(mobile)for(const height of await page.locator('#signup-view input,#signup-view button').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length).map(n=>n.getBoundingClientRect().height)))assert(height>=44);
  await screenshot(mobile?'01-touch-signup':'01-keyboard-signup');
  let release,heldResolve;const held=new Promise(r=>heldResolve=r),released=new Promise(r=>release=r);let submissions=0;
  const hold=async route=>{if(route.request().method()!=='POST')return route.continue();submissions++;const response=await route.fetch();heldResolve(response);await released;await route.fulfill({response});};await page.route('**/api/signup',hold);
  await submit(mobile);const signupResponse=await held;assert.equal(signupResponse.status(),201);assert.equal(signupResponse.headers()['set-cookie'],undefined,'Signup itself must not mint a session');
  assert.equal(await page.locator('#signup-submit').isDisabled(),true);assert.equal(await page.locator('#signup-email').isDisabled(),true);await page.keyboard.press('Enter');await page.keyboard.press('Enter');assert.equal(submissions,1);
  release();await ready();await page.unroute('**/api/signup',hold);
  const state=await page.evaluate(()=>__universe.getState());assert.equal(state.destination.entry,'welcome');assert(state.position.x>4);assert.equal(state.user.id,await noEscalation(email));
  assert.equal(requests.filter(r=>r.method==='POST'&&r.path==='/api/signup').length,1);assert.equal(requests.filter(r=>r.method==='POST'&&r.path==='/api/login').length,1);assert.equal(requests.some(r=>r.path==='/api/session'&&r.method==='POST'),false);
  assert(requests.every(r=>!r.url.includes('example.test')&&!r.url.includes(password)));const storage=await page.evaluate(()=>JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]));assert(!storage.includes(email)&&!storage.includes(password));
  await screenshot(mobile?'02-touch-in-friend-room':'02-keyboard-in-friend-room');
  const identity=state.user.id;await page.reload();await ready();assert.equal(await page.evaluate(()=>__universe.getState().user.id),identity);
  await page.goBack();await ready();assert.equal(new URL(page.url()).searchParams.get('room'),'studio');await page.goForward();await ready();
  await page.goto(base+'/signup.html#room=studio&entry=welcome');await ready();assert.equal(new URL(page.url()).pathname,'/');
  pass((mobile?'Touch 320px':'Keyboard desktop')+': one explicit create-and-enter action reaches the selected named arrival, survives reload/back/forward, rejects duplicate submits and grants no owner/private roles');
 }
 await context.close();context=null;await fixture();await fresh(true);
 await page.goto(base+'/signup.html#room=private&entry=welcome');await form('private@example.test');await submit(true);await page.locator('#places').waitFor();
 assert.equal(await page.evaluate(()=>__universe.getState().ready),false);await noEscalation('private@example.test');assert.equal((await context.request.get(base+'/api/rooms/private')).status(),404);
 await page.getByRole('button',{name:'Make a place',exact:true}).tap();await page.getByLabel('Place name',{exact:true}).fill('My first place');assert.equal(await page.getByLabel('Privacy',{exact:true}).inputValue(),'private');await page.getByRole('button',{name:'Create & enter',exact:true}).tap();await page.waitForFunction(()=>window.__universe?.getState().ready);
 const made=await page.evaluate(()=>__universe.getState());assert.equal(made.room.name,'My first place');assert.equal(made.room.role,'owner');assert.equal(made.room.public,false);assert.equal((await context.request.get(base+'/api/rooms/private')).status(),404);await screenshot('03-private-room-boundary-and-self-start');
 pass('A private-room link grants no access; a new eligible friend can create and enter their own private place by touch without operator help');
 await context.close();context=null;await fixture();await fresh();await page.goto(base+'/signup.html#room=studio&entry=welcome');await form('recovery@example.test');
 const failSignup=route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Synthetic temporary signup failure'})});await page.route('**/api/signup',failSignup);await submit();await page.locator('#signup-error').waitFor();assert.match(await page.locator('#signup-error').textContent(),/temporary/);assert.equal(await page.locator('#signup-submit').isEnabled(),true);assert.equal(app.store.get('SELECT COUNT(*) AS n FROM accounts').n,1);await page.unroute('**/api/signup',failSignup);
 const badSignup=route=>route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({created:false,loginRequired:true})});await page.route('**/api/signup',badSignup);await submit();await page.getByText(/couldn’t confirm account creation/).waitFor();assert.equal(app.store.get('SELECT COUNT(*) AS n FROM accounts').n,1);await page.unroute('**/api/signup',badSignup);
 let loginResolve;const loginHeld=new Promise(r=>loginResolve=r);const interrupted=route=>{loginResolve(route);};await page.route('**/api/login',interrupted);await submit();const pending=await loginHeld;assert.equal(app.store.get('SELECT COUNT(*) AS n FROM accounts').n,2);assert.equal(new URL(page.url()).hash.includes('view=signin'),true);await page.reload();await pending.abort().catch(()=>{});await page.unroute('**/api/login',interrupted);await page.locator('#signin-view').waitFor();assert.equal(await page.locator('#signin-password').inputValue(),'');
 await page.locator('#signin-identifier').fill('recovery@example.test');await page.locator('#signin-password').fill(password);
 const malformed=route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({user:{id:'fake'},accountId:'fake',setupOnly:'false'})});await page.route('**/api/login',malformed);await page.locator('#signin-password').press('Enter');await page.locator('#signin-error').waitFor();assert.match(await page.locator('#signin-error').textContent(),/confirm your sign-in/);assert(await page.locator('#signin-view').isVisible());assert(await page.locator('#account-view').isHidden());await page.unroute('**/api/login',malformed);
 await page.locator('#signin-password').fill(password);await page.locator('#signin-password').press('Enter');await ready();assert.equal(app.store.get('SELECT COUNT(*) AS n FROM accounts').n,2);await screenshot('04-interrupted-signup-recovered');
 pass('HTTP/malformed signup failures, reload during the follow-on login and malformed identity stay recoverable without duplicate accounts or false entry');
 await context.close();context=null;await fixture();await fresh();await page.goto(base+'/signup.html#room=studio&entry=welcome');await form('loginfailure@example.test');const abort=route=>route.abort();await page.route('**/api/login',abort);await submit();await page.locator('#signin-view').waitFor();assert.match(await page.locator('#signin-note').textContent(),/account was created/);assert.equal(await page.locator('#signin-identifier').inputValue(),'loginfailure@example.test');assert.equal(await page.locator('#signup-password').inputValue(),'');assert.equal(await page.locator('#signup-confirm').inputValue(),'');await page.unroute('**/api/login',abort);await page.locator('#signin-password').fill(password);await page.locator('#signin-password').press('Enter');await ready();pass('A failed follow-on login offers a prefilled sign-in recovery and clears successful-signup passwords');
 await context.close();context=null;await fixture(true);
 for(const mobile of[false,true]){
  await fresh(mobile);await page.goto(base+'/signup.html#room=studio&entry=welcome');await form((mobile?'setup-touch':'setup-keyboard')+'@example.test');assert.equal(await page.locator('#signup-submit').textContent(),'Create my account');await submit(mobile);await page.locator('#signin-view').waitFor();assert.equal((await context.cookies()).length,0);await page.locator('#signin-password').fill(password);await page.locator('#signin-password').press('Enter');await page.locator('#account-view').waitFor();const id=await page.locator('#account-id').inputValue();assert(id);assert(await page.locator('#enter-universe').isHidden());assert(await page.locator('#setup-note').isVisible());assert.equal((await context.request.get(base+'/api/session')).status(),503);for(const table of['universes','worlds','rooms'])assert.equal(app.store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id IS NOT NULL`).n,0);
  if(mobile)await page.locator('#copy-account-id').tap();else await page.locator('#copy-account-id').press('Enter');await page.waitForFunction(()=>/copied|selected/.test(document.querySelector('#copy-status').textContent));await page.reload();await page.locator('#account-view').waitFor();assert.equal(await page.locator('#account-id').inputValue(),id);await page.locator('#check-status').click();await page.locator('#account-view').waitFor();await screenshot(mobile?'05-true-setup-only-touch':'05-true-setup-only-keyboard');
  pass((mobile?'Touch':'Keyboard')+': genuine setup-only preserves separate signup/login, account ID/copy/status/reload and blocked game/ownership');
 }
 await context.close();context=null;await fixture(true);await fresh();
 const staleOpen=async route=>{const response=await route.fetch(),body=await response.json();await route.fulfill({response,json:{...body,setupOnly:false}});};await page.route('**/api/signup',route=>route.request().method()==='GET'?staleOpen(route):route.continue());await page.goto(base+'/signup.html#room=studio');await form('stale-setup@example.test');await submit();await page.locator('#account-view').waitFor();assert(await page.locator('#enter-universe').isHidden());assert.equal((await context.request.get(base+'/api/session')).status(),503);pass('An authoritative setup-only login overrides stale ordinary policy and never enters the game');
 await context.close();context=null;await fixture();await fresh();
 const staleSetup=async route=>{const response=await route.fetch(),body=await response.json();await route.fulfill({response,json:{...body,setupOnly:true}});};await page.route('**/api/signup',route=>route.request().method()==='GET'?staleSetup(route):route.continue());await page.goto(base+'/signup.html#room=studio');await form('stale-open@example.test');await submit();await page.locator('#signin-view').waitFor();await page.locator('#signin-password').fill(password);await page.locator('#signin-password').press('Enter');await ready();pass('An authoritative ordinary login overrides stale setup policy and enters without an account-ID interstitial');
 assert.deepEqual(errors,[]);
}catch(error){process.exitCode=1;checks.push({status:'failed',error:error.stack});console.error(error);await page?.screenshot({path:out+'/failure.png',fullPage:true}).catch(()=>{});}
finally{
 await context?.close();await browser.close();if(app){const path=app.databasePath;await app.close();dataHashes.push({fixture:index,sha256:hash(await readFile(path))});}
 await writeFile(out+'/results.json',JSON.stringify({checks,errors,source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceDiffSha256:hash(execFileSync('git',['diff','HEAD'])),seedSha256:hash(JSON.stringify(seeds)),bundleSha256:hash(await readFile(join(dist,'main.js'))),signupSha256:hash(await readFile(join(dist,'signup.js'))),syntheticDatabaseHashes:dataHashes,limits:['Synthetic isolated local HTTP open-registration service with an explicit offline owner','Native Chromium keyboard and 320px touch emulation, not physical-device or hosted TLS acceptance']},null,2));await rm(folder,{recursive:true,force:true});
}
