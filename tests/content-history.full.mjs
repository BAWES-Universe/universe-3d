/** Actual-game content lifetime proof. No application-action helpers or synthetic DOM gestures.
 * Seed data and locally intercepted HTTPS form bytes only; no external provider requests.
 */
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createGameServer} from '../server/app.mjs';
import {launch} from '../scripts/browser.mjs';
const dist=new URL('../dist',import.meta.url).pathname;
const scene={version:1,theme:'garden',bounds:{width:32,depth:26},spawn:{x:0,z:0},objects:[{id:'form-board',type:'board',name:'Local form board',x:0,z:-2,rotation:0,actions:[{id:'form',type:'link',name:'Open local form',label:'Local form',url:'https://content-history-fixture.invalid/form',mode:'embed',width:30,closable:true}]}],areas:[]};
const app=createGameServer({database:':memory:',seeds:[{id:'history-world',name:'History world',rooms:[{id:'history-room',name:'History room',scene},{id:'history-other',name:'Other room',scene:{...scene,objects:[]}}]}],dist,questsEnabled:false});
const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`;
const browser=await launch(),context=await browser.newContext({viewport:{width:1920,height:1080},reducedMotion:'reduce'}),p=await context.newPage();p.setDefaultTimeout(60000);p.setDefaultNavigationTimeout(60000);
const pointerClose=process.env.CONTENT_HISTORY_POINTER_CLOSE==='1';
const closeChat=()=>pointerClose?p.getByRole('button',{name:'Close social panel'}).click():p.locator('#dock-chat').click();
const closePlaces=()=>pointerClose?p.getByRole('button',{name:'Close places',exact:true}).click():p.keyboard.press('Escape');
const checks=[],errors=[],consoleErrors=[];let loads=0,resolves=0,deny=false,hold=false,release;
p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text())});
await context.route('https://content-history-fixture.invalid/**',async route=>{loads++;await route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Local history form</title><h1>Local history form</h1><label>Unsubmitted note <input aria-label="Unsubmitted note"></label><p>Local intercepted fixture bytes only</p>'});});
await context.route('**/api/rooms/history-room/actions/resolve',async route=>{resolves++;if(hold){hold=false;await new Promise(resolve=>release=resolve);}if(deny)await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({message:'Local fixture denies reopened content'})});else await route.continue();});
const check=async(name,run)=>{await run();checks.push({name,status:'passed',loads,resolves});console.log('PASS',name)};
const waitSurface=surface=>p.waitForFunction(surface=>history.state?.surface===surface,surface);
const openForm=async()=>{await p.locator('#interact').click();await p.locator('#dialog-actions').getByRole('button',{name:'Open local form',exact:true}).click();await p.frameLocator('iframe.embedded-frame').getByRole('heading',{name:'Local history form'}).waitFor();await waitSurface('content');};
let heldFrame,expectedLoads,expectedResolves;
async function rememberForm(text='Draft retained through foreground navigation'){
 heldFrame=await p.locator('iframe.embedded-frame').elementHandle();expectedLoads=loads;expectedResolves=resolves;
 await p.frameLocator('iframe.embedded-frame').getByRole('textbox',{name:'Unsubmitted note'}).pressSequentially(text);
}
async function retained(text='Draft retained through foreground navigation'){
 assert.equal(await heldFrame.evaluate(frame=>frame.isConnected&&frame===document.querySelector('iframe.embedded-frame')),true,'The original iframe node must remain connected');
 assert.equal(await p.frameLocator('iframe.embedded-frame').getByRole('textbox',{name:'Unsubmitted note'}).inputValue(),text);
 assert.equal(loads,expectedLoads,'Foreground navigation must not reload the iframe');assert.equal(resolves,expectedResolves,'Existing content does not need a second authorization request');
}
async function shortcuts(){await p.locator('#dock-chat').click();await p.keyboard.press('Control+k');await p.getByRole('combobox').fill('Keyboard shortcuts');await p.getByRole('option').click();await p.locator('#dialog').waitFor({state:'visible'});}
try{
 await mkdir('evidence',{recursive:true});await p.goto(base+'/?room=history-room',{waitUntil:'domcontentloaded'});await p.waitForFunction(()=>window.__universe&&!document.querySelector('#join-button').disabled,{},{timeout:90000});await p.getByPlaceholder('Your name').fill('Content history proof');await p.getByRole('button',{name:'Enter Universe'}).click();await p.waitForFunction(()=>window.__universe?.getState().ready);await openForm();await rememberForm();
 await check('native Chat close, Back and Forward preserve exact iframe, one load and typed form',async()=>{
  await p.locator('#dock-chat').click();await waitSurface('chat');await closeChat();await waitSurface('content');await retained();
  await p.goForward();await waitSurface('chat');assert(await p.locator('#social').isVisible());await retained();await p.goBack();await waitSurface('content');await retained();
 });
 await check('native Places open/close and browser traversal preserve embedded form',async()=>{
  await p.locator('#dock-explore').click();await waitSurface('places');await closePlaces();await waitSurface('content');await retained();await p.goForward();await waitSurface('places');await p.keyboard.press('Escape');await waitSurface('content');await retained();
 });
 await check('nested Express and quick actions keep Chat and content; Escape dismisses the foremost layer only',async()=>{
  await p.locator('#dock-chat').click();await p.locator('#dock-emote').click();await waitSurface('express');await p.getByRole('textbox',{name:'Your expression',exact:true}).fill('Unsent expression');await p.locator('.embedded-header strong').click();await p.keyboard.press('Tab');assert.equal(await p.evaluate(()=>document.activeElement?.textContent),'Return to world');await p.keyboard.press('Escape');await waitSurface('chat');assert(await p.locator('#social').isVisible());await retained();
  await p.goForward();await waitSurface('express');assert(await p.locator('#social').isVisible());await retained();await p.keyboard.press('Escape');await waitSurface('chat');
  await p.keyboard.press('Control+k');await p.getByRole('combobox').fill('camera');await p.keyboard.press('Escape');await waitSurface('chat');assert(await p.locator('#social').isVisible());await retained();await p.goForward();await waitSurface('palette');await p.keyboard.press('Escape');await waitSurface('chat');await retained();
  await closeChat();await waitSurface('content');await retained();
 });
 await check('Help through native quick actions preserves Chat/content and has stable Back/Forward',async()=>{
  await shortcuts();await waitSurface('dialog');await retained();await p.keyboard.press('Escape');await waitSurface('chat');assert(await p.locator('#social').isVisible());await retained();await p.goForward();await waitSurface('dialog');await p.locator('#dialog-close').click();await waitSurface('chat');await retained();await closeChat();await waitSurface('content');
 });
 await p.screenshot({path:'evidence/content-history-retained.png'});
 await check('explicit Return to world disposes; Forward genuinely reauthorizes and creates a fresh frame',async()=>{
  await p.getByRole('button',{name:'Return to world',exact:true}).click();await p.waitForFunction(()=>!history.state?.surface);assert.equal(await p.locator('iframe.embedded-frame').count(),0);assert.equal(await heldFrame.evaluate(frame=>frame.isConnected),false);
  const before=resolves;await p.goForward();await p.frameLocator('iframe.embedded-frame').getByRole('heading',{name:'Local history form'}).waitFor();assert.equal(resolves,before+1);assert.equal(await p.frameLocator('iframe.embedded-frame').getByRole('textbox',{name:'Unsubmitted note'}).inputValue(),'');
 });
 await check('Close this panel and content Escape dispose intentionally; denied Forward never resurrects',async()=>{
  await p.getByRole('button',{name:'Close this panel',exact:true}).click();await p.waitForFunction(()=>!history.state?.surface);deny=true;await p.goForward();await p.waitForFunction(()=>!history.state?.surface);assert.equal(await p.locator('iframe.embedded-frame').count(),0);deny=false;await openForm();await p.keyboard.press('Escape');await p.waitForFunction(()=>!history.state?.surface);assert.equal(await p.locator('iframe.embedded-frame').count(),0);
 });
 await check('Back during a delayed Forward authorization cannot reopen stale content',async()=>{
  hold=true;await p.goForward();await p.waitForFunction(()=>history.state?.surface==='content');for(let i=0;i<100&&!release;i++)await new Promise(resolve=>setTimeout(resolve,20));assert(release,'Local resolve interception should be pending');await p.goBack();await p.waitForFunction(()=>!history.state?.surface);const response=p.waitForResponse(response=>response.url().endsWith('/actions/resolve'));release();release=null;await (await response).finished();await p.waitForTimeout(200);assert.equal(await p.locator('iframe.embedded-frame').count(),0);assert.equal(await p.evaluate(()=>history.state?.surface??null),null);
 });
 await check('Build/Explore stay exclusive and nested Custom images return to Build',async()=>{
  await p.locator('#dock-build').click();await waitSurface('build');await p.locator('#dock-explore').click();await waitSurface('places');assert.equal(await p.locator('#editor').isVisible(),false);await p.keyboard.press('Escape');await p.waitForFunction(()=>!history.state?.surface);
  await p.locator('#dock-build').click();await p.getByRole('button',{name:'Custom images',exact:true}).click();await waitSurface('images');await p.keyboard.press('Escape');await waitSurface('build');assert(await p.locator('#editor').isVisible());await p.getByRole('button',{name:'Close editor',exact:true}).click();await p.waitForFunction(()=>!history.state?.surface);
 });
 await check('Return to world beneath Chat stays closed through UI dismiss/reopen and camera actions; native Back alone reopens with authorization',async()=>{
  await p.locator('#dock-chat').click();await waitSurface('chat');await p.getByRole('button',{name:'Close social panel',exact:true}).click();await p.waitForFunction(()=>!history.state?.surface);
  await openForm();await p.locator('#dock-chat').click();await waitSurface('chat');await p.getByRole('button',{name:'Return to world',exact:true}).click();assert.equal(await p.locator('iframe.embedded-frame').count(),0);assert.equal(await p.evaluate(()=>history.state.surface),'chat');const loadCount=loads,resolveCount=resolves;
  const point=await p.evaluate(()=>window.__universe.getScreenPoint(0,0,1));assert.equal(await p.evaluate(pt=>document.elementFromPoint(pt.x,pt.y)?.id,point),'game');await p.mouse.move(point.x,point.y);await p.mouse.down({button:'middle'});await p.mouse.move(point.x+70,point.y+30,{steps:8});await p.mouse.up({button:'middle'});await p.waitForFunction(()=>window.__universe.getCamera().framingMode==='manual');
  await p.getByRole('button',{name:'Close social panel',exact:true}).click();await p.waitForFunction(()=>!history.state?.surface);await p.locator('#dock-chat').click();await waitSurface('chat');await p.locator('#camera-follow').click();await p.locator('#home-camera').click();await p.getByRole('button',{name:'Close social panel',exact:true}).click();await p.waitForFunction(()=>!history.state?.surface);assert.equal(await p.locator('iframe.embedded-frame').count(),0);assert.equal(loads,loadCount);assert.equal(resolves,resolveCount);
  await p.goBack();await p.frameLocator('iframe.embedded-frame').getByRole('heading',{name:'Local history form'}).waitFor();assert.equal(resolves,resolveCount+1);assert.equal(loads,loadCount+1);await p.goForward();await p.waitForFunction(()=>!history.state?.surface);assert.equal(await p.locator('iframe.embedded-frame').count(),0);
 });
 await check('native two-frame retention after server scene-revocation fixture removes latest B; no stale B reopening',async()=>{
  // Explicit local server-fixture arrangement and revocation, not editor UI proof.
  const readRoom=async()=>{const response=await p.request.get(base+'/api/rooms/history-room');assert.equal(response.status(),200);return(await response.json()).room;};
  const initial=await readRoom(),fixtureScene=structuredClone(initial.scene);fixtureScene.areas.push({id:'history-dual-frame',name:'Two-frame fixture',action:'welcome',x:0,z:0,width:8,depth:8,actions:[{id:'live-a',type:'link',label:'Live frame A',url:'https://content-history-fixture.invalid/live-a',mode:'embed',width:30,closable:true,trigger:'interact'},{id:'live-b',type:'link',label:'Live frame B',url:'https://content-history-fixture.invalid/live-b',mode:'embed',width:30,closable:true,trigger:'interact'}]});
  const arranged=await p.request.put(base+'/api/rooms/history-room/scene',{data:{revision:initial.revision,scene:fixtureScene}});assert.equal(arranged.status(),200);await p.getByRole('button',{name:'Live frame A',exact:true}).waitFor();
  await p.getByRole('button',{name:'Live frame A',exact:true}).click();const frameA=p.frameLocator('iframe[title="Live frame A"]');await frameA.getByRole('heading',{name:'Local history form'}).waitFor();await frameA.getByRole('textbox',{name:'Unsubmitted note'}).pressSequentially('Live A survives revocation');const originalA=await p.locator('iframe[title="Live frame A"]').elementHandle();
  await p.getByRole('button',{name:'Live frame B',exact:true}).click();await p.frameLocator('iframe[title="Live frame B"]').getByRole('heading',{name:'Local history form'}).waitFor();assert.equal(await p.locator('iframe.embedded-frame').count(),2);const originalB=await p.locator('iframe[title="Live frame B"]').elementHandle(),loadCount=loads,resolveCount=resolves;
  const current=await readRoom(),revokedScene=structuredClone(current.scene);revokedScene.areas.find(area=>area.id==='history-dual-frame').actions=revokedScene.areas.find(area=>area.id==='history-dual-frame').actions.filter(action=>action.id!=='live-b');const revoked=await p.request.put(base+'/api/rooms/history-room/scene',{data:{revision:current.revision,scene:revokedScene}});assert.equal(revoked.status(),200);await p.waitForFunction(()=>!document.querySelector('iframe[title="Live frame B"]'));
  const liveA=async()=>{assert.equal(await originalA.evaluate(frame=>frame.isConnected&&frame===document.querySelector('iframe[title="Live frame A"]')),true);assert.equal(await frameA.getByRole('textbox',{name:'Unsubmitted note'}).inputValue(),'Live A survives revocation');assert.equal(await originalB.evaluate(frame=>frame.isConnected),false);assert.equal(await p.locator('iframe[title="Live frame B"]').count(),0);assert.equal(loads,loadCount);assert.equal(resolves,resolveCount);};
  await liveA();await p.locator('#dock-chat').click();await waitSurface('chat');await closeChat();await waitSurface('content');await liveA();await p.goForward();await waitSurface('chat');await liveA();await p.goBack();await waitSurface('content');await liveA();
  await p.getByRole('button',{name:'Return to world',exact:true}).click();await p.waitForFunction(()=>!history.state?.surface);assert.equal(await originalA.evaluate(frame=>frame.isConnected),false);await p.goForward();await p.waitForFunction(()=>!history.state?.surface);assert.equal(await p.locator('iframe.embedded-frame').count(),0);assert.equal(loads,loadCount);assert.equal(resolves,resolveCount,'Revoked latest reference B must not resolve or reopen; no multi-tab fallback is introduced');
 });
 await check('native room travel disposes the live iframe',async()=>{
  await openForm();await p.locator('#dock-explore').click();await p.getByRole('button',{name:'View room Other room',exact:true}).first().click();await p.getByRole('button',{name:'Enter Other room',exact:true}).click();await p.waitForFunction(()=>window.__universe.getState().room.id==='history-other');assert.equal(await p.locator('iframe.embedded-frame').count(),0);
 });
 assert.deepEqual(errors,[]);
}catch(error){console.error(error);process.exitCode=1;checks.push({name:'failure',error:error.stack});console.error('STATE',await p.evaluate(()=>({history:history.state,active:document.activeElement?.outerHTML,toast:document.querySelector('#toast')?.textContent})).catch(()=>null));await p.screenshot({path:'evidence/content-history-failure.png'}).catch(()=>{});}
finally{release?.();await writeFile('evidence/content-history-results.json',JSON.stringify({closeRoutes:pointerClose?'actual Chat/Places Close buttons':'native Chat dock toggle / Places Escape',buildSha256:createHash('sha256').update(await readFile(dist+'/main.js')).digest('hex'),checks,errors,consoleErrors,loads,resolves,limitations:['Chromium software WebGL at 1920×1080; no physical-device/provider certification','HTTPS form bytes intercepted locally; no provider or credential transmission','Seeded local actions; UI navigation/activation uses native clicks/keys, and __universe reads diagnostics only','Two-frame scene creation/revocation uses explicit authenticated local API fixtures, not claimed editor UI authoring']},null,2));await context.close();await browser.close();await app.close();}
