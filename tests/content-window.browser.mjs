/** Isolated native-input window tests. Only locally intercepted HTTPS fixture
 * content; the fixture shell deliberately implements the documented focus API. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {launch} from '../scripts/browser.mjs';
const source=`import {mountEmbeddedPanels} from './src/embedded-panels.js';
const root=document.querySelector('#content'),world=document.querySelector('#world'),dialog=document.querySelector('#higher');
window.changes=[];window.opens=[];window.externalCalls=0;window.gameWidth=null;
window.panels=mountEmbeddedPanels({root,getGameWidth:()=>gameWidth??innerWidth,onOpenChange:open=>opens.push(open),onWindowChange:state=>{changes.push(state);world.inert=state.open&&state.maximized;},toast:()=>{}});
for(let i=1;i<=6;i++)document.querySelector('#open'+i).onclick=()=>panels.open({key:'tab'+i,title:'Form '+i,url:'https://window-fixture.invalid/'+i,width:i===2?40:60,closable:i!==3,onExternal:()=>externalCalls++});
document.querySelector('#show-higher').onclick=showHigher;
function showHigher(){dialog.hidden=false;panels.setForeground(false);document.querySelector('#higher-close').focus();}
document.querySelector('#higher-close').onclick=()=>{dialog.hidden=true;panels.setForeground(true);document.querySelector('.embedded-maximize').focus();};
window.addEventListener('keydown',event=>{if(event.ctrlKey&&event.key==='k'){event.preventDefault();showHigher();}else if(event.key==='Escape'&&!dialog.hidden){event.preventDefault();event.stopImmediatePropagation();document.querySelector('#higher-close').click();}},true);
window.addEventListener('blur',()=>window.blurObserved=(window.blurObserved||0)+1);
history.replaceState({surface:'content',contentKey:'opaque-fixture-key'},'');`;
const bundle=await build({stdin:{contents:source,resolveDir:process.cwd()},bundle:true,format:'iife',write:false});
const css=(await Promise.all(['public/universe-tokens.css','public/style.css','src/action-runtime.css'].map(path=>readFile(path,'utf8')))).join('\n').replace(/@import[^;]+;/g,'');
const html=`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}\n#world{position:fixed;inset:0}#chat{position:absolute;left:16px;top:100px;width:300px;height:500px;background:#242030}#higher{position:fixed;inset:120px;z-index:80;background:#19132b;padding:30px}</style><div id="world">${Array.from({length:6},(_,i)=>`<button id="open${i+1}">Open ${i+1}</button>`).join('')}<button id="show-higher">Higher dialog</button><div id="chat"><label>Chat draft<input id="draft"></label><button id="chat-close">Close Chat</button></div></div><div id="content"></div><div id="higher" hidden><button id="higher-close">Close higher dialog</button></div>`;
const browser=await launch(),context=await browser.newContext({viewport:{width:1440,height:900},hasTouch:true,reducedMotion:'reduce'}),page=await context.newPage();
const checks=[],errors=[];let loads=0;page.on('pageerror',error=>errors.push(error.message));
await context.route('https://window-fixture.invalid/**',async route=>{loads++;await route.fulfill({contentType:'text/html',body:'<!doctype html><title>Local window form</title><h1>Local window form</h1><label>Unsubmitted note <input aria-label="Unsubmitted note"></label>'});});
await context.route('https://window-shell.invalid/**',async route=>{if(new URL(route.request().url()).pathname==='/')await route.fulfill({contentType:'text/html',body:html});else await route.fulfill({status:404,body:''});});
const check=async(name,run)=>{await run();checks.push({name,status:'passed'});console.log('PASS',name)};
const state=()=>page.evaluate(()=>panels.windowState()),width=async()=>Math.round((await page.locator('.embedded-panel').boundingBox()).width);
async function viewportSize(size){await page.setViewportSize(size);await page.waitForFunction(({width,height})=>{const root=document.querySelector('#content');return parseFloat(root.style.getPropertyValue('--window-viewport-width'))===width&&parseFloat(root.style.getPropertyValue('--window-height'))===height;},size);}
const maximize=()=>page.getByRole('button',{name:'Maximize content window',exact:true}),restore=()=>page.getByRole('button',{name:'Restore content window',exact:true}),handle=()=>page.getByRole('button',{name:'Resize content window',exact:true});
async function drag(delta){const box=await handle().boundingBox();await page.mouse.move(box.x+24,box.y+80);await page.mouse.down();await page.mouse.move(box.x+24+delta,box.y+80,{steps:6});}
try{
 await mkdir('evidence',{recursive:true});await page.goto('https://window-shell.invalid/');await page.addScriptTag({content:bundle.outputFiles[0].text});await page.locator('#draft').fill('Chat stays open');await page.locator('#open1').click();
 const frame=await page.locator('iframe').elementHandle();await page.frameLocator('iframe').getByRole('textbox',{name:'Unsubmitted note'}).fill('Same document and draft');const startingHistory=await page.evaluate(()=>({length:history.length,state:history.state})),startingLoads=loads;
 const retained=async()=>{assert(await frame.evaluate(node=>node===document.querySelector('iframe')&&node.isConnected));assert.equal(await page.frameLocator('iframe').getByRole('textbox',{name:'Unsubmitted note'}).inputValue(),'Same document and draft');assert.equal(loads,startingLoads);assert.deepEqual(await page.evaluate(()=>({length:history.length,state:history.state})),startingHistory);};
 await check('native pointer resize uses 48px hit target, source bounds, and retains iframe/document/history',async()=>{
  const box=await handle().boundingBox();assert.equal(box.width,48);assert.equal(box.height,160);assert.equal(await width(),864);await drag(-100);await page.mouse.up();assert.equal(await width(),964);await retained();await handle().focus();await page.keyboard.press('End');assert.equal(await width(),1390);await page.keyboard.press('Enter');await retained();
 });
 await check('native maximize/restore keeps Chat/drafts, blocks covered controls, and creates no history',async()=>{
  await maximize().focus();await page.keyboard.press('Space');assert.equal((await state()).maximized,true);assert.equal(await width(),1440);assert.equal(await page.locator('#world').evaluate(n=>n.inert),true);assert.equal(await page.locator('#draft').inputValue(),'Chat stays open');assert.equal(await page.evaluate(()=>document.elementFromPoint(40,180).closest('#content')!==null),true);
  // Tab cannot reach covered controls; cross-origin form keys are left to the form.
  for(let i=0;i<9;i++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.querySelector('#world').contains(document.activeElement)),false);}
  await page.frameLocator('iframe').getByRole('textbox',{name:'Unsubmitted note'}).focus();await page.keyboard.press('Escape');assert.equal((await state()).maximized,true);
  await page.screenshot({path:'evidence/content-window-maximized.png'});await restore().focus();await page.keyboard.press('Enter');assert.equal(await width(),1390);assert.equal(await page.locator('#world').evaluate(n=>n.inert),false);await retained();
 });
 await check('higher dialog owns focus and Escape before content close',async()=>{
  await maximize().click();await page.keyboard.press('Control+k');assert.equal(await page.locator('#content').evaluate(n=>n.inert),true);assert.equal(await page.locator('#higher-close').evaluate(n=>document.activeElement===n),true);await page.keyboard.press('Escape');assert.equal((await state()).maximized,true);assert.equal(await page.locator('#content').evaluate(n=>n.inert),false);await restore().click();assert.equal((await state()).maximized,false);await retained();
 });
 await check('keyboard resize Enter/Space and cancellation precede closing content',async()=>{
  await handle().focus();const before=await width();await page.keyboard.press('Space');assert.equal((await state()).resizing,true);await page.keyboard.press('Home');assert.equal(await width(),200);await page.keyboard.press('Escape');assert.equal(await width(),before);assert.equal((await state()).open,true);assert.equal((await state()).resizing,false);
  await page.keyboard.press('ArrowRight');assert.equal(await width(),before-32);await page.keyboard.press('Enter');assert.equal((await state()).resizing,false);await retained();
 });
 await check('native viewport shrink cancels pointer capture, clamps size and restores below1024',async()=>{
  await drag(-100);assert.equal((await state()).resizing,true);await viewportSize({width:1200,height:800});await page.mouse.up();assert.equal((await state()).resizing,false);assert((await width())<=1150);await maximize().click();await viewportSize({width:1023,height:800});assert.equal((await state()).maximized,false);assert.equal(await maximize().count(),0);assert.equal(await page.locator('.embedded-header button').first().evaluate(n=>document.activeElement===n),true);await viewportSize({width:1024,height:800});await maximize().waitFor({state:'visible'});assert.equal(await maximize().count(),1);await retained();
 });
 await check('game-width boundary is independent of the viewport or content lane',async()=>{
  await viewportSize({width:1440,height:900});await page.evaluate(()=>{gameWidth=1023;panels.refreshLayout();});assert.equal(await maximize().count(),0);await page.evaluate(()=>{gameWidth=1024;panels.refreshLayout();});assert.equal(await maximize().count(),1);await page.evaluate(()=>{gameWidth=null;panels.refreshLayout();});
 });
 await check('native touch drag and touchcancel release gesture and preserve prior width',async()=>{
  await viewportSize({width:844,height:700});const box=await handle().boundingBox(),before=await width(),cdp=await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+24,y:box.y+60,id:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x+84,y:box.y+60,id:1}]});assert.equal((await state()).resizing,true);assert((await width())<before);await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});assert.equal((await state()).resizing,false);assert.equal(await width(),before);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+24,y:box.y+60,id:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x+64,y:box.y+60,id:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});assert.equal((await state()).resizing,false);assert.equal(await width(),before-40);await cdp.detach();await retained();
 });
 await check('320 portrait, landscape and enlarged text keep Return, fallback and permitted Close reachable',async()=>{
  for(const [w,h]of[[320,568],[844,390],[1023,768],[1024,768]]){
   await viewportSize({width:w,height:h});await page.addStyleTag({content:'.embedded-panel{font-size:24px}.embedded-header strong{font-size:30px}.embedded-panel button,.embedded-status{font-size:24px!important;line-height:1.5}'});
   for(const name of['Return to world','Open in new tab ↗','Close this panel']){const button=page.getByRole('button',{name,exact:true});await button.scrollIntoViewIfNeeded();const b=await button.boundingBox();assert(b.width>=44&&b.height>=48);assert(b.x>=0&&b.x+b.width<=w+1);assert(b.y>=0&&b.y+b.height<=h+1);assert(await button.evaluate(n=>{const b=n.getBoundingClientRect();return n.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));}));}
   assert.equal(await page.locator('.embedded-header').evaluate(n=>{const b=n.getBoundingClientRect();return b.height<innerHeight;}),true);if(w===320)await page.screenshot({path:'evidence/content-window-320.png'});
  }
  await page.getByRole('button',{name:'Open in new tab ↗',exact:true}).click();assert.equal(await page.evaluate(()=>externalCalls),1);await retained();await page.screenshot({path:'evidence/content-window-enlarged.png'});
 });
 await check('five-tab identity survives selection/resize; closing selected resets its transient geometry',async()=>{
  await viewportSize({width:1920,height:1080});await page.getByRole('button',{name:'Return to world',exact:true}).click();assert.equal(await frame.evaluate(n=>n.isConnected),false);assert.equal(await page.locator('#open1').evaluate(n=>document.activeElement===n),true);
  // Explicit fixture opening: each button invokes the same public API as an authorized room action.
  for(let i=1;i<=6;i++)await page.locator('#open'+i).click();assert.equal(await page.locator('iframe').count(),5);assert.deepEqual(await page.evaluate(()=>panels.keys()),['tab1','tab2','tab3','tab4','tab5']);
  const a=await page.locator('iframe[title="Form 1"]').elementHandle();await page.getByRole('tab',{name:'Form 1',exact:true}).click();await page.frameLocator('iframe[title="Form 1"]').getByRole('textbox',{name:'Unsubmitted note'}).fill('Tab one retained');await handle().focus();await page.keyboard.press('Home');await page.keyboard.press('Enter');assert.equal(await width(),200);await page.getByRole('tab',{name:'Form 2',exact:true}).click();assert.equal(await width(),768);await page.getByRole('tab',{name:'Form 1',exact:true}).click();assert.equal(await width(),200);assert(await a.evaluate(n=>n.isConnected));assert.equal(await page.frameLocator('iframe[title="Form 1"]').getByRole('textbox',{name:'Unsubmitted note'}).inputValue(),'Tab one retained');
  await maximize().click();await page.getByRole('button',{name:'Close this panel',exact:true}).click();assert.equal((await state()).maximized,false);assert.equal(await width(),768);assert.equal(await a.evaluate(n=>n.isConnected),false);await page.getByRole('tab',{name:'Form 3',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Close this panel',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Return to world',exact:true}).count(),1);
 });
 await check('blur cleanup, stale load callback and destroy release transient state',async()=>{
  await page.getByRole('tab',{name:'Form 2',exact:true}).click();await handle().focus();const before=await width();await page.keyboard.press('ArrowLeft');assert.equal((await state()).resizing,true);
  // Lifecycle interruption is intentionally dispatched: native pointercancel and native viewport resize are tested above.
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));assert.equal((await state()).resizing,false);assert.equal(await width(),before);
  await page.evaluate(()=>{window.oldFrame=document.querySelector('iframe[title="Form 2"]');window.oldError=oldFrame.onerror;});await page.getByRole('button',{name:'Reload frame',exact:true}).click();await page.evaluate(()=>oldError());assert(!/could not/.test(await page.locator('.embedded-status').innerText()));await maximize().click();await page.keyboard.press('Escape');assert.equal((await state()).open,false);assert.equal(await page.locator('iframe').count(),0);await page.locator('#open1').click();await maximize().click();await page.evaluate(()=>panels.destroy());assert.equal(await page.locator('iframe').count(),0);assert.equal((await state()).maximized,false);assert.equal(await page.locator('#world').evaluate(n=>n.inert),false);await page.setViewportSize({width:800,height:600});
 });
 assert.deepEqual(errors,[]);
}catch(error){checks.push({name:'failure',error:error.stack});console.error(error);process.exitCode=1;await page.screenshot({path:'evidence/content-window-failure.png'}).catch(()=>{});}
finally{await writeFile('evidence/content-window-results.json',JSON.stringify({checks,errors,loads,limits:['Isolated panel and documented shell focus integration fixture, not full-game integration','Native mouse/keyboard and CDP touch input with touchCancel; window blur is a named synthetic lifecycle interruption','All HTTPS documents intercepted locally; no real external site/provider, physical device or live deployment tested']},null,2));await context.close();await browser.close();}
