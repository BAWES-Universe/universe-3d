import {Vector3} from '@babylonjs/core/Maths/math.vector.js';
import {Color3} from '@babylonjs/core/Maths/math.color.js';
import {CreateSphere} from '@babylonjs/core/Meshes/Builders/sphereBuilder.js';
import {CreateLines} from '@babylonjs/core/Meshes/Builders/linesBuilder.js';
import {StandardMaterial} from '@babylonjs/core/Materials/standardMaterial.js';
import {createAvatarRig} from './avatar-rig.js';
import {navigationPolicy} from '../server/bot-navigation.mjs';
export function createBotMapPreview(scene,bot,world){
 const avatar=createAvatarRig(scene,bot.appearance,{id:'resident-draft'}),material=new StandardMaterial('resident-handle',scene);material.diffuseColor=Color3.FromHexString('#e9c74c');material.emissiveColor=material.diffuseColor.scale(.35);
 let config=bot,handles=[],circle=null,route=null,routeCount=-1;
 function handle(id){const mesh=CreateSphere('resident-'+id,{diameter:.5,segments:8},scene);mesh.material=material;mesh.isPickable=true;mesh.metadata={type:'bot-handle',id};handles.push(mesh);return mesh;}
 const radius=handle('radius');
 function set(next){
  config=structuredClone(next);avatar.setAppearance(config.appearance);avatar.root.position.set(config.spawn.x,.08,config.spawn.z);for(const mesh of avatar.meshes){mesh.isPickable=true;mesh.metadata={type:'bot-handle',id:'spawn'};}
  const valid=navigationPolicy(world,config),color=Color3.FromHexString(valid(config.spawn)&&config.waypoints.every(valid)?'#e9c74c':'#ee806c');material.diffuseColor=color;material.emissiveColor=color.scale(.35);
  const points=Array.from({length:65},(_,i)=>{const a=i/64*Math.PI*2;return new Vector3(config.spawn.x+Math.cos(a)*config.radius,.13,config.spawn.z+Math.sin(a)*config.radius);});circle=CreateLines('resident-radius',{points,instance:circle||undefined,updatable:true},scene);circle.color=color;circle.isPickable=false;
  radius.position.set(config.spawn.x+Math.max(.8,config.radius),.25,config.spawn.z);
  if(routeCount!==config.waypoints.length){for(const mesh of handles.slice(1))mesh.dispose();handles=[radius];for(let i=0;i<config.waypoints.length;i++)handle('waypoint:'+i);route?.dispose();route=null;routeCount=config.waypoints.length;}
  config.waypoints.forEach((point,i)=>handles[i+1].position.set(point.x,.25,point.z));
  if(config.waypoints.length){const routePoints=[config.spawn,...config.waypoints,...(config.loop?[config.waypoints[0]]:[])].map(p=>new Vector3(p.x,.14,p.z));if(route&&route.getTotalVertices()!==routePoints.length){route.dispose();route=null;}route=CreateLines('resident-route',{points:routePoints,instance:route||undefined,updatable:true},scene);route.color=Color3.FromHexString('#7dd3fc');route.isPickable=false;}
 }
 set(bot);
 return {set,setWorld(next){world=next;set(config);},tick(dt,time){avatar.update({dt,time,heading:0,moving:false});},get position(){return config.spawn;},dispose(){avatar.dispose();for(const mesh of handles)mesh.dispose();circle?.dispose();route?.dispose();material.dispose();}};
}
export function moveBotHandle(bot,handle,point,snap=.5){
 const next=structuredClone(bot),round=v=>Math.round(v/snap)*snap;
 if(handle==='spawn')next.spawn={x:round(point.x),z:round(point.z)};
 else if(handle==='radius')next.radius=Math.min(100,Math.max(0,Math.round(Math.hypot(point.x-bot.spawn.x,point.z-bot.spawn.z)/snap)*snap));
 else if(handle.startsWith('waypoint:')){const index=Number(handle.slice(9));if(next.waypoints[index])next.waypoints[index]={x:round(point.x),z:round(point.z)};}
 return next;
}
