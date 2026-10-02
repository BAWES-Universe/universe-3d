// Real game/pointer/HTTP lifecycle with inert fake audio tracks. No devices or packets.
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {launch} from '../scripts/browser.mjs';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds,emptyScene} from '../src/worlds.js';
const out='evidence/media-freshness-full';await mkdir(out,{recursive:true});
const seeds=structuredClone(seedWorlds);seeds[0].rooms[0].scene={...emptyScene(),bounds:{width:16,depth:16},spawn:{x:0,z:5},objects:[],areas:[{id:'silent-fixture',name:'Silent fixture',x:2,z:0,width:4,depth:4,action:'silent'}]};
const app=createGameServer({seeds,dist:new URL('../dist',import.meta.url).pathname}),address=await app.listen(0),base=`http://127.0.0.1:${address.port}`,browser=await launch(),page=await browser.newPage({viewport:{width:1200,height:850}});page.setDefaultTimeout(60000);
const checks=[],errors=[];let holdPolicy=false,holdPresence=false,held=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
 window.fixtureTracks=[];window.captureAttempts=0;
 Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async options=>{
  if(!options.audio||options.video)throw Error('Only inert audio fixture allowed');captureAttempts++;
  const track={kind:'audio',readyState:'live',enabled:true,stop(){this.readyState='ended';},getSettings(){return{};}};fixtureTracks.push(track);return {getTracks:()=>[track],getAudioTracks:()=>[track],getVideoTracks:()=>[]};
 }});
 Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{configurable:true,value:()=>{throw Error('Screen capture prohibited');}});
});
await page.route('**/api/media',async route=>{if(!holdPolicy)return route.continue();await new Promise(resolve=>held.push(resolve));await route.continue().catch(()=>{});});
// Simulate delayed position delivery; the service keeps the last outside position.
await page.route('**/api/presence',route=>holdPresence?route.fulfill({json:{ok:true}}):route.continue());
async function move(x,z){await page.waitForFunction(()=>{const c=window.__universe.getCamera(),p=window.__universe.getState().position;return Math.hypot(c.target.x-p.x,c.target.z-p.z)<.08;});const p=await page.evaluate(p=>window.__universe.getScreenPoint(p.x,p.z),{x,z});assert(p?.visible);assert.equal(await page.evaluate(p=>document.elementFromPoint(p.x,p.y)?.id,p),'game');await page.mouse.click(p.x,p.y);await page.waitForFunction(p=>{const q=window.__universe.getState().position;return Math.hypot(p.x-q.x,p.z-q.z)<.35;},{x,z});}
async function release(){holdPolicy=false;holdPresence=false;for(const resolve of held.splice(0))resolve();}
async function enterSilentAndAssert(index){await page.locator('#dock-media').click();await move(2,0);assert.equal(await page.evaluate(i=>fixtureTracks[i].readyState,index),'ended');assert.equal((await(await page.request.get(base+'/api/media')).json()).context.kind,'proximity');await page.locator('#dock-media').click();assert(await page.locator('[data-media="microphone"]').isDisabled());assert.equal(await page.locator('[data-media="microphone"]').getAttribute('aria-pressed'),'false');}
try{
 await page.goto(base,{waitUntil:'domcontentloaded'});await page.getByPlaceholder('Your name').fill('Freshness fixture');await page.locator('#join-button').click();await page.waitForFunction(()=>window.__universe?.getState().ready);
 await page.locator('#dock-media').click();await page.locator('.media-join').click();await page.waitForFunction(()=>document.querySelector('.media-join')?.textContent==='Leave audio');await page.locator('[data-media="microphone"]').click();await page.waitForFunction(()=>document.querySelector('[data-media="microphone"]')?.getAttribute('aria-pressed')==='true');
 holdPolicy=true;holdPresence=true;await page.locator('.media-details-toggle').click();await page.locator('.media-retry').click();await page.waitForFunction(()=>fixtureTracks[0]?.readyState==='live');
 for(let i=0;i<100&&!held.length;i++)await page.waitForTimeout(10);assert(held.length>0,'held GET established');await enterSilentAndAssert(0);checks.push('Real pointer entry stops active fake track despite held GET and service still outside');
 await page.locator('#dock-media').click();await move(0,5);await page.locator('#dock-media').click();assert(await page.locator('[data-media="microphone"]').isDisabled());assert.equal(await page.evaluate(()=>captureAttempts),1);await release();await page.waitForFunction(()=>!document.querySelector('[data-media="microphone"]')?.disabled);assert.equal(await page.locator('[data-media="microphone"]').getAttribute('aria-pressed'),'false');checks.push('Exit awaits fresh authority and never restarts capture automatically');
 holdPolicy=true;holdPresence=true;await page.locator('[data-media="microphone"]').click();await page.waitForFunction(()=>fixtureTracks.length===2&&fixtureTracks[1].readyState==='live');assert.equal(await page.locator('[data-media="microphone"]').getAttribute('aria-pressed'),'false');await enterSilentAndAssert(1);checks.push('Acquired-pending fake capture is also stopped by real world entry before authorization finishes');
 await page.screenshot({path:out+'/held-policy-silent.png'});await release();await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>fixtureTracks.every(track=>track.readyState==='ended')),true);assert.equal(await page.evaluate(()=>captureAttempts),2);assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,errors}));
}catch(error){console.error(error);checks.push({failed:error.stack});await page.screenshot({path:out+'/failure.png'}).catch(()=>{});process.exitCode=1;}
finally{await release();await writeFile(out+'/results.json',JSON.stringify({bundleSha256:createHash('sha256').update(await readFile('dist/main.js')).digest('hex'),checks,errors,limits:['Real 3D pointer and app HTTP lifecycle with deliberately held policy/position fixtures','Inert JavaScript tracks only; no browser permission, native capture, peer packets, relay or external service']},null,2));await browser.close();await app.close();}
