import {movePlayer,pathDirection,supportHeight,seatPose,seatExit,canReachSeat} from './worlds.js';
// Live Universe defaults: WOKA_SPEED=9, inputStep uses20 pixels/s per unit.
// The standalone scene uses32 source pixels per world unit (roughly a metre).
export const WALK_SPEED=180/32;
export const FAST_WALK_MULTIPLIER=2.5;
export const GRAVITY=22, JUMP_SPEED=8.5;
const ACCELERATION=45, BRAKING=65, STEP=1/120;
export function createMotion(position){return {position:{...position,y:position.y??0},velocity:{x:0,z:0},verticalVelocity:0,grounded:(position.y??0)===0,seatId:null,seatHeight:0,direction:0,heading:0,moving:false,running:false};}
export function stopMotion(motion){motion.velocity={x:0,z:0};motion.moving=false;motion.running=false;}
export function standMotion(motion,scene){
 if(!motion.seatId)return true;const object=scene.objects.find(item=>item.id===motion.seatId),samePosition=object&&Math.hypot(motion.position.x-object.x,motion.position.z-object.z)<.01,exit=samePosition&&seatExit(scene,object);if(samePosition&&!exit)return false;
 if(exit)motion.position=exit;motion.seatId=null;motion.seatHeight=0;motion.grounded=true;motion.verticalVelocity=0;stopMotion(motion);return true;
}
export function sitMotion(motion,scene,object){
 const pose=seatPose(scene,object);if(!pose||!motion.grounded||!canReachSeat(scene,motion.position,object))return false;
 stopMotion(motion);motion.position={x:pose.x,y:0,z:pose.z};motion.heading=pose.heading;motion.seatId=pose.seatId;motion.seatHeight=pose.seatHeight;motion.verticalVelocity=0;motion.grounded=true;return true;
}
export function jumpMotion(motion,scene){
 if(!standMotion(motion,scene)||!motion.grounded)return false;
 // A removed platform cannot be used to jump in midair.
 if(Math.abs((motion.position.y??0)-supportHeight(scene,motion.position.x,motion.position.z,motion.position.y??0))>.001)return false;
 motion.verticalVelocity=JUMP_SPEED;motion.grounded=false;return true;
}
export function advanceVertical(motion,scene,elapsed){
 if(motion.seatId){const object=scene.objects.find(item=>item.id===motion.seatId),pose=seatPose(scene,object);if(pose&&Math.hypot(motion.position.x-pose.x,motion.position.z-pose.z)<.01){motion.position={x:pose.x,y:0,z:pose.z};motion.heading=pose.heading;motion.seatHeight=pose.seatHeight;return;}motion.seatId=null;motion.seatHeight=0;}
 const dt=Math.max(0,Math.min(.25,Number.isFinite(elapsed)?elapsed:0)),before=motion.position.y??0,support=supportHeight(scene,motion.position.x,motion.position.z,before);
 if(motion.verticalVelocity<=0&&before<=support+.00001){motion.position.y=support;motion.verticalVelocity=0;motion.grounded=true;return;}
 const next=before+motion.verticalVelocity*dt-GRAVITY*dt*dt/2;motion.verticalVelocity=Math.max(-50,motion.verticalVelocity-GRAVITY*dt);
 if(motion.verticalVelocity<=0&&next<=support){motion.position.y=support;motion.verticalVelocity=0;motion.grounded=true;}else{motion.position.y=Math.max(0,next);motion.grounded=false;}
}
export function screenDirection(input,angle){let x=input.x||0,z=input.z||0;const length=Math.hypot(x,z);if(length>.00001&&length>1){x/=length;z/=length;}return {x:-Math.sin(angle)*x+Math.cos(angle)*z,z:Math.cos(angle)*x+Math.sin(angle)*z};}
export function advanceMotion(motion,scene,{input={x:0,z:0},angle=Math.PI/4,fast=false,path=[],pathSpeed=1},elapsed){
 const dt=Math.max(0,Math.min(.25,Number.isFinite(elapsed)?elapsed:0));const manual=Math.hypot(input.x||0,input.z||0)>.065;if(manual)path.length=0;if((manual||path.length)&&!standMotion(motion,scene)){stopMotion(motion);return {manual,moving:false,running:false,travelled:0,elapsed:dt};}
 const count=Math.max(1,Math.ceil(dt/STEP)),h=dt/count;let travelled=0;
 for(let i=0;i<count;i++){
  advanceVertical(motion,scene,h);if(motion.seatId)continue;
  const direction=manual?screenDirection(input,angle):pathDirection(motion.position,path),active=Math.hypot(direction.x,direction.z)>.001;
  const speed=WALK_SPEED*(manual?(fast?FAST_WALK_MULTIPLIER:1):Math.max(1,Math.min(FAST_WALK_MULTIPLIER,Number(pathSpeed)||1))),target={x:direction.x*speed,z:direction.z*speed};
  const rate=active?ACCELERATION:BRAKING,decay=Math.exp(-rate*h),old=motion.velocity;
  const displacement={x:target.x*h+(old.x-target.x)*(1-decay)/rate,z:target.z*h+(old.z-target.z)*(1-decay)/rate};
  const nextVelocity={x:target.x+(old.x-target.x)*decay,z:target.z+(old.z-target.z)*decay};
  const before=motion.position,after=movePlayer(scene,before,displacement.x,displacement.z);const dx=after.x-before.x,dz=after.z-before.z;
  if(Math.abs(dx-displacement.x)>.00001)nextVelocity.x=0;if(Math.abs(dz-displacement.z)>.00001)nextVelocity.z=0;
  motion.position=after;motion.velocity=nextVelocity;travelled+=Math.hypot(dx,dz);
  if(Math.hypot(dx,dz)>.00005){motion.heading=Math.atan2(dx,dz);motion.direction=Math.abs(dx)>Math.abs(dz)?dx>0?2:1:dz>0?0:3;}
  if(!manual&&path.length&&active&&Math.hypot(dx,dz)<.000001){path.length=0;stopMotion(motion);}
 }
 motion.moving=travelled>.0001;motion.running=motion.moving&&(manual?fast:pathSpeed>1);if(!motion.moving&&Math.hypot(motion.velocity.x,motion.velocity.z)<.01)stopMotion(motion);
 return {manual,moving:motion.moving,running:motion.running,travelled,elapsed:dt};
}
