import test from 'node:test';
import assert from 'node:assert/strict';
import {mountSocialSheet} from '../src/social-sheet-layout.js';

function fixture(t, width=390, height=844) {
  const saved=new Map();
  const set=(name,value)=>{saved.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});};
  const viewport=Object.assign(new EventTarget(),{height,offsetTop:0});
  const win=Object.assign(new EventTarget(),{visualViewport:viewport});
  const doc=Object.assign(new EventTarget(),{hidden:false});
  let observer;
  set('window',win);set('document',doc);set('innerWidth',width);set('innerHeight',height);
  set('matchMedia',()=>({get matches(){return innerWidth<=700||innerHeight<=540;}}));
  set('MutationObserver',class {constructor(callback){observer=this;this.callback=callback;}observe(){}disconnect(){this.disconnected=true;}});
  const styles=new Map(),attrs=new Map(),captures=new Set();
  const root={hidden:false,inert:false,dataset:{},style:{setProperty:(k,v)=>styles.set(k,v),removeProperty:k=>styles.delete(k)},getBoundingClientRect:()=>({height:parseFloat(styles.get('--social-sheet-height'))||700})};
  const handle=Object.assign(new EventTarget(),{hidden:false,focus(){doc.activeElement=this;},setAttribute:(k,v)=>attrs.set(k,v),hasPointerCapture:id=>captures.has(id),setPointerCapture:id=>captures.add(id),releasePointerCapture:id=>captures.delete(id)});
  const sheet=mountSocialSheet(root,handle);
  t.after(()=>{sheet.destroy();for(const [name,descriptor] of saved)descriptor?Object.defineProperty(globalThis,name,descriptor):delete globalThis[name];});
  const emit=(type,fields={})=>{const event=new Event(type,{cancelable:true});Object.assign(event,fields);handle.dispatchEvent(event);return event;};
  const resize=(w,h,visual=h,top=0)=>{globalThis.innerWidth=w;globalThis.innerHeight=h;viewport.height=visual;viewport.offsetTop=top;win.dispatchEvent(new Event('resize'));};
  return {sheet,root,handle,styles,attrs,captures,viewport,win,doc,emit,resize,get observer(){return observer;},height:()=>root.getBoundingClientRect().height};
}

test('portrait keyboard resize clamps to available space and keeps focus in the handle',t=>{
  const f=fixture(t);assert.equal(f.handle.hidden,false);
  assert.equal(f.emit('keydown',{key:'Home'}).defaultPrevented,true);assert.equal(f.height(),340);
  f.emit('keydown',{key:'ArrowUp'});assert.equal(f.height(),388);
  f.emit('keydown',{key:'End'});assert.equal(f.height(),756);
  f.emit('keydown',{key:'ArrowUp'});assert.equal(f.height(),756);
  assert.equal(f.attrs.get('aria-valuemax'),'756');assert.equal(f.attrs.get('aria-valuenow'),'756');
});

test('cancelled pointer resize restores preference, releases capture and consumes Escape',t=>{
  const f=fixture(t);f.emit('keydown',{key:'Home'});
  f.emit('pointerdown',{button:0,pointerId:7,clientY:400});assert.equal(f.doc.activeElement,f.handle);assert(f.captures.has(7));
  f.emit('pointermove',{pointerId:8,clientY:200});assert.equal(f.height(),340);
  f.emit('pointermove',{pointerId:7,clientY:300});assert.equal(f.height(),440);
  assert.equal(f.emit('keydown',{key:'Escape'}).defaultPrevented,true);
  assert.equal(f.height(),340);assert.equal(f.captures.size,0);assert.equal(f.root.dataset.sheetResizing,undefined);
});

test('completed gesture survives viewport shrink and restores preferred portrait height',t=>{
  const f=fixture(t);f.emit('keydown',{key:'Home'});f.emit('pointerdown',{button:0,pointerId:1,clientY:400});f.emit('pointermove',{pointerId:1,clientY:300});f.emit('pointerup',{pointerId:1});
  assert.equal(f.height(),440);assert.equal(f.captures.size,0);
  f.resize(390,400);assert.equal(f.height(),400);assert.equal(f.handle.hidden,true);
  f.resize(390,844);assert.equal(f.height(),440);assert.equal(f.handle.hidden,false);
});

test('visual keyboard viewport and offset bound the sheet without discarding preferred size',t=>{
  const f=fixture(t);f.emit('keydown',{key:'End'});f.resize(390,844,350,24);
  assert.equal(f.height(),342);assert.equal(f.styles.get('--social-sheet-top'),'32px');
  assert.equal(f.styles.get('--social-sheet-bottom'),'470px');
  f.resize(390,844);assert.equal(f.height(),756);
});

test('hidden/inert state, lost capture and window blur cancel active gestures',t=>{
  const f=fixture(t);f.emit('keydown',{key:'Home'});
  for(const cause of ['hidden','inert','lostpointercapture','blur']) {
    f.emit('pointerdown',{button:0,pointerId:1,clientY:400});f.emit('pointermove',{pointerId:1,clientY:300});assert.equal(f.height(),440);
    if(cause==='hidden'||cause==='inert'){f.root[cause]=true;f.observer.callback();f.root[cause]=false;}
    else if(cause==='blur')f.win.dispatchEvent(new Event('blur'));else f.emit(cause);
    assert.equal(f.height(),340,cause);assert.equal(f.captures.size,0,cause);assert.equal(f.root.dataset.sheetResizing,undefined,cause);
  }
});

test('desktop and short landscape ignore resize gestures and do not prevent normal keys',t=>{
  const f=fixture(t,1280,850);assert.equal(f.styles.size,0);assert.equal(f.handle.hidden,true);
  assert.equal(f.emit('keydown',{key:'ArrowUp'}).defaultPrevented,false);
  f.resize(568,320);assert.equal(f.height(),320);assert.equal(f.handle.hidden,true);
  f.emit('pointerdown',{button:0,pointerId:1,clientY:300});assert.equal(f.captures.size,0);
});

test('destroy during a gesture clears presentation, disconnects observers and disables events',t=>{
  const f=fixture(t);f.emit('pointerdown',{button:0,pointerId:1,clientY:400});f.sheet.destroy();
  assert.equal(f.captures.size,0);assert.equal(f.styles.size,0);assert.equal(f.observer.disconnected,true);
  f.emit('keydown',{key:'End'});f.resize(320,568);f.viewport.dispatchEvent(new Event('resize'));
  assert.equal(f.styles.size,0);assert.equal(f.root.dataset.sheetResizing,undefined);
});
