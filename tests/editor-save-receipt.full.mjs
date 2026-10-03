/** Actual bundled game, real SQLite/HTTP and native SSE. Browser routing holds
 * only delivery of a real successful save receipt; editor input stays native. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createGameServer} from '../server/app.mjs';
import {emptyScene} from '../src/worlds.js';
import {launch} from '../scripts/browser.mjs';
const out='evidence/editor-save-receipt-full';await mkdir(out,{recursive:true});
const browser=await launch(),checks=[],errors=[],diagnostics=[];
const TIMEOUT=60000;
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});promise.catch(()=>{});return{promise,resolve,reject};}
async function waitForReceipt(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out after 60000ms waiting for the intercepted save receipt')),TIMEOUT);})]);}finally{clearTimeout(timer);}}
async function check(name,action){
 const initial={...emptyScene(),objects:[{id:'chair',name:'Original saved chair',type:'chair',x:4,z:3,rotation:0}]};
 const app=createGameServer({database:':memory:',seeds:[{id:'world',name:'Receipt world',rooms:[{id:'r',name:'Receipt room',scene:initial}]}],dist:new URL('../dist',import.meta.url).pathname,questsEnabled:false});
 const diagnostic={name,startedAt:Date.now(),serverRequests:[],transport:[],browserFailures:[]};diagnostics.push(diagnostic);
 app.server.on('request',(req,res)=>{if(req.url!=='/api/rooms/r/scene'||req.method!=='PUT')return;const request={startedAt:Date.now()};diagnostic.serverRequests.push(request);req.once('aborted',()=>request.abortedAt=Date.now());req.once('error',error=>request.error=error.message);res.once('finish',()=>Object.assign(request,{finishedAt:Date.now(),status:res.statusCode}));res.once('close',()=>Object.assign(request,{closedAt:Date.now(),complete:req.complete,writableFinished:res.writableFinished}));});
 app.server.on('connection',socket=>{socket.once('error',error=>diagnostic.transport.push({type:'socket-error',at:Date.now(),code:error.code,message:error.message}));socket.once('close',hadError=>diagnostic.transport.push({type:'socket-close',at:Date.now(),hadError}));});
 app.server.once('close',()=>diagnostic.serverClosedAt=Date.now());
 let owner,actor,page,base,receipt,closing=false;const release=deferred(),held=deferred();
 async function call(context,path,method='GET',data){const response=await context.request.fetch(base+path,{method,timeout:TIMEOUT,...(data===undefined?{}:{data})});const body=await response.json();assert(response.ok(),JSON.stringify(body));return body;}
 try{
 const {port}=await app.listen(0);base=`http://127.0.0.1:${port}`;owner=await browser.newContext();actor=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});page=await actor.newPage();page.setDefaultTimeout(TIMEOUT);page.setDefaultNavigationTimeout(TIMEOUT);page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',request=>diagnostic.browserFailures.push({at:Date.now(),method:request.method(),path:new URL(request.url()).pathname,error:request.failure()?.errorText}));page.once('crash',()=>diagnostic.browserCrashAt=Date.now());await page.bringToFront();
 // Observe events on the app's real native EventSource. No fabricated dispatches.
 await page.addInitScript(()=>{const Native=window.EventSource;window.observedEvents=[];window.EventSource=class extends Native{constructor(...args){super(...args);for(const type of ['scene','role','access-revoked'])this.addEventListener(type,event=>window.observedEvents.push({type,data:JSON.parse(event.data)}));}};});
  await call(owner,'/api/session','POST',{name:'Receipt owner'});await call(owner,'/api/rooms/r/scene','PUT',{revision:0,scene:initial});
  const {user}=await call(actor,'/api/session','POST',{name:'Receipt editor'});await call(owner,'/api/worlds/world/members/'+user.id,'PUT',{role:'editor'});
  await page.goto(base+'/?room=r',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__universe?.getState().ready,undefined,{timeout:60000});
  await page.locator('#dock-build').click();await page.locator('#game').focus();await page.keyboard.press(']');await page.waitForFunction(()=>__universe.getEditor().selected==='chair');
  const input=page.getByRole('textbox',{name:'Name',exact:true});await input.fill('Native draft chair');await input.press('Tab');await page.waitForFunction(()=>__universe.getEditor().dirty);
  await page.route(base+'/api/rooms/r/scene',async route=>{if(route.request().method()!=='PUT')return route.continue();try{diagnostic.routeFetchStartedAt=Date.now();const response=await route.fetch({timeout:TIMEOUT});diagnostic.routeFetchFinishedAt=Date.now();receipt=await response.json();assert.equal(response.status(),200,JSON.stringify(receipt));held.resolve();await release.promise;await route.fulfill({response});}catch(error){diagnostic.routeFailure={at:Date.now(),message:error.message};held.reject(error);if(!closing)errors.push('Save receipt route: '+error.message);await route.abort().catch(()=>{});}});
  await page.getByRole('button',{name:'Save room',exact:true}).click();await waitForReceipt(held.promise);assert.equal(receipt.room.revision,2);await page.waitForFunction(()=>observedEvents.some(e=>e.type==='scene'&&e.data.room?.revision===2));
  const draft=await page.evaluate(()=>__universe.getState().scene);
  const observations=await action({page,owner,actor,user,call,release,receipt,draft,base});
  checks.push({name,status:'passed',...observations});console.log('PASS',name);
 }catch(error){checks.push({name,status:'failed',error:error.stack});console.error(error);await page?.screenshot({path:out+'/failure.png'}).catch(()=>{});process.exitCode=1;}
 finally{closing=true;diagnostic.cleanupStartedAt=Date.now();release.resolve();try{await actor?.close();}finally{try{await owner?.close();}finally{await app.close();}}}
}
try{
 await check('Native edit/save applies already-observed r3 instead of the held r2 receipt',async f=>{
  const room=(await f.call(f.owner,'/api/rooms/r')).room;room.scene.objects.push({id:'newer-chair',name:'Newer committed chair',type:'chair',x:-4,z:-3,rotation:0});await f.call(f.owner,'/api/rooms/r/scene','PUT',{revision:2,scene:room.scene});await f.page.waitForFunction(()=>observedEvents.some(e=>e.type==='scene'&&e.data.room?.revision===3));assert.equal(await f.page.evaluate(()=>__universe.getEditor().saving),true);
  f.release.resolve();await f.page.waitForFunction(()=>!__universe.getEditor().saving);const state=await f.page.evaluate(()=>__universe.getState());assert.equal(state.room.revision,3);assert.equal(state.scene.objects.length,2);assert.equal(await f.page.evaluate(()=>__universe.getEditor().dirty),false);assert.equal(state.scene.objects[0].name,'Native draft chair');await f.page.screenshot({path:out+'/newer-scene.png'});
  return{revision:state.room.revision,objectIds:state.scene.objects.map(o=>o.id)};
 });
 await check('Connected downgrade remains read-only after the held successful receipt',async f=>{
  await f.call(f.owner,'/api/worlds/world/members/'+f.user.id,'PUT',{role:'member'});await f.page.waitForFunction(()=>__universe.getState().room.role==='member');await f.page.waitForFunction(()=>observedEvents.some(e=>e.type==='role'&&e.data.role==='member'));
  f.release.resolve();await f.page.waitForFunction(()=>!__universe.getEditor().saving);const state=await f.page.evaluate(()=>__universe.getState());assert.equal(state.room.revision,2);assert.equal(state.room.role,'member');assert.equal(state.room.capabilities.canEditScene,false);assert.equal(await f.page.locator('#dock-build').isDisabled(),true);assert.equal(await f.page.locator('#editor').isVisible(),false);assert.equal((await f.actor.request.put(f.base+'/api/rooms/r/scene',{data:{revision:2,scene:state.scene}})).status(),403);await f.page.screenshot({path:out+'/downgraded.png'});
  return{revision:state.room.revision,role:state.room.role,canEditScene:state.room.capabilities.canEditScene};
 });
 await check('Connected room retirement keeps its export snapshot and ignores the held receipt',async f=>{
  await f.call(f.owner,'/api/worlds/world/members/'+f.user.id,'DELETE');await f.page.getByText('You’ve left this room',{exact:true}).waitFor();await f.page.waitForFunction(()=>__universe.getState().room===null);
  f.release.resolve();await f.page.waitForFunction(()=>!__universe.getEditor().saving);const state=await f.page.evaluate(()=>__universe.getState());assert.equal(state.room,null);assert.deepEqual(state.scene,f.draft);assert.equal(await f.page.locator('#dock-build').isDisabled(),true);
  const promised=f.page.waitForEvent('download');await f.page.getByRole('button',{name:'Export my unsaved draft',exact:true}).click();const download=await promised;await download.saveAs(out+'/retired-draft.json');assert.deepEqual(JSON.parse(await readFile(out+'/retired-draft.json','utf8')).scene,f.draft);await f.page.screenshot({path:out+'/retired.png'});return{room:null,exactExport:true};
 });
 assert.deepEqual(errors,[]);
}finally{await browser.close();await writeFile(out+'/results.json',JSON.stringify({checks,errors,diagnostics,bundleSha256:createHash('sha256').update(await readFile('dist/main.js')).digest('hex'),limits:['Actual bundled game and local in-memory SQLite; native DOM input and real native EventSource events','Test wrapper records native SSE only; routing delays an authentic HTTP receipt without changing its contents','Software WebGL Chromium, no physical-device, hosted service, or deployment claim','Whole-scene CAS save ordering repair; no collaborative operation merge']},null,2));}
