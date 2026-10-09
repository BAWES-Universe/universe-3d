/**
 * GPU-free native-browser component checks for the player resident-chat surface.
 * The API below is a fixture-only in-memory component adapter, not a server or
 * model/provider integration. Real authenticated HTTP behavior is tested by
 * public-resident-chat.test.mjs with its separate loopback mock adapter.
 * Run: node tests/resident-chat.browser.mjs
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import embedded from '@sparticuz/chromium';

const source = `
import {mountResidentChat} from './src/resident-chat.js';
window.state={ready:true,room:{id:'commons'},user:{id:'guest-fixture',name:'Guest fixture'},botPermissions:{canManage:false}};
window.fixture={
 calls:[],pending:[],changes:[],managed:[],approached:[],keys:[],
 availability:{available:true},availabilityError:null,holdGets:false,holdPosts:false,
 reply:{name:'Moss',text:'Fixture-only resident reply'},
 bot:{id:'moss',name:'Moss'},
};
const api=async(path,options={})=>{
 const call={path,method:options.method||'GET',body:options.body?structuredClone(options.body):null};
 fixture.calls.push(call);
 if((call.method==='GET'&&fixture.holdGets)||(call.method==='POST'&&fixture.holdPosts)){
  return new Promise((resolve,reject)=>fixture.pending.push({call,resolve,reject}));
 }
 if(call.method==='GET'){
  if(fixture.availabilityError)throw Object.assign(new Error(fixture.availabilityError.message),fixture.availabilityError);
  return structuredClone(fixture.availability);
 }
 return structuredClone(fixture.reply);
};
window.panel=mountResidentChat({
 root:document.querySelector('#resident-chat'),api,getState:()=>state,
 onOpenChange:open=>fixture.changes.push(open),
 onManage:id=>fixture.managed.push(id),
 onApproach:bot=>fixture.approached.push(structuredClone(bot)),
});
document.querySelector('#open-chat').onclick=()=>{window.openTask=panel.open(fixture.bot);};
fixture.release=async(index,value,error=false)=>{
 const [next]=fixture.pending.splice(index,1);
 if(!next)throw Error('No held fixture request at index '+index);
 if(error)next.reject(Object.assign(new Error(value.message),value));else next.resolve(value);
 await new Promise(resolve=>setTimeout(resolve,0));
};
document.addEventListener('keydown',event=>fixture.keys.push('down:'+event.key));
document.addEventListener('keyup',event=>fixture.keys.push('up:'+event.key));
window.ready=true;
`;
const bundle = await build({
 stdin:{contents:source,resolveDir:fileURLToPath(new URL('..',import.meta.url)),sourcefile:'resident-chat-fixture.js'},
 bundle:true,format:'esm',write:false,outfile:'/tmp/resident-chat-component-fixture.js',
});
const javascript=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;
const stylesheet=bundle.outputFiles.find(file=>file.path.endsWith('.css')).text;
const html='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><button id="open-chat">Talk to Moss</button><button id="outside">Outside control</button><div id="resident-chat" hidden></div><script type="module" src="/fixture.js"></script></body></html>';
const server=createServer((request,response)=>{
 const files={'/':{type:'text/html',body:html},'/fixture.js':{type:'text/javascript',body:javascript},'/fixture.css':{type:'text/css',body:stylesheet}};
 const resource=files[request.url];
 response.writeHead(resource?200:404,{'Content-Type':resource?.type||'text/plain','Cache-Control':'no-store'});
 response.end(resource?.body||'Fixture resource not found');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const checks=[],errors=[],externalRequests=[];
let browser,page;
const check=async(name,run)=>{
 try{await reset();await run();checks.push({name,status:'passed'});console.log('PASS '+name);}
 catch(error){checks.push({name,status:'failed',error:error.stack});console.error('FAIL '+name+'\n'+error.stack);process.exitCode=1;}
};
const reset=async()=>{
 await page.goto(base);await page.waitForFunction(()=>window.ready);
};
const open=async()=>{
 await page.getByRole('button',{name:'Talk to Moss',exact:true}).click();
 await page.evaluate(()=>window.openTask);
};
const field=()=>page.getByLabel('Message this resident',{exact:true});
const send=()=>page.getByRole('button',{name:'Send',exact:true});
const close=()=>page.getByRole('button',{name:'Close resident chat',exact:true});
const posts=()=>page.evaluate(()=>fixture.calls.filter(call=>call.method==='POST'));
const isFocused=locator=>locator.evaluate(node=>node===document.activeElement);
try{
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||await embedded.executablePath(),headless:true,args:['--no-sandbox','--no-zygote','--disable-gpu']});
 page=await browser.newPage({viewport:{width:1000,height:800}});
 page.setDefaultTimeout(5000);
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>{
  if(route.request().url().startsWith(base+'/'))return route.continue();
  externalRequests.push(route.request().url());return route.abort();
 });
 await check('Unavailable provider displays the server reason and cannot submit; guests have no management affordance',async()=>{
  await page.evaluate(()=>fixture.availability={available:false,reason:'No resident provider is configured.'});
  await open();
  assert.equal(await page.getByRole('dialog',{name:'Moss',exact:true}).isVisible(),true);
  assert.match(await page.getByRole('status').textContent(),/No resident provider is configured/);
  assert.equal(await field().isDisabled(),true);assert.equal(await send().isDisabled(),true);
  assert.equal(await isFocused(close()),true);
  assert.equal(await page.getByRole('button',{name:'Manage resident',exact:true}).count(),0);
  assert.equal(await page.locator('.resident-chat-manage').isHidden(),true);
  assert.equal(await page.getByRole('button',{name:'Walk to resident',exact:true}).count(),0);
  assert.equal((await posts()).length,0);
  assert.deepEqual(await page.evaluate(()=>fixture.calls.map(({path,method})=>({path,method}))),[{path:'/api/rooms/commons/bots/moss/chat',method:'GET'}]);
 });
 await check('Out-of-range availability offers one native Walk action and no message dispatch',async()=>{
  await page.evaluate(()=>fixture.availabilityError={message:'Walk closer to this resident to chat.',status:409,data:{code:'BOT_OUT_OF_RANGE'}});
  await open();assert.equal(await field().isDisabled(),true);assert.equal(await send().isDisabled(),true);
  assert.match(await page.getByRole('status').textContent(),/Walk closer/);
  await page.getByRole('button',{name:'Walk to resident',exact:true}).click();
  assert.equal(await page.evaluate(()=>panel.isOpen()),false);
  assert.deepEqual(await page.evaluate(()=>fixture.approached),[{id:'moss',name:'Moss'}]);
  assert.equal((await posts()).length,0);
 });
 await check('Native Send uses the fixture-only API and renders provider and player HTML as literal text',async()=>{
  const playerText='<img src=x onerror="window.playerExecuted=true"> Hello resident';
  const providerText='<img src=x onerror="window.providerExecuted=true"><script>window.providerExecuted=true</script> Fixture-only reply';
  await page.evaluate(text=>{fixture.reply={name:'<svg onload="window.nameExecuted=true">Moss</svg>',text};},providerText);
  await open();assert.equal(await isFocused(field()),true);
  assert.match(await page.getByRole('status').textContent(),/Ready for text chat/);
  await field().fill(playerText);await send().click();
  await page.waitForFunction(()=>document.querySelector('.resident-chat-status').textContent==='Text reply received.');
  const calls=await posts();assert.equal(calls.length,1);
  assert.equal(calls[0].path,'/api/rooms/commons/bots/moss/chat');assert.equal(calls[0].body.message,playerText);
  assert.match(calls[0].body.requestId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  const lines=await page.getByRole('log').locator('p').allTextContents();
  assert.deepEqual(lines,['Guest fixture: '+playerText,'<svg onload="window.nameExecuted=true">Moss</svg>: '+providerText]);
  assert.equal(await page.getByRole('log').locator('img,script,svg').count(),0);
  assert.equal(await page.evaluate(()=>Boolean(window.playerExecuted||window.providerExecuted||window.nameExecuted)),false);
  assert.equal(await field().inputValue(),'');assert.equal(await isFocused(field()),true);
  assert.equal(await page.getByRole('button',{name:'Manage resident',exact:true}).count(),0);
 });
 await check('Native keyboard submission sends once; blank text and textarea Enter do not send',async()=>{
  await open();await field().fill('   ');await send().click();assert.equal((await posts()).length,0);
  await field().fill('Native keyboard message');await field().press('Enter');assert.equal((await posts()).length,0);
  await send().focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('.resident-chat-status').textContent==='Text reply received.');
  assert.equal((await posts()).length,1);assert.equal((await posts())[0].body.message,'Native keyboard message\n');
 });
 await check('Repeated native clicks while busy dispatch exactly one fixture request and re-enable after its reply',async()=>{
  await page.evaluate(()=>fixture.holdPosts=true);await open();await field().fill('One busy request');await send().dblclick();
  await page.waitForFunction(()=>fixture.pending.length===1);
  assert.equal(await field().isDisabled(),true);assert.equal(await send().isDisabled(),true);
  assert.match(await page.getByRole('status').textContent(),/Waiting for a reply/);
  const bounds=await send().boundingBox();await page.mouse.click(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.click(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
  assert.equal((await posts()).length,1);
  await page.evaluate(()=>fixture.release(0,{name:'Moss',text:'One fixture-only reply'}));
  assert.equal(await page.getByRole('log').locator('p').count(),2);assert.equal(await field().isEnabled(),true);assert.equal(await send().isEnabled(),true);
 });
 await check('A pending native keyboard submission retains modal focus, keyboard isolation and Escape dismissal',async()=>{
  await page.evaluate(()=>fixture.holdPosts=true);await open();await field().fill('Keep keyboard focus while waiting');
  await send().focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>fixture.pending.length===1);
  const retainedFocus=await page.evaluate(()=>document.querySelector('#resident-chat').contains(document.activeElement));
  await page.evaluate(()=>fixture.keys=[]);await page.keyboard.press('w');await page.keyboard.press('Tab');
  const focusedClose=await isFocused(close()),leakedKeys=await page.evaluate(()=>fixture.keys);
  await page.keyboard.press('Escape');const dismissed=await page.evaluate(()=>!panel.isOpen());
  assert.deepEqual({retainedFocus,focusedClose,leakedKeys,dismissed},{retainedFocus:true,focusedClose:true,leakedKeys:[],dismissed:true},'Busy controls must retain modal keyboard handling');
  await page.evaluate(()=>fixture.release(0,{name:'Moss',text:'Dismissed busy reply'}));
  assert.equal(await page.locator('.resident-chat-log').textContent(),'');
 });
 await check('A rejected fixture message preserves the draft, reports failure and does not fabricate a reply or retry',async()=>{
  await page.evaluate(()=>fixture.holdPosts=true);await open();await field().fill('Keep this failed message');await send().click();
  await page.waitForFunction(()=>fixture.pending.length===1);
  await page.evaluate(()=>fixture.release(0,{message:'Fixture-only provider unavailable',status:503},true));
  assert.match(await page.getByRole('status').textContent(),/Fixture-only provider unavailable/);
  assert.equal(await field().inputValue(),'Keep this failed message');assert.equal(await field().isEnabled(),true);
  assert.equal(await isFocused(field()),true);assert.equal(await page.getByRole('log').textContent(),'');assert.equal((await posts()).length,1);
 });
 await check('Close and reopen discard a late old reply without unlocking the new in-flight request',async()=>{
  await page.evaluate(()=>fixture.holdPosts=true);await open();await field().fill('Old conversation');await send().click();
  await page.waitForFunction(()=>fixture.pending.length===1);await close().click();
  assert.equal(await page.evaluate(()=>panel.isOpen()),false);assert.equal(await page.locator('.resident-chat-log').textContent(),'');
  await open();await field().fill('New conversation');await send().click();await page.waitForFunction(()=>fixture.pending.length===2);
  await page.evaluate(()=>fixture.release(0,{name:'Moss',text:'STALE OLD REPLY'}));
  assert.equal(await page.getByRole('log').textContent(),'');assert.equal(await field().isDisabled(),true);assert.equal(await send().isDisabled(),true);
  assert.equal(await field().inputValue(),'New conversation');assert.match(await page.getByRole('status').textContent(),/Waiting for a reply/);
  await page.evaluate(()=>fixture.release(0,{name:'Moss',text:'Current fixture reply'}));
  assert.match(await page.getByRole('log').textContent(),/New conversation.*Current fixture reply/);
  assert.doesNotMatch(await page.getByRole('log').textContent(),/Old conversation|STALE/);assert.equal(await field().isEnabled(),true);
 });
 await check('Late availability after Close cannot reopen or overwrite a new resident dialog',async()=>{
  await page.evaluate(()=>fixture.holdGets=true);
  await page.getByRole('button',{name:'Talk to Moss',exact:true}).click();await page.waitForFunction(()=>fixture.pending.length===1);
  await close().click();await page.evaluate(()=>{fixture.holdGets=false;fixture.bot={id:'rose',name:'Rose'};});await open();
  await page.evaluate(()=>fixture.release(0,{available:false,reason:'STALE AVAILABILITY'}));
  assert.equal(await page.getByRole('dialog',{name:'Rose',exact:true}).isVisible(),true);
  assert.match(await page.getByRole('status').textContent(),/Ready for text chat/);assert.equal(await field().isEnabled(),true);
 });
 await check('Room changes close the panel, clear text and ignore the old room reply',async()=>{
  await page.evaluate(()=>fixture.holdPosts=true);await open();await field().fill('Private to old room');await send().click();
  await page.waitForFunction(()=>fixture.pending.length===1);
  await page.evaluate(()=>{state.room={id:'garden'};panel.update();});
  assert.equal(await page.evaluate(()=>panel.isOpen()),false);assert.equal(await page.locator('textarea').inputValue(),'');
  await page.evaluate(()=>fixture.release(0,{name:'Moss',text:'OLD ROOM REPLY'}));
  assert.equal(await page.locator('.resident-chat-log').textContent(),'');assert.equal(await page.evaluate(()=>panel.isOpen()),false);
  await open();await field().fill('In garden now');await send().click();
  assert.equal((await posts()).at(-1).path,'/api/rooms/garden/bots/moss/chat');
 });
 await check('Connection or room loss closes the panel and rejects late availability',async()=>{
  for(const loss of ['connection','room']){
   await reset();await page.evaluate(()=>fixture.holdGets=true);
   await page.getByRole('button',{name:'Talk to Moss',exact:true}).click();await page.waitForFunction(()=>fixture.pending.length===1);
   await page.evaluate(loss=>{if(loss==='connection')state.ready=false;else state.room=null;panel.update();},loss);
   assert.equal(await page.evaluate(()=>panel.isOpen()),false);
   await page.evaluate(()=>fixture.release(0,{available:true}));
   assert.equal(await page.evaluate(()=>panel.isOpen()),false);assert.equal(await page.locator('.resident-chat-log').textContent(),'');
  }
 });
 await check('Tab stays in the dialog and chat typing cannot trigger document movement shortcuts',async()=>{
  await open();await page.evaluate(()=>fixture.keys=[]);await field().press('w');await field().press('ArrowLeft');
  assert.deepEqual(await page.evaluate(()=>fixture.keys),[]);
  await close().focus();await page.keyboard.press('Shift+Tab');assert.equal(await isFocused(send()),true);
  await page.keyboard.press('Tab');assert.equal(await isFocused(close()),true);
  await page.keyboard.press('Tab');assert.equal(await isFocused(field()),true);
  await page.keyboard.press('Tab');assert.equal(await isFocused(send()),true);
 });
 await check('Close and Escape dismiss and restore focus to the native opener',async()=>{
  await open();await field().fill('Dismiss this draft');await close().click();
  assert.equal(await page.evaluate(()=>panel.isOpen()),false);
  assert.equal(await page.locator('textarea').inputValue(),'');
  assert.equal(await isFocused(page.getByRole('button',{name:'Talk to Moss',exact:true})),true,'Close should restore focus to the element that opened the modal');
  await open();await field().fill('Escape this draft');await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(()=>panel.isOpen()),false);assert.equal(await page.locator('textarea').inputValue(),'');
  assert.equal(await isFocused(page.getByRole('button',{name:'Talk to Moss',exact:true})),true,'Escape should restore focus to the opener');
  assert.deepEqual(await page.evaluate(()=>fixture.changes),[true,false,true,false]);
 });
 await check('Manager-only action is reachable only with the supplied management capability',async()=>{
  await page.evaluate(()=>state.botPermissions.canManage=true);await open();
  await page.getByRole('button',{name:'Manage resident',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>fixture.managed),['moss']);assert.equal(await page.evaluate(()=>panel.isOpen()),false);
  await page.evaluate(()=>state.botPermissions.canManage=false);await open();
  assert.equal(await page.getByRole('button',{name:'Manage resident',exact:true}).count(),0);
  assert.equal((await posts()).length,0);
 });
 assert.deepEqual(errors,[],'The component should not emit browser errors');
 assert.deepEqual(externalRequests,[],'The fixture must not contact external services');
} catch(error){checks.push({name:'Browser fixture',status:'failed',error:error.stack});console.error(error);process.exitCode=1;}
finally{
 console.log(JSON.stringify({scope:'GPU-free native-browser component test with fixture-only API responses',checks,errors,externalRequests,limits:['No renderer, WebGL or production account used','Mocked component API is not evidence of server authorization, real model output or provider availability','No external paid calls; HTTP requests are restricted to this loopback fixture']},null,2));
 await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
