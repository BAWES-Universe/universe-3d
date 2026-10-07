/** Native multi-touch guest movement on the actual canvas. No game-state writes. */
import assert from 'node:assert/strict';
export async function guestTouchMotion({page,context,out,label}) {
 const records=[];
 const state=()=>page.evaluate(()=>({position:__universe.getState().position,camera:__universe.getCamera(),motion:__universe.getMotion()}));
 const pose=async seat=>{
  await page.waitForFunction(seat=>{const s=__universe.getState(),m=__universe.getMotion();return (seat?!!m.seatId:m.seatId===null)&&s.people.some(p=>p.id===s.user.id&&(p.seatId??null)===m.seatId);},seat);
 };
 for(const side of ['right','left']) {
  await page.waitForFunction(()=>{const b=document.querySelector('#interact'),r=b.getBoundingClientRect();return !b.hidden&&r.width>=48&&r.height>=48&&b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});
  await page.locator('#interact').tap();await pose(true);
  assert.match(await page.locator('#interact').innerText(),/Stand up/);
  await page.screenshot({path:`${out}/${label}-${side}-seated.png`});
  await page.locator('#interact').tap();await pose(false);
  await page.locator('#movement-side-toggle').tap();
 }
 for(const side of ['right','left']) {
  await page.waitForFunction(()=>['joystick','jump-button'].every(id=>{const b=document.getElementById(id),r=b.getBoundingClientRect();return r.width>=44&&r.height>=44&&b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}));
  const box=await page.locator('#joystick').boundingBox(),jump=await page.locator('#jump-button').boundingBox(),width=page.viewportSize().width;
  const center={id:1,x:box.x+box.width/2,y:box.y+box.height/2},finger={...center,y:center.y-26};
  const world=width<400?[{id:2,x:110,y:220},{id:3,x:170,y:220}]:[{id:2,x:250,y:180},{id:3,x:310,y:180}];
  for(const p of world)assert.equal(await page.evaluate(p=>document.elementFromPoint(p.x,p.y)?.id,p),'game');
  const cdp=await context.newCDPSession(page),before=await state();
  await page.evaluate(()=>{window.guestTouchEvents=[];if(!window.guestTouchCapture){window.guestTouchCapture=e=>guestTouchEvents.push({type:e.type,id:e.pointerId,target:e.target.id,trusted:e.isTrusted,pointerType:e.pointerType});for(const t of ['pointerdown','pointerup','pointercancel'])document.addEventListener(t,guestTouchCapture,true);}});
  try {
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[center]});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[finger]});
   await page.waitForFunction(()=>__universe.getMotion().speed>.2);
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[finger,...world]});
   const moved=world.map(p=>({...p,x:p.x+18}));
   await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[finger,...moved]});
   await page.waitForFunction(yaw=>Math.abs(__universe.getCamera().yaw-yaw)>.02,before.camera.yaw);
   await page.evaluate(()=>{window.guestJumpTrace={active:true,apex:0};function sample(){guestJumpTrace.apex=Math.max(guestJumpTrace.apex,__universe.getState().position.y);if(guestJumpTrace.active)requestAnimationFrame(sample);}sample();});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[finger,...moved,{id:4,x:jump.x+jump.width/2,y:jump.y+jump.height/2}]});
   await page.waitForFunction(()=>__universe.getState().position.y>.1&&__universe.getMotion().speed>0);
   await page.screenshot({path:`${out}/${label}-${side}-moving-jump.png`});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   await page.waitForFunction(()=>__universe.getMotion().grounded&&__universe.getMotion().speed===0);
   const after=await state(),trace=await page.evaluate(()=>{guestJumpTrace.active=false;return {apex:guestJumpTrace.apex,events:guestTouchEvents,path:__universe.getPath()};});
   assert(trace.apex>1.2);assert.equal(after.position.y,0);assert(Math.hypot(after.position.x-before.position.x,after.position.z-before.position.z)>.1);assert.deepEqual(trace.path,[]);
   assert(trace.events.every(e=>e.trusted&&e.pointerType==='touch'));
   assert.equal(trace.events.filter(e=>e.type==='pointerdown'&&e.target==='game').length,2);
   assert.equal(trace.events.filter(e=>e.type==='pointerdown'&&e.target==='jump-button').length,1);
   assert.equal(trace.events.filter(e=>e.type==='pointerdown'&&['joystick','joystick-thumb'].includes(e.target)).length,1);
   records.push({side,before,after,...trace});
  } finally {await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}).catch(()=>{});await page.evaluate(()=>{if(window.guestJumpTrace)guestJumpTrace.active=false;}).catch(()=>{});await cdp.detach();}
  await page.locator('#movement-side-toggle').tap();
 }
 return records;
}
