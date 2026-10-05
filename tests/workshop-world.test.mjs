import test from 'node:test';
import assert from 'node:assert/strict';
import {NullEngine} from '@babylonjs/core/Engines/nullEngine.js';
import {Scene} from '@babylonjs/core/scene.js';
import {Vector3} from '@babylonjs/core/Maths/math.vector.js';
import {Ray} from '@babylonjs/core/Culling/ray.js';
import {quaternion,multiply,rotateVector} from '../modules/asset-workshop/model.js';
import {resolveCompositionPlacement,compositionPlacementInside,validateCompositionObject} from '../src/composition-geometry.js';
import {bindCompositionDefinitions,compositionDefinitions,compositionGeometry,bindCompositionObject,resolvedComposition,inheritCompositionDefinitions} from '../src/composition-context.js';
import {cloneWithImageContext,inheritImageDefinitions} from '../src/image-asset-context.js';
import {emptyScene,clone,canStand,collisionBoxes,collisionBox,dimensions,findPath,movePlayer} from '../src/worlds.js';
import {validatePlacement,validateTerrainEdit} from '../src/editor-geometry.js';
import {objectFootprint,editablePersonalArea,canEditPersonalObject} from '../src/personal-area-policy.js';
import {personalEditPolicy} from '../src/personal-editor-policy.js';
import {applySceneOperations,sceneOperationDependencyView} from '../src/scene-operations.js';
import {reconcileScenes,createSceneOperationRequest,reconciliationGeometryProblem} from '../src/editor-collaboration.js';
import {createCompositionObjectView} from '../src/composition-renderer.js';

const approx=(a,b,epsilon=1e-7)=>assert(Math.abs(a-b)<epsilon,`${a} != ${b}`);
const vec=(a,b)=>a.forEach((value,index)=>approx(value,b[index]));
const part=(id,position=[0,1,0],size=[2,2,1],extra={})=>({id,name:id,shape:'box',position,rotation:[0,0,0,1],size,materialId:'wood',groupId:null,collision:'box',...extra});
function fixture(components=[part('base')]){
 const definition={format:'universe-asset-workshop',version:1,asset:{id:'furniture1',revision:1,name:'Custom chair'},materials:[{id:'wood',name:'Wood',color:'#a36b49',roughness:.72,textureRef:null}],groups:[],components};
 const item={id:'placed-1',type:'composition',name:'My chair',x:0,z:0,rotation:0,assetRef:{assetId:'furniture1',revision:1}},scene={...emptyScene(),bounds:{width:24,depth:24},objects:[item]},definitions={'furniture1:1':definition};
 return {definition,item,scene,definitions};
}
function bound(components){const f=fixture(components);bindCompositionDefinitions(f.scene,f.definitions,'room1');return f;}

test('composition scene records require exact pinned references and only cardinal ground transforms',()=>{
 const f=fixture();assert.deepEqual(validateCompositionObject(f.item),f.item);
 for(const patch of [{rotation:45},{x:Infinity},{x:'0'},{assetRef:{assetId:'furniture1',revision:0}},{assetRef:{assetId:'furniture1',revision:1,components:[]}},{scale:.1},{y:2},{components:[]},{name:''},{name:'\u0000'}, {[Symbol('data')]:true}])assert.throws(()=>validateCompositionObject({...f.item,...patch}));
 const accessor={...f.item};Object.defineProperty(accessor,'name',{get(){throw new Error('Getter ran');},enumerable:true});assert.throws(()=>validateCompositionObject(accessor),/fields/);
 for(const key of Object.keys(f.item)){const missing={...f.item};delete missing[key];assert.throws(()=>validateCompositionObject(missing));}
 assert.throws(()=>resolveCompositionPlacement({...f.definition,components:[]},f.item),/component/);
 assert.throws(()=>resolveCompositionPlacement(f.definition,{...f.item,assetRef:{assetId:'furniture1',revision:2}}),/exact/);
});

