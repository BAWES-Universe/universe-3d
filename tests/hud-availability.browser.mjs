/** Native browser input in the actual game; all fixture content is local. */
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {launch} from '../scripts/browser.mjs';
import {createGameServer} from '../server/app.mjs';
const out=process.env.HUD_EVIDENCE||'evidence/hud-availability';await mkdir(out,{recursive:true});
const scene={version:1,theme:'garden',bounds:{width:32,depth:26},spawn:{x:0,z:0},objects:[],areas:[{id:'content',name:'Content',action:'welcome',x:0,z:0,width:20,depth:20,actions:[{id:'open',type:'link',label:'Open content fixture',url:'https://hud-fixture.invalid/',mode:'embed',width:60,closable:true},{id:'wide',type:'link',label:'Open wide content',url:'https://hud-fixture.invalid/wide',mode:'embed',width:90,closable:true},{id:'message',type:'message',label:'Read local message',message:'A local content action'}]}]};
const dist=new URL('../dist',import.meta.url).pathname,app=createGameServer({dist,seeds:[{id:'hud-world',name:'HUD world',rooms:[{id:'hud-room',name:'HUD room',scene}]}],questsEnabled:false}),{port}=await app.listen(0),browser=await launch();
const checks=[],errors=[],contexts=[],historyDispositions=[];let page,storage;
const pass=(name,detail={})=>{checks.push({name,status:'passed',...detail});console.log('PASS',name);};
const settle=()=>page.waitForTimeout(700);
async function hit(locator,{scroll=true}={}){
 if(scroll)await locator.scrollIntoViewIfNeeded();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const state=await locator.evaluate(el=>{const r=el.getBoundingClientRect(),target=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{rect:r.toJSON(),hit:el===target||el.contains(target),target:target?.outerHTML.slice(0,180),width:innerWidth,height:innerHeight};});
 assert(state.rect.x>=-.5&&state.rect.right<=state.width+.5&&state.rect.y>=-.5&&state.rect.bottom<=state.height+.5,JSON.stringify(state));assert(state.hit,JSON.stringify(state));return state;
}
async function press(locator,touch=false){await hit(locator);if(touch)await locator.tap();else await locator.click();await page.waitForTimeout(150);}
async function customReachable(touch=false){
 // Build can become visible before ResizeObserver moves secondary controls
 // into More. Wait for the measured layout before choosing the native route;
 // an early isVisible() result can otherwise refer to a now-hidden control.
 await page.waitForFunction(()=>{
  const editor=document.querySelector('#editor'),r=editor.getBoundingClientRect(),short=r.height<540;
  return r.width>0&&r.height>0&&editor.dataset.short===String(short)&&editor.dataset.compact===String(r.width<760||short);
 },null,{timeout:5000});
 const custom=page.getByRole('button',{name:'Custom images',exact:true});
 if(await custom.isVisible()){await hit(custom);return;}
 const more=page.getByRole('button',{name:'More build tools',exact:true});
 if(!await more.isVisible())for(const name of ['Close furniture tray','Close terrain palette','Close item details']){const close=page.getByRole('button',{name,exact:true});if(await close.isVisible()){await press(close,touch);break;}}
 await press(more,touch);await hit(custom);await press(page.getByRole('button',{name:'Close more build tools',exact:true}),touch);
}
async function noOverflow(){const g=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,canvas:document.querySelector('#game').getBoundingClientRect().toJSON(),dpr:devicePixelRatio,render:document.querySelector('#game').width}));assert(g.scroll<=g.width,JSON.stringify(g));assert.equal(g.canvas.width,g.width);assert.equal(await page.evaluate(()=>__universe.getCamera().viewportWidth),1);return g;}
async function open(name='Open content fixture',touch=false){await press(page.getByRole('button',{name,exact:true}),touch);await page.locator('.embedded-panel').waitFor();await settle();}
async function historyDisposition(action){await settle();historyDispositions.push({action,...await page.evaluate(()=>({surface:history.state?.surface||null,embed:!!document.querySelector('#embedded-content:not([hidden])'),chat:!document.querySelector('#social').hidden,build:!document.querySelector('#editor').hidden}))});}
async function ensureEmbed(){if(!await page.locator('.embedded-panel').isVisible())await open();}
async function start(viewport,touch=false){const ctx=await browser.newContext({viewport,deviceScaleFactor:2,hasTouch:touch,isMobile:touch,...storage?{storageState:storage}:{}});contexts.push(ctx);page=await ctx.newPage();page.setDefaultTimeout(60000);page.on('pageerror',e=>errors.push(e.message));await page.route('https://hud-fixture.invalid/**',r=>r.fulfill({contentType:'text/html',body:'<h1>Local content fixture</h1><input aria-label="Frame typing" />'}));await page.goto(`http://127.0.0.1:${port}/?room=hud-room`,{waitUntil:'domcontentloaded'});if(!storage){await page.getByPlaceholder('Your name').fill('HUD acceptance');await page.locator('#join-button').click();}await page.waitForFunction(()=>window.__universe?.getState().ready);await settle();if(!storage)storage=await ctx.storageState();return ctx;}
async function cameraRowCheck(){
 const ids=['zoom-in','zoom-out','rotate-camera','camera-right','camera-tilt-up','camera-tilt-down','camera-pan','camera-follow','home-camera'],layouts=[];
 for(const width of[1440,1024]){
  await page.setViewportSize({width,height:950});await settle();if(width===1024)await open('Open wide content');
  assert.equal(await page.locator('#social').isVisible(),true);assert.equal(await page.locator('.embedded-panel').isVisible(),true);
  const row=page.locator('#view-controls'),geometry=await row.evaluate(el=>{const r=el.getBoundingClientRect(),css=getComputedStyle(el);return{direction:css.flexDirection,overflowX:css.overflowX,overflowY:css.overflowY,clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,clientHeight:el.clientHeight,scrollHeight:el.scrollHeight,scrollTop:el.scrollTop,rect:r.toJSON(),buttons:[...el.querySelectorAll('button')].map(b=>({id:b.id,...b.getBoundingClientRect().toJSON()}))};});
  assert.equal(geometry.direction,'row');assert.equal(geometry.overflowX,'auto');assert.equal(geometry.overflowY,'hidden');
  assert(geometry.scrollHeight<=geometry.clientHeight,'camera controls must not hide vertical overflow');assert.equal(geometry.scrollTop,0);
  for(const [i,b] of geometry.buttons.entries()){
   assert(Math.abs(b.top-geometry.buttons[0].top)<.5&&b.top>=geometry.rect.top&&b.bottom<=geometry.rect.bottom,JSON.stringify(geometry));
   if(i)assert(b.left>=geometry.buttons[i-1].right,'camera controls are ordered horizontally without overlap');
  }
  if(width===1440){for(const b of geometry.buttons)assert(b.left>=geometry.rect.left&&b.right<=geometry.rect.right,'all desktop camera controls are visible before input');}
  if(width===1440)await page.screenshot({path:out+'/desktop-chat-content-before-camera-input.png'});
  // Native Tab exercises the app focus reveal; never scrollIntoView here.
  const beforeInput=await page.evaluate(()=>({position:__universe.getState().position,camera:__universe.getCamera(),documentScroll:{x:scrollX,y:scrollY},dockScroll:document.querySelector('#dock').scrollLeft,socialScroll:document.querySelector('#social').scrollTop}));
  await page.locator('#zoom-in').focus();
  for(const [i,id] of ids.entries()){
   assert.equal(await page.locator(':focus').getAttribute('id'),id);
   await page.waitForFunction(id=>{const el=document.getElementById(id),r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));},id,{timeout:5000});
   await hit(page.locator(':focus'),{scroll:false});
   assert(await page.locator(':focus').evaluate(el=>{const r=el.getBoundingClientRect(),p=el.parentElement.getBoundingClientRect();return r.left>=p.left+4&&r.right<=p.right-4;}),'entire focused camera control and inset focus ring are visible');
   assert.equal(await row.evaluate(el=>el.scrollTop),0);
   if(i<ids.length-1)await page.keyboard.press('Tab');
  }
  const tabScroll=await row.evaluate(el=>el.scrollLeft);
  await page.locator('#zoom-in').focus();await page.waitForFunction(()=>document.querySelector('#view-controls').scrollLeft===0,null,{timeout:5000});await hit(page.locator('#zoom-in'),{scroll:false});
  if(width===1024){
   assert(geometry.scrollWidth>geometry.clientWidth,'narrow camera row exercises horizontal overflow');assert(tabScroll>0,'native Tab reveals the rightmost camera button: '+JSON.stringify({geometry,tabScroll}));
   const r=await row.boundingBox(),point={x:r.x+r.width/2,y:r.y+r.height/2};assert(await page.evaluate(({x,y})=>document.querySelector('#view-controls').contains(document.elementFromPoint(x,y)),point),'native wheel target belongs to the camera row');
   await page.mouse.move(point.x,point.y);await page.mouse.wheel(500,0);await page.waitForFunction(()=>document.querySelector('#view-controls').scrollLeft>0,null,{timeout:5000});
   assert(await row.evaluate(el=>el.scrollLeft>0&&el.scrollTop===0),'native wheel scrolls the camera row only horizontally');
   await hit(page.locator('#home-camera'),{scroll:false});await page.screenshot({path:out+'/narrow-camera-row.png'});
  }
  const afterInput=await page.evaluate(()=>({position:__universe.getState().position,camera:__universe.getCamera(),documentScroll:{x:scrollX,y:scrollY},dockScroll:document.querySelector('#dock').scrollLeft,socialScroll:document.querySelector('#social').scrollTop}));
  for(const axis of['x','z'])assert(Math.abs(afterInput.camera.target[axis]-beforeInput.camera.target[axis])<1e-8,'camera focus target stays fixed (allowing idle follow floating-point convergence)');
  const {target:beforeTarget,...beforeCamera}=beforeInput.camera,{target:afterTarget,...afterCamera}=afterInput.camera;
  assert.deepEqual({...afterInput,camera:afterCamera},{...beforeInput,camera:beforeCamera},'camera-row focus/wheel must not change world, camera, document or other scroll surfaces');
  layouts.push({width,geometry,tabScroll,inputStateUnchanged:true,geometryAfterInput:await row.evaluate(el=>({scrollLeft:el.scrollLeft,scrollTop:el.scrollTop})),viewport:await noOverflow()});
 }
 await page.setViewportSize({width:1440,height:950});await open();assert.equal(await page.locator('#social').isVisible(),true);await page.locator('#zoom-in').focus();await hit(page.locator('#zoom-in'),{scroll:false});
 return layouts;
}
async function keyboardDockCheck(){
 await open('Open wide content');await page.locator('#dock-explore').focus();
 for(let i=0;i<6;i++){await hit(page.locator(':focus'),{scroll:false});await page.keyboard.press('Tab');}
 assert.equal(await page.locator('#dock').evaluate(e=>e.scrollLeft>0),true);await hit(page.locator(':focus'),{scroll:false});await page.locator('#dock-explore').focus();
 // Focus scroll and wheel scrolling can finish asynchronously in software WebGL.
 // Establish the reset first, so prior Tab scrolling cannot satisfy the wheel check.
 await page.waitForFunction(()=>document.querySelector('#dock').scrollLeft===0,null,{timeout:5000});
 await hit(page.locator('#dock-explore'),{scroll:false});
 const dock=await page.locator('#dock').boundingBox(),point={x:dock.x+dock.width/2,y:dock.y+dock.height/2};
 assert(await page.evaluate(({x,y})=>document.querySelector('#dock').contains(document.elementFromPoint(x,y)),point),'native wheel target belongs to the dock');
 await page.mouse.move(point.x,point.y);await page.mouse.wheel(500,0);
 await page.waitForFunction(()=>document.querySelector('#dock').scrollLeft>0,null,{timeout:5000});
 assert(await page.locator('#dock').evaluate(e=>e.scrollLeft>0),'native wheel scrolls the available dock');
 await press(page.locator('#dock-build'));await hit(page.getByRole('button',{name:'Save room',exact:true}));await page.screenshot({path:out+'/wide-content-scroll.png'});
 pass('1440px 90-percent requested embed reserves a usable lane; native Tab/wheel reach dock and Build tools',{geometry:await noOverflow()});
}
try{
 let ctx;
 if(process.env.HUD_CAMERA_ONLY){ctx=await start({width:1440,height:950});await open();await press(page.locator('#dock-chat'));const layouts=await cameraRowCheck();await page.screenshot({path:out+'/desktop-chat-content.png'});pass('Camera controls occupy one row; native Tab/wheel reach horizontal overflow without vertical scrolling',{layouts});await ctx.close();contexts.pop();}
 if(process.env.HUD_KEYBOARD_ONLY){ctx=await start({width:1440,height:950});await keyboardDockCheck();await ctx.close();contexts.pop();}
 if(!process.env.HUD_TOUCH_ONLY&&!process.env.HUD_KEYBOARD_ONLY&&!process.env.HUD_CAMERA_ONLY){
 ctx=await start({width:1440,height:950});storage=await ctx.storageState();
 const reset=async()=>{await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__universe?.getState().ready);await settle();assert.equal(await page.locator('#editor').isVisible(),false);};
 await open();
 for(const selector of['#manage-bots','#manage-place','#invite'])await hit(page.locator(selector));
 const brand=await page.locator('.brand-logo').evaluate(e=>{const r=e.getBoundingClientRect(),actions=document.querySelector('.hud-right').getBoundingClientRect();return{ratio:r.width/r.height,right:r.right,actionLeft:actions.left,src:e.getAttribute('src')}});
 assert.equal(brand.ratio,2);assert(brand.right<=brand.actionLeft+1);assert.equal(brand.src,'/assets/bawes-universe-logo.png');
 await press(page.locator('#manage-place'));await press(page.getByRole('button',{name:'Close places',exact:true}));
 pass('Bots, Manage and Share remain hit-testable; native Manage opens/closes and the complete logo retains 2:1 aspect');
 await reset();await open();
 assert.equal(await page.locator('.embedded-frame').getAttribute('sandbox'),'allow-scripts allow-forms allow-same-origin allow-popups allow-downloads');
 await press(page.locator('#dock-build'));assert.equal(await page.locator('#editor').isVisible(),true);
 await customReachable();await hit(page.locator('#quick-actions'));await hit(page.getByRole('button',{name:'Open content fixture',exact:true}));
 await page.screenshot({path:out+'/desktop-build-content.png'});
 pass('Desktop embed leaves native Build/content/quick-action targets reachable; sandbox unchanged',{geometry:await noOverflow()});
 await press(page.getByRole('button',{name:'Return to world',exact:true}));await open();assert.equal(await page.locator('#editor').isVisible(),true);
 pass('Build-mode content opener reopens the real iframe by native pointer without the prior keyboard workaround');
 for(const [opener,closer,surface] of [['#dock-explore','Close places','#places'],['#quick-actions','Close quick menu','#command-palette'],['#shortcuts-help','Close dialog','#dialog']]){
  await reset();await open();await press(page.locator(opener));assert.equal(await page.locator(surface).isVisible(),true);await press(page.getByRole('button',{name:closer,exact:true}));await page.locator(surface).waitFor({state:'hidden'});await historyDisposition(closer);
 }
 pass('Explore, Quick actions and Shortcuts open and close above embedded content by pointer');
 await reset();await open();await press(page.locator('#dock-chat'));assert.equal(await page.locator('#social').isVisible(),true);assert.equal(await page.locator('.embedded-panel').isVisible(),true);
 await hit(page.getByRole('button',{name:'Close social panel',exact:true}));await hit(page.getByRole('button',{name:'Return to world',exact:true}));
 const cameraLayouts=await cameraRowCheck();await page.screenshot({path:out+'/desktop-chat-content.png'});await press(page.getByRole('button',{name:'Read local message',exact:true}));assert.match(await page.locator('#dialog').innerText(),/A local content action/);await press(page.getByRole('button',{name:'Close dialog',exact:true}));
 pass('Chat plus embedded content keeps a horizontal camera row, native Tab/wheel and content return/close targets reachable',{geometry:await noOverflow(),cameraLayouts});
 await reset();await open();await press(page.locator('#dock-chat'));
 // Home snaps idle follow interpolation to the player. Rotate makes a leaked
 // Home shortcut observable without allowing startup drift into the baseline.
 await press(page.locator('#home-camera'));const homeCamera=await page.evaluate(()=>__universe.getCamera());
 await press(page.locator('#rotate-camera'));await press(page.locator('#dock-emote'));
 assert.equal(await page.locator('#social').isVisible(),true);assert.equal(await page.locator('.embedded-panel').isVisible(),true);await hit(page.getByRole('button',{name:'Close Express',exact:true}));
 const before=await page.evaluate(()=>({position:__universe.getState().position,camera:__universe.getCamera()}));
 assert.equal(before.camera.follow,true);assert.deepEqual(before.camera.target,before.position,'native Home establishes an exact stationary follow target');assert.notEqual(before.camera.yaw,homeCamera.yaw,'native Rotate establishes a nondefault camera before testing the Home key');
 const expression=page.locator('.express-input');await press(expression);await expression.pressSequentially('e f r w');assert.equal(await expression.inputValue(),'e f r w');await page.keyboard.press('ArrowLeft');await page.keyboard.press('Home');
 assert.deepEqual(await expression.evaluate(el=>({focused:document.activeElement===el,start:el.selectionStart,end:el.selectionEnd})),{focused:true,start:0,end:0},'native editing keys stay in the Express input');
 const cdp=await ctx.newCDPSession(page);await cdp.send('Input.imeSetComposition',{text:'編集中',selectionStart:3,selectionEnd:3});await settle();assert.equal(await expression.inputValue(),'編集中e f r w');
 const after=await page.evaluate(()=>({position:__universe.getState().position,camera:__universe.getCamera()}));assert.deepEqual(after.position,before.position);
 for(const key of['yaw','tilt','distance','follow','framingMode','target'])assert.deepEqual(after.camera[key],before.camera[key],`Express input must preserve camera ${key}`);
 await cdp.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});await page.screenshot({path:out+'/desktop-express-chat-content.png'});await press(page.getByRole('button',{name:'Close Express',exact:true}));
 await historyDisposition('Close Express after chat plus embed');pass('Express remains usable with chat plus embed; native text/IME leaves world and camera unchanged',{cameraPrecondition:'Native Home then Rotate, exact stationary follow target and nondefault yaw',before,after});
 await reset();await keyboardDockCheck();
 await reset();await open('Open wide content');await page.setViewportSize({width:1024,height:768});await settle();
 assert(Number.parseFloat(await page.locator('#app').evaluate(e=>e.style.getPropertyValue('--hud-width')))>=359);
 for(const selector of['#manage-bots','#manage-place','#invite','#dock-explore','#dock-build','#quick-actions','#shortcuts-help'])await hit(page.locator(selector));
 await page.screenshot({path:out+'/wide-content-1024.png'});
 pass('1024px 90-percent requested embed keeps header/dock actions in a scrollable ≥360px lane',{geometry:await noOverflow()});
 await page.setViewportSize({width:1440,height:950});await reset();
 // CSS-only accessibility fixture enlarges existing control text, not app actions.
 const zoom=await page.addStyleTag({content:'#app button,#app input,#app textarea {font-size:24px !important}'});await open();await press(page.locator('#dock-emote'));await press(page.getByRole('button',{name:'Close Express',exact:true}));
 await ensureEmbed();await press(page.locator('#dock-build'));await customReachable();await hit(page.getByRole('button',{name:'Return to world',exact:true}));await page.screenshot({path:out+'/enlarged-text.png'});
 pass('Enlarged control text stays in explicit scroll containers with reachable close/return',{geometry:await noOverflow()});await zoom.evaluate(e=>e.remove());await ctx.close();contexts.pop();
 }
 for(const viewport of((process.env.HUD_KEYBOARD_ONLY||process.env.HUD_CAMERA_ONLY)?[]:[{width:390,height:844},{width:844,height:390},{width:1100,height:850}])){
  ctx=await start(viewport,true);await open('Open content fixture',true);
  const full=await page.locator('.embedded-panel').evaluate(e=>e.getBoundingClientRect().width>=innerWidth*.92);if(viewport.width<901)assert(full,'narrow portrait/landscape content deliberately owns the screen');
  await hit(page.getByRole('button',{name:'Return to world',exact:true}));await page.screenshot({path:out+`/touch-${viewport.width}-content.png`});
  if(!full){
   const d=await page.locator('#dock').boundingBox(),touch=await ctx.newCDPSession(page);await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x:d.x+d.width-20,y:d.y+d.height/2}]});
   for(let i=1;i<=6;i++)await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:1,x:d.x+d.width-20-i*(d.width-50)/6,y:d.y+d.height/2}]});
   await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(350);assert(await page.locator('#dock').evaluate(e=>e.scrollLeft>0),'native swipe scrolls available dock');await press(page.locator('#dock-build'),true);await customReachable(true);
  }
  await press(page.getByRole('button',{name:'Return to world',exact:true}),true);await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__universe?.getState().ready);await settle();
  for(const name of['Open content fixture','Open wide content','Read local message'])await hit(page.getByRole('button',{name,exact:true}));await press(page.locator('#dock-build'),true);await customReachable(true);for(const name of['Open content fixture','Open wide content','Read local message'])await hit(page.getByRole('button',{name,exact:true}));await press(page.getByRole('button',{name:'Close editor',exact:true}),true);await settle();
  await press(page.locator('#dock-emote'),true);await press(page.getByRole('button',{name:'Close Express',exact:true}),true);
  pass(`Native touch ${viewport.width}×${viewport.height} reaches Build, Express and content Return without page overflow`,{geometry:await noOverflow(),fullscreenContent:full});await ctx.close();contexts.pop();
 }
 assert.deepEqual(errors,[]);
}catch(error){console.error(error);checks.push({name:'HUD availability acceptance',status:'failed',error:error.stack});await page?.screenshot({path:out+'/failure.png'}).catch(()=>{});process.exitCode=1;}finally{await writeFile(out+'/results.json',JSON.stringify({buildSha256:createHash('sha256').update(await readFile(dist+'/main.js')).digest('hex'),mainCssSha256:createHash('sha256').update(await readFile(dist+'/main.css')).digest('hex'),filter:process.env.HUD_CAMERA_ONLY?'camera-only':process.env.HUD_TOUCH_ONLY?'touch-only':process.env.HUD_KEYBOARD_ONLY?'keyboard-only':'all',checks,errors,historyDispositions,scope:'Actual local game, native pointer/keyboard/CDP IME and emulated touch; local intercepted iframe; enlarged-text CSS fixture. No force clicks or app-action helpers. Software WebGL, not physical-device certification.'},null,2));for(const ctx of contexts)await ctx.close();await browser.close();await app.close();}
