// Actual bundled app + disposable local authority. Root resizing must really
// enlarge text; the second stress mode doubles a snapshot of computed sizes.
// Chromium emulation is not certification of native mobile accessibility modes.
import assert from 'node:assert/strict';
import {mkdtemp,cp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {build} from 'esbuild';
import {launch} from '../scripts/browser.mjs';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds} from '../src/worlds.js';
const output=process.env.ENLARGED_OUTPUT||'evidence/enlarged-control-text';
await mkdir(output,{recursive:true});
let dist=process.env.ENLARGED_TEST_DIST,temporary;
if(!dist){temporary=await mkdtemp(join(tmpdir(),'universe-enlarged-text-'));dist=temporary;await cp('public',dist,{recursive:true});await build({entryPoints:['src/main.js'],outdir:dist,bundle:true,format:'esm',splitting:true,minify:true,target:'es2022'});}
const bundle=Object.fromEntries(await Promise.all(['style.css','main.css','main.js'].map(async name=>[name,createHash('sha256').update(await readFile(join(dist,name))).digest('hex')])));
const app=createGameServer({seeds:structuredClone(seedWorlds),dist}),{port}=await app.listen(0),browser=await launch();
const context=await browser.newContext({viewport:{width:320,height:568},hasTouch:true,reducedMotion:'reduce'}),page=await context.newPage(),checks=[],errors=[];
page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));
await page.addInitScript(()=>{window.captureAttempts=0;for(const method of ['getUserMedia','getDisplayMedia'])if(navigator.mediaDevices)Object.defineProperty(navigator.mediaDevices,method,{value:()=>{window.captureAttempts++;throw Error('Capture is forbidden in the enlarged-text test');}});});
const modes=['normal','root200','computed2x'];
const viewports=JSON.parse(process.env.ENLARGED_VIEWPORTS||'[[320,568],[390,844],[667,375],[550,375]]');
const textSelectors=['#room-name','#movement-side-toggle','#jump-button','#dock-explore label','#dock-more label'];
const controlSelectors=['#zoom-in','#zoom-out','#camera-follow','#movement-side-toggle','#jump-button','#joystick'];
const check=async(name,fn)=>{try{const detail=await fn();checks.push({name,status:'passed',detail});console.log('PASS',name);}catch(error){checks.push({name,status:'failed',error:error.message});process.exitCode=1;console.error('FAIL',name,error.message);}};
async function metrics(){return page.evaluate(({textSelectors,controlSelectors})=>{
 const rect=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
 const visible=n=>n&&getComputedStyle(n).display!=='none'&&getComputedStyle(n).visibility!=='hidden'&&n.getBoundingClientRect().width>0;
 const paint=n=>{if(!visible(n))return[];const walker=document.createTreeWalker(n,NodeFilter.SHOW_TEXT),list=[];while(walker.nextNode()){if(!walker.currentNode.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(walker.currentNode);for(const r of range.getClientRects())if(r.width&&r.height)list.push({x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,unobscured:n.closest('button')?.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))??null});}return list;};
 return{width:innerWidth,height:innerHeight,pageWidth:document.documentElement.scrollWidth,text:Object.fromEntries(textSelectors.map(s=>{const n=document.querySelector(s);return[s,{fontSize:parseFloat(getComputedStyle(n).fontSize),rect:rect(n),paint:paint(n)}];})),controls:Object.fromEntries(controlSelectors.map(s=>{const n=document.querySelector(s),r=rect(n),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return[s,{...r,visible:visible(n),hit:hit?.id||hit?.className,reachable:n.contains(hit)}];})),dock:rect(document.querySelector('#dock')),header:rect(document.querySelector('#hud')),camera:rect(document.querySelector('#view-controls'))};
 },{textSelectors,controlSelectors});}
