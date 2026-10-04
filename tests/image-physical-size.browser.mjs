import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createRequire} from 'node:module';
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(path.join(base, 'package.json'));
const {build} = require('esbuild'), {chromium} = require('playwright-core'), executable = (await import(require.resolve('@sparticuz/chromium'))).default;
const source = `
import {mountImageLibraryShell} from './src/image-library-shell.js';
import {normalizeImageAssetDraft} from './src/image-asset-schema.js';
const date='2026-10-02T00:00:00.000Z';
window.makeEntry=(sequence=1,revision=sequence,status='active')=>({schemaVersion:1,status,revision,metadata:{name:'Fern',description:'Library details',tags:['plant']},definition:{schemaVersion:1,assetId:'asset_a',roomId:'room_a',createdBy:'alice',createdAt:date,originKind:'upload'},version:{...normalizeImageAssetDraft({name:'Fern',floating:false,collisionGrid:[[1,0],[0,0]]},{width:64,height:64,byteLength:200,mediaType:'image/png'}),schemaVersion:1,assetId:'asset_a',roomId:'room_a',versionId:'version_'+sequence,sequence,sha256:'a'.repeat(64),createdBy:'alice',createdAt:date}});
window.sample=async()=>{const c=document.createElement('canvas');c.width=c.height=64;c.getContext('2d').fillRect(0,0,64,64);return new Uint8Array(await(await new Promise(r=>c.toBlob(r,'image/png'))).arrayBuffer())};
window.currentEntry=makeEntry();window.log={create:[],choose:[],reconcile:[],listReads:0,imageReads:0};window.mode='normal';window.receipts=new Map();
window.selected={assetId:'asset_a',versionId:'version_1'};
window.state={user:{id:'alice'},imagePhysicalSize:{enabled:true},ready:true,room:{id:'room_a',role:'owner',capabilities:{canRead:true,canEditScene:true,canBuild:true},imageDefinitions:{}},scene:{objects:[{id:'old',type:'image',assetRef:{assetId:'asset_a',versionId:'version_1'}}]}};
state.room.scene=state.scene;
const transport={list:async({roomId,status='active'})=>{log.listReads++;return{entries:roomId==='room_a'&&currentEntry.status===status?[structuredClone(currentEntry)]:[]}},readImage:async()=>{log.imageReads++;return{bytes:await sample(),mediaType:'image/png'}},create:async()=>currentEntry,reconcileCreate:async()=>({status:'not-found'}),
createVersion:async args=>{log.create.push({...structuredClone({...args,signal:undefined})});
 const commit=()=>{if(args.expectedRevision!==currentEntry.revision||args.expectedVersionId!==currentEntry.version.versionId)throw Object.assign(new Error('The image changed.'),{code:'IMAGE_REVISION_CONFLICT',status:409});const e=makeEntry(currentEntry.version.sequence+1,currentEntry.revision+1);e.version={...e.version,...args.setup,representation:args.setup.depthPreset==='floor'?'floor':'upright'};currentEntry=e;const result={status:'committed',entry:structuredClone(e),published:{assetId:'asset_a',versionId:e.version.versionId,sequence:e.version.sequence}};receipts.set(args.operationId,result.published);return result;};
 if(mode==='hold')return new Promise(resolve=>window.finishSave=()=>resolve(commit()));
 if(mode==='conflict')throw Object.assign(new Error('The image changed.'),{code:'IMAGE_REVISION_CONFLICT',status:409});
 if(mode==='lost'){commit();throw new Error('Response lost');}
 if(mode==='not-sent')throw new Error('Connection interrupted');
 if(receipts.has(args.operationId))return{status:'committed',entry:structuredClone(currentEntry),published:receipts.get(args.operationId)};
 return commit();},reconcileVersion:async args=>{log.reconcile.push(args);return receipts.has(args.operationId)?{status:'committed',entry:structuredClone(currentEntry),published:receipts.get(args.operationId)}:{status:'not-found'}}};
window.shell=mountImageLibraryShell({root:document.querySelector('#library'),getState:()=>state,getRenderer:()=>({setImageContext(){},setImageStateListener(){},getImageStates:()=>[]}),transport,onChoose:ref=>{selected=ref;log.choose.push(ref);return true},onOpenChange:open=>{if(open)history.pushState({surface:'images'},'',location.href);else if(history.state?.surface==='images')history.back();}});
shell.acceptRoom();document.querySelector('#open').onclick=()=>shell.setOpen(true,{trigger:document.querySelector('#open')});window.addEventListener('popstate',()=>shell.setOpen(history.state?.surface==='images',{record:false}));
`;
const bundle = await build({stdin: {contents: source, resolveDir: base}, bundle: true, format: 'iife', write: false});
const browser = await chromium.launch({executablePath: await executable.executablePath(), headless: true, args: ['--no-sandbox', '--no-zygote', '--disable-gpu']});
const page = await browser.newPage({viewport: {width: 900, height: 800}}), errors = [];
page.on('pageerror', error => errors.push(error.message));
const html = '<!doctype html><html><body><button id="open">Open images</button><canvas id="game" tabindex="0"></canvas><section id="library"></section></body></html>';
await page.route('**/*', route => new URL(route.request().url()).hostname === 'image-setup.test' ? route.fulfill({contentType: 'text/html', body: html}) : route.abort());
const setup = page.locator('.uil-setup'), save = setup.getByRole('button', {name: 'Save new version', exact: true});
async function openSetup() {
  if (await page.locator('#library').isHidden()) await page.getByRole('button', {name: 'Open images', exact: true}).click();
  if (await setup.isHidden()) await page.getByRole('button', {name: 'Edit setup for Fern', exact: true}).click();
  await setup.getByRole('heading', {name: 'Edit image setup'}).waitFor();
}
async function chooseDepth(value) { await setup.getByLabel('Representation and depth', {exact: true}).selectOption(value); }
const pass = name => console.log('PASS', name);
try {
 await page.goto('https://image-setup.test/');
 await page.addStyleTag({content:(await Promise.all(['public/universe-tokens.css','src/image-library-panel.css','src/image-library-shell.css'].map(file=>readFile(path.join(base,file),'utf8')))).join('\n')});
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 await openSetup();
 const w=setup.getByLabel('Width (metres)',{exact:true}),h=setup.getByLabel('Height (metres)',{exact:true}),lock=setup.getByLabel('Lock aspect ratio',{exact:true});
 assert.equal(await w.inputValue(),'2');assert.equal(await h.inputValue(),'2');assert(await lock.isChecked());assert(await save.isDisabled());
 await w.fill('4');assert.equal(await h.inputValue(),'4');assert(await save.isEnabled());
 await lock.uncheck();await h.fill('1');assert.equal(await w.inputValue(),'4');
 await page.getByRole('button',{name:'Close Custom image library'}).click();await openSetup();assert.equal(await h.inputValue(),'1');assert.equal(await lock.isChecked(),false);
 await lock.check();await w.fill('2');assert.equal(await h.inputValue(),'.5'.replace(/^\./,'0.'));
 await w.fill('0');await save.click();await setup.getByText(/must be a finite number/).waitFor();assert.equal(await page.evaluate(()=>log.create.length),0);
 await w.fill('4');assert.equal(await h.inputValue(),'1');
 await page.evaluate(()=>{mode='conflict';});await save.click();await setup.getByRole('button',{name:'Review latest version'}).waitFor();assert.equal(await w.inputValue(),'4');assert.equal(await h.inputValue(),'1');
 await page.evaluate(()=>{currentEntry=makeEntry(2,2);currentEntry.version={...currentEntry.version,widthMetres:6,heightMetres:3};mode='normal';});
 await setup.getByRole('button',{name:'Review latest version'}).click();assert.equal(await w.inputValue(),'4');assert.equal(await h.inputValue(),'1');
 await page.evaluate(()=>{mode='not-sent';});await save.click();assert(await w.isDisabled());assert(await h.isDisabled());assert(await lock.isDisabled());
 const pending=await page.evaluate(()=>log.create.at(-1));assert.equal(pending.setup.widthMetres,4);assert.equal(pending.setup.heightMetres,1);assert.equal(pending.expectedVersionId,'version_2');
 await page.evaluate(()=>{state.imagePhysicalSize.enabled=false;shell.syncAuthority()});
 await setup.getByRole('button',{name:'Check version save status'}).click();await setup.getByText(/Physical sizing is disabled, so retry is blocked/).waitFor();assert(await setup.getByRole('button',{name:'Retry same version save'}).isDisabled());assert.equal(await w.inputValue(),'4');assert.equal(await h.inputValue(),'1');const {signal: ignoredSignal,...pendingArgs}=pending;assert.deepEqual(await page.evaluate(()=>shell.getRecoverySnapshot().setupDrafts[0].pending.args),pendingArgs);
 const beforeRetry=await page.evaluate(()=>log.create.length);await setup.getByRole('button',{name:'Check version save status'}).click();assert.equal(await page.evaluate(()=>log.create.length),beforeRetry);
 await page.evaluate(()=>{mode='normal';state.imagePhysicalSize.enabled=true;shell.syncAuthority()});await setup.getByRole('button',{name:'Retry same version save'}).click();await setup.waitFor({state:'hidden'});
 const calls=await page.evaluate(()=>log.create);assert.deepEqual(calls.at(-1),pending);
 await openSetup();assert.equal(await w.inputValue(),'4');assert.equal(await h.inputValue(),'1');assert(await save.isDisabled());
 await w.fill('5');await page.evaluate(()=>{mode='lost'});await save.click();await setup.getByRole('button',{name:'Check version save status'}).waitFor();const committedCount=await page.evaluate(()=>log.create.length),committedOperation=await page.evaluate(()=>log.create.at(-1));
 await page.evaluate(()=>{state.imagePhysicalSize.enabled=false;shell.syncAuthority()});await setup.getByRole('button',{name:'Check version save status'}).click();await setup.waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>log.create.length),committedCount);assert.equal(await page.evaluate(()=>log.reconcile.at(-1).operationId),committedOperation.operationId);assert.equal(await page.evaluate(()=>currentEntry.version.widthMetres),5);
 pass('Disabled sizing preserves exact uncertain setup, blocks resend after not-found and resolves a committed receipt without mutation');
 assert.deepEqual(errors,[]);
 pass('Physical dimensions: aspect lock/unlock, reopen, invalid values, stale review preserving exact size, locked uncertain save and byte-identical retry payload');
} finally {await browser.close();}
