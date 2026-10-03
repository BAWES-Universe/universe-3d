import test from 'node:test';
import assert from 'node:assert/strict';
import {renderHardwareScale,resizeRenderBuffer,WORLD_RENDER_PIXELS,PREVIEW_RENDER_PIXELS} from '../src/render-resolution.js';

test('CSS resolution is the baseline; larger world and preview buffers have explicit pixel caps',()=>{
 for(const [width,height,budget,expected] of [
  [320,568,WORLD_RENDER_PIXELS,1],[1280,800,WORLD_RENDER_PIXELS,1],
  [1920,1080,WORLD_RENDER_PIXELS,1],[3840,2160,WORLD_RENDER_PIXELS,2],
  [320,210,PREVIEW_RENDER_PIXELS,1],[1024,1024,PREVIEW_RENDER_PIXELS,2],
 ]){
  const scale=renderHardwareScale(width,height,budget);
  assert.equal(scale,expected);
  assert(Math.floor(width/scale)*Math.floor(height/scale)<=budget);
 }
 for(const [width,height] of [[0,0],[0,600],[2161,3841],[1440,3200],[6000,1800]]){
  const scale=renderHardwareScale(width,height,WORLD_RENDER_PIXELS);
  assert(Number.isFinite(scale)&&scale>=1);
  assert(Math.floor(width/scale)*Math.floor(height/scale)<=WORLD_RENDER_PIXELS);
 }
});

test('resizing applies one resize, and restores CSS resolution after leaving the cap',()=>{
 const calls=[],canvas={clientWidth:3840,clientHeight:2160};let current=1;
 const engine={getHardwareScalingLevel:()=>current,setHardwareScalingLevel:value=>{current=value;calls.push(['scale-and-resize',value]);},resize:()=>calls.push(['resize'])};
 resizeRenderBuffer(engine,canvas,WORLD_RENDER_PIXELS);
 canvas.clientWidth=320;canvas.clientHeight=568;resizeRenderBuffer(engine,canvas,WORLD_RENDER_PIXELS);
 canvas.clientHeight=600;resizeRenderBuffer(engine,canvas,WORLD_RENDER_PIXELS);
 assert.deepEqual(calls,[['scale-and-resize',2],['scale-and-resize',1],['resize']]);
});
