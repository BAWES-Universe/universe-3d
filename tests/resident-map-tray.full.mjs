/** Actual game/server regression: completion actions must be hit-testable before
 * any inner scrolling. All accounts and writes belong to an in-memory server. */
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds} from '../src/worlds.js';
import {launch} from '../scripts/browser.mjs';
const dist=process.env.RESIDENT_TRAY_DIST||new URL('../dist',import.meta.url).pathname;
const out=process.env.RESIDENT_TRAY_OUTPUT||'evidence/resident-map-tray';
await mkdir(out,{recursive:true});
const app=createGameServer({database:':memory:',seeds:structuredClone(seedWorlds),dist});
const base='http://127.0.0.1:'+(await app.listen(0)).port,browser=await launch();
const ctx=await browser.newContext({viewport:{width:320,height:568},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
await ctx.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
await ctx.addInitScript(()=>{for(const name of ['getUserMedia','getDisplayMedia'])if(navigator.mediaDevices)Object.defineProperty(navigator.mediaDevices,name,{value:()=>{throw Error('Device capture is forbidden');}});});
const page=await ctx.newPage(),checks=[],errors=[],writes=[];page.setDefaultTimeout(45000);
page.on('pageerror',e=>errors.push(e.message));
page.on('request',r=>{if(/\/bots(?:\/[^/]+)?$/.test(new URL(r.url()).pathname)&&['POST','PUT','PATCH','DELETE'].includes(r.method()))writes.push({method:r.method(),path:new URL(r.url()).pathname});});
const field=name=>page.locator(`[data-bot-field="${name}"]`);
const point=async()=>({x:Number(await field('waypoints.0.x').inputValue()),z:Number(await field('waypoints.0.z').inputValue())});
async function measure(label){
 const result=await page.evaluate(()=>{const rect=e=>e.getBoundingClientRect().toJSON(),panel=document.querySelector('.resident-panel');return {panel:rect(panel),ambientVisible:[...document.querySelectorAll('#area-banner,.quest-invitation,.quest-tracker')].some(n=>n.getBoundingClientRect().height>0&&getComputedStyle(n).visibility!=='hidden'),scroll:[...document.querySelectorAll('.resident-map-toolbar,.resident-map-body')].map(n=>({class:n.className,top:n.scrollTop})),actions:['cancel','undo','done'].map(name=>{const n=document.querySelector(`[data-testid="bot-map-${name}"]`),r=n.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(n);const ink=range.getBoundingClientRect();return {name,rect:rect(n),textFits:ink.x>=r.x&&ink.right<=r.right&&ink.y>=r.y&&ink.bottom<=r.bottom,hit:n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),inside:r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight&&r.y>=panel.getBoundingClientRect().top&&r.bottom<=panel.getBoundingClientRect().bottom,minTarget:r.width>=44&&r.height>=48};})};});
 checks.push({label,viewport:page.viewportSize(),...result});await page.screenshot({path:out+'/'+label+'.png'});return result;
}
async function tapAction(name){const b=await page.getByTestId('bot-map-'+name).boundingBox();await page.touchscreen.tap(b.x+b.width/2,b.y+b.height/2);}
try{
 await page.goto(base);await page.getByPlaceholder('Your name').fill('Resident tray reviewer');await page.locator('#join-button').click();await page.waitForFunction(()=>window.__universe?.getState().ready);
 const later=page.getByRole('button',{name:'Not now',exact:true});if(await later.isVisible())await later.click();
 await page.locator('#dock-more').click();await page.locator('#shell-more').getByRole('button',{name:'Room residents',exact:true}).click();
 await page.getByTestId('bot-create').click();await page.getByLabel('Resident name',{exact:true}).fill('Tray route');await field('behavior').selectOption('patrol');
 await page.getByTestId('bot-add-waypoint').click();await page.getByTestId('bot-add-waypoint').click();
 // Re-enter every mode at each viewport: previous scroll/focus cannot conceal
 // the initial-layout regression. Geometry probes deliberately never scroll.
 for(const [width,height] of [[320,568],[390,844],[667,375],[844,390]]){
  await page.setViewportSize({width,height});
  for(const mode of ['waypoint','spawn','add']){
   if(mode==='waypoint')await page.getByRole('button',{name:'Move waypoint 1 in room',exact:true}).click();
   else await page.getByTestId(mode==='spawn'?'bot-move-resident':'bot-route-world').click();
   await measure(`${width}x${height}-${mode}`);
   await page.keyboard.press('Escape');
  }
 }
 const failed=checks.filter(c=>c.ambientVisible||c.actions.some(a=>!a.hit||!a.inside||!a.minTarget||!a.textFits));
 assert.deepEqual(failed,[],'Cancel, Undo and Done must be visible and hit-testable on entry, without scrolling');
 // The same footer must survive genuine enlarged text and repeated entry.
 for(const [width,height] of [[320,568],[667,375]]){
  await page.setViewportSize({width,height});
  await page.getByLabel('Resident name',{exact:true}).fill('A resident with a long name that still leaves actions visible');
  await page.getByTestId('bot-move-resident').click();
  await page.evaluate(()=>{const nodes=[...document.querySelectorAll('.resident-map-toolbar,.resident-map-toolbar *')].filter(n=>n instanceof HTMLElement).map(n=>[n,parseFloat(getComputedStyle(n).fontSize)]);for(const[n,size]of nodes)n.style.fontSize=size*2+'px';});
  const large=await measure(`${width}x${height}-long-name-text-2x`);assert(large.actions.every(a=>a.hit&&a.inside&&a.minTarget&&a.textFits));
  await page.locator('.resident-map-toolbar,.resident-map-toolbar *').evaluateAll(nodes=>nodes.forEach(n=>n.style.removeProperty('font-size')));
  await tapAction('cancel');
 }
 await page.getByLabel('Resident name',{exact:true}).fill('Tray route');
 await page.setViewportSize({width:320,height:568});
 const initial=await point();
 await page.getByRole('button',{name:'Move waypoint 1 in room',exact:true}).click();await page.locator('#game').focus();await page.keyboard.press('ArrowRight');assert.notDeepEqual(await point(),initial);
 await tapAction('undo');assert.deepEqual(await point(),initial);assert.equal(writes.length,0);
 await page.locator('#game').focus();await page.keyboard.press('ArrowRight');await tapAction('cancel');assert.deepEqual(await point(),initial);assert.equal(writes.length,0);
 await page.getByRole('button',{name:'Move waypoint 1 in room',exact:true}).click();await page.locator('#game').focus();await page.keyboard.press('ArrowRight');const changed=await point();await tapAction('done');assert.deepEqual(await point(),changed);assert.equal(writes.length,0,'Done must return to details without persisting');
 assert(await page.getByTestId('bot-save').isVisible());await page.getByTestId('bot-save').click();await page.waitForFunction(()=>__universe.getState().bots.some(b=>b.name==='Tray route'));assert.equal(writes.length,1,'Explicit Create writes exactly once');
 await page.getByRole('button',{name:'Close residents',exact:true}).click();await page.getByTestId('bot-editor').waitFor({state:'hidden'});
 await page.locator('#dock-more').click();await page.locator('#shell-more').getByRole('button',{name:'Room residents',exact:true}).click();await page.getByRole('button',{name:'Edit Tray route',exact:true}).click();assert.deepEqual(await point(),changed);
 await page.getByLabel('Resident name',{exact:true}).fill('Unwanted name');await page.getByRole('button',{name:'Close residents',exact:true}).click();await page.getByTestId('bot-confirm-discard').click();await page.getByTestId('bot-editor').waitFor({state:'hidden'});assert.equal(writes.length,1);
 assert.deepEqual(errors,[]);console.log('PASS: 12 initial tray layouts, actual 2x text, native Undo/Cancel/Done and explicit save/discard semantics');
}catch(error){checks.push({failure:error.stack});console.error(error);process.exitCode=1;await page.screenshot({path:out+'/failure.png'}).catch(()=>{});}
finally{await writeFile(out+'/results.json',JSON.stringify({buildSha256:createHash('sha256').update(await readFile(join(dist,'main.js'))).digest('hex'),checks,errors,writes,limits:['Synthetic in-memory server; real app and native browser controls','Chromium SwiftShader and viewport/touch emulation, not physical device certification']},null,2));await ctx.close();await browser.close();await app.close();}
