import test from 'node:test';
import assert from 'node:assert/strict';
import {TERRAIN_MATERIALS,MAX_TERRAIN_CELLS,terrainCell,terrainRect,applyTerrainRect,validateTerrain,terrainBlocks,terrainCollisionBoxes} from '../src/terrain.js';
import {emptyScene,canStand,movePlayer,findPath,nearestWalkable} from '../src/worlds.js';
import {navigationPolicy,planBotPath,segmentClear} from '../server/bot-navigation.mjs';
import {scene as encodeScene} from '../server/validation.mjs';

const bounds={width:32,depth:26};
const patch=(terrain,from,to,options={material:'grass',blocked:false})=>applyTerrainRect(terrain,terrainRect(from,to),options);

test('TERRAIN-01 lower-corner grid uses floor for negative coordinates and inclusive reverse drags',()=>{
 assert.deepEqual(terrainCell({x:-.01,z:1.99}),{x:-1,z:1});
 assert.deepEqual(terrainRect({x:2,z:3},{x:-1,z:0}),{minX:-1,minZ:0,maxX:2,maxZ:3});
 assert.throws(()=>terrainCell({x:NaN,z:0}),{code:'INVALID_TERRAIN'});
 assert.throws(()=>terrainRect({x:.5,z:0},{x:2,z:0}),{code:'INVALID_TERRAIN'});
 assert.deepEqual(TERRAIN_MATERIALS,['grass','soil','stone','wood','water']);
});

test('TERRAIN-02 paint, repaint, and erase are immutable canonical transactions with no duplicate cells',()=>{
 const a=patch(undefined,{x:1,z:1},{x:-1,z:-1});
 const b=patch(a,{x:0,z:0},{x:1,z:1},{material:'water',blocked:true});
 assert.equal(a.cells.length,9);assert.equal(b.cells.length,9);
 assert.deepEqual(a.cells[4],[0,0,'grass',false]);assert.deepEqual(b.cells[4],[0,0,'water',true]);
 assert.ok(Object.isFrozen(b)&&Object.isFrozen(b.cells)&&b.cells.every(Object.isFrozen));
 const c=patch(b,{x:1,z:1},{x:-1,z:0},{erase:true});
 assert.deepEqual(c.cells,[[-1,-1,'grass',false],[0,-1,'grass',false],[1,-1,'grass',false]]);
 const empty=patch(c,{x:-100,z:-100},{x:100,z:100},{erase:true});assert.deepEqual(empty,{version:1,cells:[]});
 const reverse=patch(undefined,{x:-1,z:-1},{x:1,z:1});assert.deepEqual(reverse,a);
});

test('TERRAIN-03 strict schema rejects coercions, unknown fields, duplicates, bad bounds and footprints',()=>{
 assert.equal(validateTerrain(undefined,bounds),undefined);
 for(const terrain of [null,[],{version:2,cells:[]},{version:1,cells:[],chunks:[]},{version:1,cells:[[0,0,'water',1]]},{version:1,cells:[[0,0,'lava',false]]},{version:1,cells:[[.5,0,'soil',false]]},{version:1,cells:[[0,Infinity,'soil',false]]},{version:1,cells:[[0,0,'wood',false,1]]},{version:1,cells:[[0,0,'wood',false],[0,0,'stone',true]]},{version:1,cells:[[16,0,'stone',false]]},{version:1,cells:[[-17,0,'stone',false]]}])assert.throws(()=>validateTerrain(terrain,bounds),{code:'INVALID_TERRAIN'});
 assert.doesNotThrow(()=>validateTerrain({version:1,cells:[[-16,-13,'soil',false],[15,12,'wood',true]]},bounds));
 assert.throws(()=>validateTerrain({version:1,cells:[[15,0,'stone',false]]},{width:31,depth:26}),{code:'INVALID_TERRAIN'});
 assert.throws(()=>patch(undefined,{x:0,z:0},{x:0,z:0},{material:'water'}),{code:'INVALID_TERRAIN'});
});

test('TERRAIN-04 cell and shared scene complexity budgets hold without dropping existing cells',()=>{
 const full=patch(undefined,{x:-32,z:-32},{x:31,z:31});assert.equal(full.cells.length,MAX_TERRAIN_CELLS);
 assert.throws(()=>patch(full,{x:32,z:0},{x:32,z:0}),{code:'INVALID_TERRAIN'});
 assert.throws(()=>patch(undefined,{x:0,z:0},{x:4096,z:0}),{code:'INVALID_TERRAIN'});
 assert.equal(patch(full,{x:0,z:0},{x:0,z:0},{material:'soil',blocked:true}).cells.length,MAX_TERRAIN_CELLS);
 const scene={...emptyScene(),bounds:{width:100,depth:100},spawn:{x:0,z:40},terrain:full};assert.doesNotThrow(()=>encodeScene(scene));
 assert.throws(()=>encodeScene({...scene,extra:Array.from({length:5000},()=>[1,2,3,4,5])}),{code:'INVALID_INPUT'});
 assert.throws(()=>encodeScene({...scene,extra:Array.from({length:30},()=> 'x'.repeat(19000))}),{code:'TOO_LARGE'});
});