const overlaps=(a,b)=>a.x<b.right-.5&&a.right>b.x+.5&&a.y<b.bottom-.5&&a.bottom>b.y+.5;
async function checkLayout(label,before,mode){const after=await metrics();await writeFile(`${output}/${label}.json`,JSON.stringify(after,null,2));await page.screenshot({path:`${output}/${label}.png`});
 await check(label+' text really grows',()=>{if(mode==='normal')return;for(const s of textSelectors)assert(after.text[s].fontSize>=before.text[s].fontSize*1.99,`${s}: ${before.text[s].fontSize}px -> ${after.text[s].fontSize}px`);});
 await check(label+' painted title and control text stay in their boxes',()=>{for(const s of textSelectors){const entry=after.text[s];assert(entry.paint.length,`${s} must retain visible text`);if(s==='#movement-side-toggle'||s==='#jump-button')for(const p of entry.paint)assert(p.unobscured,`${s} text is obscured at its painted center`);for(const p of entry.paint)assert(p.x>=entry.rect.x-1&&p.right<=entry.rect.right+1&&p.y>=entry.rect.y-1&&p.bottom<=entry.rect.bottom+1,`${s} painted outside its box: ${JSON.stringify(entry)}`);}for(const p of after.text['#room-name'].paint)for(const [s,c]of Object.entries(after.controls))assert(!overlaps(p,c),`room title paints over ${s}`);});
 await check(label+' controls are separate reachable 48px targets',()=>{assert.equal(after.pageWidth,after.width);for(const [s,c]of Object.entries(after.controls)){assert(c.visible&&c.width>=48&&c.height>=48&&c.x>=0&&c.y>=0&&c.right<=after.width+1&&c.bottom<=after.height+1&&c.reachable,`${s}: ${JSON.stringify(c)}`);}const list=Object.entries(after.controls);for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++)assert(!overlaps(list[i][1],list[j][1]),`${list[i][0]} overlaps ${list[j][0]}`);});
 await check(label+' dock labels fit distinct reachable targets',async()=>{for(const id of ['dock-explore','dock-chat','dock-people','dock-build','dock-more']){const target=page.locator('#'+id);await target.scrollIntoViewIfNeeded();const detail=await target.evaluate(n=>{const r=n.getBoundingClientRect(),label=n.querySelector('label'),range=document.createRange();range.selectNodeContents(label);const p=range.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{width:r.width,height:r.height,hit:n.contains(hit),fits:p.x>=r.x&&p.right<=r.right&&p.y>=r.y&&p.bottom<=r.bottom,x:r.x,right:r.right,y:r.y,bottom:r.bottom};});assert(detail.width>=48&&detail.height>=48&&detail.hit&&detail.fits&&detail.x>=0&&detail.right<=page.viewportSize().width&&detail.y>=0&&detail.bottom<=page.viewportSize().height,`${id}: ${JSON.stringify(detail)}`);}});
 await check(label+' keyboard focus keeps its separate white outline',async()=>{
  const more=page.locator('#dock-more');await more.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');assert.equal(await more.evaluate(n=>document.activeElement===n),true);const focus=await more.evaluate(n=>({color:getComputedStyle(n).outlineColor,width:getComputedStyle(n).outlineWidth,style:getComputedStyle(n).outlineStyle}));assert.deepEqual(focus,{color:'rgb(255, 255, 255)',width:'2px',style:'solid'});
 });
 return after;
}
async function resizeText(mode){
 if(mode==='root200')await page.evaluate(()=>document.documentElement.style.fontSize='200%');
 if(mode==='computed2x')await page.evaluate(()=>{const snapshot=[...document.querySelectorAll('#app *')].filter(n=>[...n.childNodes].some(t=>t.nodeType===Node.TEXT_NODE&&t.textContent.trim())).map(n=>[n,parseFloat(getComputedStyle(n).fontSize)]);for(const[n,size]of snapshot)n.style.setProperty('font-size',`${size*2}px`,'important');});
}
async function checkNativeMotion(width,height,mode,side){
 await check(`${width}x${height}-${mode} ${side} native movement + camera + Jump and recovery`,async()=>{
   if(await page.locator('#app').getAttribute('data-movement-side')!==side)await page.locator('#movement-side-toggle').click();
   // Dismiss only through real actions, making a patch of world available for
   // the camera gesture. The earlier screenshots retain the first-use cards.
   const later=page.getByRole('button',{name:'Not now',exact:true});if(await later.isVisible()){await later.scrollIntoViewIfNeeded();await later.click();}
   const dismiss=page.locator('.area-banner-dismiss');if(await dismiss.isVisible()){await dismiss.scrollIntoViewIfNeeded();await dismiss.click();}
   const stick=await page.locator('#joystick').boundingBox(),jump=await page.locator('#jump-button').boundingBox();
   const world=await page.evaluate(()=>{for(let y=innerHeight*.45;y<innerHeight-100;y+=12)for(let x=40;x<innerWidth-90;x+=12)if(document.elementFromPoint(x,y)?.id==='game'&&document.elementFromPoint(x+32,y)?.id==='game')return{x,y};return null;});assert(world,'A real unobscured canvas patch is available');
   const beforeMotion=await page.evaluate(()=>({position:__universe.getState().position,yaw:__universe.getCamera().yaw}));const cdp=await context.newCDPSession(page),finger={id:1,x:stick.x+stick.width/2+24,y:stick.y+stick.height/2},camera={id:2,...world},jumpFinger={id:3,x:jump.x+jump.width/2,y:jump.y+jump.height/2};
   try{await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[finger]});await page.waitForFunction(p=>Math.hypot(__universe.getState().position.x-p.x,__universe.getState().position.z-p.z)>.03,beforeMotion.position);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[finger,camera]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[finger,{...camera,x:camera.x+32}]});await page.waitForFunction(yaw=>Math.abs(__universe.getCamera().yaw-yaw)>.01,beforeMotion.yaw);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[finger,{...camera,x:camera.x+32},jumpFinger]});await page.waitForFunction(()=>__universe.getState().position.y>0&&__universe.getMotion().speed>0);}finally{await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();}
   await page.waitForFunction(()=>__universe.getMotion().grounded);await page.locator('#dock-more').click();const reset=page.locator('#shell-more').getByRole('button',{name:'Reset camera',exact:true});await reset.scrollIntoViewIfNeeded();await reset.click();await page.waitForFunction(()=>Math.abs(__universe.getCamera().yaw-Math.PI/4)<.001);assert.equal(await page.locator('#shell-more').isVisible(),false);
 });
}

