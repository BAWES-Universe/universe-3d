import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEnvironment} from '../src/scene-layout.js';
function capture(bounds,theme='garden'){
 const items=[],make=(kind,name,args)=>{const v={kind,name,args};items.push(v);return v;};
 const helpers={box:(...a)=>make('box',a[0],a.slice(1)),ground:(...a)=>make('ground',a[0],a.slice(1)),cylinder:(...a)=>make('cylinder',a[0],a.slice(1)),sphere:(...a)=>make('sphere',a[0],a.slice(1)),brand:(...a)=>make('brand','brand',a),material(){}};
 buildEnvironment({bounds,theme},{},helpers);return items;
}
test('foundation stays below walkable ground, avoiding coplanar flicker',()=>{const items=capture({width:32,depth:26});for(const name of ['bedrock','sandstone-course','edge-cap']){const i=items.find(i=>i.name===name);const [,y,,,height]=i.args;assert(y+height/2<0,name);}});
test('compact custom rooms do not get out-of-bounds Commons decks',()=>{const items=capture({width:8,depth:8});assert(!items.some(i=>i.name==='table-deck'));for(const i of items.filter(i=>i.kind==='ground')){const [x,,z,w,d]=i.args;assert(Math.abs(x)+w/2<=4);assert(Math.abs(z)+d/2<=4);}});
test('full Commons has distinct stone, timber, soil and grass surface zones',()=>{const items=capture({width:32,depth:26});const kinds=new Set(items.filter(i=>i.kind==='ground').map(i=>i.args[5]));for(const kind of ['grass','stone','wood','soil'])assert(kinds.has(kind));assert(items.some(i=>i.name==='perennial-bed'));});
test('arrival uses integrated stone paving with no floor logo or contrasting disk',()=>{const items=capture({width:32,depth:26});assert(!items.some(i=>i.kind==='brand'||i.name==='arrival-plaza'||i.name==='arrival-inlay'));const arrival=items.find(i=>i.name==='arrival-court'),path=items.find(i=>i.name==='commons-promenade');assert(arrival);assert.equal(arrival.kind,'ground');assert.equal(arrival.args[1],path.args[1]);assert.equal(arrival.args[5],path.args[5]);assert.equal(arrival.args[6],path.args[6]);});
const overlap=(a,b)=>Math.abs(a[0]-b[0])<(a[3]+b[3])/2-1e-8&&Math.abs(a[2]-b[2])<(a[4]+b[4])/2-1e-8;
test('unlike overlapping flat environment surfaces never share depth',()=>{
 for(const theme of ['garden','studio','night'])for(const bounds of [{width:32,depth:26},{width:26,depth:22},{width:64,depth:64},{width:8,depth:8}]){
  const grounds=capture(bounds,theme).filter(item=>item.kind==='ground');
  for(let i=0;i<grounds.length;i++)for(let j=i+1;j<grounds.length;j++){
   const a=grounds[i],b=grounds[j],unlike=a.args[5]!==b.args[5]||a.args[6]!==b.args[6];
   if(unlike&&overlap(a.args,b.args))assert(Math.abs(a.args[1]-b.args[1])>=.002-1e-9,`${theme}: ${a.name}/${b.name} overlap at ${a.args[1]}/${b.args[1]}`);
  }
 }
});
test('garden material layers are deterministic, bounded below images, and non-solid',()=>{
 const bounds={width:32,depth:26},items=capture(bounds),again=capture(bounds);
 const names=['commons-promenade','commons-entry','portal-walk','arrival-court','table-deck','quiet-terrace'];
 for(const name of names){const item=items.find(item=>item.name===name);assert.deepEqual(item,again.find(item=>item.name===name));assert.equal(item.kind,'ground');assert(item.args[1]>=.03&&item.args[1]<.05);assert.equal(item.args[8],undefined,'no pickable/collision surface added');}
 assert.equal(items.find(i=>i.name==='portal-walk').args[1],.03);
 assert.equal(items.find(i=>i.name==='table-deck').args[1],.034);
 assert.equal(items.find(i=>i.name==='quiet-terrace').args[1],.038);
});
