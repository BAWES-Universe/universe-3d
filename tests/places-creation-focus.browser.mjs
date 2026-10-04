/** Isolated focus failure injection, real DOM and native keyboard. */
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {launch} from '../scripts/browser.mjs';
import {createGameServer} from '../server/app.mjs';
const dir=await mkdtemp(join(tmpdir(),'places-focus-'));
const fixture=`<!doctype html><html><head><link rel="stylesheet" href="/places.css"></head><body><button id="opener" aria-controls="root">Open places</button><div id="root"></div><script type="module">
import {mountPlaces} from './places.js';
const api=async path=>path.startsWith('/api/universes')?{universes:[{id:'u',name:'Local',slug:'local',public:true,worlds:[]}]}:{};
window.places=mountPlaces({root:document.querySelector('#root'),api,getState:()=>({user:{id:'user'}})});
document.querySelector('#opener').onclick=()=>places.open();window.ready=true;
</script></body></html>`;
await writeFile(join(dir,'fixture.js'),fixture.match(/<script type="module">([\s\S]*?)<\/script>/)[1]);
await writeFile(join(dir,'index.html'),fixture.replace(/<script type="module">[\s\S]*?<\/script>/,'<script type="module" src="/fixture.js"></script>'));
for(const f of ['places.js','places.css','place-creation-flow.js'])await writeFile(join(dir,f),await readFile(new URL('../src/'+f,import.meta.url)));
const app=createGameServer({dist:dir});const {port}=await app.listen(0);const browser=await launch();const page=await browser.newPage();const checks=[];
try{
 await page.goto(`http://127.0.0.1:${port}`);await page.waitForFunction(()=>window.ready);await page.getByRole('button',{name:'Open places',exact:true}).click();await page.getByRole('button',{name:'View universe Local',exact:true}).click();
 // Deliberately destroy the focused node, never repair focus in the test.
 await page.evaluate(()=>document.activeElement.remove());await page.waitForFunction(()=>document.querySelector('#root').contains(document.activeElement)&&document.activeElement.getClientRects().length);
 for(let i=0;i<25;i++){await page.keyboard.press(i%2?'Shift+Tab':'Tab');assert(await page.evaluate(()=>document.querySelector('#root').contains(document.activeElement)));}checks.push('Removed focused node recovers; native Tab and Shift+Tab stay contained');
 // Even if focus explicitly leaves the modal, its key handler recovers dismissal.
 await page.evaluate(()=>document.activeElement.blur());await page.keyboard.press('Escape');assert(await page.locator('#root').isHidden());checks.push('Escape recovers from BODY without test-side focus repair');
 await page.getByRole('button',{name:'Open places',exact:true}).click();await page.evaluate(()=>{const n=document.querySelector('#opener');n.replaceWith(n.cloneNode(true));});await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'opener');checks.push('Removed opener replaced by a live equivalent receives focus');
 await page.evaluate(()=>places.destroy());await page.keyboard.press('Tab');checks.push('Destroy removes document keyboard listeners');
 await mkdir('evidence/places-creation',{recursive:true});await writeFile('evidence/places-creation/focus-results.json',JSON.stringify({checks},null,2));console.log('PASS',checks.length,'focus fault checks');
}finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
