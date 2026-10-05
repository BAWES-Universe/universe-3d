import {Engine} from '@babylonjs/core/Engines/engine.js';
import {Scene} from '@babylonjs/core/scene.js';
import {ArcRotateCamera} from '@babylonjs/core/Cameras/arcRotateCamera.js';
import {Vector3,Quaternion,Matrix} from '@babylonjs/core/Maths/math.vector.js';
import {Plane} from '@babylonjs/core/Maths/math.plane.js';
import {Color3,Color4} from '@babylonjs/core/Maths/math.color.js';
import {HemisphericLight} from '@babylonjs/core/Lights/hemisphericLight.js';
import {Mesh} from '@babylonjs/core/Meshes/mesh.js';
import {VertexData} from '@babylonjs/core/Meshes/mesh.vertexData.js';
import {CreateLineSystem} from '@babylonjs/core/Meshes/Builders/linesBuilder.js';
import {StandardMaterial} from '@babylonjs/core/Materials/standardMaterial.js';
import '@babylonjs/core/Culling/ray.js';
import {geometry} from './geometry.js';
import {bounds} from './model.js';

// Dedicated preview resources exist only while the workshop is open.
export function createView(canvas){
 const engine=new Engine(canvas,true,{preserveDrawingBuffer:true,stencil:true},false);
 engine.setHardwareScalingLevel(Math.max(1,window.devicePixelRatio||1));
 const scene=new Scene(engine);scene.clearColor=new Color4(.075,.066,.115,1);
 const camera=new ArcRotateCamera('workshop-camera',-.8,1.04,7,new Vector3(0,.8,0),scene);
 camera.lowerRadiusLimit=1;camera.upperRadiusLimit=90;camera.lowerBetaLimit=.08;camera.upperBetaLimit=1.53;camera.wheelPrecision=40;camera.pinchPrecision=80;
 const light=new HemisphericLight('workshop-sky',new Vector3(.4,1,-.3),scene);light.intensity=1;
 const lines=[];for(let i=-8;i<=8;i++){lines.push([new Vector3(i,0,-8),new Vector3(i,0,8)],[new Vector3(-8,0,i),new Vector3(8,0,i)]);}
 const grid=CreateLineSystem('workshop-grid',{lines},scene);grid.color=Color3.FromHexString('#38334d');grid.isPickable=false;
 const meshes=new Map(),materials=new Map();let preview=null,disposed=false,frames=0;
 function material(source,ghost=false){const key=JSON.stringify([source.color,source.roughness,ghost]);if(materials.has(key))return materials.get(key);const m=new StandardMaterial('workshop-material-'+materials.size,scene);m.diffuseColor=Color3.FromHexString(source.color);m.specularColor=new Color3(.1,.1,.1);m.specularPower=8+(1-source.roughness)*56;if(ghost)m.alpha=.42;materials.set(key,m);return m;}
 function mesh(part,source,ghost=false){const m=new Mesh(ghost?'workshop-preview':'workshop-part-'+part.id,scene),data=new VertexData();Object.assign(data,geometry(part.shape));data.applyToMesh(m);m.metadata={componentId:part.id,shape:part.shape};m.isPickable=!ghost;m.material=material(source,ghost);return m;}
 function transform(m,p){m.position.set(...p.position);m.scaling.set(...p.size);m.rotationQuaternion=new Quaternion(...p.rotation);m.computeWorldMatrix(true);}
 function update(doc,selection=new Set(),pending=null){
  if(disposed)return;const ids=new Set(doc.components.map(p=>p.id));
  for(const [id,m]of meshes)if(!ids.has(id)){m.dispose();meshes.delete(id);}
  for(const part of doc.components){let m=meshes.get(part.id);if(m?.metadata.shape!==part.shape){m?.dispose();m=null;}if(!m){m=mesh(part,doc.materials.find(v=>v.id===part.materialId));meshes.set(part.id,m);}transform(m,part);m.material=material(doc.materials.find(v=>v.id===part.materialId));m.showBoundingBox=selection.has(part.id);}
  preview?.dispose();preview=null;
  if(pending){preview=mesh(pending,{color:pending.valid===false?'#e96d51':'#2dd4bf',roughness:.8},true);transform(preview,pending);}
  const used=new Set([...meshes.values(),...(preview?[preview]:[])].map(m=>m.material));for(const [key,value]of materials)if(!used.has(value)){value.dispose();materials.delete(key);}
 }
 const coords=(x,y)=>{const r=canvas.getBoundingClientRect();return{x:x-r.left,y:y-r.top};};
 function pick(x,y){const p=coords(x,y),hit=scene.pick(p.x,p.y,m=>!!m.metadata?.componentId&&m!==preview);return hit?.hit?hit.pickedMesh.metadata.componentId:null;}
 function floor(x,y){const p=coords(x,y),ray=scene.createPickingRay(p.x,p.y,Matrix.Identity(),camera),distance=ray.intersectsPlane(new Plane(0,1,0,0));if(distance===null||distance<0)return null;const v=ray.origin.add(ray.direction.scale(distance));return[v.x,0,v.z];}
 function focus(doc){const b=bounds(doc);if(!b){camera.setTarget(new Vector3(0,.8,0));camera.radius=7;return;}camera.setTarget(new Vector3(...b.min.map((v,i)=>(v+b.max[i])/2)));camera.radius=Math.max(3,Math.hypot(...b.min.map((v,i)=>b.max[i]-v))*1.5);}
 function orbit(x=0,y=0){camera.alpha+=x;camera.beta=Math.max(.08,Math.min(1.53,camera.beta+y));}
 function zoom(delta){camera.radius=Math.max(1,Math.min(90,camera.radius+delta));}
 function cameraMode(enabled){camera.detachControl();if(enabled)camera.attachControl(canvas,true);}
 const observer=new ResizeObserver(()=>engine.resize());observer.observe(canvas);engine.runRenderLoop(()=>{if(!disposed){scene.render();frames++;}});
 function diagnostics(){const r=canvas.getBoundingClientRect(),viewport=camera.viewport.toGlobal(engine.getRenderWidth(),engine.getRenderHeight());return{frames,meshes:meshes.size,materials:materials.size,parts:[...meshes].map(([id,m])=>{const p=Vector3.Project(m.position,Matrix.Identity(),scene.getTransformMatrix(),viewport);return{id,x:r.left+p.x*r.width/engine.getRenderWidth(),y:r.top+p.y*r.height/engine.getRenderHeight(),visible:p.z>=0&&p.z<=1};})};}
 return{diagnostics,update,pick,floor,focus,orbit,zoom,cameraMode,ready:scene.whenReadyAsync(),dispose(){if(disposed)return;disposed=true;observer.disconnect();camera.detachControl();engine.stopRenderLoop();scene.dispose();engine.dispose();}};
}