test('native room yaw composes authored XYZ rotations and anchors every part at the same ground offset',()=>{
 const rotation=multiply(quaternion('z',25),quaternion('x',35));
 const f=fixture([part('tilt',[1,3,-2],[2,1,3],{rotation}),part('low',[-1,-3,1],[1,2,1],{collision:'none'})]);
 for(const turn of [0,90,180,270]){
  const item={...f.item,x:4,z:2,rotation:turn},placement=resolveCompositionPlacement(f.definition,item),native=quaternion('y',-turn);
  approx(placement.renderBounds.minY,0);approx(placement.transform.y,4);
  for(let index=0;index<f.definition.components.length;index++){
   const source=f.definition.components[index],world=placement.components[index];
   vec(world.rotation,multiply(native,source.rotation));
   vec(world.position,rotateVector(source.position,native).map((value,axis)=>value+[4,4,2][axis]));
  }
 }
 const f2=fixture([part('off-centre',[2,1,0])]),p=resolveCompositionPlacement(f2.definition,{...f2.item,rotation:90});
 approx(p.editBounds.x,0);approx(p.editBounds.z,2);approx(p.editBounds.width,1);approx(p.editBounds.depth,2);
});

test('collision boxes project each collider separately while edit bounds cover decorative components',()=>{
 const f=bound([part('left',[-2,1,0],[1,2,1]),part('right',[2,1,0],[1,2,1]),part('canopy',[0,4,0],[7,.5,2],{collision:'none'})]);
 const p=compositionGeometry(f.scene,f.item);assert.equal(p.collisionCells.length,2);approx(p.editBounds.width,7);approx(p.editBounds.depth,2);
 assert.equal(canStand(f.scene,0,0),true);assert.equal(canStand(f.scene,-2,0),false);assert.equal(canStand(f.scene,2,0),false);
 assert(findPath(f.scene,{x:0,z:3},{x:0,z:-3}).length);assert(movePlayer(f.scene,{x:-3,z:0},1,0).x<-2.6);
 const chair={id:'chair',type:'chair',name:'Chair',x:0,z:0,rotation:0};assert.equal(validatePlacement(f.scene,chair).valid,true);assert.equal(validatePlacement(f.scene,{...chair,x:-2}).valid,false);
 const small={x:0,z:0,width:5,depth:3,ownerId:'me'},large={...small,width:7};assert.equal(editablePersonalArea([small],f.item,'me'),null);assert.equal(editablePersonalArea([large],f.item,'me'),large);
 assert.equal(compositionPlacementInside(small,f.definition,f.item),false);assert.equal(compositionPlacementInside(large,f.definition,f.item),true);
 const foreign={x:3,z:0,width:1,depth:1,ownerId:'them'};assert.equal(editablePersonalArea([large,foreign],f.item,'me'),null);
});

test('raised colliders block at ground level conservatively; rotations widen tilted collider footprints',()=>{
 const f=bound([part('overhead',[0,6,0],[4,1,1],{rotation:quaternion('y',45)}),part('base',[0,0,0],[.1,.1,.1],{collision:'none'})]);
 const box=collisionBoxes(f.scene,f.item)[0];approx(box.width,5/Math.sqrt(2));approx(box.depth,5/Math.sqrt(2));assert.equal(canStand(f.scene,1,1),false);
});

test('room bounds include offset and noncolliding geometry; preview collision protects arrival and terrain',()=>{
 const f=bound([part('base'),part('decoration',[3,2,0],[2,1,1],{collision:'none'})]);
 assert.equal(validatePlacement(f.scene,{...f.item,x:9}).valid,false);
 assert.equal(validatePlacement(f.scene,{...f.item,z:7}).valid,false);
 f.scene.terrain={version:1,cells:[[4,0,'stone',true]]};
 assert.equal(validatePlacement(f.scene,{...f.item,x:4.5,z:.5}).valid,false);
 assert.equal(validateTerrainEdit(f.scene,{x:0,z:0,width:1,depth:1},{material:'stone',blocked:true}).valid,false);
 const allDecor=bound([part('decoration',[0,1,0],[2,2,2],{collision:'none'})]);assert.equal(collisionBoxes(allDecor.scene,allDecor.item).length,0);assert.equal(validatePlacement(allDecor.scene,allDecor.item).valid,true);assert.equal(canStand(allDecor.scene,0,0),true);
});

