import {Engine} from '@babylonjs/core/Engines/engine.js';
import {Scene} from '@babylonjs/core/scene.js';
import {FreeCamera} from '@babylonjs/core/Cameras/freeCamera.js';
import {Camera} from '@babylonjs/core/Cameras/camera.js';
import {Vector3,Matrix} from '@babylonjs/core/Maths/math.vector.js';
import {Color3,Color4} from '@babylonjs/core/Maths/math.color.js';
import {Mesh} from '@babylonjs/core/Meshes/mesh.js';
import {TransformNode} from '@babylonjs/core/Meshes/transformNode.js';
import {CreateBox} from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import {CreatePlane} from '@babylonjs/core/Meshes/Builders/planeBuilder.js';
import {CreateCylinder} from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js';
import {CreateSphere} from '@babylonjs/core/Meshes/Builders/sphereBuilder.js';
import {CreateTorus} from '@babylonjs/core/Meshes/Builders/torusBuilder.js';
import {CreateGround} from '@babylonjs/core/Meshes/Builders/groundBuilder.js';
import {CreateLines} from '@babylonjs/core/Meshes/Builders/linesBuilder.js';
import {StandardMaterial} from '@babylonjs/core/Materials/standardMaterial.js';
import {Texture} from '@babylonjs/core/Materials/Textures/texture.js';
import {HemisphericLight} from '@babylonjs/core/Lights/hemisphericLight.js';
import {DirectionalLight} from '@babylonjs/core/Lights/directionalLight.js';
import '@babylonjs/core/Culling/ray.js';
import {CATALOG,dimensions} from './worlds.js';
const hex=h=>Color3.FromHexString(h);
export async function createRenderer(canvas,labels,{onPick,onReady}={}) {
 const engine=new Engine(canvas,true,{preserveDrawingBuffer:true,stencil:true,alpha:false},false);
 engine.setHardwareScalingLevel(Math.max(1,window.devicePixelRatio/1.5));
 const scene=new Scene(engine);scene.clearColor=new Color4(.039,.031,.071,1);scene.skipPointerMovePicking=true;
 const camera=new FreeCamera('camera',new Vector3(23,27,23),scene);camera.mode=Camera.ORTHOGRAPHIC_CAMERA;camera.minZ=.1;camera.maxZ=200;
 const hemi=new HemisphericLight('sky',new Vector3(0,1,0),scene);hemi.intensity=.68;hemi.groundColor=hex('#4e455e');
 const sun=new DirectionalLight('sun',new Vector3(-.5,-1,.35),scene);sun.intensity=.38;sun.diffuse=hex('#fff0d3');
 const materials=new Map();let nodes=[],avatars=new Map(),world=null,floor=null,grid=[],selection=null,guide=null,angle=Math.PI/4,zoom=16,target={x:0,z:0},build=false,tick=0,frameTimes=[];
 function material(color,emissive=false,alpha=1){const key=color+emissive+alpha;if(materials.has(key))return materials.get(key);const m=new StandardMaterial(key,scene);m.diffuseColor=hex(color);m.specularColor=new Color3(.04,.04,.04);m.alpha=alpha;if(emissive)m.emissiveColor=hex(color).scale(.8);materials.set(key,m);return m;}
 function box(name,x,y,z,w,h,d,color,parent,opts={}){const m=CreateBox(name,{width:w,height:h,depth:d},scene);m.position.set(x,y,z);m.material=material(color,opts.glow,opts.alpha??1);m.parent=parent||null;m.metadata=parent?.metadata||opts.metadata||null;return m;}
 function cylinder(name,x,y,z,r,h,color,parent,top=r){const m=CreateCylinder(name,{height:h,diameter:r*2,diameterTop:top*2,tessellation:10},scene);m.position.set(x,y,z);m.material=material(color);m.parent=parent||null;m.metadata=parent?.metadata||null;return m;}
 function sphere(name,x,y,z,r,color,parent,sy=1){const m=CreateSphere(name,{diameter:r*2,segments:3},scene);m.position.set(x,y,z);m.scaling.y=sy;m.material=material(color);m.parent=parent||null;m.metadata=parent?.metadata||null;return m;}
 function label(id,text,kind='world'){const el=document.createElement('div');el.className='world-label '+kind;el.dataset.entity=id;el.textContent=text;labels.append(el);return el;}
 const worldLabels=[];
 function clearWorld(){guide?.dispose();guide=null;nodes.forEach(n=>n.dispose(false));nodes=[];grid.forEach(n=>n.dispose());grid=[];worldLabels.forEach(n=>n.el.remove());worldLabels.length=0;selection?.dispose();selection=null;}
 function addObject(o){const t=CATALOG[o.type]||CATALOG.table;const n=new TransformNode(o.id,scene);n.metadata={id:o.id,type:'object'};n.position.set(o.x,0,o.z);n.rotation.y=-(o.rotation||0)*Math.PI/180;nodes.push(n);if(!['rug','portal'].includes(o.type)){const sh=CreateCylinder('contact-shadow',{height:.006,diameter:1,tessellation:20},scene);sh.parent=n;const dims=dimensions(o);sh.scaling.set(Math.max(.65,dims.width*1.03),1,Math.max(.65,dims.depth*1.03));sh.position.y=.014;sh.material=material('#151222',false,.17);sh.isPickable=false;}const c=o.color||t.color;const {width:w,depth:d}=dimensions(o);const b=(x,y,z,bw,bh,bd,col=c,opts={})=>box(o.id,x,y,z,bw,bh,bd,col,n,opts);
 if(o.type==='table'){b(0,.9,0,w,.16,d);[-1,1].forEach(a=>[-1,1].forEach(q=>b(a*(w/2-.2),.43,q*(d/2-.18),.13,.8,.13,'#594647')));b(0,1.015,0,.45,.04,.4,'#a4cfca');}
 else if(o.type==='chair'){b(0,.46,0,w,.18,d);b(0,.87,-d/2+.08,w,.75,.13);[-1,1].forEach(a=>[-1,1].forEach(q=>b(a*(w/2-.1),.22,q*(d/2-.1),.1,.4,.1,'#514055')));}
 else if(o.type==='sofa'){b(0,.45,0,w,.65,d);b(0,.96,-d/2+.14,w,.65,.28);b(-w/2+.14,.75,0,.28,.5,d);b(w/2-.14,.75,0,.28,.5,d);b(0,.8,.12,w-.55,.1,d-.42,'#ac97c4');}
 else if(o.type==='plant'||o.type==='tree'){const tree=o.type==='tree';cylinder(o.id,0,tree?.95:.24,0,tree?.25:.39,tree?1.9:.48,tree?'#756253':'#b19686',n,tree?.18:.49);sphere(o.id,0,tree?2.8:1,0,tree?1.65:.72,c,n,tree?1.15:1.25);if(tree){sphere(o.id,-.8,2.35,.2,1.1,'#4d947c',n);sphere(o.id,.8,2.6,.1,.95,'#5da388',n);}}
 else if(o.type==='wall'){b(0,1.3,0,w,2.6,d);b(0,2.64,0,w+.07,.08,d+.07,'#8c819c');}
 else if(o.type==='lamp'){cylinder(o.id,0,.04,0,.25,.08,'#49404e',n);cylinder(o.id,0,1,0,.06,1.9,'#74697e',n);b(0,1.95,0,.42,.55,.42,'#e9c74c',{glow:true});b(0,2.27,0,.55,.1,.55,'#74697e');}
 else if(o.type==='screen'){b(0,.75,0,.14,1.5,.14,'#585062');b(0,1.7,0,w,1.4,.16,'#292739');b(0,1.7,.09,w-.16,1.24,.025,c,{glow:true});b(0,1.7,.11,w*.6,.035,.03,'#c4b5fd',{glow:true});b(0,1.5,.11,w*.38,.025,.03,'#e9c74c',{glow:true});b(0,.08,0,w*.45,.12,.6,'#585062');}
 else if(o.type==='podium'){b(0,.65,0,w,.95,d);b(0,1.15,-.08,w+.12,.12,d+.15,'#b29bcc');b(0,1.43,0,.05,.5,.05,'#272132');}
 else if(o.type==='portal'){const torus=CreateTorus(o.id,{diameter:1.65,thickness:.13,tessellation:28},scene);torus.parent=n;torus.rotation.x=Math.PI/2;torus.position.y=1.1;torus.material=material(c,true);torus.metadata=n.metadata;b(0,.06,0,2,.12,1.3,'#61566f');const glow=CreatePlane(o.id,{width:1.4,height:1.5,sideOrientation:Mesh.DOUBLESIDE},scene);glow.parent=n;glow.position.y=1.08;glow.material=material(c,true,.22);glow.metadata=n.metadata;worldLabels.push({el:label(o.id,o.name,'portal-label'),position:new Vector3(o.x,2.6,o.z)});}
 else if(o.type==='rug')b(0,.014,0,w,.022,d,c);
 else if(o.type==='board'){b(0,1.25,0,w,1.1,.13);b(0,1.25,.09,w-.2,.9,.025,'#eee0c7');b(-w*.35,.45,0,.13,.9,.13,'#796448');b(w*.35,.45,0,.13,.9,.13,'#796448');b(0,1.4,.11,w*.6,.03,.02,'#a289b4');b(0,1.2,.11,w*.5,.03,.02,'#a289b4');}
 else if(o.type==='bench'){b(0,.55,0,w,.15,d);b(-w*.35,.25,0,.16,.5,.5,'#746252');b(w*.35,.25,0,.16,.5,.5,'#746252');}
 else if(o.type==='rock')sphere(o.id,0,.35,0,.7,c,n,.65);
 }
 function sync(newWorld){world=newWorld;clearWorld();const w=world.bounds.width,d=world.bounds.depth;const theme=world.theme||'garden';const floorColor=theme==='garden'?'#648582':theme==='studio'?'#7a748d':'#746680';
 const root=new TransformNode('environment',scene);nodes.push(root);box('island',0,-.52,0,w+.1,.95,d+.1,'#292738',root);box('edge',0,-.08,0,w+.05,.12,d+.05,'#b2a2c4',root);
 floor=CreateGround('floor',{width:w,height:d,subdivisions:1},scene);floor.position.y=0;floor.material=material(floorColor);floor.metadata={type:'ground'};floor.parent=root;
 if(theme==='garden'){box('walkway-edge',0,.003,2,3.24,.012,d-3.1,'#536e6a',root);box('crosswalk-edge',0,.003,-6,w-5.9,.012,3.24,'#536e6a',root);box('walkway',0,.006,2,3,.015,d-3,'#b6b5a5',root);box('crosswalk',0,.008,-6,w-6,.015,3,'#b6b5a5',root);for(let i=0;i<22;i++){const x=-w/2+1+(i*7.31)%(w-2),z=-d/2+1+(i*4.97)%(d-2);if(Math.abs(x)<2||Math.abs(z+6)<2)continue;cylinder('flower',x,.12,z,.11,.25,i%2?'#c5b7df':'#e9c74c',root);}}
 else{for(let x=-w/2;x<=w/2;x+=2)box('tile',x,.008,0,.024,.01,d,'#868198',root);for(let z=-d/2;z<=d/2;z+=2)box('tile',0,.009,z,w,.01,.024,'#868198',root);}
 for(const o of world.objects)addObject(o);
 for(const a of world.areas){const col={silent:'#5aa2a0',meeting:'#8c7dc9',stage:'#c4a56b',audience:'#917da8',welcome:'#86b39e',teleport:'#a78bfa'}[a.action]||'#8d83ab';const n=box(a.id,a.x,.012,a.z,a.width,.013,a.depth,col,root,{alpha:.24,metadata:{id:a.id,type:'area'}});if(build){const line=CreateLines('area-outline',{points:[[-1,-1],[1,-1],[1,1],[-1,1],[-1,-1]].map(([x,z])=>new Vector3(a.x+x*a.width/2,.05,a.z+z*a.depth/2))},scene);line.color=hex(col);line.parent=root;worldLabels.push({el:label(a.id,a.name,'area-label'),position:new Vector3(a.x,.5,a.z)});}}
 // Batch static geometry by material and pickability. Preserve per-face item identity
 // so visual optimization cannot alter selection, actions, collision or permissions.
 const batches=new Map();for(const parent of nodes)for(const mesh of parent.getChildMeshes()){if(mesh===floor||!mesh.getTotalVertices())continue;const key=mesh.material?.uniqueId+':'+mesh.isPickable+':'+(mesh.metadata?.type==='area'?'area':'normal');if(!batches.has(key))batches.set(key,[]);batches.get(key).push(mesh);}
 for(const meshes of batches.values()){if(meshes.length<2)continue;const ranges=[];let face=0;for(const m of meshes){m.computeWorldMatrix(true);const count=m.getTotalIndices()/3;ranges.push({start:face,end:face+count,metadata:m.metadata});face+=count;}const material=meshes[0].material,pickable=meshes[0].isPickable,onlyAreas=meshes.every(m=>m.metadata?.type==='area');const merged=Mesh.MergeMeshes(meshes,true,true);if(merged){merged.material=material;merged.parent=root;merged.isPickable=pickable;merged.metadata={type:onlyAreas?'area':'batch',ranges};}}
 for(const parent of nodes){parent.computeWorldMatrix(true);for(const mesh of parent.getChildMeshes()){mesh.computeWorldMatrix(true);mesh.freezeWorldMatrix();}}
 if(build){for(let x=-w/2;x<=w/2;x++){const l=CreateLines('grid',{points:[new Vector3(x,.04,-d/2),new Vector3(x,.04,d/2)]},scene);l.color=hex('#c4b5fd');l.alpha=.25;grid.push(l);}for(let z=-d/2;z<=d/2;z++){const l=CreateLines('grid',{points:[new Vector3(-w/2,.04,z),new Vector3(w/2,.04,z)]},scene);l.color=hex('#c4b5fd');l.alpha=.25;grid.push(l);}}
 }
 function avatar(p){let a=avatars.get(p.id);if(a&&a.woka!==p.woka){a.mesh.dispose(false,true);a.el.remove();a.shadow.dispose();avatars.delete(p.id);a=null;}if(!a){const mesh=CreatePlane(p.id,{width:1.65,height:1.65,sideOrientation:Mesh.DOUBLESIDE},scene);mesh.billboardMode=Mesh.BILLBOARDMODE_ALL;mesh.isPickable=false;const m=new StandardMaterial('woka-'+p.id,scene);m.diffuseTexture=new Texture('/assets/woka-'+(Number(p.woka)||0)+'.png',scene,false,true,Texture.NEAREST_SAMPLINGMODE);m.diffuseTexture.hasAlpha=true;m.diffuseTexture.uScale=1/3;m.diffuseTexture.vScale=1/4;m.useAlphaFromDiffuseTexture=true;m.backFaceCulling=false;m.disableLighting=true;m.emissiveColor=Color3.White();mesh.material=m;const shadow=CreateCylinder('shadow',{height:.01,diameter:.8,tessellation:16},scene);shadow.material=material('#16121e',false,.22);shadow.isPickable=false;const el=label(p.id,p.name,'player-label');a={mesh,shadow,el,woka:p.woka,x:p.x,z:p.z};avatars.set(p.id,a);}a.p=p;const labelText=(p.emote?p.emote+' ':'')+p.name;if(a.el.textContent!==labelText)a.el.textContent=labelText;a.el.classList.toggle('self',!!p.self);a.el.classList.toggle('away',p.status==='away');return a;}
 function syncPeople(people){const seen=new Set();for(const p of people){seen.add(p.id);avatar(p);}for(const [id,a]of avatars)if(!seen.has(id)){a.mesh.dispose(false,true);a.shadow.dispose();a.el.remove();avatars.delete(id);}}
 function project(v){return Vector3.Project(v,Matrix.Identity(),scene.getTransformMatrix(),camera.viewport.toGlobal(engine.getRenderWidth(),engine.getRenderHeight()));}
 function positionLabel(el,v){const p=project(v);const sx=canvas.clientWidth/engine.getRenderWidth(),sy=canvas.clientHeight/engine.getRenderHeight();el.style.transform=`translate(${p.x*sx}px,${p.y*sy}px) translate(-50%,-100%)`;const top=p.y*sy;el.style.display=p.z<0||p.z>1||top<(window.innerWidth<700?130:112)?'none':'';}
 function resize(){engine.resize();const aspect=canvas.clientWidth/canvas.clientHeight;camera.orthoLeft=-zoom*aspect;camera.orthoRight=zoom*aspect;camera.orthoTop=zoom;camera.orthoBottom=-zoom;}
 function render(dt,actualDt=dt){tick+=dt;frameTimes.push(actualDt*1000);if(frameTimes.length>300)frameTimes.shift();const follow=build?{x:0,z:0}:target;camera.position.set(follow.x+Math.cos(angle)*26,30,follow.z+Math.sin(angle)*26);camera.setTarget(new Vector3(follow.x,0,follow.z));for(const a of avatars.values()){const p=a.p;a.x+=(p.x-a.x)*Math.min(1,dt*15);a.z+=(p.z-a.z)*Math.min(1,dt*15);a.mesh.position.set(a.x,.86,a.z);a.shadow.position.set(a.x,.023,a.z);const tex=a.mesh.material.diffuseTexture;const row=p.direction??0;tex.uOffset=(p.moving?Math.floor(tick*8)%3:1)/3;tex.vOffset=(3-row)/4;positionLabel(a.el,new Vector3(a.x,1.85,a.z));}for(const l of worldLabels)positionLabel(l.el,l.position);scene.render();}
 function pick(clientX,clientY){const rect=canvas.getBoundingClientRect(),x=(clientX-rect.left)*engine.getRenderWidth()/canvas.clientWidth,y=(clientY-rect.top)*engine.getRenderHeight()/canvas.clientHeight;const picked=scene.pick(x,y,m=>m.isPickable&&m.metadata?.type!=='area');const ground=scene.pick(x,y,m=>m===floor);let metadata=picked?.pickedMesh?.metadata;if(metadata?.type==='batch')metadata=metadata.ranges.find(r=>picked.faceId>=r.start&&picked.faceId<r.end)?.metadata;return {id:metadata?.id,type:metadata?.type,point:ground?.pickedPoint?{x:ground.pickedPoint.x,z:ground.pickedPoint.z}:null};}
 function select(id){selection?.dispose();selection=null;const o=world.objects.find(o=>o.id===id)||world.areas.find(o=>o.id===id);if(!o)return;let {width,depth}=o.width?o:dimensions(o);if(Math.round((o.rotation||0)/90)%2)[width,depth]=[depth,width];selection=CreateLines('selected',{points:[[-1,-1],[1,-1],[1,1],[-1,1],[-1,-1]].map(([x,z])=>new Vector3(o.x+x*(width/2+.12),.08,o.z+z*(depth/2+.12)))},scene);selection.color=hex('#e9c74c');}
 resize();window.addEventListener('resize',resize);
 return {sync,syncPeople,render,pick,select,setGuide(target){guide?.dispose();guide=null;if(!target)return;guide=CreateTorus('quest-marker',{diameter:1.7,thickness:.08,tessellation:32},scene);guide.position.set(target.x,.12,target.z);guide.material=material('#e9c74c',true);guide.isPickable=false;},screenPoint(x,z,y=0){const p=project(new Vector3(x,y,z));return {x:p.x*canvas.clientWidth/engine.getRenderWidth(),y:p.y*canvas.clientHeight/engine.getRenderHeight()};},setBuild(v){build=v;sync(world);},setTarget(x,z){target.x=x*.32;target.z=z*.32;},zoom(delta){zoom=Math.max(6,Math.min(23,zoom+delta));resize();},rotate(delta){angle+=delta;},getCameraAngle:()=>angle,getStats:()=>({engine:'Babylon WebGL'+engine.webGLVersion,meshes:scene.meshes.length,drawCalls:engine._drawCalls?.lastSecAverage,frameMs:frameTimes.slice()}),dispose(){window.removeEventListener('resize',resize);engine.dispose();},ready:scene.whenReadyAsync()};
}
