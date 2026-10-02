import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeImageAssetDraft, normalizeImageLibraryMetadata, validateResolvedImageAsset, canUseImageReference, canRenderImageReference} from '../src/image-asset-schema.js';
import {searchImageLibrary} from '../src/image-library.js';
import {resolveImagePlacement} from '../src/image-asset-geometry.js';
import {mergeImageDefinitions} from '../src/image-asset-context.js';
const time='2026-10-02T00:00:00.000Z';
const ref={assetId:'asset',versionId:'version'};
const original={schemaVersion:1,status:'active',revision:1,metadata:{name:'Old name',description:'',tags:['old tag']},definition:{schemaVersion:1,assetId:'asset',roomId:'room',createdBy:'owner',createdAt:time,originKind:'upload'},version:{...normalizeImageAssetDraft({name:'Old name',tags:['old tag'],depthPreset:'floor',floating:false,collisionGrid:[[1,0],[0,1]]},{width:64,height:64,byteLength:100,mediaType:'image/png'}),schemaVersion:1,assetId:'asset',roomId:'room',versionId:'version',sequence:1,sha256:'a'.repeat(64),createdBy:'owner',createdAt:time}};
const instance={id:'placed',type:'image',assetRef:ref,x:2,z:3,rotation:90};
test('metadata is bounded normalized plain text with deduplicated mutable tags',()=>{
 assert.deepEqual(normalizeImageLibraryMetadata({name:' Cafe\u0301 ',description:' text ',tags:' Garden, garden, Green '}),{name:'Café',description:'text',tags:['Garden','Green']});
 for(const raw of [{name:'',description:''},{name:'x'.repeat(121),description:''},{name:'x',description:'y'.repeat(2001)},{name:'x',description:'',url:'x'},{name:'x',description:'',tags:Array.from({length:21},(_,i)=>'tag'+i)}])assert.throws(()=>normalizeImageLibraryMetadata(raw));
 assert(Object.isFrozen(normalizeImageLibraryMetadata({name:'x',description:'',tags:[]})));
});
test('mutable discovery names, descriptions and tags replace only discovery fields',()=>{
 const changed=validateResolvedImageAsset({...original,revision:2,metadata:{name:'New name',description:'rain forest',tags:['orchard']}});
 assert.deepEqual(changed.version,original.version);
 for(const query of ['new forest','orchard'])assert.equal(searchImageLibrary([changed],{query}).length,1);
 for(const query of ['old name','old tag'])assert.equal(searchImageLibrary([changed],{query}).length,0);
 assert.deepEqual(resolveImagePlacement(changed,instance),resolveImagePlacement(original,instance));
});
test('archived geometry and collision remain exact while new-reference use is denied',()=>{
 const archived=validateResolvedImageAsset({...original,status:'archived',revision:2});
 assert.equal(canUseImageReference(ref,archived),false);assert.equal(canRenderImageReference(ref,archived),true);
 assert.deepEqual(resolveImagePlacement(archived,instance),resolveImagePlacement(original,instance));
 assert.equal(searchImageLibrary([archived]).length,0);assert.equal(searchImageLibrary([archived],{status:'archived'}).length,1);
 assert.equal(canRenderImageReference(ref,{...archived,status:'deleted'}),false);
 assert.throws(()=>resolveImagePlacement({...archived,status:'deleted'},instance));
});
test('late active room replies cannot replace a newer archived lifecycle revision',()=>{
 const archived={...original,status:'archived',revision:3};
 assert.equal(mergeImageDefinitions({'asset:version':archived},{'asset:version':original})['asset:version'],archived);
 const restored={...original,revision:4};assert.equal(mergeImageDefinitions({'asset:version':archived},{'asset:version':restored})['asset:version'],restored);
});
