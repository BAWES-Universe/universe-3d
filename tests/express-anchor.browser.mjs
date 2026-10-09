/** Real Babylon rigs + DOM bubbles; no live accounts, network writes or fake projection. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {launch} from '../scripts/browser.mjs';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds} from '../src/worlds.js';
await mkdir('evidence',{recursive:true});
const bundle='evidence/express-anchor-harness.js';
await build({stdin:{resolveDir:process.cwd(),contents:`
import {createRenderer} from './src/renderer.js';
import {mountExpress} from './src/express.js';
import {normalizeAppearance} from './src/avatar-spec.js';
import {seedWorlds} from './src/worlds.js';
import {EngineStore} from '@babylonjs/core/Engines/engineStore.js';
import {Vector3} from '@babylonjs/core/Maths/math.vector.js';
const r=await createRenderer(document.querySelector('canvas'),document.querySelector('#labels'));
r.sync(seedWorlds[0].rooms[0].scene);
const state={ready:true,room:{id:'room'},user:{id:'actor',name:'Khalid'},position:{x:0,y:0,z:7},people:[],scene:{areas:[]}};
const express=mountExpress({root:document.querySelector('#express'),getState:()=>state,api:async()=>({thoughts:[]}),project:person=>r.avatarScreenPoint(person.id||person.userId),now:()=>1000});
let actor,serial=0;
function frame(dt=.016){r.render(dt);express.update();}
function emit(kind='say',text='Hi!'){express.onEvent({type:'expression',data:{roomId:'room',expression:{id:'bubble-'+(++serial),userId:'actor',author:actor,roomId:'room',kind,text,origin:{x:actor.x,z:actor.z}}}});}
function setup({height='average',hat='cap',hair='sweep',tilt=.45,distance=14,yaw=.8,y=0,seated=false,remote=false}={}){
 express.clear();const appearance=normalizeAppearance(0);Object.assign(appearance,{hat,hairStyle:hair});appearance.body.height=height;
 actor={id:'actor',name:'Khalid',x:0,y,z:7,appearance,self:!remote,seatId:seated?'seat':null,seatHeight:.4,grounded:!y};
 state.user={id:remote?'viewer':'actor',name:remote?'Viewer':'Khalid'};state.position={x:actor.x,y,z:actor.z};state.people=[actor];
 r.syncPeople([actor]);r.setTarget(0,7,y);r.resetCamera();const camera=r.getCameraState();r.rotate(yaw-camera.yaw);r.orbit(0,(tilt-camera.tilt)/.005);r.zoom(distance-camera.distance);r.setFollow(false);
 frame(.1);emit();frame();
}
function snapshot(){
 const scene=EngineStore.LastCreatedScene,head=scene.getMeshByName('avatar-actor-head-geometry');if(!head)return null;
 const box=head.getBoundingInfo().boundingBox,vertices=head.getVerticesData('position'),matrix=head.getWorldMatrix();let vertexTop=Infinity;
 for(let i=0;i<vertices.length;i+=3){const v=Vector3.TransformCoordinates(Vector3.FromArray(vertices,i),matrix);vertexTop=Math.min(vertexTop,r.screenPoint(v.x,v.z,v.y).y);}
 const boundsTop=Math.min(...box.vectorsWorld.map(v=>r.screenPoint(v.x,v.z,v.y).y));
 const label=document.querySelector('[data-entity="actor"]'),labelRect=label.getBoundingClientRect(),labelVisible=getComputedStyle(label).visibility==='visible';
 const headCenter=r.screenPoint(box.centerWorld.x,box.centerWorld.z,box.centerWorld.y),anchor=r.avatarScreenPoint('actor');
 return {anchor,headCenter,boundsTop,vertexTop,labelTop:labelRect.top,labelBottom:labelRect.bottom,labelVisible,body:r.getStats().presentation.actors[0],bubbles:[...document.querySelectorAll('.express-bubble')].map(node=>{const rect=node.getBoundingClientRect();return {id:node.dataset.expressionId,kind:node.classList.contains('express-bubble-think')?'think':node.classList.contains('express-bubble-emote')?'emote':'say',hidden:node.hidden,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom}})};
}
window.h={r,express,state,setup,frame,emit,snapshot,cacheCheck(){
 const mesh=EngineStore.LastCreatedScene.getMeshByName('avatar-actor-head-geometry'),original=mesh.getWorldMatrix;let calls=0;
 mesh.getWorldMatrix=function(...args){calls++;return original.apply(this,args)};
 r.rotate(.01);r.avatarScreenPoint('actor');const first=calls,start=performance.now();
 for(let i=0;i<500;i++)r.avatarScreenPoint('actor');const elapsed=performance.now()-start,after=calls;
 r.rotate(.01);r.avatarScreenPoint('actor');const next=calls;mesh.getWorldMatrix=original;
 return {first,after,next,elapsed,stats:r.getStats()};
},move(next){Object.assign(actor,next);r.syncPeople([actor]);state.position={x:actor.x,y:actor.y,z:actor.z};},actor:()=>actor};
setup();await r.ready;frame();window.ready=true;
`},bundle:true,format:'esm',minify:true,outfile:bundle});
const app=createGameServer({database:':memory:',seeds:seedWorlds,dist:new URL('../dist',import.meta.url).pathname}),{port}=await app.listen(0),browser=await launch();
const page=await browser.newPage({viewport:{width:1100,height:820},deviceScaleFactor:1}),errors=[],checks=[],samples=[];
page.on('pageerror',e=>errors.push(e.message));
const css=(await readFile('public/style.css','utf8'))+'\n'+await readFile('src/express.css','utf8');
await page.route('**/express-anchor-harness.js',async route=>route.fulfill({contentType:'text/javascript',body:await readFile(bundle)}));
await page.route('**/express-anchor',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\nhtml,body{margin:0;width:100%;height:100%;overflow:hidden}canvas{display:block;width:100%;height:100%}#labels,#express{position:absolute;inset:0;pointer-events:none}.express-bubble-card{animation:none!important}</style></head><body><canvas></canvas><div id="labels"></div><div id="express"></div><script type="module" src="/express-anchor-harness.js"></script></body></html>`}));
async function capture(path){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>{h.frame();requestAnimationFrame(resolve)})));await page.screenshot({path,timeout:60000});}
function check(name){checks.push(name);console.log('PASS',name);}
function assertAttached(sample,context){
 const bubble=sample.bubbles.at(-1);assert(!bubble.hidden,context+' is visible');
 const obstacle=Math.min(sample.vertexTop,sample.labelVisible?sample.labelTop:Infinity),visibleTop=Math.min(sample.vertexTop,sample.labelVisible?sample.labelTop:Infinity);
 assert(Math.abs(bubble.bottom+11-obstacle)<1,context+' has a fixed 6px tail clearance');
 assert(Math.abs((bubble.left+bubble.right)/2-sample.headCenter.x)<1,context+' follows rendered head horizontally');
 assert(visibleTop-bubble.bottom-5>=5,context+' clears actual geometry/nameplate');
 assert(visibleTop-bubble.bottom-5<7,context+' stays close to actual geometry/nameplate');
}
try{
 await page.goto(`http://127.0.0.1:${port}/express-anchor`);await page.waitForFunction(()=>window.ready,{},{timeout:60000});await page.emulateMedia({reducedMotion:'reduce'});
 console.log('Renderer ready');
 for(const appearance of [{height:'petite',hat:'none',hair:'bald'},{height:'average',hat:'cap',hair:'bun'},{height:'tall',hat:'beanie',hair:'spikes'}]){
  for(const tilt of [.015,.7,1.35])for(const distance of [6,14,58])for(const yaw of [0,1.3,3]){
   const config={...appearance,tilt,distance,yaw};const sample=await page.evaluate(config=>{h.setup(config);return h.snapshot()},config);assertAttached(sample,JSON.stringify(config));samples.push({config,...sample});if(samples.length%27===0)console.log('Verified',samples.length,'camera/appearance combinations');
  }
 }
 check('81 camera/appearance combinations keep Say tail near the rendered head and above the unchanged nameplate');
 for(const config of [{y:1.6},{height:'petite',seated:true},{height:'tall',hat:'beanie',y:1.2,seated:true},{remote:true,y:1.4}]){const sample=await page.evaluate(config=>{h.setup(config);return h.snapshot()},config);assertAttached(sample,JSON.stringify(config));}
 check('elevated, airborne, seated and remote avatars use their current rendered pose');
 await page.evaluate(()=>h.setup({tilt:.18,distance:8}));await capture('evidence/express-anchor-close.png');
 await page.evaluate(()=>h.setup({remote:true,tilt:.6,distance:12}));const before=await page.evaluate(()=>h.snapshot());
 const moving=await page.evaluate(()=>{h.move({x:4,y:1.2,z:8,moving:true,grounded:false});h.frame(.016);return {...h.snapshot(),raw:h.r.screenPoint(4,8,3.2)}});
 assertAttached(moving,'remote interpolation');assert(moving.body.x>0&&moving.body.x<4);assert(moving.body.y>0&&moving.body.y<1.2);assert(Math.abs(moving.anchor.x-moving.raw.x)>30);assert.notEqual(moving.anchor.x,before.anchor.x);
 check('remote bubbles track interpolated XYZ instead of jumping to the next network position');
 await page.evaluate(()=>{h.setup({tilt:.55,distance:12});h.emit('say','Second line');h.emit('think','Thinking');h.emit('emote','👋');h.frame()});
 const stacked=await page.evaluate(()=>h.snapshot());const visible=stacked.bubbles.filter(b=>!b.hidden).sort((a,b)=>a.top-b.top);
 for(let i=0;i<visible.length-1;i++){const tail=visible[i].kind==='think'?14:visible[i].kind==='say'?5:0;assert(visible[i].bottom+tail<=visible[i+1].top-8);}
 await capture('evidence/express-anchor-stacked.png');check('Say, Think and emote stacks leave room for their different tails');
 await page.evaluate(()=>{h.setup();document.querySelector('#labels').hidden=true;h.express.update()});const hiddenLabel=await page.evaluate(()=>h.snapshot());assert(Math.abs(hiddenLabel.bubbles[0].bottom+11-hiddenLabel.vertexTop)<1);check('a hidden nameplate reserves no empty screen gap');
 await page.evaluate(()=>{document.querySelector('#labels').hidden=false;h.r.setPresentationSuspended(true);h.express.update()});assert(await page.locator('.express-bubble').isHidden());await page.evaluate(()=>{h.r.setPresentationSuspended(false);h.frame()});assert(await page.locator('.express-bubble').isVisible());
 await page.evaluate(()=>{h.r.focusPoint(22,-15);h.r.zoom(-99);h.frame()});assert(await page.locator('.express-bubble').isHidden());
 await page.evaluate(()=>{h.setup();h.r.syncPeople([]);h.express.update()});assert(await page.locator('.express-bubble').isHidden());check('suspended, offscreen and removed rigs never leave stale visible bubbles');
 await page.evaluate(()=>h.setup());const cache=await page.evaluate(()=>h.cacheCheck());assert(cache.first>0);assert.equal(cache.after,cache.first);assert(cache.next>cache.after);assert(cache.stats.meshes<100&&cache.stats.drawCalls<150);check('stacked bubbles reuse one geometry projection per camera frame without adding renderer resources');
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(150);await page.evaluate(()=>h.setup({tilt:.015,distance:8,hat:'cap'}));assertAttached(await page.evaluate(()=>h.snapshot()),'portrait');await capture('evidence/express-anchor-mobile.png');
 await page.setViewportSize({width:844,height:390});await page.waitForTimeout(150);await page.evaluate(()=>h.setup({tilt:.7,distance:14,hat:'beanie',height:'tall'}));assertAttached(await page.evaluate(()=>h.snapshot()),'landscape');check('portrait and landscape resizing retain CSS-pixel attachment');
 assert.deepEqual(errors,[]);await writeFile('evidence/express-anchor-results.json',JSON.stringify({checks,errors,cache,samples},null,2));
}catch(error){await page.screenshot({path:'evidence/express-anchor-failure.png'}).catch(()=>{});await writeFile('evidence/express-anchor-results.json',JSON.stringify({checks,errors,failure:error.stack,samples},null,2));throw error;}
finally{await browser.close();await app.close();await rm(bundle,{force:true});}
