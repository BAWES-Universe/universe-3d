/** Actual server and app; user flows use native pointer/keyboard/touch. Only
 * fixture setup/peer moderation uses HTTP. Browser diagnostics are read-only.
 * Run with the shared .universe-gpu-test.lock held. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createGameServer} from '../server/app.mjs';
import {launch} from '../scripts/browser.mjs';
const start=(key,x,extra={})=>({id:key,name:key==='cafe'?'Café welcome':'Stage doors',x,z:0,width:1.6,depth:1.6,action:'welcome',start:{key,isDefault:key==='cafe'},...extra});
const scene=id=>({version:1,theme:'garden',bounds:{width:32,depth:26},spawn:{x:0,z:8},areas:[start('cafe',-6,id==='a'?{action:'teleport',target:'b',entry:'cafe'}:{}),start('stage',6)],objects:[{id:'door',type:'board',name:'Travel board',x:-6,z:-1.8,rotation:0,actions:[{id:'cross',type:'teleport',name:id==='a'?'Travel to Garden':'Travel to Café',target:id==='a'?'b':'a',entry:'cafe'},{id:'same',type:'teleport',name:'Travel to stage',target:id,entry:'stage'}]}]});
const app=createGameServer({database:':memory:',seeds:[{id:'world',name:'Arrival world',rooms:[{id:'a',name:'Café room',scene:scene('a')},{id:'b',name:'Garden room',scene:scene('b')}]}],dist:new URL('../dist',import.meta.url).pathname,questsEnabled:false});
const {port}=await app.listen(0),base='http://127.0.0.1:'+port,browser=await launch(),context=await browser.newContext({viewport:{width:1365,height:960},hasTouch:true,reducedMotion:'reduce'}),page=await context.newPage(),checks=[],errors=[],joins=[],presence=[],movement=[],retirement=[],heldJoins=[];
const operationTimeout=60000;
page.setDefaultTimeout(operationTimeout);page.setDefaultNavigationTimeout(operationTimeout);page.on('pageerror',error=>errors.push(error.message));
page.on('request',request=>{if(request.url().endsWith('/api/presence'))presence.push(request.postDataJSON());});
page.on('response',async res=>{if(/\/api\/rooms\/[^/]+\/join$/.test(new URL(res.url()).pathname)){const body=await res.json().catch(()=>null);joins.push({url:res.url(),request:res.request().postDataJSON(),status:res.status(),body});}});
const read=()=>page.evaluate(()=>window.__universe.getState());
const ready=id=>page.waitForFunction(id=>window.__universe?.getState().ready&&window.__universe.getState().room?.id===id,id);
const check=name=>{checks.push({name,status:'passed'});console.log('PASS',name);};
const quick=async label=>{await page.keyboard.press('Control+k');const input=page.getByRole('combobox',{name:'Search actions, people and places'});await input.fill(label);await input.press('Enter');};
const travel=async name=>{await page.locator('#interact').click();await page.locator('#dialog-actions').getByRole('button',{name,exact:true}).click();};
const holdNativeJoin=async(sourceRoomId,roomId,name)=>{
 const pattern='**/api/rooms/'+roomId+'/join',started=performance.now(),trace={sourceRoomId,roomId,phase:'waiting-for-source-navigation'};heldJoins.push(trace);
 const response=Promise.withResolvers(),deadline=Promise.withResolvers();let timer;
 const failure=(code,message,cause)=>Object.assign(new Error(message,{cause}),{code});
 const hold=async route=>{
  trace.phase='fetching-server-response';trace.requestMs=performance.now()-started;
  try{
   trace.request=route.request().postDataJSON();
   const upstream=await route.fetch({timeout:operationTimeout});
   trace.responseMs=performance.now()-started;trace.status=upstream.status();trace.phase='holding-server-response';
   assert.equal(upstream.status(),200,'Native '+roomId+' join must reach an accepted actual server response');
   response.resolve({route,upstream,unroute:()=>context.unroute(pattern,hold)});
  }catch(error){trace.phase='server-response-failed';trace.error=error.message;response.reject(failure('HELD_JOIN_FETCH_FAILED','Actual '+roomId+' join response failed: '+error.message,error));}
 };
 const activate=async()=>{
  // Room commit sets ready before navigation settles. The existing inert flag
  // fences presence/action activation until the controls response is accepted.
  await page.waitForFunction(id=>{const s=window.__universe.getState();return s.ready&&s.room?.id===id&&!document.querySelector('#editor').inert;},sourceRoomId);
  trace.sourceSettledMs=performance.now()-started;trace.phase='waiting-for-native-request';await travel(name);
 };
 await context.route(pattern,hold);
 // Readiness belongs to the actual upstream response, not the pointer click or
 // a short poll of a variable. Use the same bounded deadline as other UI work.
 timer=setTimeout(()=>deadline.reject(failure(trace.phase==='waiting-for-source-navigation'?'HELD_JOIN_SOURCE_TIMEOUT':trace.requestMs===undefined?'HELD_JOIN_REQUEST_TIMEOUT':'HELD_JOIN_RESPONSE_TIMEOUT','Native '+roomId+' join timed out '+trace.phase)),operationTimeout);
 try{const [held]=await Promise.race([Promise.all([response.promise,activate()]),deadline.promise]);return held;}
 catch(error){await context.unroute(pattern,hold);throw error;}
 finally{clearTimeout(timer);}
};
try{
 const created=await context.request.post(base+'/api/session',{data:{name:'Arrival traveler'}});assert.equal(created.status(),201);
 await page.goto(base+'/?room=a&entry=cafe&irrelevant=local');await ready('a');await page.waitForFunction(()=>!!window.__universe.getState().admissionId);await page.waitForTimeout(300);
 let state=await read();assert.equal(joins.length,1);assert.deepEqual(joins[0].request,{mode:'travel',entry:'cafe'});assert.deepEqual(state.position,{x:joins[0].body.arrival.x,z:joins[0].body.arrival.z});assert.equal(state.admissionId,joins[0].body.arrival.admissionId);assert(state.position.x<-5);assert(presence.every(value=>value.admissionId===state.admissionId));check('Initial URL uses exact server named arrival and landing on an exit does not immediately travel');
 await page.locator('#invite').click();const select=page.getByRole('combobox',{name:'Arrival for shared link'});await select.waitFor();await page.waitForFunction(()=>!document.querySelector('[aria-label="Arrival for shared link"]').disabled);await select.selectOption('stage');assert.equal(await page.getByRole('textbox',{name:'Room destination link'}).inputValue(),base+'/?room=a&entry=stage');await page.locator('#dialog-close').click();await page.waitForFunction(()=>!history.state?.surface);assert.equal(joins.length,1);check('Share names real arrivals and excludes unrelated query data; surface-only history does not rejoin');
 await travel('Travel to Garden');await ready('b');await page.waitForTimeout(150);state=await read();assert.equal(state.destination.entry,'cafe');assert.equal(joins.at(-1).request.sourceAction.entityId,'door');assert.equal(joins.at(-1).request.sourceAction.actionId,'cross');assert.equal(joins.at(-1).request.entry,'cafe');assert.deepEqual(state.position,{x:joins.at(-1).body.arrival.x,z:joins.at(-1).body.arrival.z});check('Native item doorway sends canonical action plus entry and consumes authoritative cross-room pose');
 const gardenAdmission=state.admissionId;await travel('Travel to stage');await page.waitForFunction(id=>window.__universe.getState().admissionId!==id,gardenAdmission);state=await read();assert.equal(state.room.id,'b');assert.equal(state.destination.entry,'stage');assert(state.position.x>5);assert.equal(joins.at(-1).request.mode,'travel');check('Native same-room travel allocates a new admission at its selected named start');
 const stageAdmission=state.admissionId;await page.goBack();await page.waitForFunction(id=>window.__universe.getState().ready&&window.__universe.getState().admissionId!==id,stageAdmission);state=await read();assert.equal(state.destination.entry,'cafe');assert(state.position.x<-5);const backAdmission=state.admissionId;await page.goForward();await page.waitForFunction(id=>window.__universe.getState().ready&&window.__universe.getState().admissionId!==id,backAdmission);state=await read();assert.equal(state.destination.entry,'stage');assert(state.position.x>5);check('Back and Forward perform real same-room travel when the named entry changes');
 const beforeReload=state;await page.reload();await ready('b');state=await read();assert.equal(state.admissionId,beforeReload.admissionId);assert.deepEqual(state.position,beforeReload.position);assert.equal(joins.at(-1).request.mode,'resume');assert.equal('entry' in joins.at(-1).request,false);assert.equal(state.destination.entry,'stage');check('Reload resumes its existing placement and preserves entry-bearing URL without teleporting again');
 // Native editor selection and Try exercise committed same-room admission.
 await page.locator('#dock-build').click();const point=await page.evaluate(()=>window.__universe.getScreenPoint(6,0,0));await page.locator('#game').click({position:{x:point.x,y:point.y}});const trial=page.locator('[data-focus-key="arrival:try"]');await trial.waitFor();assert.equal(await trial.isEnabled(),true);const previous=state.admissionId;await trial.click();await page.waitForFunction(id=>window.__universe.getState().ready&&window.__universe.getState().admissionId!==id,previous);assert.equal((await read()).destination.entry,'stage');check('Native Build selection and Try saved arrival invoke real explicit admission');
 await page.setViewportSize({width:390,height:844});await page.locator('#invite').tap();await page.waitForFunction(()=>!document.querySelector('[aria-label="Arrival for shared link"]').disabled);await page.getByRole('combobox',{name:'Arrival for shared link'}).selectOption('cafe');const bounds=await page.getByRole('button',{name:'Copy link',exact:true}).boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=390&&bounds.y>=0&&bounds.y+bounds.height<=844);await mkdir('evidence',{recursive:true});await page.screenshot({path:'evidence/arrival-navigation-mobile.png'});await page.locator('#dialog-close').tap();check('Named-arrival sharing is reachable by native touch in a 390px viewport');
 await page.setViewportSize({width:1365,height:960});await quick('Café room');await ready('a');await page.waitForTimeout(150);
 const source=await read();let deniedJoins=0;
 const denialMessage=attempt=>'Destination access denied by local fixture (attempt '+attempt+')';
 const denial=async route=>{deniedJoins++;await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'ROOM_FORBIDDEN',message:denialMessage(deniedJoins)})});};
 await context.route('**/api/rooms/b/join',denial);await travel('Travel to Garden');await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Destination access denied'));await page.waitForTimeout(400);
 state=await read();assert.equal(deniedJoins,1);assert.equal(state.ready,true);assert.equal(state.room.id,'a');assert.equal(state.admissionId,source.admissionId);assert.deepEqual(state.position,source.position);
 await quick('Custom images');await page.getByRole('button',{name:'Close Custom image library'}).waitFor();await page.getByRole('button',{name:'Close Custom image library'}).click();check('Denied travel keeps source pose usable, resumes Custom images, and does not repeatedly trigger its landing exit');
 const exit=source.scene.areas.find(area=>area.id==='cafe');
 const walkUntil=async(key,inside)=>{
  let sample;
  await page.keyboard.down(key);
  try{
   // Slow frames cap motion elapsed time, so equal key holds need not retrace
   // equal distances. Observe the actual boundary with read-only diagnostics.
   sample=await page.waitForFunction(({area,inside})=>{
    const state=window.__universe.getState(),p=state.position;
    const entered=Math.abs(p.x-area.x)<=area.width/2&&Math.abs(p.z-area.z)<=area.depth/2;
    const left=Math.abs(p.x-area.x)>area.width/2+.25||Math.abs(p.z-area.z)>area.depth/2+.25;
    return state.room.id==='a'&&(inside?entered:left)?{position:p,frameMs:window.__universe.getStats().frameMs.slice(-8)}:false;
   },{area:exit,inside});
  }finally{await page.keyboard.up(key);}
  movement.push({phase:inside?'reentered':'left',...await sample.jsonValue(),deniedJoins});await sample.dispose();
 };
 const leaveAndReturn=async()=>{
  await page.waitForFunction(()=>document.querySelector('#image-library').hidden&&!history.state?.surface);await page.locator('#game').focus();
  await walkUntil('w',false);await page.waitForFunction(()=>window.__universe.getMotion().speed<.01);assert.equal(deniedJoins,1);
  await walkUntil('s',true);
 };
 const [deniedAgain]=await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/rooms/b/join'&&response.status()===403&&response.request().postDataJSON()?.sourceAction?.entityType==='area'),leaveAndReturn()]);
 assert.equal((await deniedAgain.json()).message,denialMessage(2));await page.waitForFunction(message=>document.querySelector('#toast').textContent.includes(message),denialMessage(2));await page.waitForTimeout(450);assert.equal(deniedJoins,2);await page.waitForTimeout(300);assert.equal(deniedJoins,2);check('Failed automatic doorway attempts once per physical entry and stays suppressed after denial');
 await context.unroute('**/api/rooms/b/join',denial);
 const heldScene=await holdNativeJoin('a','b','Travel to Garden');
 const beforeRoom=(await (await context.request.get(base+'/api/rooms/b')).json()).room,nextScene=structuredClone(beforeRoom.scene);nextScene.areas[1].name='Newest stage sign';const saved=await context.request.put(base+'/api/rooms/b/scene',{data:{revision:beforeRoom.revision,scene:nextScene}});assert.equal(saved.status(),200);const changed=await saved.json();await page.waitForTimeout(100);assert.equal((await read()).room.id,'a');
 await heldScene.route.fulfill({response:heldScene.upstream});await ready('b');state=await read();assert.equal(state.room.revision,changed.room.revision);assert.equal(state.scene.areas[1].name,'Newest stage sign');await heldScene.unroute();check('Real target scene SSE received before held join response wins before destination render');
 await page.screenshot({path:'evidence/arrival-navigation-destination.png'});
 // Observe rendered frames and heading changes without changing application
 // state, so a transient target display or post-retirement regrant also fails.
 const retirementWatch=await page.evaluateHandle(()=>{
  const samples=[];let frame;
  const sample=()=>{const s=window.__universe.getState(),value={roomId:s.room?.id??null,ready:s.ready,admissionId:s.admissionId,admissionEpoch:s.admissionEpoch,admissionRevision:s.admissionRevision,title:document.querySelector('#room-name').textContent};if(JSON.stringify(value)!==JSON.stringify(samples.at(-1)))samples.push(value);};
  const observeFrame=()=>{sample();frame=requestAnimationFrame(observeFrame);};
  const observer=new MutationObserver(sample);observer.observe(document.querySelector('#room-name'),{childList:true,characterData:true,subtree:true});observeFrame();
  return {stop(){sample();cancelAnimationFrame(frame);observer.disconnect();return samples;}};
 });
 const joinsBeforeRevocation=joins.length;
 const heldRevocation=await holdNativeJoin('b','a','Travel to Café');
 const archived=await context.request.delete(base+'/api/rooms/a');assert.equal(archived.status(),200);await page.waitForTimeout(100);await heldRevocation.route.fulfill({response:heldRevocation.upstream});
 // Unconfirmed authority is only an intermediate state. Wait for the empty
 // server session to retire the room completely and navigation to settle.
 await page.waitForFunction(()=>{const s=window.__universe.getState();return !s.ready&&s.room===null&&s.destination===null&&s.admissionId===null&&s.admissionEpoch===null&&s.admissionRevision===null&&!document.querySelector('#editor').inert;});
 state=await read();assert.equal(state.ready,false);assert.equal(state.room,null);assert.equal(state.destination,null);
 for(const field of ['admissionId','admissionEpoch','admissionRevision'])assert.equal(state[field],null,field+' remains retired');
 assert.equal(await page.locator('#dock-build').isDisabled(),true);assert.equal(await page.locator('#editor').isVisible(),false);assert.equal(await page.locator('#dock-build').evaluate(node=>node.classList.contains('active')),false);
 assert.equal(await page.locator('#room-name').textContent(),'Find your place');await page.getByRole('dialog',{name:'You’ve left this room',exact:true}).waitFor();
 const browse=page.getByRole('button',{name:'Browse accessible places',exact:true});assert.equal(await browse.isEnabled(),true);
 const session=await (await context.request.get(base+'/api/session')).json();assert.equal(session.currentRoomId,null);
 await browse.click();await page.locator('#places').waitFor({state:'visible'});await page.getByRole('searchbox',{name:'Find a place',exact:true}).waitFor();
 assert.equal(await page.getByRole('tab',{name:'Places',exact:true}).getAttribute('aria-selected'),'true');
 retirement.push(...await retirementWatch.evaluate(watch=>watch.stop()));await retirementWatch.dispose();
 assert(retirement.every(sample=>sample.roomId!=='a'&&sample.title!=='Café room'),'Revoked target never becomes the displayed room');
 const retiredAt=retirement.findIndex(sample=>sample.roomId===null);assert(retiredAt>=0,'Complete room retirement was observed');
 assert(retirement.slice(retiredAt).every(sample=>sample.roomId===null&&!sample.ready&&sample.admissionId===null&&sample.admissionEpoch===null&&sample.admissionRevision===null),'Retired source authority is never restored');
 assert.equal(joins.length,joinsBeforeRevocation+1,'Recovery never silently rejoins either room');
 assert.equal((await (await context.request.get(base+'/api/session')).json()).currentRoomId,null);await heldRevocation.unroute();
 check('Real target access revocation during held join never displays target or restores retired source authority');
 assert.deepEqual(errors,[]);
}catch(error){console.error(error);checks.push({name:'failure',status:'failed',code:error.code,error:error.stack});await mkdir('evidence',{recursive:true});await page.screenshot({path:'evidence/arrival-navigation-failure.png'}).catch(()=>{});process.exitCode=1;}finally{await mkdir('evidence',{recursive:true});await writeFile('evidence/arrival-navigation-full.json',JSON.stringify({checks,errors,joins,movement,retirement,heldJoins,limits:['Local real server and browser only; no remote services, devices, deployment or production configuration']},null,2));await context.close();await browser.close();await app.close();}
