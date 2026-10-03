/** Bounded editor-module race repro with real SQLite HTTP and native SSE.
 * It is not a full-game or native end-to-end user journey. Playwright delays only
 * the successful PUT receipt; it does not fabricate any server room/event.
 */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
import {launch} from '../scripts/browser.mjs';
import {createGameServer} from '../server/app.mjs';
import {emptyScene} from '../src/worlds.js';

const source=`import {mountEditor} from './src/editor.js';
window.install=({room,user})=>{
 const state=window.state={room,scene:structuredClone(room.scene),user,position:{x:0,z:7},ready:true};
 window.logs={events:[],toasts:[]};
 const api=async(url,{method='GET',body}={})=>{const response=await fetch(url,{method,credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.message),{status:response.status,data});return data;};
 const editor=window.editor=mountEditor({root:document.querySelector('#editor'),getState:()=>state,onScene:scene=>state.scene=scene,onSelect:()=>{},toast:message=>logs.toasts.push(message),api});
 editor.attachRoom();editor.setBuild(true);
 const events=window.events=new EventSource('/api/events');
 events.addEventListener('hello',()=>window.streamReady=true);
 for(const type of ['scene','role'])events.addEventListener(type,event=>{
  const data=JSON.parse(event.data);logs.events.push({type,data,saving:editor.isSaving()});
  if(data.roomId!==state.room.id)return;
  // Same role/scene dispatch relevant to this race as src/main.js handleEvent.
  if(type==='role'){state.room.role=data.role;state.room.capabilities=data.capabilities||data.room?.capabilities;if(data.room?.personalAreas)state.room.personalAreas=data.room.personalAreas;}
  if(data.room?.scene){editor.cancelGesture();editor.receiveScene(data.room);}
 });
};`;
const bundle=await build({stdin:{contents:source,resolveDir:process.cwd(),sourcefile:'save-ack-fixture.js'},bundle:true,format:'iife',write:false});
const browser=await launch(),checks=[],errors=[];
const out='evidence/editor-save-ack-ordering';await mkdir(out,{recursive:true});
const TIMEOUT=60000;
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});promise.catch(()=>{});return{promise,resolve,reject};}
async function waitForReceipt(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out after 60000ms waiting for the intercepted save receipt')),TIMEOUT);})]);}finally{clearTimeout(timer);}}
async function fixture(){
 const app=createGameServer({database:':memory:',seeds:[{id:'world',name:'Ordering world',rooms:[{id:'r',name:'Ordering room',scene:emptyScene()}]}],questsEnabled:false});
 let context,closing=false;const held=deferred(),release=deferred();let receipt;
 async function close(){closing=true;release.resolve();try{await context?.close();}finally{await app.close();}}
 try{
 const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`;
 let cookie='';const owner={async call(path,method='GET',body){const response=await fetch(base+path,{method,signal:AbortSignal.timeout(TIMEOUT),headers:{cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];const data=await response.json();assert.equal(response.ok,true,JSON.stringify(data));return data;}};
 await owner.call('/api/session','POST',{name:'Ordering owner'});
 await owner.call('/api/rooms/r/scene','PUT',{revision:0,scene:emptyScene()});
 context=await browser.newContext();const page=await context.newPage();page.setDefaultTimeout(TIMEOUT);page.setDefaultNavigationTimeout(TIMEOUT);await page.bringToFront();page.on('pageerror',error=>errors.push(error.message));
 await page.route(base+'/',route=>route.fulfill({status:200,contentType:'text/html',body:'<canvas id="game" tabindex="0"></canvas><aside id="editor"></aside>'}));
 await page.goto(base+'/');
 const sessionResponse=await page.request.post(base+'/api/session',{data:{name:'Ordering editor'}});assert.equal(sessionResponse.status(),201);const {user}=await sessionResponse.json();
 await owner.call('/api/worlds/world/members/'+user.id,'PUT',{role:'editor'});
 const join=await page.request.post(base+'/api/rooms/r/join',{data:{}});assert.equal(join.status(),200);const {room}=await join.json();assert.equal(room.revision,1);assert.equal(room.role,'editor');
 await page.addScriptTag({content:bundle.outputFiles[0].text});await page.evaluate(input=>install(input),{room,user});await page.waitForFunction(()=>window.streamReady);
 await page.route(base+'/api/rooms/r/scene',async route=>{
  if(route.request().method()!=='PUT')return route.continue();
  try{const response=await route.fetch({timeout:TIMEOUT});receipt=await response.json();assert.equal(response.status(),200,JSON.stringify(receipt));held.resolve(receipt);await release.promise;await route.fulfill({response});}catch(error){held.reject(error);if(!closing)errors.push('Save receipt route: '+error.message);await route.abort().catch(()=>{});}
 });
 await page.locator('[data-tool=chair]').click();
 // Repository editor fixture placement, not a claim about renderer picking.
 await page.evaluate(()=>{editor.pointerDown({point:{x:4,z:3}},{clientX:100,clientY:100,pointerId:1,button:0});editor.pointerUp({point:{x:4,z:3}},{clientX:100,clientY:100,pointerId:1,button:0});});
 assert.equal(await page.evaluate(()=>state.scene.objects.length),1);
 await page.getByRole('button',{name:'Save room',exact:true}).click();await waitForReceipt(held.promise);assert.equal(receipt.room.revision,2);
 await page.waitForFunction(()=>logs.events.some(event=>event.type==='scene'&&event.data.room.revision===2));
 return{app,owner,page,context,base,user,receipt,release,close};
 }catch(error){await close();throw error;}
}
async function check(name,body){let f;try{f=await fixture();const observations=await body(f);checks.push({name,status:'passed',...observations});console.log('PASS',name);}catch(error){checks.push({name,status:'failed',error:error.stack,...(error.observations||{})});console.error('FAIL',name,error.message);process.exitCode=1;}finally{await f?.close();}}
try{
 await check('Control: ordinary receipt and subsequent SSE each adopt the committed revision',async f=>{
  f.release.resolve();await f.page.waitForFunction(()=>!editor.isSaving());
  const saved=await f.page.evaluate(()=>({revision:state.room.revision,dirty:editor.isDirty(),count:state.scene.objects.length}));assert.deepEqual(saved,{revision:2,dirty:false,count:1});
  const current=(await f.owner.call('/api/rooms/r')).room;
  current.scene.objects.push({id:'after-receipt-chair',type:'chair',name:'Subsequent chair',x:-4,z:-3,rotation:0});
  await f.owner.call('/api/rooms/r/scene','PUT',{revision:current.revision,scene:current.scene});
  await f.page.waitForFunction(()=>state.room.revision===3);
  const next=await f.page.evaluate(()=>({revision:state.room.revision,dirty:editor.isDirty(),count:state.scene.objects.length}));assert.deepEqual(next,{revision:3,dirty:false,count:2});return{saved,next};
 });
 await check('A received r3 while saving; delayed r2 HTTP receipt must not strand its clean scene on r2',async f=>{
  const current=(await f.owner.call('/api/rooms/r')).room;assert.equal(current.revision,2);
  current.scene.objects.push({id:'newer-owner-chair',type:'chair',name:'Newer saved chair',x:-4,z:-3,rotation:0});
  const next=(await f.owner.call('/api/rooms/r/scene','PUT',{revision:current.revision,scene:current.scene})).room;assert.equal(next.revision,3);
  await f.page.waitForFunction(()=>logs.events.some(event=>event.type==='scene'&&event.data.room.revision===3&&event.saving));
  f.release.resolve();await f.page.waitForFunction(()=>!editor.isSaving());
  const actual=await f.page.evaluate(()=>({revision:state.room.revision,objectIds:state.scene.objects.map(item=>item.id),dirty:editor.isDirty(),status:document.querySelector('.editor-status').textContent,events:logs.events.map(({type,data,saving})=>({type,revision:data.room?.revision,role:data.room?.role,saving})),toasts:logs.toasts}));
  const server=(await f.owner.call('/api/rooms/r')).room,observations={actual,server:{revision:server.revision,objectIds:server.scene.objects.map(item=>item.id)}};
  try{assert.equal(actual.revision,3);assert(actual.objectIds.includes('newer-owner-chair'));assert.equal(actual.dirty,false);}catch(error){error.observations=observations;throw error;}return observations;
 });
 await check('Live editor-to-member downgrade must survive a delayed successful save receipt',async f=>{
  await f.owner.call('/api/worlds/world/members/'+f.user.id,'PUT',{role:'member'});
  await f.page.waitForFunction(()=>logs.events.some(event=>event.type==='role'&&event.data.role==='member'&&event.saving));
  const during=await f.page.evaluate(()=>({revision:state.room.revision,role:state.room.role,canEditScene:state.room.capabilities.canEditScene,saving:editor.isSaving()}));assert.equal(during.role,'member');assert.equal(during.canEditScene,false);
  f.release.resolve();await f.page.waitForFunction(()=>!editor.isSaving());
  const after=await f.page.evaluate(()=>({revision:state.room.revision,role:state.room.role,canEditScene:state.room.capabilities.canEditScene,chairDisabled:document.querySelector('button[data-tool=chair]').disabled,dirty:editor.isDirty(),events:logs.events.map(({type,data,saving})=>({type,revision:data.room?.revision,role:data.room?.role,saving}))}));
  const denied=await f.page.request.put(f.base+'/api/rooms/r/scene',{data:{revision:f.receipt.room.revision,scene:f.receipt.room.scene}}),denial=await denied.json();
  const observations={during,after,backend:{status:denied.status(),code:denial.code}};
  try{assert.equal(denied.status(),403);assert.equal(after.role,'member');assert.equal(after.canEditScene,false);assert.equal(after.chairDisabled,true);}catch(error){error.observations=observations;throw error;}return observations;
 });
 assert.deepEqual(errors,[]);
}finally{await browser.close();await writeFile(out+'/results.json',JSON.stringify({checks,errors,limits:['Regression reproduction authored locally and integrated on base c196513c36fe2d162796149d90fea4c62bb05496; source remains scoped to the editor','Real in-memory SQLite server, HTTP CAS commits and native EventSource; only HTTP response delivery is delayed','Isolated repository editor module with fixture placement; no renderer, full-game journey, WebGL, remote service, or deployment','The two race checks fail against the unmodified base and pass with receipt reconciliation']},null,2));}
