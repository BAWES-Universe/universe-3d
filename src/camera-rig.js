// Projection-independent camera state. Input uses CSS pixels, never render pixels.
const TAU=Math.PI*2;
export const CAMERA_LIMITS=Object.freeze({minDistance:10,maxDistance:58,minTilt:.42,maxTilt:1.35});
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
export function createCameraRig({aspect=1.6}={}) {
 const defaults={yaw:Math.PI/4,tilt:.88,distance:aspect<.8?29:30};
 const state={...defaults,follow:true,framingMode:'follow',target:{x:0,z:2},player:{x:0,z:2},bounds:{width:32,depth:26}};
 const constrain=()=>{state.target.x=clamp(state.target.x,-state.bounds.width/2-8,state.bounds.width/2+8);state.target.z=clamp(state.target.z,-state.bounds.depth/2-8,state.bounds.depth/2+8);};
 return {
  orbit(dx,dy){state.yaw=((state.yaw-dx*.006)%TAU+TAU)%TAU;state.tilt=clamp(state.tilt+dy*.005,CAMERA_LIMITS.minTilt,CAMERA_LIMITS.maxTilt);},
  pan(dx,dy,viewportHeight=800){state.follow=false;state.framingMode='manual';const s=2*state.distance*Math.tan(.78/2)/Math.max(1,viewportHeight);const sn=Math.sin(state.yaw),cs=Math.cos(state.yaw);state.target.x-=(-sn*dx+cs*dy/Math.sin(state.tilt))*s;state.target.z-=(cs*dx+sn*dy/Math.sin(state.tilt))*s;constrain();},
  zoom(delta){if(Number.isFinite(delta))state.distance=clamp(state.distance+delta,CAMERA_LIMITS.minDistance,CAMERA_LIMITS.maxDistance);},
  rotate(delta){if(Number.isFinite(delta))state.yaw=(state.yaw+delta+TAU)%TAU;},
  reset(){Object.assign(state,defaults,{follow:true,framingMode:'follow'});state.target={...state.player};},
  setFollow(value){state.follow=!!value;state.framingMode=value?'follow':'manual';},
  focusPoint(x,z){if(Number.isFinite(x)&&Number.isFinite(z)){state.follow=false;state.framingMode='focus';state.target={x,z};constrain();}},
  setTarget(x,z){if(Number.isFinite(x)&&Number.isFinite(z))state.player={x,z};},
  setBounds(bounds){state.bounds={...bounds};constrain();},
  step(dt){if(state.follow){const rate=1-Math.exp(-Math.max(0,dt)*7);state.target.x+=(state.player.x-state.target.x)*rate;state.target.z+=(state.player.z-state.target.z)*rate;}return this.getState();},
  getState(){return {...state,target:{...state.target},player:{...state.player},bounds:{...state.bounds}};},
  getPosition(){const flat=Math.cos(state.tilt)*state.distance;return {x:state.target.x+Math.cos(state.yaw)*flat,y:.6+Math.sin(state.tilt)*state.distance,z:state.target.z+Math.sin(state.yaw)*flat};}
 };
}
