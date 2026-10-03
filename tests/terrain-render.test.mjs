import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEnvironment} from '../src/scene-layout.js';
import {createTerrainMask,subtractTerrainRect,terrainOverlapsRect,terrainSurfaceGroups,terrainSurfaceGeometry,terrainGhostLines} from '../src/terrain-render.js';
const terrain=cells=>({version:1,cells});
const area=rectangles=>rectangles.reduce((n,r)=>n+r.width*r.depth,0);
const overlap=(a,b)=>Math.max(0,Math.min(a.x+a.width/2,b.x+b.width/2)-Math.max(a.x-a.width/2,b.x-b.width/2))*Math.max(0,Math.min(a.z+a.depth/2,b.z+b.depth/2)-Math.max(a.z-a.depth/2,b.z-b.depth/2));
function capture(value,theme='garden',bounds={width:32,depth:26}){
 const items=[],helpers={};for(const kind of ['box','ground','sphere','cylinder'])helpers[kind]=(...args)=>{const item={kind,args};items.push(item);return item;};helpers.material=()=>{};
 buildEnvironment({bounds,theme,terrain:value},{},helpers);return items;
}
test('empty terrain preserves the unedited environment exactly, including erasure',()=>{
 for(const theme of ['garden','studio','night'])assert.deepEqual(capture(terrain([]),theme),capture(undefined,theme));
});
test('rectangle subtraction is exact at fractional boundaries and negative coordinates',()=>{
 const cells=[[-2,-1,'water',true],[-1,-1,'water',true],[0,0,'stone',false],[1,1,'grass',false]],mask=createTerrainMask(terrain(cells));
 for(const rectangle of [{x:0,z:0,width:6,depth:5},{x:-.3,z:.1,width:2.3,depth:3.7},{x:-1.5,z:-.5,width:1,depth:1}]){
  const pieces=subtractTerrainRect(mask,rectangle),removed=cells.reduce((n,[x,z])=>n+overlap(rectangle,{x:x+.5,z:z+.5,width:1,depth:1}),0);
  assert(Math.abs(area(pieces)-(rectangle.width*rectangle.depth-removed))<1e-8);
  for(const p of pieces){assert(!terrainOverlapsRect(mask,p));for(const other of pieces)if(other!==p)assert(overlap(p,other)<1e-8);}
 }
});
test('unchanged strips and solid paint are merged into rectangles',()=>{
 const cells=[];for(let z=-2;z<3;z++)for(let x=-3;x<4;x++)cells.push([x,z,'wood',x%2===0]);
 assert.deepEqual(terrainSurfaceGroups(terrain(cells)),[{material:'wood',rectangles:[{x0:-3,x1:4,z0:-2,z1:3}]}]);
 assert.deepEqual(subtractTerrainRect(new Map(),{x:0,z:0,width:32,depth:26}),[{x:0,z:0,width:32,depth:26}]);
});
test('painted water removes baked paving, timber, inlays, planting and foliage',()=>{
 const cells=[];for(let z=-6;z<12;z++)for(let x=-13;x<13;x++)if((x<0&&z<3)||(x>5&&z>6))cells.push([x,z,'water',true]);
 const mask=createTerrainMask(terrain(cells));
 for(const item of capture(terrain(cells))){
  const [name,x,y,z,a,b,c]=item.args;if(item.isVisible===false){assert.equal(name,'walkable-ground');continue;}
  if(item.kind==='box'&&y+b/2<=0)continue;
  const rectangle={x,z,width:item.kind==='sphere'||item.kind==='cylinder'?a*2:a,depth:item.kind==='box'?c:item.kind==='ground'?b:a*2};
  assert(!terrainOverlapsRect(mask,rectangle),`${item.kind} ${name} intersects authored water`);
 }
});
test('full-room terrain leaves the foundation but no buried decorative surfaces',()=>{
 const cells=[];for(let z=-4;z<4;z++)for(let x=-4;x<4;x++)cells.push([x,z,'water',false]);
 const items=capture(terrain(cells),'garden',{width:8,depth:8});
 assert.equal(items.filter(i=>i.kind==='ground'&&i.isVisible!==false).length,0);
 assert.equal(items.filter(i=>i.kind==='box').length,3);
});
test('render material and blocking remain independent',()=>{
 const cells=[[-1,-1,'water',true],[0,-1,'water',false],[1,0,'stone',true]];
 assert.deepEqual(terrainSurfaceGroups(terrain(cells)),terrainSurfaceGroups(terrain(cells.map(([x,z,material,blocked])=>[x,z,material,!blocked]))));
});
test('4096 checkerboard cells use five material buffers with bounded vertices',()=>{
 const cells=[],materials=['grass','soil','stone','wood','water'];for(let z=-32;z<32;z++)for(let x=-32;x<32;x++)cells.push([x,z,materials[((x+z)%5+5)%5],false]);
 const groups=terrainSurfaceGroups(terrain(cells));assert.equal(groups.length,5);
 let faces=0;for(const group of groups){const geometry=terrainSurfaceGeometry(group.rectangles,.04);assert(geometry.positions.length/3<=4096*4);assert.equal(geometry.normals.length,geometry.positions.length);assert.equal(geometry.uvs.length/2,geometry.positions.length/3);faces+=geometry.indices.length/6;}
 assert.equal(faces,4096);
});
test('surface geometry points upward and UVs remain aligned across split boundaries',()=>{
 const geometry=terrainSurfaceGeometry([{x0:-2,x1:0,z0:-1,z1:2},{x0:0,x1:1,z0:-1,z1:2}],.04);
 assert.deepEqual(geometry.positions.slice(0,3),[-2,.04,-1]);assert.deepEqual(geometry.uvs.slice(0,2),[-1,-.5]);
 assert.deepEqual(geometry.uvs.slice(6,8),geometry.uvs.slice(8,10));
 const p=geometry.positions,[a,b,c]=geometry.indices.slice(0,3).map(i=>p.slice(i*3,i*3+3));assert((b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2])<0,'clockwise triangles face upward in Babylon left-handed space');assert.deepEqual(geometry.normals.slice(0,3),[0,1,0]);
});
test('preview grid includes the exact footprint and every cell edge',()=>{
 const lines=terrainGhostLines(4,3);assert.equal(lines.length,9);
 assert.deepEqual(lines[0],[[-2,.115,-1.5],[-2,.115,1.5]]);assert.deepEqual(lines[4],[[2,.115,-1.5],[2,.115,1.5]]);
 assert.deepEqual(lines.at(-1),[[-2,.115,1.5],[2,.115,1.5]]);
});
