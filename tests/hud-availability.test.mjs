import test from 'node:test';
import assert from 'node:assert/strict';
import {availableHudLane,createHudAvailability} from '../src/hud-availability.js';
const lane=panels=>availableHudLane({width:1440,height:950,panels});
const panel=(left,right,top=0,bottom=950)=>({left,right,top,bottom});
test('HUD lane uses real right bounds without touching canvas geometry',()=>assert.deepEqual(lane([panel(864,1440)]),{left:0,right:864,width:864,constrained:true}));
test('HUD lane supports left and simultaneous left/right surfaces',()=>assert.deepEqual(lane([panel(0,350),panel(900,1440)]),{left:350,right:900,width:550,constrained:true}));
test('HUD lane unions overlapping side surfaces and clips offscreen transforms',()=>assert.deepEqual(lane([panel(1050,1500),panel(900,1440)]),{left:0,right:900,width:900,constrained:true}));
test('Fullscreen sheets and centered modals retain whole HUD lane',()=>assert.deepEqual(lane([panel(0,1440),panel(400,1040,100,850)]),{left:0,right:1440,width:1440,constrained:false}));
test('No side panel restores unconstrained native layout',()=>assert.deepEqual(lane([]),{left:0,right:1440,width:1440,constrained:false}));
test('Unusable lane stays explicit rather than inventing covered available width',()=>assert.equal(lane([panel(0,800),panel(600,1440)]).width,0));

test('camera focus reveal binds once and scrolls only a clipped horizontal keyboard target',()=>{
 let handler,bindings=0;const scrolls=[],css={display:'flex',flexDirection:'row',overflowX:'auto'};
 const row={clientWidth:100,scrollWidth:300,scrollLeft:0,ownerDocument:{defaultView:{getComputedStyle:()=>css}},addEventListener:(name,fn)=>{assert.equal(name,'focusin');bindings++;handler=fn;},contains:el=>el===button,getBoundingClientRect:()=>({left:10,right:110}),scrollBy:value=>{scrolls.push(value);row.scrollLeft+=value.left;}};
 let rect={left:90,right:130},keyboard=true;const button={closest:()=>button,matches:selector=>{assert.equal(selector,':focus-visible');return keyboard;},getBoundingClientRect:()=>rect};
 const root={querySelector:selector=>{assert.equal(selector,'#view-controls');return row;}};
 createHudAvailability(root,{});createHudAvailability(root,{});assert.equal(bindings,1);
 handler({target:button});assert.deepEqual(scrolls,[{left:25,behavior:'instant'}]);
 rect={left:15,right:55};handler({target:button});assert.equal(scrolls.length,1);
 rect={left:-30,right:10};handler({target:button});assert.deepEqual(scrolls.at(-1),{left:-25,behavior:'instant'});assert.equal(row.scrollLeft,0);
 keyboard=false;rect={left:90,right:130};handler({target:button});assert.equal(scrolls.length,2);
 keyboard=true;css.flexDirection='column';handler({target:button});assert.equal(scrolls.length,2);
 css.flexDirection='row';row.clientWidth=0;handler({target:button});assert.equal(scrolls.length,2);
 row.clientWidth=100;rect={left:NaN,right:Infinity};handler({target:button});assert.equal(scrolls.length,2);
});
