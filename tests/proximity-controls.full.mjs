/**
 * Actual bundled 3D game, authenticated local HTTP/SSE, native product input.
 * Run after building and freezing runtime source:
 * node tests/proximity-controls.full.mjs
 * PROXIMITY_CONTROLS_REPLAY=consent replays native consent with expired case handoffs.
 * Two independent Chromium processes prevent accidental identity sharing.
 * API fixtures only create an explicitly synthetic outsider, sibling sessions,
 * and room access changes. Browser evaluation reads diagnostics/DOM only.
 */
import assert from 'node:assert/strict';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds, canStand} from '../src/worlds.js';
import {proximityFixture} from './fixtures/proximity-config.mjs';
import {launch} from '../scripts/browser.mjs';

const root=new URL('../',import.meta.url), out=new URL('../evidence/proximity-controls-full/',import.meta.url);
const replay=process.env.PROXIMITY_CONTROLS_REPLAY;
assert(replay===undefined||['secondary','touch','observer','consent'].includes(replay),'Only explicit secondary, touch, observer or consent replay modes are supported');
const targeted=!!replay;
await mkdir(out,{recursive:true});
async function hashes(){
 const files=[];
 async function walk(path){for(const entry of await readdir(new URL(path,root),{withFileTypes:true})){const p=path+entry.name;if(entry.isDirectory())await walk(p+'/');else files.push(p);}}
 for(const folder of ['src/','server/','public/'])await walk(folder);
 files.push('package.json','scripts/build.mjs','dist/main.js','dist/main.css','tests/proximity-controls.full.mjs');
 const result={};for(const file of files.sort())result[file]=createHash('sha256').update(await readFile(new URL(file,root))).digest('hex');
 return {files:result,combined:createHash('sha256').update(JSON.stringify(result)).digest('hex')};
}
const beforeHashes=await hashes();
const seeds=structuredClone(seedWorlds);
const obstacle={id:'qa-wall',type:'wall',name:'Known collision wall',x:4,z:0,width:.3,depth:6,rotation:0};
for(const world of seeds)for(const room of world.rooms){room.scene.objects=room.id==='commons'?[{...obstacle}]:[];room.scene.areas=[];room.scene.spawn={x:0,z:0};room.scene.bounds={width:48,depth:40};}
const app=createGameServer({database:':memory:',seeds,dist:new URL('../dist',import.meta.url).pathname,proximityMembershipConfig:proximityFixture,proximityTextConfig:{enabled:true}});
const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`;
const browsers=[],contexts=[],pages=[],checks=[],errors=[],requests=[],fixtures=[],layouts=[],motionSamples=[];
let phase='startup',alice,bob,aliceContext,bobContext,outsider,heldReleases=[];
const names={alice:'Mira group proof',bob:'Ari group proof'};
const position=page=>page.evaluate(()=>__universe.getState().position);
const controls=page=>page.evaluate(()=>__universe.getProximityControls());
const controller=page=>page.evaluate(()=>__universe.getFollowMotion());
const followButton=page=>page.locator('.proximity-controls [data-control="follow"]');
const acceptButton=(page,name)=>page.getByRole('button',{name:`Accept ${name}’s follow invitation`,exact:true});
const declineButton=(page,name)=>page.getByRole('button',{name:`Decline ${name}’s follow invitation`,exact:true});
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const placementIdentity=value=>Object.fromEntries(['admissionId','admissionEpoch','admissionRevision'].map(key=>[key,value[key]]));
function contrast(a,b){const luminance=value=>{const channels=value.match(/[\d.]+/g).slice(0,3).map(Number).map(c=>{c/=255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;});return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;};const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
const cameraKeys=['yaw','tilt','distance','follow','framingMode'];
async function check(name,fn){phase=name;const start=Date.now();console.log('RUN',name);await fn();checks.push({name,status:'passed',elapsedMs:Date.now()-start});console.log('PASS',name);}
async function frames(page,count=6){await page.evaluate(count=>new Promise(resolve=>{const tick=()=>--count<=0?resolve():requestAnimationFrame(tick);requestAnimationFrame(tick);}),count);}
async function settled(page){await page.waitForFunction(()=>__universe.getMotion().speed<.02,null,{timeout:15000});}
// Following can slide tangentially along a wall while converging to the leader's
// Z coordinate. The app caps each motion tick at .25s, so a throttled renderer
// needs a simulation-time budget rather than the generic 15s wall-clock wait.
// Keep the same speed threshold and reject wall penetration on every observed frame.
async function settledAtWall(page){
 return page.evaluate(()=>new Promise((resolve,reject)=>{
  let last=performance.now(),simulatedSeconds=0,observedFrames=0,maxX=-Infinity,done=false,frame;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);cancelAnimationFrame(frame);error?reject(error):resolve(value);};
  const timer=setTimeout(()=>finish(Error('Wall convergence made insufficient rendered progress within 60 seconds')),60000);
  const tick=now=>{
   if(done)return;simulatedSeconds+=Math.max(0,Math.min(.25,(now-last)/1000));last=now;observedFrames++;
   const position=__universe.getState().position,speed=__universe.getMotion().speed;maxX=Math.max(maxX,position.x);
   if(position.x>=3.551)return finish(Error('Following crossed the wall face: '+JSON.stringify(position)));
   if(speed<.02)return finish(null,{simulatedSeconds,observedFrames,maxX,speed});
   if(simulatedSeconds>=8)return finish(Error('Following failed the unchanged settling threshold after 8 simulated seconds: '+JSON.stringify({position,speed})));
   frame=requestAnimationFrame(tick);
  };frame=requestAnimationFrame(tick);
 }));
}

async function readyControls(page,count=2){await page.waitForFunction(count=>{const s=__universe.getProximityControls();return s.canAct&&!s.operation&&s.context?.participants.length===count;},count,{timeout:20000});const more=page.locator('.proximity-advanced > summary');if(await more.isVisible()&&!await more.evaluate(node=>node.parentElement.open))await more.click();}
async function gameplay(page){await page.bringToFront();await page.locator('#game').focus();await frames(page,3);}
async function nativeInvite(leader,follower,leaderName){await readyControls(leader);await leader.getByRole('button',{name:'Follow me',exact:true}).click();await follower.waitForFunction(name=>__universe.getProximityControls().invitations.some(invitation=>invitation.leaderName===name),leaderName);}
async function nativeAccept(follower,leaderName){await acceptButton(follower,leaderName).click();await follower.waitForFunction(()=>!!__universe.getProximityControls().motion);await gameplay(follower);await follower.waitForFunction(()=>__universe.getFollowMotion().armed);}
async function nativeStop(page){
 const start=requests.length,label=pages.find(entry=>entry.page===page).label;
 if((await controls(page)).canStop){
  const more=page.locator('.proximity-advanced > summary');if(await more.isVisible()&&!await more.evaluate(node=>node.parentElement.open))await more.click();
  // A role locator retains its node during click actionability checks; expiry
  // can relabel it Invite before pointerdown. Native Escape in this strip is
  // cancellation even if that label changes before the key is dispatched.
  await followButton(page).press('Escape',{timeout:5000});
  await page.waitForFunction(()=>{const s=__universe.getProximityControls();return !s.context?.following&&!s.canStop&&!s.operation;});
 }
 await settled(page);
 assert(!requests.slice(start).some(request=>request.label===label&&request.body?.action==='invite'),'Case cleanup must never create a new invitation');
}
async function freshNativeInvite(leader,follower,leaderName){
 // An earlier case may have left a pending invitation or outlived its normal TTL.
 // Retire that case's consent through the product before creating this case's own.
 const previous=(await controls(follower)).invitations.map(invitation=>invitation.invitationId);
 await nativeStop(leader);await follower.waitForFunction(name=>!__universe.getProximityControls().invitations.some(invitation=>invitation.leaderName===name),leaderName);
 await nativeInvite(leader,follower,leaderName);const invitation=(await controls(follower)).invitations.find(invitation=>invitation.leaderName===leaderName);assert(!previous.includes(invitation.invitationId),'Each consent scenario must receive a fresh native invitation');
}
async function expirePriorInvitation(){
 const prior=(await controls(bob)).invitations;assert.equal((await controls(bob)).context.limits.invitationTtlMs,30000);
 await bob.waitForFunction(()=>__universe.getProximityControls().invitations.length===0,null,{timeout:45000});await alice.waitForFunction(()=>__universe.getProximityControls().context.outgoingInvitations.length===0);
 const expired=await controls(bob);for(const invitation of prior)assert(expired.context.serverTime>=invitation.expiresAt,'Replay must observe natural production expiry');assert.equal(expired.context.following,null);assert.equal(expired.motion,null);motionSamples.push({kind:'expired-case-invitation',phase,prior,serverTime:expired.context.serverTime});
}
async function visit(page,name,id){await page.bringToFront();if(await page.locator('#dialog').isVisible())await page.locator('#dialog-close').click();if(await page.locator('#places').isVisible()){await page.getByRole('button',{name:'Close places',exact:true}).click();await page.locator('#places').waitFor({state:'hidden'});await frames(page,3);}await page.locator('#dock-explore').click();await page.getByRole('button',{name:'View room '+name,exact:true}).click();await page.getByRole('button',{name:'Enter '+name,exact:true}).click();await page.waitForFunction(id=>__universe.getState().ready&&__universe.getState().room?.id===id,id,{timeout:30000});await page.locator('#places').waitFor({state:'hidden'});await gameplay(page);}
async function resetPair(){
 for(const page of [alice,bob]){for(const key of ['w','a','s','d','Shift'])await page.keyboard.up(key);if(await page.locator('.express-tray').isVisible())await page.getByRole('button',{name:'Close Express',exact:true}).click();if(await page.locator('#social').isVisible())await page.getByRole('button',{name:'Close social panel',exact:true}).click();if(await page.locator('#editor').isVisible())await page.getByRole('button',{name:'Close editor',exact:true}).click();if(await page.locator('#dialog').isVisible())await page.locator('#dialog-close').click();await nativeStop(page);}
 for(const page of [alice,bob])await visit(page,'The Studio','studio');
 for(const page of [alice,bob])await visit(page,'The Commons','commons');
 await readyControls(alice);await readyControls(bob);
}
// Actual key chords selected from the observed camera yaw. Stop when observed
// coordinates cross the target, never after an arbitrary movement duration.
async function walkAxis(page,axis,target){
 await gameplay(page);const start=await position(page),delta=target-start[axis];if(Math.abs(delta)<.18)return;
 const yaw=await page.evaluate(()=>__universe.getCamera().yaw),desired={x:axis==='x'?Math.sign(delta):0,z:axis==='z'?Math.sign(delta):0};
 const candidates=[['w'],['a'],['s'],['d'],['w','a'],['w','d'],['s','a'],['s','d']].map(keys=>{let x=+(keys.includes('d'))-+(keys.includes('a')),z=+(keys.includes('s'))-+(keys.includes('w'));const n=Math.hypot(x,z);x/=n;z/=n;const world={x:-Math.sin(yaw)*x+Math.cos(yaw)*z,z:Math.cos(yaw)*x+Math.sin(yaw)*z};return {keys,score:world.x*desired.x+world.z*desired.z};}).sort((a,b)=>b.score-a.score);
 assert(candidates[0].score>.98,'Camera reset should permit cardinal native key chords');
 try{for(const key of candidates[0].keys)await page.keyboard.down(key);await page.waitForFunction(({axis,target,sign})=>sign*(__universe.getState().position[axis]-target)>=0,{axis,target,sign:Math.sign(delta)},{timeout:20000});}finally{for(const key of candidates[0].keys)await page.keyboard.up(key);}
 await settled(page);return position(page);
}
async function capture(page,name){await page.screenshot({path:new URL(name+'.png',out).pathname,timeout:60000});}
async function makeBrowserPage(label,storageState){
 const browser=await launch();browsers.push(browser);const context=await browser.newContext({viewport:{width:1280,height:850},hasTouch:true,permissions:[],...(storageState?{storageState}:{})});contexts.push(context);
 const page=await context.newPage();pages.push({label,page});page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(60000);
 page.on('pageerror',error=>errors.push({label,message:error.message}));page.on('console',message=>{if(message.text()==='QA_FORBIDDEN_DEVICE_CAPTURE')errors.push({label,message:'Unexpected media capture request'});});
 page.on('request',request=>{const url=new URL(request.url());if(url.pathname==='/api/proximity-controls/action'||url.pathname==='/api/proximity-controls')requests.push({label,path:url.pathname,method:request.method(),body:request.postDataJSON(),at:Date.now()});});
 await page.addInitScript(()=>{for(const method of ['getUserMedia','getDisplayMedia'])if(navigator.mediaDevices?.[method])navigator.mediaDevices[method]=async()=>{console.error('QA_FORBIDDEN_DEVICE_CAPTURE');throw Error('No device capture allowed in this test');};});
 return {browser,context,page};
}
async function enter(page,name){await page.bringToFront();await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!!window.__universe&&!document.querySelector('#join-button')?.disabled,null,{timeout:90000});if(await page.locator('#welcome').isVisible()){await page.locator('#display-name').fill(name);await page.locator('#join-button').click();}await page.waitForFunction(()=>__universe.getState().ready,null,{timeout:90000});await page.locator('#welcome').waitFor({state:'hidden'});await page.waitForFunction(()=>typeof __universe.getProximityControls==='function'&&typeof __universe.getFollowMotion==='function');await gameplay(page);}
function apiFixture(label,cookie=''){return {label,cookie,async call(path,method='GET',body){const response=await fetch(base+path,{method,headers:{...(this.cookie?{cookie:this.cookie}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});const set=response.headers.get('set-cookie');if(set)this.cookie=set.split(';')[0];const data=await response.json();fixtures.push({label,path,method,status:response.status});return {status:response.status,data};}};}
async function holdFreshReads(page,{fetchFirst=false,abort=false}={}){
 let release,markReady,markDone,held=0,revision=null;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>markReady=resolve),done=new Promise(resolve=>markDone=resolve);
 const route=async route=>{if(held)return route.continue();held++;try{const response=fetchFirst?await route.fetch():null;if(response)revision=(await response.json()).snapshotRevision;markReady();await gate;if(abort)await route.abort('failed');else if(response)await route.fulfill({response});else await route.continue();}finally{markDone();}};
 await page.route('**/api/proximity-controls?*',route);const finish=async()=>{release();if(held)await done;await page.unroute('**/api/proximity-controls?*',route);};heldReleases.push(finish);return {get held(){return held;},get revision(){return revision;},ready,finish};
}
async function unchangedAcrossFrames(page,before,count=8){await frames(page,count);const after=await position(page);assert(distance(before,after)<.025,`Unexpected displacement ${JSON.stringify({before,after})}`);}
async function assertReachable(page,locator,cdp){
 for(let attempt=0;attempt<10;attempt++){
  const shape=await locator.evaluate(node=>{const r=node.getBoundingClientRect(),root=node.closest('.proximity-controls'),clip=root.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {label:node.getAttribute('aria-label'),rect:r.toJSON(),clip:clip.toJSON(),width:innerWidth,height:innerHeight,hit:node===hit||node.contains(hit),documentWidth:document.documentElement.scrollWidth};});
  if(shape.hit&&shape.rect.x>=0&&shape.rect.right<=shape.width&&shape.rect.y>=0&&shape.rect.bottom<=shape.height&&shape.rect.y>=shape.clip.y-.5&&shape.rect.bottom<=shape.clip.bottom+.5){assert(shape.rect.width>=48&&shape.rect.height>=48,JSON.stringify(shape));assert(shape.documentWidth<=shape.width,JSON.stringify(shape));layouts.push(shape);return shape;}
  const x=shape.clip.x+8,top=Math.max(2,shape.clip.y+8),bottom=Math.min(shape.height-2,shape.clip.bottom-8),up=shape.rect.bottom>shape.clip.bottom,start=up?bottom:top,end=up?top:bottom;
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x,y:start}]});for(let i=1;i<=5;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:1,x,y:start+(end-start)*i/5}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await frames(page,2);
 }
 throw Error('Native touch scrolling could not reach '+await locator.getAttribute('aria-label'));
}

try{
 ({context:aliceContext,page:alice}=await makeBrowserPage('Mira'));await enter(alice,names.alice);
 ({context:bobContext,page:bob}=await makeBrowserPage('Ari'));await enter(bob,names.bob);
 assert.notEqual(await alice.evaluate(()=>__universe.getState().user.id),await bob.evaluate(()=>__universe.getState().user.id));await readyControls(alice);await readyControls(bob);
 if(!targeted){
 await check('A confirmed authoritative Stop does not regress when its later HTTP acknowledgement is lost',async()=>{
  await nativeInvite(alice,bob,names.alice);await nativeAccept(bob,names.alice);let release,seen,continued;const gate=new Promise(resolve=>release=resolve),arrived=new Promise(resolve=>seen=resolve),done=new Promise(resolve=>continued=resolve);let responseStatus;
  const route=async route=>{if(route.request().postDataJSON()?.action==='stop'){const response=await route.fetch();responseStatus=response.status();seen();await gate;try{await route.abort('failed');}finally{continued();}}else await route.continue();};await bob.route('**/api/proximity-controls/action',route);const finish=async()=>{release();await done;await bob.unroute('**/api/proximity-controls/action',route);};heldReleases.push(finish);
  await followButton(bob).click();await arrived;assert.equal(responseStatus,200);await bob.waitForFunction(()=>!__universe.getProximityControls().context?.following&&!__universe.getProximityControls().stopUnconfirmed);assert.equal((await controls(bob)).motion,null);await finish();await bob.waitForFunction(()=>!__universe.getProximityControls().operation);const stopped=await controls(bob);assert.equal(stopped.stopUnconfirmed,false);assert.doesNotMatch(stopped.error,/unconfirmed|retry stop/i,'A later lost HTTP reply must not contradict the already observed authoritative Stop');assert.equal(stopped.motion,null);await alice.waitForFunction(()=>!__universe.getProximityControls().context.followers.length&&!__universe.getProximityControls().context.outgoingInvitations.length);assert.doesNotMatch(await alice.locator('.proximity-status').textContent(),/waiting.*accept/i,'The leader must not advertise pending consent after its invitations and followers have ended');await nativeStop(alice);
 });
 await check('Current guest locks, API-only outsider cannot join the bubble, current owner unlocks without membership churn',async()=>{
  assert.equal(await alice.evaluate(()=>__universe.getState().room.role),'owner');assert.notEqual(await bob.evaluate(()=>__universe.getState().room.role),'owner');
  const before=(await controls(bob)).context,lock=bob.getByRole('button',{name:'Lock nearby conversation',exact:true}),node=await lock.elementHandle();await lock.click();await bob.waitForFunction(()=>__universe.getProximityControls().context?.locked===true&&!__universe.getProximityControls().operation);
  const after=(await controls(bob)).context;for(const key of ['memberId','bubbleId','membershipRevision'])assert.equal(after[key],before[key]);assert.equal(await bob.getByRole('button',{name:'Unlock nearby conversation',exact:true}).evaluate((current,original)=>current===original,node),true);
  outsider=apiFixture('API-only synthetic outsider');assert.equal((await outsider.call('/api/session','POST',{name:'API-only outsider',woka:0})).status,201);assert.equal((await outsider.call('/api/rooms/commons/join','POST',{})).status,200);assert.equal((await outsider.call('/api/proximity-controls')).data.bubbleId,null);
  assert.equal((await controls(bob)).context.participants.length,2);await capture(bob,'actual-3d-locked-controls');await alice.getByRole('button',{name:'Unlock nearby conversation',exact:true}).click();await alice.waitForFunction(()=>__universe.getProximityControls().context?.locked===false&&!__universe.getProximityControls().operation);
  assert.equal((await outsider.call('/api/proximity-controls')).data.bubbleId,before.bubbleId);await outsider.call('/api/rooms/commons/leave','POST',{});await readyControls(alice);await readyControls(bob);await node.dispose();
 });
 }
 if(!targeted||replay==='consent'){
 await check('Named invitation is passive, preserves focus/camera/position, and native typing plus IME cannot accept',async()=>{
  await bob.locator('#dock-chat').click();const composer=bob.getByRole('textbox',{name:'Message the room',exact:true});await composer.fill('Keep this draft');await composer.press('Home');await composer.press('ArrowRight');await composer.press('Shift+ArrowRight');const before=await composer.evaluate(node=>({value:node.value,start:node.selectionStart,end:node.selectionEnd,position:__universe.getState().position,camera:__universe.getCamera()}));
  await nativeInvite(alice,bob,names.alice);assert.equal(await composer.evaluate(node=>document.activeElement===node),true);assert.equal((await controls(bob)).motion,null);assert.equal((await controls(bob)).followSpeedLimited,false);assert.deepEqual(await position(bob),before.position);const camera=await bob.evaluate(()=>__universe.getCamera());for(const key of cameraKeys)assert.deepEqual(camera[key],before.camera[key]);assert.deepEqual(await composer.evaluate(node=>({value:node.value,start:node.selectionStart,end:node.selectionEnd})),{value:before.value,start:before.start,end:before.end});
  const count=requests.filter(r=>r.label==='Ari'&&r.method==='POST').length;await composer.pressSequentially('fwasd');await composer.press('Shift+f');const cdp=await bobContext.newCDPSession(bob);await cdp.send('Input.imeSetComposition',{text:'編集中',selectionStart:3,selectionEnd:3});await composer.press('f');await composer.press('Enter');await cdp.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});assert.equal(requests.filter(r=>r.label==='Ari'&&r.method==='POST').length,count);assert.equal((await controls(bob)).motion,null);await unchangedAcrossFrames(bob,before.position);await bob.getByRole('button',{name:'Close social panel',exact:true}).click();await capture(bob,'actual-3d-named-invitation');
 });
 if(replay==='consent')await check('Prior passive invitation expires naturally before the independent Decline scenario',expirePriorInvitation);
 await check('Native Decline and Ignore enforce individual consent; F is one social edge and Shift F controls the camera',async()=>{
  await freshNativeInvite(alice,bob,names.alice);
  await declineButton(bob,names.alice).click();await bob.waitForFunction(()=>__universe.getProximityControls().invitations.length===0);await nativeStop(alice);
  await nativeInvite(alice,bob,names.alice);await gameplay(bob);const invitationId=(await controls(bob)).invitations[0].invitationId,commands=requests.filter(r=>r.label==='Ari'&&r.method==='POST').length;await bob.keyboard.press('f');await frames(bob,8);assert.equal((await controls(bob)).invitations[0]?.invitationId,invitationId,'Pinned source F leaves an unaccepted incoming invitation untouched');assert.equal(requests.filter(r=>r.label==='Ari'&&r.method==='POST').length,commands);assert.equal((await controls(bob)).context.following,null,'Gameplay F must never accept an invitation');assert.equal((await controls(bob)).motion,null);await declineButton(bob,names.alice).click();await bob.waitForFunction(()=>__universe.getProximityControls().invitations.length===0);await nativeStop(alice);
  const ignore=bob.getByRole('button',{name:'Ignore follow invitations',exact:true});await ignore.focus();await ignore.press('Space');await bob.waitForFunction(()=>__universe.getProximityControls().ignoreRequests&&!__universe.getProximityControls().operation);await followButton(alice).click();await alice.waitForFunction(()=>!__universe.getProximityControls().operation);assert.equal((await controls(bob)).invitations.length,0);assert.equal((await controls(bob)).motion,null);await nativeStop(alice);await ignore.press('Space');await bob.waitForFunction(()=>!__universe.getProximityControls().ignoreRequests&&!__universe.getProximityControls().operation);
  await gameplay(alice);const camera=await alice.evaluate(()=>__universe.getCamera()),count=requests.filter(r=>r.label==='Mira'&&r.body?.action==='invite').length;await alice.keyboard.down('f');await acceptButton(bob,names.alice).waitFor();await alice.keyboard.down('f');await alice.keyboard.down('f');await frames(alice,5);await alice.keyboard.up('f');assert.equal(requests.filter(r=>r.label==='Mira'&&r.body?.action==='invite').length,count+1);assert.equal((await controls(alice)).canStop,true);assert.equal((await alice.evaluate(()=>__universe.getCamera())).follow,camera.follow);
  await alice.keyboard.press('Shift+f');await alice.waitForFunction(value=>__universe.getCamera().follow!==value,camera.follow);assert.equal((await controls(alice)).canStop,true);await alice.keyboard.press('Shift+f');
 });
 if(replay==='consent')await check('Prior shortcut invitation expires naturally before the independent Accept scenario',expirePriorInvitation);
 await check('Live updates retain Accept identity; native held Enter accepts once without opening Express',async()=>{
  await freshNativeInvite(alice,bob,names.alice);
  const accept=acceptButton(bob,names.alice),node=await accept.elementHandle();await accept.focus();const revision=(await controls(bob)).context.snapshotRevision;await gameplay(alice);await alice.keyboard.press('r');await bob.waitForFunction(revision=>__universe.getProximityControls().context.snapshotRevision>revision,revision);assert.equal(await accept.evaluate((current,original)=>current===original&&document.activeElement===current,node),true);
  const count=requests.filter(r=>r.label==='Ari'&&r.body?.action==='accept').length;await bob.keyboard.down('Enter');await bob.waitForFunction(()=>!!__universe.getProximityControls().context?.following);await frames(bob,8);await bob.keyboard.up('Enter');await frames(bob,3);assert.equal(requests.filter(r=>r.label==='Ari'&&r.body?.action==='accept').length,count+1);assert.equal(await bob.locator('.express-tray').isVisible(),false);await node.dispose();await gameplay(bob);await bob.waitForFunction(()=>__universe.getFollowMotion().armed);
 });
 }
 if(!targeted){
 await check('Accepted follower actually moves toward a moving leader, faces displacement and uses collision-safe scene coordinates',async()=>{
  const before=await position(bob);await walkAxis(alice,'z',-9);await bob.waitForFunction(start=>Math.hypot(__universe.getState().position.x-start.x,__universe.getState().position.z-start.z)>.8,before,{timeout:20000});const after=await position(bob),motion=await bob.evaluate(()=>__universe.getMotion()),leader=await position(alice);assert(after.z<before.z-.7);assert(distance(after,leader)<distance(before,leader));assert(canStand(seeds[0].rooms[0].scene,after.x,after.z));assert(Math.cos(motion.heading)*(after.z-before.z)+Math.sin(motion.heading)*(after.x-before.x)>0,'Avatar facing follows actual displacement');motionSamples.push({kind:'native-follow',before,after,leader,motion});await capture(bob,'actual-3d-following');
 });
 await check('Native Stop halts locally before a held server request and cannot rearm from later state',async()=>{
  const leaderWalk=walkAxis(alice,'z',-15);await bob.waitForFunction(()=>__universe.getMotion().speed>.5);let release,seen,continued;const gate=new Promise(resolve=>release=resolve),arrived=new Promise(resolve=>seen=resolve),done=new Promise(resolve=>continued=resolve);const route=async route=>{if(route.request().postDataJSON()?.action==='stop'){seen();await gate;try{await route.continue();}finally{continued();}}else await route.continue();};await bob.route('**/api/proximity-controls/action',route);const finish=async()=>{release();await done;await bob.unroute('**/api/proximity-controls/action',route);};heldReleases.push(finish);
  await followButton(bob).click();await arrived;assert.equal((await controls(bob)).motion,null);await settled(bob);const stopped=await position(bob);await unchangedAcrossFrames(bob,stopped);assert((await controls(bob)).context.following,'Server relation remains while request is deliberately held');await finish();await bob.waitForFunction(()=>!__universe.getProximityControls().context?.following);await leaderWalk;await unchangedAcrossFrames(bob,stopped);await nativeStop(alice);
 });
 for(const surface of ['Chat','Build','dialog'])await check(`Accepted follower pauses in ${surface}; closing requires a fresh current-authority response`,async()=>{
  await resetPair();await nativeInvite(bob,alice,names.bob);await nativeAccept(alice,names.bob);
  const open=surface==='Chat'?()=>alice.locator('#dock-chat').click():surface==='Build'?()=>alice.locator('#dock-build').click():()=>alice.locator('#shortcuts-help').click();const close=surface==='Chat'?()=>alice.getByRole('button',{name:'Close social panel',exact:true}).click():surface==='Build'?()=>alice.getByRole('button',{name:'Close editor',exact:true}).click():()=>alice.locator('#dialog-close').click();
  await open();await alice.waitForFunction(()=>__universe.getFollowMotion().paused);const paused=await position(alice);await walkAxis(bob,'z',-8);await unchangedAcrossFrames(alice,paused);assert((await controls(alice)).context.following,'Foreground state must retain room consent');
  const held=await holdFreshReads(alice,{fetchFirst:surface==='Chat',abort:surface==='Build'});await close();await gameplay(alice);await alice.waitForFunction(()=>__universe.getFollowMotion().pending);assert(held.held>0,'Resume must issue a new GET');await held.ready;let currentRevision=null;
  if(surface==='Chat'){assert(Number.isInteger(held.revision));await alice.waitForFunction(revision=>__universe.getProximityControls().context.snapshotRevision>revision,held.revision);currentRevision=(await controls(alice)).context.snapshotRevision;}
  await unchangedAcrossFrames(alice,paused);const readCount=requests.filter(r=>r.label==='Mira'&&r.method==='GET').length;await held.finish();await alice.waitForFunction(()=>__universe.getFollowMotion().armed);const additionalAuthorityReads=requests.filter(r=>r.label==='Mira'&&r.method==='GET').length-readCount;if(surface==='Chat')motionSamples.push({kind:'stale-resume-get-superseded-by-sse',heldSnapshotRevision:held.revision,newerSnapshotRevision:currentRevision,additionalAuthorityReads});if(surface==='Build'){assert(additionalAuthorityReads>=1,'A failed GET must retire its ticket and issue a bounded fresh retry');assert.equal((await controls(alice)).error,'','Confirmed retry must clear its own resolved refresh error');motionSamples.push({kind:'aborted-resume-get-retried',additionalAuthorityReads});}await alice.waitForFunction(before=>Math.hypot(__universe.getState().position.x-before.x,__universe.getState().position.z-before.z)>.4,paused,{timeout:15000});
 });
 await check('Stop stays natively reachable through Quick actions while Chat covers the contextual strip',async()=>{
  await alice.locator('#dock-chat').click();await alice.waitForFunction(()=>__universe.getFollowMotion().paused);const stopped=await position(alice);await alice.keyboard.press('Control+k');await alice.getByRole('combobox').fill('Stop following');const option=alice.getByRole('option').filter({hasText:'Stop following or leading'});assert.equal(await option.count(),1);await option.click();await alice.waitForFunction(()=>!__universe.getProximityControls().context?.following&&!__universe.getProximityControls().motion);await unchangedAcrossFrames(alice,stopped);assert.equal(await alice.locator('#social').isVisible(),true);await alice.getByRole('button',{name:'Close social panel',exact:true}).click();
 });
 await check('Direct following stops at the known wall instead of teleporting through it',async()=>{
  await resetPair();await nativeInvite(bob,alice,names.bob);await nativeAccept(alice,names.bob);await alice.locator('#dock-chat').click();await alice.waitForFunction(()=>__universe.getFollowMotion().paused);const before=await position(alice);await walkAxis(bob,'z',6);await walkAxis(bob,'x',8);await walkAxis(bob,'z',0);await unchangedAcrossFrames(alice,before);await alice.getByRole('button',{name:'Close social panel',exact:true}).click();await gameplay(alice);await alice.waitForFunction(()=>__universe.getState().position.x>3.35,null,{timeout:20000});const convergence=await settledAtWall(alice);const blocked=await position(alice);await unchangedAcrossFrames(alice,blocked,12);assert(blocked.x<3.551,JSON.stringify(blocked));assert(Math.abs(blocked.z)<2,'Fixture must hit the face of the wall');assert(canStand(seeds[0].rooms[0].scene,blocked.x,blocked.z));const leader=await position(bob);assert(distance(blocked,leader)>Math.sqrt(2000)/proximityFixture.sourceUnitsPerWorldUnit);assert((await controls(alice)).motion,'Collision must not erase consent');motionSamples.push({kind:'known-wall',before,blocked,leader,obstacle,convergence});await capture(alice,'actual-3d-follow-collision');
 });
 await check('Native room travel revokes accepted follow and old movement cannot revive',async()=>{
  await visit(alice,'The Studio','studio');await alice.waitForFunction(()=>!__universe.getProximityControls().context?.following);assert.equal((await controls(alice)).motion,null);assert.equal((await controller(alice)).armed,false);const stationary=await position(alice);await walkAxis(bob,'z',-5);await unchangedAcrossFrames(alice,stationary);await visit(alice,'The Commons','commons');
 });
 await check('Authenticated API access revocation clears native follower consent and local motion',async()=>{
  await resetPair();await nativeInvite(alice,bob,names.alice);await nativeAccept(bob,names.alice);const id=await bob.evaluate(()=>__universe.getState().user.id);const result=await alice.request.post(base+'/api/rooms/commons/moderate',{data:{userId:id,action:'kick'}});fixtures.push({label:'Authenticated owner access-revocation fixture',path:'/api/rooms/commons/moderate',method:'POST',status:result.status()});assert.equal(result.status(),200);await bob.waitForFunction(()=>!__universe.getState().ready);await bob.waitForFunction(()=>!__universe.getProximityControls().motion&&!__universe.getFollowMotion().armed);const after=await position(bob);await unchangedAcrossFrames(bob,after);assert.equal((await (await bob.request.get(base+'/api/proximity-controls')).json()).following??null,null);await visit(bob,'The Studio','studio');await visit(bob,'The Commons','commons');
 });
 }
 if(!targeted||replay==='observer'){
 await check('Separate authenticated session observes following without a lease, preserves position and cannot drive the shared avatar',async()=>{
  await resetPair();const username='group_'+randomUUID().replaceAll('-','').slice(0,16),password=randomUUID();const registered=await bob.request.post(base+'/api/account',{data:{username,password}});assert.equal(registered.status(),201);fixtures.push({label:'Ephemeral synthetic test-account registration',path:'/api/account',method:'POST',status:registered.status()});
  await nativeInvite(alice,bob,names.alice);await nativeAccept(bob,names.alice);await walkAxis(alice,'z',-8);await bob.waitForFunction(()=>__universe.getState().position.z< -3);
  // A zero-speed frame can still precede a newer leader sample and more valid
  // following. Pause through the native UI while retaining the accepted lease,
  // then measure an acknowledged stationary pose before the observer boots.
  await bob.locator('#dock-chat').click();await bob.waitForFunction(()=>__universe.getFollowMotion().paused);await settled(bob);
  const before=await position(bob),lease=(await controls(bob)).motion.leaseId,actor=await bob.evaluate(()=>({id:__universe.getState().user.id,...Object.fromEntries(['admissionId','admissionEpoch','admissionRevision'].map(key=>[key,__universe.getState()[key]]))}));
  await unchangedAcrossFrames(bob,before,12);await bob.waitForFunction(expected=>{const state=__universe.getState(),self=state.people.find(person=>person.id===state.user.id);return self&&!self.moving&&Math.hypot(self.x-expected.x,self.z-expected.z)<.025;},before);
  const baselineResponse=await bob.request.get(base+'/api/rooms/commons');assert.equal(baselineResponse.status(),200);const baseline=(await baselineResponse.json()).presence.find(person=>person.id===actor.id);assert(baseline);assert(distance(baseline,before)<.025,'The stable controller pose must be acknowledged before observer admission');assert.deepEqual(placementIdentity(baseline),placementIdentity(actor));
  const admissionSample={kind:'separate-session-admission-preservation',before,leader:await position(alice),baseline:{x:baseline.x,z:baseline.z,...placementIdentity(baseline)},lease};motionSamples.push(admissionSample);
  const session=apiFixture('Separate-session synthetic login');assert.equal((await session.call('/api/login','POST',{username,password})).status,200);const cookie=session.cookie.slice(session.cookie.indexOf('=')+1);const third=await makeBrowserPage('separate-session sibling',{cookies:[{name:'universe_session',value:cookie,domain:'127.0.0.1',path:'/',httpOnly:true,secure:false,sameSite:'Strict'}],origins:[]});
  const admissions=[];third.page.on('response',response=>{if(new URL(response.url()).pathname==='/api/rooms/commons/join'&&response.request().method()==='POST')admissions.push(response);});
  try{await enter(third.page,names.bob);const joinResponse=admissions.find(response=>response.request().postDataJSON()?.mode==='enter');assert(joinResponse,'The observer must use the real initial-enter request');const {arrival}=await joinResponse.json();Object.assign(admissionSample,{status:joinResponse.status(),arrival,after:await position(bob),observer:await position(third.page)});console.log('ADMISSION_PRESERVATION',JSON.stringify(admissionSample));assert.equal(joinResponse.status(),200);assert.equal(arrival.resumed,true);assert.deepEqual(placementIdentity(arrival),placementIdentity(baseline),'Secondary admission must preserve the controller admission identity');assert.deepEqual({x:arrival.x,z:arrival.z},{x:baseline.x,z:baseline.z},'Initial enter must preserve the acknowledged controller pose');assert.equal((await controller(bob)).paused,true);assert.equal(await third.page.evaluate(()=>__universe.getState().user.id),await bob.evaluate(()=>__universe.getState().user.id));await third.page.waitForFunction(()=>__universe.getProximityControls().followingReadOnly);const secondary=await controls(third.page);assert.equal(secondary.motion,null);assert.equal(secondary.context.following.controlling,false);assert.equal(secondary.context.following.leaseId,null);assert.equal((await controls(bob)).motion.leaseId,lease);assert(distance(await position(bob),before)<.1,'Secondary admission must preserve controlling position: '+JSON.stringify(admissionSample));await third.page.waitForFunction(expected=>Math.hypot(__universe.getState().position.x-expected.x,__universe.getState().position.z-expected.z)<.1,before);
   const stopped=await position(third.page);await gameplay(third.page);try{await third.page.keyboard.down('w');await frames(third.page,8);}finally{await third.page.keyboard.up('w');}await unchangedAcrossFrames(third.page,stopped);const admissionId=await third.page.evaluate(()=>__universe.getState().admissionId);assert(admissionId,'Observer must have a current placement before probing follow authorization');const response=await third.page.request.post(base+'/api/presence',{data:{roomId:'commons',admissionId,x:20,z:20,moving:true}});fixtures.push({label:'Separate-session unauthorized movement attempt',path:'/api/presence',method:'POST',status:response.status()});assert.equal(response.status(),409);assert.equal((await response.json()).code,'FOLLOW_CONTROLLED_ELSEWHERE');await readyControls(third.page);await followButton(third.page).click();await bob.waitForFunction(()=>!__universe.getProximityControls().context?.following&&!__universe.getProximityControls().motion);
  }finally{await third.context.close();await third.browser.close();}await bob.getByRole('button',{name:'Close social panel',exact:true}).click();await gameplay(bob);
 });
 }
 if(!targeted||replay==='secondary')await check('Same-cookie secondary browser observes a single controller; native sibling room travel retires the prior lease',async()=>{
  await resetPair();await nativeInvite(alice,bob,names.alice);await nativeAccept(bob,names.alice);const oldConnection=(await controls(bob)).context.connectionId,oldLease=(await controls(bob)).motion.leaseId;
  // Same accepted HTTP session in another process. This deliberately avoids the
  // same-process multi-WebGL bootstrap instability seen in this test runtime.
  const secondary=await makeBrowserPage('same-cookie sibling',await bobContext.storageState()),sibling=secondary.page;
  try{await enter(sibling,names.bob);assert.equal(await sibling.evaluate(()=>__universe.getState().user.id),await bob.evaluate(()=>__universe.getState().user.id));await sibling.waitForFunction(()=>__universe.getProximityControls().followingReadOnly);assert.equal((await controls(sibling)).motion,null);assert.equal((await controls(bob)).motion.leaseId,oldLease);assert.notEqual((await controls(sibling)).context.connectionId,oldConnection);await visit(sibling,'The Studio','studio');await bob.waitForFunction(()=>!__universe.getProximityControls().motion&&!__universe.getProximityControls().context?.following);await visit(sibling,'The Commons','commons');await bob.waitForFunction(old=>!!__universe.getProximityControls().context&&__universe.getProximityControls().context.connectionId!==old,oldConnection);}finally{await secondary.context.close();await secondary.browser.close();}await gameplay(bob);
 });
 if(!targeted||['secondary','touch'].includes(replay))await check('At 320px portrait and short landscape native touch can reach invitation, Lock, Ignore, Accept and Stop',async()=>{
  if(replay!=='touch')await resetPair();const cdp=await bobContext.newCDPSession(bob);
  for(const viewport of [{width:320,height:568},{width:568,height:320}]){
   await bob.setViewportSize(viewport);await frames(bob,6);
   const ignore=bob.getByRole('button',{name:'Ignore follow invitations',exact:true}),lock=bob.locator('[data-control="lock"]');
   await assertReachable(bob,ignore,cdp);await ignore.tap();await bob.waitForFunction(()=>__universe.getProximityControls().ignoreRequests&&!__universe.getProximityControls().operation);await ignore.tap();await bob.waitForFunction(()=>!__universe.getProximityControls().ignoreRequests&&!__universe.getProximityControls().operation);
   await assertReachable(bob,lock,cdp);await lock.tap();await bob.waitForFunction(()=>__universe.getProximityControls().context.locked&&!__universe.getProximityControls().operation);await lock.tap();await bob.waitForFunction(()=>!__universe.getProximityControls().context.locked&&!__universe.getProximityControls().operation);await nativeInvite(alice,bob,names.alice);
   for(const locator of [acceptButton(bob,names.alice),declineButton(bob,names.alice),bob.locator('[data-control="lock"]'),bob.getByRole('button',{name:'Ignore follow invitations',exact:true})])await assertReachable(bob,locator,cdp);
   await assertReachable(bob,followButton(bob),cdp);await followButton(bob).hover();
   // The shell inherits a native background transition. Read the completed
   // visual state rather than the transparent first frame of that transition.
   await bob.waitForFunction(()=>{const node=document.querySelector('.proximity-controls [data-control="follow"]');return node&&node.getAnimations().every(animation=>!animation.pending&&animation.playState!=='running');});
   const style=await followButton(bob).evaluate(node=>{const s=getComputedStyle(node);return {color:s.color,backgroundColor:s.backgroundColor,backgroundImage:s.backgroundImage,fontFamily:s.fontFamily,transition:s.transition,hoverCapable:matchMedia('(hover: hover)').matches,hovered:node.matches(':hover'),active:node.matches(':active'),animations:node.getAnimations().map(animation=>({playState:animation.playState,pending:animation.pending,currentTime:animation.currentTime})),outerHTML:node.outerHTML};});const ratio=contrast(style.color,style.backgroundColor);assert(ratio>=4.5,JSON.stringify({viewport,style,ratio}));layouts.push({kind:'settled-stop-contrast',viewport,...style,contrast:ratio});
   await assertReachable(bob,acceptButton(bob,names.alice),cdp);await capture(bob,`actual-3d-touch-invitation-${viewport.width}x${viewport.height}`);await acceptButton(bob,names.alice).tap();await bob.waitForFunction(()=>!!__universe.getProximityControls().context?.following);await assertReachable(bob,followButton(bob),cdp);await followButton(bob).tap();await bob.waitForFunction(()=>!__universe.getProximityControls().context?.following&&!__universe.getProximityControls().canStop);await nativeStop(alice);
  }
  await bob.setViewportSize({width:1280,height:850});
 });
 await check('No page errors, no device permissions, and no media provider is configured',async()=>{for(const page of [alice,bob])assert.equal((await (await page.request.get(base+'/api/media')).json()).enabled,false);assert.deepEqual(errors,[]);});
}catch(error){
 checks.push({name:phase,status:'failed',error:error.stack});process.exitCode=1;console.error('FAIL',phase,error);
 for(const {label,page} of pages)if(!page.isClosed()){
  const diagnostic=await page.evaluate(()=>({ready:window.__universe?.getState().ready,room:window.__universe?.getState().room?.id,position:window.__universe?.getState().position,motion:window.__universe?.getMotion(),controls:window.__universe?.getProximityControls?.(),followMotion:window.__universe?.getFollowMotion?.(),camera:window.__universe?.getCamera(),active:document.activeElement?.outerHTML?.slice(0,200),surface:history.state,toast:document.querySelector('#toast')?.textContent})).catch(error=>({error:error.message}));console.error('DIAGNOSTIC',label,JSON.stringify(diagnostic));await capture(page,'failure-'+label.replace(/[^a-z0-9]/gi,'-')).catch(()=>{});
 }
}finally{
 for(const release of heldReleases)await release().catch(()=>{});
 const afterHashes=await hashes(),unchanged=beforeHashes.combined===afterHashes.combined;
 if(!unchanged){checks.push({name:'Exact source and bundle hashes unchanged throughout run',status:'failed'});process.exitCode=1;}else checks.push({name:'Exact source and bundle hashes unchanged throughout run',status:'passed'});
 await writeFile(new URL(replay==='consent'?'results-consent.json':replay==='observer'?'results-observer.json':replay==='touch'?'results-touch.json':targeted?'results-secondary.json':'results.json',out),JSON.stringify({status:process.exitCode?'failed':'passed',mode:replay==='consent'?'native consent with expired case handoffs':replay==='observer'?'separate-session observer replay only':replay==='touch'?'touch-only replay':targeted?'same-cookie and touch replay only':'full native suite',scope:'Actual bundled 3D shell, separate Chromium processes, native keyboard/pointer/touch, isolated memory SQLite and opt-in test membership configuration. API-only outsider/access fixtures are labeled when used. No actual devices, live providers, physical phones or deployment claimed.',checks,errors,hashes:{before:beforeHashes,after:afterHashes,unchanged},fixtures,requests,layouts,motionSamples,configuration:{proximityMembershipConfig:proximityFixture,database:':memory:',scene:{spawn:{x:0,z:0},bounds:{width:48,depth:40},obstacle}},browserVersions:await Promise.all(browsers.map(browser=>browser.version()))},null,2));
 for(const context of contexts)await context.close().catch(()=>{});for(const browser of browsers)await browser.close().catch(()=>{});await app.close();
}
