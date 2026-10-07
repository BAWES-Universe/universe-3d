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
import {guestTouchMotion} from './public-guest-motion.mjs';
const out=process.env.UNIVERSE_PUBLIC_GUEST_EVIDENCE||'evidence/public-guest-browser';await mkdir(out,{recursive:true});
const dist=resolve('dist'),folder=await mkdtemp(join(tmpdir(),'universe-shared-entry-')),database=join(folder,'synthetic.sqlite'),password='synthetic shared entry password';
const scene={version:1,theme:'garden',bounds:{width:24,depth:22},spawn:{x:0,z:6},areas:[{id:'welcome',name:'Welcome point',x:5,z:0,width:2,depth:2,action:'welcome',start:{key:'welcome'}}],objects:[{id:'chair-root',type:'chair',name:'Welcome chair',x:2,z:6,rotation:0},{id:'chair-named',type:'chair',name:'Arrival chair',x:6.4,z:0,rotation:0}]};
const seeds=[{id:'universe',name:'Synthetic Universe',rooms:['commons','studio','private'].map(id=>({id,name:id==='studio'?'Friend Studio':id==='private'?'Private Studio':'Commons',scene:structuredClone(scene)}))}];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function snapshot(){return{head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(),trackedChanges:execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim(),diffSha256:hash(execFileSync('git',['diff','HEAD'])),guardSha256:hash(await readFile('server/runtime-config.mjs')),bundleSha256:hash(await readFile(join(dist,'main.js'))),signupSha256:hash(await readFile(join(dist,'signup.js')))};}
const sourceBefore=await snapshot(),checks=[],wire=[],errors=[],motionEvidence=[];let browser,context,page,app,driver,base,driverBase;
const pass=name=>{checks.push({name,status:'passed'});console.log('PASS',name);};
async function freePort(){const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function fresh(mobile=false,viewport=mobile?{width:320,height:568}:{width:1280,height:900}){await context?.close();context=await browser.newContext({viewport,hasTouch:mobile,isMobile:mobile,reducedMotion:'reduce'});page=await context.newPage();page.setDefaultTimeout(45000);page.on('pageerror',e=>errors.push(e.message));}
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
 const observeRequest=(req,res)=>{const row={method:req.method,path:req.url,headers:Object.fromEntries(['host','origin','referer','sec-fetch-site','sec-fetch-mode','sec-fetch-dest','sec-fetch-user'].filter(key=>req.headers[key]!==undefined).map(key=>[key,req.headers[key]])),cookiePresent:!!req.headers.cookie};wire.push(row);res.on('finish',()=>row.status=res.statusCode);};app.server.on('request',observeRequest);
 driver=http.createServer((req,res)=>{const target=new URL(req.url,'http://localhost').searchParams.get('target')||'/';const escaped=(base+target).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><h1>A friend shared a place</h1><a id="shared" href="${escaped}">Open shared Universe</a>${req.url==='/resources'?`<iframe src="${base}/"></iframe><img src="${base}/signup.js"><script src="${base}/signup.js"></script>`:''}${req.url==='/automatic'?`<script>setTimeout(()=>location.href=${JSON.stringify(base+'/')},250)</script>`:''}<form method="post" action="${base}/api/signup"><button id="post">Cross-site form</button></form>`);});await new Promise(resolve=>driver.listen(0,'127.0.0.1',resolve));driverBase=`http://localhost:${driver.address().port}`;browser=await launch();
 for(const viewport of[{width:1280,height:900},{width:320,height:568},{width:667,height:375}])for(const named of[false,true]){
  const mobile=viewport.width<800,label=`${viewport.width}x${viewport.height}-${named?'named':'root'}`;
  await fresh(mobile,viewport);const target=named?'/?room=studio&entry=welcome':'/',room=named?'studio':'commons',start=wire.length;
  const {response}=await link(target,mobile);assert.equal(response.status(),200);await page.getByRole('button',{name:'Explore as guest'}).waitFor();await page.waitForFunction(()=>window.__universe&&!document.getElementById('join-button').disabled);assert.equal(await page.locator('#display-name').inputValue(),'');assert.equal(await page.locator('#display-name').getAttribute('required'),null);
  if(mobile)await page.getByRole('button',{name:'Explore as guest'}).tap();else await page.getByRole('button',{name:'Explore as guest'}).press('Enter');
  let state=await ready(room);assert(state.user.ephemeralGuest);assert(!state.user.account);assertOrdinary(state.user.id);assert.equal(state.room.capabilities.canBuild,false);if(named)assert.equal(state.destination.entry,'welcome');let guestId=state.user.id;const session=(await context.cookies()).find(cookie=>cookie.name==='universe_session');assert(session);assert.equal(session.expires,-1);assert.equal(session.httpOnly,true);assert.equal(session.secure,true);assert.equal(session.sameSite,'Strict');
  await page.waitForTimeout(500);assert.equal(wire.slice(start).filter(r=>r.path.startsWith('/api/')&&r.status>=400&&!['/api/session'].includes(r.path)).length,0,'No guest background API errors');assert.deepEqual(wire.slice(start).filter(r=>r.method==='POST'&&['/api/signup','/api/login','/api/quests/preferences','/api/quests/notices/claim','/api/media/state'].includes(r.path)),[]);
  if(!mobile){
   await page.locator('#interact').waitFor({state:'visible'});if(mobile)await page.locator('#interact').tap();else{await page.locator('#game').focus();await page.keyboard.press('t');}await page.waitForFunction(()=>__universe.getMotion().seatId!==null);await page.waitForTimeout(200);assert.equal(app.presence.get(room+':'+guestId).seatId,named?'chair-named':'chair-root');
   if(mobile)await page.locator('#interact').tap();else await page.keyboard.press('t');await page.waitForFunction(()=>__universe.getMotion().seatId===null);
   if(mobile)await page.locator('#jump-button').tap();else{await page.locator('#game').focus();await page.keyboard.press('Space');}await page.waitForFunction(()=>__universe.getMotion().y>.1);await page.waitForFunction(()=>__universe.getMotion().grounded);
  }
  if(mobile)motionEvidence.push({label,records:await guestTouchMotion({page,context,out,label})});
  if(!mobile){
   const before=await page.evaluate(()=>__universe.getState().position);await page.locator('#game').focus();
   // Keep native movement held until a frame observes the original endpoint.
   // A fixed key hold can begin and end between software-WebGL frames.
   try{await page.keyboard.down('w');await page.waitForFunction(before=>{const moved=__universe.getState().position;return Math.hypot(moved.x-before.x,moved.z-before.z)>.1;},before);}
   finally{await page.keyboard.up('w');}
   const moved=await page.evaluate(()=>__universe.getState().position);assert(Math.hypot(moved.x-before.x,moved.z-before.z)>.1);
   await page.waitForFunction(()=>__universe.getMotion().speed===0);
   const camera=await page.evaluate(()=>__universe.getCamera());await page.keyboard.press(']');
   await page.waitForFunction(yaw=>__universe.getCamera().yaw!==yaw,camera.yaw);
   const rotated=await page.evaluate(()=>__universe.getCamera());assert.notEqual(rotated.yaw,camera.yaw);assert.notDeepEqual(rotated,camera);
   motionEvidence.push({label,input:'keyboard',before,moved,cameraBefore:camera,cameraAfter:rotated});
  }
  await page.reload();state=await ready(room);assert.equal(state.user.id,guestId);assert.equal((await link(target,mobile)).response.status(),200);assert.equal((await ready(room)).user.id,guestId);await page.screenshot({path:out+`/${label}-guest.png`});pass(`${mobile?`${viewport.width}x${viewport.height} touch`:'Desktop'} native external ${named?'named destination':'root'} guest entry/reload with no account or background denials; ${mobile?'visible mirrored Sit/Stand + simultaneous movement/camera/Jump':'native T/Space/WASD/camera'}`);
  if(!mobile&&named){
   const oldGuest=guestId;await app.close();app=createGameServer({database,seeds,dist,runtimeConfig});await app.listen(port);app.server.on('request',observeRequest);await page.reload();await page.getByRole('button',{name:'Explore as guest'}).click();state=await ready(room);assert.notEqual(state.user.id,oldGuest);assert.equal(state.destination.entry,'welcome');guestId=state.user.id;assert.equal(app.store.user(oldGuest),undefined);pass('Restart loses guest lease; one-click re-entry preserves named room/entry');
   await page.locator('#dock-build').click();await page.getByRole('button',{name:'Keep exploring',exact:true}).click();assert.equal(await page.locator('#dialog').isVisible(),false);assert.equal((await ready(room)).user.id,guestId);
   await page.locator('#dock-build').click();await page.getByRole('button',{name:'Create account',exact:true}).click();await page.locator('#signup-view').waitFor();assert.equal(new URL(page.url()).hash,'#room=studio&entry=welcome');await page.locator('#signup-name').fill('Synthetic account after guest');await page.locator('#signup-email').fill('guest-transition@example.test');await page.locator('#signup-password').fill(password);await page.locator('#signup-confirm').fill(password);await page.locator('#signup-confirm').press('Enter');state=await ready(room);assert(state.user.account);assert(!state.user.ephemeralGuest);assert.notEqual(state.user.id,guestId);assert.equal(state.destination.entry,'welcome');assert.equal(app.store.user(guestId),undefined);assert.equal(app.presence.has(room+':'+guestId),false);assertOrdinary(state.user.id);pass('Dismissible guest Build prompt and signup/login transition retire guest and preserve named destination');
  }
 }
 await fresh(true);assert.equal((await link('/?room=private&entry=welcome',true)).response.status(),200);await page.getByRole('button',{name:'Explore as guest'}).tap();await page.locator('#places').waitFor();assert.equal(await page.evaluate(()=>__universe.getState().ready),false);assert.equal(await page.evaluate(async()=> (await fetch('/api/rooms/private',{credentials:'same-origin'})).status),404);const identity=await page.evaluate(()=>__universe.getState().user);assert(identity.ephemeralGuest);assertOrdinary(identity.id);pass('Private link creates no access, membership or owner privileges');
 await page.getByRole('button',{name:'Make a place',exact:true}).tap();await page.getByRole('button',{name:'Keep exploring',exact:true}).tap();assert.equal(await page.locator('#dialog').isVisible(),false);pass('Guest creation prompt dismisses without persistent creation or navigation');
 assert.deepEqual(errors,[]);
}catch(error){process.exitCode=1;checks.push({status:'failed',error:error.stack});console.error(error);await page?.screenshot({path:out+'/failure.png',fullPage:true}).catch(()=>{});}
finally{
 await context?.close();await browser?.close();await new Promise(resolve=>driver?driver.close(resolve):resolve());await app?.close();const sourceAfter=await snapshot();if(JSON.stringify(sourceBefore)!==JSON.stringify(sourceAfter)){process.exitCode=1;checks.push({status:'failed',error:'Source or build changed during native test'});}
 await writeFile(out+'/results.json',JSON.stringify({checks,errors,motionEvidence,sourceBefore,sourceAfter,wire,fixture:{base,driverBase,mode:'public',registrationMode:'open',setupOnly:false,override:'allowedOrigins=[actual loopback HTTP origin]; production readRuntimeConfig HTTPS validation untouched',cookieSecure:'always'},limits:['Synthetic SQLite and native Chromium on loopback HTTP only','Public-mode guard and all auth/access APIs real; only test fixture Origin matches loopback HTTP','No request interception, certificate warning bypass, browser trust change, hosted TLS or physical-device certification']},null,2));await rm(folder,{recursive:true,force:true});
}
