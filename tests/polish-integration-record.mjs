/** Actual shell interaction recording, CDP timestamps; no fabricated UI or scene changes. */
import {launch} from '../scripts/browser.mjs';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds} from '../src/worlds.js';
import {mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
const out='evidence/integration/walkthrough',frames=await mkdtemp(join(tmpdir(),'external-shell-frames-'));await mkdir(out,{recursive:true});
const app=createGameServer({database:':memory:',seeds:seedWorlds,dist:new URL('../dist',import.meta.url).pathname}),{port}=await app.listen(0),browser=await launch(),context=await browser.newContext({viewport:{width:568,height:320},isMobile:true,hasTouch:true,reducedMotion:'reduce'}),p=await context.newPage();p.setDefaultTimeout(60000);
const captures=[],writes=[],steps=[],errors=[];let cdp;
const wait=ms=>p.waitForTimeout(ms);
async function step(name,run){steps.push({name,started:Date.now()});await run();await wait(1000);}
try{
 await p.goto(`http://127.0.0.1:${port}`);await p.waitForFunction(()=>window.__universe&&!document.querySelector('#join-button').disabled);await p.getByPlaceholder('Your name').fill('Shell walkthrough');await p.getByRole('button',{name:'Enter Universe',exact:false}).click();await p.waitForFunction(()=>__universe.getState().ready);if(await p.getByRole('button',{name:'Not now',exact:true}).isVisible())await p.getByRole('button',{name:'Not now',exact:true}).click();
 cdp=await context.newCDPSession(p);cdp.on('Page.screencastFrame',e=>{const file=join(frames,String(captures.length).padStart(5,'0')+'.jpg');captures.push({file,t:e.metadata.timestamp});writes.push(writeFile(file,Buffer.from(e.data,'base64')));cdp.send('Page.screencastFrameAck',{sessionId:e.sessionId}).catch(()=>{});});await cdp.send('Page.startScreencast',{format:'jpeg',quality:85,maxWidth:568,maxHeight:320,everyNthFrame:1});
 await step('Walk in 568x320 emulated landscape',async()=>{await p.locator('#game').focus();await p.keyboard.down('d');await wait(600);await p.keyboard.up('d');});
 await step('Build: select, rotate, undo and redo with native controls',async()=>{await p.locator('#dock-build').tap();await p.locator('#game').focus();await p.keyboard.press(']');await p.keyboard.press('r');await p.keyboard.press('Control+z');await p.keyboard.press('Control+Shift+z');await p.getByRole('button',{name:'Close editor',exact:true}).tap();});
 await step('Open Chat and keep an unsent draft',async()=>{await p.locator('#dock-chat').tap();await p.getByRole('textbox',{name:'Message the room',exact:true}).fill('A little room for us');});
 await step('Close Chat and open More',async()=>{await p.getByRole('button',{name:'Close social panel',exact:true}).tap();await p.locator('#dock-more').tap();});
 await step('Discover character and room actions',async()=>{await p.locator('#shell-more').getByRole('button',{name:'Customize character',exact:true}).scrollIntoViewIfNeeded();});
 await step('Open profile through More',async()=>{await p.locator('#shell-more').getByRole('button',{name:'You',exact:true}).tap();});
 await step('Return to retained chat draft',async()=>{await p.getByRole('button',{name:'Close social panel',exact:true}).tap();await p.locator('#dock-chat').tap();});
 await step('Return to the world',async()=>{await p.getByRole('button',{name:'Close social panel',exact:true}).tap();await p.locator('#game').focus();await p.keyboard.down('w');await wait(500);await p.keyboard.up('w');});
}catch(e){errors.push(e.stack);process.exitCode=1;console.error(e);}
finally{await cdp?.send('Page.stopScreencast').catch(()=>{});await Promise.all(writes);if(captures.length>1){let list='';for(let i=0;i<captures.length;i++){list+=`file '${captures[i].file}'\n`;if(i<captures.length-1)list+=`duration ${Math.max(.012,captures[i+1].t-captures[i].t).toFixed(5)}\n`;}list+=`file '${captures.at(-1).file}'\n`;await writeFile(join(frames,'frames.txt'),list);const ff=spawnSync('ffmpeg',['-y','-f','concat','-safe','0','-i',join(frames,'frames.txt'),'-fps_mode','vfr','-c:v','libx264','-preset','fast','-crf','22','-pix_fmt','yuv420p','-movflags','+faststart',out+'/integrated-walkthrough.mp4'],{encoding:'utf8'});if(ff.status){errors.push(ff.stderr);process.exitCode=1;}}
 await writeFile(out+'/recording.json',JSON.stringify({steps,frames:captures.length,errors,scope:'Actual app in Chromium software WebGL. 568x320 touch emulation with keyboard input; real capture timestamps, no physical-device claim.'},null,2));await context.close();await browser.close();await app.close();await rm(frames,{recursive:true,force:true});}
