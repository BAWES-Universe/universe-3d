/** Native game UI, isolated public-mode guest sessions, real HTTP/SSE. */
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../server/store.mjs';
import {bootstrapOwner} from '../server/operator-accounts.mjs';
import {createGameServer} from '../server/app.mjs';
import {readRuntimeConfig} from '../server/runtime-config.mjs';
import {DEFAULT_PROXIMITY_CONFIG} from '../server/proximity-runtime-config.mjs';
import {seedWorlds} from '../src/worlds.js';
import {launch} from '../scripts/browser.mjs';
const out='evidence/guest-conversations';await mkdir(out,{recursive:true});
const folder=await mkdtemp(join(tmpdir(),'guest-conversations-')),database=join(folder,'synthetic.sqlite');
const seeds=structuredClone(seedWorlds);for(const w of seeds)for(const r of w.rooms){r.scene.areas=[];r.scene.spawn={x:0,z:0};r.scene.objects=r.scene.objects.filter(o=>Math.hypot(o.x,o.z)>5);}
const store=new Store(database,seeds);await bootstrapOwner(store,{name:'Synthetic owner',username:'synthetic_owner',password:'synthetic conversation password'});store.close();
const free=http.createServer();await new Promise(r=>free.listen(0,'127.0.0.1',r));const port=free.address().port;await new Promise(r=>free.close(r));const base=`http://127.0.0.1:${port}`;
const config=readRuntimeConfig({UNIVERSE_MODE:'public',UNIVERSE_BIND_ADDRESS:'127.0.0.1',PORT:String(port),UNIVERSE_DB:database,UNIVERSE_ALLOWED_HOSTS:`127.0.0.1:${port}`,UNIVERSE_ALLOWED_ORIGINS:`https://127.0.0.1:${port}`,UNIVERSE_TLS_MODE:'external',UNIVERSE_COOKIE_SECURE:'always',UNIVERSE_REGISTRATION_MODE:'open'});
// Loopback test-origin override only; real public guest authority remains active.
const app=createGameServer({database,seeds,dist:resolve('dist'),runtimeConfig:{...config,allowedOrigins:[base]},...DEFAULT_PROXIMITY_CONFIG});await app.listen(port);
console.log('Launching browser');const browser=await launch(),contexts=[],checks=[],errors=[];let alice,bob;
const pass=name=>{checks.push(name);console.log('PASS',name);};
async function enter(name,viewport={width:1280,height:900}){const context=await browser.newContext({viewport});contexts.push(context);await context.addInitScript(()=>{window.captureAttempts=0;if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=async()=>{window.captureAttempts++;throw new DOMException('Synthetic permission denial','NotAllowedError');};});const page=await context.newPage();page.setDefaultTimeout(90000);page.on('pageerror',e=>errors.push(e.message));console.log('Navigating guest');await page.goto(base,{waitUntil:'domcontentloaded'});console.log('Loaded guest shell');await page.waitForFunction(()=>window.__universe&&!document.querySelector('#join-button').disabled);await page.getByRole('button',{name:'Explore as guest'}).click();await page.waitForFunction(()=>window.__universe.getState().ready);assert.equal(await page.evaluate(()=>__universe.getState().user.ephemeralGuest),true);return page;}
try{
 console.log('Entering Alice');alice=await enter('Alice');console.log('Entering Bob');bob=await enter('Bob');await alice.bringToFront();await alice.locator('[data-control=chat]').waitFor();await alice.waitForFunction(()=>document.querySelector('[data-control=chat]').getAttribute('aria-disabled')==='false');
 assert.equal(await alice.evaluate(()=>captureAttempts),0);assert.equal(await bob.evaluate(()=>captureAttempts),0);pass('Two real public guests form a bubble with zero device prompts');
 await alice.screenshot({path:out+'/guest-bubble-controls.png'});
 await alice.locator('[data-control=chat]').click();const input=alice.getByRole('textbox',{name:'Message nearby people',exact:true});await input.waitFor();await input.fill('Hello from this guest bubble');await input.press('Enter');await alice.getByText('Hello from this guest bubble',{exact:true}).waitFor();
 await bob.bringToFront();await bob.locator('[data-control=chat]').click();await bob.getByText('Hello from this guest bubble',{exact:true}).waitFor();const reply=bob.getByRole('textbox',{name:'Message nearby people',exact:true});await reply.fill('I can chat without an account');await reply.press('Enter');await alice.getByText('I can chat without an account',{exact:true}).waitFor();pass('Native Bubble chat sends both ways through guest HTTP/SSE');await bob.screenshot({path:out+'/guest-bubble-chat.png'});
 console.log('Opening media');await bob.locator('#dock-chat').click();await bob.locator('[data-control=call]').click();console.log('Joining audio');await bob.getByRole('button',{name:'Join audio',exact:true}).click();console.log('Audio joined');assert.equal(await bob.evaluate(()=>captureAttempts),0);await bob.locator('[data-media=microphone]').click();await bob.waitForFunction(()=>document.querySelector('[data-media=microphone]')?.title.includes('Microphone was not allowed'));assert.equal(await bob.evaluate(()=>captureAttempts),1);await bob.locator('[data-media=camera]').click();await bob.waitForFunction(()=>document.querySelector('[data-media=camera]')?.title.includes('Camera was not allowed'));assert.equal(await bob.evaluate(()=>captureAttempts),2);pass('Joining audio does not capture; denied mic/camera stay off and expose recovery');await bob.screenshot({path:out+'/guest-media-permission-denied.png'});
 await bob.getByRole('button',{name:'Leave audio',exact:true}).click();await bob.getByRole('button',{name:'Join audio',exact:true}).waitFor();const before=await bob.evaluate(()=>__universe.getState().user.id);await bob.reload({waitUntil:'domcontentloaded'});await bob.waitForFunction(()=>window.__universe?.getState().ready);assert.equal(await bob.evaluate(()=>__universe.getState().user.id),before);assert.equal(await bob.evaluate(()=>captureAttempts),0);pass('Leave/reload retains guest identity without restoring device capture');
 // Same real shell at compact sizes; no desktop-only replacement UI.
 await bob.setViewportSize({width:320,height:568});await bob.screenshot({path:out+'/guest-bubble-mobile.png'});const bounds=await bob.locator('#proximity-controls').boundingBox();assert(bounds&&bounds.x>=0&&bounds.x+bounds.width<=321);pass('320px conversation controls stay in the viewport');
 assert.deepEqual(errors,[]);
}finally{if(bob)await bob.screenshot({path:out+'/last-browser-state.png'}).catch(()=>{});await writeFile(out+'/results.json',JSON.stringify({checks,errors,scope:'Synthetic public guests, actual source UI/HTTP/SSE. Device denial injected; no successful real audio/video packet claim.'},null,2));for(const context of contexts)await context.close();await browser.close();await app.close();await rm(folder,{recursive:true,force:true});}
