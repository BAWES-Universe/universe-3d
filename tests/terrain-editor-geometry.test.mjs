import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyScene,clone} from '../src/worlds.js';
import {validateTerrainEdit,wallFromStroke,validatePlacement} from '../src/editor-geometry.js';
import {applyTerrainRect} from '../src/terrain.js';
import {bindImageDefinitions} from '../src/image-asset-context.js';
import {normalizeImageAssetDraft,validateImageDefinition} from '../src/image-asset-schema.js';
const stone={material:'stone',blocked:false},water={material:'water',blocked:true};
const rect=(minX,minZ,maxX=minX,maxZ=minZ)=>({minX,minZ,maxX,maxZ});
test('terrain rectangle preview never changes the scene and returns exact lower-corner cells',()=>{const scene=emptyScene(),before=clone(scene);const result=validateTerrainEdit(scene,rect(-2,-3,0,-2),stone);assert(result.valid);assert.equal(result.terrain.cells.length,6);assert.deepEqual(result.terrain.cells[0],[-2,-3,'stone',false]);assert.deepEqual(scene,before);});
test('terrain preview rejects bounds and budget before a commit',()=>{const scene=emptyScene();assert.match(validateTerrainEdit(scene,rect(15,0,16,0),stone).reason,/inside/);assert.match(validateTerrainEdit(scene,rect(-100,-100,100,100),stone).reason,/4,096/);});
test('new blockers protect arrival and player, while unblocked floors can underlay furniture',()=>{const scene=emptyScene();assert.match(validateTerrainEdit(scene,rect(0,7),water).reason,/arrival/);assert.match(validateTerrainEdit(scene,rect(4,0),water,{position:{x:4.5,z:.5}}).reason,/standing/);scene.objects=[{id:'table',type:'table',x:3,z:0}];assert(validateTerrainEdit(scene,rect(3,0),stone).valid);assert.equal(validateTerrainEdit(scene,rect(3,0),water).valid,false);assert.match(validateTerrainEdit(scene,rect(3,0),water).reason,/Overlaps Community table/);assert(validateTerrainEdit(scene,rect(3,0),{...water,blocked:false}).valid);});
test('repainting an existing blocker adds no new protected geometry; erase restores base',()=>{const scene=emptyScene();scene.terrain=applyTerrainRect(undefined,rect(4,0),water);const repaint=validateTerrainEdit(scene,rect(4,0),{material:'soil',blocked:true},{position:{x:4.5,z:.5}});assert(repaint.valid);assert.deepEqual(repaint.terrain.cells,[[4,0,'soil',true]]);const erase=validateTerrainEdit(scene,rect(4,0),{erase:true});assert(erase.valid);assert.deepEqual(erase.terrain.cells,[]);});
test('terrain preview prevents sealing the last walking route from arrival',()=>{const scene=emptyScene();scene.spawn={x:0,z:0};scene.terrain=applyTerrainRect(undefined,rect(-2,-2,-2,1),water);scene.terrain=applyTerrainRect(scene.terrain,rect(1,-2,1,1),water);scene.terrain=applyTerrainRect(scene.terrain,rect(-1,-2,0,-2),water);assert.match(validateTerrainEdit(scene,rect(-1,1,0,1),water).reason,/walking route/);assert(validateTerrainEdit(scene,rect(-1,1,0,1),stone).valid);});
test('solid wall previews cannot intersect authored blocking ground; rugs remain allowed',()=>{const scene=emptyScene();scene.terrain=applyTerrainRect(undefined,rect(2,0),water);assert.match(validatePlacement(scene,{type:'wall',x:3,z:.5,width:3}).reason,/blocked terrain/);assert(validatePlacement(scene,{type:'rug',x:3,z:.5}).valid);});
test('orthogonal wall stroke uses ordinary wall dimensions in both directions',()=>{assert.deepEqual(wallFromStroke({x:5,z:1},{x:1,z:2}),{type:'wall',name:'Wall',x:3,z:1,width:4,depth:.3,rotation:0});assert.deepEqual(wallFromStroke({x:1,z:5},{x:2,z:1}),{type:'wall',name:'Wall',x:1,z:3,width:4,depth:.3,rotation:90});assert.equal(wallFromStroke({x:2,z:2},{x:2,z:2},90).rotation,90);assert.equal(wallFromStroke({x:NaN,z:2},{x:2,z:2}),null);});

test('blocking terrain rejects the captured compact chair overlap without changing the draft',()=>{
 const scene={...emptyScene(),bounds:{width:30,depth:24},spawn:{x:0,z:5},objects:[{id:'chair',type:'chair',name:'Chair',x:-10,z:7,rotation:180}],terrain:{version:1,cells:[[-11,5,'water',true]]}},before=clone(scene);
 const rejected=validateTerrainEdit(scene,rect(-11,7),water);assert.equal(rejected.valid,false);assert.equal(rejected.reason,'Overlaps Chair');assert.deepEqual(scene,before);
 assert(validateTerrainEdit(scene,rect(-12,7),water).valid);scene.objects[0].type='rug';assert(validateTerrainEdit(scene,rect(-11,7),water).valid);
});
test('terrain checks rotated solid cells, permits touching edges, and preserves old overlaps',()=>{
 const scene=emptyScene();scene.objects=[{id:'wall',type:'wall',name:'Rotated wall',x:4.5,z:0,width:4,rotation:90}];
 assert.equal(validateTerrainEdit(scene,rect(4,1),water).valid,false);assert(validateTerrainEdit(scene,rect(4,2),water).valid);
 scene.terrain=applyTerrainRect(undefined,rect(4,1),water);assert(validateTerrainEdit(scene,rect(4,1),{material:'soil',blocked:true}).valid);assert(validateTerrainEdit(scene,rect(4,1),{erase:true}).valid);
 assert.equal(validateTerrainEdit(scene,rect(4,0,4,1),water).valid,false);
});

test('terrain uses sparse rotated image collision cells without blocking empty artwork or floating images',()=>{
 const stamp='2026-10-03T00:00:00.000Z',definition={schemaVersion:1,assetId:'a',roomId:'r',createdBy:'u',createdAt:stamp,originKind:'upload'};
 const image=floating=>({...validateImageDefinition(definition,{...normalizeImageAssetDraft({name:'Sparse art',floating,collisionGrid:floating?null:[[1,0],[0,0]]},{width:64,height:64,byteLength:200,mediaType:'image/png'}),schemaVersion:1,assetId:'a',roomId:'r',versionId:'v',sequence:1,sha256:'f'.repeat(64),createdBy:'u',createdAt:stamp}),status:'active'});
 const scene=emptyScene();scene.objects=[{id:'art',type:'image',name:'Sparse art',assetRef:{assetId:'a',versionId:'v'},x:4,z:0,rotation:0}];bindImageDefinitions(scene,{'a:v':image(false)},'r');
 for(const [rotation,occupied,empty]of [[0,[3,-1],[4,0]],[90,[4,-1],[3,0]],[180,[4,0],[3,-1]],[270,[3,0],[4,-1]]]){scene.objects[0].rotation=rotation;assert.equal(validateTerrainEdit(scene,rect(...occupied),water).valid,false,`Occupied image cell at ${rotation} degrees`);assert(validateTerrainEdit(scene,rect(...empty),water).valid,`Empty image cell at ${rotation} degrees`);}
 bindImageDefinitions(scene,{'a:v':image(true)},'r');assert(validateTerrainEdit(scene,rect(3,-1,4,0),water).valid);
});
