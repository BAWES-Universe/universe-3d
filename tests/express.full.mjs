/** Actual bundled game shell proof. Build dist before running; this test never rebuilds it. */
import assert from 'node:assert/strict';
import {writeFile}from'node:fs/promises';
import{createGameServer}from'../server/app.mjs';
import{seedWorlds}from'../src/worlds.js';
import{launch}from'../scripts/browser.mjs';
const app=createGameServer({database:':memory:',seeds:seedWorlds,dist:new URL('../dist',import.meta.url).pathname});const{port}=await app.listen(0),base=`http://127.0.0.1:${port}`,browser=await launch();const errors=[],checks=[];
const check=async(name,fn)=>{await fn();checks.push({name,status:'passed'});console.log('PASS',name)};
let alice,bob,ac,bc,mc,mobile;
async function enter(page,name){
 // Each software-WebGL page must be active while its real renderer initializes.
 // DOMContentLoaded alone does not mean the asynchronous game boot is complete.
 page.setDefaultTimeout(60000);page.setDefaultNavigationTimeout(60000);
 await page.bringToFront();await page.goto(base,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>!!window.__universe&&!document.querySelector('#join-button')?.disabled,{},{timeout:90000});
 const previous=await page.evaluate(()=>window.__universe.getState().user);
 assert.equal(previous,null,'Fresh browser context unexpectedly adopted an existing identity');
 await page.locator('#welcome').waitFor({state:'visible'});await page.locator('#display-name').fill(name);
 await page.locator('#join-button').click();await page.waitForFunction(()=>window.__universe?.getState().ready,{},{timeout:60000});
 await page.locator('#welcome').waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>window.__universe.getState().user.name),name);
 await page.waitForTimeout(400);
}
try{
 if(!process.env.EXPRESS_MOBILE_ONLY){
 ac=await browser.newContext({viewport:{width:1280,height:850}});bc=await browser.newContext({viewport:{width:1280,height:850}});alice=await ac.newPage();bob=await bc.newPage();for(const p of[alice,bob])p.on('pageerror',e=>errors.push(e.message));await enter(alice,'Mira expression proof');await enter(bob,'Ari expression proof');assert.notEqual(await alice.evaluate(()=>window.__universe.getState().user.id),await bob.evaluate(()=>window.__universe.getState().user.id),'Participants must have isolated identities');await alice.bringToFront();await alice.waitForFunction(()=>window.__universe.getState().people.length===2);
 await check('actual shell Enter sends a real projected avatar Say to another client',async()=>{
  await alice.locator('#game').focus();await alice.keyboard.press('Enter');await alice.getByRole('textbox',{name:'Your expression',exact:true}).fill('A little room for magic ✨');await alice.keyboard.press('Enter');await bob.getByText('A little room for magic ✨',{exact:true}).waitFor();const bubble=bob.locator('.express-bubble-say');await bob.bringToFront();assert.equal(await bubble.isVisible(),true);
  const clearance=await bubble.evaluate(node=>{const label=[...document.querySelectorAll('.player-label')].find(el=>el.dataset.entity===node.dataset.userId);return {visible:label&&getComputedStyle(label).visibility==='visible',gap:label?.getBoundingClientRect().top-node.getBoundingClientRect().bottom-5};});
  assert(clearance.visible,'Sender nameplate is visible in the actual shell');assert(clearance.gap>=5&&clearance.gap<=7,'Bundled main.js attaches the Say tail six CSS pixels above the sender nameplate');
  const before=await bubble.boundingBox(),cameraBefore=await bob.evaluate(()=>window.__universe.getCamera().yaw);assert(before);await bob.locator('#rotate-camera').click();await bob.waitForFunction(yaw=>Math.abs(window.__universe.getCamera().yaw-yaw)>.01,cameraBefore,{timeout:10000});/* Software-WebGL frames need not complete within an arbitrary100ms. Require the actual projected bubble to move after the real click. */await bob.waitForFunction(previous=>{const bubble=document.querySelector('.express-bubble-say');if(!bubble)return false;const next=bubble.getBoundingClientRect();return Math.abs(previous.x-next.x)>1||Math.abs(previous.y-next.y)>1;},before,{timeout:10000});const after=await bubble.boundingBox();assert(after);assert(Math.abs(before.x-after.x)>1||Math.abs(before.y-after.y)>1);await bob.screenshot({path:'evidence/express-full-desktop.png'});
 });
 await check('walk to Ctrl Enter flushes stationary presence and Think clears on next movement',async()=>{
  await alice.bringToFront();await alice.locator('#game').focus();let position=await alice.evaluate(()=>window.__universe.getState().position);await alice.keyboard.down('w');await alice.waitForFunction(p=>Math.hypot(window.__universe.getState().position.x-p.x,window.__universe.getState().position.z-p.z)>.1,position);await alice.keyboard.up('w');await alice.waitForTimeout(550);await alice.keyboard.press('Control+Enter');await alice.getByRole('textbox',{name:'Your expression',exact:true}).fill('Thinking right after walking');await alice.keyboard.press('Enter');await alice.locator('.express-bubble-think').waitFor();await bob.getByText('Thinking right after walking',{exact:true}).waitFor();await alice.waitForTimeout(1650);assert.equal(await alice.locator('.express-bubble-think').count(),1);await alice.bringToFront();await alice.locator('#game').focus();position=await alice.evaluate(()=>window.__universe.getState().position);await alice.keyboard.down('d');await alice.waitForFunction(p=>Math.hypot(window.__universe.getState().position.x-p.x,window.__universe.getState().position.z-p.z)>.1,position);await alice.keyboard.up('d');await bob.waitForFunction(()=>!document.querySelector('.express-bubble-think'));
 });
 await check('global Cmd K in real chat preserves draft, selection, open panel and browser history',async()=>{
  await alice.locator('#dock-chat').click();const composer=alice.getByRole('textbox',{name:'Message the room',exact:true});await composer.fill('This draft stays exactly here');await composer.evaluate(el=>el.setSelectionRange(3,9));await alice.keyboard.press('Meta+k');await alice.getByRole('combobox').waitFor();await alice.getByRole('combobox').fill('camera');await alice.keyboard.press('Escape');await alice.waitForTimeout(250);assert.equal(await alice.locator('#social').isVisible(),true);assert.equal(await composer.inputValue(),'This draft stays exactly here');assert.deepEqual(await composer.evaluate(el=>[document.activeElement===el,el.selectionStart,el.selectionEnd]),[true,3,9]);assert.equal(await alice.evaluate(()=>history.state.surface),'chat');
 });
 await check('palette person opens that actual direct-message recipient; member sees no build command',async()=>{
  await alice.keyboard.press('Control+k');await alice.getByRole('combobox').fill('Ari expression proof');const option=alice.getByRole('option').filter({hasText:'Open direct message'});assert.equal(await option.count(),1);await alice.waitForFunction(()=>{const image=document.querySelector('.command-person-portrait');return image&&image.naturalWidth>0});assert.match(await alice.locator('.command-person-portrait').getAttribute('src'),/^data:image\/png;base64,/);
  await alice.evaluate(()=>{window.stableCommandOption=document.querySelector('[role=option]');window.stableCommandPortrait=document.querySelector('.command-person-portrait');});
  const bobId=await bob.evaluate(()=>window.__universe.getState().user.id);
  for(const status of ['away','busy','online']){
   const update=await bob.request.patch(base+'/api/me',{data:{status}});assert.equal(update.status(),200);
   await alice.waitForFunction(({id,status})=>window.__universe.getState().people.some(person=>person.id===id&&person.status===status),{id:bobId,status});
   assert.equal(await alice.evaluate(()=>window.stableCommandOption===document.querySelector('[role=option]')&&window.stableCommandOption.isConnected&&window.stableCommandPortrait===document.querySelector('.command-person-portrait')),true,'Live presence refresh replaced the pending click target');
  }
  await option.click();await alice.getByRole('textbox',{name:'Message Ari expression proof',exact:true}).waitFor();await alice.waitForTimeout(200);assert.equal(await alice.locator('#social').isVisible(),true);
  await bob.locator('#quick-actions').click();await bob.getByRole('combobox').fill('Build this place');assert.equal(await bob.getByRole('option').count(),0);await bob.keyboard.press('Escape');
 });
 }
 await check('touch shell has visible Express/quick menu entries and keyboard stays closed on tray opening',async()=>{
  await ac?.close();await bc?.close();mc=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});mobile=await mc.newPage();mobile.on('pageerror',e=>errors.push(e.message));await enter(mobile,'Touch explorer');await mobile.emulateMedia({reducedMotion:'reduce'});await mobile.locator('#dock-more').tap();await mobile.locator('#shell-more').getByRole('button',{name:'Express',exact:true}).tap();await mobile.locator('.express-tray').waitFor();assert.notEqual(await mobile.evaluate(()=>document.activeElement.className),'express-input');const tray=await mobile.locator('.express-tray').boundingBox();assert(tray.x>=0&&tray.x+tray.width<=391);await mobile.waitForTimeout(400);assert.equal(await mobile.locator('.express-tray').evaluate(el=>getComputedStyle(el).opacity),'1');await mobile.screenshot({path:'evidence/express-full-mobile.png'});await mobile.getByRole('button',{name:'Close Express',exact:true}).tap();await mobile.locator('#dock-more').tap();await mobile.locator('#shell-more').getByRole('button',{name:'Quick actions',exact:true}).tap();await mobile.getByRole('combobox').waitFor();await mobile.waitForTimeout(400);await mobile.screenshot({path:'evidence/command-full-mobile.png'});await mobile.keyboard.press('Escape');
 });
 assert.deepEqual(errors,[]);await writeFile(process.env.EXPRESS_MOBILE_ONLY?'evidence/express-full-mobile-results.json':'evidence/express-full-results.json',JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({passed:checks.length,errors}));
}catch(error){
 for(const[label,page]of[['Alice',alice],['Bob',bob],['Mobile',mobile]])if(page&&!page.isClosed()){
  const diagnostic=page.evaluate(()=>({url:location.href,documentReady:document.readyState,gameBooted:!!window.__universe,position:window.__universe?.getState().position,ready:window.__universe?.getState().ready,userId:window.__universe?.getState().user?.id,active:document.activeElement?.outerHTML?.slice(0,200),welcomeHidden:document.querySelector('#welcome')?.hidden,joinDisabled:document.querySelector('#join-button')?.disabled,joinError:document.querySelector('#join-error')?.textContent,express:!document.querySelector('.express-tray')?.hidden,surface:history.state,toast:document.querySelector('#toast')?.textContent})).catch(e=>({error:e.message}));
  console.error('FULL SHELL DIAGNOSTIC',label,await Promise.race([diagnostic,new Promise(resolve=>setTimeout(()=>resolve({error:'Diagnostic page did not respond within5s'}),5000))]));
 }
 console.error('PAGE ERRORS',errors);throw error;
}finally{await browser.close();await app.close();}
