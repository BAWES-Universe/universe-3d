/** Native invitation → account → private place → sized artwork → room chat.
 * Setup provisions only a synthetic site owner and one site-admission token.
 * All friend mutations use the actual page; diagnostics only read state/data.
 */
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {createGameServer} from '../server/app.mjs';
import {bootstrapOwner} from '../server/operator-accounts.mjs';
import {readRuntimeConfig} from '../server/runtime-config.mjs';
import {launch} from '../scripts/browser.mjs';
import {makePng} from '../fixtures/png-fixtures.mjs';
import {clientProtocolHeaders} from '../src/client-protocol.js';

const out='evidence/complete-friend-journey';await mkdir(out,{recursive:true});
const config=readRuntimeConfig({UNIVERSE_MODE:'local',UNIVERSE_REGISTRATION_MODE:'invite-only'});
const app=createGameServer({database:':memory:',seeds:[],dist:new URL('../dist',import.meta.url).pathname,runtimeConfig:config,imagePhysicalSizeEnabled:true});
const password='synthetic invitation journey password';
await bootstrapOwner(app.store,{name:'Synthetic site owner',username:'journey_owner',password});
const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`,browser=await launch(),owner=await browser.newContext(),context=await browser.newContext({viewport:{width:1280,height:850}}),page=await context.newPage();
page.setDefaultTimeout(60000);page.setDefaultNavigationTimeout(90000);
const checks=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
const pass=name=>{checks.push({name,status:'passed'});console.log('PASS',name);};
async function call(ctx,path,method='GET',data){const response=await ctx.request.fetch(base+path,{method,headers:clientProtocolHeaders(),...(data?{data}:{})});const result=await response.json();assert(response.ok(),JSON.stringify({path,status:response.status(),result}));return result;}
const ready=()=>page.waitForFunction(()=>window.__universe?.getState().ready);
try{
 await call(owner,'/api/login','POST',{username:'journey_owner',password});
 const invite=await call(owner,'/api/site-invites','POST',{clientOperationId:randomBytes(32).toString('base64url'),label:'Synthetic first friend'});
 await page.goto(base+'/join.html#invite='+invite.token);await page.locator('#signup-view').waitFor();
 assert.equal(new URL(page.url()).hash,'');
 const signup=page.locator('#signup-form');await signup.getByLabel('What should we call you?',{exact:true}).fill('First friend');
 await signup.getByLabel('Username',{exact:true}).fill('first_journey_friend');
 await signup.getByLabel('Password',{exact:true}).fill(password);await signup.getByLabel('Confirm password',{exact:true}).fill(password);await signup.getByLabel('Confirm password',{exact:true}).press('Enter');
 await page.getByRole('heading',{name:'You’re one hello away.',exact:true}).waitFor();assert.equal((await context.cookies()).length,0,'Account creation is not implicit login');
 await page.locator('#signin-password').fill(password);await page.locator('#signin-password').press('Enter');await page.locator('#signedin-view').waitFor();
 const session=await call(context,'/api/session'),userId=session.user.id;assert.equal(session.siteAdmission.canManage,false);assert.equal(session.imagePhysicalSize.required,true);
 assert.equal(app.store.get('SELECT COUNT(*) AS n FROM world_members WHERE user_id=?',userId).n,0);assert.equal(app.store.get('SELECT COUNT(*) AS n FROM members WHERE user_id=?',userId).n,0);
 await page.getByRole('link',{name:'Go to Universe',exact:false}).click();await page.locator('#places').waitFor();assert.equal(await page.evaluate(()=>__universe.getState().ready),false);
 pass('An invited friend chooses a password, signs in separately and reaches the real empty directory without implicit room access');

 await page.getByRole('button',{name:'Make a place',exact:true}).click();await page.getByLabel('Place name',{exact:true}).fill('Our first studio');assert.equal(await page.getByLabel('Privacy',{exact:true}).inputValue(),'private');
 await page.getByRole('button',{name:'Create & enter',exact:true}).click();await ready();await page.locator('#places').waitFor({state:'hidden'});
 const state=await page.evaluate(()=>__universe.getState()),roomId=state.room.id;
 assert.equal(state.room.role,'owner');assert.equal(state.room.public,false);assert.equal(state.scene.objects.length,0);
 const account=app.store.get('SELECT user_id FROM accounts WHERE username=?','first_journey_friend');assert.equal(state.user.id,account.user_id);
 if(await page.getByRole('button',{name:'Not now',exact:true}).isVisible())await page.getByRole('button',{name:'Not now',exact:true}).click();
 await page.screenshot({path:out+'/01-created-private-place.png'});
 pass('One guided action creates a private hierarchy and enters its empty room as its explicit creator');

 await page.locator('#dock-build').click();await page.getByRole('button',{name:'Custom images',exact:true}).click();
 const library=page.locator('#image-library');await library.getByRole('button',{name:'Add PNG',exact:true}).click();
 const png=makePng({width:1024,height:1024,pixel:(x,y)=>{const stripe=Math.floor(x/128)%2===Math.floor(y/128)%2;return stripe?[42,180,166,255]:[236,200,97,255];}});
 const chooser=page.waitForEvent('filechooser');await library.getByRole('button',{name:'Choose PNG',exact:true}).click();await(await chooser).setFiles({name:'Studio tile.png',mimeType:'image/png',buffer:png});await library.getByAltText('Local image preview').waitFor();
 const form=library.locator('.uil-draft').first();await form.getByRole('spinbutton',{name:'Width (metres)',exact:true}).fill('2');await form.getByRole('combobox',{name:'Representation and depth',exact:true}).selectOption('floor');await library.getByRole('button',{name:'Upload',exact:true}).click();
 await library.getByRole('button',{name:new RegExp('^Place Studio tile')}).waitFor();
 const entry=(await call(context,`/api/rooms/${roomId}/assets`)).entries[0];assert.equal(entry.version.widthMetres,2);assert.equal(entry.version.heightMetres,2);assert.equal(entry.version.widthPixels,1024);assert.equal(entry.version.sha256,createHash('sha256').update(png).digest('hex'));
 await library.getByRole('button',{name:new RegExp('^Place Studio tile')}).click();await library.waitFor({state:'hidden'});
 await page.waitForFunction(()=>__universe.getEditor().tool==='image');
 let target;
 for(const [x,z] of [[-4,-3],[-4,2],[4,-3],[4,3]]){
  const point=await page.evaluate(({x,z})=>__universe.getScreenPoint(x,z,0),{x,z});
  if(point?.visible&&await page.evaluate(p=>document.elementFromPoint(p.x,p.y)?.id==='game',point)){target=point;break;}
 }
 assert(target,'A real unobscured world point is available');await page.mouse.move(target.x,target.y);await page.waitForFunction(()=>__universe.getEditor().preview?.valid===true);await page.mouse.click(target.x,target.y);await page.waitForFunction(()=>__universe.getState().scene.objects.some(object=>object.type==='image'));
 await page.getByRole('button',{name:'Save room',exact:true}).click();await page.waitForFunction(()=>!__universe.getEditor().dirty&&!__universe.getEditor().saving);
 const saved=(await call(context,`/api/rooms/${roomId}`)).room.scene;assert.deepEqual(saved.objects[0].assetRef,{assetId:entry.definition.assetId,versionId:entry.version.versionId});
 await page.screenshot({path:out+'/02-sized-artwork-saved.png'});await page.getByRole('button',{name:'Close editor',exact:true}).click();
 pass('The newly created room accepts original 1024px PNG bytes at 2×2m and saves an immutable placed version through native Build controls');

 await page.locator('#dock-chat').click();await page.getByRole('textbox',{name:'Message the room',exact:true}).fill('Our first studio is ready');await page.locator('#social').getByRole('button',{name:'Send message',exact:true}).click();await page.getByText('Our first studio is ready',{exact:true}).waitFor();
 await page.setViewportSize({width:320,height:700});await page.screenshot({path:out+'/03-compact-first-chat.png'});await page.getByRole('button',{name:'Close social panel',exact:true}).click();
 await page.reload({waitUntil:'domcontentloaded'});await ready();assert.equal(await page.evaluate(()=>__universe.getState().user.id),userId);assert.deepEqual(await page.evaluate(()=>__universe.getState().scene),saved);
 await page.locator('#dock-chat').click();await page.getByText('Our first studio is ready',{exact:true}).waitFor();await page.getByRole('button',{name:'Close social panel',exact:true}).click();await page.screenshot({path:out+'/04-mobile-returned-world.png'});
 pass('Compact room chat and a full page reload preserve the invited identity, private room and pinned artwork');
 assert.deepEqual(errors,[]);
}catch(error){process.exitCode=1;checks.push({status:'failed',error:error.stack});console.error(error);await page.screenshot({path:out+'/failure.png'}).catch(()=>{});}
finally{await writeFile(out+'/results.json',JSON.stringify({checks,errors,bundleSha256:createHash('sha256').update(await readFile('dist/main.js')).digest('hex'),scope:'Actual combined app; synthetic site invitation and owner setup; native friend mutation journey; 320px resize is browser emulation, not a physical phone'},null,2));await browser.close();await app.close();}