test('bound immutable room definitions never serialize or accept client-embedded geometry',()=>{
 const f=fixture(),json=JSON.stringify(f.scene);assert.equal(resolvedComposition(f.scene,f.item),null);
 f.scene.compositionDefinitions=f.definitions;assert.equal(resolvedComposition(f.scene,f.item),null);assert.equal(objectFootprint(f.item),null);delete f.scene.compositionDefinitions;
 bindCompositionDefinitions(f.scene,f.definitions,'room1');assert.equal(JSON.stringify(f.scene),json);assert(Object.isFrozen(compositionDefinitions(f.scene)['furniture1:1'].components[0].size));
 f.definition.components[0].size[0]=20;approx(collisionBox(f.item,f.scene).width,2);
 assert.throws(()=>bindCompositionDefinitions(f.scene,{wrong:f.definition}));assert.throws(()=>bindCompositionDefinitions(f.scene,{...f.definitions,extra:{evil:true}}));
 assert.equal(canStand(f.scene,0,0),false);const missing={...f.item,assetRef:{assetId:'missing',revision:1}};f.scene.objects.push(missing);assert.equal(canStand(f.scene,8,8),false);assert.equal(validatePlacement(f.scene,{id:'other',type:'chair',x:8,z:8}).valid,false);
});

test('clone, inherited preview, operation replacement and scene-less personal checks retain composition context',()=>{
 const f=bound(),copy=clone(f.scene);assert.deepEqual(compositionGeometry(copy,copy.objects[0]),compositionGeometry(f.scene,f.item));assert.deepEqual(objectFootprint(copy.objects[0]),objectFootprint(f.item));
 const itemCopy=clone(f.item);assert.deepEqual(objectFootprint(itemCopy),objectFootprint(f.item));const roomCopy=cloneWithImageContext({scene:f.scene});assert.deepEqual(objectFootprint(roomCopy.scene.objects[0]),objectFootprint(f.item));
 const derived=inheritImageDefinitions(f.scene,{...f.scene,objects:[]});assert.equal(compositionDefinitions(derived),compositionDefinitions(f.scene));
 const preview=bindCompositionObject(f.scene,{...f.item,id:'preview',x:4});approx(objectFootprint(preview).x,4);
 const next=applySceneOperations(f.scene,[{kind:'object',id:f.item.id,after:{...f.item,x:2}}]);approx(objectFootprint(next.objects[0]).x,2);assert.equal(canStand(next,2,0),false);
 const rebound=inheritCompositionDefinitions(f.scene,{...f.scene,objects:[{...f.item}]});assert(objectFootprint(rebound.objects[0]));
 bindCompositionDefinitions(copy,{},'room2');assert.equal(objectFootprint(copy.objects[0]),null);assert.equal(resolvedComposition(copy,copy.objects[0]),null);assert(objectFootprint(f.item));
 assert.equal(objectFootprint(f.item,{},{}),null);
});

test('personal editor policy resolves both changed footprints and denies imported unresolved refs',()=>{
 const f=bound([part('base'),part('decoration',[2,1,0],[2,2,1],{collision:'none'})]);
 const area={areaId:'mine',x:0,z:0,width:8,depth:6,ownerId:'me',canEditObjects:true,revision:1};
 const room={id:'room1',role:'guest',capabilities:{canEditScene:false,canBuild:true,canEditObjects:true},personalAreas:[area],compositionDefinitions:f.definitions},policy=personalEditPolicy({room,user:{id:'me'}});
 assert(policy.canEditItem(f.item));assert(canEditPersonalObject(room,f.item,'me'));
 assert.equal(policy.validateItem({...f.item,x:1},f.item),null);assert(policy.validateItem({...f.item,x:2},f.item));
 assert(policy.validateItem(f.item,{...f.item,x:8}));assert(policy.validateItem({...f.item,assetRef:{assetId:'missing',revision:1}},f.item));
 assert(policy.validateChange(f.scene,{...f.scene,objects:[{...f.item,x:2}]}));assert.equal(policy.validateChange(f.scene,{...f.scene,objects:[]}),null);
});

