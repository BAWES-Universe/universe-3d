/** Actual local game across server replacement using the same SQLite file.
 * Native input retains a draft; no old mutation is automatically retried. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createGameServer} from '../server/app.mjs';
import {emptyScene} from '../src/worlds.js';
import {launch} from '../scripts/browser.mjs';

const out='evidence/editor-collaboration-restart';await mkdir(out,{recursive:true});
const browser=await launch(),checks=[],errors=[];
const dist=new URL('../dist',import.meta.url).pathname;
const initial={...emptyScene(),objects:[
 {id:'a',type:'chair',name:'Original chair',x:-4,z:-3,rotation:0},
 {id:'b',type:'chair',name:'Peer chair',x:4,z:-3,rotation:0}
]};
async function check(kind){
 const started=Date.now(),directory=await mkdtemp(join(tmpdir(),'universe-editor-restart-'));
 const config={database:join(directory,'game.sqlite'),dist,questsEnabled:false,seeds:[{id:'world',name:'Restart world',rooms:[{id:'room',name:'Restart room',scene:initial}]}]};
 let app=createGameServer(config),actor,owner,page,blockEvents=false,intercept=kind!=='draft',base;const attempts=[];
 async function call(context,path,method='GET',data){const response=await context.request.fetch(base+path,{method,timeout:60000,...(data===undefined?{}:{data})});const body=await response.json();assert(response.ok(),JSON.stringify(body));return body;}
 try{
  const {port}=await app.listen(0);base=`http://127.0.0.1:${port}`;
  owner=await browser.newContext();actor=await browser.newContext({viewport:{width:1440,height:1000}});page=await actor.newPage();page.setDefaultTimeout(60000);page.setDefaultNavigationTimeout(60000);page.on('pageerror',e=>errors.push(e.message));await page.bringToFront();
  await call(owner,'/api/session','POST',{name:'Restart owner'});const {user}=await call(actor,'/api/session','POST',{name:'Restart editor'});await call(owner,'/api/worlds/world/members/'+user.id,'PUT',{role:'editor'});
  await page.route(/\/api\/events(?:\?.*)?$/,route=>blockEvents?route.abort('failed'):route.continue());
  await page.route(base+'/api/rooms/room/scene/operations',async route=>{
   if(route.request().method()!=='POST')return route.continue();attempts.push(route.request().postDataJSON());
   if(!intercept)return route.continue();intercept=false;
   if(kind==='committed-undo'){const response=await route.fetch();assert.equal(response.status(),200);return route.abort('failed');}
   return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Local transport could not confirm the save'})});
  });
  await page.goto(base+'/?room=room',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__universe?.getState().ready);
  const oldEpoch=await page.evaluate(()=>__universe.getState().admissionEpoch);
  await page.locator('#dock-build').click();await page.locator('#game').focus();await page.keyboard.press(']');await page.waitForFunction(()=>__universe.getEditor().selected==='a');
  const input=page.getByRole('textbox',{name:'Name',exact:true});await input.fill('My retained draft');await input.press('Tab');await page.waitForFunction(()=>__universe.getEditor().dirty);
  if(kind!=='draft'){
   await page.getByRole('button',{name:'Save room',exact:true}).click();await page.getByRole('button',{name:'Retry save',exact:true}).waitFor();assert.equal(attempts.length,1);
   await page.locator('#game').focus();await page.keyboard.press('Control+z');await page.waitForFunction(()=>__universe.getState().scene.objects.find(o=>o.id==='a').name==='Original chair');
   assert.equal(await page.evaluate(()=>__universe.getEditor().dirty),true,'Unknown save outcome remains unresolved after undo to the old base');
  }
  blockEvents=true;await app.close();await page.waitForFunction(()=>!__universe.getState().online);
  app=createGameServer(config);await app.listen(port);
  const latest=(await call(owner,'/api/rooms/room')).room;latest.scene.objects.find(o=>o.id==='b').name='Peer edit after restart';
  await call(owner,'/api/rooms/room/scene','PUT',{revision:latest.revision,scene:latest.scene});
  const countBeforeResume=attempts.length;blockEvents=false;
  await page.waitForFunction(epoch=>{const s=window.__universe?.getState();return s?.ready&&s.online&&s.admissionEpoch!==epoch&&!document.querySelector('#editor').inert&&s.scene.objects.find(o=>o.id==='b')?.name==='Peer edit after restart';},oldEpoch);
  assert.equal(await page.locator('#editor').isVisible(),true,'Same-room restart keeps Build open');
  let state=await page.evaluate(()=>__universe.getState());
  assert.equal(state.scene.objects.find(o=>o.id==='a').name,kind==='draft'?'My retained draft':'Original chair');
  assert.equal(attempts.length,countBeforeResume,'New admission must not automatically submit an old request');
  if(kind==='uncommitted-undo'){
   assert.equal(await page.evaluate(()=>__universe.getEditor().dirty),false,'Canceled uncommitted change converges without a new save');
  }else{
   assert.equal(await page.evaluate(()=>__universe.getEditor().dirty),true);
   await page.getByRole('button',{name:'Save room',exact:true}).click();await page.waitForFunction(()=>!__universe.getEditor().saving&&!__universe.getEditor().dirty);
   if(kind==='committed-undo')assert.notEqual(attempts[0].operationId,attempts[1].operationId,'Explicit post-resume undo uses a new reviewed base, not the retired request');
  }
  state=(await call(owner,'/api/rooms/room')).room;
  assert.equal(state.scene.objects.find(o=>o.id==='a').name,kind==='draft'?'My retained draft':'Original chair');
  assert.equal(state.scene.objects.find(o=>o.id==='b').name,'Peer edit after restart');
  await page.screenshot({path:out+'/'+kind+'.png'});
  checks.push({name:kind,status:'passed',durationMs:Date.now()-started,operationAttempts:attempts.length,revision:state.revision});console.log('PASS',kind);
 }catch(error){checks.push({name:kind,status:'failed',error:error.stack,durationMs:Date.now()-started});console.error(error);await page?.screenshot({path:out+'/'+kind+'-failure.png'}).catch(()=>{});process.exitCode=1;}
 finally{await actor?.close();await owner?.close();await app.close();}
}
try{for(const kind of ['draft','committed-undo','uncommitted-undo'])await check(kind);assert.deepEqual(errors,[]);}
finally{await browser.close();await writeFile(out+'/results.json',JSON.stringify({checks,errors,bundleSha256:createHash('sha256').update(await readFile('dist/main.js')).digest('hex'),limits:['Native browser input, actual local SQLite and HTTP/SSE; server instance and process admission epoch replaced while the browser remains open','Persistent database and sessions survive replacement; no real hosted restart or deployment','Only a local response fault is injected; no live providers, devices or external requests']},null,2));}
