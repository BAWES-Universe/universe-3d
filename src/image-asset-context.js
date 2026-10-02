import {validateResolvedImageAsset,validateImageInstance,canUseImageReference} from './image-asset-schema.js';
import {resolveImagePlacement} from './image-asset-geometry.js';

// Read projection only. Definitions never become part of serialized scene data.
const contexts=new WeakMap(),geometryCache=new WeakMap(),EMPTY=Object.freeze(Object.create(null));
export const imageReferenceKey=ref=>`${ref?.assetId}:${ref?.versionId}`;
export function bindImageDefinitions(scene,definitions={},roomId){
 if(!scene||typeof scene!=='object')throw new TypeError('A scene is required');
 const normalized=Object.create(null);
 for(const [key,raw]of Object.entries(definitions)){
  const entry=validateResolvedImageAsset(raw);
  if(key!==imageReferenceKey({assetId:entry.definition.assetId,versionId:entry.version.versionId})||roomId&&entry.definition.roomId!==roomId)throw new Error('Image definitions do not belong to this room');
  normalized[key]=entry;
 }
 contexts.set(scene,Object.freeze(normalized));return scene;
}
export function imageDefinitions(scene){return contexts.get(scene)||EMPTY;}
export function inheritImageDefinitions(source,target){const value=contexts.get(source);if(value)contexts.set(target,value);return target;}
export function cloneWithImageContext(value){
 const copy=structuredClone(value);
 if(value&&typeof value==='object'){
  inheritImageDefinitions(value,copy);
  if(value.scene&&copy.scene)inheritImageDefinitions(value.scene,copy.scene);
 }
 return copy;
}
export function resolvedImage(scene,instance){
 const entry=imageDefinitions(scene)[imageReferenceKey(instance?.assetRef)];
 return entry&&canUseImageReference(instance.assetRef,entry)?entry:null;
}
export function imageGeometry(scene,instance){
 const normalized=validateImageInstance(instance),entry=resolvedImage(scene,normalized);
 if(!entry)throw new Error('The room has not resolved this image version');
 const signature=JSON.stringify([normalized.id,normalized.assetRef,normalized.x,normalized.z,normalized.rotation]);
 const cached=geometryCache.get(instance);
 if(cached?.entry===entry&&cached.signature===signature)return cached.value;
 const value=resolveImagePlacement(entry,normalized);geometryCache.set(instance,{entry,signature,value});return value;
}
