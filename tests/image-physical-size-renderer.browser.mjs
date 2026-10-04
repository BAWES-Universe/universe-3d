/** Renderer integration check; requires the physical-size world/editor adapter.
 * Uses the actual renderer and PNG loader; EngineStore is read-only diagnostics. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
import {launch} from '../scripts/browser.mjs';
import {renderFixture} from './image-asset-renderer-fixtures.mjs';
const out='evidence/image-physical-size-renderer';await mkdir(out,{recursive:true});
const fixture=renderFixture({width:1024,height:1024,metadata:{depthPreset:'floor',widthMetres:2,heightMetres:2},pixel:()=>[245,35,225,255]});
const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`
import {EngineStore} from '@babylonjs/core/Engines/engineStore.js';
import {createRenderer} from './src/renderer.js';
import {emptyScene,dimensions} from './src/worlds.js';
import {bindImageDefinitions,imageGeometry} from './src/image-asset-context.js';
const entry=${JSON.stringify(fixture.resolved)},item=${JSON.stringify(fixture.instance)};
const world=emptyScene();bindImageDefinitions(world,{'a1:v1':entry},'r1');
const r=await createRenderer(document.querySelector('canvas'),document.querySelector('#labels'));
r.setImageContext({roomId:'r1',roomEpoch:1,authorityEpoch:1,canRead:true});r.sync(world);r.setBuild(true);r.setFollow(false);r.setTarget(0,0);
window.setGhost=(valid,rotation=0)=>{r.setGhost({...item,valid,rotation});};
window.snapshot=()=>{const scene=EngineStore.LastCreatedScene,plane=scene.getMeshByName('image-plane-image-preview');for(const mesh of scene.meshes)mesh.computeWorldMatrix(true);const bounds=mesh=>{const box=mesh.getBoundingInfo().boundingBox;return {min:box.minimumWorld.asArray(),max:box.maximumWorld.asArray()};};return{dimensions:dimensions(item,world),geometry:imageGeometry(world,item).editBounds,plane:plane?{enabled:plane.isEnabled(),pickable:plane.isPickable,texture:plane.material.diffuseTexture?.isReady(),...bounds(plane)}:null,edges:scene.meshes.filter(m=>m.name==='preview-edge').map(m=>({...bounds(m),position:m.getAbsolutePosition().asArray(),color:m.material.diffuseColor.asArray(),pickable:m.isPickable})),outline:scene.meshes.filter(m=>m.name==='image-footprint').map(bounds)};};
window.pixel=(x,z,y=.05)=>{r.render(.016);const canvas=document.querySelector('canvas'),copy=document.createElement('canvas');copy.width=canvas.width;copy.height=canvas.height;const context=copy.getContext('2d');context.drawImage(canvas,0,0);const point=r.screenPoint(x,z,y);return [...context.getImageData(point.x*canvas.width/canvas.clientWidth,point.y*canvas.height/canvas.clientHeight,1,1).data];};
let last=0;function frame(t){r.render(Math.min(.05,(t-last)/1000||.016));last=t;requestAnimationFrame(frame);}requestAnimationFrame(frame);await r.ready;window.ready=true;
`},bundle:true,format:'esm',write:false});
const browser=await launch(),page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));
await page.route('https://image-render.test/**',route=>{const path=new URL(route.request().url()).pathname;if(path.endsWith('/image'))return route.fulfill({contentType:'image/png',body:fixture.bytes});if(path==='/harness.js')return route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text});return route.fulfill({contentType:'text/html',body:'<style>body{margin:0}canvas{width:100vw;height:100vh;display:block}#labels{position:absolute;inset:0;pointer-events:none}</style><canvas></canvas><div id="labels"></div><script type="module" src="/harness.js"></script>'});});
const close=(actual,expected)=>assert(Math.abs(actual-expected)<.0001,`${actual} ~= ${expected}`);
try{
 await page.goto('https://image-render.test/');await page.waitForFunction(()=>window.ready);
 for(const valid of [true,false])for(const rotation of [0,90]){
  await page.evaluate(([valid,rotation])=>setGhost(valid,rotation),[valid,rotation]);
  await page.waitForFunction(()=>snapshot().plane?.texture&&snapshot().plane.enabled);
  const value=await page.evaluate(()=>snapshot());assert.deepEqual(value.dimensions,{width:2,depth:2});assert.equal(value.geometry.width,2);assert.equal(value.geometry.depth,2);assert.equal(value.edges.length,4);
  close(value.plane.max[0]-value.plane.min[0],2);close(value.plane.max[2]-value.plane.min[2],2);assert.equal(value.plane.pickable,false);
  for(const edge of value.edges){assert.equal(edge.pickable,false);close(Math.max(Math.abs(edge.position[0]),Math.abs(edge.position[2])),1);close(Math.min(Math.abs(edge.position[0]),Math.abs(edge.position[2])),0);assert(Math.max(edge.max[0]-edge.min[0],edge.max[2]-edge.min[2])<2.061);const target=valid?[115/255,237/255,170/255]:[1,104/255,124/255];edge.color.forEach((color,index)=>close(color,target[index]));}
  assert.equal(value.outline.length,1);close(value.outline[0].max[0]-value.outline[0].min[0],2);close(value.outline[0].max[2]-value.outline[0].min[2],2);
  const center=await page.evaluate(()=>pixel(0,0));assert(center[0]>150&&center[2]>120&&center[1]<130,'actual ghost texture pixels are visible');
  await page.screenshot({path:`${out}/${valid?'valid':'blocked'}-${rotation}.png`});checks.push({valid,rotation,center,...value});
 }
 assert.deepEqual(errors,[]);console.log('PASS 1024px at 2m: textured ghost, authoritative extent, 2m outline and auxiliary valid/blocked borders agree at 0 and 90 degrees');
}catch(error){console.error(error);process.exitCode=1;checks.push({failure:error.stack});}
finally{await writeFile(out+'/results.json',JSON.stringify({checks,errors,limits:['Renderer module from the current checkout with the physical-size world/editor adapter; complete-game evidence is separate','Software WebGL Chromium module harness; actual-game native inspector evidence is separate']},null,2));await browser.close();}
