import test from 'node:test';
import assert from 'node:assert/strict';
import {mountWorldInput} from '../src/world-input.js';

class Target extends EventTarget {
  classList={add(){},remove(){},toggle(){}};
  style={};
  setPointerCapture(){}
  releasePointerCapture(){}
  focus(){}
}
function pointer(target,type,id,x,y){
  const event=new Event(type,{cancelable:true});
  Object.assign(event,{pointerId:id,pointerType:'touch',button:0,clientX:x,clientY:y});
  target.dispatchEvent(event);
}
for(const released of [1,2,3])test(`lifting touch ${released} rebases pinch and orbit without a camera jump`,()=>{
  const oldWindow=globalThis.window;globalThis.window=new Target();
  const canvas=new Target(),calls=[],points=new Map([[1,[100,100]],[2,[200,100]],[3,[300,200]]]);
  const input=mountWorldInput({canvas,joystickRoot:new Target(),joystickThumb:new Target(),getContext:()=>({ready:true}),getRenderer:()=>({setGhost(){},getCameraState:()=>({distance:25}),zoom:n=>calls.push(['zoom',n]),orbit:(x,y)=>calls.push(['orbit',x,y]),pan:(x,y)=>calls.push(['pan',x,y]),pick:()=>({point:{x:0,z:0}})}),getEditor:()=>null,onWalkTo:()=>calls.push(['walk']),onInteract:()=>false,onJoystick(){}});
  try{
    for(const [id,[x,y]]of points)pointer(canvas,'pointerdown',id,x,y);
    pointer(canvas,'pointerup',released,...points.get(released));points.delete(released);
    const [id,[x,y]]=[...points][0];
    pointer(canvas,'pointermove',id,x,y);
    assert(calls.every(([, ...values])=>values.every(n=>n===0)),`stationary surviving touches moved the camera: ${JSON.stringify(calls)}`);
    calls.length=0;pointer(canvas,'pointermove',id,x+2,y);
    assert.equal(calls.at(-1)[0],'orbit');assert.equal(calls.at(-1)[1],1);assert.equal(calls.at(-1)[2],0);
    for(const [id,[x,y]]of points)pointer(canvas,'pointerup',id,x,y);
    assert(!calls.some(([kind])=>kind==='walk'),'camera gesture must not fall through to walking');
  }finally{input.destroy();globalThis.window=oldWindow;}
});
