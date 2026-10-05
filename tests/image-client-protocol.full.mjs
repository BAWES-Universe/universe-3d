/** Actual immutable bc715 bundle vs the compatible current bundle.
 * Run under flock /tmp/universe-shared-webgl.lock, with UNIVERSE_LEGACY_SOURCE
 * pointing at the authorized clean baseline checkout. No baseline files change.
 * Native browser input creates the draft, uploads/places/saves the sized image,
 * and downloads recovery. evaluate() is read-only diagnostic access.
 */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createGameServer} from '../server/app.mjs';
import {emptyScene} from '../src/worlds.js';
import {launch} from '../scripts/browser.mjs';
import {makePng} from '../fixtures/png-fixtures.mjs';
import {buildClients,bounded,deferred,instrument,ok,request,assertFenced,makeDirty,exportRetiredDraft,assertLegacyRetirement,capability,sha} from './fixtures/image-client-protocol-fixture.mjs';

const currentCapability=capability+',composition-furniture-v1';
const output=process.env.UNIVERSE_PROTOCOL_EVIDENCE||'evidence/image-client-protocol';await mkdir(output,{recursive:true});
const clients=await buildClients(),browser=await launch(),checks=[];
const sourceSha256=Object.fromEntries(await Promise.all(['server/app.mjs','server/image-client-protocol.mjs','server/image-assets.mjs','src/main.js','src/client-protocol.js','src/image-library-shell.js','src/image-library-panel.js','src/image-library-setup.js','src/files.js','src/image-asset-loader.js','src/image-recovery-export.js','server/image-protocol-capabilities.json'].map(async path=>[path,sha(await readFile(new URL('../'+path,import.meta.url)))])));
const results={startedAt:new Date().toISOString(),baseline:clients.baseline,sourceSha256,legacyBundleSha256:clients.legacy.mainSha256,currentBundleSha256:clients.current.mainSha256,testSha256:sha(await readFile(new URL(import.meta.url))),checks,limits:[
 'Exact authorized bc715 application bundle, compiled without changing its source; no obsolete server binary is executed',
 'Disposable loopback HTTP/SSE/SQLite, synthetic accounts and PNG; no external service, production data or deployment',
 'Native mouse/keyboard/upload/download for claimed editing paths; browser evaluation only reads application/DOM state',
 'Supported rollback means this compatible runtime restarted with writes disabled; arbitrary unmodified old-server rollback cannot honor a new metadata fence',
 'Targeted denial protects the reproduced old same-room held-resume case; arbitrary already-delivered bytes for unknown historical destinations cannot be retroactively revoked'
]};
const persist=()=>writeFile(join(output,'results.json'),JSON.stringify(results,null,2));
const initial={...emptyScene(),objects:[{id:'a',type:'chair',name:'Original chair',x:-4,z:-3,rotation:0}]};
const seeds=[{id:'world',name:'Protocol world',rooms:[{id:'room',name:'Protocol room',scene:initial}]}];
async function scenario(name,run,{modern=false}={}){
 if(process.env.UNIVERSE_PROTOCOL_CASE&&!name.includes(process.env.UNIVERSE_PROTOCOL_CASE))return;
 const database=join(clients.temporary,name+'.sqlite'),config={database,seeds,dist:modern?clients.current.directory:clients.legacy.directory,questsEnabled:false,imagePhysicalSizeEnabled:modern};
 let app=createGameServer(config),context,oldPage,old,base,port;const observations={};const started=Date.now();
 const restart=async enabled=>{await app.close();app=createGameServer({...config,dist:clients.current.directory,imagePhysicalSizeEnabled:enabled});await app.listen(port);return app;};
 try{
  ({port}=await app.listen(0));base=`http://127.0.0.1:${port}`;
  context=await browser.newContext({viewport:{width:1440,height:960},acceptDownloads:true});
  await ok(context,base,'/api/session','POST',{name:'Synthetic protocol owner'},false);
  oldPage=await context.newPage();old=await instrument(context,oldPage,base);
  await oldPage.goto(base+'/?room=room',{waitUntil:'domcontentloaded'});await oldPage.waitForFunction(()=>window.__universe?.getState().ready||document.querySelector('#join-error')?.textContent.includes('server is not ready'));assert(await oldPage.evaluate(()=>window.__universe?.getState().ready),'Application startup failed');
  assert.equal(await oldPage.evaluate(()=>__universe.getState().room.id),'room');
  await makeDirty(oldPage,'My preserved '+name+' draft');
  await run({context,oldPage,old,base,port,restart,getApp:()=>app,observations});
  assert.deepEqual(old.errors,[],'Old page must not throw on incompatible image schema');
  checks.push({name,status:'passed',durationMs:Date.now()-started,...observations});console.log('PASS',name);
 }catch(error){observations.failureState=await oldPage?.evaluate(()=>({state:window.__universe?.getState(),text:document.body.innerText})).catch(()=>null);observations.failureEvents=old?.events;observations.failureRequests=old?.requests;observations.failureConsole=old?.consoleErrors;checks.push({name,status:'failed',durationMs:Date.now()-started,error:error.stack,...observations});console.error('FAIL',name,error);process.exitCode=1;await oldPage?.screenshot({path:join(output,name+'-failure.png')}).catch(()=>{});}
 finally{await context?.close();await app.close();await persist();}
}
try{
 await scenario('restart-shared-cookie-sizing-and-rollback',async f=>{
  const before=f.old.events.length;await f.restart(true);
  const draft=await exportRetiredDraft(f.oldPage);assert.equal(draft.scene.objects[0].name,'My preserved restart-shared-cookie-sizing-and-rollback draft');assert.equal(draft.scene.objects.length,1);
  f.observations.retirement=assertLegacyRetirement(f.old.events,before);await writeFile(join(output,'old-draft-export.json'),JSON.stringify(draft,null,2));
  await f.oldPage.screenshot({path:join(output,'old-tab-retired-draft-export.png')});
  f.observations.oldFailures=await assertFenced(f.context,f.base,[['/api/session'],['/api/worlds'],['/api/rooms/room'],['/api/rooms/room/join','POST',{}],['/api/rooms/room/scene','PUT',{revision:0,scene:initial}],['/api/rooms/room/assets']]);
  const current=await f.context.newPage(),fresh=await instrument(f.context,current,f.base);f.observations.currentDiagnostics=fresh;await current.bringToFront();
  await current.goto(f.base+'/?room=room',{waitUntil:'domcontentloaded'});await current.waitForFunction(()=>window.__universe?.getState().ready);
  assert.equal((await ok(f.context,f.base,'/api/client-protocol')).imagePhysicalSize.required,true);
  assert.equal(await current.evaluate(()=>__universe.getState().user.id),await f.oldPage.evaluate(()=>__universe.getState().user.id),'Sibling tabs share one account/cookie');
  await current.locator('#dock-build').click();await current.getByRole('button',{name:'Custom images',exact:true}).click();
  const library=current.locator('#image-library');await library.getByRole('button',{name:'Add PNG',exact:true}).click();
  const chooser=current.waitForEvent('filechooser');await library.getByRole('button',{name:'Choose PNG',exact:true}).click();
  const png=makePng({width:256,height:256,pixel:()=>[245,35,225,255]});await(await chooser).setFiles({name:'Explicit physical size.png',mimeType:'image/png',buffer:png});
  await library.getByAltText('Local image preview').waitFor();const form=library.locator('.uil-draft').first();
  await form.getByRole('spinbutton',{name:'Width (metres)',exact:true}).fill('2');
  await form.getByRole('combobox',{name:'Representation and depth',exact:true}).selectOption('floor');
  await library.getByRole('button',{name:'Upload',exact:true}).click();await library.getByRole('button',{name:/^Place Explicit physical size/}).click();
  await library.waitFor({state:'hidden'});await current.waitForFunction(()=>__universe.getEditor().tool==='image');
  await current.waitForFunction(()=>{const value=__universe.getCamera().framing;return value.status==='manual'||!value.targetOffset||Math.hypot(value.offset.x-value.targetOffset.x,value.offset.y-value.targetOffset.y)<1;});
  const point=await current.evaluate(()=>__universe.getScreenPoint(3,0,0));assert(point?.visible);await current.mouse.move(point.x,point.y);
  await current.waitForFunction(()=>__universe.getEditor().preview?.valid);await current.mouse.click(point.x,point.y);
  await current.waitForFunction(()=>__universe.getState().scene.objects.some(object=>object.type==='image'));
  await current.getByRole('button',{name:'Save room',exact:true}).click();await current.waitForFunction(()=>!__universe.getEditor().dirty&&!__universe.getEditor().saving);
  const room=(await ok(f.context,f.base,'/api/rooms/room')).room,entry=Object.values(room.imageDefinitions)[0],placed=room.scene.objects.find(object=>object.type==='image');
  assert(placed);assert.equal(entry.version.widthMetres,2);assert.equal(entry.version.heightMetres,2);
  assert.equal(await f.oldPage.evaluate(()=>__universe.getState().room),null);assertLegacyRetirement(f.old.events,before);
  for(const req of fresh.requests.filter(req=>req.path!=='/api/events'&&!/\/assets\/[^/]+\/versions\/[^/]+\/image$/.test(req.path)&&!/\/files\/[^/]+$/.test(req.path)))assert.equal(req.capability,currentCapability,'Every current API call carries its complete capability declaration: '+req.path);
  assert(fresh.requests.some(req=>req.path==='/api/events'&&new URLSearchParams(req.query).get('capabilities')===currentCapability));
  assert(f.old.requests.every(req=>req.capability===null),'Updated sibling never blesses the old tab');
  f.observations.sizedVersion={widthMetres:entry.version.widthMetres,heightMetres:entry.version.heightMetres,versionId:entry.version.versionId,placementId:placed.id};
  await current.locator('#image-render-status').waitFor({state:'hidden'});await current.screenshot({path:join(output,'current-tab-sized-image.png')});assert.deepEqual(fresh.errors,[]);
  await current.reload({waitUntil:'domcontentloaded'});await current.waitForFunction(()=>window.__universe?.getState().ready);assert((await ok(f.context,f.base,'/api/rooms/room')).room.scene.objects.some(o=>o.id===placed.id));
  await f.restart(false);
  const protocol=(await ok(f.context,f.base,'/api/client-protocol')).imagePhysicalSize;assert.deepEqual(protocol,{enabled:false,required:true,capability});
  const retained=(await ok(f.context,f.base,'/api/rooms/room')).room;assert.deepEqual(retained.imageDefinitions,room.imageDefinitions);assert.deepEqual(retained.scene,room.scene);
  const disabled=await request(f.context,f.base,'/api/rooms/room/assets','POST',{operationId:'disabled-new-size',draft:{name:'Disabled new size',widthMetres:3,heightMetres:3,depthPreset:'floor'},mediaType:'image/png',pngBase64:png.toString('base64')});assert.equal(disabled.status,409);assert.equal(disabled.body.code??disabled.body.error?.code,'IMAGE_PHYSICAL_SIZE_DISABLED');
  f.observations.rollback={protocol,retainedDimensions:true,deniedSizedWrite:disabled.status};
  f.observations.rollbackOldFailures=await assertFenced(f.context,f.base,[['/api/rooms/room'],['/api/rooms/room/assets'],['/api/rooms/room/join','POST',{}]]);
  await current.waitForFunction(()=>window.__universe?.getState().ready);assert.deepEqual(fresh.errors,[]);
 });
 await scenario('held-old-save-receipt',async f=>{
  const held=deferred(),release=deferred();let closing=false;
  await f.oldPage.route(f.base+'/api/rooms/room/scene/operations',async route=>{
   if(route.request().method()!=='POST')return route.continue();
   try{const response=await route.fetch();assert.equal(response.status(),200);held.resolve(await response.json());await release.promise;await route.fulfill({response});}catch(error){held.reject(error);if(!closing)throw error;}
  });
  try{
   await f.oldPage.getByRole('button',{name:'Save room',exact:true}).click();const receipt=await bounded(held.promise,'old committed save response');
   assert.equal(receipt.room.scene.objects[0].name,'My preserved held-old-save-receipt draft');
   const before=f.old.events.length;f.getApp().setImagePhysicalSizeEnabledForTest(true);
   const draft=await exportRetiredDraft(f.oldPage);assert.equal(draft.scene.objects[0].name,'My preserved held-old-save-receipt draft');
   const response=f.oldPage.waitForResponse(response=>response.url()===f.base+'/api/rooms/room/scene/operations');release.resolve();await response;
   await f.oldPage.waitForFunction(()=>!__universe.getEditor().saving);assert.equal(await f.oldPage.evaluate(()=>__universe.getState().room),null);assert.equal(await f.oldPage.evaluate(()=>__universe.getState().ready),false);
   f.observations.retirement=assertLegacyRetirement(f.old.events,before);f.observations.savedRevision=receipt.room.revision;f.observations.draftExportPreserved=true;
   f.observations.oldFailures=await assertFenced(f.context,f.base,[['/api/rooms/room'],['/api/rooms/room/scene/operations','POST',{}]]);
  }finally{closing=true;release.resolve();}
 });
 await scenario('held-old-resume-preserves-draft',async f=>{
  const held=deferred(),release=deferred();let closing=false,hold=true,blockEvents=false;
  await f.oldPage.route(f.base+'/api/events',route=>blockEvents?route.abort('failed'):route.continue());
  await f.oldPage.route(f.base+'/api/rooms/room/join',async route=>{
   if(!hold||route.request().method()!=='POST')return route.continue();hold=false;
   try{const response=await route.fetch();assert.equal(response.status(),200);held.resolve(await response.json());await release.promise;await route.fulfill({response});}catch(error){held.reject(error);if(!closing)throw error;}
  });
  try{
   f.getApp().server.closeAllConnections();const receipt=await bounded(held.promise,'pre-gate old resume response');assert.equal(receipt.room.id,'room');
   const before=f.old.events.length;f.getApp().setImagePhysicalSizeEnabledForTest(true);
   await f.oldPage.waitForFunction(()=>!__universe.getState().ready&&__universe.getState().room===null);
   assertLegacyRetirement(f.old.events,before);blockEvents=true;
   const delivered=f.oldPage.waitForResponse(response=>response.url()===f.base+'/api/rooms/room/join');release.resolve();await(await delivered).finished();
   await f.oldPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const local=await f.oldPage.evaluate(()=>({ready:__universe.getState().ready,roomId:__universe.getState().room?.id??null,admissionId:__universe.getState().admissionId}));
   assert.deepEqual(local,{ready:false,roomId:null,admissionId:null},'Targeted denial must stop the old buffered same-room resume from re-adopting its stale response');
   const draft=await exportRetiredDraft(f.oldPage);assert.equal(draft.scene.objects[0].name,'My preserved held-old-resume-preserves-draft draft');
   f.observations.afterLateSuccess=local;f.observations.draftExportAfterLateSuccess=true;
   f.observations.oldFailures=await assertFenced(f.context,f.base,[['/api/rooms/room'],['/api/rooms/room/join','POST',{}],['/api/rooms/room/scene','PUT',{revision:receipt.room.revision,scene:receipt.room.scene}]]);
   const reopened=f.oldPage.waitForResponse(response=>response.url()===f.base+'/api/events');blockEvents=false;await(await bounded(reopened,'old reconnect retirement')).finished();
   assert.equal(await f.oldPage.evaluate(()=>__universe.getState().ready),false);assertLegacyRetirement(f.old.events,before);
   f.observations.reconnectRetiredAgain=true;f.observations.draftExportPreserved=true;
  }finally{closing=true;release.resolve();}
 });
 await scenario('held-current-resume-remains-retired',async f=>{
  const png=makePng({width:64,height:32,pixel:()=>[35,190,240,255]});
  await f.oldPage.getByRole('button',{name:'Custom images',exact:true}).click();const library=f.oldPage.locator('#image-library');
  await library.getByRole('button',{name:'Add PNG',exact:true}).click();const chooser=f.oldPage.waitForEvent('filechooser');await library.getByRole('button',{name:'Choose PNG',exact:true}).click();await(await chooser).setFiles({name:'Unsent recovery PNG.png',mimeType:'image/png',buffer:png});
  await library.getByAltText('Local image preview').waitFor();const form=library.locator('.uil-draft').first();await form.getByRole('spinbutton',{name:'Width (metres)',exact:true}).fill('3');await form.getByRole('combobox',{name:'Representation and depth',exact:true}).selectOption('floor');
  await library.getByRole('button',{name:'Close Custom image library',exact:true}).click();await library.waitFor({state:'hidden'});
  const held=deferred(),release=deferred(),omitted=deferred();let closing=false,hold=true,omitStreamCapability=false;
  await f.oldPage.route(f.base+'/api/events?capabilities='+encodeURIComponent(currentCapability),route=>{if(!omitStreamCapability)return route.continue();omitted.resolve(true);return route.continue({url:f.base+'/api/events'});});
  await f.oldPage.route(f.base+'/api/rooms/room/join',async route=>{
   if(!hold||route.request().method()!=='POST')return route.continue();hold=false;
   try{const response=await route.fetch();assert.equal(response.status(),200);held.resolve(await response.json());await release.promise;await route.fulfill({response});}catch(error){held.reject(error);if(!closing)throw error;}
  });
  try{
   f.getApp().server.closeAllConnections();const receipt=await bounded(held.promise,'current pre-retirement resume response');assert.equal(receipt.room.id,'room');
   await f.oldPage.locator('#dock-more').click();await f.oldPage.locator('#shell-more').waitFor({state:'visible'});
   const before=f.old.events.length;omitStreamCapability=true;f.getApp().server.closeAllConnections();
   await bounded(omitted.promise,'current EventSource capability omission');
   await f.oldPage.getByRole('heading',{name:'Reload to continue',exact:true}).waitFor();
   assert(await f.oldPage.locator('#shell-more').isHidden(),'Retirement dismisses More so recovery owns native keyboard focus');
   await f.oldPage.keyboard.press('Tab');assert(await f.oldPage.locator('#dialog').evaluate(node=>node.contains(document.activeElement)),'Native Tab remains in the foreground recovery dialog');
   const draft=await exportRetiredDraft(f.oldPage);assert.equal(draft.scene.objects[0].name,'My preserved held-current-resume-remains-retired draft');
   await f.oldPage.getByRole('button',{name:'Reload required',exact:true}).click();await f.oldPage.getByRole('button',{name:'Export image draft and receipts',exact:true}).waitFor({state:'visible',timeout:10000});const download=f.oldPage.waitForEvent('download');download.catch(()=>{});await f.oldPage.getByRole('button',{name:'Export image draft and receipts',exact:true}).click();const imageCopy=JSON.parse(await readFile(await(await download).path(),'utf8'));
   assert.equal(imageCopy.format,'universe-image-recovery');assert.equal(imageCopy.uploadDraft.file.name,'Unsent recovery PNG.png');assert.deepEqual(Buffer.from(imageCopy.uploadDraft.file.bytes.data,'base64'),png);assert.equal(imageCopy.uploadDraft.fields.widthInput,'3');assert.equal(imageCopy.uploadDraft.fields.heightInput,'1.5');assert.equal(imageCopy.uploadDraft.fields.depthPreset,'floor');assert.equal(imageCopy.pendingUpload,null);
   await writeFile(join(output,'current-unsent-image-export.json'),JSON.stringify(imageCopy,null,2));
   const delivered=f.oldPage.waitForResponse(response=>response.url()===f.base+'/api/rooms/room/join');release.resolve();await(await delivered).finished();
   await f.oldPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const state=await f.oldPage.evaluate(()=>({ready:__universe.getState().ready,room:__universe.getState().room,reload:__universe.getState().clientReloadRequired,admissionId:__universe.getState().admissionId}));
   assert.deepEqual(state,{ready:false,room:null,reload:true,admissionId:null});assertLegacyRetirement(f.old.events,before,{requireGlobal:false});
   assert.equal(await f.oldPage.getByRole('button',{name:'Reload required',exact:true}).count(),1);
   f.observations.afterLateSuccess=state;f.observations.draftExportPreserved=true;f.observations.imageExport={exactBytes:true,widthInput:imageCopy.uploadDraft.fields.widthInput,heightInput:imageCopy.uploadDraft.fields.heightInput,unsent:true};assert.equal(f.old.requests.filter(request=>request.method==='POST'&&request.path==='/api/rooms/room/assets').length,0,'No upload or automatic retry is sent');f.observations.transportFault='Only the reconnect EventSource declaration is omitted; retirement JSON comes from the real backend';
   await f.oldPage.setViewportSize({width:320,height:700});
   const reloadRequired=f.oldPage.getByRole('button',{name:'Reload required',exact:true});
   await reloadRequired.waitFor({state:'visible'});
   const recoveryControl=await reloadRequired.evaluate(button=>{
    const rect=button.getBoundingClientRect(),connection=document.querySelector('#connection'),style=getComputedStyle(connection),inset=Math.min(8,rect.width/4,rect.height/4);
    const points=[['center',rect.x+rect.width/2,rect.y+rect.height/2],['top-left',rect.x+inset,rect.y+inset],['top-right',rect.right-inset,rect.y+inset],['bottom-left',rect.x+inset,rect.bottom-inset],['bottom-right',rect.right-inset,rect.bottom-inset]];
    return{viewport:{width:innerWidth,height:innerHeight},button:rect.toJSON(),connection:{rect:connection.getBoundingClientRect().toJSON(),width:style.width,maxWidth:style.maxWidth,overflow:style.overflow},hitPoints:points.map(([name,x,y])=>{const hit=document.elementFromPoint(x,y);return{name,x,y,buttonHit:hit===button||button.contains(hit),hit:hit?{tag:hit.tagName,id:hit.id,className:hit.className,text:hit.textContent?.slice(0,100)}:null};})};
   });
   f.observations.mobileRecoveryControl=recoveryControl;
   await writeFile(join(output,'current-mobile-recovery-control.json'),JSON.stringify(recoveryControl,null,2));
   await f.oldPage.screenshot({path:join(output,'current-mobile-recovery-control.png')});
   assert(recoveryControl.button.x>=0&&recoveryControl.button.y>=0&&recoveryControl.button.right<=recoveryControl.viewport.width&&recoveryControl.button.bottom<=recoveryControl.viewport.height,'The persistent Reload required button must fit entirely inside a 320×700 viewport: '+JSON.stringify(recoveryControl));
   assert(recoveryControl.button.height>=44,'The persistent Reload required button must provide at least 44px usable height: '+JSON.stringify(recoveryControl));
   assert(recoveryControl.hitPoints.every(point=>point.buttonHit),'The persistent Reload required button center and inset corners must be unobstructed: '+JSON.stringify(recoveryControl));
   await reloadRequired.click();await f.oldPage.screenshot({path:join(output,'current-tab-permanent-retirement.png')});
   omitStreamCapability=false;const navigation=f.oldPage.waitForNavigation({waitUntil:'domcontentloaded'});f.oldPage.once('dialog',dialog=>dialog.accept());await f.oldPage.getByRole('button',{name:'Reload Universe',exact:true}).click();await navigation;await f.oldPage.waitForFunction(()=>window.__universe?.getState().ready);
   assert.equal(f.old.requests.filter(request=>request.method==='POST'&&request.path==='/api/rooms/room/assets').length,0,'Explicit reload does not resubmit an unsent PNG');assert.equal((await ok(f.context,f.base,'/api/rooms/room/assets')).entries.length,0);assert.equal(await f.oldPage.evaluate(()=>__universe.getState().scene.objects[0].name),'Original chair');f.observations.explicitReload={ready:true,automaticImageUploads:0,serverAssets:0};
  }finally{closing=true;release.resolve();}
 },{modern:true});
}finally{await browser.close();await persist();}
