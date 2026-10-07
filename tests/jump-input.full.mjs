/** Native jump ownership through the bundled shell and real local public authority.
 * Signup, keyboard, pointer, and CDP touch events follow normal UI paths.
 * App diagnostics are read-only; no direct game focus or motion setters.
 * JUMP_DIST selects an immutable pre-fix bundle. JUMP_FOCUS_ONLY=1 runs the
 * desktop regression only. JUMP_CAPTURE=1 captures its native rising avatar.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../server/store.mjs';
import {bootstrapOwner} from '../server/operator-accounts.mjs';
import {createGameServer} from '../server/app.mjs';
import {readRuntimeConfig} from '../server/runtime-config.mjs';
import {launch} from '../scripts/browser.mjs';

const out=process.env.JUMP_EVIDENCE||'evidence/jump-input-regression';
await mkdir(out,{recursive:true});
const folder=await mkdtemp(join(tmpdir(),'jump-input-'));
const database=join(folder,'synthetic.sqlite'),password='synthetic jump test password';
const scene={version:1,theme:'garden',bounds:{width:24,depth:22},spawn:{x:0,z:6},areas:[],objects:[]};
const seeds=[{id:'universe',name:'Synthetic Universe',rooms:[{id:'commons',name:'Jump Commons',scene}]}];
const checks=[],errors=[];
let failures=0,browser,context,page,app,base;
const snap=()=>page.evaluate(()=>({
 position:__universe.getState().position,motion:__universe.getMotion(),camera:__universe.getCamera(),
 focus:{id:document.activeElement?.id,tag:document.activeElement?.tagName},
 dialog:!document.querySelector('#dialog').hidden,ready:__universe.getState().ready
}));

async function record(name,action){
 const before=await snap();
 await page.evaluate(()=>{
  window.jumpSamples=[];window.jumpObservationActive=true;
  function sample(){jumpSamples.push({t:performance.now(),...__universe.getState().position});if(window.jumpObservationActive)requestAnimationFrame(sample);}
  sample();
 });
 try{await action();await page.waitForTimeout(1650);}
 finally{await page.evaluate(()=>{window.jumpObservationActive=false;});}
 const after=await snap(),samples=await page.evaluate(()=>jumpSamples);
 const result={name,before,after,apex:Math.max(...samples.map(s=>s.y)),samples};
 checks.push(result);
 console.log(JSON.stringify({name,beforeFocus:before.focus,afterFocus:after.focus,apex:result.apex,before:before.position,after:after.position,camera:after.camera,dialog:after.dialog}));
 return result;
}
async function enter(viewport){
 await context?.close();
 context=await browser.newContext({viewport,hasTouch:viewport.width<800,isMobile:viewport.width<800});
 page=await context.newPage();page.setDefaultTimeout(25000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);
 await page.locator('#open-signup').click();
 await page.locator('#signup-name').fill('Jump Visitor');
 await page.locator('#signup-email').fill(`jump-${viewport.width}@example.test`);
 await page.locator('#signup-password').fill(password);await page.locator('#signup-confirm').fill(password);
 await page.locator('#signup-submit').click();
 await page.waitForFunction(()=>window.__universe?.getState().ready);
 const no=page.getByRole('button',{name:'Not now',exact:true});if(await no.isVisible())await no.click();
 await page.waitForTimeout(300);await page.screenshot({path:`${out}/${viewport.width}-fresh.png`});
 const rects=await page.evaluate(()=>Object.fromEntries(['jump-button','joystick','movement-side-toggle','controls-hint'].map(id=>{
  const n=document.getElementById(id),r=n.getBoundingClientRect(),s=getComputedStyle(n);
  return[id,{x:r.x,y:r.y,width:r.width,height:r.height,display:s.display,visibility:s.visibility,hidden:n.hidden,hit:r.width?document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.id:null}];
 })));
 checks.push({name:`${viewport.width} visible controls`,rects});console.log(JSON.stringify({viewport,rects}));
}
async function test(name,run){
 try{await run();checks.push({name,status:'passed'});console.log('PASS',name);}
 catch(error){
  failures++;checks.push({name,status:'failed',error:error.stack});console.error('FAIL',name,error.message);
  await page.screenshot({path:out+'/failure-'+failures+'.png'}).catch(()=>{});
  if(await page.locator('#dialog').isVisible())await page.locator('#dialog-close').click();
 }
}
function isJump(result){assert(result.apex>1.2,'Native input must lift avatar above y1.2');assert.equal(result.after.position.y,0,'Avatar lands back on floor');assert.equal(result.after.motion.grounded,true);}
function still(result){assert.equal(result.apex,result.before.position.y);assert.deepEqual(result.after.position,result.before.position);}
async function moveJump(key='w',capture=false){
 await page.keyboard.down(key);
 try{
  await page.waitForTimeout(150);await page.keyboard.press('Space');
  if(capture){await page.waitForFunction(()=>__universe.getState().position.y>1.1,null,{timeout:2200});await page.screenshot({path:out+'/desktop-moving-jump.png'});}
  else await page.waitForTimeout(80);
 }finally{await page.keyboard.up(key);}
}
async function gesture(side,width){
 const box=await page.locator('#joystick').boundingBox(),jump=await page.locator('#jump-button').boundingBox();
 const center={id:1,x:box.x+box.width/2,y:box.y+box.height/2},finger={...center,y:center.y-26};
 const world=width===320?[{id:2,x:110,y:220},{id:3,x:170,y:220}]:[{id:2,x:250,y:180},{id:3,x:310,y:180}];
 for(const point of world)assert.equal(await page.evaluate(p=>document.elementFromPoint(p.x,p.y)?.id,point),'game','Camera finger starts on canvas');
 const jumpFinger={id:4,x:jump.x+jump.width/2,y:jump.y+jump.height/2},cdp=await context.newCDPSession(page),before=await snap();
 await page.evaluate(()=>{
  window.nativeJumpEvents=[];if(window.nativeJumpCapture)return;
  const capture=window.nativeJumpCapture=e=>nativeJumpEvents.push({type:e.type,id:e.pointerId,target:e.target.id,trusted:e.isTrusted,pointerType:e.pointerType});
  for(const type of ['pointerdown','pointerup','pointercancel'])document.addEventListener(type,capture,true);
 });
 try{
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[center]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[finger]});
  await page.waitForFunction(()=>__universe.getMotion().speed>.2);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[finger,...world]});
  const moved=world.map(p=>({...p,x:p.x+18}));
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[finger,...moved]});
  await page.waitForFunction(yaw=>Math.abs(__universe.getCamera().yaw-yaw)>.02,before.camera.yaw);
  const result=await record(`${width} ${side} simultaneous joystick + two-finger camera + Jump`,async()=>{
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[finger,...moved,jumpFinger]});
   await page.waitForFunction(()=>__universe.getState().position.y>0&&__universe.getMotion().speed>0);
   await page.screenshot({path:`${out}/${width}-${side}-moving-jump.png`});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  });
  isJump(result);assert(Math.hypot(result.after.position.x-before.position.x,result.after.position.z-before.position.z)>.1);
  assert.equal(result.after.motion.speed,0);
  assert.deepEqual(await page.evaluate(()=>__universe.getPath()),[],'Camera and Jump cannot fall through to walking destination');
  const events=await page.evaluate(()=>nativeJumpEvents);
  assert(events.every(e=>e.trusted&&e.pointerType==='touch'));
  assert.equal(events.filter(e=>e.type==='pointerdown'&&e.target==='game').length,2);
  assert.equal(events.filter(e=>e.type==='pointerdown'&&e.target==='jump-button').length,1);
  assert.equal(events.filter(e=>e.type==='pointerdown'&&['joystick','joystick-thumb'].includes(e.target)).length,1);
  checks.push({name:`${width} ${side} pointer ownership`,events});
 }finally{await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}).catch(()=>{});await cdp.detach();}
}

try{
 const store=new Store(database,seeds);await bootstrapOwner(store,{name:'Synthetic owner',username:'synthetic_owner',password});store.close();
 const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
 const port=probe.address().port;await new Promise(r=>probe.close(r));base=`http://127.0.0.1:${port}`;
 const config=readRuntimeConfig({UNIVERSE_MODE:'public',UNIVERSE_BIND_ADDRESS:'127.0.0.1',PORT:String(port),UNIVERSE_DB:database,UNIVERSE_ALLOWED_HOSTS:`127.0.0.1:${port}`,UNIVERSE_ALLOWED_ORIGINS:`https://127.0.0.1:${port}`,UNIVERSE_TLS_MODE:'external',UNIVERSE_COOKIE_SECURE:'always',UNIVERSE_REGISTRATION_MODE:'open'});
 // Sole fixture override: native loopback HTTP Origin. Public guards, Secure
 // cookies, signup/login and room authority are the real application paths.
 app=createGameServer({database,seeds,dist:resolve(process.env.JUMP_DIST||'dist'),runtimeConfig:Object.freeze({...config,allowedOrigins:Object.freeze([base])})});
 await app.listen(port);browser=await launch();
 await enter({width:1280,height:800});
 await test('Fresh signup naturally focuses world; Space jumps and lands',async()=>isJump(await record('desktop fresh Space',()=>page.keyboard.press('Space'))));
 await test('Zoom → W+Space transfers accepted movement to world and jumps',async()=>{
  await page.locator('#zoom-in').click();const result=await record('desktop Zoom W+Space',()=>moveJump('w',process.env.JUMP_CAPTURE==='1'));
  isJump(result);assert.equal(result.after.focus.id,'game');assert.equal(result.after.camera.distance,result.before.camera.distance);
 });
 await test('Zoom → ArrowUp+Space transfers accepted movement to world and jumps',async()=>{await page.locator('#zoom-in').click();isJump(await record('desktop Zoom ArrowUp+Space',()=>moveJump('ArrowUp')));});
 await test('Tab-focused camera button retains native Space activation without movement',async()=>{
  await page.locator('#zoom-in').click();await page.keyboard.press('Tab');const result=await record('desktop keyboard button Space',()=>page.keyboard.press('Space'));
  still(result);assert.equal(result.before.focus.id,'zoom-out');assert.equal(result.after.focus.id,'zoom-out');assert.equal(result.after.camera.distance,result.before.camera.distance+2);
 });
 await test('Modal blocks movement; after close W+Space returns to world',async()=>{
  await page.locator('#shortcuts-help').click();still(await record('desktop modal W+Space',()=>moveJump()));
  if(await page.locator('#dialog').isVisible())await page.locator('#dialog-close').click();
  isJump(await record('desktop after modal close W+Space',()=>moveJump()));
 });
 await test('Typing owns Space and movement; closing chat then W+Space recovers',async()=>{
  await page.locator('#dock-chat').click();const field=page.locator('#social textarea').first();await field.fill('Private draft');const before=await field.inputValue();
  still(await record('desktop typing W Space',()=>page.keyboard.type('w ')));assert.equal(await field.inputValue(),before+'w ');
  await page.getByRole('button',{name:'Close social panel',exact:true}).click();isJump(await record('desktop after chat close W+Space',()=>moveJump()));
 });
 for(const viewport of(process.env.JUMP_FOCUS_ONLY?[]:[{width:320,height:568},{width:667,height:375}])){
  await enter(viewport);
  await test(`${viewport.width} Jump target visible and native tap jumps`,async()=>{
   const b=await page.locator('#jump-button').boundingBox();assert(b&&b.width>=44&&b.height>=44&&b.y>=0&&b.y+b.height<=viewport.height);
   assert.equal(await page.evaluate(b=>document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)?.id,b),'jump-button');
   isJump(await record(`${viewport.width} fresh Jump tap`,()=>page.locator('#jump-button').tap()));
  });
  await test(`${viewport.width} right four-pointer gesture keeps ownership`,()=>gesture('right',viewport.width));
  await test(`${viewport.width} swap sides then native Jump works`,async()=>{await page.locator('#movement-side-toggle').tap();isJump(await record(`${viewport.width} side swap Jump`,()=>page.locator('#jump-button').tap()));});
  await test(`${viewport.width} left four-pointer gesture keeps ownership`,()=>gesture('left',viewport.width));
  await test(`${viewport.width} held Jump cannot repeat on landing/release`,async()=>{
   const box=await page.locator('#jump-button').boundingBox(),cdp=await context.newCDPSession(page);
   try{
    isJump(await record(`${viewport.width} held Jump`,async()=>{await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x:box.x+box.width/2,y:box.y+box.height/2}]});}));
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});still(await record(`${viewport.width} after held Jump release`,async()=>{}));
   }finally{await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}).catch(()=>{});await cdp.detach();}
  });
  await test(`${viewport.width} typing blocked; native close and Jump recover`,async()=>{
   await page.locator('#dock-chat').tap();await page.locator('#social textarea').first().fill('Touch draft');still(await record(`${viewport.width} typing Space`,()=>page.keyboard.press('Space')));
   await page.getByRole('button',{name:'Close social panel',exact:true}).tap();isJump(await record(`${viewport.width} Jump after typing`,()=>page.locator('#jump-button').tap()));
  });
  await test(`${viewport.width} More menu blocks world; side button movement focus recovers`,async()=>{
   await page.locator('#dock-more').tap();still(await record(`${viewport.width} More W Space`,()=>moveJump()));await page.keyboard.press('Escape');
   await page.locator('#movement-side-toggle').tap();isJump(await record(`${viewport.width} side button W+Space`,()=>moveJump()));
  });
 }
 assert.deepEqual(errors,[]);
}catch(error){console.error(error);checks.push({name:'fatal',error:error.stack});failures++;await page?.screenshot({path:out+'/failure.png'}).catch(()=>{});}
finally{
 await writeFile(out+'/results.json',JSON.stringify({checks,errors,failures,limits:['Synthetic loopback public authority with real signup/login and native browser input','No game state setters or artificial game focus','No live-host or physical-device claim']},null,2));
 await browser?.close();await app?.close();await rm(folder,{recursive:true,force:true});if(failures)process.exitCode=1;
}
