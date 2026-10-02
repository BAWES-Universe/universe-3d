import {movePlayer,pathDirection} from './worlds.js';
// Live Universe defaults: WOKA_SPEED=9, inputStep uses20 pixels/s per unit.
// The standalone scene uses32 source pixels per world unit (roughly a metre).
export const WALK_SPEED=180/32;
export const FAST_WALK_MULTIPLIER=2.5;
const ACCELERATION=45, BRAKING=65, STEP=1/120;
export function createMotion(position){return {position:{...position},velocity:{x:0,z:0},direction:0,heading:0,moving:false,running:false};}
export function stopMotion(motion){motion.velocity={x:0,z:0};motion.moving=false;motion.running=false;}
export function screenDirection(input,angle){let x=input.x||0,z=input.z||0;const length=Math.hypot(x,z);if(length>.00001&&length>1){x/=length;z/=length;}return {x:-Math.sin(angle)*x+Math.cos(angle)*z,z:Math.cos(angle)*x+Math.sin(angle)*z};}
export function advanceMotion(motion,scene,{input={x:0,z:0},angle=Math.PI/4,fast=false,path=[]},elapsed){
 const dt=Math.max(0,Math.min(.25,Number.isFinite(elapsed)?elapsed:0));const manual=Math.hypot(input.x||0,input.z||0)>.065;if(manual)path.length=0;
 const count=Math.max(1,Math.ceil(dt/STEP)),h=dt/count;let travelled=0;
 for(let i=0;i<count;i++){
  const direction=manual?screenDirection(input,angle):pathDirection(motion.position,path),active=Math.hypot(direction.x,direction.z)>.001;
  const speed=WALK_SPEED*(manual&&fast?FAST_WALK_MULTIPLIER:1),target={x:direction.x*speed,z:direction.z*speed};
  const rate=active?ACCELERATION:BRAKING,decay=Math.exp(-rate*h),old=motion.velocity;
  const displacement={x:target.x*h+(old.x-target.x)*(1-decay)/rate,z:target.z*h+(old.z-target.z)*(1-decay)/rate};
  const nextVelocity={x:target.x+(old.x-target.x)*decay,z:target.z+(old.z-target.z)*decay};
  const before=motion.position,after=movePlayer(scene,before,displacement.x,displacement.z);const dx=after.x-before.x,dz=after.z-before.z;
  if(Math.abs(dx-displacement.x)>.00001)nextVelocity.x=0;if(Math.abs(dz-displacement.z)>.00001)nextVelocity.z=0;
  motion.position=after;motion.velocity=nextVelocity;travelled+=Math.hypot(dx,dz);
  if(Math.hypot(dx,dz)>.00005){motion.heading=Math.atan2(dx,dz);motion.direction=Math.abs(dx)>Math.abs(dz)?dx>0?2:1:dz>0?0:3;}
  if(!manual&&path.length&&active&&Math.hypot(dx,dz)<.000001){path.length=0;stopMotion(motion);}
 }
 motion.moving=travelled>.0001;motion.running=motion.moving&&manual&&fast;if(!motion.moving&&Math.hypot(motion.velocity.x,motion.velocity.z)<.01)stopMotion(motion);
 return {manual,moving:motion.moving,running:motion.running,travelled,elapsed:dt};
}
