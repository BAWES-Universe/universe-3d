import {compositionGeometry} from './composition-context.js';
import {SILENT_MEDIA_MESSAGE} from './media-policy-copy.js';
import {imagePhysicalSize} from './image-asset-schema.js';
import {cloneWithImageContext,imageGeometry,resolvedImage} from './image-asset-context.js';
import {terrainBlocks} from './terrain.js';
// Original standalone room layouts; source-native Woka identity is rendered as legacy sprites.
export const CATALOG = {
 table:{name:'Community table',icon:'▤',width:2.4,depth:1.3,color:'#b88855',solid:true},
 chair:{name:'Chair',icon:'▥',width:.7,depth:.7,color:'#a78bfa',solid:true},
 sofa:{name:'Lounge sofa',icon:'▰',width:2.5,depth:1.05,color:'#8b74b8',solid:true},
 plant:{name:'Planter',icon:'♧',width:.8,depth:.8,color:'#58a286',solid:true},
 tree:{name:'Canopy tree',icon:'♠',width:1.3,depth:1.3,color:'#397c70',solid:true},
 wall:{name:'Wall',icon:'▧',width:3,depth:.3,color:'#676079',solid:true},
 lamp:{name:'Lantern',icon:'◈',width:.4,depth:.4,color:'#e9c74c',solid:true},
 screen:{name:'Room screen',icon:'▣',width:2.5,depth:.4,color:'#4156f6',solid:true},
 podium:{name:'Podium',icon:'▱',width:1.5,depth:.8,color:'#9b7acd',solid:true},
 portal:{name:'Portal',icon:'◉',width:1.7,depth:.8,color:'#a78bfa',solid:false},
 rug:{name:'Rug',icon:'▨',width:4,depth:3,color:'#5d5476',solid:false},
 board:{name:'Notice board',icon:'▤',width:2,depth:.3,color:'#947556',solid:true},
 bench:{name:'Bench',icon:'▬',width:2,depth:.7,color:'#b88855',solid:true},
 rock:{name:'Stone',icon:'◆',width:1.1,depth:1,color:'#758987',solid:true},
};
const obj=(id,type,x,z,extra={})=>({id,type,name:CATALOG[type].name,x,z,rotation:0,...extra});
const area=(id,name,x,z,width,depth,action,extra={})=>({id,name,x,z,width,depth,action,...extra});
export function emptyScene(theme='garden') {return {version:1,theme,bounds:{width:32,depth:26},spawn:{x:0,z:7},objects:[],areas:[]};}
const commons={...emptyScene(),objects:[
 obj('commons-table','table',-6,-2,{name:'Gather around'}),obj('commons-chair1','chair',-6,0,{rotation:180}),obj('commons-chair2','chair',-7.9,-2,{rotation:90}),obj('commons-chair3','chair',-4.1,-2,{rotation:270}),
 obj('commons-sofa','sofa',6,-1,{rotation:90}),obj('commons-sofa2','sofa',8,-4,{rotation:180}),obj('commons-rug','rug',6,-3,{color:'#625477'}),
 obj('commons-plant1','plant',3,-5),obj('commons-plant2','plant',9,0),obj('commons-board','board',-2,-7,{name:'Welcome to Universe',text:'A place to gather, create, and make your world. Walk with WASD or click the ground. Find portals to the Studio and Assembly. Enter Build to change this place.'}),
 obj('commons-studio','portal',-10,-8,{name:'The Studio',target:'studio',color:'#2dd4bf'}),obj('commons-assembly','portal',10,-8,{name:'Assembly',target:'assembly',color:'#e9c74c'}),
 obj('commons-tree1','tree',-13,-3),obj('commons-tree2','tree',13,3),obj('commons-tree3','tree',-11,9),obj('commons-tree4','tree',12,-11),
 obj('commons-bench','bench',-10,6,{rotation:90}),obj('commons-lamp1','lamp',-3,5),obj('commons-lamp2','lamp',3,5),obj('commons-rock','rock',12,8),
 ],areas:[area('welcome','The Commons',0,7,6,4,'welcome',{message:'Welcome to your Universe. Wander, meet someone, make a place.'}),area('quiet','Quiet garden',6,-3,8,6,'silent',{message:SILENT_MEDIA_MESSAGE})]};
const studio={...emptyScene('studio'),spawn:{x:0,z:8},objects:[
 obj('studio-rug','rug',0,-1,{width:10,depth:8,color:'#454067'}),obj('studio-table1','table',-4,-1),obj('studio-table2','table',4,-1),obj('studio-chair1','chair',-4,1),obj('studio-chair2','chair',4,1),
 obj('studio-screen','screen',0,-7,{name:'Project screen',text:'Use the media controls to share your screen with eligible participants.'}),
 obj('studio-wall1','wall',-9,-6,{rotation:90,width:8}),obj('studio-wall2','wall',9,-6,{rotation:90,width:8}),
 obj('studio-plant','plant',-7,6),obj('studio-plant2','plant',7,6),obj('studio-portal','portal',0,10,{name:'The Commons',target:'commons'}),
 obj('studio-board','board',-6,-7,{name:'Create together',text:'The owner can grant editor access from People. Place furniture, design an area, save it, and return later. Changes are stored by the server.'}),
 ],areas:[area('studio-meeting','Studio meeting',0,-1,13,10,'meeting',{meetingName:'studio',message:'Studio meeting'})]};
