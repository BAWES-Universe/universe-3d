import {WALK_SPEED,FAST_WALK_MULTIPLIER} from './motion.js';
// Presence may come from a legacy four-direction peer or the full 3D payload.
// Never let a fabricated cardinal velocity override an exact world rotation.
export function resolveAvatarMotion(p){
 const dirs=[[0,1],[-1,0],[1,0],[0,-1]],facing=dirs[p.direction??0]||dirs[0];
 const heading=Number.isFinite(p.rotation)?p.rotation:Number.isFinite(p.heading)?p.heading:Math.atan2(facing[0],facing[1]);
 const moving=!!p.moving,running=moving&&p.running===true;
 const speed=moving?WALK_SPEED*(running?FAST_WALK_MULTIPLIER:1):0;
 const velocity=p.velocity&&Number.isFinite(p.velocity.x)&&Number.isFinite(p.velocity.z)?{x:p.velocity.x,z:p.velocity.z}:{x:Math.sin(heading)*speed,z:Math.cos(heading)*speed};
 return {heading,velocity,moving,running};
}
