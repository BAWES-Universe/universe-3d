import {clientProtocolHeaders} from '../src/client-protocol.js';
/** Actual-game image setup acceptance. Run serially under the shared GPU flock.
 * All claimed UI flows use native mouse/keyboard/file chooser/CDP touch input.
 * evaluate() only reads state, projections, DOM and rendered-frame diagnostics.
 * The separate local owner is an HTTP fixture for peer commits and role changes.
 */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {inflateSync} from 'node:zlib';
import {launch} from '../scripts/browser.mjs';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds,emptyScene} from '../src/worlds.js';
import {resolveImagePlacement} from '../src/image-asset-geometry.js';
import {makePng} from '../fixtures/png-fixtures.mjs';

const out='evidence/image-physical-size-native';
const dist=process.env.UNIVERSE_IMAGE_SETUP_DIST||new URL('../dist',import.meta.url).pathname;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
await mkdir(out,{recursive:true});
const app=createGameServer({seeds:structuredClone(seedWorlds),dist,imagePhysicalSizeEnabled:true}),address=await app.listen(0),base=`http://127.0.0.1:${address.port}`;
const browser=await launch();
let context=await browser.newContext({viewport:{width:1440,height:960}}),page=await context.newPage(),roomId,assetId,ownerCookie='',cdp;
const checks=[],errors=[],mutations=[],events=[],fixtures=[];
const results={startedAt:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceTree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(),testSha256:sha(await readFile(new URL(import.meta.url))),bundleSha256:sha(await readFile(dist+'/main.js')),checks,errors,mutations,events,fixtures,limits:[
 'Disposable loopback server, local accounts and synthetic 1024×1024 PNG; no external media, real provider, credentials or deployment',
 'Native browser mouse, keyboard, file chooser and CDP touch; browser evaluation is read-only diagnostic access',
 'A separately authenticated owner arranges room, membership and concurrent version fixtures through HTTP',
 'SQLite and pure geometry checks are model evidence; separate screenshot pixels, native picking and keyboard walking establish actual renderer/input behavior',
 'Headless Chromium SwiftShader and emulated 320px touch are not physical-device performance evidence'
]};
const fixtureRequest=(method,url,options={})=>page.request[method](url,{...options,headers:clientProtocolHeaders(options.headers)});
const state=()=>page.evaluate(()=>window.__universe.getState());
const editor=()=>page.evaluate(()=>window.__universe.getEditor());
const root=()=>page.locator('#image-library');
const setup=()=>root().locator('.uil-setup');
const button=(name,scope=root())=>scope.getByRole('button',{name,exact:true});
const assetPath=()=>`/api/rooms/${roomId}/assets/${assetId}`;
const ref=entry=>({assetId:entry.definition.assetId,versionId:entry.version.versionId});
const persist=()=>writeFile(out+'/results.json',JSON.stringify(results,null,2));
const report=async(name,details={})=>{checks.push({name,status:'passed',...details});console.log('PASS',name);await persist();};
const near=(actual,expected,tolerance=.08)=>assert(Math.abs(actual-expected)<tolerance,`${actual} should be within ${tolerance} of ${expected}`);
async function owner(path,method='GET',body){
 const response=await fetch(base+path,{method,headers:clientProtocolHeaders({Cookie:ownerCookie,...(body?{'Content-Type':'application/json'}:{})}),...(body?{body:JSON.stringify(body)}:{})});
 if(response.headers.get('set-cookie'))ownerCookie=response.headers.get('set-cookie').split(';')[0];
 const result=await response.json();fixtures.push({path,method,status:response.status});
 assert(response.ok,JSON.stringify({path,status:response.status,result}));return result;
}
async function observe(){
 page.setDefaultTimeout(20000);
 page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>{const path=new URL(request.url()).pathname;if(['POST','PATCH'].includes(request.method())&&path.includes('/assets'))mutations.push({method:request.method(),path,body:JSON.parse(request.postData())});});
 cdp=await context.newCDPSession(page);await cdp.send('Network.enable');
 cdp.on('Network.eventSourceMessageReceived',event=>{if(event.eventName==='image-assets')events.push(JSON.parse(event.data));});
}
async function frames(count=3){const start=await page.evaluate(()=>window.__universe.getStats().presentation.drawnFrames);await page.waitForFunction(n=>window.__universe.getStats().presentation.drawnFrames>=n,start+count,{timeout:30000});}
async function ready(){await page.waitForFunction(()=>window.__universe?.getState().ready,{},{timeout:60000});await frames();}
async function build(){if(!await page.locator('#editor').isVisible())await page.locator('#dock-build').click();}
async function openLibrary(){if(!await root().isVisible()){await build();await page.getByRole('button',{name:'Custom images',exact:true}).click();}await root().waitFor({state:'visible'});await libraryReady();}
async function libraryReady(){await page.waitForFunction(()=>document.querySelector('#image-library .uil-cards')?.getAttribute('aria-busy')!=='true');}
async function closeLibrary(){await button('Close Custom image library').click();await root().waitFor({state:'hidden'});await frames();}
async function openSetup(name){await openLibrary();await button('Edit setup for '+name).click();await setup().waitFor({state:'visible'});}
async function list(status='active'){const response=await fixtureRequest('get',base+`/api/rooms/${roomId}/assets?status=${status}`);assert.equal(response.status(),200);return(await response.json()).entries;}
async function current(status='active'){const entry=(await list(status)).find(e=>e.definition.assetId===assetId);assert(entry,'fixture asset remains discoverable');return entry;}
async function room(){const response=await fixtureRequest('get',base+`/api/rooms/${roomId}`);assert.equal(response.status(),200);return(await response.json()).room;}
async function choose(name,version){await openLibrary();const place=root().getByRole('button',{name:`Place ${name} (${assetId})`,exact:true});assert.equal(await place.innerText(),`Place ${name} · version ${version}`);await place.click();await root().waitFor({state:'hidden'});await page.waitForFunction(()=>window.__universe.getEditor().tool==='image');}
async function projected(x,z,y=0){
 await page.waitForFunction(()=>{const f=window.__universe.getCamera().framing;return f.status==='manual'||!f.targetOffset||Math.hypot(f.offset.x-f.targetOffset.x,f.offset.y-f.targetOffset.y)<1;});
 const point=await page.evaluate(p=>window.__universe.getScreenPoint(p.x,p.z,p.y),{x,z,y});assert(point?.visible,`visible world point ${x},${z},${y}`);
 assert.equal(await page.evaluate(p=>document.elementFromPoint(p.x,p.y)?.id,point),'game','world point reaches the actual canvas');return point;
}
async function clickWorld(x,z,y=0){const point=await projected(x,z,y);await page.mouse.click(point.x,point.y);return point;}
async function preview(x,z){const point=await projected(x,z);await page.mouse.move(point.x,point.y);await frames();const value=(await editor()).preview;assert.equal(value?.type,'image');assert.equal(value.valid,true,value.reason);return{point,value};}
async function place(x,z,expectedRef){const before=(await state()).scene.objects.length,{point,value}=await preview(x,z);assert.deepEqual(value.assetRef,expectedRef);await page.mouse.click(point.x,point.y);await page.waitForFunction(n=>window.__universe.getState().scene.objects.length===n,before+1);const valuePlaced=(await state()).scene.objects.at(-1);assert.deepEqual(valuePlaced.assetRef,expectedRef);return valuePlaced;}
async function select(){await page.getByRole('button',{name:'↖ Select',exact:true}).click();}
async function save(){await page.getByRole('button',{name:'Save room',exact:true}).click();await page.waitForFunction(()=>!window.__universe.getEditor().dirty&&!window.__universe.getEditor().saving);return(await state()).scene;}
async function untouched(scene,revision){assert.deepEqual((await state()).scene,scene);assert.equal((await room()).revision,revision);assert.equal((await editor()).dirty,false);}
async function bytesFor(entry,bytes){const response=await fixtureRequest('get',base+assetPath()+`/versions/${entry.version.versionId}/image`);assert.equal(response.status(),200);assert.deepEqual(await response.body(),bytes);assert.equal(entry.version.sha256,sha(bytes));}
function rows(){return app.store.all('SELECT version_id,sequence,version_json,sha256,byte_length,bytes FROM room_image_asset_versions WHERE room_id=? AND asset_id=? ORDER BY sequence',roomId,assetId);}
function snapshotRows(){return rows().map(row=>({...row,bytes:Buffer.from(row.bytes).toString('base64')}));}
function decodeScreenshot(bytes){
 let off=8,width,height,channels,parts=[];
 while(off<bytes.length){const length=bytes.readUInt32BE(off),type=bytes.toString('ascii',off+4,off+8),data=bytes.subarray(off+8,off+8+length);if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);channels=data[9]===6?4:data[9]===2?3:0;assert(channels&&data[8]===8);}if(type==='IDAT')parts.push(data);off+=length+12;}
 const raw=inflateSync(Buffer.concat(parts)),pixels=Buffer.alloc(width*height*channels),paeth=(a,b,c)=>{const p=a+b-c;return Math.abs(p-a)<=Math.abs(p-b)&&Math.abs(p-a)<=Math.abs(p-c)?a:Math.abs(p-b)<=Math.abs(p-c)?b:c;};
 for(let y=0;y<height;y++){const filter=raw[y*(width*channels+1)];for(let x=0;x<width*channels;x++){const i=y*width*channels+x,a=x>=channels?pixels[i-channels]:0,b=y?pixels[i-width*channels]:0,c=y&&x>=channels?pixels[i-width*channels-channels]:0;pixels[i]=(raw[y*(width*channels+1)+1+x]+[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter])&255;}}
 return{rgb(x,y){const i=(Math.round(y)*width+Math.round(x))*channels;return[...pixels.subarray(i,i+3)];}};
}
async function pink(name,x,z,y=.05){
 await page.locator('#image-render-status').waitFor({state:'hidden'});await frames(4);const point=await projected(x,z,y),pixels=decodeScreenshot(await page.screenshot({path:out+'/'+name+'.png'})),rgb=pixels.rgb(point.x,point.y);
 assert(rgb[0]>180&&rgb[1]<110&&rgb[2]>150,`actual rendered pink pixel at ${JSON.stringify(point)}: ${rgb}`);return{point,rgb};
}
async function configure(preset,pivotValue,grid){
 await setup().getByRole('combobox',{name:'Representation and depth',exact:true}).selectOption(preset);
 if(preset==='custom')await setup().getByRole('spinbutton',{name:'Custom ground pivot',exact:true}).fill(String(pivotValue));
 const checkbox=setup().getByRole('checkbox',{name:'Paint collision cells',exact:true});await checkbox.setChecked(!!grid);
 if(grid)for(let row=0;row<grid.length;row++)for(let col=0;col<grid[row].length;col++){const cell=button(`Collision row ${row+1}, column ${col+1}`,setup());if((await cell.getAttribute('aria-pressed'))!==String(!!grid[row][col]))await cell.click();}
}
async function setupValues(){return{depth:await setup().getByRole('combobox',{name:'Representation and depth',exact:true}).inputValue(),pivot:await setup().getByRole('spinbutton',{name:'Custom ground pivot',exact:true}).inputValue(),grid:await setup().getByRole('group',{name:'Setup collision cells',exact:true}).getByRole('button').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-pressed')))};}
async function saveVersion(sequence){const count=mutations.length;await button('Save new version',setup()).click();await setup().waitFor({state:'hidden'});await libraryReady();const entry=await current();assert.equal(entry.version.sequence,sequence);assert.equal(mutations.length,count+1);return entry;}
async function peerVersion(baseEntry,setupValue){return owner(assetPath()+'/versions','POST',{operationId:'peer-'+randomUUID(),expectedRevision:baseEntry.revision,expectedVersionId:baseEntry.version.versionId,setup:setupValue});}
// Native touch completion can precede the ResizeObserver move into More.
async function mobileLibrary(){await page.waitForFunction(()=>!document.querySelector('#editor').hidden&&document.querySelector('#editor').dataset.compact==='true');const custom=page.getByRole('button',{name:'Custom images',exact:true});if(!await custom.isVisible())await page.getByRole('button',{name:'More build tools',exact:true}).click();await custom.waitFor({state:'visible'});await custom.click();}
async function touch(locator){await locator.scrollIntoViewIfNeeded();const box=await locator.boundingBox();assert(box&&box.x>=0&&box.x+box.width<=320.5&&box.y>=0&&box.y+box.height<=760.5,`touch target in viewport: ${JSON.stringify(box)}`);const point={x:box.x+box.width/2,y:box.y+box.height/2};assert(await locator.evaluate((node,p)=>node===document.elementFromPoint(p.x,p.y)||node.contains(document.elementFromPoint(p.x,p.y)),point));await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,id:1,radiusX:2,radiusY:2,force:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}

try {
 await observe();
 await owner('/api/session','POST',{name:'Sizing peer owner'});
 const universe=(await owner('/api/universes','POST',{name:'Image sizing acceptance'})).universe;
 const world=(await owner('/api/worlds','POST',{universeId:universe.id,name:'Sizing world'})).world;
 const roomName='High resolution court';
 const created=(await owner('/api/rooms','POST',{worldId:world.id,name:roomName,scene:emptyScene()})).room;roomId=created.id;
 await owner(`/api/rooms/${roomId}/join`,'POST',{});
 await page.goto(base,{waitUntil:'domcontentloaded',timeout:60000});
 await page.getByPlaceholder('Your name').fill('Sizing native editor');await page.locator('#join-button').click();await ready();
 assert((await page.locator('body').innerText()).length>0);assert.equal(await page.locator('.vite-error-overlay,[data-nextjs-dialog]').count(),0);
 const userId=(await state()).user.id;await owner(`/api/rooms/${roomId}/members/${userId}`,'PUT',{role:'editor'});
 await page.locator('#dock-explore').click();await page.getByRole('button',{name:'View room '+roomName,exact:true}).click();await page.getByRole('button',{name:'Enter '+roomName,exact:true}).click();await page.waitForFunction(id=>window.__universe.getState().room.id===id,roomId);await page.locator('#places').waitFor({state:'hidden'});
 const name='High resolution artwork',bytes=makePng({width:1024,height:1024,pixel:(x,y)=>[245,35,225,x<256&&y<256?0:255]});
 await openLibrary();await button('Add PNG').click();
 const chooser=page.waitForEvent('filechooser');await button('Choose PNG').click();await(await chooser).setFiles({name:name+'.png',mimeType:'image/png',buffer:bytes});await root().getByAltText('Local image preview').waitFor();
 const form=root().locator('.uil-draft').first(),width=form.getByRole('spinbutton',{name:'Width (metres)',exact:true}),height=form.getByRole('spinbutton',{name:'Height (metres)',exact:true});
 assert.equal(await width.inputValue(),'2');assert.equal(await height.inputValue(),'2');assert.equal(await form.getByRole('checkbox',{name:'Lock aspect ratio',exact:true}).isChecked(),true);
 assert.match(await form.innerText(),/Room 32 × 26 m/);
 await width.fill('1');assert.equal(await height.inputValue(),'1');
 await form.getByRole('combobox',{name:'Representation and depth',exact:true}).selectOption('floor');
 await page.screenshot({path:out+'/01-upload-one-metre.png'});
 await button('Upload').click();await root().getByRole('button',{name:/^Place High resolution artwork/}).waitFor();const v1=(await list())[0];assetId=v1.definition.assetId;
 assert.equal(v1.version.widthMetres,1);await bytesFor(v1,bytes);
 await choose(name,1);const a=await place(-3,0,ref(v1));await select();await save();
 const pink1=await pink('02-one-metre',a.x,a.z);await clickWorld(a.x,a.z,.05);assert.equal((await editor()).selected,a.id);
 await clickWorld(a.x-.4,a.z-.4,.05);assert.equal((await editor()).selected,null,'source transparent corner remains unpickable after physical resizing');
 const versions=[v1],placements=[a];
 for(const size of [2,4]){
  const before=structuredClone((await state()).scene);
  await openSetup(name);const w=setup().getByRole('spinbutton',{name:'Width (metres)',exact:true}),h=setup().getByRole('spinbutton',{name:'Height (metres)',exact:true});
  await w.fill(String(size));assert.equal(await h.inputValue(),String(size));
  await page.screenshot({path:out+`/03-setup-${size}m.png`});
  const next=await saveVersion(versions.length+1);versions.push(next);assert.deepEqual((await state()).scene,before);
  await bytesFor(next,bytes);await choose(name,next.version.sequence);
  if(size===2){await page.locator('#game').focus();await page.keyboard.press('r');}
  const placed=await place(size===2?0:4,size===2?-3:0,ref(next));placements.push(placed);
  if(size===2)assert.equal(placed.rotation,90);
  await select();await save();await pink(`04-world-${size}m`,placed.x,placed.z);
  await clickWorld(placed.x,placed.z,.05);assert.equal((await editor()).selected,placed.id);assert.match(await page.locator('.builder-image-summary').innerText(),new RegExp(`1024 × 1024 px · ${size} × ${size} m`),'isolated editor adapter reports physical metres');
 }
 await report('Native chooser preserves 1024px PNG; aspect lock defaults to2m; explicit1/2/4m versions place, render pink source pixels and persist independently',{hash:sha(bytes),versions:versions.map(e=>({versionId:e.version.versionId,size:e.version.widthMetres,sha256:e.version.sha256})),placements,pink1});
 const picked=placements[2];await clickWorld(picked.x,picked.z,.05);assert.equal((await editor()).selected,picked.id);
 await page.getByRole('button',{name:'Duplicate selected item',exact:true}).click();
 const target=await projected(0,3);await page.mouse.move(target.x,target.y);await frames();assert.equal((await editor()).preview.valid,true);await page.mouse.click(target.x,target.y);await page.waitForFunction(()=>window.__universe.getState().scene.objects.length===4);
 assert.deepEqual((await state()).scene.objects.at(-1).assetRef,ref(versions[2]));
 await page.getByRole('button',{name:'Undo',exact:true}).click();assert.equal((await state()).scene.objects.length,3);
 await page.getByRole('button',{name:'Redo',exact:true}).click();assert.equal((await state()).scene.objects.length,4);
 await select();const saved=await save();
 const peerRoom=await owner(`/api/rooms/${roomId}`);assert.deepEqual(peerRoom.room.scene,saved);
 await page.reload();await ready();assert.deepEqual((await state()).scene,saved);
 for(const e of versions)await bytesFor(e,bytes);
 await page.screenshot({path:out+'/05-reloaded-versions.png'});
 await report('Rotated placement, native Duplicate/Undo/Redo, save/reload and separately authenticated peer converge with exact immutable pins');
 const storage=await context.storageState();await context.close();context=await browser.newContext({viewport:{width:320,height:760},isMobile:true,hasTouch:true,deviceScaleFactor:2,storageState:storage});page=await context.newPage();await observe();await page.goto(base);await ready();await touch(page.locator('#dock-build'));await mobileLibrary();await libraryReady();await touch(button('Edit setup for '+name));await setup().waitFor({state:'visible'});
 const mobileWidth=setup().getByRole('spinbutton',{name:'Width (metres)',exact:true});await mobileWidth.fill('2');assert.equal(await setup().getByRole('spinbutton',{name:'Height (metres)',exact:true}).inputValue(),'2');
 const metrics=await setup().evaluate(node=>({viewport:innerWidth,document:document.documentElement.scrollWidth,client:node.clientWidth,scroll:node.scrollWidth}));assert.equal(metrics.document,320);assert.equal(metrics.client,metrics.scroll);
 await touch(mobileWidth);await page.screenshot({path:out+'/06-mobile-size-controls.png'});
 await touch(button('Save new version',setup()));await setup().waitFor({state:'hidden'});assert.equal((await current()).version.widthMetres,2);assert.deepEqual((await state()).scene,saved);
 await report('320px DPR2 touch emulation: size controls and Save reachable, locked ratio preserved, save changes no placed versions',{metrics});
 assert.deepEqual(errors,[]);await report('App renders meaningful content with no error overlay or unhandled runtime exceptions');
} catch(error) {console.error(error);checks.push({name:'Native acceptance',status:'failed',error:error.stack});await page.screenshot({path:out+'/failure.png'}).catch(()=>{});await writeFile(out+'/failure-state.json',JSON.stringify({state:await state().catch(()=>null),editor:await editor().catch(()=>null),text:await page.locator('body').innerText().catch(()=>null)},null,2));process.exitCode=1;}
finally {await persist();await context.close();await browser.close();await app.close();}
