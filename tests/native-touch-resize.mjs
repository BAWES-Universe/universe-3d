import assert from 'node:assert/strict';
/** Observe the real handle's pointer lifecycle, without changing app state.
 * CDP touchCancel is nonblocking: its acknowledgement is not DOM completion.
 * Arm before touchStart and observe on the handle after its app listeners,
 * since the resize handler stops pointerdown/pointerup propagation.
 */
export async function observeNativeTouchResize(handle){
 const observation=await handle.evaluateHandle(node=>{
  const events=[],types=['pointerdown','gotpointercapture','pointercancel','pointerup','lostpointercapture'];
  const record=event=>events.push({type:event.type,id:event.pointerId,trusted:event.isTrusted,pointerType:event.pointerType,captured:node.hasPointerCapture(event.pointerId)});
  for(const type of types)node.addEventListener(type,record);
  return {events,remove(){for(const type of types)node.removeEventListener(type,record);}};
 });
 return async terminal=>{
  try{
   await handle.page().waitForFunction(({observation,terminal})=>{
    const owner=observation.events.find(event=>event.type==='pointerdown');
    return owner&&observation.events.some(event=>event.id===owner.id&&event.type===terminal)&&observation.events.some(event=>event.id===owner.id&&event.type==='lostpointercapture');
   },{observation,terminal});
   const events=await observation.evaluate(value=>value.events),owner=events[0].id;
   assert.deepEqual(events.map(event=>event.type),['pointerdown','gotpointercapture',terminal,'lostpointercapture']);
   assert(events.every(event=>event.id===owner&&event.trusted&&event.pointerType==='touch'),'A single trusted touch pointer owns the complete resize lifecycle');
   assert.deepEqual(events.map(event=>event.captured),[true,true,false,false],'The resize handle acquires capture and releases it before the next gesture');
  }finally{await observation.evaluate(value=>value.remove());await observation.dispose();}
 };
}
