/** Actual bundled game + SQLite. Native UI inputs; diagnostics are read-only.
 * Fault injection delays/drops actual HTTP responses, never fabricates creation success.
 */
import assert from 'node:assert/strict';
import {mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {launch} from '../scripts/browser.mjs';
import {seedWorlds} from '../src/worlds.js';
import {createGameServer} from '../server/app.mjs';
const out='evidence/places-creation';await mkdir(out,{recursive:true});
const temp=await mkdtemp(join(tmpdir(),'places-creation-'));
const app=createGameServer({database:join(temp,'test.sqlite'),dist:new URL('../dist',import.meta.url).pathname,seeds:seedWorlds});
const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`,browser=await launch();
const results=[],errors=[];let alice,bob,touch,releaseInitialCatalog;
const check=async(name,fn)=>{const detail=await fn();results.push({name,status:'passed',...detail});console.log('PASS',name)};
const call=async(ctx,path,method='GET',data)=>{const r=await ctx.request.fetch(base+path,{method,data});const body=await r.json();assert(r.ok(),JSON.stringify({path,status:r.status(),body}));return body;};
const own=async(ctx,id)=>(await call(ctx,'/api/universes')).universes.filter(u=>u.ownerId===id);
const focusInside=async(page)=>assert(await page.evaluate(()=>{const n=document.activeElement;return document.querySelector('#places').contains(n)&&n.getClientRects().length>0;}),'focus must remain in visible Places');
async function tabTo(page,matcher){
 let tabs=0;
 try{
  // Opening Places exposes its Close control before the asynchronous directory.
  // Establish that the intended row exists before testing bounded native traversal.
  await page.getByRole('button',{name:matcher}).first().waitFor({state:'visible'});
  for(;tabs<100;tabs++){const label=await page.evaluate(()=>document.activeElement.getAttribute('aria-label')||document.activeElement.textContent);if(matcher.test(label))return;await page.keyboard.press('Tab');}
  throw Error('Tab target missing '+matcher);
 }catch(error){
  const snapshot=await page.evaluate(()=>({activeLabel:document.activeElement.getAttribute('aria-label')||document.activeElement.textContent,activeTag:document.activeElement.tagName,focusInsidePlaces:document.querySelector('#places').contains(document.activeElement),visibleTreeLabels:[...document.querySelectorAll('.places-tree-item')].filter(n=>n.getClientRects().length).map(n=>n.getAttribute('aria-label')),loadingText:[...document.querySelectorAll('#places .places-status,#places .places-empty')].map(n=>n.textContent).filter(Boolean)}));
  throw new Error(`${error.message}\nPlaces traversal ${JSON.stringify({matcher:String(matcher),tabs,...snapshot})}`,{cause:error});
 }
}
async function open(page){if(await page.locator('#places').isHidden())await page.locator('#dock-explore').click();await page.getByRole('button',{name:'Close places',exact:true}).waitFor();}
async function guide(page){await open(page);if(!await page.getByRole('button',{name:'Make a place',exact:true}).isVisible())await page.getByRole('button',{name:'← All places',exact:true}).click();await page.getByRole('button',{name:'Make a place',exact:true}).click();}
async function ready(page){await page.waitForFunction(()=>window.__universe?.getState().ready);}
async function position(page){return page.evaluate(()=>__universe.getState().position);}
async function record(page){
 const cdp=await page.context().newCDPSession(page),frames=[];
 cdp.on('Page.screencastFrame',({data,metadata,sessionId})=>{frames.push({data,time:metadata.timestamp});void cdp.send('Page.screencastFrameAck',{sessionId}).catch(()=>{});});
 await cdp.send('Page.startScreencast',{format:'jpeg',quality:50,maxWidth:1100,maxHeight:740,everyNthFrame:3});
 return async()=>{await cdp.send('Page.stopScreencast');await cdp.detach();const lines=[];
  for(let i=0;i<frames.length;i++){const path=join(temp,`frame-${i}.jpg`);await writeFile(path,Buffer.from(frames[i].data,'base64'));lines.push(`file '${path}'`, `duration ${Math.max(.04,Math.min(2,(frames[i+1]?.time??frames[i].time+.4)-frames[i].time))}`);}
  await writeFile(join(temp,'frames.txt'),lines.join('\n'));
  const result=spawnSync('ffmpeg',['-y','-loglevel','error','-f','concat','-safe','0','-i',join(temp,'frames.txt'),'-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',out+'/creation-journey.mp4'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return frames.length;
 };
}
try{
 const seed=await browser.newContext();await call(seed,'/api/session','POST',{name:'Synthetic seed custodian'});await seed.close();
 alice=await browser.newContext({viewport:{width:1280,height:850}});bob=await browser.newContext({viewport:{width:1280,height:850}});
 const aid=(await call(alice,'/api/session','POST',{name:'Creation Alice'})).user.id,bid=(await call(bob,'/api/session','POST',{name:'Creation Bob'})).user.id;
 await call(alice,'/api/account','POST',{username:'creation_alice',password:'synthetic-password-only'});await call(bob,'/api/account','POST',{username:'creation_bob',password:'synthetic-password-only'});
 const fixtureTimeout=15000,page=await alice.newPage();page.setDefaultTimeout(fixtureTimeout);page.on('pageerror',e=>errors.push(e.message));
 const initialCatalogGate=new Promise(resolve=>{releaseInitialCatalog=resolve;});
 let catalogHeld,catalogFailed;const initialCatalogHeld=new Promise((resolve,reject)=>{catalogHeld=resolve;catalogFailed=reject;});initialCatalogHeld.catch(()=>{});
 const holdInitialCatalog=async route=>{try{const response=await route.fetch();catalogHeld(response);await initialCatalogGate;await route.fulfill({response});}catch(error){catalogFailed(error);await route.abort().catch(()=>{});}};
 const waitForInitialCatalog=async()=>{let timer;try{return await Promise.race([initialCatalogHeld,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Initial Places catalog response did not arrive within '+fixtureTimeout+'ms')),fixtureTimeout);})]);}finally{clearTimeout(timer);}};
 await page.route('**/api/universes?*',holdInitialCatalog);
 await page.goto(base+'/?room=commons');await ready(page);
 await check('native hierarchy traversal waits for a held real catalog response without spending its Tab budget',async()=>{
  await open(page);const response=await waitForInitialCatalog();assert.equal(response.status(),200);assert((await response.json()).universes.length>0);
  assert.equal(await page.getByRole('button',{name:/^View universe /}).count(),0);await focusInside(page);
  // Observe native keys only; do not focus or activate a control from diagnostics.
  await page.evaluate(()=>{window.__placesReadinessKeys=[];window.__placesReadinessKeyListener=event=>{if(['Tab','Enter'].includes(event.key))window.__placesReadinessKeys.push({key:event.key,trusted:event.isTrusted});};document.addEventListener('keydown',window.__placesReadinessKeyListener,true);});
  const seeking=tabTo(page,/^View universe /);seeking.catch(()=>{});
  await page.screenshot({path:out+'/catalog-loading.png'});
  assert.deepEqual(await page.evaluate(()=>window.__placesReadinessKeys),[]);
  assert.equal(await page.getByRole('button',{name:/^View universe /}).count(),0);await focusInside(page);
  releaseInitialCatalog();await seeking;
  assert.match(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),/^View universe /);
  await page.keyboard.press('Enter');await focusInside(page);assert.equal(await page.evaluate(()=>document.activeElement.className),'places-detail-title');
  const keys=await page.evaluate(()=>{document.removeEventListener('keydown',window.__placesReadinessKeyListener,true);const keys=window.__placesReadinessKeys;delete window.__placesReadinessKeys;delete window.__placesReadinessKeyListener;return keys;});
  assert(keys.some(event=>event.key==='Tab')&&keys.some(event=>event.key==='Enter'));assert(keys.every(event=>event.trusted));
  await page.screenshot({path:out+'/catalog-ready.png'});await page.keyboard.press('Escape');assert(await page.locator('#places').isHidden());assert.equal(await page.evaluate(()=>document.activeElement.id),'dock-explore');
  await page.unroute('**/api/universes?*',holdInitialCatalog);
  return {nativeKeys:keys.length};
 });
 await check('native Tab/Enter selects every hierarchy level; Escape restores opener and no movement leaks',async()=>{
  for(const kind of ['universe','world','room']){
   await open(page);await tabTo(page,new RegExp('^View '+kind+' '));await page.keyboard.press('Enter');await focusInside(page);
   assert.equal(await page.evaluate(()=>document.activeElement.className),'places-detail-title');
   const before=await position(page);await page.keyboard.down('w');await page.waitForTimeout(150);await page.keyboard.up('w');assert.deepEqual(await position(page),before);
   await page.keyboard.press('Escape');assert(await page.locator('#places').isHidden());assert.equal(await page.evaluate(()=>document.activeElement.id),'dock-explore');
  }
 });
 let roomId,worldId,universeId;
 await check('Arabic private creation recovers a lost committed World response after reload; one hierarchy and direct arrival',async()=>{
  const stop=await record(page);await guide(page);
  await page.getByLabel('Place name',{exact:true}).fill('مجلس الأصدقاء 🌿');assert.equal(await page.getByLabel('Privacy',{exact:true}).inputValue(),'private');
  await page.getByRole('button',{name:'Back to places',exact:true}).click();await guide(page);assert.equal(await page.getByLabel('Place name',{exact:true}).inputValue(),'مجلس الأصدقاء 🌿');
  await page.screenshot({path:out+'/desktop-plan.png'});
  let lost=false;
  await page.route('**/api/worlds',async route=>{if(route.request().method()==='POST'&&!lost){lost=true;const response=await route.fetch();assert.equal(response.status(),201);await route.abort('failed');}else await route.continue();});
  await page.getByRole('button',{name:'Create & enter',exact:true}).click();await page.getByRole('button',{name:'Retry creation',exact:true}).waitFor();assert(lost);await focusInside(page);
  let u=await own(alice,aid);assert.equal(u.length,1);assert.equal(u[0].worlds.length,1);assert.equal(u[0].worlds[0].rooms.length,0);
  await page.screenshot({path:out+'/partial-progress.png'});
  await page.reload();await ready(page);await guide(page);assert(await page.getByLabel('Place name',{exact:true}).isDisabled());await page.getByRole('button',{name:'Retry creation',exact:true}).click();await page.locator('#places').waitFor({state:'hidden'});
  u=await own(alice,aid);assert.equal(u.length,1);assert.equal(u[0].worlds.length,1);assert.equal(u[0].worlds[0].rooms.length,1);
  universeId=u[0].id;worldId=u[0].worlds[0].id;roomId=u[0].worlds[0].rooms[0].id;
  for(const p of [u[0],u[0].worlds[0],u[0].worlds[0].rooms[0]]){assert.equal(p.name,'مجلس الأصدقاء 🌿');assert.equal(p.public,false);assert.equal(p.ownerId,aid);assert.match(p.slug,/^[a-z0-9-]+$/);}
  assert.equal(await page.evaluate(()=>__universe.getState().room.id),roomId);
  const room=(await call(alice,`/api/rooms/${roomId}`)).room;assert.equal(room.worldId,worldId);assert.equal(room.universeId,universeId);assert.equal(room.capabilities.canEditScene,true);assert.equal(room.scene.objects.length,0);assert.equal(room.scene.areas.length,0);
  assert.equal((await alice.request.get(base+'/api/worlds/'+worldId+'/members')).status(),200);assert.equal((await bob.request.get(base+'/api/rooms/'+roomId)).status(),404);
  assert(!(await call(bob,'/api/memberships')).memberships.some(m=>m.worldId===worldId));
  await page.screenshot({path:out+'/created-room.png'});const frames=await stop();await page.unroute('**/api/worlds');
  return {universeId,worldId,roomId,recordingFrames:frames};
 });
 await check('completed receipt never recreates hierarchy; explicit Make another handles duplicate names and real slug collision',async()=>{
  await guide(page);await page.getByRole('button',{name:'Make another place',exact:true}).click();await page.getByLabel('Place name',{exact:true}).fill('مجلس الأصدقاء 🌿');await page.getByLabel('Privacy',{exact:true}).selectOption('public');
  let collided=false;
  await page.route('**/api/universes',async route=>{if(route.request().method()==='POST'&&!collided){collided=true;const body=route.request().postDataJSON();await call(bob,'/api/universes','POST',{name:'Collision fixture',slug:body.slug,public:false});}await route.continue();});
  let joinFailed=false; await page.route('**/api/rooms/*/join',async route=>{if(!joinFailed){joinFailed=true;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Synthetic arrival interruption'})});}else await route.continue();});
  await page.getByRole('button',{name:'Create & enter',exact:true}).click();await page.getByRole('button',{name:'Enter your room',exact:true}).waitFor();await page.getByRole('button',{name:'Enter your room',exact:true}).click();await page.locator('#places').waitFor({state:'hidden'});assert(joinFailed);await page.unroute('**/api/rooms/*/join');await page.unroute('**/api/universes');
  const u=await own(alice,aid);assert.equal(u.length,2);assert(collided);assert.notEqual(u[0].slug,u[1].slug);const pub=u.find(x=>x.public);assert(pub);assert.equal(pub.worlds.length,1);assert.equal(pub.worlds[0].rooms.length,1);
  const visitor=(await call(bob,`/api/rooms/${pub.worlds[0].rooms[0].id}`)).room;assert.equal(visitor.role,'guest');assert.equal(visitor.capabilities.canEditScene,false);assert(!(await call(bob,'/api/memberships')).memberships.some(m=>m.worldId===pub.worlds[0].id));
 });
 await check('invitation send, asynchronous refresh and accept retain native focus and exact editor permissions',async()=>{
  await open(page);await page.getByRole('button',{name:'View world مجلس الأصدقاء 🌿',exact:true}).first().click();
  // Choose the original private world by its native ancestry tree order if creation timestamps tie.
  const buttons=page.getByRole('button',{name:'View world مجلس الأصدقاء 🌿',exact:true});
  if(!(await page.locator('.places-detail').innerText()).includes('Private'))await buttons.nth(1).click();
  await page.getByRole('button',{name:'Members & invitations',exact:true}).click();await page.getByLabel('Local account',{exact:true}).fill('creation_bob');await page.getByRole('button',{name:'Find account',exact:true}).click();await page.getByRole('button',{name:'Select account creation_bob',exact:true}).click();await page.getByLabel('World role',{exact:true}).selectOption('editor');await page.getByRole('button',{name:'Send invitation',exact:true}).click();await page.locator('#places').getByText('Invitation sent to their local account inbox.',{exact:true}).waitFor();await focusInside(page);await page.keyboard.press('Escape');assert(await page.locator('#places').isHidden());
  const bp=await bob.newPage();bp.on('pageerror',e=>errors.push(e.message));await bp.goto(base+'/?room=commons');await ready(bp);await open(bp);await bp.getByRole('tab',{name:/Invitations/}).click();await bp.getByRole('button',{name:'Refresh inbox',exact:true}).click();await focusInside(bp);await bp.getByRole('button',{name:'Accept invitation',exact:true}).click();await bp.locator('#places').getByText('Invitation accepted. Your membership is ready.',{exact:true}).waitFor();await focusInside(bp);
  await bp.keyboard.press('Escape');assert(await bp.locator('#places').isHidden());const member=(await call(bob,'/api/memberships')).memberships.find(m=>m.worldId===worldId);assert.equal(member.role,'editor');await bp.close();
 });
 await check('second ordinary account creates its own hierarchy at 320px touch; short landscape and Back preserve draft/focus',async()=>{
  touch=await browser.newContext({viewport:{width:320,height:568},isMobile:true,hasTouch:true,storageState:await bob.storageState()});const p=await touch.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(base+'/?room=commons');await ready(p);
  await p.locator('#dock-explore').tap();await p.getByRole('button',{name:'← All places',exact:true}).tap();await p.getByRole('button',{name:'Make a place',exact:true}).tap();await focusInside(p);assert.notEqual(await p.evaluate(()=>document.activeElement.tagName),'INPUT');
  await p.getByLabel('Place name',{exact:true}).tap();await p.keyboard.type('Tokyo Café');const before=await position(p);await p.keyboard.type(' wasd');assert.deepEqual(await position(p),before);
  await p.getByRole('button',{name:'Back to places',exact:true}).tap();await p.getByRole('button',{name:'Make a place',exact:true}).tap();assert.equal(await p.getByLabel('Place name',{exact:true}).inputValue(),'Tokyo Café wasd');
  // Move the scroll container with native touch events, then use the complete
  // Privacy select through touch and hardware-keyboard input at 320px.
  const privacy=p.getByLabel('Privacy',{exact:true});
  const cdp=await touch.newCDPSession(p);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:160,y:490}]});
  for(const y of [450,410,370,330,290])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:160,y}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await cdp.detach();
  await privacy.tap();await p.keyboard.press('End');await p.keyboard.press('Enter');
  assert.equal(await privacy.inputValue(),'public');
  await p.keyboard.press('Home');await p.keyboard.press('Enter');assert.equal(await privacy.inputValue(),'private');
  await p.keyboard.press('End');await p.keyboard.press('Enter');assert.equal(await privacy.inputValue(),'public');
  const privacyGeometry=await privacy.evaluate(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scrollTop:n.closest('.places-detail').scrollTop,uncovered:[[r.left+3,r.top+3],[r.right-3,r.top+3],[r.left+3,r.bottom-3],[r.right-3,r.bottom-3]].every(([x,y])=>document.elementFromPoint(x,y)===n)};});
  assert(privacyGeometry.height>=48&&privacyGeometry.x>=0&&privacyGeometry.x+privacyGeometry.width<=320);assert(privacyGeometry.uncovered,JSON.stringify(privacyGeometry));
  await p.screenshot({path:out+'/touch-320-privacy.png'});
  assert.equal(await p.evaluate(()=>JSON.parse(sessionStorage.getItem('universe-place-creation-v1:'+__universe.getState().user.id)).public),true);
  for(const size of [{width:320,height:568},{width:667,height:320}]){await p.setViewportSize(size);await focusInside(p);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),size.width);await p.getByRole('button',{name:'Create & enter',exact:true}).scrollIntoViewIfNeeded();const box=await p.getByRole('button',{name:'Create & enter',exact:true}).boundingBox();assert(box.height>=48);assert(box.x>=0&&box.x+box.width<=size.width);await p.screenshot({path:out+`/touch-${size.width}.png`});}
  await p.setViewportSize({width:320,height:568});
  let dropped=false;await p.route('**/api/worlds',async route=>{if(route.request().method()==='POST'&&!dropped){dropped=true;const response=await route.fetch();assert.equal(response.status(),201);await route.abort('failed');}else await route.continue();});
  await p.getByRole('button',{name:'Create & enter',exact:true}).tap();await p.getByRole('button',{name:'Retry creation',exact:true}).waitFor();assert(dropped);
  let partial=(await own(bob,bid)).find(u=>u.name==='Tokyo Café wasd');assert.equal(partial.public,true);assert.equal(partial.worlds[0].public,true);assert.equal(partial.worlds[0].rooms.length,0);
  await p.reload();await ready(p);await guide(p);assert.equal(await p.getByLabel('Privacy',{exact:true}).inputValue(),'public');assert(await p.getByLabel('Privacy',{exact:true}).isDisabled());
  await p.getByRole('button',{name:'Retry creation',exact:true}).tap();await p.locator('#places').waitFor({state:'hidden'});await p.unroute('**/api/worlds');
  const id=await p.evaluate(()=>__universe.getState().room.id),owned=(await own(bob,bid)).filter(u=>u.name==='Tokyo Café wasd');assert.equal(owned.length,1);const u=owned[0];assert.equal(u.worlds.length,1);assert.equal(u.worlds[0].rooms.length,1);assert.equal(u.worlds[0].rooms[0].id,id);
  for(const record of [u,u.worlds[0],u.worlds[0].rooms[0]]){assert.equal(record.public,true);assert.equal(record.ownerId,bid);}
  const visitor=(await call(alice,'/api/rooms/'+id)).room;assert.equal(visitor.role,'guest');assert.equal(visitor.capabilities.canEditScene,false);assert(!(await call(alice,'/api/memberships')).memberships.some(m=>m.worldId===u.worlds[0].id));
  assert.equal((await call(bob,'/api/rooms/'+id)).room.capabilities.canEditScene,true);
  await p.reload();await ready(p);assert.equal(await p.evaluate(()=>__universe.getState().room.id),id);
  await guide(p);await p.getByRole('button',{name:'Make another place',exact:true}).tap();await p.getByLabel('Place name',{exact:true}).fill('Back keeps this draft');await p.goBack();await p.locator('#places').waitFor({state:'hidden'});await guide(p);assert.equal(await p.getByLabel('Place name',{exact:true}).inputValue(),'Back keeps this draft');await focusInside(p);await p.keyboard.press('Escape');assert(await p.locator('#places').isHidden());await touch.close();touch=null;
 });
 assert.deepEqual(errors,[]);
} catch(error){console.error(error);results.push({status:'failed',error:error.stack});process.exitCode=1;for(const c of [alice,bob,touch])for(const p of c?.pages()||[])await p.screenshot({path:out+'/failure-'+(c===alice?'alice':c===bob?'bob':'touch')+'.png',timeout:5000}).catch(()=>{});}
finally{releaseInitialCatalog?.();await writeFile(out+'/full-results.json',JSON.stringify({results,errors,environment:'Native Chromium input, SwiftShader software rendering, touch emulation. No physical-device claim.'},null,2));await alice?.close();await bob?.close();await touch?.close();await browser.close();await app.close();await rm(temp,{recursive:true,force:true});}
