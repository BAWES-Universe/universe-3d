/** Run only with the shared GPU slot explicitly granted. Fresh loopback server,
 * actual app/creator UI, read-only diagnostics and a separate API fixture peer.
 * No synthetic app-state injection, fake success, live network or credentials.
 */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {launch} from '../scripts/browser.mjs';
import {seedWorlds} from '../src/worlds.js';
import {createGameServer} from '../server/app.mjs';
const runtime=resolve(process.env.CREATOR_RUNTIME||'dist'),out=resolve(process.env.CREATOR_EVIDENCE||'evidence/creator-actual-game');
await mkdir(out,{recursive:true});
const app=createGameServer({seeds:seedWorlds,dist:runtime}),{port}=await app.listen(0),base=`http://127.0.0.1:${port}`;
let ownerCookie='';
async function owner(path,method='GET',body){
 const response=await fetch(base+path,{method,headers:{Cookie:ownerCookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 if(response.headers.get('set-cookie'))ownerCookie=response.headers.get('set-cookie').split(';')[0];
 const data=await response.json();assert(response.ok,JSON.stringify({path,status:response.status,data}));return data;
}
const checks=[],errors=[],requests={presence:0,media:0};let browser,context,page;
const result={bundleSha256:createHash('sha256').update(await readFile(runtime+'/main.js')).digest('hex'),checks,errors,limits:['Software WebGL on a loopback fixture only; no phone, thermal, FPS or production-capacity claim','Media lifecycle/HTTP policy continues; no capture or transport-success claim','No DPR/default resolution modification']};
const report=async(name,details={})=>{checks.push({name,...details});console.log('PASS',name);await writeFile(out+'/results.json',JSON.stringify(result,null,2));};
const stats=()=>page.evaluate(()=>__universe.getStats()),state=()=>page.evaluate(()=>__universe.getState()),preview=()=>page.evaluate(()=>__universe.getCreatorPreview());
async function openCreator(){
 if(!await page.getByRole('button',{name:'Edit your 3D character',exact:true}).isVisible())await page.locator('#dock-settings').click();
 await page.getByRole('button',{name:'Edit your 3D character',exact:true}).click();
 await page.waitForFunction(()=>__universe.getStats().presentation.suspended&&__universe.getCreatorPreview().renderedFrames>0);
 assert(await page.locator('.avatar-preview-error').isHidden());
}
async function resumed(){await page.locator('#avatar-creator').waitFor({state:'hidden'});await page.waitForFunction(()=>{const p=__universe.getStats().presentation;return !p.suspended&&!p.resumePending&&!document.querySelector('#labels').hidden;});}
try{
 const ownerSession=await owner('/api/session','POST',{name:'Presentation fixture peer'});await owner('/api/rooms/commons/join','POST',{});
 browser=await launch();context=await browser.newContext({viewport:{width:1100,height:800},deviceScaleFactor:1});
 await context.route('**/*',route=>route.request().url().startsWith(base+'/')||route.request().url().startsWith('data:')?route.continue():route.abort());
 page=await context.newPage();page.setDefaultTimeout(45000);page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>{const url=new URL(request.url());if(url.pathname==='/api/presence')requests.presence++;if(url.pathname==='/api/media')requests.media++;});
 await page.goto(base,{waitUntil:'domcontentloaded'});await page.getByPlaceholder('Your name').fill('Presentation fixture player');await page.locator('#join-button').click();
 await page.waitForFunction(()=>window.__universe?.getState().ready&&__universe.getStats().presentation.drawnFrames>5);
 const initialState=await state(),initialStats=await stats();await page.screenshot({path:out+'/01-world-layers.png'});
 await openCreator();const opened=await stats(),previewStart=await preview(),initialRequests={...requests};
 await page.getByRole('tab',{name:'Hair',exact:true}).click();await page.getByRole('button',{name:'Hairstyle: High bun',exact:true}).click();
 await page.locator('.avatar-preview').focus();await page.keyboard.down('w');await page.waitForTimeout(200);await page.keyboard.up('w');
 await owner('/api/presence','POST',{roomId:'commons',x:-3,z:7,moving:false});
 await owner('/api/rooms/commons/messages','POST',{text:'Creator fixture: room chat is still live'});
 await page.waitForFunction(id=>__universe.getState().people.some(p=>p.id===id&&p.x===-3&&p.z===7),ownerSession.user.id);
 await page.waitForTimeout(2600);
 const paused=await stats(),activePreview=await preview();assert.equal(paused.presentation.drawnFrames,opened.presentation.drawnFrames);assert(paused.presentation.skippedFrames>opened.presentation.skippedFrames);
 assert(activePreview.renderedFrames>previewStart.renderedFrames);assert(requests.presence>initialRequests.presence);assert(requests.media>initialRequests.media);
 assert.deepEqual((await state()).position,initialState.position);assert.equal((await state()).moving,false);assert.equal(await page.locator('#labels').evaluate(node=>node.hidden),true);
 assert.equal(await page.evaluate(()=>__universe.getScreenPoint(0,7,2.6).visible),false);
 await page.screenshot({path:out+'/02-creator-paused-world.png'});
 await report('World draws stop completely while creator, presence, media policy, room events and app ticks continue',{before:opened.presentation,paused:paused.presentation,creatorFrames:activePreview.renderedFrames-previewStart.renderedFrames,presenceRequests:requests.presence-initialRequests.presence,mediaRequests:requests.media-initialRequests.media});
 // Resize the creator independently. The retained world buffer must not clear
 // or be resized until it can draw the current world again.
 await page.setViewportSize({width:900,height:760});await page.waitForTimeout(250);
 const resizedPaused=await stats();assert(resizedPaused.presentation.resizePending);assert.equal(resizedPaused.renderWidth,paused.renderWidth);assert.equal(resizedPaused.renderHeight,paused.renderHeight);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await resumed();
 const resumedStats=await stats();assert(resumedStats.presentation.drawnFrames>paused.presentation.drawnFrames);assert.equal(resumedStats.presentation.resizePending,false);assert.equal(resumedStats.renderWidth,900);assert.equal(resumedStats.renderHeight,760);
 assert.deepEqual((await state()).user.appearance,initialState.user.appearance);assert.deepEqual((await state()).position,initialState.position);
 const peerPose=resumedStats.presentation.actors.find(p=>p.id===ownerSession.user.id);assert.equal(peerPose.x,-3);assert.equal(peerPose.z,7);assert(resumedStats.presentation.lastRenderDt<=.1);
 assert.equal((await preview()).active,false);assert.equal((await preview()).meshCount,0);assert.equal((await preview()).camera,null);
 await page.screenshot({path:out+'/03-world-resumed.png'});await report('Cancel resumes with current peer pose, resized buffer and unchanged account/player state; preview resources released',{resumed:resumedStats.presentation});
 await page.locator('#dock-chat').click();await page.getByText('Creator fixture: room chat is still live',{exact:true}).waitFor();await report('Room chat received during creator is available after close');
 await openCreator();await page.getByRole('tab',{name:'Extras',exact:true}).click();await page.getByRole('button',{name:'Headwear: Soft cap',exact:true}).click();await page.getByRole('button',{name:'Save character',exact:true}).click();await resumed();assert.equal((await state()).user.appearance.hat,'cap');
 await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__universe?.getState().ready&&__universe.getStats().presentation.drawnFrames>2);assert.equal((await state()).user.appearance.hat,'cap');
 await report('Save persists the changed appearance across reload and world drawing resumes');
 await openCreator();await page.goBack();await resumed();await page.goForward();await page.waitForFunction(()=>__universe.getStats().presentation.suspended&&__universe.getCreatorPreview().active);await page.keyboard.press('Escape');await resumed();await report('Browser Back/Forward and Escape keep pause/resume paired across repeated creator lifecycles');
 await openCreator();const beforeRevoke=await stats();
 await owner('/api/rooms/commons','PATCH',{public:false});
 await page.waitForFunction(()=>!__universe.getState().ready&&__universe.getStats().presentation.avatarCount===0);
 const revoked=await stats();assert.equal(revoked.presentation.drawnFrames,beforeRevoke.presentation.drawnFrames);assert.equal(revoked.presentation.suspended,true);assert.equal(await page.locator('#labels').locator('.player-label').count(),0);
 assert(!app.presence.has('commons:'+initialState.user.id));await page.getByRole('button',{name:'Cancel',exact:true}).click();await resumed();assert.equal((await stats()).presentation.avatarCount,0);await page.getByText('You’ve left this room',{exact:true}).waitFor();await page.screenshot({path:out+'/04-access-revoked.png'});
 await report('Access revoke while paused clears actor resources and presence; close cannot resurrect stale people',{revoked:revoked.presentation});
 assert.equal(initialStats.hardwareScalingLevel,(await stats()).hardwareScalingLevel);assert.deepEqual(errors,[]);await report('No page errors; original hardware scaling policy retained');
}catch(error){errors.push(error.stack);console.error(error);process.exitCode=1;await page?.screenshot({path:out+'/failure.png'}).catch(()=>{});}
finally{await writeFile(out+'/results.json',JSON.stringify(result,null,2));await browser?.close();await app.close();}
