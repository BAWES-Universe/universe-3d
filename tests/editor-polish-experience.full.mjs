import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createGameServer} from '../server/app.mjs';
import {emptyScene} from '../src/worlds.js';
import {launch} from '../scripts/browser.mjs';
const before=process.argv.includes('--before'),out=`evidence/editor-polish-${before?'before':'after'}`;await mkdir(out,{recursive:true});
const scene={...emptyScene(),objects:[{id:'a',type:'chair',name:'Oak chair',x:-4,z:-3,rotation:0},{id:'b',type:'chair',name:'Peer chair',x:4,z:-3,rotation:0}]};
const app=createGameServer({dist:new URL('../dist',import.meta.url).pathname,seeds:[{id:'world',name:'Workshop',rooms:[{id:'room',name:'Friends’ workshop',scene}]}]});const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`,browser=await launch(),owner=await browser.newContext();
const checks=[],errors=[];let context,page,peerContext;
async function call(ctx,path,method='GET',data){const r=await ctx.request.fetch(base+path,{method,...(data?{data}:{})});const v=await r.json();assert(r.ok(),JSON.stringify(v));return v;}
await call(owner,'/api/session','POST',{name:'Setup owner'});
try{
 for(const size of [{name:'desktop',width:1440,height:960},{name:'portrait',width:320,height:568,touch:true},{name:'landscape',width:568,height:320,touch:true}]){
  context=await browser.newContext({viewport:size,hasTouch:!!size.touch,isMobile:!!size.touch,deviceScaleFactor:size.touch?2:1});page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
  const {user}=await call(context,'/api/session','POST',{name:'Editor '+size.name});await call(owner,'/api/worlds/world/members/'+user.id,'PUT',{role:'editor'});
  await page.goto(base+'/?room=room');await page.waitForFunction(()=>window.__universe?.getState().ready);await page.locator('#dock-build').click();await page.locator('#game').focus();await page.keyboard.press(']');
  await page.screenshot({path:`${out}/${size.name}-selection.png`});
  const get=()=>page.evaluate(()=>({scene:__universe.getState().scene,editor:__universe.getEditor(),position:__universe.getState().position}));
  const rotate=page.locator('.inspector .editor-actions button').first();await rotate.focus();const original=await get();await page.keyboard.press('ArrowRight');const nudged=await get();
  checks.push({name:size.name+' focused button ArrowRight',changedScene:JSON.stringify(original.scene)!==JSON.stringify(nudged.scene)});
  if(!before){assert.deepEqual(nudged.scene,original.scene);assert.deepEqual(nudged.position,original.position);}else if(JSON.stringify(original.scene)!==JSON.stringify(nudged.scene)){await page.locator('#game').focus();await page.keyboard.press('Control+z');}
  await page.getByRole('spinbutton',{name:'X',exact:true}).fill('4');await page.getByRole('spinbutton',{name:'X',exact:true}).press('Tab');
  await page.screenshot({path:`${out}/${size.name}-invalid.png`});
  if(!before){const feedback=page.locator('.builder-inspector .editor-polish-feedback');assert(await feedback.isVisible());assert.match(await feedback.innerText(),/Overlaps/);assert.equal((await get()).scene.objects[0].x,-4);}
  await page.locator('.inspector .editor-actions button').first().click();
  if(!before){assert.match(await page.locator('button[aria-label=Undo]').getAttribute('title'),/rotate Oak chair/i);}
  await page.getByRole('button',{name:'Close item details',exact:true}).click();if(!before)assert.equal(await page.evaluate(()=>document.activeElement.id),'game');
  await page.getByRole('button',{name:'Close editor',exact:true}).click();await page.locator('#dock-build').click();assert.equal((await get()).editor.dirty,true);
  await page.locator('#game').focus();await page.keyboard.press('Control+z');await page.keyboard.press('Control+Shift+z');
  await page.getByRole('button',{name:'Save room',exact:true}).click();await page.waitForFunction(()=>!__universe.getEditor().dirty);
  assert.equal((await call(context,'/api/rooms/room')).room.scene.objects[0].rotation,(original.scene.objects[0].rotation+90)%360);
  checks.push({name:size.name+' native selection, invalid position, rotate, close/reopen, undo/redo and explicit save',status:'passed'});
  if(!before&&size.name==='desktop'){
   peerContext=await browser.newContext({viewport:{width:1440,height:960}});const {user:peer}=await call(peerContext,'/api/session','POST',{name:'Second ordinary editor'});await call(owner,'/api/worlds/world/members/'+peer.id,'PUT',{role:'editor'});
   const other=await peerContext.newPage();other.setDefaultTimeout(60000);other.setDefaultNavigationTimeout(90000);await other.goto(base+'/?room=room',{waitUntil:'domcontentloaded'});await other.waitForFunction(()=>window.__universe?.getState().ready);await other.locator('#dock-build').click();
   assert.equal(await page.evaluate(()=>__universe.getState().room.role),'editor');assert.equal(await other.evaluate(()=>__universe.getState().room.role),'editor');
   await page.locator('#game').focus();await page.keyboard.press(']');await page.getByRole('textbox',{name:'Name',exact:true}).fill('My chair');await page.getByRole('textbox',{name:'Name',exact:true}).press('Tab');
   await other.locator('#game').focus();await other.keyboard.press(']');await other.getByRole('textbox',{name:'Name',exact:true}).fill('Peer chair name');await other.getByRole('textbox',{name:'Name',exact:true}).press('Tab');await other.getByRole('button',{name:'Save room',exact:true}).click();await other.waitForFunction(()=>!__universe.getEditor().dirty);
   await page.locator('.builder-recovery').getByRole('button',{name:'Review changes',exact:true}).click();const review=page.getByRole('dialog',{name:'Review conflicting room changes'});assert(await review.isVisible());assert.equal((await get()).scene.objects[0].name,'My chair');await page.screenshot({path:out+'/two-ordinary-editors-conflict.png'});await review.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal((await get()).scene.objects[0].name,'My chair');
   await page.getByRole('button',{name:'Load server version',exact:true}).click();assert.equal((await get()).scene.objects[0].name,'Peer chair name');
   // Return the shared fixture's name for the portrait and landscape comparisons.
   await page.locator('#game').focus();await page.keyboard.press(']');await page.getByRole('textbox',{name:'Name',exact:true}).fill('Oak chair');await page.getByRole('textbox',{name:'Name',exact:true}).press('Tab');await page.getByRole('button',{name:'Save room',exact:true}).click();await page.waitForFunction(()=>!__universe.getEditor().dirty);
   checks.push({name:'Two ordinary editors: same-object conflict, cancel preserves unsaved draft, explicit server recovery',status:'passed'});await peerContext.close();peerContext=null;
  }

  await context.close();context=null;
 }
 assert.deepEqual(errors,[]);
}catch(e){console.error(e);checks.push({status:'failed',error:e.stack});await page?.screenshot({path:out+'/failure.png'}).catch(()=>{});process.exitCode=1;}
finally{await peerContext?.close();await context?.close();await owner.close();await browser.close();await app.close();await writeFile(out+'/experience-results.json',JSON.stringify({checks,errors,limits:['Native Chromium input; software WebGL','320px portrait and 568x320 landscape use browser touch emulation, not physical devices']},null,2));}
