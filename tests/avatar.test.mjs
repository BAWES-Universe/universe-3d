import test from 'node:test';
import assert from 'node:assert/strict';
import {NullEngine} from '@babylonjs/core/Engines/nullEngine.js';
import {Scene} from '@babylonjs/core/scene.js';
import {Vector3} from '@babylonjs/core/Maths/math.vector.js';
import {AVATAR_PRESETS,AVATAR_OPTIONS,AVATAR_PALETTES,DEFAULT_APPEARANCE,normalizeAppearance,validateAppearance,appearanceKey,appearanceForUser} from '../src/avatar-spec.js';
import {createAvatarRig} from '../src/avatar-rig.js';
const copy=()=>structuredClone(DEFAULT_APPEARANCE);
test('avatar canonical schema validates all original presets and bounded palette',()=>{
 for(const p of AVATAR_PRESETS)assert.deepEqual(validateAppearance(p.appearance),p.appearance);
 for(const [key,values]of Object.entries(AVATAR_OPTIONS))for(const {id}of values){const a=copy();if(['height','build'].includes(key))a.body[key]=id;else a[key]=id;assert.doesNotThrow(()=>validateAppearance(a));}
 for(const [key,values]of Object.entries(AVATAR_PALETTES))for(const color of values){const a=copy();a[key]=color;assert.equal(validateAppearance(a)[key],color);}
});
test('avatar writes reject unknown catalog, style, entitlements, oversized and malformed data',()=>{
 for(const bad of[null,[],{},2,'avatar', {...copy(),version:2},{...copy(),catalog:'paid-unlocked'},{...copy(),skin:'javascript:alert(1)'},{...copy(),topStyle:'admin-exclusive'},{...copy(),entitlements:['all']},{...copy(),body:{height:'average',build:'balanced',heightCm:999}},{...copy(),hairColor:'#000000'},{...copy(),hat:'x'.repeat(100000)}])assert.throws(()=>validateAppearance(bad),{code:'INVALID_APPEARANCE'});
});
test('legacy Wokas normalize deterministically without mutating canonical defaults',()=>{
 assert.deepEqual(normalizeAppearance(1),AVATAR_PRESETS[1].appearance);assert.deepEqual(normalizeAppearance('2'),AVATAR_PRESETS[2].appearance);assert.deepEqual(appearanceForUser({appearance:AVATAR_PRESETS[4].appearance,woka:0}),AVATAR_PRESETS[4].appearance);
 const a=normalizeAppearance(0);a.body.build='soft';assert.equal(DEFAULT_APPEARANCE.body.build,'balanced');assert.equal(appearanceKey(normalizeAppearance(3)),appearanceKey(3));
});
test('native avatar geometry has depth, articulated parts, bounded meshes, and shared material',()=>{
 const engine=new NullEngine(),scene=new Scene(engine),one=createAvatarRig(scene,0),two=createAvatarRig(scene,1);
 assert.equal(one.meshes.length,8);assert.equal(scene.materials.length,1);assert(one.meshes.every(m=>m.getTotalVertices()>0&&m.material===two.meshes[0].material));
 one.root.computeWorldMatrix(true);const bounds=one.root.getHierarchyBoundingVectors(true);assert(bounds.max.y-bounds.min.y>1.9);assert(bounds.max.z-bounds.min.z>.60);assert(bounds.max.x-bounds.min.x>.70);assert.equal(one.root.metadata.forwardAxis,'+Z');
 one.dispose();two.dispose();assert.equal(scene.meshes.length,0);engine.dispose();
});
test('heading follows actual world velocity for all cardinal directions, independent of camera',()=>{
 const engine=new NullEngine(),scene=new Scene(engine),rig=createAvatarRig(scene,0);
 for(const[x,z,yaw]of[[0,1,0],[1,0,Math.PI/2],[0,-1,Math.PI],[-1,0,-Math.PI/2]]){for(let i=0;i<60;i++)rig.update({velocity:{x,z},heading:99,dt:1/60,moving:true});const forward=Vector3.TransformNormal(Vector3.Forward(),rig.root.computeWorldMatrix(true)).normalize();assert(Math.abs(forward.x-x)<.001);assert(Math.abs(forward.z-z)<.001);assert(Math.abs(rig.heading-yaw)<.001);}
 const yaw=rig.root.rotation.y;rig.update({velocity:{x:0,z:0},dt:0});assert.equal(rig.root.rotation.y,yaw);rig.dispose();engine.dispose();
});
test('shape changes rebuild genuine volume with no accumulating scene meshes',()=>{
 const engine=new NullEngine(),scene=new Scene(engine),rig=createAvatarRig(scene,0),counts=new Set();
 for(const hair of AVATAR_OPTIONS.hairStyle){rig.setAppearance({...copy(),hairStyle:hair.id});counts.add(rig.meshes.reduce((n,m)=>n+m.getTotalVertices(),0));assert.equal(scene.meshes.length,8);}
 assert(counts.size>=6);const original=rig.root.scaling.clone();rig.setAppearance({...copy(),body:{height:'tall',build:'soft'},bag:'backpack',glasses:'round',headphones:'over-ear'});assert(rig.root.scaling.y>original.y);assert(rig.root.scaling.x>original.x);assert.equal(scene.materials.length,1);rig.dispose();engine.dispose();
});
test('walk and 2.5x fast-walk poses differ; idle settles without direction reset',()=>{
 const engine=new NullEngine(),scene=new Scene(engine),rig=createAvatarRig(scene,0);const left=()=>rig.root.getChildTransformNodes(false).find(n=>n.name.endsWith('left-leg'));
 for(let i=0;i<20;i++)rig.update({moving:true,running:false,dt:1/60,velocity:{x:1,z:0}});const walking=left().rotation.x;
 for(let i=0;i<20;i++)rig.update({moving:true,running:true,dt:1/60,velocity:{x:2.5,z:0}});assert.notEqual(left().rotation.x,walking);
 for(let i=0;i<120;i++)rig.update({moving:false,dt:1/60});assert(Math.abs(left().rotation.x)<.001);assert.equal(rig.heading,Math.PI/2);rig.dispose();engine.dispose();
});

