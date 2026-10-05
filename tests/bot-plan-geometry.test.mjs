import test from 'node:test';
import assert from 'node:assert/strict';
import {createBotPlanGeometry} from '../src/bot-plan-geometry.js';
for (const angle of [0,Math.PI/4,Math.PI/2,Math.PI,3*Math.PI/2,-Math.PI/4]) test(`resident plan agrees with camera right/up and round-trips at ${angle}`,()=>{
 const g=createBotPlanGeometry({angle}),origin=g.project({x:0,z:0});
 for(const world of [{x:3,z:-2},{x:-10,z:8},{x:0,z:0}]){const back=g.unproject(g.project(world));assert.ok(Math.abs(back.x-world.x)<1e-9);assert.ok(Math.abs(back.z-world.z)<1e-9);}
 const right=g.project(g.delta(1,0)),up=g.project(g.delta(0,-1));
 assert.ok(right.x>origin.x);assert.ok(Math.abs(right.y-origin.y)<1e-9);assert.ok(up.y<origin.y);assert.ok(Math.abs(up.x-origin.x)<1e-9);
 for(const corner of g.rectangle({width:32,depth:26})){assert.ok(corner.x>=21.999&&corner.x<=338.001);assert.ok(corner.y>=21.999&&corner.y<=198.001);}
});
test('default camera top-right maps toward negative X, never its old inverted direction',()=>{const g=createBotPlanGeometry(),p=g.unproject({x:200,y:90});assert.ok(p.x<0);assert.ok(Math.abs(p.z)<1e-9);});
