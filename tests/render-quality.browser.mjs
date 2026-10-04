/** Real built shell, native input and read-only diagnostics. No physical-device claim. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {launch} from '../scripts/browser.mjs';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds} from '../src/worlds.js';
import {WORLD_RENDER_PIXELS,PREVIEW_RENDER_PIXELS} from '../src/render-resolution.js';
const out='evidence/render-quality';await mkdir(out,{recursive:true});
const app=createGameServer({seeds:seedWorlds,dist:new URL('../dist',import.meta.url).pathname}),{port}=await app.listen(0),browser=await launch(),checks=[],errors=[];let page,context;
const report=async(name,details={})=>{checks.push({name,...details});console.log(details.passed===false?'FAIL':'PASS',name);await writeFile(out+'/results.json',JSON.stringify({checks,errors,scope:'Chromium SwiftShader on shared Linux; native mouse and CDP-emulated touch. CSS text-size fixture only, not browser/OS text zoom, physical-device performance or accessibility certification.'},null,2));};
const canvasMetrics=selector=>page.locator(selector).evaluate(c=>({width:c.width,height:c.height,cssWidth:c.clientWidth,cssHeight:c.clientHeight,pixels:c.width*c.height,dpr:devicePixelRatio}));
async function openCreator(){if(!await page.getByRole('button',{name:'Edit your 3D character',exact:true}).isVisible()){await page.locator('#dock-more').tap();await page.locator('#shell-more').getByRole('button',{name:'You',exact:true}).tap();}await page.getByRole('button',{name:'Edit your 3D character',exact:true}).click();await page.waitForFunction(()=>__universe.getCreatorPreview().active&&__universe.getStats().presentation.suspended);}
async function closed(){await page.locator('#avatar-creator').waitFor({state:'hidden'});await page.waitForFunction(()=>!__universe.getStats().presentation.suspended&&!__universe.getStats().presentation.resumePending);assert.deepEqual(await page.evaluate(()=>{const p=__universe.getCreatorPreview();return{active:p.active,camera:p.camera,meshCount:p.meshCount};}),{active:false,camera:null,meshCount:0});}
try{
 for(const dpr of [1,2,3]){
  context=await browser.newContext({viewport:{width:320,height:568},deviceScaleFactor:dpr,isMobile:true,hasTouch:true});page=await context.newPage();page.setDefaultTimeout(60000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}`,{waitUntil:'domcontentloaded'});await page.getByPlaceholder('Your name').fill(`Resolution ${dpr}`);await page.locator('#join-button').tap();await page.waitForFunction(()=>window.__universe?.getState().ready);
  const world=await canvasMetrics('#game');assert.equal(world.width,320);assert.equal(world.height,568);
  await openCreator();await page.waitForFunction(()=>__universe.getCreatorPreview().renderedFrames>2);const preview=await canvasMetrics('.avatar-preview');assert.equal(preview.width,preview.cssWidth);assert.equal(preview.height,preview.cssHeight);assert(preview.pixels<=PREVIEW_RENDER_PIXELS);
  await page.screenshot({path:out+`/dpr${dpr}-creator.png`});await report(`DPR ${dpr}: world and preview retain CSS resolution`,{world,preview});
  if(dpr===2){
   const before=await page.evaluate(()=>__universe.getStats());await page.setViewportSize({width:3840,height:2160});await page.waitForFunction(()=>__universe.getStats().presentation.resizePending);const paused=await page.evaluate(()=>__universe.getStats());assert.equal(paused.renderWidth,before.renderWidth);assert.equal(paused.renderHeight,before.renderHeight);assert.equal(paused.presentation.drawnFrames,before.presentation.drawnFrames);
   await page.getByRole('button',{name:'Cancel',exact:true}).click();await closed();const capped=await canvasMetrics('#game');assert.equal(capped.width,1920);assert.equal(capped.height,1080);assert(capped.pixels<=WORLD_RENDER_PIXELS);
   await page.setViewportSize({width:320,height:568});await page.waitForFunction(()=>__universe.getStats().renderWidth===320&&__universe.getStats().renderHeight===568);await report('Paused resize retains old framebuffer; resume caps a 4K CSS viewport at 1080p and returning to mobile restores 1:1 CSS pixels',{pausedBuffer:{width:paused.renderWidth,height:paused.renderHeight},resumedBuffer:capped});
  }else{await page.getByRole('button',{name:'Cancel',exact:true}).tap();await closed();}
  if(dpr===3){
   await openCreator();const fontBefore=await page.locator('.avatar-header h2').evaluate(e=>parseFloat(getComputedStyle(e).fontSize));await page.addStyleTag({content:'html { font-size: 200% !important; }'});const fontAfter=await page.locator('.avatar-header h2').evaluate(e=>parseFloat(getComputedStyle(e).fontSize));assert(fontAfter>fontBefore*2);
   const cdp=await context.newCDPSession(page);
   async function swipe(up=true){const y=up?[470,420,360,300,240,180]:[180,240,300,360,420,470];await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:7,y:y[0],id:1}]});for(const value of y.slice(1)){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:7,y:value,id:1}]});await page.waitForTimeout(35);}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(100);}
   async function reach(locator){for(let n=0;n<24;n++){const hit=await locator.evaluate(e=>{const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return{x,y,usable:r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight&&e.contains(document.elementFromPoint(x,y))};});if(hit.usable)return hit;await swipe(hit.y>284);}throw Error('Native scroll could not reach '+await locator.getAttribute('aria-label'));}
   async function tap(locator){const p=await reach(locator);await page.touchscreen.tap(p.x,p.y);}
   await page.screenshot({path:out+'/root-200-heading.png'});
   await tap(page.getByRole('tab',{name:'Hair',exact:true}));await tap(page.getByRole('button',{name:'Hairstyle: High bun',exact:true}));await page.screenshot({path:out+'/root-200-hair.png'});
   await tap(page.getByRole('tab',{name:'Outfit',exact:true}));await tap(page.getByRole('button',{name:'Top: Cozy hoodie',exact:true}));await tap(page.getByRole('button',{name:'Shoes: Low-top sneakers',exact:true}));await page.screenshot({path:out+'/root-200-outfit.png'});
   await tap(page.getByRole('tab',{name:'Extras',exact:true}));await tap(page.getByRole('button',{name:'Headwear: Soft cap',exact:true}));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),320);
   const layout=await page.locator('.avatar-dialog').evaluate(e=>({height:e.clientHeight,scrollHeight:e.scrollHeight,scrollWidth:e.scrollWidth,scrollTop:e.scrollTop}));assert.equal(layout.scrollWidth,320);assert(layout.scrollHeight>layout.height);
   await tap(page.getByRole('button',{name:'Save character',exact:true}));await closed();assert.equal(await page.evaluate(()=>__universe.getState().user.appearance.hairStyle),'bun');assert.equal(await page.evaluate(()=>__universe.getState().user.appearance.hat),'cap');await report('320×568, DPR3, root text 200%: native touch scrolling reaches hair, outfit, shoes, extras and Save; enlarged text persists selections without horizontal page overflow',{fontBefore,fontAfter,layout});
   await openCreator();assert.equal(await page.locator('.avatar-dialog').evaluate(e=>e.scrollTop),0);await tap(page.getByRole('tab',{name:'Hair',exact:true}));await tap(page.getByRole('button',{name:'Hairstyle: Cropped',exact:true}));await tap(page.getByRole('button',{name:'Cancel',exact:true}));await closed();assert.equal(await page.evaluate(()=>__universe.getState().user.appearance.hairStyle),'bun');await report('Enlarged creator reopens at its heading and Cancel discards the draft and releases preview resources');
  }
  await context.close();context=null;
 }
 assert.deepEqual(errors,[]);
}catch(error){errors.push(error.stack);console.error(error);process.exitCode=1;await page?.screenshot({path:out+'/failure.png'}).catch(()=>{});}finally{await report('Run complete',{passed:errors.length===0});await context?.close();await browser.close();await app.close();}
