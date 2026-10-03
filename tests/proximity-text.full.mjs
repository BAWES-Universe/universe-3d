/** Native full-shell Nearby text acceptance on an isolated opt-in HTTP/SSE server. */
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds} from '../src/worlds.js';
import {proximityFixture} from './fixtures/proximity-config.mjs';
import {launch} from '../scripts/browser.mjs';

const seeds=structuredClone(seedWorlds);
// Controlled map geometry isolates text/focus behavior while using the real bundle.
for(const world of seeds)for(const room of world.rooms){room.scene.objects=[];room.scene.areas=[];room.scene.spawn={x:0,z:0};room.scene.bounds={width:48,depth:40};}
const app=createGameServer({database:':memory:',seeds,dist:new URL('../dist',import.meta.url).pathname,proximityMembershipConfig:proximityFixture,proximityTextConfig:{enabled:true}});
const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`,browser=await launch();
const checks=[],errors=[],contexts=[];let alice,bob,ac,bc,phase='startup';
const output='evidence/proximity-text-full';await mkdir(output,{recursive:true});
const pass=async(name,fn)=>{phase=name;await fn();checks.push({name,status:'passed'});console.log('PASS',name);};
async function context(options={}){const ctx=await browser.newContext({viewport:{width:1280,height:850},...options});contexts.push(ctx);await ctx.addInitScript(()=>{window.captureAttempts=0;const devices=navigator.mediaDevices;if(devices)devices.getUserMedia=async()=>{window.captureAttempts++;throw new Error('No capture is requested by the Nearby text acceptance fixture');};});return ctx;}
async function enter(page,name){page.setDefaultTimeout(60000);page.setDefaultNavigationTimeout(60000);page.on('pageerror',e=>errors.push(e.message));await page.bringToFront();await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!!window.__universe&&!document.querySelector('#join-button')?.disabled,null,{timeout:90000});if(await page.locator('#welcome').isVisible()){await page.locator('#display-name').fill(name);await page.locator('#join-button').click();}await page.waitForFunction(()=>window.__universe?.getState().ready,null,{timeout:60000});await page.locator('#welcome').waitFor({state:'hidden'});}
async function nearby(page,{touch=false}={}){await page.bringToFront();const activate=locator=>touch?locator.tap():locator.click();if(await page.locator('#social').isHidden())await activate(page.locator('#dock-chat'));else if(await page.locator('#social').getAttribute('data-tab')!=='chat')await activate(page.getByRole('tab',{name:/^Chat/}));await activate(page.getByRole('button',{name:'Nearby',exact:true}));const live=page.getByRole('button',{name:'Open current nearby stay',exact:true});if(await live.isVisible())await activate(live);return page.getByRole('textbox',{name:'Message nearby people',exact:true});}
async function enabled(page){await page.waitForFunction(()=>{return document.querySelector('.social-nearby-status')?.dataset.canSend==='true';},null,{timeout:15000});}
async function send(page,text){await page.bringToFront();const composer=await nearby(page);await enabled(page);await composer.fill(text);await composer.press('Enter');await page.getByText(text,{exact:true}).waitFor();}
async function visit(page,name,id){await page.bringToFront();await page.locator('#dock-explore').click();await page.getByRole('button',{name:'View room '+name,exact:true}).click();await page.getByRole('button',{name:'Enter '+name,exact:true}).click();await page.waitForFunction(id=>window.__universe.getState().room.id===id,id);await page.locator('#places').waitFor({state:'hidden'});}
try{
 ac=await context();bc=await context();alice=await ac.newPage();bob=await bc.newPage();await enter(alice,'Mira nearby');if(process.env.PROXIMITY_TEXT_MOBILE_ONLY){await bc.request.post(base+'/api/session',{data:{name:'Ari nearby',woka:0}});await bc.request.post(base+'/api/rooms/commons/join',{data:{}});}else await enter(bob,'Ari nearby');
 if(!process.env.PROXIMITY_TEXT_MOBILE_ONLY){
 assert.notEqual(await alice.evaluate(()=>__universe.getState().user.id),await bob.evaluate(()=>__universe.getState().user.id));
 await pass('All microphones off: native Enter relays Nearby text between two real game sessions',async()=>{
  await nearby(bob);await enabled(bob);await send(alice,'Hello to this bubble');await bob.getByText('Hello to this bubble',{exact:true}).waitFor();
  for(const page of[alice,bob]){const media=await(await page.request.get(base+'/api/media')).json();assert.equal(media.enabled,false);assert.equal(await page.evaluate(()=>captureAttempts),0);}
  assert.equal(await alice.getByText('Hello to this bubble',{exact:true}).count(),1);await alice.screenshot({path:output+'/desktop-nearby.png',timeout:60000});
 });
 await pass('Incoming Nearby text preserves another focused panel and marks unread without moving focus',async()=>{
  await bob.bringToFront();await bob.getByRole('tab',{name:'Profile',exact:true}).click();const name=bob.getByRole('textbox',{name:'Display name',exact:true});await name.fill('Unsaved profile draft');await name.evaluate(el=>el.setSelectionRange(2,8));
  await send(alice,'A quiet note while you edit');await bob.waitForFunction(()=>document.querySelector('.social-unread'));
  assert.deepEqual(await name.evaluate(el=>({focused:document.activeElement===el,value:el.value,start:el.selectionStart,end:el.selectionEnd})),{focused:true,value:'Unsaved profile draft',start:2,end:8});
  await nearby(bob);await bob.getByText('A quiet note while you edit',{exact:true}).waitFor();
 });
 await pass('Native typing, Shift Enter and IME stay in the composer without world motion or accidental send',async()=>{
  await alice.bringToFront();const composer=await nearby(alice);await enabled(alice);await composer.fill('');const before=await alice.evaluate(()=>({position:__universe.getState().position,camera:__universe.getCamera()}));
  let submitted=0;const count=request=>{if(new URL(request.url()).pathname==='/api/proximity-text/messages'&&request.method()==='POST')submitted++;};alice.on('request',count);
  await composer.pressSequentially('wefr');await composer.press('Shift+Enter');await composer.pressSequentially('second line');assert.equal(await composer.inputValue(),'wefr\nsecond line');
  const cdp=await ac.newCDPSession(alice);await cdp.send('Input.imeSetComposition',{text:'編集中',selectionStart:3,selectionEnd:3});await composer.press('Enter');assert.equal(submitted,0,'composition Enter must not send');
  await cdp.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});await composer.fill('Keyboard send exactly once');await composer.press('Enter');await bob.getByText('Keyboard send exactly once',{exact:true}).waitFor();assert.equal(submitted,1);
  const after=await alice.evaluate(()=>({position:__universe.getState().position,camera:__universe.getCamera()}));assert.deepEqual(after.position,before.position);for(const key of['yaw','tilt','distance','follow','framingMode'])assert.deepEqual(after.camera[key],before.camera[key]);assert.equal(await alice.locator('.express-tray').isVisible(),false);await composer.press('Escape');await alice.locator('#social').waitFor({state:'hidden'});assert.equal(await alice.locator('#dock-chat').evaluate(el=>document.activeElement===el),true,'Escape returns to the Chat control');assert.equal(submitted,1);await alice.keyboard.press('Enter');await alice.locator('#social').waitFor({state:'visible'});assert.equal(await alice.locator('.express-tray').isVisible(),false);alice.off('request',count);
 });
 await pass('Room travel retains received Nearby rows read-only and never sends a carried draft to the new room',async()=>{
  const composer=await nearby(bob);await composer.fill('Unsent before room travel');let sent=0;const count=r=>{if(new URL(r.url()).pathname==='/api/proximity-text/messages')sent++;};bob.on('request',count);
  await visit(bob,'The Studio','studio');await nearby(bob);await bob.getByText('Hello to this bubble',{exact:true}).waitFor();assert.equal(sent,0);assert.equal(await bob.getByRole('button',{name:'Send nearby message',exact:true}).isDisabled(),true);
  await visit(bob,'The Commons','commons');await nearby(bob);const live=bob.getByRole('button',{name:'Open current nearby stay',exact:true});if(await live.isVisible())await live.click();await enabled(bob);assert.equal(sent,0);bob.off('request',count);
 });
 await pass('Disconnected stream disables sends, reconnect preserves received rows but never recovers missed text',async()=>{
  await send(alice,'Before reconnect in this stay');await alice.getByRole('textbox',{name:'Message nearby people',exact:true}).fill('Kept during reconnect');
  let block=true;const blockEvents=route=>block?route.abort('internetdisconnected'):route.continue();await alice.route('**/api/events',blockEvents);app.server.closeAllConnections();
  await alice.waitForFunction(()=>__universe.getState().online===false);await alice.waitForFunction(()=>document.querySelector('[aria-label="Send nearby message"]')?.disabled===true);
  await nearby(bob);await enabled(bob);await send(bob,'Only live listeners get this');
  block=false;await alice.unroute('**/api/events',blockEvents);await alice.waitForFunction(()=>__universe.getState().online===true,null,{timeout:15000});await enabled(alice);
  assert.equal(await alice.getByText('Before reconnect in this stay',{exact:true}).count(),1);assert.equal(await alice.getByText('Only live listeners get this',{exact:true}).count(),0);assert.equal(await alice.getByRole('textbox',{name:'Message nearby people',exact:true}).inputValue(),'Kept during reconnect');
  await send(bob,'The next live message arrives');await alice.getByText('The next live message arrives',{exact:true}).waitFor();
 });
 await pass('Plain text is inert, Nearby bodies never enter browser durable storage, and full reload clears local transcript',async()=>{
  const text='<img src=x onerror="window.nearbyInjected=true">';await send(alice,text);await bob.getByText(text,{exact:true}).waitFor();assert.equal(await bob.evaluate(()=>window.nearbyInjected),undefined);assert.equal(await bob.locator('.social-message-text img').count(),0);
  for(const page of[alice,bob])assert.equal(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}).includes('Hello to this bubble')),false);
  await alice.reload({waitUntil:'domcontentloaded'});await alice.waitForFunction(()=>window.__universe?.getState().ready,null,{timeout:90000});await nearby(alice);await enabled(alice);assert.equal(await alice.getByText('Hello to this bubble',{exact:true}).count(),0);assert.equal(await alice.getByText('The next live message arrives',{exact:true}).count(),0);
 });
 }
 await pass('Touch 320px and landscape with doubled computed text keep Nearby composer, Send and Close reachable',async()=>{
  const storage=await ac.storageState();await ac.close();await bc.close();const mc=await context({viewport:{width:320,height:700},isMobile:true,hasTouch:true,storageState:storage}),page=await mc.newPage();await enter(page,'unused');await nearby(page,{touch:true});
  for(const viewport of[{width:320,height:700},{width:700,height:320}]){await page.setViewportSize(viewport);await page.evaluate(()=>{for(const old of window.__nearbyFontScale||[])old.value?old.node.style.setProperty('font-size',old.value,old.priority):old.node.style.removeProperty('font-size');const fonts=[...document.querySelectorAll('#social,#social *')].map(node=>({node,value:node.style.getPropertyValue('font-size'),priority:node.style.getPropertyPriority('font-size'),size:Number.parseFloat(getComputedStyle(node).fontSize)}));for(const item of fonts)item.node.style.setProperty('font-size',`${item.size*2}px`,'important');window.__nearbyFontScale=fonts;});
   const composer=page.getByRole('textbox',{name:'Message nearby people',exact:true}),send=page.getByRole('button',{name:'Send nearby message',exact:true}),close=page.getByRole('button',{name:'Close social panel',exact:true});
   const touch=await mc.newCDPSession(page);
   for(const control of[composer,send,close]){
    let visible=false;
    for(let attempt=0;attempt<10;attempt++){
     const box=await control.boundingBox(),shell=await page.locator('#social').boundingBox(),header=await page.locator('.social-header').boundingBox();
     const panel=await page.locator('.social-panel').boundingBox(),floor=control===close?Math.max(0,shell.y):Math.max(0,header.y+header.height,panel.y),bottom=Math.min(viewport.height,shell.y+shell.height);
     if(box&&box.x>=-.5&&box.x+box.width<=viewport.width+.5&&box.y>=floor-.5&&box.y+box.height<=bottom+.5){visible=true;break;}
     const low=bottom-12,high=Math.min(low-35,floor+12),up=!box||box.y+box.height>bottom,x=shell.x+8,needed=box?up?box.y+box.height-bottom:floor-box.y:80,distance=Math.min(low-high,Math.max(25,needed+15)),start=up?low:high,end=start+(up?-distance:distance);
     await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x,y:start}]});
     for(let step=1;step<=4;step++){await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:1,x,y:start+(end-start)*step/4}]});await page.waitForTimeout(30);}
     await page.waitForTimeout(120);await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(120);
    }
    if(!visible){console.error('MOBILE GEOMETRY',viewport,await page.evaluate(()=>[...document.querySelectorAll('#social,.social-header,.social-panel,.social-nearby-composer,[aria-label="Message nearby people"]')].map(el=>({selector:el.id||el.className,rect:el.getBoundingClientRect().toJSON(),scrollTop:el.scrollTop,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,overflow:getComputedStyle(el).overflow,touch:getComputedStyle(el).touchAction}))));await page.screenshot({path:output+'/mobile-failure.png',timeout:60000});}
    assert(visible,'Control unreachable after native touch scroll: '+await control.getAttribute('aria-label'));
   }
   await page.screenshot({path:output+`/touch-${viewport.width}.png`,timeout:60000});
  }
  await page.getByRole('button',{name:'Close social panel',exact:true}).tap();assert.equal(await page.locator('#social').isHidden(),true);
 });
 assert.deepEqual(errors,[]);
}catch(error){checks.push({name:phase,status:'failed',error:error.stack});process.exitCode=1;console.error(error);for(const[label,page]of[['alice',alice],['bob',bob]])if(page&&!page.isClosed())console.error(label,await page.evaluate(()=>({room:__universe?.getState().room?.id,online:__universe?.getState().online,status:document.querySelector('.social-nearby-status')?.textContent,composer:document.querySelector('[aria-label="Message nearby people"]')?.outerHTML,active:document.activeElement?.outerHTML?.slice(0,200)})).catch(e=>e.message));
}finally{const digest=async path=>createHash('sha256').update(await readFile(path)).digest('hex');await writeFile(output+(process.env.PROXIMITY_TEXT_MOBILE_ONLY?'/results-mobile.json':'/results.json'),JSON.stringify({checks,errors,bundle:{js:await digest(new URL('../dist/main.js',import.meta.url)),css:await digest(new URL('../dist/main.css',import.meta.url))},scope:'Actual bundled shell/native browser input with isolated opt-in HTTP/SSE authority. No microphone/camera permission or media packet proof. Synthetic blank map controls position.'},null,2));for(const ctx of contexts)await ctx.close().catch(()=>{});await browser.close();await app.close();}
