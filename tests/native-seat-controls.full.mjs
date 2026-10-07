/** Native Sit/Stand regression on isolated local users.
 * SEAT_QUEST=1 adds quest/area coexistence; SEAT_TEXT_SCALE=root200|computed2x
 * stresses text without changing app state. SEAT_PROBE=1 is observation-only.
 * SEAT_BASELINE_STYLE can load the unchanged baseline stylesheet as a negative control.
 */
import {build} from 'esbuild';
import {mkdtemp,cp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {launch} from '../scripts/browser.mjs';
import {emptyScene} from '../src/worlds.js';
import {createGameServer} from '../server/app.mjs';

const dir=await mkdtemp(join(tmpdir(),'native-seat-controls-'));
const out=process.env.SEAT_EVIDENCE||'evidence/native-seat-controls';
const withQuests=!!process.env.SEAT_QUEST,assertSeat=!process.env.SEAT_PROBE;
const viewports=JSON.parse(process.env.SEAT_VIEWPORTS||'[{"width":320,"height":568},{"width":667,"height":375},{"width":1280,"height":800}]');
await mkdir(out,{recursive:true});
await cp('public',dir,{recursive:true});
if(process.env.SEAT_BASELINE_STYLE)await cp(process.env.SEAT_BASELINE_STYLE,join(dir,'style.css'));
await build({entryPoints:['src/main.js'],outdir:dir,bundle:true,format:'esm',splitting:true,minify:true,target:'es2022'});
const hash=async name=>createHash('sha256').update(await readFile(join(dir,name))).digest('hex');
const provenance={mainSha256:await hash('main.js'),moduleCssSha256:await hash('main.css'),publicStyleSha256:await hash('style.css'),textScale:process.env.SEAT_TEXT_SCALE||'normal',baselineStyle:!!process.env.SEAT_BASELINE_STYLE};
const browser=await launch(),checks=[],errors=[];
const scope='Isolated local synthetic users, rendered UI and native Chromium input with read-only diagnostics; no hosted or physical-phone claim';
let page,app,context;
const persist=()=>writeFile(out+'/results.json',JSON.stringify({checks,errors,scope,provenance},null,2));
const report=async(name,data={})=>{checks.push({name,status:assertSeat?'passed':'observed',...data});console.log(JSON.stringify(checks.at(-1)));await persist();};
const state=()=>page.evaluate(()=>({position:__universe.getState().position,motion:__universe.getMotion(),path:__universe.getPath(),toast:document.querySelector('#toast').textContent}));
const settle=()=>page.waitForTimeout(600);
async function enter(target,port,name){
 target.setDefaultTimeout(30000);target.on('pageerror',error=>errors.push(error.message));
 await target.goto('http://127.0.0.1:'+port+'/?room=seat-room',{waitUntil:'domcontentloaded'});
 await target.getByPlaceholder('Your name').fill(name);await target.locator('#join-button').click();
 await target.waitForFunction(()=>window.__universe?.getState().ready&&__universe.getStats().presentation.drawnFrames>2);
}
async function waitPose(seatId,target=page){
 await target.waitForFunction(id=>__universe.getMotion().seatId===id,seatId);
 await target.waitForFunction(id=>{const s=__universe.getState();return s.people.some(p=>p.id===s.user.id&&(p.seatId??null)===id);},seatId);
}
async function clickPoint(point,touch){
 assert(point.visible,'Projected seat must be visible');
 assert.equal(await page.evaluate(p=>document.elementFromPoint(p.x,p.y)?.id,point),'game','Projected seat must be unobscured canvas');
 if(touch)await page.touchscreen.tap(point.x,point.y);else await page.mouse.click(point.x,point.y);
}
const chairPoint=id=>page.evaluate(id=>{const o=__universe.getState().scene.objects.find(o=>o.id===id);return __universe.getScreenPoint(o.x,o.z,.5);},id);
async function scaleText(){
 if(process.env.SEAT_TEXT_SCALE==='root200')await page.evaluate(()=>document.documentElement.style.fontSize='200%');
 if(process.env.SEAT_TEXT_SCALE==='computed2x')await page.evaluate(()=>{
  const nodes=[...document.querySelectorAll('#app *')].filter(n=>!n.dataset.seatTextStress&&[...n.childNodes].some(t=>t.nodeType===Node.TEXT_NODE&&t.textContent.trim()));
  const sizes=nodes.map(n=>parseFloat(getComputedStyle(n).fontSize));
  nodes.forEach((n,i)=>{n.style.setProperty('font-size',`${sizes[i]*2}px`,'important');n.dataset.seatTextStress='true';});
 });
}
async function controlHits(selector){
 return page.locator(selector).evaluate(n=>{const r=n.getBoundingClientRect();return{rect:r.toJSON(),hits:[[.5,.5],[.25,.25],[.75,.25],[.25,.75],[.75,.75]].map(([x,y])=>n.contains(document.elementFromPoint(r.x+r.width*x,r.y+r.height*y)))};});
}
async function contextualGeometry(){
 const g=await page.evaluate(()=>{
  const a=document.querySelector('#interaction').getBoundingClientRect(),q=document.querySelector('.quest-context').getBoundingClientRect(),b=document.querySelector('#interact'),r=b.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(b);
  return{interaction:a.toJSON(),context:q.toJSON(),target:r.toJSON(),fontSize:parseFloat(getComputedStyle(b).fontSize),label:b.textContent,paintFits:[...range.getClientRects()].filter(p=>p.width&&p.height).every(p=>p.left>=r.left-.5&&p.right<=r.right+.5&&p.top>=r.top-.5&&p.bottom<=r.bottom+.5),hit:b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};
 });
 assert(g.hit&&g.paintFits,JSON.stringify(g));assert(g.target.width>=48&&g.target.height>=48);
 if(process.env.SEAT_TEXT_SCALE)assert(g.fontSize>=23.9,'Primary action text must genuinely enlarge');
 assert(g.context.bottom<=g.interaction.top-7.5||g.context.right<=g.interaction.left-7.5||g.context.left>=g.interaction.right+7.5,JSON.stringify(g));
 assert(g.context.height>=48,JSON.stringify(g));
 for(const selector of ['#joystick','#jump-button','#zoom-in','#zoom-out','#camera-follow','#movement-side-toggle']){
  const control=await controlHits(selector);assert(control.hits.every(Boolean),selector+' must remain reachable '+JSON.stringify(control));
 }
 return g;
}
async function contextualJourney(label){
 await page.locator('.quest-invitation').waitFor({state:'visible'});await scaleText();await settle();
 const measure=await page.evaluate(()=>Object.fromEntries(['#interaction','#interact','.quest-context','.quest-invitation','#area-banner'].map(selector=>{const n=document.querySelector(selector),r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return[selector,{rect:r.toJSON(),hit:hit?.className||hit?.id}];})));
 await report(label+' contextual geometry',{measure});await page.screenshot({path:out+'/'+label+'-quest-seat.png'});
 if(!assertSeat)return;
 const clear=async phase=>{
  const sitting=await contextualGeometry();await page.locator('#interact').tap();await waitPose('near-chair');await settle();
  const standing=await contextualGeometry();assert.match(standing.label,/Stand up/);
  await page.screenshot({path:out+'/'+label+'-'+phase.replaceAll(' ','-')+'-seated.png'});
  await page.locator('#interact').tap();await waitPose(null);await report(label+' '+phase+' stays clear of Sit/Stand',{sitting,standing});
 };
 await clear('invitation and area');
 await page.locator('.quest-invitation').getByRole('button',{name:'Show me the options',exact:true}).tap();
 const card=page.locator('.quest-card').filter({has:page.getByRole('heading',{name:'Explore Sitting lawn',exact:true})});
 await card.getByRole('button',{name:'Accept quest',exact:true}).tap();await card.getByRole('button',{name:'Show the way',exact:true}).tap();
 await page.locator('.quest-tracker').waitFor({state:'visible'});await scaleText();await settle();await clear('tracked quest and area');
 await page.locator('#movement-side-toggle').tap();await settle();await clear('mirrored tracked quest and area');
 await page.screenshot({path:out+'/'+label+'-quest-left.png'});
}
async function ordinaryJourney(label,touch,port){
 const geometry=await page.evaluate(()=>Object.fromEntries(['interaction','interact','joystick','jump-button'].map(id=>{const e=document.getElementById(id),r=e.getBoundingClientRect();return[id,{rect:{x:r.x,y:r.y,width:r.width,height:r.height},hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.id,visible:!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden',text:e.textContent}];})));
 await page.screenshot({path:out+'/'+label+'-nearby-before.png'});
 const rect=geometry.interact.rect;
 if(touch)await page.touchscreen.tap(rect.x+rect.width/2,rect.y+rect.height/2);else await page.mouse.click(rect.x+rect.width/2,rect.y+rect.height/2);
 await settle();
 if(assertSeat){assert.equal(geometry.interact.hit,'interact',JSON.stringify({geometry,after:await state()}));await waitPose('near-chair');if(touch)assert(rect.width>=48&&rect.height>=48);}
 await report(label+' natural nearby Sit button',{geometry,after:await state()});await page.screenshot({path:out+'/'+label+'-nearby-after.png'});
 if(assertSeat&&touch){
  await page.locator('#interact').tap();await waitPose(null);await page.locator('#movement-side-toggle').tap();await settle();
  const mirrored=await controlHits('#interact');assert(mirrored.hits.every(Boolean));
  await page.locator('#interact').tap();await waitPose('near-chair');await page.screenshot({path:out+'/'+label+'-left-seated.png'});
  await page.locator('#interact').tap();await waitPose(null);await report(label+' mirrored visible Sit and Stand targets work',{mirrored});
  await page.locator('#movement-side-toggle').tap();await settle();
 }
 if(assertSeat&&!touch){
  const owner=page,peerContext=await browser.newContext({viewport:{width:1280,height:800}});
  try{
   page=await peerContext.newPage();await enter(page,port,'Seat occupancy peer');await page.locator('#interaction').waitFor({state:'visible'});
   await page.locator('#interact').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('already sitting'));assert.equal((await state()).motion.seatId,null);
   await report('desktop second synthetic user cannot take an occupied seat',{after:await state()});await page.screenshot({path:out+'/occupied-seat-rejected.png'});
   await owner.bringToFront();await owner.locator('#game').focus();await owner.keyboard.press('t');await waitPose(null,owner);
   await page.bringToFront();await page.locator('#interact').click();await waitPose('near-chair');await page.locator('#interact').click();await waitPose(null);
   await report('desktop seat becomes available only after its occupant stands');
  }finally{await peerContext.close();page=owner;await page.bringToFront();}
 }
 if((await state()).motion.seatId){await page.locator('#game').focus();await page.keyboard.press('t');await waitPose(null);await settle();}
 await page.locator('#game').focus();await page.keyboard.press('t');await waitPose('near-chair');await report(label+' T reaches canonical seated pose',{after:await state()});
 await page.keyboard.press('r');await settle();assert(Math.abs((await state()).motion.heading)<.001);
 await page.keyboard.press('t');await waitPose(null);await report(label+' T stands and seated heading remains chair-aligned');
 await page.waitForTimeout(1200);const near=await chairPoint('near-chair');await clickPoint(near,touch);await waitPose('near-chair');await report(label+' rendered nearby chair picking sits',{point:near});
 await page.locator('#game').focus();await page.keyboard.press('t');await waitPose(null);
 await page.locator('#dock-chat').click();const composer=page.getByRole('textbox',{name:'Message the room'});await composer.click();await page.keyboard.type('t');await settle();assert.equal((await state()).motion.seatId,null);
 await page.keyboard.press('Escape');await page.locator('#social').waitFor({state:'hidden'});await report(label+' typing T stays in chat');
 await page.locator('#game').focus();await page.keyboard.press('F1');await page.keyboard.press('t');await settle();assert.equal((await state()).motion.seatId,null);await page.keyboard.press('Escape');await report(label+' modal owns T');
 await page.locator('#dock-build').click();await page.keyboard.press('t');await settle();assert.equal((await state()).motion.seatId,null);
 await page.getByRole('button',{name:'Close editor',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#editor').hidden);await report(label+' Build owns T');
 const far=await chairPoint('far-chair');await clickPoint(far,touch);await page.waitForTimeout(2000);await page.waitForFunction(()=>__universe.getPath().length===0&&!__universe.getState().moving);
 await report(label+' one distant rendered-chair click',{point:far,after:await state(),prompt:await page.locator('#interaction').innerText()});await page.screenshot({path:out+'/'+label+'-distant-first-click.png'});
 await clickPoint(await chairPoint('far-chair'),touch);await waitPose('far-chair');assert.equal((await state()).motion.heading,-Math.PI/2);
 await report(label+' second chair click seats with rotated canonical pose');await page.screenshot({path:out+'/'+label+'-rotated-seated.png'});
}
try{
 for(const viewport of viewports){
  const touch=viewport.width!==1280,label=`${viewport.width}x${viewport.height}`;
  const scene={...emptyScene(),spawn:{x:0,z:0},objects:[{id:'near-chair',type:'chair',name:'Chair',x:0,z:-2,rotation:0},{id:'far-chair',type:'chair',name:'Rotated chair',x:5,z:-3,rotation:90},{id:'near-bench',type:'bench',name:'Bench',x:-4,z:-3,rotation:180}],areas:withQuests?[{id:'sitting-lawn',name:'Sitting lawn',x:0,z:-1,width:8,depth:8,action:'welcome',message:'Welcome. Pick a chair and make yourself comfortable.'}]:[]};
  app=createGameServer({seeds:[{id:'seat-world',name:'Seat world',rooms:[{id:'seat-room',name:'Seat room',scene}]}],dist:dir,questsEnabled:withQuests});
  const {port}=await app.listen(0);context=await browser.newContext({viewport,hasTouch:touch,isMobile:touch,deviceScaleFactor:touch?2:1});page=await context.newPage();
  await enter(page,port,'Seat audit '+label);const no=page.getByRole('button',{name:'Not now',exact:true});if(!withQuests&&await no.isVisible())await no.click();
  await page.waitForFunction(()=>!document.querySelector('#interaction').hidden);await settle();
  if(withQuests)await contextualJourney(label);else await ordinaryJourney(label,touch,port);
  await context.close();context=null;await app.close();app=null;
 }
 assert.deepEqual(errors,[]);
}catch(error){console.error(error);checks.push({name:'Native seat regression',status:'failed',error:error.stack,state:await state().catch(()=>null)});await page?.screenshot({path:out+'/failure.png'}).catch(()=>{});process.exitCode=1;}
finally{await persist();await context?.close();await app?.close();await browser.close();await rm(dir,{recursive:true,force:true});}
