/** Actual app/SQLite/SSE with native editor input. Faults affect only synthetic
 * HTTP replies; mutations and lost-ACK retries use the real scene transaction. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createGameServer} from '../server/app.mjs';
import {bootstrapOwner,addReviewer} from '../server/operator-accounts.mjs';
import {emptyScene} from '../src/worlds.js';
import {launch} from '../scripts/browser.mjs';
const out='evidence/editor-handoff-safety';await mkdir(out,{recursive:true});
const sourceIdentity=()=>({head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(),trackedChanges:execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim()});
const sourceBefore=sourceIdentity();
const browser=await launch(),checks=[],errors=[];
const savePath='/api/rooms/r/scene/operations';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function scenario(name,action){
 if(process.env.EDITOR_HANDOFF_FILTER&&!new RegExp(process.env.EDITOR_HANDOFF_FILTER).test(name))return;
 const initial={...emptyScene(),objects:[{id:'chair',name:'Original chair',type:'chair',x:4,z:3,rotation:0}]};
 const app=createGameServer({database:':memory:',seeds:[{id:'world',name:'Flow world',rooms:[{id:'r',name:'Flow room',scene:initial}]}],dist:new URL('../dist',import.meta.url).pathname,questsEnabled:false});
 const streams=new Set();app.server.on('request',(req,res)=>{if(new URL(req.url,'http://127.0.0.1').pathname==='/api/events'){streams.add(res);res.once('close',()=>streams.delete(res));}});
 const password='synthetic editor handoff password';await bootstrapOwner(app.store,{name:'Synthetic owner',username:'flow_owner',password});const actor=await addReviewer(app.store,{name:'Synthetic editor',username:'flow_editor',password});
 const base='http://127.0.0.1:'+(await app.listen(0)).port;
 const owner=await browser.newContext(),context=await browser.newContext({viewport:{width:1440,height:900}}),p=await context.newPage(),writes=[],releases=[];
 p.setDefaultTimeout(45000);p.on('pageerror',e=>errors.push(name+': '+e.message));
 await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
 p.on('request',r=>{if(new URL(r.url()).pathname===savePath&&r.method()==='POST')writes.push(r.postDataJSON());});
 const button=label=>p.getByRole('button',{name:label,exact:true});
 const editor=()=>p.evaluate(()=>window.__universe.getEditor());
 const state=()=>p.evaluate(()=>window.__universe.getState());
 async function call(path,method='GET',data){const response=await owner.request.fetch(base+path,{method,...(data===undefined?{}:{data})});const json=await response.json();assert(response.ok(),JSON.stringify(json));return json;}
 async function choose(target='bots'){
  if(target==='play')await button('Close editor').click();else await p.locator('#manage-bots').click();
  await button(target==='play'?'Save & play':'Save room & edit residents').waitFor();
 }
 async function submit(target='bots'){await choose(target);await button(target==='play'?'Save & play':'Save room & edit residents').click();}
 async function holdReceipt(){
  const held=deferred(),release=deferred();releases.push(release);
  await p.route(base+savePath,async r=>{try{const response=await r.fetch();assert(response.ok());held.resolve(await response.json());await release.promise;await r.fulfill({response});}catch(e){held.resolve({failure:e.message});await r.abort().catch(()=>{});}});
  return{held,release};
 }
 async function reconnect(){
  const joined=p.waitForResponse(response=>new URL(response.url()).pathname==='/api/rooms/r/join'&&response.request().postDataJSON()?.mode==='resume'&&response.ok());
  assert(streams.size>0);for(const stream of [...streams])stream.end();await joined;
  await p.waitForFunction(()=>window.__universe.getState().ready&&!document.querySelector('#editor').inert);
 }
 try{
  await call('/api/login','POST',{username:'flow_owner',password});await call('/api/worlds/world/members/'+actor.id,'PUT',{role:'editor'});
  await p.goto(base+'/?room=r');await p.waitForFunction(()=>window.__universe);
  if(await p.locator('#login-form').isHidden())await p.locator('#show-login').click();
  await p.locator('#login-username').fill('flow_editor');await p.locator('#login-password').fill(password);await p.locator('#login-button').click();
  await p.waitForFunction(()=>window.__universe?.getState().ready&&window.__universe.getState().botPermissions.canManage);
  await p.locator('#dock-build').click();await p.locator('#game').focus();await p.keyboard.press(']');await p.waitForFunction(()=>window.__universe.getEditor().selected==='chair');
  await p.getByRole('textbox',{name:'Name',exact:true}).fill('Exact handoff draft');await p.getByRole('textbox',{name:'Name',exact:true}).press('Tab');await p.waitForFunction(()=>window.__universe.getEditor().dirty);
  const draft=(await state()).scene;
  await action({p,button,editor,state,call,choose,submit,holdReceipt,reconnect,writes,base,actor,draft});
  checks.push({name,pass:true,writes:writes.map(w=>({operationId:w.operationId,baseRevision:w.baseRevision}))});console.log('PASS',name);
  await p.screenshot({path:out+'/'+name.replaceAll(/[^a-z0-9]+/gi,'-').toLowerCase()+'.png'});
 }catch(error){checks.push({name,pass:false,error:error.stack});console.error(name,error);process.exitCode=1;await p.screenshot({path:out+'/failure.png'}).catch(()=>{});}
 finally{for(const release of releases)release.resolve();await context.close();await owner.close();await app.close();}
}
try{
 await scenario('Keep draft and Cancel do not write',async f=>{
  await f.choose('play');await f.button('Keep editing').click();assert.deepEqual((await f.state()).scene,f.draft);
  await f.choose('play');await f.button('Keep draft').click();assert(await f.p.locator('#editor').isHidden());assert((await f.editor()).dirty);assert.equal(await f.p.locator('#dock-build label').innerText(),'Draft');
  await f.choose();await f.button('Cancel').click();assert.equal(f.writes.length,0);assert.deepEqual((await f.state()).scene,f.draft);
 });
 await scenario('Back and Forward retire an unsubmitted decision safely',async f=>{
  await f.choose();await f.p.goBack();await f.p.locator('#dialog').waitFor({state:'hidden'});await f.p.goForward();assert(await f.p.locator('#dialog').isHidden());assert.equal(f.writes.length,0);assert.deepEqual((await f.state()).scene,f.draft);
  await f.submit();await f.p.getByTestId('bot-create').waitFor();assert.equal(f.writes.length,1);
 });
 await scenario('Retained reconnect retires an unsubmitted decision safely',async f=>{
  const admission=(await f.state()).admissionId;await f.choose();await f.reconnect();assert.equal((await f.state()).admissionId,admission);assert(await f.p.locator('#dialog').isHidden());assert(await f.p.locator('#editor').isVisible());assert.equal(f.writes.length,0);assert.deepEqual((await f.state()).scene,f.draft);
  await f.submit();await f.p.getByTestId('bot-create').waitFor();assert.equal(f.writes.length,1);
 });
 await scenario('Retained reconnect retires a pending save decision without reopening destination',async f=>{
  const admission=(await f.state()).admissionId,{held,release}=await f.holdReceipt();await f.submit();await held.promise;await f.reconnect();assert.equal((await f.state()).admissionId,admission);assert(await f.p.locator('#editor').isVisible());
  release.resolve();await f.p.waitForFunction(()=>!window.__universe.getEditor().saving);assert(!(await f.editor()).dirty);assert(await f.p.getByTestId('bot-editor').isHidden());assert(await f.p.locator('#dialog').isHidden());assert.deepEqual((await f.state()).scene,f.draft);assert.equal(f.writes.length,1);
  await f.p.locator('#manage-bots').click();await f.p.getByTestId('bot-create').waitFor();assert.equal(f.writes.length,1);
 });
 await scenario('Newer generic dialog survives retained reconnect and older save acknowledgement',async f=>{
  const {held,release}=await f.holdReceipt();await f.submit();await held.promise;await f.button('Cancel').click();await f.button('Keyboard shortcuts').click();await f.p.locator('#dialog').getByRole('heading',{name:'Make yourself at home',exact:true}).waitFor();const content=await f.p.locator('#dialog').innerText();
  await f.reconnect();release.resolve();await f.p.waitForFunction(()=>!window.__universe.getEditor().saving);assert(await f.p.locator('#dialog').isVisible());assert.equal(await f.p.locator('#dialog').innerText(),content);assert(await f.p.getByTestId('bot-editor').isHidden());assert.equal(f.writes.length,1);
 });
 await scenario('Save and play waits for acknowledgement',async f=>{
  const {held,release}=await f.holdReceipt();await f.submit('play');await held.promise;assert(await f.p.locator('#dialog').isVisible());assert(await f.p.locator('#editor').isVisible());assert((await f.editor()).saving);const target=await f.p.locator('#dialog-actions button').first().boundingBox();await f.p.mouse.dblclick(target.x+target.width/2,target.y+target.height/2);assert.equal(f.writes.length,1);
  release.resolve();await f.p.locator('#editor').waitFor({state:'hidden'});assert(!(await f.editor()).dirty);assert.equal(f.writes.length,1);
 });
 await scenario('Definitive save failure retains exact draft and allows retry',async f=>{
  await f.p.route(f.base+savePath,r=>r.fulfill({status:403,contentType:'application/json',body:JSON.stringify({code:'FIXTURE_DENIED',message:'Synthetic save denied'})}));
  await f.submit();await f.p.waitForFunction(()=>!window.__universe.getEditor().saving);assert(await f.p.locator('#dialog').isVisible());assert.deepEqual((await f.state()).scene,f.draft);assert((await f.editor()).dirty);assert(await f.p.getByTestId('bot-editor').isHidden());
  await f.p.unroute(f.base+savePath);await f.button('Save room & edit residents').click();await f.p.getByTestId('bot-create').waitFor();assert(!(await f.editor()).dirty);assert.equal(f.writes.length,2);
 });
 await scenario('Lost acknowledgement retries identical operation exactly once',async f=>{
  let first=true;await f.p.route(f.base+savePath,async r=>{if(first){first=false;const response=await r.fetch();assert(response.ok());await r.abort();}else await r.continue();});
  await f.submit();await f.p.waitForFunction(()=>!window.__universe.getEditor().saving);assert((await f.editor()).dirty);assert(await f.p.locator('#dialog').isVisible());
  await f.button('Save room & edit residents').click();await f.p.getByTestId('bot-create').waitFor();assert.equal(f.writes.length,2);assert.deepEqual(f.writes[0],f.writes[1]);assert.equal((await f.state()).room.revision,1);
 });
 for(const dismiss of ['Cancel','Back'])await scenario(dismiss+' during save cannot reopen old destination',async f=>{
  const {held,release}=await f.holdReceipt();await f.submit();await held.promise;if(dismiss==='Back'){await f.p.goBack();await f.p.locator('#dialog').waitFor({state:'hidden'});await f.p.goForward();}else await f.button('Cancel').click();await f.p.locator('#dialog').waitFor({state:'hidden'});
  release.resolve();await f.p.waitForFunction(()=>!window.__universe.getEditor().saving);assert(await f.p.getByTestId('bot-editor').isHidden());assert(await f.p.locator('#dialog').isHidden());assert.deepEqual((await f.state()).scene,f.draft);assert.equal(f.writes.length,1);
 });
 await scenario('Concurrent edit conflict never leaves draft silently',async f=>{
  const room=(await f.call('/api/rooms/r')).room;room.scene.objects[0].name='Concurrent saved chair';await f.call('/api/rooms/r/scene','PUT',{revision:room.revision,scene:room.scene});
  await f.submit();await f.p.waitForFunction(()=>!window.__universe.getEditor().saving);assert((await f.editor()).dirty);assert.equal((await f.state()).scene.objects[0].name,'Exact handoff draft');assert(await f.p.getByTestId('bot-editor').isHidden());
  if(await f.p.locator('#dialog').isVisible())await f.button('Return to Build').click();assert(await f.p.locator('#editor').isVisible());assert(f.writes.length<=1);
 });
 await scenario('Permission loss invalidates submitted save continuation',async f=>{
  const {held,release}=await f.holdReceipt();await f.submit();await held.promise;await f.call('/api/worlds/world/members/'+f.actor.id,'PUT',{role:'member'});await f.p.waitForFunction(()=>window.__universe.getState().room.role==='member');
  release.resolve();await f.p.waitForFunction(()=>!window.__universe.getEditor().saving);assert(await f.p.getByTestId('bot-editor').isHidden());assert(await f.p.locator('#dock-build').isDisabled());assert.equal((await f.state()).room.capabilities.canEditScene,false);
 });
 await scenario('Room retirement ignores submitted save destination',async f=>{
  const {held,release}=await f.holdReceipt();await f.submit();await held.promise;await f.call('/api/worlds/world/members/'+f.actor.id,'DELETE');await f.p.waitForFunction(()=>window.__universe.getState().room===null);
  release.resolve();await f.p.waitForFunction(()=>!window.__universe.getEditor().saving);assert(await f.p.getByTestId('bot-editor').isHidden());assert.equal((await f.state()).room,null);assert.deepEqual((await f.state()).scene,f.draft);
 });
 assert.deepEqual(errors,[]);
}finally{await browser.close();await writeFile(out+'/results.json',JSON.stringify({checks,errors,sourceBefore,sourceAfter:sourceIdentity(),bundleSha256:createHash('sha256').update(await readFile('dist/main.js')).digest('hex'),limits:['Native Chromium software WebGL; no physical device or hosted deployment claim','Synthetic registered accounts, real SQLite/HTTP/SSE and scene operations','One explicit injected 403; one dropped real receipt; delayed replies preserve real server bodies']},null,2));}
