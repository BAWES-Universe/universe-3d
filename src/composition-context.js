import {validate} from '../modules/asset-workshop/model.js';
import {canRenderCompositionReference,compositionReferenceKey,freezeCompositionRecord,resolveCompositionPlacement,validateCompositionObject} from './composition-geometry.js';
export {canRenderCompositionReference,compositionReferenceKey};

// Projections are attached out of band, never trusted from serialized scene data.
const contexts=new WeakMap(),objectContexts=new WeakMap(),geometryCache=new WeakMap(),EMPTY=Object.freeze(Object.create(null));
function attach(scene,context){contexts.set(scene,context);for(const object of scene.objects||[])if(object&&typeof object==='object')objectContexts.set(object,context);return scene;}
export function bindCompositionDefinitions(scene,definitions={},roomId=null){
 if(!scene||typeof scene!=='object')throw new TypeError('A scene is required');
 if(!definitions||typeof definitions!=='object'||Array.isArray(definitions))throw new Error('Use a composition definitions map');
 const normalized=Object.create(null);
 for(const [key,raw]of Object.entries(definitions)){
  const definition=validate(raw);
  if(key!==compositionReferenceKey({assetId:definition.asset.id,revision:definition.asset.revision}))throw new Error('Composition definition key does not match its published reference');
  normalized[key]=freezeCompositionRecord(definition);
 }
 return attach(scene,Object.freeze({definitions:Object.freeze(normalized),roomId}));
}
export function compositionDefinitions(sceneOrObject){return (contexts.get(sceneOrObject)||objectContexts.get(sceneOrObject))?.definitions||EMPTY;}
export function compositionRoomId(sceneOrObject){return (contexts.get(sceneOrObject)||objectContexts.get(sceneOrObject))?.roomId??null;}
export function inheritCompositionDefinitions(source,target){
 if(!target||typeof target!=='object')return target;
 const context=contexts.get(source)||objectContexts.get(source);
 if(context){if(Array.isArray(target.objects))attach(target,context);else objectContexts.set(target,context);}
 return target;
}
/** Attach the current room projection to an uncommitted preview or replacement. */
export function bindCompositionObject(scene,object){if(object&&typeof object==='object'){const context=contexts.get(scene);if(context)objectContexts.set(object,context);else objectContexts.delete(object);}return object;}
export function resolvedComposition(scene,instance){
 const definitions=compositionDefinitions(scene||instance),entry=definitions[compositionReferenceKey(instance?.assetRef)];
 return canRenderCompositionReference(instance?.assetRef,entry)?entry:null;
}
export function compositionGeometry(scene,instance){
 const normalized=validateCompositionObject(instance),entry=resolvedComposition(scene,instance);
 if(!entry)throw new Error('The room has not resolved this composition revision');
 const signature=JSON.stringify(normalized),cached=geometryCache.get(instance);
 if(cached?.entry===entry&&cached.signature===signature)return cached.value;
 const value=resolveCompositionPlacement(entry,normalized);geometryCache.set(instance,{entry,signature,value});return value;
}
