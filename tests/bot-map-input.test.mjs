import test from 'node:test';
import assert from 'node:assert/strict';
import {createBotMapInput} from '../src/bot-map-input.js';
function fixture(){
 let mode=null,owner={roomId:'room',botId:'bot'},draft={spawn:{x:0,z:0},radius:6,waypoints:[],restrictedAreaIds:[]},places=[],patches=[],previews=[];
 const editor={getDraft:()=>structuredClone(draft),getIdentity:()=>owner,getMapMode:()=>mode,beginMapMode:value=>mode=value,previewMapPoint:p=>({...structuredClone(draft),waypoints:[...draft.waypoints,p]}),placeMapPoint:p=>places.push(p),updateMap:patch=>{patches.push(patch);Object.assign(draft,patch);return true;}};
 const input=createBotMapInput({getEditor:()=>editor,getState:()=>({scene:{bounds:{width:32,depth:26},objects:[],areas:[]}}),getPreview:()=>({bot:draft}),showPreview:b=>previews.push(b),toast:()=>{}});
 return {input,places,patches,previews,setMode:value=>mode=value,setOwner:value=>owner=value,getDraft:()=>draft,getMode:()=>mode};
}
const floor={type:'ground',point:{x:3,z:2}},event={clientX:30,clientY:20};
test('floor placement requires explicit mode and one uninterrupted owned pointer',()=>{
 const f=fixture();assert.equal(f.input.pointerDown(floor,event),false);assert.equal(f.input.pointerUp(floor,event),false);f.setMode('add');assert.equal(f.input.pointerDown(floor,event),true);f.input.pointerUp(floor,event);assert.deepEqual(f.places,[floor.point]);assert.equal(f.input.pointerUp(floor,event),false);assert.equal(f.places.length,1);
});
test('Escape/camera cancellation consumes the pending floor placement',()=>{
 const f=fixture();f.setMode('add');f.input.pointerDown(floor,event);assert.equal(f.input.cancelGesture(),true);f.input.pointerMove({point:{x:4,z:2}},{clientX:40,clientY:20});f.input.pointerUp(floor,event);assert.deepEqual(f.places,[]);assert.deepEqual(f.patches,[]);
});
test('resident or room changes cannot commit a stale handle or floor click',()=>{
 for(const type of ['ground','bot-handle']){const f=fixture();f.setMode('spawn');f.input.pointerDown({...floor,type,id:'spawn'},event);f.setOwner({roomId:'other',botId:'other'});f.input.pointerMove({point:{x:4,z:2}},{clientX:40,clientY:20});f.input.pointerUp(floor,event);assert.deepEqual(f.places,[]);assert.deepEqual(f.patches,[]);}
});
test('native handle drag stays preview-only until release and keeps navigation checks',()=>{
 const f=fixture();f.input.pointerDown({type:'bot-handle',id:'spawn',point:{x:0,z:0}},{clientX:0,clientY:0});f.input.pointerMove(floor,event);assert.deepEqual(f.getDraft().spawn,{x:0,z:0});f.input.pointerUp(floor,event);assert.deepEqual(f.getDraft().spawn,{x:3,z:2});
 f.input.pointerDown({type:'bot-handle',id:'spawn',point:{x:3,z:2}},event);f.input.pointerUp({point:{x:99,z:99}},{clientX:100,clientY:100});assert.deepEqual(f.getDraft().spawn,{x:3,z:2});
});
test('arrow keys in add mode never move the resident unexpectedly',()=>{const f=fixture();f.setMode('add');f.input.nudge('ArrowLeft');assert.deepEqual(f.patches,[]);});

test('clicking a visible home or numbered handle opens the matching editing mode',()=>{for(const handle of ['spawn','waypoint:0']){const f=fixture(),hit={type:'bot-handle',id:handle,point:{x:0,z:0}};f.input.pointerDown(hit,event);f.input.pointerUp(hit,event);assert.equal(f.getMode(),handle);assert.deepEqual(f.patches,[]);}});
