/** Actual app input ownership, using native keyboard/pointer/emulated touch. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createGameServer} from '../server/app.mjs';
import {launch} from '../scripts/browser.mjs';

const out='evidence/input-ownership';await mkdir(out,{recursive:true});
const scene={version:1,theme:'garden',bounds:{width:32,depth:26},spawn:{x:0,z:0},objects:[],areas:[]};
const app=createGameServer({database:':memory:',dist:new URL('../dist',import.meta.url).pathname,seeds:[{id:'input-world',name:'Input world',rooms:[{id:'input-room',name:'Input room',scene}]}],questsEnabled:false});
const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`,browser=await launch(),checks=[],errors=[];
let context,page,storage;
const pass=(name,detail={})=>{checks.push({name,status:'passed',...detail});console.log('PASS',name);};
async function start(touch=false){
 context=await browser.newContext({viewport:touch?{width:320,height:568}:{width:1280,height:800},hasTouch:touch,isMobile:touch,reducedMotion:'reduce',...(storage?{storageState:storage}:{})});
 if(!storage){const session=await context.request.post(base+'/api/session',{data:{name:'Input owner'}});assert.equal(session.status(),201);}
 page=await context.newPage();page.setDefaultTimeout(60000);page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base+'/?room=input-room',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__universe?.getState().ready&&window.__universe.getStats().presentation.drawnFrames>2);
}
async function snapshot(){return page.evaluate(()=>({position:__universe.getState().position,frames:__universe.getStats().presentation.drawnFrames}));}
async function framesAfter(before){await page.waitForFunction(n=>__universe.getStats().presentation.drawnFrames>=n+3,before.frames);}
try{
 await start();
 await page.locator('#game').focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
 const focus=await page.locator('#game').evaluate(node=>({focused:document.activeElement===node,visible:node.matches(':focus-visible'),outline:getComputedStyle(node).outlineStyle,width:getComputedStyle(node).outlineWidth,offset:getComputedStyle(node).outlineOffset}));
 assert(focus.focused&&focus.visible,JSON.stringify(focus));assert.equal(focus.outline,'solid');assert.equal(focus.width,'2px');assert.equal(focus.offset,'-4px');
 await page.screenshot({path:out+'/world-keyboard-focus.png'});pass('Native Tab return gives the world canvas a visible inset focus indicator',focus);

 const before=await snapshot();await page.locator('#dock-chat').click();const composer=page.getByRole('textbox',{name:'Message the room'});await composer.waitFor();
 assert.equal(await composer.evaluate(node=>document.activeElement===node),true);
 await page.keyboard.type('wasd');await framesAfter(before);assert.equal(await composer.inputValue(),'wasd');assert.deepEqual((await snapshot()).position,before.position);
 await page.screenshot({path:out+'/desktop-chat-keyboard-owner.png'});pass('Opening desktop Chat focuses its composer; immediate movement-letter typing stays in chat');
 await page.keyboard.press('Escape');await page.locator('#social').waitFor({state:'hidden'});await page.waitForFunction(()=>!history.state?.surface);
 await page.locator('#game').focus();const world=await snapshot();await page.keyboard.down('w');
 try{await page.waitForFunction(p=>Math.hypot(__universe.getState().position.x-p.x,__universe.getState().position.z-p.z)>.25,world.position);}finally{await page.keyboard.up('w');}
 await page.waitForFunction(()=>__universe.getState().moving===false);pass('Returning to the world restores intentional keyboard movement');
 await page.keyboard.press('c');assert.equal(await composer.evaluate(node=>document.activeElement===node),true);assert.equal(await composer.inputValue(),'wasd');pass('Direct C shortcut gives chat keyboard ownership and preserves its unsent draft');
 storage=await context.storageState();await context.close();context=null;

 await start(true);const touchBefore=await snapshot();await page.locator('#dock-chat').tap();
 const touchOwner=await page.evaluate(()=>({tag:document.activeElement.tagName,id:document.activeElement.id,inside:document.querySelector('#social').contains(document.activeElement),coarse:matchMedia('(pointer: coarse)').matches}));
 assert(touchOwner.coarse&&touchOwner.inside);assert.equal(touchOwner.id,'social-tab-chat');assert.notEqual(touchOwner.tag,'TEXTAREA');
 await page.keyboard.down('w');try{await framesAfter(touchBefore);}finally{await page.keyboard.up('w');}assert.deepEqual((await snapshot()).position,touchBefore.position);
 const touchComposer=page.getByRole('textbox',{name:'Message the room'});await touchComposer.tap();await page.keyboard.type('hello');assert.equal(await touchComposer.evaluate(node=>document.activeElement===node),true);assert((await touchComposer.inputValue()).endsWith('hello'));
 await page.screenshot({path:out+'/touch-chat-keyboard-owner.png'});pass('Touch opens on a non-text panel control, then a deliberate composer tap starts typing',touchOwner);
 assert.deepEqual(errors,[]);
}catch(error){console.error(error);process.exitCode=1;await page?.screenshot({path:out+'/failure.png',timeout:60000}).catch(()=>{});checks.push({status:'failed',error:error.stack});}
finally{await writeFile(out+'/results.json',JSON.stringify({checks,errors,scope:'Chromium native input on a local synthetic game; touch is emulated, not a physical keyboard or OS focus certification'},null,2));await context?.close();await browser.close();await app.close();}
