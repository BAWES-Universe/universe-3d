/** Real bundled-shell Nearby typing, local authenticated HTTP/SSE and native input.
 * Client wall clocks are intentionally skewed; elapsed timers remain real.
 */
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds} from '../src/worlds.js';
import {proximityFixture} from './fixtures/proximity-config.mjs';
import {launch} from '../scripts/browser.mjs';
const seeds=structuredClone(seedWorlds);for(const w of seeds)for(const r of w.rooms){r.scene.objects=[];r.scene.areas=[];r.scene.spawn={x:0,z:0};r.scene.bounds={width:48,depth:40};}
const app=createGameServer({database:':memory:',seeds,dist:new URL('../dist',import.meta.url).pathname,proximityMembershipConfig:proximityFixture,proximityTextConfig:{enabled:true}}),{port}=await app.listen(0),base=`http://127.0.0.1:${port}`,browser=await launch();
const checks=[],errors=[],requests=[],contexts=[];let phase='startup',alice,bob;
const out='evidence/proximity-typing-full';await mkdir(out,{recursive:true});
async function page(name,offset){const ctx=await browser.newContext({viewport:{width:1280,height:850}});contexts.push(ctx);await ctx.addInitScript(offset=>{const nativeNow=Date.now.bind(Date);Date.now=()=>nativeNow()+offset;window.captureAttempts=0;if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=async()=>{captureAttempts++;throw Error('This typing test does not request capture');};},offset);const p=await ctx.newPage();p.setDefaultTimeout(60000);p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>{const path=new URL(r.url()).pathname;if(path==='/api/proximity-text/typing')requests.push({name,path,body:r.postDataJSON()});});await p.bringToFront();await p.goto(base,{waitUntil:'domcontentloaded'});await p.waitForFunction(()=>window.__universe&&!document.querySelector('#join-button')?.disabled,null,{timeout:90000});await p.locator('#display-name').fill(name);await p.locator('#join-button').click();await p.waitForFunction(()=>window.__universe.getState().ready,null,{timeout:60000});return p;}
const composer=p=>p.getByRole('textbox',{name:'Message nearby people',exact:true}),typing=p=>p.locator('.social-nearby-typing');
async function nearby(p){await p.bringToFront();if(await p.locator('#social').isHidden())await p.locator('#dock-chat').click();await p.getByRole('button',{name:'Nearby',exact:true}).click();const current=p.getByRole('button',{name:'Open current nearby stay',exact:true});if(await current.isVisible())await current.click();await p.waitForFunction(()=>document.querySelector('.social-nearby-status')?.dataset.canSend==='true');await typing(p).waitFor({state:'visible'});}
const shows=(p,name)=>p.waitForFunction(name=>document.querySelector('.social-nearby-typing')?.textContent===`${name} is typing…`,name,{timeout:5000});
const clears=(p,timeout=5000)=>p.waitForFunction(()=>!document.querySelector('.social-nearby-typing')?.textContent,null,{timeout});
const pass=async(name,fn)=>{phase=name;await fn();checks.push({name,status:'passed'});console.log('PASS',name);};
try{
 alice=await page('Mira',60000);bob=await page('Ari',-60000);assert.notEqual(await alice.evaluate(()=>__universe.getState().user.id),await bob.evaluate(()=>__universe.getState().user.id));await nearby(bob);await nearby(alice);
 await pass('Real native input reaches an all-mic-off peer with opposite client clock offsets, without transmitting the draft',async()=>{
  const secret='draft must never enter typing metadata';await composer(alice).fill(secret);await shows(bob,'Mira');assert.ok(requests.some(r=>r.name==='Mira'&&r.body.isTyping));for(const r of requests){assert.deepEqual(Object.keys(r.body).sort(),['connectionEpoch','roomId','bubbleId','memberId','membershipRevision','sequence','isTyping'].sort());assert.equal(JSON.stringify(r.body).includes(secret),false);}
  for(const p of[alice,bob]){assert.equal(await p.evaluate(()=>captureAttempts),0);assert.equal((await(await p.request.get(base+'/api/media')).json()).enabled,false);}
  await composer(alice).fill('');await clears(bob);await composer(bob).fill('Ari native activity');await shows(alice,'Ari');await composer(bob).fill('');await clears(alice);
 });
 await pass('Reopened SSE reseeds typing after same-admission resume and never restarts a retained draft',async()=>{
  await alice.bringToFront();await composer(alice).fill('Retained through reconnect');await shows(bob,'Mira');
  const before=await alice.evaluate(()=>{const state=__universe.getState();return{admissionId:state.admissionId,position:state.position};});
  const starts=requests.filter(r=>r.body.isTyping).length;
  let block=true;const blockEvents=route=>block?route.abort('internetdisconnected'):route.continue();await alice.route(/\/api\/events(?:\?.*)?$/,blockEvents);
  app.server.closeAllConnections();
  await alice.waitForFunction(()=>__universe.getState().online===false);
  await alice.waitForFunction(()=>document.querySelector('[aria-label="Send nearby message"]')?.disabled===true);await clears(bob);
  block=false;await alice.unroute(/\/api\/events(?:\?.*)?$/,blockEvents);
  await alice.waitForFunction(()=>__universe.getState().online===true,null,{timeout:15000});
  await nearby(bob);await nearby(alice);
  assert.deepEqual(await alice.evaluate(()=>{const state=__universe.getState();return{admissionId:state.admissionId,position:state.position};}),before);
  assert.equal(await composer(alice).inputValue(),'Retained through reconnect');await composer(alice).focus();
  assert.equal(requests.filter(r=>r.body.isTyping).length,starts,'Reconnect and focus must not restart typing');
  await composer(alice).fill('New input after reconnect');await shows(bob,'Mira');await composer(alice).fill('');await clears(bob);
  await bob.bringToFront();await composer(bob).fill('Peer input after reconnect');await shows(alice,'Ari');await composer(bob).fill('');await clears(alice);
 });
 await pass('Incoming typing preserves the recipient composer, cursor, timeline, geometry and unread',async()=>{
  await bob.bringToFront();await composer(bob).fill('Keep this separate draft');await composer(bob).press('Home');await composer(bob).press('ArrowRight');await composer(bob).press('Shift+ArrowRight');const before=await composer(bob).evaluate(el=>{window.savedTypingComposer=el;window.savedTypingTimeline=document.querySelector('.social-timeline');return {value:el.value,start:el.selectionStart,end:el.selectionEnd,box:el.getBoundingClientRect().toJSON(),scroll:savedTypingTimeline.scrollTop,rows:savedTypingTimeline.children.length,unread:document.querySelector('#unread').textContent};});
  await alice.bringToFront();await composer(alice).fill('New native typing activity');await shows(bob,'Mira');const after=await composer(bob).evaluate(el=>({same:el===savedTypingComposer,timeline:document.querySelector('.social-timeline')===savedTypingTimeline,focus:document.activeElement===el,value:el.value,start:el.selectionStart,end:el.selectionEnd,box:el.getBoundingClientRect().toJSON(),scroll:savedTypingTimeline.scrollTop,rows:savedTypingTimeline.children.length,unread:document.querySelector('#unread').textContent}));assert.equal(after.same,true);assert.equal(after.timeline,true);assert.equal(after.focus,true);delete after.same;delete after.timeline;delete after.focus;assert.deepEqual(after,before);await bob.screenshot({path:out+'/typing-desktop.png',timeout:60000});
 });
 await pass('A delayed real text acknowledgement cannot stop newer typing or erase its newer draft',async()=>{
  let release;let markHeld;const held=new Promise(r=>markHeld=r);const hold=async route=>{const response=await route.fetch();await new Promise(resolve=>{release=async()=>{await route.fulfill({response});resolve();};markHeld();});};await alice.route('**/api/proximity-text/messages',hold,{times:1});await alice.bringToFront();await composer(alice).fill('Accepted message before next activity');await composer(alice).press('Enter');await Promise.race([held,new Promise((_,reject)=>setTimeout(()=>reject(Error('Text acknowledgement was not held')),10000))]);await bob.getByText('Accepted message before next activity',{exact:true}).waitFor();await composer(alice).fill('A newer draft after submission');await shows(bob,'Mira');await release();await alice.getByText('Accepted message before next activity',{exact:true}).waitFor();assert.equal(await composer(alice).inputValue(),'A newer draft after submission');await shows(bob,'Mira');
 });
 await pass('Native close and re-open stop immediately and do not restart from a restored draft or focus alone',async()=>{
  await alice.getByRole('button',{name:'Close social panel',exact:true}).click();await clears(bob);const count=requests.filter(r=>r.name==='Mira'&&r.body.isTyping).length;await nearby(alice);await composer(alice).focus();await alice.waitForTimeout(400);assert.equal(requests.filter(r=>r.name==='Mira'&&r.body.isTyping).length,count);assert.equal(await composer(alice).inputValue(),'A newer draft after submission');
 });
 await pass('Lost stop is bounded by a real twelve-second lease, with no timer-generated start or retry',async()=>{
  let drops=0;const dropStops=route=>{if(route.request().postDataJSON()?.isTyping===false){drops++;return route.abort('internetdisconnected');}return route.continue();};await alice.route('**/api/proximity-text/typing',dropStops);const count=requests.filter(r=>r.name==='Mira'&&r.body.isTyping).length;const accepted=alice.waitForResponse(r=>new URL(r.url()).pathname==='/api/proximity-text/typing'&&r.request().postDataJSON()?.isTyping===true&&r.ok());await composer(alice).fill('Idle after this real input');await accepted;const started=performance.now();await shows(bob,'Mira');await clears(bob,17000);const elapsed=performance.now()-started;assert(elapsed>=10500&&elapsed<=17000,`Lease ended after${elapsed}ms`);assert.equal(requests.filter(r=>r.name==='Mira'&&r.body.isTyping).length,count+1);assert(drops>=1,'The10s idle stop was attempted and intentionally lost');await alice.unroute('**/api/proximity-text/typing',dropStops);checks.push({name:'Observed real lease duration',status:'passed',elapsedMs:Math.round(elapsed)});
 });
 await pass('Actual room travel retires old typing and cannot display it in another room',async()=>{
  await alice.bringToFront();await composer(alice).fill('Leaving this bubble');await shows(bob,'Mira');await alice.locator('#dock-explore').click();await alice.getByRole('button',{name:'View room The Studio',exact:true}).click();await alice.getByRole('button',{name:'Enter The Studio',exact:true}).click();await alice.waitForFunction(()=>__universe.getState().room.id==='studio');await clears(bob);assert.equal(await alice.locator('.social-nearby-typing').textContent(),'');
 });
 assert.deepEqual(errors,[]);
}catch(error){checks.push({name:phase,status:'failed',error:error.stack});process.exitCode=1;console.error(error);for(const[name,p]of[['Mira',alice],['Ari',bob]])if(p&&!p.isClosed())console.error(name,await p.evaluate(()=>({room:window.__universe?.getState().room?.id,ready:window.__universe?.getState().ready,online:window.__universe?.getState().online,typing:document.querySelector('.social-nearby-typing')?.outerHTML,context:document.querySelector('.social-nearby-status')?.textContent,visible:document.visibilityState,active:document.activeElement?.outerHTML?.slice(0,180)})).catch(e=>e.message));
}finally{const hash=async file=>createHash('sha256').update(await readFile(new URL('../dist/'+file,import.meta.url))).digest('hex');await writeFile(out+'/results.json',JSON.stringify({checks,errors,bundle:{js:await hash('main.js'),css:await hash('main.css')},typingRequests:requests.map(r=>({name:r.name,sequence:r.body.sequence,isTyping:r.body.isTyping})),scope:'Two actual bundled clients, synthetic accounts/map, native input, live local HTTP/SSE and deliberately offset JavaScript wall clocks. No devices/provider or physical-phone claim.'},null,2));for(const ctx of contexts)await ctx.close();await browser.close();await app.close();}