const assembly={...emptyScene('assembly'),objects:[
 obj('assembly-rug','rug',0,-7,{width:11,depth:5,color:'#5c4578'}),obj('assembly-podium','podium',0,-7,{name:'Community podium'}),
 ...[-6,-3,0,3,6].flatMap((x,i)=>[obj('seat-a'+i,'chair',x,-1,{rotation:180}),obj('seat-b'+i,'chair',x,2,{rotation:180})]),
 obj('assembly-screen','screen',0,-10,{width:5,name:'Assembly screen'}),obj('assembly-tree1','tree',-12,-6),obj('assembly-tree2','tree',12,-6),obj('assembly-portal','portal',0,10,{target:'commons',name:'The Commons'}),
 ],areas:[area('stage','Assembly stage',0,-7,12,5,'stage',{meetingName:'assembly'}),area('audience','Assembly audience',0,0,17,9,'audience',{meetingName:'assembly'})]};
export const seedWorlds=[{id:'universe',name:'Our Universe',rooms:[{id:'commons',name:'The Commons',scene:commons},{id:'studio',name:'The Studio',scene:studio},{id:'assembly',name:'Assembly',scene:assembly}]}];
export const clone = cloneWithImageContext;
export function dimensions(o,scene){if(o.type==='composition'){const {width,depth}=compositionGeometry(scene,o).localBounds;return {width,depth};}if(o.type==='image'){const entry=resolvedImage(scene,o);if(!entry)throw Error('Image version is unavailable');const size=imagePhysicalSize(entry.version);return{width:size.widthMetres,depth:size.heightMetres};}const t=CATALOG[o.type]||CATALOG.table;return {width:o.width||t.width,depth:o.depth||t.depth};}
export function collisionBox(o,scene){if(o.type==='composition')return compositionGeometry(scene,o).editBounds;if(o.type==='image')return imageGeometry(scene,o).editBounds;let {width,depth}=dimensions(o,scene);if(Math.round((o.rotation||0)/90)%2)[width,depth]=[depth,width];return {x:o.x,z:o.z,width,depth};}
export function contains(area,x,z,padding=0){return Math.abs(x-area.x)<=area.width/2+padding&&Math.abs(z-area.z)<=area.depth/2+padding;}
export function collisionBoxes(scene,object){if(object.type==='composition')return compositionGeometry(scene,object).collisionCells;if(object.type==='image')return imageGeometry(scene,object).collisionCells;return CATALOG[object.type]?.solid?[collisionBox(object,scene)]:[];}
export function canStand(scene,x,z,r=.3){if(!Number.isFinite(x)||!Number.isFinite(z)||!Number.isFinite(r)||r<0||Math.abs(x)>scene.bounds.width/2-r||Math.abs(z)>scene.bounds.depth/2-r)return false;try{if(terrainBlocks(scene,x,z,r))return false;}catch{return false;}for(const object of scene.objects){try{if(object.type==='image'&&!contains(imageGeometry(scene,object).editBounds,x,z,r))continue;if(collisionBoxes(scene,object).some(box=>contains(box,x,z,r)))return false;}catch{return false;}}return true;}
export function movePlayer(scene,p,dx,dz){let {x,z}=p;const steps=Math.max(1,Math.ceil(Math.hypot(dx,dz)/.15));for(let i=0;i<steps;i++){if(canStand(scene,x+dx/steps,z))x+=dx/steps;if(canStand(scene,x,z+dz/steps))z+=dz/steps;}return {x,z};}
export function nearestWalkable(scene,p){if(canStand(scene,p.x,p.z))return p;for(let r=.5;r<20;r+=.5)for(let a=0;a<Math.PI*2;a+=Math.PI/8){let q={x:p.x+Math.cos(a)*r,z:p.z+Math.sin(a)*r};if(canStand(scene,q.x,q.z))return q;}return scene.spawn;}
// Bounded A* for click movement, sharing the same solid-object predicate as keyboard movement.
export function findPath(scene,start,end){const g=.5,key=(x,z)=>x+','+z;const s={x:Math.round(start.x/g),z:Math.round(start.z/g)},t={x:Math.round(end.x/g),z:Math.round(end.z/g)};if(!canStand(scene,t.x*g,t.z*g))return [];
 let open=[{...s,g:0,f:0}],came=new Map(),best=new Map([[key(s.x,s.z),0]]),n=0;
 while(open.length&&n++<5000){open.sort((a,b)=>a.f-b.f);const q=open.shift(),k=key(q.x,q.z);if(q.x===t.x&&q.z===t.z){const path=[{x:t.x*g,z:t.z*g}];let c=k;while(came.has(c)){c=came.get(c);let [x,z]=c.split(',').map(Number);path.unshift({x:x*g,z:z*g});}return path.slice(1);}
 for(const [dx,dz]of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){let x=q.x+dx,z=q.z+dz,nk=key(x,z),cost=q.g+(dx&&dz?1.414:1);if(!canStand(scene,x*g,z*g)||!canStand(scene,(q.x+dx)*g,q.z*g)||!canStand(scene,q.x*g,(q.z+dz)*g)||cost>=(best.get(nk)??Infinity))continue;best.set(nk,cost);came.set(nk,k);open.push({x,z,g:cost,f:cost+Math.hypot(t.x-x,t.z-z)});}}
 return [];}
export function pathDirection(position,path){while(path.length&&Math.hypot(path[0].x-position.x,path[0].z-position.z)<.13)path.shift();if(!path.length)return {x:0,z:0};const dx=path[0].x-position.x,dz=path[0].z-position.z,length=Math.hypot(dx,dz);return {x:dx/length,z:dz/length};}
