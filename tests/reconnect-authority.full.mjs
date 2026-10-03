/** Actual-shell regression for a guaranteed missed revocation, not offline emulation.
 * Local HTTP fixtures create ordinary accounts, private hierarchy, and invitation.
 * Native browser input creates/exports the draft and opens the accessible directory.
 */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createGameServer} from '../server/app.mjs';
import {emptyScene,seedWorlds} from '../src/worlds.js';
import {launch} from '../scripts/browser.mjs';

const connected=process.env.UNIVERSE_RECONNECT_MODE==='connected';
const out=process.env.UNIVERSE_RECONNECT_EVIDENCE||'evidence/reconnect-authority'+(connected?'-connected':'');
await mkdir(out,{recursive:true});
const app=createGameServer({database:':memory:',seeds:seedWorlds,dist:new URL('../dist',import.meta.url).pathname,questsEnabled:false});
const streams=new Set(),streamLog=[];
app.server.on('request',(req,res)=>{
 if(req.url!=='/api/events')return;
 const entry={openedAt:Date.now(),closedAt:null,events:[]};streamLog.push(entry);streams.add(res);
 const write=res.write.bind(res);res.write=(chunk,...args)=>{entry.events.push(String(chunk));return write(chunk,...args);};
 res.once('close',()=>{entry.closedAt=Date.now();streams.delete(res);});
});
const {port}=await app.listen(0),base='http://127.0.0.1:'+port,browser=await launch();
const owner=await browser.newContext(),editor=await browser.newContext({viewport:{width:1600,height:1000},acceptDownloads:true}),page=await editor.newPage();
page.setDefaultTimeout(20000);page.setDefaultNavigationTimeout(60000);
const checks=[],errors=[],heldCatalog=[],heldPlaces=[];let blockEvents=false,blockedRetries=0,revokedAt=null,beforeDraft=null,holdCatalog=false,holdPlaces=false;
const result={scenario:connected?'connected-revocation':'missed-revocation-reconnect',source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),bundleSha256:createHash('sha256').update(await readFile('dist/main.js')).digest('hex'),checks,errors,streamLog,limits:['Isolated local server, real HTTP; missed-event case destroys the actual SSE socket and blocks retries','Native Chromium keyboard/pointer input; browser evaluation only reads diagnostics','No cloud/offline emulation, hidden app actions, external audit scripts, production services or physical device claim']};
page.on('pageerror',error=>errors.push(error.message));
await editor.route('**/api/events',route=>{if(blockEvents){blockedRetries++;return route.abort('connectionrefused');}return route.continue();});
await editor.route('**/api/worlds',async route=>{if(!holdCatalog)return route.continue();holdCatalog=false;const response=await route.fetch();heldCatalog.push({route,response});});
await editor.route('**/api/universes?*',async route=>{if(!holdPlaces)return route.continue();holdPlaces=false;const response=await route.fetch();heldPlaces.push({route,response});});
async function call(context,path,method='GET',data){const response=await context.request.fetch(base+path,{method,...(data===undefined?{}:{data})});const body=await response.json();assert(response.ok(),method+' '+path+' '+JSON.stringify(body));return body;}
async function account(context,name,username){const session=await call(context,'/api/session','POST',{name});await call(context,'/api/account','POST',{username,password:'local-regression-password-123'});return session.user;}
function check(name,ok,details={}){checks.push({name,status:ok?'passed':'failed',...details});console.log(ok?'PASS':'FAIL',name);}
async function until(predicate,label){const stop=Date.now()+25000;while(!predicate()){if(Date.now()>stop)throw Error('Timed out: '+label);await page.waitForTimeout(40);}}
const state=()=>page.evaluate(()=>window.__universe.getState());
try{
 await account(owner,'Private owner','reconnect_owner');const actor=await account(editor,'Invited editor','reconnect_editor');
 const universe=(await call(owner,'/api/universes','POST',{name:'Private reconnect universe',public:false})).universe;
 const world=(await call(owner,'/api/worlds','POST',{universeId:universe.id,name:'Private reconnect world',public:false})).world;
 const room=(await call(owner,'/api/rooms','POST',{worldId:world.id,name:'Private reconnect room',public:false})).room;
 const scene={...emptyScene(),objects:[{id:'draft-chair',type:'chair',name:'Saved chair',x:4,z:3,rotation:0}],spawn:{x:0,z:5}};
 await call(owner,`/api/rooms/${room.id}/scene`,'PUT',{revision:room.revision,scene});
 assert.equal((await editor.request.get(base+`/api/rooms/${room.id}`)).status(),404);
 const invitation=(await call(owner,`/api/worlds/${world.id}/invitations`,'POST',{userId:actor.id,role:'editor',tags:['maker']})).invitation;
 await call(editor,`/api/invitations/${invitation.id}/accept`,'POST',{});
 await page.goto(base+'/?room='+room.id,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__universe?.getState().ready,undefined,{timeout:60000});
 await page.locator('#dock-explore').click();await page.getByRole('button',{name:'View room '+room.name,exact:true}).waitFor();await page.getByRole('button',{name:'Close places',exact:true}).click();
 holdPlaces=true;await page.locator('#dock-explore').click();await until(()=>heldPlaces.length===1,'a stale Places catalog is held');await page.getByRole('button',{name:'Close places',exact:true}).click();
 await page.locator('#dock-build').click();await page.locator('#game').focus();await page.keyboard.press(']');
 await page.waitForFunction(()=>window.__universe.getEditor().selected==='draft-chair');
 const name=page.getByRole('textbox',{name:'Name',exact:true});await name.fill('Exact retained unsaved chair');await name.press('Tab');
 await page.waitForFunction(()=>window.__universe.getEditor().dirty);beforeDraft=(await state()).scene;
 assert.equal(beforeDraft.objects[0].name,'Exact retained unsaved chair');assert.equal((await state()).room.role,'editor');
 check('Invited editor creates a real dirty draft in owner private hierarchy',true);
 holdCatalog=true;await call(owner,`/api/worlds/${world.id}`,'PATCH',{description:'Delayed pre-revocation directory fixture'});await until(()=>heldCatalog.length===1,'a stale shell catalog is held');
 assert(JSON.stringify(await heldCatalog[0].response.json()).includes(room.id));assert(JSON.stringify(await heldPlaces[0].response.json()).includes(room.id));
 if(!connected){
  blockEvents=true;assert.equal(streams.size,1);const firstStream=[...streams][0];assert(firstStream.socket);firstStream.socket.destroy();
  await until(()=>streams.size===0,'first SSE socket closes');await until(()=>blockedRetries>0,'a retry is blocked');
 }
 revokedAt=Date.now();await call(owner,`/api/worlds/${world.id}/members/${actor.id}`,'DELETE');
 assert.equal((await call(editor,'/api/session')).currentRoomId,null);assert.equal((await editor.request.get(base+`/api/rooms/${room.id}`)).status(),404);
 if(!connected){
  assert.equal(streams.size,0);assert(streamLog[0].closedAt<=revokedAt);assert(!streamLog.some(stream=>stream.events.join('').includes('event: access-revoked')));
  check('Revocation occurs with no SSE socket and a confirmed blocked retry',true,{blockedRetries});
  blockEvents=false;await until(()=>streamLog.length>=2&&streams.size===1,'fresh SSE connection');assert(streamLog[1].events.join('').includes('event: hello'));await page.waitForTimeout(10000);
 }else{await page.getByText('You’ve left this room',{exact:true}).waitFor();assert(streamLog.some(stream=>stream.events.join('').includes('event: access-revoked')));check('Connected access-revoked push reaches the actual app',true);}
 // Release already-fetched private snapshots only after fresh cleanup/catalogs.
 // A baseline failure is still observed below; do not time out hiding its state.
 if((await state()).room===null){
  await page.waitForFunction(()=>window.__universe.getState().worlds.length>0);
  await page.waitForFunction(()=>!document.querySelector('#places').textContent.includes('Private reconnect universe'));
 }
 for(const item of [...heldCatalog.splice(0),...heldPlaces.splice(0)])await item.route.fulfill({response:item.response});await page.waitForTimeout(150);
 result.afterReconnect=await state();result.ui=await page.evaluate(()=>({editorVisible:!document.querySelector('#editor').hidden,buildDisabled:document.querySelector('#dock-build').disabled,dialogVisible:!document.querySelector('#dialog').hidden,title:document.querySelector('#room-name').textContent,dialog:document.querySelector('#dialog').textContent}));
 const current=result.afterReconnect,ui=result.ui;
 check('Missing admission disables all Build authority',!current.ready&&current.admissionId===null&&current.room?.capabilities?.canBuild!==true&&current.room?.capabilities?.canEditScene!==true&&ui.buildDisabled&&!ui.editorVisible,{ready:current.ready,role:current.room?.role,capabilities:current.room?.capabilities,ui});
 check('Reconnect exposes export and accessible-places recovery',ui.dialogVisible&&ui.dialog.includes('Export my unsaved draft')&&ui.dialog.includes('Browse accessible places'));
 check('Dirty draft is byte-for-byte unchanged by failed admission',JSON.stringify(current.scene)===JSON.stringify(beforeDraft));
 check('Late pre-revocation shell and Places responses cannot restore private metadata',!JSON.stringify({worlds:current.worlds,universes:current.universes}).includes(world.id)&&!JSON.stringify({worlds:current.worlds,universes:current.universes}).includes(room.id)&&!await page.locator('#places').textContent().then(text=>text.includes(world.name)));
 check('Retired current room no longer advertises private metadata',current.room===null&&ui.title==='Find your place');
 await page.screenshot({path:out+'/reconnected.png'});
 const exportButton=page.getByRole('button',{name:'Export my unsaved draft',exact:true});
 if(await exportButton.isVisible()){
  const downloadPromise=page.waitForEvent('download');await exportButton.click();const download=await downloadPromise;await download.saveAs(out+'/exported-draft.json');
  const exported=JSON.parse(await readFile(out+'/exported-draft.json','utf8'));
  check('Recovery native download preserves the exact unsaved scene',JSON.stringify(exported.scene)===JSON.stringify(beforeDraft)&&exported.name===room.name,{filename:download.suggestedFilename()});
 }else check('Recovery native download preserves the exact unsaved scene',false,{reason:'Recovery export button missing'});
 const browse=page.getByRole('button',{name:'Browse accessible places',exact:true});
 if(await browse.isVisible())await browse.click();else await page.locator('#dock-explore').click();
 await page.getByRole('button',{name:'View universe Universe',exact:true}).click();
 await page.getByRole('button',{name:'View world Our Universe',exact:true}).click();
 await page.getByRole('button',{name:'View room The Commons',exact:true}).waitFor();
 const directory=await page.locator('#places').innerText();check('Accessible directory opens with public places and no private hierarchy names',!directory.includes(room.name)&&!directory.includes(world.name)&&!directory.includes(universe.name));
 await page.screenshot({path:out+'/accessible-places.png'});assert.deepEqual(errors,[]);
 result.revokedAt=revokedAt;result.blockedRetries=blockedRetries;result.beforeDraft=beforeDraft;
 if(checks.some(check=>check.status==='failed'))process.exitCode=1;
}catch(error){checks.push({name:'failure',status:'failed',error:error.stack});console.error(error);await page.screenshot({path:out+'/failure.png'}).catch(()=>{});process.exitCode=1;}
finally{for(const item of [...heldCatalog,...heldPlaces])await item.route.abort().catch(()=>{});await writeFile(out+'/results.json',JSON.stringify(result,null,2));await editor.close();await owner.close();await browser.close();await app.close();}
