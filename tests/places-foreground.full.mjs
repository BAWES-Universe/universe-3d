/** Actual bundled baseline shell: Places must yield to its foreground modal. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {launch} from '../scripts/browser.mjs';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds} from '../src/worlds.js';
const out='evidence/places-correction';await mkdir(out,{recursive:true});
const app=createGameServer({database:':memory:',dist:new URL('../dist',import.meta.url).pathname,seeds:seedWorlds});
const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`,browser=await launch(),checks=[],errors=[];
const context=await browser.newContext({viewport:{width:1280,height:850}}),page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
const focused=async selector=>assert(await page.evaluate(selector=>{const owner=document.querySelector(selector),node=document.activeElement;return !owner.hidden&&owner.contains(node)&&node.getClientRects().length;},selector),`focus belongs to ${selector}`);
let release;
try{
 assert.equal((await context.request.post(base+'/api/session',{data:{name:'Foreground owner'}})).status(),201);
 await page.goto(base+'/?room=commons');await page.waitForFunction(()=>window.__universe?.getState().ready);
 await page.locator('#game').click();await page.keyboard.press('g');await page.getByRole('button',{name:'Refresh places',exact:true}).waitFor();
 await focused('#places');
 const before=await page.evaluate(()=>__universe.getState().position);
 let responseReady;const pending=new Promise(resolve=>{responseReady=resolve;});const responseGate=new Promise(resolve=>{release=resolve;});
 await page.route('**/api/universes?*',async route=>{const response=await route.fetch();responseReady();await responseGate;await route.fulfill({response});});
 await page.getByRole('button',{name:'Refresh places',exact:true}).click();await pending;await page.evaluate(()=>{window.__oldRefresh=document.querySelector('#places [aria-label="Refresh places"]');});
 await page.keyboard.down('Control');await page.keyboard.down('k');await focused('#command-palette');await page.keyboard.up('k');await page.keyboard.up('Control');await focused('#command-palette');
 checks.push('Native Ctrl+K release retains foreground palette ownership above Places');
 const search=page.getByRole('combobox',{name:'Search actions, people and places'});await page.keyboard.type('place');assert.equal(await search.inputValue(),'place');
 await page.keyboard.press('ArrowDown');await page.keyboard.press('Tab');await focused('#command-palette');
 release();await page.waitForFunction(()=>document.querySelector('#places [aria-label="Refresh places"]')!==window.__oldRefresh);await page.waitForTimeout(300);await focused('#command-palette');
 await page.setViewportSize({width:900,height:700});await focused('#command-palette');
 // Deliberately blur the foreground control while a real catalog event arrives.
 await page.evaluate(()=>document.activeElement.blur());
 assert.equal((await context.request.post(base+'/api/universes',{data:{name:'Foreground update',slug:'foreground-update',public:false}})).status(),201);
 await page.getByRole('button',{name:'View universe Foreground update',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>document.activeElement===document.body),true);
 await page.setViewportSize({width:1000,height:760});assert.equal(await page.evaluate(()=>document.activeElement===document.body),true);
 assert(await page.locator('#command-palette').isVisible());await search.click();await focused('#command-palette');
 await page.keyboard.press('Tab');await focused('#command-palette');
 await page.keyboard.press('Shift+Tab');await search.click();await page.keyboard.type(' wasd');assert.equal(await search.inputValue(),'place wasd');assert.deepEqual(await page.evaluate(()=>__universe.getState().position),before);
 checks.push('Search, result navigation, Tab, pending Places refresh/mutations and resize keep palette focus; no movement leaks');
 await page.keyboard.press('Escape');assert(await page.locator('#command-palette').isHidden());assert(await page.locator('#places').isVisible());await focused('#places');
 await page.keyboard.press('Tab');await focused('#places');
 await page.keyboard.down('Meta');await page.keyboard.down('k');await focused('#command-palette');await page.keyboard.up('k');await page.keyboard.up('Meta');await focused('#command-palette');
 await page.keyboard.press('Escape');await focused('#places');await page.keyboard.press('Escape');assert(await page.locator('#places').isHidden());
 checks.push('Escape dismisses one layer at a time and returns focus to visible Places');
 assert.deepEqual(errors,[]);console.log('PASS',checks.length,'foreground ownership checks');
}catch(error){console.error(error);process.exitCode=1;checks.push({status:'failed',error:error.stack});await page.screenshot({path:out+'/foreground-failure.png'}).catch(()=>{});}
finally{release?.();await writeFile(out+'/foreground-results.json',JSON.stringify({checks,errors},null,2));await context.close();await browser.close();await app.close();}
