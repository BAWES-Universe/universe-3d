import {compositionGeometry,resolvedComposition,compositionRoomId} from './composition-context.js';
import {createCompositionObjectView} from './composition-renderer.js';
import {createWorldPresentation} from './world-presentation.js';
import {resizeRenderBuffer,WORLD_RENDER_PIXELS} from './render-resolution.js';
import {createBabylonImageTexturePool,createBabylonImageObjectView,pickWithImageAlpha} from './babylon-image-object-view.js';
import {resolvedImage,imageGeometry} from './image-asset-context.js';
import {Engine} from '@babylonjs/core/Engines/engine.js';
import {Scene} from '@babylonjs/core/scene.js';
import {FreeCamera} from '@babylonjs/core/Cameras/freeCamera.js';
import {Vector3,Vector4,Matrix} from '@babylonjs/core/Maths/math.vector.js';
import {Color3,Color4} from '@babylonjs/core/Maths/math.color.js';
import {Mesh} from '@babylonjs/core/Meshes/mesh.js';
import {VertexData} from '@babylonjs/core/Meshes/mesh.vertexData.js';
import {TransformNode} from '@babylonjs/core/Meshes/transformNode.js';
import {CreateBox,CreateBoxVertexData} from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import {CreatePlane} from '@babylonjs/core/Meshes/Builders/planeBuilder.js';
import {CreateCylinder} from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js';
import {CreateSphere} from '@babylonjs/core/Meshes/Builders/sphereBuilder.js';
import {CreateTorus} from '@babylonjs/core/Meshes/Builders/torusBuilder.js';
import {CreateGround,CreateGroundVertexData} from '@babylonjs/core/Meshes/Builders/groundBuilder.js';
import {CreateLines,CreateLineSystem} from '@babylonjs/core/Meshes/Builders/linesBuilder.js';
import {StandardMaterial} from '@babylonjs/core/Materials/standardMaterial.js';
import {Texture} from '@babylonjs/core/Materials/Textures/texture.js';
import {DynamicTexture} from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import {HemisphericLight} from '@babylonjs/core/Lights/hemisphericLight.js';
import {DirectionalLight} from '@babylonjs/core/Lights/directionalLight.js';
import {ShadowGenerator} from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import '@babylonjs/core/Culling/ray.js';
import {CATALOG,dimensions} from './worlds.js';
import {createBotMapPreview} from './bot-preview.js';
import {createAvatarRig} from './avatar-rig.js';
import {resolveAvatarMotion} from './avatar-motion.js';
import {createCameraRig} from './camera-rig.js';
import {frameInFreeArea,createFramingTransition,projectionShift} from './viewport-framing.js';
import {measurePanelOcclusion} from './panel-occlusion.js';
import {createEnvironmentMaterials} from './environment-materials.js';
import {buildEnvironment} from './scene-layout.js';
import {TERRAIN_SURFACES,terrainSurfaceGroups,terrainSurfaceGeometry,terrainGhostLines,terrainCutGeometry,TERRAIN_BATCH_VERTEX_LIMIT} from './terrain-render.js';
import {labelFits,WORLD_LABEL_OCCLUDERS} from './label-layout.js';
const hex=h=>Color3.FromHexString(h);

