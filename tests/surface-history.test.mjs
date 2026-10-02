import test from 'node:test';
import assert from 'node:assert/strict';
import {createSurfaceHistory,surfaceEntry,surfaceLayers} from '../src/surface-history.js';
function fixture(){
 let room='room',content=null,index=0,backCalls=0;const entries=[{room}],writes=[];
 const history={get state(){return entries[index];},pushState(state){entries.splice(++index,Infinity,state);writes.push('push');},replaceState(state){entries[index]=state;writes.push('replace');},back(){backCalls++;}};
 const machine=createSurfaceHistory({history,getRoom:()=>room,getContent:()=>content});
 return{machine,history,entries,writes,setContent:value=>content=value,setRoom:value=>room=value,get backs(){return backCalls;},back(fn=()=>{}){index--;machine.replay(fn);},forward(fn=()=>{}){index++;machine.replay(fn);}};
}
test('coexisting content survives primary replacement and nested foreground Back/Forward without extra writes',()=>{
 const f=fixture();f.setContent('opaque');f.machine.remember('content',{nested:true});f.machine.remember('chat');assert.equal(f.entries.length,3);
 f.machine.remember('places');assert.equal(f.entries.length,3);assert.deepEqual(f.history.state,{room:'room',surface:'places',content:'opaque'});
 f.machine.remember('express',{nested:true});assert.deepEqual(f.history.state.underlay,['places']);
 f.machine.dismiss('express');f.machine.dismiss('express');assert.equal(f.backs,1);
 const writes=f.writes.length;f.back(()=>{f.machine.dismiss('express');f.machine.remember('places');});assert.equal(f.writes.length,writes);assert.equal(f.backs,1);assert(f.machine.wantsContent('opaque'));
 f.forward(()=>f.machine.remember('express',{nested:true}));assert.equal(f.entries.length,4);assert.equal(f.writes.length,writes);assert.deepEqual(surfaceLayers(f.history.state,'room'),['places','express']);
});
test('exclusive Build/Explore replace primary state while images and profile avatar keep their real underlay',()=>{
 assert.deepEqual(surfaceEntry({room:'r',surface:'build'},{room:'r',surface:'places'}),{entry:{room:'r',surface:'places'},method:'replaceState'});
 assert.deepEqual(surfaceEntry({room:'r',surface:'build'},{room:'r',surface:'images',nested:true}).entry.underlay,['build']);
 assert.deepEqual(surfaceEntry({room:'r',surface:'settings'},{room:'r',surface:'avatar',nested:true}).entry.underlay,['settings']);
 assert.deepEqual(surfaceEntry({room:'r',surface:'build'},{room:'r',surface:'express',nested:true,visible:()=>false}).entry,{room:'r',surface:'express'});
});
test('pending close then open retains nested intent without duplicate back or replay pushes',()=>{
 const f=fixture();f.machine.remember('chat');f.machine.remember('palette',{nested:true});f.machine.dismiss('palette');f.machine.remember('avatar',{nested:true});f.back(()=>f.machine.remember('avatar',{nested:true}));
 assert.deepEqual(f.history.state,{room:'room',surface:'avatar',underlay:['chat']});assert.equal(f.entries.length,3);assert.equal(f.backs,1);
});
test('genuine async content reopening keeps the foreground and never stores provider data',()=>{
 const f=fixture();f.setContent('opaque');f.machine.remember('content',{nested:true});f.machine.remember('chat');const before=JSON.stringify(f.history.state);f.machine.remember('content',{nested:true});assert.equal(JSON.stringify(f.history.state),before);
 f.machine.forgetContent('different');assert.equal(JSON.stringify(f.history.state),before);f.machine.forgetContent('opaque');assert.deepEqual(f.history.state,{room:'room',surface:'chat',contentDismissedDepth:1});
 f.setRoom('elsewhere');assert(!f.machine.wantsContent('opaque'));assert.deepEqual(surfaceLayers({room:'room',surface:'chat',underlay:['unknown','https://private.invalid']},'elsewhere'),[]);
});
test('stale or malformed underlay names are bounded to known surfaces and current room',()=>{
 assert.deepEqual(surfaceLayers({room:'r',surface:'chat',underlay:['chat','build','content','unknown','build']},'r'),['chat','build']);
 assert.deepEqual(surfaceLayers({room:'r',surface:'chat',underlay:'private'},'r'),['chat']);
});

test('closing content beneath Chat never resurrects it on UI close, while native Back preserves history',()=>{
 const f=fixture();f.setContent('opaque');f.machine.remember('content',{nested:true});f.machine.remember('chat');
 f.setContent(null);f.machine.dismiss('content');assert.equal(f.backs,0);assert.deepEqual(f.history.state,{room:'room',surface:'chat',contentDismissedDepth:1});
 f.machine.dismiss('chat');assert.equal(f.backs,0);assert.deepEqual(f.history.state,{room:'room'});assert.deepEqual(f.entries[1],{room:'room',surface:'content',content:'opaque'});
 f.machine.remember('chat');f.machine.dismiss('chat');f.back();assert.deepEqual(f.history.state,{room:'room'});assert.equal(f.backs,1);
 f.back();assert(f.machine.wantsContent('opaque'));f.forward();assert.deepEqual(f.history.state,{room:'room'});
});
test('changed-background boundary survives primary replacement and nested foreground dismissals',()=>{
 const f=fixture();f.setContent('opaque');f.machine.remember('content',{nested:true});f.machine.remember('chat');f.setContent(null);f.machine.dismiss('content');
 f.machine.remember('places');assert.equal(f.history.state.contentDismissedDepth,1);f.machine.remember('palette',{nested:true});assert.equal(f.history.state.contentDismissedDepth,1);
 f.machine.dismiss('palette');f.back();assert.equal(f.history.state.surface,'places');assert.equal(f.history.state.contentDismissedDepth,1);f.machine.dismiss('places');assert.equal(f.backs,1);assert.deepEqual(f.history.state,{room:'room'});
});
test('content closed below an already nested surface dismisses only that foreground before its underlay',()=>{
 const f=fixture();f.setContent('opaque');f.machine.remember('content',{nested:true});f.machine.remember('chat');f.machine.remember('express',{nested:true});f.setContent(null);f.machine.dismiss('content');
 f.machine.dismiss('express');assert.deepEqual(f.history.state,{room:'room',surface:'chat',contentDismissedDepth:1});assert.equal(f.backs,0);f.machine.dismiss('chat');assert.deepEqual(f.history.state,{room:'room'});assert.equal(f.backs,0);
});

test('Chat to People to Help carries a closed-content boundary until all foreground is dismissed',()=>{
 const f=fixture();f.setContent('opaque');f.machine.remember('content',{nested:true});f.machine.remember('chat');f.setContent(null);f.machine.dismiss('content');
 f.machine.remember('people');assert.equal(f.history.state.contentDismissedDepth,1);f.machine.remember('dialog',{nested:true});assert.equal(f.history.state.contentDismissedDepth,1);assert.deepEqual(f.history.state.underlay,['people']);
 f.machine.dismiss('dialog');f.back();assert.deepEqual(f.history.state,{room:'room',surface:'people',contentDismissedDepth:1});f.machine.dismiss('people');assert.deepEqual(f.history.state,{room:'room'});assert.equal(f.backs,1);assert.equal(f.entries[1].content,'opaque');
});