test('dependency views use complete decorative bounds and reject unresolved revision changes',()=>{
 const f=bound([part('base'),part('decoration',[3,1,0],[1,1,1],{collision:'none'})]);
 const area={id:'a',name:'A',x:3,z:0,width:1,depth:1,action:'silent'};f.scene.areas=[area];
 const view=sceneOperationDependencyView(f.scene,[{kind:'object',id:f.item.id,after:{...f.item,x:.5}}]);assert.deepEqual(view.areas,[area]);
 const areaView=sceneOperationDependencyView(f.scene,[{kind:'area',id:'new',after:{...area,id:'new'}}]);assert.deepEqual(areaView.objects,[f.item]);
 assert.throws(()=>sceneOperationDependencyView(f.scene,[{kind:'object',id:f.item.id,after:{...f.item,assetRef:{assetId:'missing',revision:2}}}]),/geometry/);
 const explicit=sceneOperationDependencyView(structuredClone(f.scene),[{kind:'object',id:f.item.id,after:null}],{},f.definitions);assert.deepEqual(explicit.areas,[area]);
});

test('composition dimensions retain local authored extents and geometry cache invalidates pose/reference changes',()=>{
 const f=bound([part('offset',[2,1,0],[4,2,1])]);assert.deepEqual(dimensions(f.item),{width:4,depth:1});const old=compositionGeometry(f.scene,f.item);assert.equal(compositionGeometry(f.scene,f.item),old);
 f.item.rotation=90;const p=compositionGeometry(f.scene,f.item);assert.notEqual(p,old);approx(p.editBounds.width,1);approx(p.editBounds.depth,4);
 f.item.assetRef.revision=2;assert.throws(()=>compositionGeometry(f.scene,f.item));
});

test('native meshes share placement transforms, preserve per-component picks and own no texture loaders',()=>{
 const engine=new NullEngine(),scene=new Scene(engine),f=fixture([part('base',[1,3,-1],[2,1,3],{rotation:multiply(quaternion('z',20),quaternion('x',15))}),part('decor',[0,1,0],[1,1,1],{collision:'none'})]);
 f.definition.materials[0].textureRef={assetId:'texture1',versionId:'v1',slot:'baseColor'};
 const instance={...f.item,x:3,z:-2,rotation:90},view=createCompositionObjectView({scene,definition:f.definition,instance});
 try{
  const p=resolveCompositionPlacement(f.definition,instance);assert.equal(view.meshes.length,2);assert.equal(view.materials.length,1);assert.equal(scene.textures.length,0);
  for(const [index,mesh] of view.meshes.entries()){
   mesh.computeWorldMatrix(true);const box=mesh.getBoundingInfo().boundingBox,expected=p.components[index].renderBounds;
   vec(box.minimumWorld.asArray(),[expected.minX,expected.minY,expected.minZ]);vec(box.maximumWorld.asArray(),[expected.maxX,expected.maxY,expected.maxZ]);
   assert.equal(mesh.metadata.id,instance.id);assert.equal(mesh.metadata.componentId,f.definition.components[index].id);assert.deepEqual(mesh.metadata.assetRef,instance.assetRef);assert.equal(mesh.isPickable,true);
  }
  assert.deepEqual(view.materials[0].metadata.textureRef,f.definition.materials[0].textureRef);assert.equal(view.materials[0].diffuseTexture,null);
  const base=p.components[0],hit=scene.pickWithRay(new Ray(new Vector3(base.position[0],20,base.position[2]),new Vector3(0,-1,0)),mesh=>mesh.metadata?.componentId==='base');assert(hit.hit);assert.equal(hit.pickedMesh.metadata.id,instance.id);
  const original=view.meshes[0];view.update({definition:f.definition,instance:{...instance,x:6}});assert.equal(view.meshes[0],original);assert.equal(view.getState().placement.transform.x,6);
  const revision=structuredClone(f.definition);revision.asset.revision=2;revision.components[0].shape='wedge';view.update({definition:revision,instance:{...instance,assetRef:{assetId:'furniture1',revision:2}}});assert(original.isDisposed());assert.equal(view.meshes[0].metadata.assetRef.revision,2);
  view.update({definition:revision,instance:{...instance,assetRef:{assetId:'furniture1',revision:2}},preview:true});assert(view.meshes.every(mesh=>!mesh.isPickable));
 }finally{view.dispose();view.dispose();assert.equal(scene.meshes.length,0);assert.equal(scene.materials.length,0);assert.equal(scene.transformNodes.length,0);scene.dispose();engine.dispose();}
});

