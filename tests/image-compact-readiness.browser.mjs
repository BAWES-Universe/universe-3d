/** Bounded timing probe for native touch opening of Custom at 320px.
 * Runs the authorized baseline candidate; never executes the A review source.
 * Observers collect DOM state only. All UI actions use native CDP touch. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds} from '../src/worlds.js';
import {launch} from '../scripts/browser.mjs';
const out='evidence/image-compact-readiness';await mkdir(out,{recursive:true});
const app=createGameServer({seeds:structuredClone(seedWorlds),dist:new URL('../dist',import.meta.url).pathname}),address=await app.listen(0),browser=await launch();
const context=await browser.newContext({viewport:{width:320,height:760},isMobile:true,hasTouch:true,deviceScaleFactor:2}),page=await context.newPage(),cdp=await context.newCDPSession(page),trials=[],errors=[];
page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(20000);
async function touch(locator){await locator.scrollIntoViewIfNeeded();const box=await locator.boundingBox();assert(box&&box.x>=0&&box.x+box.width<=320.5&&box.y>=0&&box.y+box.height<=760.5,`touch target in viewport: ${JSON.stringify(box)}`);const point={x:box.x+box.width/2,y:box.y+box.height/2};assert(await locator.evaluate((node,p)=>node===document.elementFromPoint(p.x,p.y)||node.contains(document.elementFromPoint(p.x,p.y)),point));await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,id:1,radiusX:2,radiusY:2,force:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
async function record(){await page.evaluate(()=>{window.layoutObservations=[];const editor=document.querySelector('#editor');const take=stage=>{const custom=editor.querySelector('[aria-label="Custom images"]')||[...editor.querySelectorAll('button')].find(b=>b.textContent==='Custom images');const box=custom?.getBoundingClientRect();layoutObservations.push({stage,time:performance.now(),hidden:editor.hidden,compact:editor.dataset.compact??null,customVisible:!!box?.width&&!!box?.height,customParent:custom?.parentElement?.className});};document.querySelector('#dock-build').addEventListener('click',()=>{take('click-after-handler');queueMicrotask(()=>take('click-microtask'));});new MutationObserver(()=>take('editor-mutation')).observe(editor,{attributes:true,attributeFilter:['hidden','data-compact'],childList:true,subtree:true});take('before-tap');});}
try{
 for(let trial=0;trial<6;trial++){
  await page.goto(`http://127.0.0.1:${address.port}`,{waitUntil:'domcontentloaded'});
  if(trial===0){await page.getByPlaceholder('Your name').fill('Compact readiness fixture');await page.locator('#join-button').click();}
  await page.waitForFunction(()=>window.__universe?.getState().ready,null,{timeout:60000});await record();await touch(page.locator('#dock-build'));
  const custom=page.getByRole('button',{name:'Custom images',exact:true});const visibleBefore=await custom.isVisible();const immediate=await page.locator('#editor').getAttribute('data-compact');
  let oldPathFailure=null;
  if(trial<3){try{if(!visibleBefore)await touch(page.getByRole('button',{name:'More build tools',exact:true}));await custom.scrollIntoViewIfNeeded({timeout:1500});await touch(custom);}catch(error){oldPathFailure=error.message;}}
  // Readiness correction under test: wait for the actual responsive layout before
  // deciding which native control exposes Custom. It never skips hit assertions.
  if(trial>=3||oldPathFailure){await page.waitForFunction(()=>!document.querySelector('#editor').hidden&&document.querySelector('#editor').dataset.compact==='true');if(!await custom.isVisible())await touch(page.getByRole('button',{name:'More build tools',exact:true}));await touch(custom);}
  await page.locator('#image-library').waitFor({state:'visible'});
  const observations=await page.evaluate(()=>layoutObservations);assert(observations.some(o=>o.compact==='true'));
  trials.push({trial,mode:trial<3?'original-helper':'layout-ready-helper',visibleBefore,immediate,oldPathFailure,observations,opened:true});
  await page.screenshot({path:`${out}/trial-${trial}.png`});
 }
 assert.deepEqual(errors,[]);const observedWindow=trials.filter(t=>t.observations.some(o=>!o.hidden&&o.compact!== 'true'&&o.customVisible));
 console.log('PASS native compact readiness probe',JSON.stringify({trials:trials.length,observedPreLayoutVisibilityWindows:observedWindow.length,originalHelperFailures:trials.filter(t=>t.oldPathFailure).length,correctedTrials:trials.filter(t=>t.mode==='layout-ready-helper').length}));
}catch(error){console.error(error);process.exitCode=1;trials.push({failure:error.stack});}
finally{await writeFile(out+'/results.json',JSON.stringify({trials,errors,limits:['Authorized baseline + image integration adapter only; A not executed','Six bounded native-touch openings, not an estimate of CI flake frequency','Observers measure DOM state; they do not delay ResizeObserver or change layout']},null,2));await context.close();await browser.close();await app.close();}