try{
 await page.goto(`http://127.0.0.1:${port}`,{waitUntil:'domcontentloaded'});await page.getByPlaceholder('Your name').fill('Enlarged text reviewer');await page.locator('#join-button').click();await page.waitForFunction(()=>window.__universe?.getState().ready);
 for(const [width,height]of viewports)for(const mode of modes){
  await page.setViewportSize({width,height});await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__universe?.getState().ready);await page.evaluate(()=>document.fonts.ready);const before=await metrics();
  await resizeText(mode);
  await page.waitForTimeout(100);await checkLayout(`${width}x${height}-${mode}`,before,mode);
  // The actual control updates the same label and mirrors the original input
  // nodes. Check the enlarged layout again after that content/state change.
  await check(`${width}x${height}-${mode} handedness swaps keep controls reachable`,async()=>{
   await page.locator('#movement-side-toggle').click();assert.equal(await page.locator('#app').getAttribute('data-movement-side'),'left');const mirrored=await metrics();assert(mirrored.controls['#joystick'].x<100);await writeFile(`${output}/${width}x${height}-${mode}-left.json`,JSON.stringify(mirrored,null,2));const pairs=Object.entries(mirrored.controls);for(let i=0;i<pairs.length;i++)for(let j=i+1;j<pairs.length;j++)assert(!overlaps(pairs[i][1],pairs[j][1]),`${pairs[i][0]} overlaps ${pairs[j][0]} after swapping`);for(const[s,c]of Object.entries(mirrored.controls))assert(c.reachable&&c.width>=48&&c.height>=48,`${s}: ${JSON.stringify(c)}`);await page.screenshot({path:`${output}/${width}x${height}-${mode}-left.png`});await page.locator('#movement-side-toggle').click();assert.equal(await page.locator('#app').getAttribute('data-movement-side'),'right');
  });

  if(await page.locator('#app').getAttribute('data-movement-side')==='left')await page.locator('#movement-side-toggle').click();
 }
 // Test interaction only after every first-use layout has been recorded, so
 // dismissing the invitation never weakens the enlarged first-arrival cases.
 if(!process.env.ENLARGED_LAYOUT_ONLY)for(const[width,height]of[[320,568],[667,375]])for(const mode of ['normal','computed2x']){
  await page.setViewportSize({width,height});await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__universe?.getState().ready);await page.evaluate(()=>document.fonts.ready);await resizeText(mode);
  for(const side of ['right','left'])await checkNativeMotion(width,height,mode,side);
 }
 assert.equal(await page.evaluate(()=>captureAttempts),0);assert.deepEqual(errors,[]);
} catch(error){checks.push({name:'test flow',status:'failed',error:error.stack});process.exitCode=1;console.error(error);await page.screenshot({path:output+'/failure.png'}).catch(()=>{});}
finally{await writeFile(output+'/results.json',JSON.stringify({checks,errors,bundle,scope:'Actual app, ephemeral local authority, seeded synthetic data, Chromium touch and computed-font stress. No account creation, hosted writes, physical capture or physical-device certification.'},null,2));await context.close();await browser.close();await app.close();if(temporary)await rm(temporary,{recursive:true,force:true});}
