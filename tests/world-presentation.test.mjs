import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorldPresentation} from '../src/world-presentation.js';

test('normal frames pass bounded visual delta without changing the application clock',()=>{
 const gate=createWorldPresentation();
 assert.deepEqual(gate.nextFrame(.016,.02),{resumed:false,dt:.016,actualDt:.02});
 assert.deepEqual(gate.nextFrame(8,8),{resumed:false,dt:.1,actualDt:8});
 assert.equal(gate.isSuppressed(),false);
});
test('creator presentation suppresses every world draw attempt while callers keep ticking',()=>{
 const gate=createWorldPresentation();gate.setSuspended(true);
 let applicationTicks=0,presenceTicks=0,creatorTicks=0,draws=0;
 for(let i=0;i<600;i++){
  applicationTicks++;creatorTicks++;if(i%60===0)presenceTicks++;
  if(gate.nextFrame(1/60))draws++;
 }
 assert.equal(applicationTicks,600);assert.equal(creatorTicks,600);assert.equal(presenceTicks,10);assert.equal(draws,0);
 assert.equal(gate.snapshot().skippedFrames,600);assert.equal(gate.isSuppressed(),true);
});
test('resume never replays hidden time, requests authoritative positions exactly once',()=>{
 const gate=createWorldPresentation();gate.nextFrame(.016);gate.setSuspended(true);
 for(let i=0;i<500;i++)gate.nextFrame(.1,2);
 gate.setSuspended(false);assert.equal(gate.isSuppressed(),true,'projected overlays stay hidden until the first current frame');
 assert.deepEqual(gate.nextFrame(500,500),{resumed:true,dt:0,actualDt:0});
 assert.equal(gate.isSuppressed(),false);
 assert.deepEqual(gate.nextFrame(.016),{resumed:false,dt:.016,actualDt:.016});
});
test('idempotent toggles and close/reopen before a world frame retain one pending resume',()=>{
 const gate=createWorldPresentation();assert.equal(gate.setSuspended(false),false);
 assert.equal(gate.setSuspended(true),true);assert.equal(gate.setSuspended(true),false);
 gate.setSuspended(false);gate.setSuspended(true);assert.equal(gate.nextFrame(4),null);
 gate.setSuspended(false);assert.equal(gate.nextFrame(4).resumed,true);
 assert.equal(gate.nextFrame(.016).resumed,false);assert.equal(gate.snapshot().resumeCount,2);
});
test('invalid deltas cannot poison resumed animation and snapshots are read-only copies',()=>{
 const gate=createWorldPresentation();
 for(const dt of [NaN,Infinity,-2,undefined])assert.equal(gate.nextFrame(dt).dt,0);
 const stats=gate.snapshot();stats.suspended=true;stats.skippedFrames=1e8;
 assert.equal(gate.snapshot().suspended,false);assert.equal(gate.snapshot().skippedFrames,0);
});