export async function createRenderer(canvas,labels){
 const presentation=createWorldPresentation();
 const motionPreference=window.matchMedia('(prefers-reduced-motion: reduce)');
 let ambienceTime=0;
 let drawnFrames=0,lastRenderDt=0,resizePending=false,labelsHiddenBeforePause=null;
 const engine=new Engine(canvas,true,{preserveDrawingBuffer:true,stencil:true,alpha:false},false);
 resizeRenderBuffer(engine,canvas,WORLD_RENDER_PIXELS);
 const scene=new Scene(engine);scene.clearColor=new Color4(.065,.058,.096,1);scene.skipPointerMovePicking=true;
 const camera=new FreeCamera('camera',new Vector3(23,27,23),scene);camera.minZ=.15;camera.maxZ=160;camera.fov=.78;camera.inputs.clear();
 const rig=createCameraRig({aspect:canvas.clientWidth/canvas.clientHeight});
 const framingTransition=createFramingTransition();let framing={status:'unobstructed',offset:{x:0,y:0},rect:null,panelCount:0},framingKey='',framingGoal=null;
 const hemi=new HemisphericLight('soft-sky',new Vector3(0,1,0),scene);hemi.intensity=.78;hemi.diffuse=hex('#eaf4ef');hemi.groundColor=hex('#746d69');
 const sun=new DirectionalLight('late-afternoon',new Vector3(-.65,-1,.4),scene);sun.position.set(20,32,-18);sun.intensity=.78;sun.diffuse=hex('#fff1d6');
 const shadows=new ShadowGenerator(1024,sun);shadows.usePercentageCloserFiltering=true;shadows.filteringQuality=ShadowGenerator.QUALITY_LOW;shadows.bias=.0008;shadows.normalBias=.012;shadows.setDarkness(.28);
 const surfaces=createEnvironmentMaterials(scene),materials=new Map(),signMaterials=new Map(),worldLabels=[],pendingLabels=[];
 // One 64px original falloff texture per renderer. Shared by every contact plane.
 // No light, shadow-map pass, depth offset or pickable geometry is added.
 const contactTexture=new DynamicTexture('world-contact-falloff',{width:64,height:64},scene,true,Texture.BILINEAR_SAMPLINGMODE);
 const contactContext=contactTexture.getContext(),falloff=contactContext.createRadialGradient(32,32,0,32,32,32);
 falloff.addColorStop(0,'rgba(31,35,30,.26)');falloff.addColorStop(.38,'rgba(31,35,30,.18)');falloff.addColorStop(1,'rgba(31,35,30,0)');
 contactContext.fillStyle=falloff;contactContext.fillRect(0,0,64,64);contactTexture.hasAlpha=true;contactTexture.update(false);
 const contactMaterial=new StandardMaterial('world-contact',scene);contactMaterial.diffuseTexture=contactTexture;contactMaterial.useAlphaFromDiffuseTexture=true;contactMaterial.disableLighting=true;contactMaterial.emissiveColor=Color3.White();contactMaterial.specularColor=Color3.Black();
 function contact(name,x,y,z,width,depth,parent=null){const mesh=CreateGround(name,{width,height:depth},scene);mesh.position.set(x,y,z);mesh.parent=parent;mesh.material=contactMaterial;mesh.isPickable=false;mesh.receiveShadows=false;mesh.metadata={type:'environment'};return mesh;}
 const compositionViews=new Set(),compositionErrors=new Map();
 const imagePool=createBabylonImageTexturePool(scene),imageViews=new Map(),missingImages=new Map();let ghostComposition=null;let imageContext={roomId:'unjoined',roomEpoch:0,authorityEpoch:0,canRead:false},imageStateListener=null,ghostImage=null;
 function cleanComposition(value,id=value.id||'composition-preview'){return{id,type:'composition',name:value.name||'Custom furniture',assetRef:value.assetRef,x:value.x,z:value.z,rotation:value.rotation??0};}
 function cleanImage(value,id=value.id||'image-preview'){const out={id,type:'image',assetRef:value.assetRef,x:value.x,z:value.z,rotation:value.rotation||0};if(value.name!==undefined)out.name=value.name;if(value.actions!==undefined)out.actions=value.actions;return out;}
 function getImageStates(){return [...compositionErrors.values(),...missingImages.values(),...[...imageViews].map(([id,view])=>{const value=view.getState();return{id,status:value.status,name:world?.objects.find(o=>o.id===id)?.name||'Image',message:value.error?.message||value.label};})];}
 function notifyImageStates(){try{imageStateListener?.(getImageStates());}catch{}}
 function syncImages(){missingImages.clear();if(!imageContext.canRead){for(const view of imageViews.values())view.dispose();imageViews.clear();notifyImageStates();return;}const ids=new Set((world?.objects||[]).filter(o=>o.type==='image').map(o=>o.id));for(const[id,view]of imageViews)if(!ids.has(id)){view.dispose();imageViews.delete(id);}for(const object of world?.objects||[]){if(object.type!=='image')continue;const entry=resolvedImage(world,object);if(!entry){imageViews.get(object.id)?.dispose();imageViews.delete(object.id);missingImages.set(object.id,{id:object.id,status:'error',name:object.name||'Image',message:'Image metadata is unavailable. Refresh Custom or remove this instance.'});continue;}const input={resolved:entry,instance:cleanImage(object),context:imageContext};if(imageViews.has(object.id))imageViews.get(object.id).update(input);else{const view=createBabylonImageObjectView({scene,texturePool:imagePool,...input,onState:notifyImageStates});imageViews.set(object.id,view);view.ready.then(notifyImageStates);} }notifyImageStates();}
 function setImageContext(next){const value={...next},previousRoom=imageContext.roomId,changed=JSON.stringify(value)!==JSON.stringify(imageContext);if(!changed)return;imageContext=value;setGhost(null);for(const view of compositionViews)view.dispose();compositionViews.clear();compositionErrors.clear();missingImages.clear();for(const view of imageViews.values())view.dispose();imageViews.clear();if(world&&value.canRead&&compositionRoomId(world)===value.roomId&&world.objects.some(object=>object.type==='composition'))sync(world);else if(world&&value.roomId===previousRoom&&value.canRead)syncImages();else notifyImageStates();}

 let botPreview=null,botPreviewLabel=null;
 let nodes=[],avatars=new Map(),world=null,floor=null,grid=[],selection=null,guide=null,ghost=null,destination=null,build=false,ghostKey=null,tick=0,frameTimes=[],motions=[];
 const brandMat=new StandardMaterial('source-bawes',scene);brandMat.diffuseTexture=new Texture('/assets/bawes-logo.png',scene);brandMat.diffuseTexture.hasAlpha=true;brandMat.useAlphaFromDiffuseTexture=true;brandMat.backFaceCulling=false;brandMat.specularColor=Color3.Black();
 function material(color,emissive=false,alpha=1){const key=color+emissive+alpha;if(materials.has(key))return materials.get(key);const m=new StandardMaterial(key,scene);m.diffuseColor=hex(color);m.specularColor=new Color3(.045,.045,.045);m.alpha=alpha;if(emissive)m.emissiveColor=hex(color).scale(.65);materials.set(key,m);return m;}
 function finish(mesh,color,parent,opts={}){mesh.parent=parent||null;mesh.metadata=parent?.metadata||opts.metadata||{type:'environment'};mesh.material=opts.surface?surfaces.material(opts.surface,color,opts.alpha??1):material(color,opts.glow,opts.alpha??1);mesh.isPickable=opts.pickable??!!parent?.metadata?.id;mesh.receiveShadows=opts.alpha==null;return mesh;}
 function box(name,x,y,z,w,h,d,color,parent,opts={}){const uv=(u,v)=>new Vector4(0,0,u,v);const m=CreateBox(name,{width:w,height:h,depth:d,faceUV:[uv(w,h),uv(w,h),uv(d,h),uv(d,h),uv(w,d),uv(w,d)]},scene);m.position.set(x,y,z);return finish(m,color,parent,opts);}
 function cylinder(name,x,y,z,r,h,color,parent,top=r,opts={}){const m=CreateCylinder(name,{height:h,diameter:r*2,diameterTop:top*2,tessellation:opts.tessellation||12},scene);m.position.set(x,y,z);return finish(m,color,parent,opts);}
 function sphere(name,x,y,z,r,color,parent,sy=1,opts={}){const m=CreateSphere(name,{diameter:r*2,segments:opts.segments||4},scene);m.position.set(x,y,z);m.scaling.y=sy;return finish(m,color,parent,opts);}
 function ground(name,x,y,z,w,d,kind,tint,parent,pickable=false){const m=CreateGround(name,{width:w,height:d,subdivisions:1},scene);m.position.set(x,y,z);const u=m.getVerticesData('uv'),v=m.getVerticesData('position');for(let i=0;i<u.length/2;i++){u[i*2]=(v[i*3]+x)/2;u[i*2+1]=(v[i*3+2]+z)/2;}m.setVerticesData('uv',u);finish(m,tint,parent,{surface:kind,pickable});return m;}

 function cutSurfaces(name,pieces,y,geometryForPiece,color,parent,opts){
  let first=null,index=0;
  for(const geometry of terrainCutGeometry(pieces,y,geometryForPiece)){
   const mesh=new Mesh(name+'-'+index++,scene),data=new VertexData();Object.assign(data,geometry);data.applyToMesh(mesh);
   finish(mesh,color,parent,opts);first??=mesh;
  }
  return first;
 }
 function groundPieces(name,pieces,y,kind,tint,parent){
  return cutSurfaces(name,pieces,y,p=>{
   const data=CreateGroundVertexData({width:p.width,height:p.depth,subdivisions:1});
   for(let i=0;i<data.uvs.length/2;i++){data.uvs[i*2]=(data.positions[i*3]+p.x)/2;data.uvs[i*2+1]=(data.positions[i*3+2]+p.z)/2;}
   return data;
  },tint,parent,{surface:kind,pickable:false});
 }
 function boxPieces(name,pieces,y,height,color,parent,opts={}){
  const uv=(u,v)=>new Vector4(0,0,u,v);
  return cutSurfaces(name,pieces,y,p=>CreateBoxVertexData({width:p.width,height,depth:p.depth,faceUV:[uv(p.width,height),uv(p.width,height),uv(p.depth,height),uv(p.depth,height),uv(p.width,p.depth),uv(p.width,p.depth)]}),color,parent,opts);
 }

 function addTerrain(terrain,parent){
  for(const {material:kind,rectangles}of terrainSurfaceGroups(terrain)){
   const surface=TERRAIN_SURFACES[kind],mesh=new Mesh('authored-terrain-'+kind,scene),data=new VertexData();
   Object.assign(data,terrainSurfaceGeometry(rectangles,surface.height));data.applyToMesh(mesh);
   finish(mesh,surface.tint,parent,{surface:kind,pickable:false});mesh.metadata={type:'terrain',material:kind};
  }
 }
 function label(id,text,kind='world'){const el=document.createElement('div');el.className='world-label '+kind;el.dataset.entity=id;el.textContent=text;labels.append(el);return el;}
 function signMaterial(title,body,kind='notice'){
  const key=kind+title+body;if(signMaterials.has(key))return signMaterials.get(key);
  const tex=new DynamicTexture('room-sign',{width:512,height:256},scene,true,Texture.TRILINEAR_SAMPLINGMODE),ctx=tex.getContext(),dark=kind==='screen';
  ctx.fillStyle=dark?'#242034':'#e5d8b8';ctx.fillRect(0,0,512,256);ctx.fillStyle=dark?'#c5b2e1':'#6b5370';ctx.fillRect(24,24,6,55);ctx.font='bold 29px sans-serif';ctx.fillText(String(title||'Universe').slice(0,28),46,57,432);
  ctx.fillStyle=dark?'#ddd2ea':'#796b65';ctx.font='19px sans-serif';const words=String(body||'Make room for possibility').split(/\s+/);let row='',y=106;
  for(const word of words){if(ctx.measureText(row+' '+word).width>424){ctx.fillText(row,45,y);y+=27;row=word;if(y>185)break;}else row+=(row?' ':'')+word;}if(y<=185)ctx.fillText(row,45,y);
  ctx.fillStyle=dark?'#e2c580':'#9a8879';ctx.font='bold 15px sans-serif';ctx.fillText('UNIVERSE',45,228);tex.update(true);
  const m=new StandardMaterial('room-sign',scene);m.diffuseTexture=tex;m.specularColor=Color3.Black();m.emissiveColor=new Color3(.14,.14,.14);signMaterials.set(key,m);return m;
 }
 function clearWorld(){for(const view of compositionViews)view.dispose();compositionViews.clear();compositionErrors.clear();guide?.dispose();guide=null;nodes.forEach(n=>n.dispose(false));nodes=[];for(const mat of signMaterials.values())mat.dispose(true,true);signMaterials.clear();grid.forEach(n=>n.dispose());grid=[];worldLabels.forEach(n=>n.el.remove());worldLabels.length=0;selection?.dispose();selection=null;motions=[];shadows.getShadowMap().renderList=[];}
 function addObject(o,{preview=false}={}){
  if(o.type==='composition'){
   const instance=cleanComposition(o),definition=resolvedComposition(world,instance);
   try{if(!definition)throw new Error('Custom furniture revision is unavailable. Refresh the library.');const view=createCompositionObjectView({scene,definition,instance,preview});if(!preview){compositionViews.add(view);view.node.onDisposeObservable.addOnce(()=>compositionViews.delete(view));nodes.push(view.node);}return view.node;}
   catch(error){if(!preview)compositionErrors.set(o.id,{id:o.id,status:'error',name:o.name||'Custom furniture',message:error.message});const node=new TransformNode('missing-composition-'+o.id,scene);if(!preview)nodes.push(node);return node;}
  }
  const t=CATALOG[o.type]||CATALOG.table,n=new TransformNode(o.id||'preview',scene);n.metadata={id:o.id,type:'object'};n.position.set(o.x,0,o.z);n.rotation.y=-(o.rotation||0)*Math.PI/180;if(!preview)nodes.push(n);
  const c=o.color||t.color,{width:w,depth:d}=dimensions(o);
  const b=(x,y,z,bw,bh,bd,col=c,opts={})=>box(o.id,x,y,z,bw,bh,bd,col,n,opts);
  const wood=(x,y,z,bw,bh,bd,col='#cfb18c')=>b(x,y,z,bw,bh,bd,col,{surface:'wood'});
  if(!['rug','portal'].includes(o.type))contact('contact-shadow',0,.043,0,Math.max(.7,w*1.25),Math.max(.7,d*1.25),n);
  if(o.type==='table'){
   wood(0,.91,0,w,.16,d,o.color?c:'#cfb18c');[-1,1].forEach(a=>[-1,1].forEach(q=>wood(a*(w/2-.18),.43,q*(d/2-.15),.14,.8,.14,'#ab8e70')));
   for(let z=-d/2+.12;z<d/2;z+=.24)b(0,1,z,w-.1,.008,.013,'#8c7159');
   b(-.48,1.006,.05,.52,.03,.36,'#dbd7c7');b(-.45,1.027,.05,.43,.008,.28,'#a59abb');
   cylinder('ceramic-cup',.56,1.105,-.14,.095,.2,'#ddd8ca',n,.095);cylinder('tea',.56,1.208,-.14,.076,.005,'#66514a',n,.076);
   b(.2,1.03,.16,.25,.045,.28,'#887caa');
  }else if(o.type==='chair'){
   wood(0,.49,0,w,.12,d,'#c9b193');b(0,.57,.02,w-.1,.08,d-.11,c,{surface:'fabric'});wood(0,.89,-d/2+.065,w,.66,.12,'#c9b193');
   [-1,1].forEach(a=>[-1,1].forEach(q=>wood(a*(w/2-.095),.25,q*(d/2-.1),.1,.48,.1,'#a7927d')));
  }else if(o.type==='sofa'){
   wood(0,.22,0,w-.16,.18,d-.1,'#9c8a77');b(0,.5,0,w,.55,d,c,{surface:'fabric'});b(0,.99,-d/2+.15,w,.61,.29,c,{surface:'fabric'});
   b(-w/2+.14,.73,0,.28,.52,d,c,{surface:'fabric'});b(w/2-.14,.73,0,.28,.52,d,c,{surface:'fabric'});
   for(let x=-w/2+.57;x<w/2-.25;x+=.67)b(x,.806,.08,.62,.13,d-.4,'#c3accc',{surface:'fabric'});
   const cushion=b(-w*.28,.99,-d*.09,.38,.35,.18,'#e2c88c',{surface:'fabric'});cushion.rotation.z=-.2;
  }else if(o.type==='plant'||o.type==='tree'){
   const tree=o.type==='tree';cylinder('terracotta',0,tree?.09:.24,0,tree?.6:.34,tree?.14:.48,tree?'#b2b99c':'#d1b291',n,tree?.6:.44,{surface:tree?'soil':'stone'});
   if(tree){cylinder('textured-trunk',0,1,0,.24,1.95,'#c1ad91',n,.16,{surface:'bark'});
    for(const [x,y,z,r,sy]of [[0,2.72,0,1.1,1.12],[-.78,2.33,.1,.89,1.12],[.68,2.47,.25,.88,1.1],[.1,2.27,-.63,.85,1.22],[-.25,3.38,.05,.64,.95]])sphere('leaf-canopy',x,y,z,r,c,n,sy,{surface:'leaves'});
   }else{for(let i=0;i<7;i++){const a=i*2.4,r=.17+i*.025;const leaf=sphere('planter-leaf',Math.cos(a)*r,.63+i*.05,Math.sin(a)*r,.24,i%2?c:'#9dba87',n,1.6,{surface:'leaves'});leaf.rotation.z=Math.sin(a)*.38;}}
  }else if(o.type==='wall'){
   b(0,1.3,0,w,2.6,d,o.color?c:'#c4bac5',{surface:'stone'});wood(0,.16,0,w,.18,d+.035,'#aa9290');wood(0,2.65,0,w+.1,.1,d+.09,'#cdb8ae');
  }else if(o.type==='lamp'){
   cylinder('lamp-base',0,.055,0,.24,.11,'#756777',n);cylinder('lamp-pole',0,1.06,0,.055,2.06,'#74657a',n);
   b(0,2.05,0,.32,.43,.32,'#ffe3a4',{glow:true});b(0,2.31,0,.5,.09,.5,'#675b70');b(0,1.81,0,.4,.075,.4,'#675b70');
   for(const x of [-.17,.17])for(const z of [-.17,.17])b(x,2.05,z,.035,.49,.035,'#736178');
  }else if(o.type==='screen'){
   b(0,.69,0,.13,1.35,.13,'#776884');b(0,1.73,0,w,1.43,.14,'#494051');const display=CreatePlane('room-display',{width:w-.14,height:1.29},scene);display.position.set(0,1.73,.087);display.rotation.y=Math.PI;display.parent=n;display.material=signMaterial(o.name,o.text||'Open this screen to see its shared room content.','screen');display.metadata=n.metadata;display.isPickable=!preview;b(0,.06,0,w*.44,.1,.58,'#796a83');
  }else if(o.type==='podium'){
   wood(0,.61,0,w,.95,d,o.color?c:'#c4a3a8');wood(0,1.13,-.08,w+.12,.12,d+.15,'#d3b8b9');b(0,1.43,0,.05,.5,.05,'#40344d');
  }else if(o.type==='portal'){
   cylinder('portal-paving',0,.066,0,1.27,.09,'#ddd0b4',n,1.27,{surface:'stone',tessellation:32});
   const ring=CreateTorus('portal-halo',{diameter:1.8,thickness:.09,tessellation:40},scene);ring.parent=n;ring.rotation.x=Math.PI/2;ring.position.y=1.3;ring.material=material(c,true);ring.metadata=n.metadata;ring.isPickable=!preview;ring.metadata.dynamic=true;
   const rim=CreateTorus('portal-rim',{diameter:2.03,thickness:.05,tessellation:40},scene);rim.parent=n;rim.rotation.x=Math.PI/2;rim.position.y=1.3;rim.material=material('#d4c5db');rim.metadata=n.metadata;
   const glow=CreatePlane('portal-window',{width:1.65,height:1.65,sideOrientation:Mesh.DOUBLESIDE},scene);glow.parent=n;glow.position.y=1.3;glow.material=material(c,true,.13);glow.metadata=n.metadata;
   if(!preview){motions.push({mesh:ring,kind:'portal',phase:o.x});worldLabels.push({el:label(o.id,o.name,'portal-label'),position:new Vector3(o.x,2.7,o.z)});}
  }else if(o.type==='rug'){
   b(0,.065,0,w,.015,d,c,{surface:'fabric'});for(const s of [-1,1])b(0,.077,s*(d/2-.11),w-.12,.008,.055,'#d6bbbd');
  }else if(o.type==='board'){
   wood(0,1.28,0,w,1.15,.16,o.color?c:'#bda585');const poster=CreatePlane('room-notice',{width:w-.17,height:.96},scene);poster.position.set(0,1.28,.093);poster.rotation.y=Math.PI;poster.parent=n;poster.material=signMaterial(o.name,o.text);poster.metadata=n.metadata;poster.isPickable=!preview;
   wood(-w*.35,.48,0,.12,.96,.13);wood(w*.35,.48,0,.12,.96,.13);
   const emblem=CreatePlane('bawes-notice',{width:.13,height:.175},scene);emblem.position.set(w*.36,1.02,.115);emblem.rotation.y=Math.PI;emblem.parent=n;emblem.material=brandMat;emblem.metadata=n.metadata;
  }else if(o.type==='bench'){
   for(let z=-d/2+.09;z<d/2;z+=.19)wood(0,.56,z,w,.13,.16,o.color?c:'#d0af86');
   wood(-w*.35,.27,0,.17,.52,.5,'#b09779');wood(w*.35,.27,0,.17,.52,.5,'#b09779');
  }else if(o.type==='rock')sphere('weathered-stone',0,.34,0,.64,c,n,.66,{surface:'stone',segments:3});
  return n;
 }
 function sync(newWorld){
  if(!newWorld)return;if(ghostComposition&&(compositionRoomId(world)!==compositionRoomId(newWorld)||!resolvedComposition(newWorld,ghostComposition)))setGhost(null);world=newWorld;clearWorld();botPreview?.setWorld(world);rig.setBounds(world.bounds);
  const root=new TransformNode('environment',scene);nodes.push(root);floor=buildEnvironment(world,root,{box,cylinder,sphere,ground,groundPieces,boxPieces,material});floor.metadata={type:'ground'};addTerrain(world.terrain,root);
  for(const o of world.objects)if(o.type!=='image')addObject(o);syncImages();
  if(build)for(const a of world.areas){
   const col=a.start?'#8bdbc8':{silent:'#67bdae',meeting:'#b09add',stage:'#e0bd77',audience:'#bc9bca',welcome:'#9eccab',teleport:'#c3a8fa'}[a.action]||'#aa9cc2';box(a.id,a.x,.083,a.z,a.width,.015,a.depth,col,root,{alpha:.15,pickable:false,metadata:{id:a.id,type:'area'}});
   const marker=label(a.id,a.start?'Arrival: '+a.name+(a.start.isDefault?' · default':''):a.name,'area-label'+(a.start?' arrival-label':''));
   if(a.start){
    marker.dataset.arrivalKey=a.start.key;marker.dataset.arrivalDefault=String(a.start.isDefault===true);marker.title='Entry key: '+a.start.key;
    const diameter=Math.min(.9,a.width*.6,a.depth*.6),ring=CreateTorus('arrival-marker-'+a.id,{diameter,thickness:.055,tessellation:20},scene);ring.position.set(a.x,.14,a.z);finish(ring,col,root,{pickable:false,metadata:{id:a.id,type:'area'}});
    cylinder('arrival-centre-'+a.id,a.x,.14,a.z,diameter*.1,.025,col,root,diameter*.1,{pickable:false,metadata:{id:a.id,type:'area'}});
   }
   worldLabels.push({el:marker,position:new Vector3(a.x,.5,a.z)});
  }
  // Merge by material, pickability and shadow behavior, preserving exact face ranges.
  const batches=new Map();for(const parent of nodes)for(const mesh of parent.getChildMeshes()){
   if(mesh===floor||!mesh.getTotalVertices()||mesh.metadata?.dynamic)continue;
   const key=mesh.material?.uniqueId+':'+mesh.isPickable+':'+mesh.receiveShadows;
   if(!batches.has(key))batches.set(key,[]);batches.get(key).push(mesh);
  }
  const mergeGroups=[];for(const meshes of batches.values()){
   if(!world.terrain?.cells?.length){mergeGroups.push(meshes);continue;}
   let group=[],vertices=0;for(const mesh of meshes){const count=mesh.getTotalVertices();if(vertices+count>TERRAIN_BATCH_VERTEX_LIMIT&&group.length){mergeGroups.push(group);group=[];vertices=0;}group.push(mesh);vertices+=count;}if(group.length)mergeGroups.push(group);
  }
  for(const meshes of mergeGroups){
   if(meshes.length<2)continue;const ranges=[];let face=0;
   for(const m of meshes){m.computeWorldMatrix(true);const count=m.getTotalIndices()/3;ranges.push({start:face,end:face+count,metadata:m.metadata});face+=count;}
   const mat=meshes[0].material,pickable=meshes[0].isPickable,receive=meshes[0].receiveShadows;const merged=Mesh.MergeMeshes(meshes,true,true);
   if(merged){merged.material=mat;merged.parent=root;merged.isPickable=pickable;merged.receiveShadows=receive;merged.metadata={type:'batch',ranges};}
  }
  for(const parent of nodes){parent.computeWorldMatrix(true);for(const mesh of parent.getChildMeshes()){mesh.computeWorldMatrix(true);if(!mesh.metadata?.dynamic)mesh.freezeWorldMatrix();if(mesh!==floor&&mesh.isPickable&&mesh.material?.alpha===1)shadows.addShadowCaster(mesh);}}
  shadows.getShadowMap().refreshRate=0;shadows.getShadowMap().resetRefreshCounter();
  if(build){const w=world.bounds.width,d=world.bounds.depth,lines=[];for(let x=-w/2;x<=w/2;x++)lines.push([new Vector3(x,.093,-d/2),new Vector3(x,.093,d/2)]);for(let z=-d/2;z<=d/2;z++)lines.push([new Vector3(-w/2,.093,z),new Vector3(w/2,.093,z)]);const l=CreateLineSystem('build-grid',{lines,useVertexAlpha:true},scene);l.color=hex('#b8aacc');l.alpha=.28;l.isPickable=false;grid.push(l);}
  updateCamera();
 }
 function avatar(p){let a=avatars.get(p.id);const appearance=p.appearance??p.woka,key=JSON.stringify(appearance);
  if(!a){const character=createAvatarRig(scene,appearance,{id:p.id});const shadow=contact('avatar-contact',p.x,.084,p.z,.9,.9);a={rig:character,shadow,el:label(p.id,p.name,'player-label'),appearanceKey:key,x:p.x,z:p.z};avatars.set(p.id,a);}
  if(a.appearanceKey!==key){a.rig.setAppearance(appearance);a.appearanceKey=key;}
  a.p=p;for(const mesh of a.rig.meshes){mesh.isPickable=p.kind==='bot';if(p.kind==='bot')mesh.metadata={type:'bot',id:p.id};}const labelText=(p.emote?p.emote+' ':'')+p.name+(p.kind==='bot'?' · Bot':'');if(a.el.textContent!==labelText)a.el.textContent=labelText;a.el.classList.toggle('self',!!p.self);a.el.classList.toggle('away',p.status==='away');return a;
 }
 function syncPeople(people){const seen=new Set();for(const p of people){seen.add(p.id);avatar(p);}for(const [id,a]of avatars)if(!seen.has(id)){a.rig.dispose();a.shadow.dispose();a.el.remove();avatars.delete(id);}}

 function updateCamera(){const p=rig.getPosition(),s=rig.getState();camera.position.set(p.x,p.y,p.z);camera.setTarget(new Vector3(s.target.x,.6,s.target.z));camera.getViewMatrix(true);camera.unfreezeProjectionMatrix();const projection=camera.getProjectionMatrix(true);const shift=projectionShift(framing.offset,canvas.clientWidth,canvas.clientHeight);projection.setRowFromFloats(2,projection.m[8]+shift.x,projection.m[9]+shift.y,projection.m[10],projection.m[11]);camera.freezeProjectionMatrix(projection);scene.updateTransformMatrix(true);}
 function updateFraming(dt){
  const s=rig.getState();if(s.framingMode==='manual'){framing={...framing,status:'manual',offset:framingTransition.step(null,dt,{manual:true})};return;}
  const {panels,hud}=measurePanelOcclusion(canvas),points=[],anchor=s.follow?s.player:s.target;
  // Conservative envelope includes the widest avatar/accessory and label anchor.
  // Remove the existing shift before fitting; otherwise projection feeds itself.
  for(const x of [-.72,.72])for(const z of [-.72,.72])for(const y of [.02,2.85]){const p=screenPoint(anchor.x+x,anchor.z+z,y);points.push({x:p.x-framing.offset.x,y:p.y-framing.offset.y});}
  const footprint={left:Math.min(...points.map(p=>p.x)),right:Math.max(...points.map(p=>p.x)),top:Math.min(...points.map(p=>p.y)),bottom:Math.max(...points.map(p=>p.y))};
  const input={width:canvas.clientWidth,height:canvas.clientHeight,panels,hud,footprint};const key=JSON.stringify(input,(_,v)=>typeof v==='number'?Math.round(v*4)/4:v);
  if(key!==framingKey){framingGoal=frameInFreeArea(input);framingKey=key;}
  framing={...framingGoal,offset:framingTransition.step(framingGoal?.offset,dt)};
 }
 function project(v){return Vector3.Project(v,Matrix.Identity(),scene.getTransformMatrix(),camera.viewport.toGlobal(engine.getRenderWidth(),engine.getRenderHeight()));}
 function screenPoint(x,z,y=0){if(presentation.isSuppressed())return{x:0,y:0,visible:false};const p=project(new Vector3(x,y,z));const sx=p.x*canvas.clientWidth/engine.getRenderWidth(),sy=p.y*canvas.clientHeight/engine.getRenderHeight();return {x:sx,y:sy,visible:p.z>=0&&p.z<=1&&sx>=0&&sx<=canvas.clientWidth&&sy>=0&&sy<=canvas.clientHeight};}
 function positionLabel(el,v){const p=screenPoint(v.x,v.z,v.y);el.style.display='';el.style.transform=`translate(${p.x}px,${p.y}px) translate(-50%,-100%)`;pendingLabels.push({el,visible:p.visible});}
 function resolveLabelVisibility(){
  const viewport=canvas.getBoundingClientRect(),obstacles=[];
  for(const element of document.querySelectorAll(WORLD_LABEL_OCCLUDERS)){
   if(element.hidden||element.closest('[hidden]')||!element.getClientRects().length)continue;
   const style=getComputedStyle(element);if(style.visibility==='hidden'||style.display==='none'||Number(style.opacity)===0)continue;
   const rect=element.getBoundingClientRect();if(rect.width>0&&rect.height>0)obstacles.push(rect);
  }
  // All transforms are written before layout is read; visibility does not reflow.
  const visibility=pendingLabels.map(({el,visible})=>({el,visible:visible&&labelFits(el.getBoundingClientRect(),viewport,obstacles,9)}));
  for(const {el,visible}of visibility){el.style.visibility=visible?'visible':'hidden';el.dataset.hudOccluded=visible?'false':'true';}
  pendingLabels.length=0;
 }

 function setPresentationSuspended(value){
  if(!presentation.setSuspended(value))return;
  if(value){if(labelsHiddenBeforePause===null)labelsHiddenBeforePause=labels.hidden;labels.hidden=true;}
  // Keep labels hidden on close until the first current-state world draw completes.
 }
 function restoreLabels(){if(labelsHiddenBeforePause!==null){labels.hidden=labelsHiddenBeforePause;labelsHiddenBeforePause=null;}}
 function resize(){if(presentation.isSuppressed()){resizePending=true;return;}resizeRenderBuffer(engine,canvas,WORLD_RENDER_PIXELS);updateCamera();}
 function render(dt,actualDt=dt){
  const frame=presentation.nextFrame(dt,actualDt);if(!frame)return;
  dt=frame.dt;actualDt=frame.actualDt;
  if(resizePending){resizePending=false;resizeRenderBuffer(engine,canvas,WORLD_RENDER_PIXELS);}
  // Restore before measuring label rects (hidden elements have zero bounds).
  // The following layout + world draw complete in this same task before paint.
  restoreLabels();
  tick+=dt;const ambienceMotion=!motionPreference.matches&&!build;if(ambienceMotion)ambienceTime+=dt;surfaces.tick(ambienceTime,{motion:ambienceMotion});frameTimes.push(actualDt*1000);if(frameTimes.length>300)frameTimes.shift();const s=rig.step(dt);updateCamera();updateFraming(actualDt);updateCamera();
  for(const a of avatars.values()){
   const p=a.p,rate=p.self||frame.resumed?1:1-Math.exp(-dt*20);a.x+=(p.x-a.x)*rate;a.z+=(p.z-a.z)*rate;
   const motion=resolveAvatarMotion(p);
   a.rig.update({position:{x:a.x,y:.08,z:a.z},...motion,dt,time:tick});
   a.shadow.position.set(a.x,.084,a.z);positionLabel(a.el,new Vector3(a.x,2.48,a.z));
  }
  for(const motion of motions){if(motion.kind==='portal'){const p=1+Math.sin(ambienceTime*1.8+motion.phase)*.025;motion.mesh.scaling.setAll(p);}}
  for(const marker of [destination,guide])if(marker){const p=1+Math.sin(ambienceTime*4)*.09;marker.scaling.setAll(p);marker.position.y=.105+Math.sin(ambienceTime*3)*.014;}
  if(botPreview){botPreview.tick(dt,tick);positionLabel(botPreviewLabel,new Vector3(botPreview.position.x,2.8,botPreview.position.z));}
  for(const l of worldLabels)positionLabel(l.el,l.position);resolveLabelVisibility();engine._drawCalls?.fetchNewFrame();scene.render();drawnFrames++;lastRenderDt=dt;
 }
 function pick(clientX,clientY){
  if(presentation.isSuppressed())return {id:undefined,type:undefined,point:null};
  updateCamera();const rect=canvas.getBoundingClientRect(),scale=engine.getHardwareScalingLevel();
  // Babylon divides ray inputs by hardware scale. Convert CSS to its input
  // space once, including framebuffer rounding; never apply DPR separately.
  const x=(clientX-rect.left)*engine.getRenderWidth()*scale/rect.width,y=(clientY-rect.top)*engine.getRenderHeight()*scale/rect.height;
  const ray=scene.createPickingRay(x,y,Matrix.Identity(),camera);const picked=pickWithImageAlpha(scene,ray,m=>m.isPickable&&m!==floor&&m.metadata?.type!=='area'&&m.metadata?.type!=='image-ghost');let metadata=picked?.pickedMesh?.metadata;
  if(metadata?.type==='batch')metadata=metadata.ranges.find(r=>picked.faceId>=r.start&&picked.faceId<r.end)?.metadata;
  const distance=-ray.origin.y/ray.direction.y;
  const point=Number.isFinite(distance)&&distance>=0?{x:ray.origin.x+ray.direction.x*distance,z:ray.origin.z+ray.direction.z*distance}:null;
  return {id:metadata?.id,type:metadata?.type,componentId:metadata?.componentId,assetRef:metadata?.assetRef,point};
 }
 function outline(o,color,height=.11,parent=null){if(o.type==='composition'){const geometry=compositionGeometry(world,cleanComposition(o)),points=geometry.editBounds.corners.map(p=>new Vector3(p.x,height,p.z));points.push(points[0].clone());const line=CreateLines('composition-footprint',{points},scene);line.color=hex(color);line.isPickable=false;line.parent=parent;return line;}if(o.type==='image'){const geometry=imageGeometry(world,cleanImage(o)),points=geometry.editBounds.corners.map(p=>new Vector3(p.x,height,p.z));points.push(points[0].clone());const line=CreateLines('image-footprint',{points},scene);line.color=hex(color);line.isPickable=false;line.parent=parent;return line;}const {width,depth}=o.type==='area'||o.type==='terrain'?o:dimensions(o,world);const angle=-(o.rotation||0)*Math.PI/180,cs=Math.cos(angle),sn=Math.sin(angle);const points=[[-1,-1],[1,-1],[1,1],[-1,1],[-1,-1]].map(([x,z])=>{const padding=o.type==='terrain'?0:.055,px=x*(width/2+padding),pz=z*(depth/2+padding);return new Vector3((parent?0:o.x)+px*cs+pz*sn,height,(parent?0:o.z)-px*sn+pz*cs);});const n=CreateLines('footprint',{points},scene);n.color=hex(color);n.isPickable=false;n.parent=parent;return n;}
 function select(id){
  selection?.dispose();selection=null;
  const o=world?.objects.find(o=>o.id===id)||world?.areas.find(o=>o.id===id);if(!o)return;
  try{
   const shape={...o,type:o.type||'area'},line=outline(shape,'#ffe29b');
   selection=new TransformNode('selection-frame',scene);line.parent=selection;
   const positions=line.getVerticesData('position'),corners=[];
   for(let i=0;i<4;i++)corners.push(new Vector3(positions[i*3],positions[i*3+1],positions[i*3+2]));
   // Eight short, world-space corner strokes survive minification better than
   // a one-pixel line. Normal depth testing deliberately preserves occlusion.
   // Merged into two meshes (ink edge + gold inset), independent of room size.
   for(const [color,width,y]of [['#302c37',.09,.112],['#ffe29b',.045,.124]]){
    const strokes=[];
    for(let i=0;i<4;i++)for(const neighbor of [(i+1)%4,(i+3)%4]){
     const from=corners[i],delta=corners[neighbor].subtract(from),length=Math.min(.3,delta.length()*.23);
     if(length<.001)continue;const direction=delta.normalize(),mid=from.add(direction.scale(length/2));
     const stroke=box('selection-corner',mid.x,y,mid.z,length,.009,width,color,null,{glow:true,pickable:false});stroke.rotation.y=-Math.atan2(direction.z,direction.x);stroke.receiveShadows=false;strokes.push(stroke);
    }
    const merged=Mesh.MergeMeshes(strokes,true,true);if(merged){merged.parent=selection;merged.isPickable=false;merged.receiveShadows=false;}
   }
  }catch{selection?.dispose();selection=null;notifyImageStates();}
 }

 function setGhost(value){
  ghostComposition=value?.type==='composition'?cleanComposition(value):null;
  if(!value){ghostImage?.dispose();ghostImage=null;ghost?.dispose();ghost=null;ghostKey=null;return;}
  const {x,z,...style}=value,key=JSON.stringify(style);if(ghost&&key===ghostKey){ghost.position.set(x,0,z);if(value.type==='image')updateImageGhost(value);return;}
  ghostImage?.dispose();ghostImage=null;ghost?.dispose();const valid=value.valid!==false,col=!valid?'#ff687c':value.type==='terrain'?(value.erase?'#b7dfef':value.blocked?'#edc77c':'#73d8ac'):'#73edaa';ghost=new TransformNode('build-preview',scene);ghost.position.set(x,0,z);ghostKey=key;
  const mat=material(col,true,value.type==='terrain'?.3:.32);mat.disableLighting=true;mat.emissiveColor=hex(col);
  if(value.type==='terrain'){
   const fill=CreateGround('terrain-preview-fill',{width:value.width,height:value.depth},scene);fill.position.y=.104;fill.parent=ghost;fill.material=mat;fill.isPickable=false;fill.receiveShadows=false;
   const lines=CreateLineSystem('terrain-preview-cells',{lines:terrainGhostLines(value.width,value.depth).map(line=>line.map(point=>new Vector3(...point)))},scene);lines.parent=ghost;lines.color=hex(col);lines.alpha=.65;lines.isPickable=false;
  }
  else if(value.type==='area')box('area-preview',0,.13,0,value.width||4,.08,value.depth||3,col,ghost,{alpha:.23,pickable:false});
  else if(value.type==='image')updateImageGhost(value);
  else{const object=addObject({...value,id:'ghost-preview',x:0,z:0},{preview:true});object.parent=ghost;for(const mesh of object.getChildMeshes()){mesh.material=mat;mesh.isPickable=false;mesh.receiveShadows=false;}}
  const shape=outline({...value,x:0,z:0},col,.16);shape.parent=ghost;
  if(value.type==='composition')return;
  const dims=value.type==='area'||value.type==='terrain'?value:dimensions(value,world),frame=new TransformNode('ghost-frame',scene);frame.parent=ghost;frame.rotation.y=-(value.rotation||0)*Math.PI/180;
  for(const side of [-1,1]){box('preview-edge',0,.105,side*dims.depth/2,dims.width+.06,.035,.055,col,frame,{glow:true,pickable:false});box('preview-edge',side*dims.width/2,.105,0,.055,.035,dims.depth+.06,col,frame,{glow:true,pickable:false});}
 }
 function updateImageGhost(value){const entry=resolvedImage(world,value);if(!entry)return;const input={resolved:entry,instance:cleanImage(value,'image-preview'),context:imageContext},style=()=>{if(!ghostImage)return;const mesh=ghostImage.node.imageParts.mesh;mesh.isPickable=false;mesh.metadata={...mesh.metadata,type:'image-ghost'};mesh.material.diffuseColor=hex(value.valid===false?'#ff9c9c':'#adf4c9');};if(ghostImage){ghostImage.update(input);style();}else{ghostImage=createBabylonImageObjectView({scene,texturePool:imagePool,...input,onState:style});style();ghostImage.ready.then(style);}}
 function marker(name,target,color,size){if(!target)return null;const m=CreateTorus(name,{diameter:size,thickness:.07,tessellation:40},scene);m.position.set(target.x,.11,target.z);m.material=material(color,true);m.isPickable=false;return m;}
 const act=fn=>(...args)=>{fn(...args);updateCamera();};
 resize();window.addEventListener('resize',resize);
 function setBotPreview(bot){if(!bot){botPreview?.dispose();botPreview=null;botPreviewLabel?.remove();botPreviewLabel=null;return;}if(!botPreview){botPreview=createBotMapPreview(scene,bot,world);botPreviewLabel=label('resident-draft','Draft · '+bot.name,'player-label');}else{botPreview.set(bot);botPreviewLabel.textContent='Draft · '+bot.name;}}
 return {sync,syncPeople,render,setPresentationSuspended,pick,select,screenPoint,setGhost,setBotPreview,setImageContext,getImageStates,setImageStateListener(fn){imageStateListener=fn;notifyImageStates();},async retryImage(id){if(!imageContext.canRead)return false;const view=imageViews.get(id);if(!view)return false;const result=await view.retry();return result.status==='ready';},
  setDestination(target){if(destination&&target&&Math.hypot(destination.position.x-target.x,destination.position.z-target.z)<.01)return;destination?.dispose();destination=marker('walk-destination',target,'#ffe6a4',.75);},
  setGuide(target){guide?.dispose();guide=marker('quest-marker',target,'#e9c74c',1.7);},
  setBuild(v){if(build===v)return;build=v;setGhost(null);sync(world);},
  focusPoint:act((x,z)=>rig.focusPoint(x,z)),setTarget:(x,z)=>rig.setTarget(x,z),orbit:act((dx,dy)=>rig.orbit(dx,dy)),pan:act((dx,dy)=>rig.pan(dx,dy,canvas.clientHeight)),zoom:act(delta=>rig.zoom(delta)),rotate:act(delta=>rig.rotate(delta)),resetCamera:act(()=>rig.reset()),setFollow:act(v=>rig.setFollow(v)),
  getCameraState:()=>({...rig.getState(),projection:'perspective',viewportWidth:camera.viewport.width,framing:structuredClone({...framing,targetOffset:framingGoal?.offset||null})}),getCameraAngle:()=>rig.getState().yaw,
  getStats:()=>({presentation:{...presentation.snapshot(),drawnFrames,lastRenderDt,resizePending,avatarCount:avatars.size,actors:[...avatars].map(([id,a])=>({id,x:a.x,z:a.z}))},ambience:{reducedMotion:motionPreference.matches,paused:motionPreference.matches||build,time:ambienceTime},compositions:{instances:compositionViews.size,components:[...compositionViews].reduce((sum,view)=>sum+view.meshes.length,0),errors:[...compositionErrors.values()]},resources:{materials:scene.materials.length,textures:scene.textures.length,geometries:scene.geometries.length,nodes:scene.transformNodes.length},engine:'Babylon WebGL'+engine.webGLVersion,meshes:scene.meshes.length,drawCalls:engine._drawCalls?.current??null,frameMs:frameTimes.slice(),textures:surfaces.textures.size,camera:rig.getState(),hardwareScalingLevel:engine.getHardwareScalingLevel(),renderWidth:engine.getRenderWidth(),renderHeight:engine.getRenderHeight()}),
  dispose(){restoreLabels();setBotPreview(null);setGhost(null);clearWorld();for(const a of avatars.values())a.el.remove();avatars.clear();destination?.dispose();destination=null;ghostImage?.dispose();for(const view of imageViews.values())view.dispose();imageViews.clear();imagePool.dispose();window.removeEventListener('resize',resize);engine.dispose();},ready:scene.whenReadyAsync()};
}
