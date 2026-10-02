/** Real authenticated multi-browser expression client and server acceptance. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGameServer} from '../server/app.mjs';
import {launch} from '../scripts/browser.mjs';
const dir=await mkdtemp(join(tmpdir(),'universe-expressions-'));
const html='<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/express.css"><style>html,body{margin:0;width:100%;height:100%;background:#201727;color:white;font:14px Arial}#game,#root{position:absolute;inset:0;width:100%;height:100%}#game{background:transparent;border:0}#open{position:absolute;left:20px;top:20px;z-index:30;padding:15px}[hidden]{display:none!important}</style></head><body><canvas id="game" tabindex="0"></canvas><button id="open">Express</button><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';
await writeFile(join(dir,'index.html'),html);
await writeFile(join(dir,'fixture.js'),`import{mountExpress}from'/express.js';
window.api=async(path,{method='GET',body}={})=>{const response=await fetch(path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.message||data.error),{status:response.status,data});return data};
const session=await window.api('/api/session',{method:'POST',body:{name:new URL(location.href).searchParams.get('name')||'Guest',woka:0}});window.state={...session,ready:false,people:[],position:{x:0,z:0},moving:false};window.toasts=[];window.offset=0;
window.express=mountExpress({root:document.querySelector('#root'),api:window.api,getState:()=>window.state,now:()=>Date.now()+window.offset,project:p=>({x:450+p.x*20,y:340+p.z*10,visible:true}),onReturnFocus:()=>document.querySelector('#game').focus(),toast:message=>window.toasts.push(message)});
window.joinRoom=async id=>{window.state.ready=false;window.express.update();const result=await window.api('/api/rooms/'+id+'/join',{method:'POST',body:{}});Object.assign(window.state,{room:result.room,scene:result.room.scene,people:result.presence,position:result.room.scene.spawn,ready:true});window.express.update()};await window.joinRoom(new URL(location.href).searchParams.get('room')||'r1');
window.events=new EventSource('/api/events');for(const type of ['hello','presence','expression','expression-clear','moderation','access-revoked'])window.events.addEventListener(type,event=>{const data=JSON.parse(event.data);if(type==='presence'&&data.roomId===window.state.room.id)window.state.people=data.presence;if(type==='moderation'&&data.userId===window.state.user.id&&['kick','ban'].includes(data.action))window.state.ready=false;window.express.onEvent({type,data})});
window.addEventListener('keydown',e=>window.express.handleKey(e),true);window.addEventListener('keyup',e=>window.express.handleKey(e),true);document.querySelector('#open').onclick=()=>window.express.open();setInterval(()=>window.express.update(),30);window.ready=true;`);
for(const file of ['express.js','express.css'])await writeFile(join(dir,file),await readFile(new URL('../src/'+file,import.meta.url)));
const scene={version:1,theme:'garden',bounds:{width:32,depth:26},spawn:{x:0,z:0},objects:[],areas:[{id:'quiet',name:'Quiet corner',x:10,z:0,width:3,depth:3,action:'silent'}]};
const app=createGameServer({database:':memory:',seeds:[{id:'w1',name:'Expression world',rooms:[{id:'r1',name:'Together',scene},{id:'r2',name:'Elsewhere',scene}]}],dist:dir});
const address=await app.listen(0),base=`http://127.0.0.1:${address.port}`,browser=await launch();const errors=[],checks=[];const check=async(name,fn)=>{await fn();checks.push({name,status:'passed'});console.log('PASS',name)};
const call=(page,path,method='GET',body)=>page.evaluate(async({path,method,body})=>window.api(path,{method,body}),{path,method,body});
let alice,bob,charlie,aliceContext,bobContext,charlieContext;
async function say(page,text,kind='say'){await page.evaluate(kind=>window.express.open(kind),kind);await page.getByRole('textbox',{name:'Your expression',exact:true}).fill(text);await page.getByRole('button',{name:'Send expression',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.express-tray').hidden)}
try{
 aliceContext=await browser.newContext();bobContext=await browser.newContext();charlieContext=await browser.newContext();alice=await aliceContext.newPage();bob=await bobContext.newPage();charlie=await charlieContext.newPage();for(const p of[alice,bob,charlie])p.on('pageerror',error=>errors.push(error.message));
 await alice.goto(base+'/?name=Mira');await alice.waitForFunction(()=>window.ready);await bob.goto(base+'/?name=Ari');await bob.waitForFunction(()=>window.ready);await charlie.goto(base+'/?name=Elsewhere&room=r2');await charlie.waitForFunction(()=>window.ready);await alice.waitForFunction(()=>window.state.people.length===2);
 const aliceId=await alice.evaluate(()=>window.state.user.id),bobId=await bob.evaluate(()=>window.state.user.id);
 await check('authenticated Say reaches both real avatars but never another room or chat history',async()=>{
  await say(alice,'Hello from this real room');await bob.getByText('Hello from this real room',{exact:true}).waitFor();assert.equal(await bob.locator('.express-bubble').getAttribute('data-user-id'),aliceId);await charlie.waitForTimeout(80);assert.equal(await charlie.locator('.express-bubble').count(),0);assert.equal((await call(alice,'/api/rooms/r1/messages')).messages.length,0);
 });
 await check('four real Say sends retain exactly newest three lines with independent expiration',async()=>{
  for(const text of['Second','Third','Fourth'])await say(alice,text);await bob.getByText('Fourth',{exact:true}).waitFor();assert.deepEqual(await bob.locator('.express-bubble-say .express-bubble-text').allTextContents(),['Second','Third','Fourth']);await bob.evaluate(()=>{window.offset+=6000;window.express.update()});assert.equal(await bob.locator('.express-bubble-say').count(),0);await bob.evaluate(()=>window.offset=0);
 });
 await check('Think is network-visible, survives late room join snapshot, then clears on real movement',async()=>{
  await say(alice,'Building a tiny world','think');await bob.getByText('Building a tiny world',{exact:true}).waitFor();await bob.evaluate(()=>window.joinRoom('r2'));assert.equal(await bob.locator('.express-bubble').count(),0);await bob.evaluate(()=>window.joinRoom('r1'));await bob.getByText('Building a tiny world',{exact:true}).waitFor();
  await call(alice,'/api/presence','POST',{roomId:'r1',x:1,z:0,moving:true});await alice.evaluate(()=>{window.state.position={x:1,z:0};window.state.moving=true});await bob.waitForFunction(()=>!document.querySelector('.express-bubble-think'));assert.equal((await call(bob,'/api/rooms/r1/expressions')).thoughts.length,0);await call(alice,'/api/presence','POST',{roomId:'r1',x:1,z:0,moving:false});await alice.evaluate(()=>window.state.moving=false);
 });
 await check('authority rejects forged actor/other-room sends and validates text length',async()=>{
  const result=await call(alice,'/api/rooms/r1/expression','POST',{kind:'say',text:'Identity belongs to session',userId:bobId});assert.equal(result.expression.userId||result.expression.author.id,aliceId);
  const forbidden=await charlie.evaluate(async()=>{try{await window.api('/api/rooms/r1/expression',{method:'POST',body:{kind:'say',text:'Leak'}});return 200}catch(error){return error.status}});assert.equal(forbidden,403);
  const invalid=await alice.evaluate(async()=>{try{await window.api('/api/rooms/r1/expression',{method:'POST',body:{kind:'say',text:'x'.repeat(101)}});return 200}catch(error){return error.status}});assert.equal(invalid,400);
 });
 await check('server mute blocks expression and client keeps actionable unsent draft',async()=>{
  await call(alice,'/api/rooms/r1/moderate','POST',{userId:bobId,action:'mute'});await bob.evaluate(()=>window.express.open());await bob.getByRole('textbox',{name:'Your expression',exact:true}).fill('Waiting until unmuted');await bob.getByRole('button',{name:'Send expression',exact:true}).click();await bob.getByRole('alert').waitFor();assert.equal(await bob.getByRole('textbox',{name:'Your expression',exact:true}).inputValue(),'Waiting until unmuted');await call(alice,'/api/rooms/r1/moderate','POST',{userId:bobId,action:'unmute'});await bob.getByRole('button',{name:'Send expression',exact:true}).click();await bob.waitForFunction(()=>document.querySelector('.express-tray').hidden);
 });
 await check('quiet area enforces Think on server even when caller submits Say',async()=>{
  await call(alice,'/api/presence','POST',{roomId:'r1',x:10,z:0,moving:false});await alice.evaluate(()=>window.state.position={x:10,z:0});const result=await call(alice,'/api/rooms/r1/expression','POST',{kind:'say',text:'A visible quiet thought'});assert.equal(result.expression.kind,'think');await bob.getByText('A visible quiet thought',{exact:true}).waitFor();assert.equal(await bob.locator('.express-bubble-think').count(),1);
 });
 await check('real emote response produces attributed animated reaction for connected peer',async()=>{
  await bob.evaluate(()=>window.express.playSlot(0));await alice.locator(`.express-bubble-emote[data-user-id="${bobId}"]`).waitFor();assert.equal(await alice.locator(`.express-bubble-emote[data-user-id="${bobId}"] .express-bubble-text`).textContent(),'👍');
 });
 await check('kick ends access, clears expressions, and rejects later sends',async()=>{
  await call(alice,'/api/rooms/r1/moderate','POST',{userId:bobId,action:'kick'});await bob.waitForFunction(()=>window.state.ready===false);assert.equal(await bob.locator('.express-bubble').count(),0);const result=await bob.evaluate(async()=>{try{await window.api('/api/rooms/r1/expression',{method:'POST',body:{kind:'say',text:'After removal'}});return 200}catch(error){return error.status}});assert.equal(result,403);
 });
 assert.deepEqual(errors,[]);await writeFile('evidence/express-live-results.json',JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({passed:checks.length,errors}));
}finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
