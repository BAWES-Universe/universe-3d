/** Native wall authoring on a disposable real server. Browser evaluation only
 * reads diagnostics, scene state and projections; edits use native input. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createGameServer} from '../server/app.mjs';
import {emptyScene,collisionBox,canStand} from '../src/worlds.js';
import {overlaps} from '../src/editor-geometry.js';
import {launch} from '../scripts/browser.mjs';

const out='evidence/wall-building-native';await mkdir(out,{recursive:true});
const dist=process.env.UNIVERSE_WALL_TEST_DIST||new URL('../dist',import.meta.url).pathname;
const app=createGameServer({database:':memory:',seeds:[{id:'universe',name:'Wall testing',rooms:[{id:'commons',name:'Make a corner',scene:emptyScene()}]}],dist});
const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`,browser=await launch(),contexts=[],checks=[],errors=[],collisionSamples=[];
let page,phase='startup';
const scene=p=>p.evaluate(()=>__universe.getState().scene),editor=p=>p.evaluate(()=>__universe.getEditor());
const touching=(a,b)=>{
 const x=(a.width+b.width)/2-Math.abs(a.x-b.x),z=(a.depth+b.depth)/2-Math.abs(a.z-b.z);
 return Math.abs(x)<1e-8&&z>1e-8||Math.abs(z)<1e-8&&x>1e-8;
};
async function pass(name){checks.push({name,status:'passed'});console.log('PASS',name);}
async function enter(options={}){
 const context=await browser.newContext({viewport:{width:1440,height:960},...options});contexts.push(context);const p=await context.newPage();page=p;p.setDefaultTimeout(30000);p.on('pageerror',e=>errors.push(e.message));await p.goto(base);
 if(!options.storageState){await p.locator('#display-name').fill('Wall maker');await p.locator('#join-button').click();}
 await p.waitForFunction(()=>window.__universe?.getState().ready,null,{timeout:60000});return p;
}
async function frames(p,n=3){const before=await p.evaluate(()=>__universe.getStats().presentation.drawnFrames);await p.waitForFunction(count=>__universe.getStats().presentation.drawnFrames>=count,before+n);}
// A rejected collision substep can zero velocity before the next smaller step
// closes the remaining gap. Measure sustained contact, not that first zero.
async function wallContact(p,edge){
 return p.evaluate(edge=>new Promise((resolve,reject)=>{
  let previousFrame=-1,previousX=null,stable=0,frame,done=false;const samples=[];
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);cancelAnimationFrame(frame);error?reject(error):resolve(value);};
  const timer=setTimeout(()=>finish(Error('No sustained wall contact: '+JSON.stringify(samples))),30000);
  const tick=()=>{
   const drawnFrame=__universe.getStats().presentation.drawnFrames;
   if(drawnFrame!==previousFrame){
    previousFrame=drawnFrame;const position={...__universe.getState().position},speed=__universe.getMotion().speed;
    samples.push({drawnFrame,position,speed});if(samples.length>24)samples.shift();
    if(position.x<edge-.00001)return finish(Error('Walking crossed the wall face: '+JSON.stringify(samples)));
    const contact=position.x<edge+.01&&speed<.01&&position.y===0;
    stable=contact?(previousX!==null&&Math.abs(position.x-previousX)<.001?stable+1:1):0;previousX=position.x;
    if(stable>=3)return finish(null,{edge,position,samples});
   }
   frame=requestAnimationFrame(tick);
  };frame=requestAnimationFrame(tick);
 }),edge);
}
async function project(p,x,z,y=0){
 await p.waitForFunction(()=>{const f=__universe.getCamera().framing;return f.status==='manual'||!f.targetOffset||Math.hypot(f.offset.x-f.targetOffset.x,f.offset.y-f.targetOffset.y)<1;});
 const q=await p.evaluate(({x,z,y})=>__universe.getScreenPoint(x,z,y),{x,z,y});assert(q.visible,'Point visible: '+JSON.stringify({x,z,q}));assert.equal(await p.evaluate(q=>document.elementFromPoint(q.x,q.y)?.id,q),'game','World input must reach the real canvas');return q;
}
async function drawTool(p){
 if(await p.locator('#editor').isHidden())await p.locator('#dock-build').click();
 if(await p.getByRole('region',{name:'Terrain tools',exact:true}).isHidden())await p.getByRole('button',{name:'Terrain',exact:true}).click();
 await p.getByRole('button',{name:'Draw wall',exact:true}).click();await p.getByRole('button',{name:'Close terrain palette',exact:true}).click();await frames(p);
}
async function drag(p,from,to,{touch=false,cancel=false}={}){
 const a=await project(p,...from),b=await project(p,...to),before=await scene(p);let cdp;
 if(touch){cdp=await p.context().newCDPSession(p);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...a,id:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...b,id:1}]});}
 else{await p.mouse.move(a.x,a.y);await p.mouse.down();await p.mouse.move(b.x,b.y,{steps:8});}
 const preview=(await editor(p)).preview;assert.deepEqual(await scene(p),before,'Dragging only previews');assert(preview?.valid,preview?.reason||'Wall preview missing');
 if(cancel)await p.keyboard.press('Escape');
 if(touch){await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();}else await p.mouse.up();
 return {before,preview};
}
async function save(p){await p.getByRole('button',{name:'Save room',exact:true}).click();await p.waitForFunction(()=>!__universe.getEditor().saving);assert.equal((await editor(p)).dirty,false,await p.locator('.builder-recovery').textContent());return scene(p);}
function corner(objects){assert.equal(objects.length,2);const [a,b]=objects.map(collisionBox);assert.equal(overlaps(a,b),false);assert.equal(touching(a,b),true,'Physical faces touch without a gap');}

try{
 page=await enter();phase='desktop corner and undo';await drawTool(page);
 await drag(page,[-6,1],[-2,1]);const first=await scene(page);assert.equal(first.objects.length,1);
 const second=await drag(page,[-2,1],[-2,5]);const joined=await scene(page);corner(joined.objects);
 assert.equal(joined.objects.at(-1).x,second.preview.x);assert.equal(joined.objects.at(-1).z,second.preview.z);
 await page.locator('#game').focus();await page.keyboard.press('Control+z');assert.deepEqual(await scene(page),first);await page.keyboard.press('Control+Shift+z');assert.deepEqual(await scene(page),joined);
 await pass('Native desktop drag creates a flush L corner; exact preview, one-step Undo and Redo agree');

 phase='rotation lock and cancel';await drawTool(page);const q=await project(page,3,1);await page.mouse.move(q.x,q.y);await page.locator('#game').focus();await page.keyboard.press('r');assert.equal((await editor(page)).preview.rotation,90);
 const locked=await drag(page,[3,1],[6,3],{cancel:true});assert.equal(locked.preview.rotation,90,'Explicit rotation survives a mostly horizontal drag');assert.deepEqual(await scene(page),joined);
 await pass('Native Rotate locks wall orientation during drag and Escape leaves no extra wall');

 phase='server save and reload';await save(page);const response=await page.request.get(base+'/api/rooms/commons');assert.equal(response.status(),200);assert.deepEqual((await response.json()).room.scene,joined);
 await page.getByRole('button',{name:'Close editor',exact:true}).click();await frames(page);await page.screenshot({path:out+'/desktop-corner.png'});
 await page.reload();await page.waitForFunction(()=>window.__universe?.getState().ready);assert.deepEqual(await scene(page),joined);corner((await scene(page)).objects);
 await pass('Real authenticated server retains exact joined geometry after save and browser reload');

 phase='native collision';let target=await project(page,0,3);await page.mouse.click(target.x,target.y);await page.waitForFunction(()=>{const s=__universe.getState();return Math.hypot(s.position.x,s.position.z-3)<.35&&!__universe.getPath().length;});
 await page.locator('#game').focus();await page.keyboard.press('Home');await page.waitForFunction(()=>Math.abs(__universe.getCamera().yaw-Math.PI/4)<.001);const origin=await project(page,0,3);await page.mouse.move(origin.x,origin.y);await page.mouse.down({button:'right'});await page.mouse.move(origin.x+(Math.PI/4)/.006,origin.y,{steps:12});await page.mouse.up({button:'right'});await page.locator('#game').focus();
 const vertical=joined.objects.find(o=>o.rotation===90),edge=vertical.x+.15+.3;
 try{await page.keyboard.down('w');const contact=await wallContact(page,edge),before=contact.position;await frames(page,12);const after=await page.evaluate(()=>__universe.getState().position),sample={...contact,before,after};collisionSamples.push(sample);assert(Math.abs(before.x-after.x)<.01,JSON.stringify(sample));assert(after.x>=edge-.00001,JSON.stringify(sample));assert(canStand(joined,after.x,after.z));}finally{await page.keyboard.up('w');}
 await pass('Native held walking stops at the same joined wall geometry for 12 further rendered frames');

 phase='narrow touch corner';const storageState=await page.context().storageState();await page.context().close();page=await enter({storageState,viewport:{width:390,height:844},isMobile:true,hasTouch:true});await drawTool(page);
 await drag(page,[1,1],[3,1],{touch:true});await drag(page,[3,1],[3,3],{touch:true});const touched=await scene(page);corner(touched.objects.slice(-2));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
 await page.getByRole('button',{name:'More build tools',exact:true}).tap();await page.getByRole('button',{name:'Undo',exact:true}).tap();assert.equal((await scene(page)).objects.length,touched.objects.length-1);await page.getByRole('button',{name:'Redo',exact:true}).tap();assert.deepEqual(await scene(page),touched);await page.getByRole('button',{name:'Close more build tools',exact:true}).tap();await save(page);await page.getByRole('button',{name:'Close editor',exact:true}).tap();await frames(page);await page.screenshot({path:out+'/touch-corner-390.png'});
 await pass('390px native touch builds another flush corner; toolbar Undo/Redo and save preserve it without horizontal overflow');
 assert.deepEqual(errors,[]);
}catch(error){checks.push({name:phase,status:'failed',error:error.stack});process.exitCode=1;console.error(error);if(page&&!page.isClosed()){console.error(await page.evaluate(()=>({camera:__universe.getCamera(),editor:__universe.getEditor(),state:__universe.getState()})).catch(e=>e.message));await page.screenshot({path:out+'/failure.png'}).catch(()=>{});}}
finally{
 const hash=createHash('sha256').update(await readFile(dist+'/main.js')).digest('hex');
 await writeFile(out+'/results.json',JSON.stringify({checks,errors,collisionSamples,bundleSha256:hash,limits:['Disposable loopback app and local synthetic account; no production changes','Native mouse, keyboard and CDP touch; evaluation only reads diagnostics','Chromium SwiftShader and 390px touch emulation do not certify physical phones']},null,2));
 for(const context of contexts)await context.close().catch(()=>{});await browser.close();await app.close();
}
