import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyScene,collisionBox,canStand,movePlayer} from '../src/worlds.js';
import {snapWallPlacement,validatePlacement,overlaps,wallFromStroke} from '../src/editor-geometry.js';
import {wallSnapCandidates} from '../src/wall-snapping.js';
import {applyTerrainRect} from '../src/terrain.js';
import {scene as encodeScene} from '../server/validation.mjs';
import {reconcileScenes,rebaseHistory,reconciliationGeometryProblem} from '../src/editor-collaboration.js';

const wall=(id,x,z,width=4,rotation=0,depth=.3)=>({id,type:'wall',name:id,x,z,width,depth,rotation});
const touching=(a,b)=>{
 const x=(a.width+b.width)/2-Math.abs(a.x-b.x),z=(a.depth+b.depth)/2-Math.abs(a.z-b.z);
 return Math.abs(x)<1e-8&&z>1e-8||Math.abs(z)<1e-8&&x>1e-8;
};
test('explicit wall orientation persists during a drag while automatic strokes follow its dominant direction',()=>{
 const from={x:-6,z:-5},to={x:-2,z:-4};
 assert.equal(wallFromStroke(from,to,90).rotation,0);
 const locked=wallFromStroke(from,to,90,{lockAxis:true});
 assert.equal(locked.rotation,90);assert.equal(locked.x,from.x);assert.equal(locked.width,1);
 assert.equal(wallFromStroke(from,{x:-5,z:0},0,{lockAxis:true}).rotation,0);
});
test('wall endpoint strokes snap into real, non-overlapping L corners in every orientation',()=>{
 for(const rotation of [0,90,180,270])for(const direction of [-1,1]){
  const vertical=rotation%180===90,scene=emptyScene();
  scene.objects=[wall('existing',-5,-4,4,rotation)];
  const from=vertical?{x:-5,z:-4+direction*2}:{x:-5+direction*2,z:-4};
  const to=vertical?{x:from.x+3,z:from.z}:{x:from.x,z:from.z+3};
  const raw=wallFromStroke(from,to),before=JSON.stringify(scene),original=JSON.stringify(raw);
  assert.equal(validatePlacement(scene,raw).valid,false);
  const snapped=snapWallPlacement(scene,raw);assert.equal(snapped.joined,true);
  const a=collisionBox(scene.objects[0]),b=collisionBox(snapped.item);
  assert.equal(overlaps(a,b),false);assert.equal(touching(a,b),true);
  assert.equal(validatePlacement(scene,snapped.item).valid,true);
  assert.equal(snapped.item.width,raw.width);assert.equal(snapped.item.rotation,raw.rotation);
  assert.equal(JSON.stringify(scene),before);assert.equal(JSON.stringify(raw),original);
  assert.ok(snapped.distance<=.6);
 }
});
test('wall snapping handles collinear ends, T joins and custom thickness without grid gaps',()=>{
 const scene=emptyScene();scene.objects=[wall('existing',-4,-4,4,0,.6)];
 for(const raw of [wall('new',0,-4,4),wall('new',-4,-2,4,90,.4)]){
  const result=snapWallPlacement(scene,raw);assert.equal(result.joined,true);
  assert(touching(collisionBox(result.item),collisionBox(scene.objects[0])));
  assert.equal(validatePlacement(scene,result.item).valid,true);
 }
});
test('remote geometry order cannot change a snap and repeated snapping is stable',()=>{
 const scene=emptyScene();scene.objects=[wall('left',-4,-4),wall('right',4,-4)];
 const item=wall('draft',0,-4),a=snapWallPlacement(scene,item);
 assert.deepEqual(snapWallPlacement({...scene,objects:[...scene.objects].reverse()},item),a);
 assert.deepEqual(snapWallPlacement(scene,a.item).item,a.item);
});
test('four wall strokes close a room without a final-corner gap across start corners and drag directions',()=>{
 for(const width of [3,4,5])for(const depth of [3,4,5])for(const start of [0,1,2,3])for(const reverse of [false,true]){
  let points=[{x:-8,z:-6},{x:-8+width,z:-6},{x:-8+width,z:-6+depth},{x:-8,z:-6+depth}];
  if(reverse)points.reverse();points=[...points.slice(start),...points.slice(0,start)];
  const scene=emptyScene();
  for(let i=0;i<4;i++){
   const result=snapWallPlacement(scene,wallFromStroke(points[i],points[(i+1)%4]));
   assert(validatePlacement(scene,result.item).valid);scene.objects.push({...result.item,id:'wall-'+i});
  }
  const boxes=scene.objects.map(collisionBox);
  for(let i=0;i<4;i++)assert(touching(boxes[i],boxes[(i+1)%4]),JSON.stringify({width,depth,start,reverse,corner:i}));
 }
});
test('snapping excludes the selected wall and never moves ordinary furniture or angled walls',()=>{
 const existing=wall('a',-4,-4),scene=emptyScene();scene.objects=[existing];
 assert.equal(snapWallPlacement(scene,existing).joined,false);
 const moved={...existing,x:-3};assert.equal(snapWallPlacement(scene,moved).joined,false);
 for(const raw of [{...existing,id:'b',type:'table'},{...existing,id:'b',rotation:45},{...existing,id:'b',x:NaN}])assert.equal(snapWallPlacement(scene,raw).joined,false);
 assert.deepEqual(wallSnapCandidates(scene,{...existing,id:'b'},{tolerance:-1}),[]);
});
test('crossing walls remain blocked and distant walls do not attract the preview',()=>{
 const scene=emptyScene();scene.objects=[wall('a',-4,-4)];
 const crossing=wall('b',-4,-4,4,90),far=wall('b',3,-4);
 assert.equal(snapWallPlacement(scene,crossing).joined,false);assert.equal(validatePlacement(scene,crossing).valid,false);
 assert.equal(snapWallPlacement(scene,far).joined,false);assert.deepEqual(snapWallPlacement(scene,far).item,far);
});
test('a snap never hides another obstacle, blocked terrain, the room edge or the player',()=>{
 const scene=emptyScene();scene.objects=[wall('a',-4,-4)];const item=wall('b',-2,-2,4,90);
 const candidates=wallSnapCandidates(scene,item);assert.ok(candidates.length>=2);
 const blocked={...scene,objects:[...scene.objects,{id:'blocker',type:'table',name:'Blocker',x:-2,z:-2,width:2,depth:3}]};
 assert.equal(snapWallPlacement(blocked,item).joined,false);
 const terrain={...scene,terrain:applyTerrainRect(undefined,{minX:-3,minZ:-3,maxX:-1,maxZ:0},{material:'water',blocked:true})};
 assert.equal(snapWallPlacement(terrain,item).joined,false);
 assert.equal(snapWallPlacement(scene,item,{position:{x:-2,z:-2}}).joined,false);
 const edge={...scene,bounds:{width:8,depth:8},objects:[wall('edge',0,-3)]};assert.equal(snapWallPlacement(edge,wall('new',2,-5,4,90)).joined,false);
});
test('joined walls retain collision and serialize as ordinary exact wall objects',()=>{
 const scene=emptyScene();scene.objects=[wall('a',-4,-4)];const result=snapWallPlacement(scene,wall('b',-2,-2,4,90));scene.objects.push(result.item);
 const saved=JSON.parse(encodeScene(scene));assert.deepEqual(saved.objects,scene.objects);
 const center=result.item;assert.equal(canStand(saved,center.x,center.z),false);
 const moved=movePlayer(saved,{x:center.x-1,z:center.z},2,0);assert.ok(moved.x<center.x-.4);
 assert.deepEqual(Object.keys(result.item).sort(),Object.keys(wall('b',-2,-2,4,90)).sort());
});
test('joined wall coordinates survive collaborative rebase and undo snapshots without shifting peer items',()=>{
 const base=emptyScene();base.objects=[wall('a',-4,-4)];
 const mine=structuredClone(base);mine.objects.push(snapWallPlacement(base,wall('b',-2,-2,4,90)).item);
 const server=structuredClone(base);server.objects.push({id:'peer',type:'chair',name:'Peer chair',x:6,z:2,rotation:0});
 const validate=(candidate,current)=>reconciliationGeometryProblem(current,candidate);
 const result=reconcileScenes({base,mine,server,validate});assert.equal(result.conflicts.length,0);
 assert.deepEqual(result.scene.objects.find(o=>o.id==='b'),mine.objects[1]);assert.deepEqual(result.scene.objects.find(o=>o.id==='peer'),server.objects[1]);
 const history=rebaseHistory([{scene:base,selected:null},{scene:mine,selected:'b'}],{base,server,validate});
 assert.equal(history.invalidated,false);assert.deepEqual(history.entries[0].scene,server);
 assert.deepEqual(history.entries[1].scene.objects.find(o=>o.id==='b'),mine.objects[1]);
});
