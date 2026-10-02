import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeImageAssetDraft,validateImageDefinition} from '../src/image-asset-schema.js';
import {personalEditPolicy} from '../src/personal-editor-policy.js';
const stamp='2026-10-02T00:00:00.000Z';
function entry(assetId,versionId,width=64,height=128,roomId='room'){
 const definition={schemaVersion:1,assetId,roomId,createdBy:'editor',createdAt:stamp,originKind:'upload'};
 const version={...normalizeImageAssetDraft({name:'Custom tree'},{width,height,byteLength:100,mediaType:'image/png'}),schemaVersion:1,assetId,roomId,versionId,sequence:1,sha256:'a'.repeat(64),createdBy:'editor',createdAt:stamp};
 return {...validateImageDefinition(definition,version),status:'active'};
}
const image={id:'image-instance',type:'image',assetRef:{assetId:'tree',versionId:'v1'},x:0,z:0,rotation:0,name:'My tree',actions:[]};
const area={areaId:'desk',x:0,z:0,width:6,depth:6,ownerId:'me',canEditObjects:true,revision:2};
const room={id:'room',role:'guest',capabilities:{canBuild:true,canEditScene:false,canEditObjects:true},personalAreas:[area],imageDefinitions:{'tree:v1':entry('tree','v1')}};
const scene={bounds:{width:32,depth:26},spawn:{x:0,z:8},objects:[image],areas:[]};
const policy=personalEditPolicy({room,user:{id:'me'}});
test('image personal editor uses pinned authoritative dimensions and both old/new footprints',()=>{
 assert.equal(policy.canEditItem(image),true);
 assert.equal(policy.validateItem({...image,x:2}),null);
 assert.match(policy.validateItem({...image,x:2.01}),/entirely/);
 assert.equal(policy.validateItem({...image,x:1,rotation:90}),null);
 assert.match(policy.validateItem({...image,x:1.01,rotation:90}),/entirely/);
 assert.match(policy.validateChange({...scene,objects:[{...image,x:4}]},scene),/entirely/);
 assert.match(policy.validateChange(scene,{...scene,objects:[{...image,z:2}]}),/entirely/);
 assert.match(policy.validateChange(scene,{...scene,theme:'studio'}),/settings/);
});
test('unresolved versions, forged geometry, foreign overlap, and revoked privileges cannot expand image rights',()=>{
 for(const object of [{...image,assetRef:{assetId:'tree',versionId:'new'}},{...image,width:.01},{...image,scale:.01},{...image,rotation:45}])assert.match(policy.validateItem(object),/entirely/);
 const foreign=personalEditPolicy({room:{...room,personalAreas:[area,{...area,areaId:'theirs',x:2,ownerId:'them'}]},user:{id:'me'}});
 assert.match(foreign.validateItem(image),/entirely/);
 const revoked=personalEditPolicy({room:{...room,capabilities:{canBuild:false,canEditScene:false,canEditObjects:false}},user:{id:'me'}});
 assert.equal(revoked.canEdit,false);assert.equal(revoked.canEditItem(image),false);assert.match(revoked.validateChange(scene,{...scene,objects:[]}),/permission/);
 const otherRoom=personalEditPolicy({room:{...room,imageDefinitions:{'tree:v1':entry('tree','v1',64,128,'other')}},user:{id:'me'}});assert.equal(otherRoom.canEditItem(image),false);
 assert.equal(room.role,'guest');assert.equal(room.capabilities.canEditScene,false);
});
