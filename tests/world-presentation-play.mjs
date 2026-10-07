/** Native input + real-time CDP recording of the actual playable renderer. */
import {launch} from '../scripts/browser.mjs';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds} from '../src/worlds.js';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const out='evidence/world-presentation-play',tmp=out+'/frames';await mkdir(tmp,{recursive:true});
const app=createGameServer({seeds:seedWorlds,dist:new URL('../dist',import.meta.url).pathname}),{port}=await app.listen(0),browser=await launch(),context=await browser.newContext({viewport:{width:1280,height:800},reducedMotion:'reduce'}),p=await context.newPage();p.setDefaultTimeout(60000);
const frames=[],writes=[],checks=[],errors=[];let cdp;
p.on('pageerror',e=>errors.push(e.message));const wait=ms=>p.waitForTimeout(ms);
const point=(x,z,y=0)=>p.evaluate(o=>__universe.getScreenPoint(o.x,o.z,o.y),{x,z,y});
try{
 await p.goto(`http://127.0.0.1:${port}`);await p.getByPlaceholder('Your name').fill('World explorer');await p.getByRole('button',{name:'Enter Universe'}).click();await p.waitForFunction(()=>__universe.getState().ready);if(await p.getByRole('button',{name:'Not now',exact:true}).isVisible())await p.getByRole('button',{name:'Not now',exact:true}).click();await wait(800);
 cdp=await context.newCDPSession(p);cdp.on('Page.screencastFrame',e=>{const path=tmp+'/'+String(frames.length).padStart(5,'0')+'.jpg';frames.push({path,t:e.metadata.timestamp});writes.push(writeFile(path,Buffer.from(e.data,'base64')));cdp.send('Page.screencastFrameAck',{sessionId:e.sessionId}).catch(()=>{});});await cdp.send('Page.startScreencast',{format:'jpeg',quality:85,maxWidth:1280,maxHeight:800,everyNthFrame:1});
 await p.locator('#game').focus();await p.keyboard.down('d');await wait(550);await p.keyboard.up('d');await p.keyboard.down('Shift');await p.keyboard.down('a');await wait(220);await p.keyboard.up('a');await p.keyboard.up('Shift');checks.push('Native walk and Shift fast walk');
 await p.mouse.move(850,430);await p.mouse.down({button:'right'});await p.mouse.move(1030,470,{steps:20});await p.mouse.up({button:'right'});await wait(600);await p.keyboard.press('Home');await wait(600);checks.push('Native orbit, tilt and camera reset');
 await p.locator('#dock-build').click();await p.locator('[data-tool="chair"]').click();const q=await point(4,3);await p.mouse.move(q.x,q.y,{steps:12});await wait(500);await p.keyboard.press('r');await wait(250);await p.mouse.click(q.x,q.y);const chair=await p.evaluate(()=>__universe.getState().scene.objects.at(-1));assert.equal(chair.type,'chair');await p.keyboard.press('v');const hit=await point(chair.x,chair.z,.52);await p.mouse.click(hit.x,hit.y);assert.equal(await p.evaluate(()=>__universe.getEditor().selected),chair.id);await wait(1000);await p.screenshot({path:out+'/selection-actual-game.png'});checks.push('Native placement, rotate and pointer selection preserve object identity');
 await p.keyboard.press('Control+z');await wait(500);await p.keyboard.press('Control+Shift+z');await wait(600);checks.push('Native undo and redo');
 await p.getByRole('button',{name:'Close editor',exact:true}).click();await p.getByRole('button',{name:'Keep draft',exact:true}).click();assert(await p.locator('#editor').isHidden());assert(await p.evaluate(()=>__universe.getEditor().dirty));await wait(600);await p.locator('#game').focus();await p.keyboard.down('w');await wait(650);await p.keyboard.up('w');await wait(500);assert.deepEqual(errors,[]);
}catch(e){errors.push(e.stack);process.exitCode=1;console.error(e);await p.screenshot({path:out+'/failure.png'}).catch(()=>{});}finally{
 await cdp?.send('Page.stopScreencast').catch(()=>{});await Promise.all(writes);if(frames.length>1){let list='';for(let i=0;i<frames.length;i++){list+=`file '${frames[i].path.split('/').at(-1)}'\n`;if(i<frames.length-1)list+=`duration ${Math.max(.012,frames[i+1].t-frames[i].t).toFixed(5)}\n`;}list+=`file '${frames.at(-1).path.split('/').at(-1)}'\n`;await writeFile(tmp+'/frames.txt',list);const ff=spawnSync('ffmpeg',['-y','-f','concat','-safe','0','-i',tmp+'/frames.txt','-fps_mode','vfr','-c:v','libx264','-preset','fast','-crf','23','-pix_fmt','yuv420p','-movflags','+faststart',out+'/world-presentation-gameplay.mp4'],{encoding:'utf8'});if(ff.status)errors.push(ff.stderr);}
 await writeFile(out+'/results.json',JSON.stringify({checks,errors,frames:frames.length,scope:'Actual game, native input, original screencast timing. Software WebGL; pauses reflect this test environment, not physical-device evidence.'},null,2));await browser.close();await app.close();await rm(tmp,{recursive:true,force:true});
}
