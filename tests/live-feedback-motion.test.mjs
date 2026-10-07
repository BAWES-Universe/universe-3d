import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyScene,canStand,movePlayer,collisionBox,objectTop,seatExit} from '../src/worlds.js';
import {createMotion,advanceMotion,jumpMotion,sitMotion,standMotion,GRAVITY,JUMP_SPEED} from '../src/motion.js';
import {createCameraRig} from '../src/camera-rig.js';
import {resolveAvatarMotion} from '../src/avatar-motion.js';
import {readPresenceMotion} from '../server/presence-motion.mjs';
import {NullEngine} from '@babylonjs/core/Engines/nullEngine.js';
import {Scene} from '@babylonjs/core/scene.js';
import {createAvatarRig} from '../src/avatar-rig.js';
const platform={id:'platform',type:'table',x:0,z:0,width:3,depth:3};
const room=(objects=[])=>({...emptyScene(),objects});
const step=(m,s,n=60,input={x:0,z:0},dt=1/60)=>{for(let i=0;i<n;i++)advanceMotion(m,s,{input,angle:Math.PI/2},dt);};

test('solid platform is blocking; decorative rug and portal are walkable',()=>{
 const s=room([platform]);assert.equal(canStand(s,0,0),false);assert(movePlayer(s,{x:0,z:3},0,-6).z>1.79);
 assert.equal(canStand(room([{...platform,type:'rug'},{id:'portal',type:'portal',x:0,z:0}]),0,0),true);
});
test('arbitrary rotation collision covers the visible footprint without 90-degree rounding gaps',()=>{
 const box=collisionBox({type:'wall',x:0,z:0,width:5,depth:.3,rotation:45});assert(box.width>3.7);assert(box.depth>3.7);assert.equal(canStand(room([{type:'wall',x:0,z:0,width:5,depth:.3,rotation:45}]),1.5,1.5),false);
});
test('Space impulse has frame-independent gravity, airborne height, and ground landing',()=>{
 const heights=[];for(const fps of [10,20,30,60,120]){const m=createMotion({x:0,z:0}),s=room();assert(jumpMotion(m,s));step(m,s,fps*.3,undefined,1/fps);heights.push(m.position.y);assert(!m.grounded);assert(!jumpMotion(m,s));step(m,s,fps,undefined,1/fps);assert.equal(m.position.y,0);assert(m.grounded);assert.equal(m.verticalVelocity,0);}
 assert(Math.max(...heights)-Math.min(...heights)<1e-10);assert(Math.abs(heights[0]-(JUMP_SPEED*.3-GRAVITY*.3*.3/2))<1e-10);
});
test('jump clears a low platform side and lands on its real top, then stepping off falls',()=>{
 const s=room([platform]),m=createMotion({x:0,z:2});assert(jumpMotion(m,s));step(m,s,23,{x:0,z:-1});assert(m.position.z<1.5);step(m,s,60);assert.equal(m.position.y,1.01);assert(m.grounded);assert(canStand(s,m.position.x,m.position.z)===false,'avatar really occupies the platform top, not a ground-only visual bounce');step(m,s,65,{x:0,z:-1});step(m,s,60);assert.equal(m.position.y,0);assert(m.position.z<-1.8);
});
test('jump cannot pass through a taller solid or bypass blocked terrain',()=>{
 for(const s of [room([{...platform,type:'wall'}]),{...room(),terrain:{version:1,cells:[[-1,0,'stone',true],[0,0,'stone',true],[1,0,'stone',true]]}}]){const m=createMotion({x:0,z:2});jumpMotion(m,s);step(m,s,60,{x:0,z:-1});assert(m.position.z>=(s.terrain?1.3:1.8)-.04);}
});
test('removed platform drops an avatar and cannot supply a midair jump',()=>{
 const m=createMotion({x:0,y:1.01,z:0}),s=room([platform]);step(m,s,1);assert(m.grounded);s.objects=[];assert(!jumpMotion(m,s));step(m,s,60);assert.equal(m.position.y,0);
});
test('sitting pins a real chair pose; movement or jump exits into clear floor',()=>{
 const chair={id:'chair',type:'chair',x:0,z:0,rotation:90},s=room([chair]),m=createMotion({x:0,z:1});assert(sitMotion(m,s,chair));assert.equal(m.seatId,'chair');assert.equal(m.heading,-Math.PI/2);step(m,s);assert.equal(m.position.z,0);assert.equal(m.position.x,0);assert.equal(m.seatHeight,.61);assert(jumpMotion(m,s));assert.equal(m.seatId,null);assert(canStand(s,m.position.x,m.position.z));assert(!m.grounded);
});
test('a fully obstructed chair exit does not teleport through nearby walls',()=>{
 const chair={id:'chair',type:'chair',x:0,z:0};const s=room([chair,...[[0,1],[0,-1],[1,0],[-1,0]].map(([x,z],i)=>({id:'b'+i,type:'wall',x,z,width:1,depth:1}))]);assert.equal(seatExit(s,chair),null);const m=createMotion({x:0,z:0});m.seatId='chair';assert.equal(standMotion(m,s),false);assert.equal(m.seatId,'chair');
});
test('camera reaches near eye-level front framing and close zoom without unstable pan',()=>{
 const r=createCameraRig();r.orbit(0,-10000);r.zoom(-10000);const p=r.getPosition();assert(p.y<.7);assert.equal(r.getState().distance,6);r.pan(10,10);assert(Number.isFinite(r.getState().target.x));r.setTarget(2,2,1.5);r.setFollow(true);r.step(5);assert(r.getPosition().y>2);
});
test('remote presence resolves fresh waves, seated and airborne poses while old waves expire',()=>{
 assert(resolveAvatarMotion({emote:'👋',emoteAt:Date.now()}).waving);assert(!resolveAvatarMotion({emote:'👋',emoteAt:Date.now()-6000}).waving);assert(resolveAvatarMotion({grounded:false}).airborne);const sitting=resolveAvatarMotion({seatId:'chair',seatHeight:.61,moving:true,velocity:{x:4,z:0}});assert(sitting.seated);assert(!sitting.moving);assert.deepEqual(sitting.velocity,{x:0,z:0});
});
test('seated legs and wave arm have actual rig articulation; ordinary pose resets them',()=>{
 const engine=new NullEngine(),scene=new Scene(engine),rig=createAvatarRig(scene,0);const joint=name=>rig.root.getChildTransformNodes(false).find(n=>n.name.endsWith(name));rig.update({seated:true,seatHeight:.61,waving:true,dt:1/60});assert.equal(joint('left-leg').rotation.x,-Math.PI/2);assert.equal(joint('left-shin').rotation.x,Math.PI/2);assert(joint('right-arm').rotation.z>2);rig.update({dt:1/60});assert(Math.abs(joint('left-leg').rotation.x)<.001);assert(joint('right-arm').rotation.z>0);rig.dispose();engine.dispose();
});
test('server bounds vertical fields and canonicalizes only nearby unoccupied valid seats',()=>{
 const chair={id:'chair',type:'chair',x:0,z:0},context={scene:room([chair]),previous:{x:0,z:1},presence:new Map(),userId:'one',roomId:'room',now:10000};
 assert.deepEqual(readPresenceMotion({y:1.5,verticalVelocity:-2,grounded:false},context),{y:1.5,verticalVelocity:-2,grounded:false});
 for(const bad of [{y:-1},{y:NaN},{y:513},{verticalVelocity:30},{grounded:1},{seatId:'missing'}])assert.throws(()=>readPresenceMotion(bad,context));
 const fields=readPresenceMotion({seatId:'chair',x:900,y:5,moving:true},context);assert.equal(fields.x,0);assert.equal(fields.y,0);assert.equal(fields.moving,false);assert.equal(fields.seatHeight,.61);
 assert.throws(()=>readPresenceMotion({seatId:'chair'},{...context,previous:{x:10,z:0}}),{code:'SEAT_OUT_OF_REACH'});
 assert.throws(()=>readPresenceMotion({seatId:'chair'},{...context,presence:new Map([['other',{userId:'two',roomId:'room',seatId:'chair',lastSeen:9999}]])}),{code:'SEAT_OCCUPIED'});
 assert.deepEqual(readPresenceMotion({seatId:null},context),{seatId:null,seatHeight:0});
});

test('sitting cannot teleport through an intervening solid wall',()=>{
 const chair={id:'chair',type:'chair',x:0,z:0},scene=room([chair,{id:'wall',type:'wall',x:0,z:.7,width:3,depth:.3}]),m=createMotion({x:0,z:1.8});assert.equal(sitMotion(m,scene,chair),false);
 assert.throws(()=>readPresenceMotion({seatId:'chair'},{scene,previous:m.position,presence:new Map(),userId:'one',roomId:'room',now:10000}),{code:'SEAT_OUT_OF_REACH'});
});

test('moving or removing an occupied chair releases the seat without teleporting the person',()=>{
 const chair={id:'chair',type:'chair',x:0,z:0},s=room([chair]),m=createMotion({x:0,z:1});assert(sitMotion(m,s,chair));chair.x=8;step(m,s,1);assert.equal(m.seatId,null);assert.equal(m.position.x,0);assert.equal(m.position.z,0);
});
