/** Same real renderer, deterministic scenes/cameras. No screenshot-only effects. */
import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {launch} from '../scripts/browser.mjs';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds,emptyScene} from '../src/worlds.js';
const lifecycleOnly=process.env.WORLD_LIFECYCLE_ONLY==='1';
const phase=process.env.WORLD_PHASE||'after',out=`evidence/world-presentation-${phase}`;
await mkdir(out,{recursive:true});
const sparse={...emptyScene(),bounds:{width:18,depth:16},spawn:{x:0,z:5},objects:[{id:'chair',type:'chair',x:-2,z:0,rotation:0},{id:'tree',type:'tree',x:5,z:-3,rotation:0},{id:'bench',type:'bench',x:2,z:2,rotation:0}],terrain:{version:1,cells:[]}};
for(let z=-5;z<2;z++)for(let x=-5;x<4;x++)sparse.terrain.cells.push([x,z,x>=0?'water':x===-1?'stone':'wood',x>=0]);
const crowded=structuredClone(seedWorlds[0].rooms[0].scene);
for(let z=2;z<=8;z+=2)for(let x=-7;x<=7;x+=2)crowded.objects.push({id:`crowd-${x}-${z}`,type:(x+z)%3===0?'plant':'chair',x,z,rotation:90});
const scenes={commons:seedWorlds[0].rooms[0].scene,sparse,crowded,studio:seedWorlds[0].rooms[1].scene};
await build({stdin:{resolveDir:process.env.WORLD_SOURCE_ROOT||process.cwd(),contents:`import{EngineStore}from'@babylonjs/core/Engines/engineStore.js';import{createRenderer}from'./src/renderer.js';window.make=async()=>{window.r=await createRenderer(document.querySelector('canvas'),document.querySelector('#labels'));};await make();window.configure=async world=>{r.sync(world);r.syncPeople([{id:'self',name:'World explorer',woka:0,x:0,z:5,self:true}]);r.resetCamera();r.setFollow(false);r.focusPoint(0,1);await EngineStore.LastCreatedScene.whenReadyAsync();r.render(1/60);};window.resources=()=>{const s=EngineStore.LastCreatedScene;return{meshes:s.meshes.length,nodes:s.transformNodes.length,materials:s.materials.length,textures:s.textures.length,geometries:s.geometries.length,vertices:s.meshes.reduce((n,m)=>n+m.getTotalVertices(),0)};};window.engineCount=()=>EngineStore.Instances.length;window.details=()=>{const s=EngineStore.LastCreatedScene;return{water:s.materials.filter(m=>m.name.startsWith('water')).map(m=>({u:m.diffuseTexture.uOffset,v:m.diffuseTexture.vOffset})),selection:s.getTransformNodeByName('selection-frame')?.getChildMeshes().map(m=>({name:m.name,pickable:m.isPickable,group:m.renderingGroupId,vertices:m.getTotalVertices()}))};};window.measure=async()=>{const frames=[],cpu=[],draws=[];for(let i=0;i<12;i++){await new Promise(requestAnimationFrame);r.render(1/60);}let previous;for(let i=0;i<90;i++){const t=await new Promise(requestAnimationFrame);if(previous!==undefined)frames.push(t-previous);previous=t;const start=performance.now();r.render(1/60);cpu.push(performance.now()-start);draws.push(r.getStats().drawCalls);}return{frames,cpu,draws,resources:resources(),stats:r.getStats()};};window.ready=true;`},bundle:true,format:'esm',minify:true,outfile:out+'/harness.js'});
const app=createGameServer({seeds:seedWorlds,dist:process.env.WORLD_DIST||new URL('../dist',import.meta.url).pathname}),{port}=await app.listen(0),browser=await launch();
const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1,reducedMotion:'reduce'});page.setDefaultTimeout(60000);
const errors=[],results=lifecycleOnly?JSON.parse(await readFile(out+'/results.json','utf8')):{phase,environment:'Chromium / ANGLE SwiftShader software WebGL; emulation only',scenes:{},checks:[],errors};delete results.failure;results.errors=errors;page.on('pageerror',e=>errors.push(e.message));
const summarize=a=>{a=[...a].sort((a,b)=>a-b);return{n:a.length,p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],max:a.at(-1)};};
try{
 // Play the actual application before opening the controlled renderer fixture.
 await page.goto(`http://127.0.0.1:${port}`);await page.getByPlaceholder('Your name').fill('Presentation explorer');await page.getByRole('button',{name:'Enter Universe'}).click();await page.waitForFunction(()=>window.__universe?.getState().ready);
 if(await page.getByRole('button',{name:'Not now',exact:true}).isVisible())await page.getByRole('button',{name:'Not now',exact:true}).click();
 await page.waitForTimeout(1200);await page.screenshot({path:out+'/actual-game.png'});
 await page.locator('#game').focus();await page.keyboard.down('d');await page.waitForTimeout(350);await page.keyboard.up('d');await page.keyboard.press('Home');
 await page.locator('#dock-build').click();await page.waitForTimeout(250);await page.screenshot({path:out+'/actual-build.png'});results.checks.push('Actual game joins, renders, accepts movement and opens Build');
 await page.route('**/world-presentation-harness.js',async route=>route.fulfill({contentType:'text/javascript',body:await readFile(out+'/harness.js')}));
 await page.route('**/world-presentation-harness',route=>route.fulfill({contentType:'text/html',body:'<html><head><link rel="stylesheet" href="/style.css"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}canvas{width:100%;height:100%;display:block}#labels{position:absolute;inset:0;pointer-events:none}</style></head><body><canvas></canvas><div id="labels"></div><script type="module" src="/world-presentation-harness.js"></script></body></html>'}));
 await page.goto(`http://127.0.0.1:${port}/world-presentation-harness`);await page.waitForFunction(()=>window.ready);
 results.gpu=await page.evaluate(()=>{const gl=document.querySelector('canvas').getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);});
 for(const [name,scene]of Object.entries(lifecycleOnly?{}:scenes)){
  await page.evaluate(w=>configure(w),scene);const data=await page.evaluate(()=>measure());await page.screenshot({path:out+'/'+name+'.png'});
  results.scenes[name]={...data,frameSummary:summarize(data.frames),cpuSummary:summarize(data.cpu),drawSummary:summarize(data.draws)};console.log(phase,name,JSON.stringify({frames:results.scenes[name].frameSummary,draws:results.scenes[name].drawSummary,resources:data.resources}));
 }
 await page.evaluate(w=>configure(w),sparse);await page.evaluate(()=>{r.setBuild(true);r.select('chair');r.render(.016);});await page.screenshot({path:out+'/selection.png'});
 await page.evaluate(w=>configure(w),crowded);await page.evaluate(w=>configure(w),sparse);await page.evaluate(()=>{r.setBuild(true);r.select('chair');r.render(.016);});const before=await page.evaluate(()=>resources());for(let i=0;i<6;i++){await page.evaluate(w=>configure(w),crowded);await page.evaluate(w=>configure(w),sparse);await page.evaluate(()=>{r.setBuild(true);r.select('chair');r.render(.016);});}const after=await page.evaluate(()=>resources());assert.deepEqual(after,before);results.switches={cycles:6,before,after};results.checks.push('Six crowded/sparse round trips retain identical resources');
 await page.setViewportSize({width:390,height:844});await page.evaluate(w=>configure(w),sparse);await page.evaluate(()=>{r.setBuild(true);r.select('chair');r.render(.016);});await page.screenshot({path:out+'/narrow.png'});
 results.checks.push('Narrow portrait rendered');
 if(phase==='after'){
  const selection=await page.evaluate(()=>details().selection);assert.equal(selection.length,3);assert(selection.every(m=>!m.pickable&&m.group===0));results.checks.push('Selection uses exactly three non-pickable depth-tested meshes');
  const a=await page.evaluate(()=>details());await page.evaluate(()=>{for(let i=0;i<60;i++)r.render(.05);});const b=await page.evaluate(()=>details());assert.deepEqual(b.water,a.water);results.checks.push('Reduced motion holds water texture stationary');
  await page.emulateMedia({reducedMotion:'no-preference'});await page.evaluate(()=>r.setBuild(false));const c=await page.evaluate(()=>details());await page.evaluate(()=>r.render(.05));const d=await page.evaluate(()=>details());assert.notDeepEqual(c.water,d.water);results.checks.push('Normal motion water animates');
  await page.evaluate(()=>r.setBuild(true));const e=await page.evaluate(()=>details());await page.evaluate(()=>r.render(.05));const f=await page.evaluate(()=>details());assert.deepEqual(e.water,f.water);results.checks.push('Build freezes decorative water motion');
 }
 results.disposal=await page.evaluate(()=>{r.dispose();const state={engines:engineCount(),labels:document.querySelector('#labels').children.length};document.querySelector('#labels').replaceChildren();return state;});assert.equal(results.disposal.engines,0);if(phase==='after')assert.equal(results.disposal.labels,0);await page.evaluate(()=>make());await page.evaluate(w=>configure(w),sparse);results.reopen=await page.evaluate(()=>resources());results.checks.push('Renderer disposes and reopens without runtime error');assert.deepEqual(errors,[]);
}catch(e){results.failure=e.stack;console.error(e);process.exitCode=1;await page.screenshot({path:out+'/failure.png'}).catch(()=>{});}finally{await writeFile(out+'/results.json',JSON.stringify(results,null,2));await browser.close();await app.close();}