test('disposing a view root on room switch releases component meshes and materials; invalid update fails closed',()=>{
 const engine=new NullEngine(),scene=new Scene(engine),f=fixture();
 const a=createCompositionObjectView({scene,definition:f.definition,instance:f.item});a.node.dispose();assert.equal(a.getState().status,'disposed');assert.equal(scene.meshes.length,0);assert.equal(scene.materials.length,0);
 const b=createCompositionObjectView({scene,definition:f.definition,instance:f.item});assert.throws(()=>b.update({definition:f.definition,instance:{...f.item,assetRef:{assetId:'other',revision:1}}}));assert.equal(b.getState().status,'disposed');assert.equal(scene.meshes.length,0);assert.equal(scene.materials.length,0);scene.dispose();engine.dispose();
});


test('collaboration retains pinned composition context through whole-scene review and v2 wire snapshots',async()=>{
 const f=bound(),mine=clone(f.scene),server=clone(f.scene);mine.objects[0].x=3;mine.theme='studio';server.objects.push({id:'peer',type:'chair',name:'Peer chair',x:-5,z:0,rotation:0});
 const result=reconcileScenes({base:f.scene,mine,server,choices:{context:'mine'},validate:reconciliationGeometryProblem,version:1});
 assert.equal(result.conflicts.length,0);assert.equal(result.scene.objects.length,2);assert.equal(compositionDefinitions(result.scene),compositionDefinitions(server));approx(objectFootprint(result.scene.objects[0]).x,3);
 const next=clone(f.scene);next.objects[0].rotation=90;
 const request=await createSceneOperationRequest({base:f.scene,mine:next,baseRevision:1,operationId:'save',admission:{admissionId:'joined',admissionEpoch:'epoch',admissionRevision:1},version:2});
 assert.match(request.dependenciesHash,/^[a-f0-9]{64}$/);assert.deepEqual(request.operations[0].after.assetRef,f.item.assetRef);assert.equal(request.operations[0].after.rotation,90);assert.equal(Object.hasOwn(request,'compositionDefinitions'),false);
 assert.equal(reconciliationGeometryProblem(f.scene,next),null);
});

test('all supported primitive meshes fit conservative world edit bounds and scene disposal releases views',()=>{
 const engine=new NullEngine(),scene=new Scene(engine),f=fixture(['box','cylinder','sphere','wedge'].map((shape,index)=>part(shape,[index*2-3,index*.3,0],[1,.6,1.4],{shape,rotation:multiply(quaternion('x',20),quaternion('z',25))})));
 const view=createCompositionObjectView({scene,definition:f.definition,instance:{...f.item,rotation:270}}),p=view.getState().placement;
 for(const mesh of view.meshes){
  const matrix=mesh.computeWorldMatrix(true),points=mesh.getVerticesData('position');
  for(let index=0;index<points.length;index+=3){const point=Vector3.TransformCoordinates(new Vector3(points[index],points[index+1],points[index+2]),matrix),b=p.renderBounds;assert(point.x>=b.minX-1e-7&&point.x<=b.maxX+1e-7&&point.y>=b.minY-1e-7&&point.y<=b.maxY+1e-7&&point.z>=b.minZ-1e-7&&point.z<=b.maxZ+1e-7);}
 }
 scene.dispose();assert.equal(view.getState().status,'disposed');engine.dispose();
});
