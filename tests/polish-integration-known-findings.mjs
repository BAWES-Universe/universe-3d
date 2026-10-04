/** Reproduce the two explicitly deferred product findings in the combined app. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createGameServer} from '../server/app.mjs';
import {emptyScene} from '../src/worlds.js';
import {makePng} from '../fixtures/png-fixtures.mjs';
import {launch} from '../scripts/browser.mjs';
const out='evidence/integration/findings';await mkdir(out,{recursive:true});
const app=createGameServer({database:':memory:',dist:new URL('../dist',import.meta.url).pathname,seeds:[{id:'w',name:'Workshop',rooms:[{id:'r',name:'Integration room',scene:emptyScene()}]}]});
const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`,browser=await launch(),context=await browser.newContext({viewport:{width:1440,height:900}}),p=await context.newPage(),findings=[];
p.setDefaultTimeout(60000);p.setDefaultNavigationTimeout(90000);
try{
 await p.goto(base+'/?room=r',{waitUntil:'domcontentloaded'});await p.getByPlaceholder('Your name').fill('Local findings');await p.locator('#join-button').click();await p.waitForFunction(()=>window.__universe?.getState().ready);
 await p.locator('#dock-explore').click();await p.getByRole('button',{name:'View room Integration room',exact:true}).click();
 const focus=await p.evaluate(()=>({tag:document.activeElement.tagName,inside:document.querySelector('#places').contains(document.activeElement)}));
 await p.keyboard.press('Escape');const stayed=await p.locator('#places').isVisible();findings.push({finding:'Places selection loses focus and Escape fails',reproduced:focus.tag==='BODY'&&stayed,focus,stayed,files:['src/places.js','src/main.js']});await p.screenshot({path:out+'/places-focus.png'});
 if(stayed)await p.getByRole('button',{name:'Close places',exact:true}).click();
 await p.locator('#dock-build').click();await p.getByRole('button',{name:'Custom images',exact:true}).click();await p.getByRole('button',{name:'Add PNG',exact:true}).click();
 const chooser=p.waitForEvent('filechooser');await p.getByRole('button',{name:'Choose PNG',exact:true}).click();await(await chooser).setFiles({name:'integration-1024.png',mimeType:'image/png',buffer:makePng({width:1024,height:1024,pixel:()=>[230,110,70,255]})});
 await p.getByAltText('Local image preview').waitFor();await p.locator('#image-library').getByRole('textbox',{name:'Name',exact:true}).fill('Large original');await p.getByRole('combobox',{name:'Representation and depth',exact:true}).selectOption('floor');await p.locator('#image-library').getByRole('button',{name:'Upload',exact:true}).click();await p.getByRole('button',{name:/^Place Large original \(/}).click();
 await p.locator('#game').focus();const q=await p.evaluate(()=>__universe.getScreenPoint(0,0));await p.mouse.move(q.x,q.y);const before=await p.evaluate(()=>__universe.getState().scene.objects.length);await p.mouse.click(q.x,q.y);
 const diagnostic=await p.evaluate(()=>({preview:__universe.getEditor().preview,bounds:__universe.getState().scene.bounds,objects:__universe.getState().scene.objects.length}));assert.equal(diagnostic.preview.valid,false);assert.equal(diagnostic.objects,before);
 findings.push({finding:'1024px floor image uploads but cannot fit the default room',reproduced:true,...diagnostic,files:['src/image-asset-schema.js','src/image-asset-geometry.js','src/image-library.js','src/image-library-shell.js']});await p.screenshot({path:out+'/oversized-image.png'});
}finally{await writeFile(out+'/results.json',JSON.stringify({findings,scope:'Known deferred findings; reproduction success is not a product pass.'},null,2));await browser.close();await app.close();}
