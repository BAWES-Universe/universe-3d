import {CAMERA_LIMITS} from '../src/camera-rig.js';
import {build}from'esbuild';import{mkdtemp,cp,rm,writeFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import assert from'node:assert/strict';import{launch}from'../scripts/browser.mjs';import{seedWorlds}from'../src/worlds.js';import{createGameServer}from'../server/app.mjs';
const touchChecks=[];
const dir=await mkdtemp(join(tmpdir(),'universe-camera-walk-'));await cp('public',dir,{recursive:true});await build({entryPoints:['src/main.js'],outdir:dir,bundle:true,format:'esm',splitting:true,minify:true,target:'es2022'});
const app=createGameServer({seeds:seedWorlds,dist:dir}),address=await app.listen(0),browser=await launch(),page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(60000);const check=name=>{checks.push({name,status:'passed'});console.log('PASS',name)};
try{await page.goto('http://127.0.0.1:'+address.port,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!!window.__universe,{},{timeout:60000});await page.getByPlaceholder('Your name').fill('Garden explorer');await page.getByRole('button',{name:'Enter Universe'}).click();await page.waitForFunction(()=>window.__universe?.getState().ready);await page.waitForTimeout(400);const no=page.getByRole('button',{name:'Not now',exact:true});if(await no.isVisible())await no.click();await page.locator('#game').focus();
async function assertLabelsClear(){const data=await page.evaluate(()=>{const boxes=[...document.querySelectorAll('#hud > .brand, #hud > .room-heading, #hud > .hud-right, #quest-open, #area-banner, #view-controls, #dock, #quick-actions, #shortcuts-help')].filter(e=>!e.hidden&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden').map(e=>e.getBoundingClientRect());const all=[...document.querySelectorAll('.world-label')],visible=all.filter(e=>getComputedStyle(e).visibility==='visible'&&getComputedStyle(e).display!=='none');return{visible:visible.length,hidden:all.length-visible.length,overlaps:visible.filter(e=>{const r=e.getBoundingClientRect();return boxes.some(b=>r.left<b.right+8&&r.right>b.left-8&&r.top<b.bottom+8&&r.bottom>b.top-8)}).map(e=>e.textContent)}});assert.deepEqual(data.overlaps,[]);return data;}
async function cameraAction(direct,menu){const button=page.getByRole('button',{name:direct,exact:true});if(await button.isVisible())await button.click();else{await page.locator('#dock-more').click();await page.locator('#shell-more').getByRole('button',{name:menu,exact:true}).click();}}
let suppressed=0;for(const size of[{width:1280,height:800},{width:390,height:844}]){await page.setViewportSize(size);await page.waitForTimeout(200);for(let i=0;i<8;i++){await cameraAction('Orbit camera right','Orbit right');if(i===3)await cameraAction('Tilt camera down','Tilt down');await page.waitForTimeout(120);const result=await assertLabelsClear();suppressed+=result.hidden;}await page.screenshot({path:`evidence/finishing-hud-labels-${size.width<700?'mobile':'desktop'}.png`});}assert(suppressed>0);check('measured label bounds avoid actual HUD rectangles across desktop/mobile camera orbits');await page.setViewportSize({width:1280,height:800});await page.getByRole('button',{name:'Reset camera',exact:true}).click();await page.waitForTimeout(250);await page.screenshot({path:'evidence/finishing-integrated-arrival.png'});

const before=await page.evaluate(()=>window.__universe.getState().position);await page.keyboard.down('w');await page.waitForTimeout(900);await page.keyboard.up('w');await page.screenshot({path:'evidence/textured-native-walking-desktop.png'});await page.waitForTimeout(500);const after=await page.evaluate(()=>window.__universe.getState().position);assert(Math.hypot(after.x-before.x,after.z-before.z)>1);check('actual WASD walk moves native character through textured Commons');
const oldCamera=await page.evaluate(()=>window.__universe.getCamera());await page.mouse.move(780,320);await page.mouse.down({button:'right'});await page.mouse.move(980,360,{steps:10});await page.mouse.up({button:'right'});await page.waitForTimeout(250);const orbit=await page.evaluate(()=>({camera:window.__universe.getCamera(),position:window.__universe.getState().position}));assert(Math.abs(orbit.camera.yaw-oldCamera.yaw)>.4);assert(Math.hypot(orbit.position.x-after.x,orbit.position.z-after.z)<.01);check('right-drag orbit changes 3D view without walking');await page.screenshot({path:'evidence/textured-native-orbit-desktop.png'});
await page.locator('#dock-build').click();const pose=await page.evaluate(()=>window.__universe.getCamera());assert(Math.abs(pose.yaw-orbit.camera.yaw)<.01);check('actual Build entry retains the current orbit');await page.locator('#editor [data-tool="chair"]').click();const count=await page.evaluate(()=>window.__universe.getState().scene.objects.length);await page.mouse.move(790,310);await page.mouse.down({button:'right'});await page.mouse.move(630,350,{steps:8});await page.mouse.up({button:'right'});await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>window.__universe.getState().scene.objects.length),count);check('camera orbit with armed furniture tool never drops an object');await page.screenshot({path:'evidence/textured-native-builder-orbit.png'});
// Touch capability changes chrome sizes. Enable it before waiting for the actual
// compact layout; an old fixed point can belong to a camera button, not the world.
const touch=await page.context().newCDPSession(page);
await touch.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
for(const width of [390,320]){
 await page.setViewportSize({width,height:844});
 await page.waitForFunction(width=>{
  const editor=document.querySelector('#editor'),canvas=document.querySelector('#game'),r=canvas.getBoundingClientRect();
  return window.__universe?.getState().ready&&matchMedia('(pointer:coarse)').matches&&innerWidth===width&&innerHeight===844&&r.width===width&&r.height===844&&!editor.hidden&&editor.dataset.compact==='true'&&editor.dataset.sheet==='none';
 },width);
 const gesture=await page.evaluate(()=>{
  const canvas=document.querySelector('#game'),r=canvas.getBoundingClientRect(),x=Math.round(r.left+r.width/2);
  // Test the whole outward/upward path, not just the canvas's bounding box:
  // the full-size canvas continues underneath the editor and camera controls.
  for(const fraction of [.5,.55,.6,.45,.4]){
   const y=Math.round(r.top+r.height*fraction),start=[{id:11,x:x-60,y},{id:12,x:x+60,y}],end=[{id:11,x:x-95,y:y-30},{id:12,x:x+100,y:y-30}];
   const path=start.flatMap((p,i)=>Array.from({length:11},(_,step)=>({x:p.x+(end[i].x-p.x)*step/10,y:p.y+(end[i].y-p.y)*step/10})));
   if(path.every(p=>document.elementFromPoint(p.x,p.y)===canvas))return{start,end};
  }
  throw Error('No unobstructed world path for the armed-furniture pinch');
 });
 const touchBefore=await page.evaluate(()=>({camera:window.__universe.getCamera(),editor:window.__universe.getEditor(),position:window.__universe.getState().position}));
 assert.equal(touchBefore.editor.tool,'chair','Furniture stays armed throughout the camera gesture');
 assert(touchBefore.camera.distance>CAMERA_LIMITS.minDistance,'Pinch starts above the zoom clamp');
 await page.evaluate(()=>{window.__cameraTouchTargets=[];const record=e=>{if(e.pointerType==='touch')window.__cameraTouchTargets.push({type:e.type,target:e.target.id,pointerId:e.pointerId});};for(const type of ['pointerdown','pointerup'])document.addEventListener(type,record,{capture:true});window.__stopCameraTouchRecording=()=>{for(const type of ['pointerdown','pointerup'])document.removeEventListener(type,record,true);};});
 await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:gesture.start});
 await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:gesture.end});
 await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await page.waitForFunction(distance=>window.__universe.getCamera().distance<distance,touchBefore.camera.distance);
 const touchAfter=await page.evaluate(()=>{window.__stopCameraTouchRecording();return{camera:window.__universe.getCamera(),editor:window.__universe.getEditor(),count:window.__universe.getState().scene.objects.length,position:window.__universe.getState().position,targets:window.__cameraTouchTargets};});
 assert(touchAfter.camera.distance<touchBefore.camera.distance);
 assert(Math.abs(touchAfter.camera.tilt-touchBefore.camera.tilt)>.01,'Pinch centroid also orbits the camera');
 assert.equal(touchAfter.count,count);
 assert.equal(touchAfter.editor.tool,'chair');
 assert.equal(touchAfter.editor.dirty,touchBefore.editor.dirty);
 assert.equal(touchAfter.editor.undo,touchBefore.editor.undo);
 assert.deepEqual(touchAfter.position,touchBefore.position);
 for(const type of ['pointerdown','pointerup']){const events=touchAfter.targets.filter(e=>e.type===type);assert.equal(events.length,2);assert(events.every(e=>e.target==='game'),'Both native touch pointers belong to the world');}
 touchChecks.push({width,gesture,before:touchBefore,after:touchAfter});
 check(`two-finger mobile pinch/orbit changes camera without placing armed furniture at ${width}px`);
 await page.screenshot({path:`evidence/textured-native-touch-camera-${width}.png`});
}


assert.deepEqual(errors,[]);await writeFile('evidence/camera-walkthrough-results.json',JSON.stringify({checks,errors,start:before,end:after,touchChecks},null,2));}catch(error){console.error(error);await page.screenshot({path:'evidence/camera-walkthrough-failure.png'}).catch(()=>{});await writeFile('evidence/camera-walkthrough-results.json',JSON.stringify({checks,errors,touchChecks,failure:error.stack},null,2));process.exitCode=1;}finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
