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
