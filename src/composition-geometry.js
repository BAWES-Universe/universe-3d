import {validate, multiply, rotateVector} from '../modules/asset-workshop/model.js';

const ID=/^[A-Za-z0-9_-]{1,80}$/,ASSET_ID=/^[A-Za-z0-9_-]{1,64}$/;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const exact=(value,keys,label)=>{if(!record(value)||Reflect.ownKeys(value).length!==keys.length||keys.some(key=>{const property=Object.getOwnPropertyDescriptor(value,key);return !property||!('value' in property)||!property.enumerable;}))throw new Error(`Invalid ${label} fields`);};
const zero=value=>Math.abs(value)<1e-12?0:value;
export const compositionReferenceKey=ref=>`${ref?.assetId}:${ref?.revision}`;
export function canRenderCompositionReference(ref,definition){return !!ref&&!!definition&&ref.assetId===definition.asset?.id&&ref.revision===definition.asset?.revision;}
/** A room instance has no client-authored dimensions, geometry, elevation or scale. */
export function validateCompositionObject(raw){
 exact(raw,['id','type','name','x','z','rotation','assetRef'],'composition instance');
 if(typeof raw.id!=='string'||!ID.test(raw.id)||raw.type!=='composition')throw new Error('Invalid composition instance identity');
 if(typeof raw.name!=='string'||!raw.name.trim()||raw.name.length>80||/[\u0000-\u001f\u007f]/.test(raw.name))throw new Error('Use a composition name of 1–80 characters');
 if(![raw.x,raw.z].every(value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1000000)||![0,90,180,270].includes(raw.rotation))throw new Error('Use finite composition coordinates and a quarter-turn rotation');
 exact(raw.assetRef,['assetId','revision'],'composition reference');
 if(typeof raw.assetRef.assetId!=='string'||!ASSET_ID.test(raw.assetRef.assetId)||!Number.isInteger(raw.assetRef.revision)||raw.assetRef.revision<1||raw.assetRef.revision>1000000)throw new Error('Use a pinned composition reference');
 return {id:raw.id,type:'composition',name:raw.name,x:raw.x,z:raw.z,rotation:raw.rotation,assetRef:{...raw.assetRef}};
}
export const validateCompositionInstance=validateCompositionObject;
export function freezeCompositionRecord(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freezeCompositionRecord(child);Object.freeze(value);}return value;}
function boxCorners(position,rotation,size){
 const corners=[];
 for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1]){
  const p=rotateVector([x*size[0]/2,y*size[1]/2,z*size[2]/2],rotation);
  corners.push(p.map((value,axis)=>zero(value+position[axis])));
 }
 return corners;
}
function boundsOf(corners){
 const min=[0,1,2].map(axis=>Math.min(...corners.map(p=>p[axis]))),max=[0,1,2].map(axis=>Math.max(...corners.map(p=>p[axis])));
 return {x:zero((min[0]+max[0])/2),y:zero((min[1]+max[1])/2),z:zero((min[2]+max[2])/2),width:max[0]-min[0],height:max[1]-min[1],depth:max[2]-min[2],minX:min[0],minY:min[1],minZ:min[2],maxX:max[0],maxY:max[1],maxZ:max[2]};
}
function groundBounds(bounds){const {x,z,width,depth,minX,maxX,minZ,maxZ}=bounds;return {x,z,width,depth,minX,maxX,minZ,maxZ,corners:[{x:minX,z:minZ},{x:maxX,z:minZ},{x:maxX,z:maxZ},{x:minX,z:maxZ}]};}
/** Shared native transform and conservative X/Z collider policy. Elevated colliders
 * still block walking: v1 has no pass-under physics. Decorative parts count for
 * edit authorization and room bounds. Definitions must come from a room resolver. */
export function resolveCompositionPlacement(rawDefinition,rawInstance){
 const definition=validate(rawDefinition),instance=validateCompositionObject(rawInstance);
 if(!definition.components.length)throw new Error('Add at least one component before placing custom furniture');
 if(!canRenderCompositionReference(instance.assetRef,definition))throw new Error('The exact published composition revision is required');
 const localCorners=definition.components.flatMap(component=>boxCorners(component.position,component.rotation,component.size));
 const localBounds=boundsOf(localCorners),offsetY=zero(-localBounds.minY),radians=-instance.rotation*Math.PI/180;
 const rotation=[0,Math.sin(radians/2),0,Math.cos(radians/2)],position=[instance.x,offsetY,instance.z];
 const components=definition.components.map(component=>{
  const relative=rotateVector(component.position,rotation),worldPosition=relative.map((value,axis)=>zero(value+position[axis])),worldRotation=multiply(rotation,component.rotation);
  const corners=boxCorners(worldPosition,worldRotation,component.size),renderBounds=boundsOf(corners);
  return {...component,position:worldPosition,rotation:worldRotation,renderBounds,editBounds:groundBounds(renderBounds),corners};
 });
 const renderBounds=boundsOf(components.flatMap(component=>component.corners)),editBounds=groundBounds(renderBounds);
 const collisionCells=components.filter(component=>component.collision==='box').map(component=>({componentId:component.id,...component.editBounds}));
 return freezeCompositionRecord({schemaVersion:1,instanceId:instance.id,assetRef:instance.assetRef,transform:{x:instance.x,y:offsetY,z:instance.z,rotation:instance.rotation,rotationY:radians,position,quaternion:rotation},localBounds,renderBounds,editBounds,collisionCells,components});
}
export function compositionFootprint(definition,instance){return resolveCompositionPlacement(definition,instance).editBounds;}
export function compositionCollisionCells(definition,instance){return resolveCompositionPlacement(definition,instance).collisionCells;}
export function compositionPlacementInside(area,definition,instance){
 if(!area||![area.x,area.z,area.width,area.depth].every(Number.isFinite)||area.width<=0||area.depth<=0)return false;
 const box=compositionFootprint(definition,instance);
 return Math.abs(box.x-area.x)+box.width/2<=area.width/2+1e-8&&Math.abs(box.z-area.z)+box.depth/2<=area.depth/2+1e-8;
}