test('TERRAIN-05 sparse blockers use exact 1m boxes and explicit collision independent of material',()=>{
 const scene=emptyScene();scene.terrain={version:1,cells:[[0,0,'water',false],[-2,-1,'wood',true]]};
 assert.deepEqual(terrainCollisionBoxes(scene.terrain),[{x:-1.5,z:-.5,width:1,depth:1}]);
 assert.equal(terrainBlocks(scene,.5,.5),false);assert.equal(terrainBlocks(scene,-1.5,-.5),true);
 assert.equal(terrainBlocks(scene,-.7,-.5,.3),true);assert.equal(terrainBlocks(scene,-.69,-.5,.3),false);
 assert.equal(terrainBlocks(scene,0,0,Infinity),true);assert.equal(terrainBlocks(scene,NaN,0),true);
});

test('TERRAIN-06 identity index avoids rescanning cells and refreshes on edit, import, erase, and undo',()=>{
 const full=patch(undefined,{x:-32,z:-32},{x:31,z:31},{material:'stone',blocked:true});
 let reads=0;const cells=new Proxy(full.cells,{get(target,property){if(typeof property==='string'&&/^\d+$/.test(property))reads++;return Reflect.get(target,property);}});
 const original={version:1,cells},scene={terrain:original};assert.equal(terrainBlocks(scene,.5,.5),true);const initialReads=reads;
 assert.ok(initialReads>=MAX_TERRAIN_CELLS);
 for(let i=0;i<1000;i++)assert.equal(terrainBlocks(scene,1000,1000),false);assert.equal(reads,initialReads);
 scene.terrain=patch(original,{x:0,z:0},{x:0,z:0},{material:'grass',blocked:false});assert.equal(terrainBlocks(scene,.5,.5),false);
 scene.terrain=JSON.parse(JSON.stringify(original));assert.equal(terrainBlocks(scene,.5,.5),true);
 scene.terrain=patch(scene.terrain,{x:0,z:0},{x:0,z:0},{erase:true});assert.equal(terrainBlocks(scene,.5,.5),false);
 scene.terrain=original;assert.equal(terrainBlocks(scene,.5,.5),true);
});

test('TERRAIN-07 keyboard, click paths, and safe arrival share blocked terrain',()=>{
 const scene=emptyScene();scene.terrain=patch(undefined,{x:-3,z:0},{x:3,z:0},{material:'water',blocked:true});
 const moved=movePlayer(scene,{x:0,z:3},0,-20);assert.ok(moved.z>1.3);
 const path=findPath(scene,{x:0,z:3},{x:0,z:-2});assert.ok(path.length>10);assert.deepEqual(path.at(-1),{x:0,z:-2});
 for(const point of path)assert.ok(canStand(scene,point.x,point.z));
 assert.deepEqual(findPath(scene,{x:0,z:3},{x:.5,z:.5}),[]);
 const landing=nearestWalkable(scene,{x:.5,z:.5});assert.ok(canStand(scene,landing.x,landing.z));
 scene.terrain=patch(scene.terrain,{x:-3,z:0},{x:3,z:0},{erase:true});assert.ok(canStand(scene,.5,.5));
});

test('TERRAIN-08 resident policy and swept paths use the same terrain blockers',()=>{
 const scene=emptyScene();scene.terrain=patch(undefined,{x:0,z:-3},{x:0,z:3},{material:'stone',blocked:true});
 const config={spawn:{x:-4,z:0},radius:12,restrictedAreaIds:[]},allowed=navigationPolicy(scene,config);
 assert.equal(allowed({x:.5,z:.5}),false);const path=planBotPath(scene,config.spawn,{x:4,z:0},config);assert.ok(path?.length>1);
 let previous=config.spawn;for(const point of path){assert.ok(segmentClear(previous,point,allowed));previous=point;}
 assert.deepEqual(previous,{x:4,z:0});
 scene.terrain=patch(scene.terrain,{x:0,z:-3},{x:0,z:3},{material:'water',blocked:false});assert.equal(navigationPolicy(scene,config)({x:.5,z:.5}),true);
});

test('TERRAIN-09 legacy scenes serialize without added terrain and terrain cannot cover imported arrival',()=>{
 const scene=emptyScene();assert.equal(encodeScene(scene),JSON.stringify(scene));assert.ok(!Object.hasOwn(JSON.parse(encodeScene(scene)),'terrain'));
 assert.throws(()=>encodeScene({...scene,terrain:{version:1,cells:[[0,7,'water',true]]}}),{code:'TERRAIN_BLOCKS_ARRIVAL'});
 for(const width of ['3',null,false])assert.throws(()=>encodeScene({...scene,objects:[{id:'bad-wall',type:'wall',x:0,z:0,width}]}),{code:'INVALID_INPUT'});
});
