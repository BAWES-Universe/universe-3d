import {mkdir,writeFile} from 'node:fs/promises';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds} from '../src/worlds.js';
import {launch} from '../scripts/browser.mjs';
const phase=process.env.SHELL_PHASE||'before',out='evidence/external-shell';
await mkdir(out,{recursive:true});
const app=createGameServer({database:':memory:',dist:process.env.SHELL_DIST||new URL('../dist',import.meta.url).pathname,seeds:seedWorlds});
const {port}=await app.listen(0),browser=await launch(),observations=[];
try{
 for(const [name,width,height,touch] of [['desktop',1440,900,false],['portrait',320,568,true],['landscape',568,320,true]]){
  const context=await browser.newContext({viewport:{width,height},hasTouch:touch,isMobile:touch,reducedMotion:'reduce'});
  await context.request.post(`http://127.0.0.1:${port}/api/session`,{data:{name:'Shell '+name}});
  const p=await context.newPage();p.setDefaultTimeout(60000);
  await p.goto(`http://127.0.0.1:${port}/?room=commons`);
  await p.waitForFunction(()=>window.__universe?.getState().ready&&__universe.getStats().presentation.drawnFrames>3);
  await p.screenshot({path:`${out}/${phase}-${name}-arrival.png`});
  await p.locator('#game').focus();await p.keyboard.down('w');await p.waitForTimeout(350);await p.keyboard.up('w');
  await p.locator('#dock-chat').click();await p.getByRole('textbox',{name:'Message the room',exact:true}).fill('Unsent shell draft');
  await p.screenshot({path:`${out}/${phase}-${name}-chat.png`});
  await p.getByRole('button',{name:'Close social panel',exact:true}).click();
  await p.locator('#dock-people').click();await p.getByRole('button',{name:'Close social panel',exact:true}).click();
  if(await p.locator('#dock-build').isEnabled()) {await p.locator('#dock-build').click();await p.screenshot({path:`${out}/${phase}-${name}-build.png`});await p.getByRole('button',{name:'Close editor',exact:true}).click();}
  observations.push({name,width,height,touchEmulated:touch,...await p.evaluate(()=>({dock:{width:document.querySelector('#dock').clientWidth,scroll:document.querySelector('#dock').scrollWidth},overflow:document.documentElement.scrollWidth>innerWidth,stats:__universe.getStats()}))});
  await context.close();
 }
}finally{await writeFile(`${out}/${phase}-baseline.json`,JSON.stringify(observations,null,2));await browser.close();await app.close();}
