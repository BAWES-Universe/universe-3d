/** Native touch pointer ownership in actual input module; scene projection is a fixture. */
import {build} from 'esbuild';import {launch} from '../scripts/browser.mjs';import assert from 'node:assert/strict';import {mkdir,writeFile} from 'node:fs/promises';
const source=`import {mountWorldInput} from './src/world-input.js';window.log={movement:{x:0,z:0},walks:0,interactions:0,jumps:0,orbits:0,camera:[]};window.context={ready:true,building:false,modalOpen:false};const by=id=>document.getElementById(id);window.input=mountWorldInput({canvas:by('game'),joystickRoot:by('joystick'),joystickThumb:by('thumb'),getContext:()=>context,getRenderer:()=>({pick:(x,y)=>({point:{x,z:y}}),setGhost:()=>{},getCameraState:()=>({distance:25}),orbit:(x,y)=>{log.orbits++;log.camera.push(['orbit',x,y])},pan:(x,y)=>{log.orbits++;log.camera.push(['pan',x,y])},zoom:value=>log.camera.push(['zoom',value])}),getEditor:()=>null,onWalkTo:()=>log.walks++,onInteract:()=>{log.interactions++;return true},onJoystick:value=>log.movement=value});by('jump').addEventListener('pointerdown',e=>{e.preventDefault();e.stopPropagation();log.jumps++;});by('menu').onclick=()=>{context.modalOpen=true;input.cancel();};`;
const bundle=await build({stdin:{contents:source,resolveDir:process.cwd(),sourcefile:'input-multipointer-fixture.js'},bundle:true,format:'iife',write:false});
const browser=await launch(),ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
await mkdir('evidence',{recursive:true});
try{
 await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}#game{position:absolute;inset:0;width:390px;height:844px;touch-action:none}#joystick{position:absolute;right:15px;bottom:130px;width:96px;height:96px;touch-action:none;background:gray}#jump{position:absolute;left:15px;bottom:130px;width:60px;height:60px;touch-action:none}#menu{position:absolute;right:15px;top:15px}</style><canvas id="game" tabindex="0"></canvas><div id="joystick"><div id="thumb"></div></div><button id="jump">Jump</button><button id="menu">Menu</button>');await page.addScriptTag({content:bundle.outputFiles[0].text});
 const cdp=await ctx.newCDPSession(page);const touch=(type,points)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points});
 const move={id:1,x:350,y:656},camera={id:2,x:110,y:360},jump={id:3,x:40,y:680};
 await touch('touchStart',[move]);assert((await page.evaluate(()=>log.movement)).x>.2);
 await touch('touchStart',[move,camera]);await touch('touchMove',[move,{...camera,x:145,y:390}]);assert(await page.evaluate(()=>log.orbits>0));assert((await page.evaluate(()=>log.movement)).x>.2,'Camera drag cannot release movement');
 await touch('touchStart',[move,{...camera,x:145,y:390},jump]);assert.equal(await page.evaluate(()=>log.jumps),1);assert((await page.evaluate(()=>log.movement)).x>.2,'Jump cannot release movement');
 await touch('touchMove',[move]);assert((await page.evaluate(()=>log.movement)).x>.2,'Other fingers ending cannot release movement');assert.equal(await page.evaluate(()=>log.walks),0);assert.equal(await page.evaluate(()=>log.interactions),0);
 await touch('touchEnd',[]);assert.deepEqual(await page.evaluate(()=>log.movement),{x:0,z:0});
 await touch('touchStart',[move]);await page.locator('#joystick').dispatchEvent('pointerup',{pointerId:999,pointerType:'touch'});assert((await page.evaluate(()=>log.movement)).x>.2,'A foreign pointerup cannot release movement');
 await page.locator('#game').dispatchEvent('pointercancel',{pointerId:998,pointerType:'touch'});assert((await page.evaluate(()=>log.movement)).x>.2,'Camera cancellation cannot release independent movement');
 await page.evaluate(()=>{context.modalOpen=true;input.cancel()});assert.deepEqual(await page.evaluate(()=>log.movement),{x:0,z:0});await touch('touchEnd',[]);assert.equal(await page.evaluate(()=>log.walks),0);
 await page.evaluate(()=>{context.modalOpen=false});await touch('touchStart',[move]);assert((await page.evaluate(()=>log.movement)).x>.2,'Cancel resets pointer ownership for next movement');await touch('touchEnd',[]);
 // Replacing either member of the measured pair must not turn a stationary
 // third finger into a large pinch/orbit delta when another finger lifts.
 const transitions=[];
 for(const released of [1,2,3]){
  const points=[{id:1,x:100,y:200},{id:2,x:200,y:200},{id:3,x:300,y:300}];
  for(let count=1;count<=3;count++)await touch('touchStart',points.slice(0,count));
  const remaining=points.filter(p=>p.id!==released);
  await touch('touchEnd',[points.find(p=>p.id===released)]);await page.evaluate(()=>log.camera=[]);
  remaining[0]={...remaining[0],x:remaining[0].x+2};
  await touch('touchMove',remaining);
  const deltas=await page.evaluate(()=>log.camera);
  assert(deltas.some(([kind])=>kind==='orbit'),'Remaining fingers keep orbit control');
  assert(deltas.every(([, ...values])=>values.every(value=>Math.abs(value)<2)),`Finger ${released} release jumped: ${JSON.stringify(deltas)}`);
  transitions.push({released,deltas});await touch('touchEnd',[]);
 }
 assert.equal(await page.evaluate(()=>log.walks),0,'Finger transitions cannot produce walk taps');
 assert.deepEqual(errors,[]);console.log('PASS simultaneous native movement + camera + jump; foreign releases; camera cancel; modal cleanup; three-to-two finger camera transitions');await writeFile('evidence/world-input-multipointer.json',JSON.stringify({status:'passed',errors,transitions,limits:['Native CDP touch in Chromium; input module fixture, not a physical device or real movement simulation']},null,2));
}finally{await ctx.close();await browser.close()}