test('garment surfaces face outward, keeping front details occluded from behind',()=>{
 const engine=new NullEngine(),scene=new Scene(engine),rig=createAvatarRig(scene,0),mesh=rig.meshes.find(m=>m.name.endsWith('body-geometry')),p=mesh.getVerticesData('position'),n=mesh.getVerticesData('normal');
 let front=false,back=false;for(let i=0;i<p.length;i+=3)if(p[i+1]>.8&&p[i+1]<1.2&&Math.abs(p[i])<.02){if(p[i+2]<-.16){assert(n[i+2]<-.9);back=true;}if(p[i+2]>.16&&p[i+2]<.17){assert(n[i+2]>.9);front=true;}}assert(front&&back);rig.dispose();engine.dispose();
});
test('hats tuck high hair geometry without changing the saved hairstyle',()=>{
 const engine=new NullEngine(),scene=new Scene(engine),rig=createAvatarRig(scene,{...copy(),hairStyle:'bun'});rig.root.computeWorldMatrix(true);const bare=rig.root.getHierarchyBoundingVectors(true).max.y;rig.setAppearance({...copy(),hairStyle:'bun',hat:'cap'});rig.root.computeWorldMatrix(true);const capped=rig.root.getHierarchyBoundingVectors(true).max.y;assert(capped<bare-.10);assert.equal(rig.appearance.hairStyle,'bun');rig.setAppearance({...rig.appearance,hat:'none'});assert.equal(rig.root.getHierarchyBoundingVectors(true).max.y,bare);rig.dispose();engine.dispose();
});
