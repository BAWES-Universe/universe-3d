/** Two actual editors, local SQLite/HTTP/native SSE and native authoring input.
 * The test controls transport failures, never editor state or input handlers. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createGameServer} from '../server/app.mjs';
import {emptyScene} from '../src/worlds.js';
import {launch} from '../scripts/browser.mjs';

const out='evidence/editor-area-collaboration-full';
await mkdir(out,{recursive:true});
const initial={...emptyScene(),objects:[
 {id:'chair-a',type:'chair',name:'Chair A',x:4,z:3,rotation:0},
 {id:'chair-b',type:'chair',name:'Chair B',x:-4,z:-3,rotation:0}
],areas:[
 {id:'quiet',name:'Quiet corner',x:0,z:7,width:3,depth:3,action:'welcome',message:'Welcome'},
 {id:'lounge',name:'Lounge',x:-7,z:-6,width:3,depth:3,action:'welcome',message:'Lounge message'},
 {id:'overlap-a',name:'Overlap A',x:6,z:-6,width:3,depth:3,action:'welcome',message:'A'},
 {id:'overlap-b',name:'Overlap B',x:7,z:-6,width:3,depth:3,action:'welcome',message:'B'},
 {id:'east-entry',name:'East entry',x:8,z:0,width:.9,depth:.9,action:'welcome',start:{key:'east',isDefault:false}}
]};
const app=createGameServer({database:':memory:',seeds:[{id:'world',name:'Area collaboration',rooms:[{id:'room',name:'Shared areas',scene:initial}]}],dist:new URL('../dist',import.meta.url).pathname,questsEnabled:false});
const {port}=await app.listen(0),base='http://127.0.0.1:'+port,browser=await launch();
const contexts=[],checks=[],errors=[],requests=[];
let alice,bob,bobUser,phase='startup',blockBobEvents=false;
const state=page=>page.evaluate(()=>__universe.getState());
const edit=page=>page.evaluate(()=>__universe.getEditor());
const area=(room,id)=>room.scene.areas.find(value=>value.id===id);
const item=(room,id)=>room.scene.objects.find(value=>value.id===id);
const review=page=>page.getByRole('dialog',{name:'Review conflicting room changes',exact:true});
async function call(context,path,method='GET',data){
 const response=await context.request.fetch(base+path,{method,timeout:60000,...(data===undefined?{}:{data})});
 const body=await response.json();assert(response.ok(),JSON.stringify(body));return body;
}
async function enter(context,label){
 const page=await context.newPage();page.setDefaultTimeout(60000);page.setDefaultNavigationTimeout(60000);
 page.on('pageerror',error=>errors.push(label+': '+error.message));
 page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/rooms/room/scene/operations')requests.push({label,body:request.postDataJSON()});});
 await page.bringToFront();await page.goto(base+'/?room=room',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__universe?.getState().ready,undefined,{timeout:90000});
 await page.locator('#dock-build').click();return page;
}
async function select(page,id){
 await page.bringToFront();await page.locator('#game').focus();await page.keyboard.press('v');
 for(let count=0;count<30&&(await edit(page)).selected!==id;count++)await page.keyboard.press(']');
 assert.equal((await edit(page)).selected,id);
}
async function field(page,id,label,value){
 await select(page,id);const input=page.getByRole('textbox',{name:label,exact:true});
 await input.fill(value);await input.press('Tab');assert.equal((await edit(page)).dirty,true);
}
async function choose(page,key,value){
 const select=page.locator('select[data-focus-key="'+key+'"]');const index=await select.locator('option').evaluateAll((options,value)=>options.findIndex(option=>option.value===value),value);assert(index>=0);await select.focus();await page.keyboard.press('Home');for(let i=0;i<index;i++)await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');assert.equal(await select.inputValue(),value);
}
async function onEntry(page,id,value){
 await select(page,id);await choose(page,'On entry',value);
 assert.equal(area(await state(page),id).action,value);assert.equal((await edit(page)).dirty,true);
}
async function theme(page,value){
 await page.bringToFront();await page.locator('.builder-room-settings').click();
 await choose(page,'Environment',value);
 assert.equal((await state(page)).scene.theme,value);assert.equal((await edit(page)).dirty,true);
}
async function save(page){
 await page.bringToFront();await page.getByRole('button',{name:'Save room',exact:true}).click();
 await page.waitForFunction(()=>!__universe.getEditor().saving&&!__universe.getEditor().dirty);
}
async function waitArea(page,id,key,value){await page.waitForFunction(({id,key,value})=>__universe.getState().scene.areas.find(area=>area.id===id)?.[key]===value,{id,key,value});}
async function openReview(page){await page.bringToFront();const button=page.locator('.builder-recovery').getByRole('button',{name:'Review changes',exact:true});await button.waitFor();await button.click();await review(page).waitFor();}
async function takeServer(page){
 if(await review(page).isVisible())await review(page).getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('button',{name:'Load server version',exact:true}).click();
 await page.waitForFunction(()=>!__universe.getEditor().dirty);
}
async function nativePoint(page,x,z){
 await page.bringToFront();await page.waitForFunction(()=>{const f=__universe.getCamera().framing;return f.status==='manual'||!f.targetOffset||Math.hypot(f.offset.x-f.targetOffset.x,f.offset.y-f.targetOffset.y)<1;});
 const point=await page.evaluate(({x,z})=>__universe.getScreenPoint(x,z,0),{x,z});
 assert(point?.visible);assert.equal(await page.evaluate(point=>document.elementFromPoint(point.x,point.y)?.id,point),'game');return point;
}
async function addChair(page,x,z){
 await page.bringToFront();if(!await page.locator('.builder-tray').isVisible())await page.getByRole('button',{name:'＋ Furniture',exact:true}).click();
 await page.getByRole('button',{name:'Place Chair',exact:true}).click();const point=await nativePoint(page,x,z);
 await page.mouse.click(point.x,point.y);assert.equal((await edit(page)).dirty,true);return(await state(page)).scene.objects.at(-1).id;
}
async function check(name,run){
 phase=name;const started=performance.now();
 try{await run();checks.push({name,status:'passed',durationMs:Math.round(performance.now()-started)});console.log('PASS',name);}
 catch(error){checks.push({name,status:'failed',error:error.stack,durationMs:Math.round(performance.now()-started)});throw error;}
}
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};}
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out waiting for '+label)),60000);})]);}finally{clearTimeout(timer);}}

try{
 const a=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
 const b=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});contexts.push(a,b);
 await call(a,'/api/session','POST',{name:'Alice area editor'});
 await call(a,'/api/rooms/room/scene','PUT',{revision:0,scene:initial});
 bobUser=(await call(b,'/api/session','POST',{name:'Bob area editor'})).user;
 await call(a,'/api/worlds/world/members/'+bobUser.id,'PUT',{role:'editor'});
 alice=await enter(a,'alice');bob=await enter(b,'bob');
 assert.equal((await state(alice)).room.sceneOperations.version,1,'V1 capability remains available');
 assert.equal((await state(alice)).room.sceneOperationsV2.version,2);
 await bob.route(base+'/api/events',route=>blockBobEvents?route.abort('failed'):route.continue());

 await check('A native Silent area and an independent peer object save in both orders with current privacy policy',async()=>{
  await onEntry(alice,'quiet','silent');await field(bob,'chair-a','Name','Bob keeps this chair');
  await save(bob);await alice.waitForFunction(()=>__universe.getState().scene.objects.find(item=>item.id==='chair-a').name==='Bob keeps this chair');
  assert.equal(area(await state(alice),'quiet').action,'silent');assert.equal((await edit(alice)).dirty,true);await save(alice);
  await waitArea(bob,'quiet','action','silent');
  for(const context of[a,b])assert.equal((await call(context,'/api/media')).context.kind,'silent');
  for(const page of[alice,bob])await page.waitForFunction(()=>document.querySelector('#area-name')?.textContent.includes('No calls'));
  await onEntry(alice,'quiet','welcome');await field(bob,'chair-b','Name','Bob second independent chair');
  await save(alice);await waitArea(bob,'quiet','action','welcome');assert.equal((await edit(bob)).dirty,true);await save(bob);
  const room=(await call(a,'/api/rooms/room')).room;
  assert.equal(area(room,'quiet').action,'welcome');assert.equal(item(room,'chair-b').name,'Bob second independent chair');
  for(const context of[a,b])assert.notEqual((await call(context,'/api/media')).context.kind,'silent');
 });

 await check('Native distinct area edits retain both committed values and server area order',async()=>{
  const order=(await state(alice)).scene.areas.map(area=>area.id);
  await field(alice,'quiet','Area message','Alice welcome message');await field(bob,'lounge','Name','Bob lounge');
  await save(alice);await waitArea(bob,'quiet','message','Alice welcome message');assert.equal((await edit(bob)).dirty,true);await save(bob);
  const room=(await call(a,'/api/rooms/room')).room;assert.equal(area(room,'quiet').message,'Alice welcome message');assert.equal(area(room,'lounge').name,'Bob lounge');assert.deepEqual(room.scene.areas.map(area=>area.id),order);
 });

 await check('Same-area conflict keeps both versions through native cancel, exact export and reviewed save',async()=>{
  await field(alice,'lounge','Name','Alice competing lounge');await field(bob,'lounge','Name','Bob competing lounge');
  const draft=(await state(bob)).scene;await save(alice);await openReview(bob);
  assert.match(await review(bob).innerText(),/Alice competing lounge/);assert.match(await review(bob).innerText(),/Bob competing lounge/);
  await review(bob).getByRole('button',{name:'Cancel',exact:true}).click();assert.deepEqual((await state(bob)).scene,draft);
  const pending=bob.waitForEvent('download');await bob.getByRole('button',{name:'Export my draft',exact:true}).click();const download=await pending;await download.saveAs(out+'/area-conflict.json');assert.deepEqual(JSON.parse(await readFile(out+'/area-conflict.json','utf8')).scene,draft);
  await openReview(bob);await bob.getByLabel('Keep mine',{exact:true}).check();await bob.getByRole('button',{name:'Use reviewed choices',exact:true}).click();await bob.waitForFunction(()=>history.state?.surface==='build');await save(bob);
  assert.equal(area((await call(a,'/api/rooms/room')).room,'lounge').name,'Bob competing lounge');
 });

 await check('A conflicting Environment field can use the server value while keeping an independent local item',async()=>{
  await theme(alice,'studio');await field(bob,'chair-a','Name','Bob item beside theme conflict');await theme(bob,'assembly');
  await save(alice);await openReview(bob);assert.match(await review(bob).innerText(),/studio/);assert.match(await review(bob).innerText(),/assembly/);
  await bob.getByLabel('Use server',{exact:true}).check();await bob.getByRole('button',{name:'Use reviewed choices',exact:true}).click();await bob.waitForFunction(()=>history.state?.surface==='build');
  assert.equal((await state(bob)).scene.theme,'studio');assert.equal(item(await state(bob),'chair-a').name,'Bob item beside theme conflict');assert.equal((await edit(bob)).dirty,true);await save(bob);
  const room=(await call(a,'/api/rooms/room')).room;assert.equal(room.scene.theme,'studio');assert.equal(item(room,'chair-a').name,'Bob item beside theme conflict');
 });

 await check('Unseen changes in an overlapping area require review without automatically saving either draft',async()=>{
  await field(alice,'overlap-a','Area message','Alice changes overlapping A');await field(bob,'overlap-b','Area message','Bob changes overlapping B');
  const draft=(await state(alice)).scene,attempts=requests.filter(request=>request.label==='alice').length;
  await save(bob);await openReview(alice);assert.equal(requests.filter(request=>request.label==='alice').length,attempts);assert.deepEqual((await state(alice)).scene,draft);
  await review(alice).getByRole('button',{name:'Cancel',exact:true}).click();assert.deepEqual((await state(alice)).scene,draft);
  await takeServer(alice);const room=(await call(a,'/api/rooms/room')).room;assert.equal(area(room,'overlap-a').message,'A');assert.equal(area(room,'overlap-b').message,'Bob changes overlapping B');
 });

 await check('A named arrival move versus a peer blocker cannot silently commit an invalid combined landing',async()=>{
  await select(alice,'east-entry');const x=alice.getByLabel('X',{exact:true});await x.fill('6');await x.press('Tab');assert.equal(area(await state(alice),'east-entry').x,6);
  const id=await addChair(bob,6,0);await save(bob);await openReview(alice);const room=(await call(a,'/api/rooms/room')).room;
  assert.equal(area(room,'east-entry').x,8);assert(room.scene.objects.some(item=>item.id===id));assert.equal(area(await state(alice),'east-entry').x,6);
  const revision=room.revision,attempts=requests.filter(request=>request.label==='alice').length;
  for(const fieldset of await review(alice).locator('fieldset').all()){const mine=fieldset.locator('input[type=radio][value=mine]');if(await mine.count())await mine.check();}
  await review(alice).getByRole('button',{name:'Use reviewed choices',exact:true}).click();assert.equal(await review(alice).isVisible(),true,'Acknowledgment cannot bypass invalid physical landing geometry');
  assert.equal((await call(a,'/api/rooms/room')).room.revision,revision);assert.equal(requests.filter(request=>request.label==='alice').length,attempts);await takeServer(alice);
 });

 await check('Lost area response retries its exact batch and keeps later local and peer field changes',async()=>{
  let dropped=false,first;await alice.route(base+'/api/rooms/room/scene/operations',async route=>{if(!dropped){dropped=true;first=route.request().postDataJSON();const response=await route.fetch();assert.equal(response.status(),200);await route.abort('failed');}else await route.continue();});
  await field(alice,'lounge','Name','Area committed before response loss');await alice.getByRole('button',{name:'Save room',exact:true}).click();await alice.getByRole('button',{name:'Retry save',exact:true}).waitFor();
  await field(alice,'lounge','Area message','Later local area message');await theme(bob,'garden');await save(bob);
  await alice.getByRole('button',{name:'Retry save',exact:true}).click();await alice.waitForFunction(()=>!__universe.getEditor().saving);
  assert.equal(area(await state(alice),'lounge').message,'Later local area message');assert.equal((await state(alice)).scene.theme,'garden');assert.equal((await edit(alice)).dirty,true);
  const same=requests.filter(request=>request.body.operationId===first.operationId);assert.equal(same.length,2);assert.deepEqual(same[0].body,same[1].body);assert.equal(first.version,2);await save(alice);await alice.unroute(base+'/api/rooms/room/scene/operations');
  const room=(await call(a,'/api/rooms/room')).room;assert.equal(area(room,'lounge').message,'Later local area message');assert.equal(room.scene.theme,'garden');
 });

 await check('Missed native SSE recovers a peer theme without discarding an unsaved area draft',async()=>{
  await field(bob,'lounge','Area message','Bob draft survives missed events');blockBobEvents=true;app.server.closeAllConnections();await bob.waitForFunction(()=>!__universe.getState().online);
  await alice.waitForFunction(()=>__universe.getState().online);await theme(alice,'assembly');await save(alice);blockBobEvents=false;
  await bob.waitForFunction(()=>__universe.getState().online&&__universe.getState().scene.theme==='assembly');assert.equal(area(await state(bob),'lounge').message,'Bob draft survives missed events');assert.equal((await edit(bob)).dirty,true);await save(bob);
 });

 await check('A role downgrade while an area request is held prevents commit and cannot regain Build',async()=>{
  const held=deferred(),release=deferred(),finished=deferred();let responseStatus;
  await field(bob,'quiet','Area message','Must not commit after downgrade');const draft=(await state(bob)).scene,server=(await call(a,'/api/rooms/room')).room;
  await bob.route(base+'/api/rooms/room/scene/operations',async route=>{held.resolve();await release.promise;try{const response=await route.fetch();responseStatus=response.status();await route.fulfill({response});}finally{finished.resolve();}});
  await bob.getByRole('button',{name:'Save room',exact:true}).click();await bounded(held.promise,'held area request');
  await call(a,'/api/worlds/world/members/'+bobUser.id,'PUT',{role:'member'});await bob.waitForFunction(()=>__universe.getState().room.role==='member');
  release.resolve();await bounded(finished.promise,'denied held request');assert.equal(responseStatus,403);await bob.waitForFunction(()=>!__universe.getEditor().saving);
  assert.equal(await bob.locator('#editor').isVisible(),false);assert.equal(await bob.locator('#dock-build').isDisabled(),true);assert.deepEqual((await state(bob)).scene,draft);
  const current=(await call(a,'/api/rooms/room')).room;assert.equal(current.revision,server.revision);assert.deepEqual(current.scene,server.scene);await bob.unroute(base+'/api/rooms/room/scene/operations');
 });
 assert.deepEqual(errors,[]);
 assert(requests.length>0&&requests.every(request=>request.body.version===2),'Native supported edits use negotiated v2');
 await alice.screenshot({path:out+'/shared-areas.png',timeout:60000});
}catch(error){if(!checks.some(check=>check.name===phase&&check.status==='failed'))checks.push({name:phase,status:'failed',error:error.stack});console.error(error);for(const[label,page]of[['alice',alice],['bob',bob]])await page?.screenshot({path:out+'/failure-'+label+'.png',timeout:60000}).catch(()=>{});process.exitCode=1;}
finally{
 await writeFile(out+'/results.json',JSON.stringify({checks,errors,requests:requests.map(({label,body})=>({label,operationId:body.operationId,version:body.version,baseRevision:body.baseRevision,kinds:body.operations.map(operation=>operation.kind)})),bundleSha256:createHash('sha256').update(await readFile('dist/main.js')).digest('hex'),limits:['Actual two-client game with native authoring input and authenticated local SQLite/HTTP/native SSE','Controlled local response loss and request delay; no fabricated editor state or remote service','Software WebGL only; no physical-device, live call or deployment claim']},null,2));
 for(const context of contexts)await context.close();await browser.close();await app.close();
}
