/** Actual shell: native Enter activation must belong to the foreground builder. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds} from '../src/worlds.js';
import {launch} from '../scripts/browser.mjs';
const seeds=structuredClone(seedWorlds);seeds[0].rooms[0].scene.objects=[];seeds[0].rooms[0].scene.areas=[];
const app=createGameServer({seeds,dist:new URL('../dist',import.meta.url).pathname}),{port}=await app.listen(0),browser=await launch(),page=await browser.newPage({viewport:{width:1280,height:900}}),checks=[],errors=[];
page.setDefaultTimeout(60000);page.on('pageerror',e=>errors.push(e.message));const record=name=>{checks.push({name,status:'passed'});console.log('PASS',name)};
try{
 await page.goto(`http://127.0.0.1:${port}`,{waitUntil:'domcontentloaded'});await page.locator('#display-name').fill('Keyboard maker');await page.locator('#join-button').click();await page.waitForFunction(()=>window.__universe?.getState().ready);await page.locator('#game').focus();await page.keyboard.press('e');await page.getByRole('button',{name:'Terrain',exact:true}).press('Enter');await page.getByRole('button',{name:'Paint wood',exact:true}).press('Enter');assert.equal(await page.locator('.express-tray').isVisible(),false);assert.equal(await page.locator('#editor').isVisible(),true);record('Native Enter on Terrain and material buttons keeps the builder foreground');
 await page.keyboard.press('Shift+ArrowDown');const before=await page.evaluate(()=>__universe.getState().scene.terrain?.cells.length||0);await page.keyboard.press('Enter');assert((await page.evaluate(()=>__universe.getState().scene.terrain.cells.length))>before);assert.equal(await page.locator('.express-tray').isVisible(),false);record('Native canvas Enter commits terrain once without opening Express');
 await page.getByRole('button',{name:'Close editor',exact:true}).press('Enter');assert(await page.getByRole('button',{name:'Save & play',exact:true}).isVisible());assert.equal(await page.locator('.express-tray').isVisible(),false);const kept=await page.evaluate(()=>__universe.getState().scene);await page.getByRole('button',{name:'Keep draft',exact:true}).press('Enter');await page.locator('#editor').waitFor({state:'hidden'});await page.waitForFunction(()=>history.state?.surface!=='build');assert.deepEqual(await page.evaluate(()=>__universe.getState().scene),kept);assert(await page.evaluate(()=>__universe.getEditor().dirty));assert.equal(await page.locator('.express-tray').isVisible(),false);record('Native Done then Keep draft Enter dismisses Build with the exact draft and without falling through to Express');
 assert.deepEqual(errors,[]);
}catch(error){checks.push({name:'keyboard lifecycle',status:'failed',error:error.stack});console.error(error);process.exitCode=1;}
finally{await mkdir('evidence',{recursive:true});await writeFile('evidence/terrain-keyboard-full.json',JSON.stringify({checks,errors,bundle:createHash('sha256').update(await readFile(new URL('../dist/main.js',import.meta.url))).digest('hex'),scope:'Actual local bundle, native keyboard, no app action injection or external service'},null,2));await browser.close();await app.close();}
