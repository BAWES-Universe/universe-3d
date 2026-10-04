/** Actual bundled application, two synthetic authenticated contexts, software WebGL. */
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds} from '../src/worlds.js';
import {proximityFixture} from './fixtures/proximity-config.mjs';
import {launch} from '../scripts/browser.mjs';
const seeds=structuredClone(seedWorlds);
for(const world of seeds)for(const room of world.rooms){room.scene.objects=[];room.scene.areas=[];room.scene.spawn={x:0,z:0};room.scene.bounds={width:48,depth:40};}
const app=createGameServer({database:':memory:',seeds,dist:new URL('../dist',import.meta.url).pathname,proximityMembershipConfig:proximityFixture,proximityTextConfig:{enabled:true},proximityTypingConfig:{enabled:true}});
const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`,browser=await launch();
const output='evidence/compact-conversations-full';await mkdir(output,{recursive:true});
const checks=[],errors=[],geometry=[],contexts=[];let phase='startup';
const check=async(name,fn)=>{phase=name;await fn();checks.push({name,status:'PASS'});console.log('PASS',name);};
async function context(opts){const c=await browser.newContext(opts);contexts.push(c);await c.addInitScript(()=>{window.captureAttempts=0;if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=async()=>{captureAttempts++;throw Error('Media capture forbidden in test');};});return c;}
async function enter(c,name){const p=await c.newPage();p.setDefaultTimeout(60000);p.on('pageerror',e=>errors.push(e.message));await p.goto(base);await p.locator('#display-name').fill(name);await p.locator('#join-button').click();await p.waitForFunction(()=>window.__universe?.getState().ready);return p;}
async function open(p){await p.bringToFront();if(await p.locator('#social').isHidden())await p.locator('#dock-chat').click();}
async function room(p){await open(p);await p.getByRole('button',{name:'Open room chat',exact:true}).click();}
async function near(p){await open(p);await p.getByRole('button',{name:'Nearby',exact:true}).click();}
const composer=p=>p.locator('#social textarea');
async function send(p,text){await p.bringToFront();await composer(p).fill(text);await composer(p).press('Enter');await p.locator('.social-message-text').getByText(text,{exact:true}).waitFor();}
const movement=p=>p.evaluate(()=>({position:__universe.getState().position,camera:Object.fromEntries(['yaw','tilt','distance','follow','framingMode'].map(k=>[k,__universe.getCamera()[k]])),building:!document.querySelector('#editor').hidden}));
async function metrics(p,mode,viewport){await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const r=await p.evaluate(()=>{const box=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};const c=document.querySelector('#social textarea'),s=document.querySelector('#social'),t=document.querySelector('.social-timeline');return {shell:box(s),timeline:box(t),composer:box(c),send:box(document.querySelector('.social-composer-actions button')),overflow:document.documentElement.scrollWidth>innerWidth,warning:!document.querySelector('#toast').hidden&&document.querySelector('#toast').textContent.includes('Not enough visible'),focus:document.activeElement.tagName};});
geometry.push({mode,viewport,...r});assert(!r.overflow);assert(r.composer.y>=r.shell.y);assert(r.composer.bottom<=viewport.height+1);assert(r.send.bottom<=viewport.height+1);assert(r.timeline.height>=40);if(process.env.COMPACT_COMBINED==='1')assert(!r.warning,'No framing warning with compatible shell');return r;}
let a,b,ac,bc;
try{
 ac=await context({viewport:{width:390,height:844},hasTouch:true,isMobile:true,deviceScaleFactor:2});bc=await context({viewport:{width:1280,height:850}});
 a=await enter(ac,'Mira compact');b=await enter(bc,'Ari compact');
 const aid=await a.evaluate(()=>__universe.getState().user.id),bid=await b.evaluate(()=>__universe.getState().user.id);assert.notEqual(aid,bid);
 await check('touch opening never focuses the composer; Room send reaches the second context exactly once',async()=>{
  await room(a);assert.notEqual(await a.evaluate(()=>document.activeElement.tagName),'TEXTAREA');await room(b);await send(a,'Meet by the garden, Ari');await b.getByText('Meet by the garden, Ari',{exact:true}).waitFor();assert.equal(await b.getByText('Meet by the garden, Ari',{exact:true}).count(),1);
 });
 for(let i=0;i<15;i++)await bc.request.post(base+'/api/rooms/commons/messages',{data:{text:i%3===0?`رسالة ${i}: أهلاً بالجميع، هل نلتقي بعد قليل في الحديقة؟`:`Plan ${i}: This is a longer message with a verylongunbrokenwordwithoutspaces012345678901234567890123456789 to check wrapping.`,clientOperationId:crypto.randomUUID()}});
 await check('typing, IME and newline own the keyboard and preserve player/camera/build state',async()=>{
  await a.bringToFront();const before=await movement(a);await composer(a).fill('');await composer(a).pressSequentially('wefr');await composer(a).press('Shift+Enter');await composer(a).pressSequentially('draft');assert.equal(await composer(a).inputValue(),'wefr\ndraft');
  let requests=0;const listener=r=>{if(r.method()==='POST'&&r.url().includes('/messages'))requests++;};a.on('request',listener);
  const cdp=await ac.newCDPSession(a);await cdp.send('Input.imeSetComposition',{text:'編集中',selectionStart:3,selectionEnd:3});await composer(a).press('Enter');assert.equal(requests,0);await cdp.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});a.off('request',listener);await cdp.detach();
  assert.deepEqual(await movement(a),before);assert.equal(await a.locator('.express-tray').isVisible(),false);
 });
 await check('incoming messages retain the draft, selection, scroll position and focused contextual action',async()=>{
  await composer(a).fill('A kept draft');await composer(a).evaluate(n=>n.setSelectionRange(2,6));
  await a.locator('.social-timeline').evaluate(n=>n.scrollTop=0);const before=await a.locator('.social-timeline').evaluate(n=>n.scrollTop);
  await send(b,'While you are reading');await a.getByText('While you are reading',{exact:true}).waitFor({state:'attached'});
  assert.equal(await composer(a).inputValue(),'A kept draft');assert.deepEqual(await composer(a).evaluate(n=>[n.selectionStart,n.selectionEnd]),[2,6]);assert.equal(await a.locator('.social-timeline').evaluate(n=>n.scrollTop),before);
  await a.bringToFront();const summary=a.locator('.social-message-options summary').first();await summary.click();await summary.focus();await send(b,'A second incoming note');await a.getByText('A second incoming note',{exact:true}).waitFor({state:'attached'});assert.equal(await summary.evaluate(n=>document.activeElement===n),true);assert.equal(await summary.evaluate(n=>n.parentElement.open),true);
  await summary.press('Escape');assert.equal(await a.locator('#social').isVisible(),true);assert.equal(await summary.evaluate(n=>n.parentElement.open),false);
 });
 await check('contextual editing preserves draft; deletion requires confirmation and Escape cancels',async()=>{
  await a.bringToFront();const row=a.locator('.social-message').filter({hasText:'Meet by the garden, Ari'});await row.locator('summary').click();await row.getByRole('button',{name:'Edit your message'}).click();await composer(a).fill('Meet by the garden at noon');await a.getByRole('button',{name:'Save edited message'}).click();await b.getByText('Meet by the garden at noon',{exact:true}).waitFor({state:'attached'});await a.waitForFunction(()=>document.querySelector('#social textarea').value==='A kept draft');
  const edited=a.locator('.social-message').filter({hasText:'Meet by the garden at noon'});await edited.locator('summary').click();await edited.getByRole('button',{name:'Delete your message'}).click();await a.getByRole('alertdialog').getByRole('button',{name:'Cancel',exact:true}).press('Escape');assert.equal(await a.getByRole('alertdialog').count(),0);assert.equal(await edited.count(),1);await edited.locator('summary').press('Escape');
 });
 await check('portrait resize handles keyboard and pointer interruption without moving the world',async()=>{
  await a.bringToFront();const before=await movement(a),handle=a.getByRole('separator',{name:'Resize conversation'});await handle.focus();const h=await a.locator('#social').evaluate(n=>n.getBoundingClientRect().height);await handle.press('ArrowUp');assert((await a.locator('#social').evaluate(n=>n.getBoundingClientRect().height))>h);await handle.press('ArrowDown');
  const restored=await a.locator('#social').evaluate(n=>n.getBoundingClientRect().height),box=await handle.boundingBox();await a.mouse.move(box.x+box.width/2,box.y+box.height/2);await a.mouse.down();await a.mouse.move(box.x+box.width/2,box.y-60);await a.evaluate(()=>window.dispatchEvent(new Event('blur')));await a.mouse.up();assert.equal(await a.locator('#social').getAttribute('data-sheet-resizing'),null);assert.equal(await a.locator('#social').evaluate(n=>n.getBoundingClientRect().height),restored);assert.deepEqual(await movement(a),before);
  await a.mouse.move(box.x+box.width/2,box.y+box.height/2);await a.mouse.down();await a.mouse.move(box.x+box.width/2,box.y-30);await a.keyboard.press('Escape');await a.mouse.up();assert.equal(await a.locator('#social').isVisible(),true);assert.equal(await a.locator('#social').getAttribute('data-sheet-resizing'),null);
 });
 await check('Room layouts: 320/390 portrait, 568 landscape and desktop, readable long/Arabic text',async()=>{
  for(const viewport of [{width:320,height:568},{width:390,height:844},{width:568,height:320},{width:1280,height:850}]){await a.setViewportSize(viewport);await a.locator('.social-timeline').evaluate(n=>n.scrollTop=0);await metrics(a,'room',viewport);if(process.env.COMPACT_SKIP_SCREENSHOTS!=='1')await a.screenshot({path:`${output}/room-${viewport.width}x${viewport.height}.png`});}
 });
 await check('native timeline swipes scroll messages without moving the player or camera',async()=>{
  await a.setViewportSize({width:390,height:844});await a.bringToFront();await metrics(a,'room-scroll',{width:390,height:844});const before=await movement(a),cdp=await ac.newCDPSession(a);
  // Baseline shell can place a framing toast over the timeline. Start a real
  // swipe only on measured, unobscured timeline content; do not hide the toast.
  const swipe=await a.locator('.social-timeline').evaluate(node=>{
   const box=node.getBoundingClientRect(),x=box.x+box.width/2;
   let point=null;
   for(let y=Math.min(innerHeight,box.bottom)-20;y>box.top+140;y-=24){const hit=document.elementFromPoint(x,y);if(hit&&(hit===node||node.contains(hit))){point={x,y};break;}}
   const toast=document.querySelector('#toast');
   return {point,scrollTop:node.scrollTop,scrollHeight:node.scrollHeight,clientHeight:node.clientHeight,rowCount:node.querySelectorAll('[data-message-id]').length,toast:{visible:!toast.hidden,text:toast.textContent,rect:toast.getBoundingClientRect().toJSON()}};
  });
  geometry.push({mode:'room-native-swipe',viewport:{width:390,height:844},...swipe});
  assert(swipe.scrollHeight>swipe.clientHeight+125,'Enough loaded content for the native swipe');
  assert.equal(swipe.scrollTop,0,'The preceding layout fixture starts at the top');
  assert(swipe.point,'An unobscured timeline point with room for the swipe must exist');
  const {x,y}=swipe.point;
  assert(await a.locator('.social-timeline').evaluate((node,{x,y})=>{const hit=document.elementFromPoint(x,y);return hit===node||node.contains(hit);},{x,y}),'Native swipe starts on timeline content');await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x,y}]});for(let i=1;i<=5;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:1,x,y:y-i*25}]});await a.waitForTimeout(25);}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await a.waitForFunction(()=>document.querySelector('.social-timeline').scrollTop>20);assert.deepEqual(await movement(a),before);await cdp.detach();
 });
 await check('Direct mode keeps recipient, draft, history and excludes unsupported message actions',async()=>{
  await a.setViewportSize({width:390,height:844});await a.getByRole('tab',{name:'People',exact:true}).click();await a.getByRole('button',{name:'Message Ari compact',exact:true}).click();assert.notEqual(await a.evaluate(()=>document.activeElement.tagName),'TEXTAREA');await send(a,'A direct hello');await b.getByRole('button',{name:'Open direct messages'}).click();await b.getByRole('button',{name:'Open messages with Mira compact'}).click();await b.getByText('A direct hello',{exact:true}).waitFor();assert.equal(await a.locator('.social-message-options').count(),0);for(const text of ['رسالة مباشرة: نلتقي غداً في الحديقة بعد الظهر.', 'Bring your ideas. This direct conversation stays separate from what everyone can read in the room.', 'See you soon!']){await send(b,text);await a.getByText(text,{exact:true}).waitFor({state:'attached'});}await composer(a).fill('Direct draft');await room(a);assert.equal(await composer(a).inputValue(),'A kept draft');await a.getByRole('button',{name:'Open direct messages'}).click();await a.getByRole('button',{name:'Open messages with Ari compact'}).click();assert.equal(await composer(a).inputValue(),'Direct draft');
  for(const viewport of [{width:320,height:568},{width:390,height:844},{width:568,height:320},{width:1280,height:850}]){await a.setViewportSize(viewport);await metrics(a,'dm',viewport);if(process.env.COMPACT_SKIP_SCREENSHOTS!=='1')await a.screenshot({path:`${output}/dm-${viewport.width}x${viewport.height}.png`});}
 });
 await check('Nearby live text reaches an active peer and remains a separate ephemeral channel',async()=>{
  await near(a);await near(b);await a.waitForFunction(()=>document.querySelector('.social-nearby-status')?.dataset.canSend==='true');await send(a,'Hello nearby فقط');await b.getByText('Hello nearby فقط',{exact:true}).waitFor();assert.match(await a.locator('.social-subtitle').textContent(),/clears on reload/);assert.equal(await a.locator('.social-message-options').count(),0);for(const text of ['هذا الحديث للقريبين فقط، أهلاً وسهلاً بالجميع.', 'Only this bubble can receive this live conversation. Let us decide where to explore together next.', 'Ready when you are.']){await send(b,text);await a.getByText(text,{exact:true}).waitFor({state:'attached'});}
  await composer(a).fill('Nearby draft');await room(a);assert.equal(await composer(a).inputValue(),'A kept draft');await near(a);assert.equal(await composer(a).inputValue(),'Nearby draft');
  for(const viewport of [{width:320,height:568},{width:390,height:844},{width:568,height:320},{width:1280,height:850}]){await a.setViewportSize(viewport);await metrics(a,'nearby',viewport);if(process.env.COMPACT_SKIP_SCREENSHOTS!=='1')await a.screenshot({path:`${output}/nearby-${viewport.width}x${viewport.height}.png`});}
 });
 await check('viewport change retains mounted composer, selection and draft; Back and Forward preserve conversation',async()=>{
  await a.setViewportSize({width:390,height:844});await composer(a).focus();await composer(a).evaluate(n=>{window.keptComposer=n;n.setSelectionRange(1,4);});await a.setViewportSize({width:390,height:460});assert.deepEqual(await composer(a).evaluate(n=>({same:n===keptComposer,value:n.value,start:n.selectionStart,end:n.selectionEnd})),{same:true,value:'Nearby draft',start:1,end:4});await metrics(a,'nearby-viewport-shrunk',{width:390,height:460});
  await a.setViewportSize({width:390,height:844});await a.goBack();await a.locator('#social').waitFor({state:'hidden'});await a.goForward();await a.locator('#social').waitFor({state:'visible'});assert.equal(await composer(a).inputValue(),'Nearby draft');assert.notEqual(await a.evaluate(()=>document.activeElement.tagName),'TEXTAREA');
 });
 await check('reconnect pauses Nearby sending, preserves draft and does not replay missed text',async()=>{
  // Capability-bearing EventSource URLs must be blocked too; prove that a real
  // reconnect attempt was intercepted before sending the missed-message probe.
  const eventsPath=url=>url.pathname==='/api/events';let blockedStreams=0;
  const blockEvents=route=>{blockedStreams++;return route.abort('internetdisconnected');};
  await a.route(eventsPath,blockEvents);
  const blockedRetry=a.waitForEvent('requestfailed',{predicate:request=>eventsPath(new URL(request.url()))&&blockedStreams>0,timeout:15000});
  app.server.closeAllConnections();await blockedRetry;assert(blockedStreams>0,'A reconnect stream must actually be blocked');
  await a.waitForFunction(()=>!__universe.getState().online);await a.waitForFunction(()=>document.querySelector('[aria-label="Send nearby message"]').disabled);assert.equal(await composer(a).inputValue(),'Nearby draft');
  await near(b);await b.waitForFunction(()=>document.querySelector('.social-nearby-status')?.dataset.canSend==='true');await send(b,'Only live listeners receive this');
  assert.equal(await a.evaluate(()=>__universe.getState().online),false,'Receiver remains disconnected through the probe');
  assert.equal(await a.getByText('Only live listeners receive this',{exact:true}).count(),0);
  await a.unroute(eventsPath,blockEvents);await a.waitForFunction(()=>__universe.getState().online);await a.waitForFunction(()=>document.querySelector('.social-nearby-status')?.dataset.canSend==='true');assert.equal(await composer(a).inputValue(),'Nearby draft');assert.equal(await a.getByText('Hello nearby فقط',{exact:true}).count(),1);assert.equal(await a.getByText('Only live listeners receive this',{exact:true}).count(),0);await send(b,'The next live message arrives');await a.getByText('The next live message arrives',{exact:true}).waitFor({state:'attached'});
 });
 await check('reload clears Nearby transcript but restores durable Room and Direct history; no media permission requests',async()=>{
  await a.reload({waitUntil:'domcontentloaded',timeout:90000});await a.waitForFunction(()=>window.__universe?.getState().ready,null,{timeout:90000});await near(a);assert.equal(await a.getByText('Hello nearby فقط',{exact:true}).count(),0);assert.equal(await composer(a).inputValue(),'');await room(a);await a.getByText('Meet by the garden at noon',{exact:true}).waitFor({state:'attached'});assert.equal(await composer(a).inputValue(),'A kept draft');await a.getByRole('button',{name:'Open direct messages'}).click();await a.getByRole('button',{name:'Open messages with Ari compact'}).click();await a.getByText('A direct hello',{exact:true}).waitFor();assert.equal(await composer(a).inputValue(),'Direct draft');for(const p of [a,b])assert.equal(await p.evaluate(()=>captureAttempts),0);
 });
 await check('real room travel restores room drafts and keeps the previous Nearby stay read-only',async()=>{
  await a.setViewportSize({width:390,height:844});await near(a);await a.waitForFunction(()=>document.querySelector('.social-nearby-status')?.dataset.canSend==='true');await send(a,'Before room travel');await composer(a).fill('Stay draft');
  async function visit(name,id){await a.locator('#dock-explore').click();const all=a.getByRole('button',{name:'← All places',exact:true});if(await all.isVisible())await all.click();await a.getByRole('button',{name:'View room '+name,exact:true}).click();await a.getByRole('button',{name:'Enter '+name,exact:true}).click();await a.waitForFunction(id=>__universe.getState().room.id===id,id);await a.locator('#places').waitFor({state:'hidden'});}
  await visit('The Studio','studio');await near(a);await a.getByText('Before room travel',{exact:true}).waitFor({state:'attached'});assert.equal(await composer(a).getAttribute('readonly'),'');assert.equal(await composer(a).inputValue(),'Stay draft');assert.equal(await a.getByRole('button',{name:'Send nearby message'}).isDisabled(),true);await room(a);assert.equal(await composer(a).inputValue(),'');await composer(a).fill('Studio draft');await visit('The Commons','commons');await room(a);assert.equal(await composer(a).inputValue(),'A kept draft');assert.notEqual(await a.evaluate(()=>document.activeElement.tagName),'TEXTAREA');
 });
 assert.deepEqual(errors,[]);
}catch(e){checks.push({name:phase,status:'FAIL',error:e.stack});console.error(e);process.exitCode=1;if(a)if(process.env.COMPACT_SKIP_SCREENSHOTS!=='1')await a.screenshot({path:`${output}/failure.png`}).catch(()=>{});}
finally{const digest=async path=>createHash('sha256').update(await readFile(path)).digest('hex');await writeFile(`${output}/results.json`,JSON.stringify({checks,errors,geometry,combined:process.env.COMPACT_COMBINED==='1',screenshotsCaptured:process.env.COMPACT_SKIP_SCREENSHOTS!=='1',bundles:{js:await digest('dist/main.js'),css:await digest('dist/main.css')},scope:'Chromium software WebGL, touch/DPR/viewport emulation, synthetic users on isolated in-memory SQLite; no physical keyboard/phone or media packet proof.'},null,2));for(const c of contexts)await c.close();await browser.close();await app.close();}
