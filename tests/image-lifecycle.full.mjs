import {clientProtocolHeaders} from '../src/client-protocol.js';
/** Actual-game image lifecycle acceptance, run serially on the software GPU.
 * User-flow claims use native mouse/keyboard/file-chooser input only. Browser
 * evaluation reads state, projections or DOM; it never invokes application actions.
 * The only API mutation fixture deliberately creates a concurrent metadata edit.
 */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {launch} from '../scripts/browser.mjs';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds,emptyScene} from '../src/worlds.js';
import {makePng} from '../fixtures/png-fixtures.mjs';

const out=process.env.UNIVERSE_IMAGE_LIFECYCLE_EVIDENCE||'evidence/image-lifecycle-full';
const dist=process.env.UNIVERSE_IMAGE_LIFECYCLE_DIST||new URL('../dist',import.meta.url).pathname;
await mkdir(out,{recursive:true});
const seeds=structuredClone(seedWorlds),roomId='image-lifecycle-court',roomName='Image lifecycle court';
seeds[0].rooms.push({id:roomId,name:roomName,scene:{...emptyScene(),bounds:{width:8,depth:16},spawn:{x:0,z:4}}});
const app=createGameServer({seeds,dist,imagePhysicalSizeEnabled:true}),address=await app.listen(0),base=`http://127.0.0.1:${address.port}`;
const browser=await launch(),context=await browser.newContext({viewport:{width:1440,height:960}}),page=await context.newPage();
page.setDefaultTimeout(15000);
const checks=[],errors=[],mutations=[];
const results={startedAt:new Date().toISOString(),testedBundleSha256:createHash('sha256').update(await readFile(dist+'/main.js')).digest('hex'),checks,errors,limits:[
 'Fresh isolated loopback server with generated local PNG; no production, external provider, credentials or deployment',
 'Headless Chromium / SwiftShader; rendered-pixel evidence is not physical-device performance evidence',
 'Native browser mouse, keyboard and file chooser; read-only state/projection/DOM diagnostics, no app-action helpers or forged DOM events',
 'Concurrent metadata mutation uses an authenticated local fixture request solely to arrange a real UI conflict',
 'File chooser covered; native OS file drag/drop is not covered'
]};
page.on('pageerror',error=>errors.push(error.message));
page.on('request',request=>{
 const path=new URL(request.url()).pathname;
 if(['POST','PATCH'].includes(request.method())&&/\/assets(?:\/[^/]+)?$/.test(path))mutations.push({method:request.method(),path,body:JSON.parse(request.postData())});
});
const root=page.locator('#image-library');
const fixtureRequest=(method,url,options={})=>page.request[method](url,{...options,headers:clientProtocolHeaders(options.headers)});
const state=()=>page.evaluate(()=>window.__universe.getState());
const editor=()=>page.evaluate(()=>window.__universe.getEditor());
const persist=()=>writeFile(out+'/results.json',JSON.stringify(results,null,2));
const report=async(name,details={})=>{checks.push({name,status:'passed',...details});console.log('PASS',name,JSON.stringify(details));await persist();};
const near=(actual,expected,tolerance=.08)=>assert(Math.abs(actual-expected)<tolerance,`${actual} should be within ${tolerance} of ${expected}`);
const assetPath=id=>`/api/rooms/${roomId}/assets/${id}`;
async function ready(){await page.waitForFunction(()=>window.__universe?.getState().ready,{},{timeout:60000});}
async function build(){if(!await page.locator('#editor').isVisible())await page.locator('#dock-build').click();}
async function openLibrary(){
 await build();
 if(!await root.isVisible())await page.getByRole('button',{name:'Custom images',exact:true}).click();
 await root.waitFor({state:'visible'});
 await page.waitForFunction(()=>document.querySelector('#image-library .uil-cards')?.getAttribute('aria-busy')!=='true');
}
async function closeLibrary(){await root.getByRole('button',{name:'Close Custom image library',exact:true}).click();await root.waitFor({state:'hidden'});await page.waitForTimeout(180);}
async function filter(status,query=''){
 await openLibrary();
 await root.getByRole('combobox',{name:'Library status',exact:true}).selectOption(status);
 await root.getByPlaceholder('Search Custom').fill(query);
 await page.waitForFunction(()=>document.querySelector('#image-library .uil-cards')?.getAttribute('aria-busy')!=='true');
}
async function list(status='active'){
 const response=await fixtureRequest('get',base+`/api/rooms/${roomId}/assets?status=${status}`);
 assert.equal(response.status(),200);return(await response.json()).entries;
}
async function entry(id,status='active'){const value=(await list(status)).find(value=>value.definition.assetId===id);assert(value,`${id} appears in ${status} API projection`);return value;}
async function projected(x,z,y=0){
 await page.waitForFunction(()=>{const f=window.__universe.getCamera().framing;return f.status==='manual'||!f.targetOffset||Math.hypot(f.offset.x-f.targetOffset.x,f.offset.y-f.targetOffset.y)<1;});
 const q=await page.evaluate(p=>window.__universe.getScreenPoint(p.x,p.z,p.y),{x,z,y});
 assert(q?.visible,`projected ${x},${z},${y} must be visible`);
 assert.equal(await page.evaluate(p=>document.elementFromPoint(p.x,p.y)?.id,q),'game','projected pointer target is unobscured canvas');
 return q;
}
async function clickWorld(x,z,y=0){const q=await projected(x,z,y);await page.mouse.click(q.x,q.y);return q;}
async function select(){await page.getByRole('button',{name:'↖ Select',exact:true}).click();}
async function save(){
 await page.getByRole('button',{name:'Save room',exact:true}).click();
 await page.waitForFunction(()=>!window.__universe.getEditor().dirty&&!window.__universe.getEditor().saving);
 return(await state()).scene;
}
async function choose(name){
 await filter('active',name);
 await root.getByRole('button',{name:new RegExp('^Place '+name+' \\(')}).click();
 await root.waitFor({state:'hidden'});await page.waitForFunction(()=>window.__universe.getEditor().tool==='image');
}
async function place(x,z){
 const count=(await state()).scene.objects.length,q=await projected(x,z);
 await page.mouse.move(q.x,q.y);
 const preview=(await editor()).preview;
 assert.equal(preview?.type,'image');assert.equal(preview.valid,true,preview.reason);
 assert.equal((await state()).scene.objects.length,count,'preview cannot add a scene object');
 await page.mouse.click(q.x,q.y);
 await page.waitForFunction(n=>window.__universe.getState().scene.objects.length===n,count+1);
 return(await state()).scene.objects.at(-1);
}
async function visit(name,id){
 await page.locator('#dock-explore').click();
 await page.getByRole('button',{name:'View room '+name,exact:true}).click();
 await page.getByRole('button',{name:'Enter '+name,exact:true}).click();
 await page.waitForFunction(id=>window.__universe.getState().room.id===id,id);
 await page.locator('#places').waitFor({state:'hidden'});
}
function decodeScreenshot(bytes){
 let off=8,width,height,channels,parts=[];
 while(off<bytes.length){const length=bytes.readUInt32BE(off),type=bytes.toString('ascii',off+4,off+8),data=bytes.subarray(off+8,off+8+length);if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);channels=data[9]===6?4:data[9]===2?3:0;assert(channels&&data[8]===8);}if(type==='IDAT')parts.push(data);off+=length+12;}
 const raw=inflateSync(Buffer.concat(parts)),pixels=Buffer.alloc(width*height*channels);
 const paeth=(a,b,c)=>{const p=a+b-c;return Math.abs(p-a)<=Math.abs(p-b)&&Math.abs(p-a)<=Math.abs(p-c)?a:Math.abs(p-b)<=Math.abs(p-c)?b:c;};
 for(let y=0;y<height;y++){const filter=raw[y*(width*channels+1)];for(let x=0;x<width*channels;x++){const i=y*width*channels+x,a=x>=channels?pixels[i-channels]:0,b=y?pixels[i-width*channels]:0,c=y&&x>=channels?pixels[i-width*channels-channels]:0;pixels[i]=(raw[y*(width*channels+1)+1+x]+[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter])&255;}}
 return{rgb(x,y){const i=(Math.round(y)*width+Math.round(x))*channels;return[...pixels.subarray(i,i+3)];}};
}
async function visiblePink(name,x,z){
 await page.waitForTimeout(650);const q=await projected(x,z,.05),pixels=decodeScreenshot(await page.screenshot({path:out+'/'+name+'.png'})),rgb=pixels.rgb(q.x,q.y);
 assert(rgb[0]>180&&rgb[1]<110&&rgb[2]>150,`actual image pixel must remain pink: ${rgb}`);return{point:q,rgb};
}
async function editDetails(name){await root.getByRole('button',{name:'Edit '+name,exact:true}).click();await root.getByRole('heading',{name:'Edit image details',exact:true}).waitFor();}
async function detailsClosed(){await root.getByRole('heading',{name:'Edit image details',exact:true}).waitFor({state:'hidden'});}
async function dragWorld(from,to){
 const start=await projected(from.x,from.z,.05),end=await projected(to.x,to.z);
 await page.mouse.move(start.x,start.y);await page.mouse.down();const before=(await state()).scene;
 await page.mouse.move(end.x,end.y,{steps:14});
 assert.deepEqual((await state()).scene,before,'pointer drag preview cannot mutate scene before release');
 const preview=(await editor()).preview;assert.equal(preview?.kind,'move');assert.equal(preview.valid,true,preview.reason);
 await page.mouse.up();
}

try{
 await page.goto(base,{waitUntil:'domcontentloaded',timeout:60000});
 await page.getByPlaceholder('Your name').fill('Image lifecycle acceptance');await page.locator('#join-button').click();await ready();
 await visit(roomName,roomId);await openLibrary();
 const originalName='Lifecycle original wall',renamed='Lifecycle pink bridge',description='Violet signal ridge, searchable library description',tags=['RevisedTag','Gallery'];
 const bytes=makePng({width:256,height:64,pixel:(x,y)=>[245,35,225,x<32&&y>=32?0:255]});
 const sceneBefore=(await state()).scene;
 await root.getByRole('button',{name:'Add PNG',exact:true}).click();
 const chooser=page.waitForEvent('filechooser');await root.getByRole('button',{name:'Choose PNG',exact:true}).click();
 await(await chooser).setFiles({name:'Lifecycle original wall.png',mimeType:'image/png',buffer:bytes});
 await root.getByAltText('Local image preview').waitFor();
 await root.getByRole('spinbutton',{name:'Width (metres)',exact:true}).fill('8');assert.equal(await root.getByRole('spinbutton',{name:'Height (metres)',exact:true}).inputValue(),'2');
 await root.getByRole('textbox',{name:'Name',exact:true}).fill(originalName);
 await root.getByRole('textbox',{name:'Tags',exact:true}).fill('lifecycle, local');
 await root.getByRole('combobox',{name:'Representation and depth',exact:true}).selectOption('floor');
 await root.getByRole('checkbox',{name:'Floating placement',exact:true}).uncheck();
 await root.getByRole('checkbox',{name:'Paint collision cells',exact:true}).check();
 for(let column=1;column<=8;column++)await root.getByRole('button',{name:`Collision row 1, column ${column}`,exact:true}).click();
 assert.equal(mutations.length,0,'the local chooser and controls must not upload automatically');
 await root.getByRole('button',{name:'Upload',exact:true}).click();
 await root.getByRole('button',{name:new RegExp('^Place '+originalName+' \\(')}).waitFor();
 assert.equal(mutations.filter(m=>m.method==='POST').length,1);
 assert.deepEqual((await state()).scene,sceneBefore,'upload cannot place an object');
 const original=(await list())[0],id=original.definition.assetId;
 assert.equal(original.version.widthMetres,8);assert.equal(original.version.heightMetres,2);
 assert.equal(original.metadata.name,originalName);assert.equal(original.metadata.description,'');assert.deepEqual(original.metadata.tags,['lifecycle','local']);
 assert.deepEqual(original.version.collisionGrid,[Array(8).fill(1),Array(8).fill(0)]);
 assert.equal(original.version.sha256,createHash('sha256').update(bytes).digest('hex'));
 await choose(originalName);const placed=await place(0,0);await select();
 assert.deepEqual(placed.assetRef,{assetId:id,versionId:original.version.versionId});assert.equal(placed.name,originalName);
 const initialPixels=await visiblePink('01-original-image',0,-.5);
 await clickWorld(-3.5,.5,.05);assert.equal((await editor()).selected,null,'transparent image pixel falls through to ground');
 await clickWorld(0,-.5,.05);assert.equal((await editor()).selected,placed.id,'opaque image pixel selects exact placed instance');
 const pinned=await save();
 await report('Real PNG chooser, collision painting, upload, placement, rendering, alpha picking and scene save establish the original pinned instance',{assetId:id,versionId:original.version.versionId,initialPixels});

 await filter('active');await editDetails(originalName);
 await root.getByRole('textbox',{name:'Asset name',exact:true}).fill('Cancelled details');
 await root.getByRole('button',{name:'Cancel details',exact:true}).click();await detailsClosed();
 assert.equal((await entry(id)).revision,original.revision);
 await editDetails(originalName);
 await root.getByRole('textbox',{name:'Description',exact:true}).fill('Keyboard shortcut draft');
 await root.getByRole('textbox',{name:'Description',exact:true}).press('r');
 await root.getByRole('textbox',{name:'Description',exact:true}).press('d');
 assert.deepEqual((await state()).scene,pinned,'typing R/D in metadata must not rotate or duplicate the selected object');
 assert.equal((await editor()).tool,'select','typing D in metadata cannot activate the duplicate tool');
 await page.keyboard.press('Escape');await detailsClosed();assert(await root.isVisible(),'Escape returns from metadata to the library');
 assert.equal((await entry(id)).revision,original.revision);
 await editDetails(originalName);
 await root.getByRole('textbox',{name:'Asset name',exact:true}).fill(renamed);
 await root.getByRole('textbox',{name:'Description',exact:true}).fill(description);
 await root.getByRole('textbox',{name:'Asset tags',exact:true}).fill('RevisedTag, Gallery, revisedtag');
 await root.getByRole('button',{name:'Save details',exact:true}).click();await detailsClosed();
 const edited=await entry(id);
 assert.deepEqual(edited.metadata,{name:renamed,description,tags});assert.equal(edited.revision,original.revision+1);
 assert.deepEqual(edited.version,original.version);assert.deepEqual(edited.definition,original.definition);
 assert.deepEqual((await state()).scene,pinned,'library metadata cannot rename or otherwise mutate a placed instance');
 await root.getByPlaceholder('Search Custom').fill('violet signal');assert.equal(await root.locator('.uil-card').count(),1);
 await root.getByPlaceholder('Search Custom').fill('revisedtag');assert.equal(await root.locator('.uil-card').count(),1);
 await root.getByPlaceholder('Search Custom').fill('not in any description');assert.equal(await root.locator('.uil-card').count(),0);
 await root.getByPlaceholder('Search Custom').fill('violet signal');
 await page.screenshot({path:out+'/02-description-search.png'});
 await report('Metadata Cancel and Escape do not commit; typing is isolated; Save changes only mutable name/description/tags, deduplicates tags, and description/tag search finds the same asset');

 await editDetails(renamed);
 const localDraft={name:'Local unsaved label',description:'Preserve this unsaved description',tags:'LocalDraftTag'};
 await root.getByRole('textbox',{name:'Asset name',exact:true}).fill(localDraft.name);
 await root.getByRole('textbox',{name:'Description',exact:true}).fill(localDraft.description);
 await root.getByRole('textbox',{name:'Asset tags',exact:true}).fill(localDraft.tags);
 const concurrentMetadata={name:'Concurrent curator label',description:'A newer revision from the local concurrency fixture',tags:['ConcurrentTag']};
 const concurrent=await fixtureRequest('patch',base+assetPath(id),{data:{expectedRevision:edited.revision,metadata:concurrentMetadata}});
 assert.equal(concurrent.status(),200);const concurrentEntry=await concurrent.json();
 const beforeConflict=mutations.length;
 await root.getByRole('button',{name:'Save details',exact:true}).click();
 await root.getByRole('button',{name:'Load latest details',exact:true}).waitFor();
 assert.match(await root.innerText(),/changed|conflict/i);
 assert.equal(await root.getByRole('textbox',{name:'Asset name',exact:true}).inputValue(),localDraft.name);
 assert.equal(await root.getByRole('textbox',{name:'Description',exact:true}).inputValue(),localDraft.description);
 assert.equal(await root.getByRole('textbox',{name:'Asset tags',exact:true}).inputValue(),localDraft.tags);
 assert.equal(mutations.length,beforeConflict+1,'one Save attempts exactly one CAS; conflicts cannot replay with a new revision');
 assert.equal(await root.getByRole('button',{name:'Save details',exact:true}).isDisabled(),true);
 await root.getByRole('textbox',{name:'Asset name',exact:true}).press('Enter');await page.waitForTimeout(180);
 assert.equal(mutations.length,beforeConflict+1,'Enter on a conflicted draft cannot silently resubmit');
 assert.equal((await entry(id)).revision,concurrentEntry.revision);assert.deepEqual((await entry(id)).metadata,concurrentMetadata);
 await page.screenshot({path:out+'/03-preserved-conflict-draft.png'});
 await root.getByRole('button',{name:'Load latest details',exact:true}).click();
 await page.waitForFunction(value=>document.querySelector('#image-library input[id$="-detail-name"]')?.value===value,concurrentMetadata.name);
 assert.equal(await root.getByRole('textbox',{name:'Asset name',exact:true}).inputValue(),concurrentMetadata.name);
 assert.equal(await root.getByRole('textbox',{name:'Description',exact:true}).inputValue(),concurrentMetadata.description);
 assert.equal(await root.getByRole('textbox',{name:'Asset tags',exact:true}).inputValue(),concurrentMetadata.tags.join(', '));
 await root.getByRole('textbox',{name:'Asset name',exact:true}).fill(renamed);
 await root.getByRole('textbox',{name:'Description',exact:true}).fill(description);
 await root.getByRole('textbox',{name:'Asset tags',exact:true}).fill('RevisedTag, Gallery, revisedtag');
 await root.getByRole('button',{name:'Save details',exact:true}).click();await detailsClosed();
 const settled=await entry(id);assert.equal(settled.revision,concurrentEntry.revision+1);assert.deepEqual(settled.version,original.version);
 assert.deepEqual((await state()).scene,pinned);
 await report('Real UI stale-revision conflict explains the change and preserves the draft; only explicit Load latest details permits a deliberate revised save');

 await root.getByPlaceholder('Search Custom').fill('');
 const archiveMutations=()=>mutations.filter(m=>m.method==='PATCH'&&m.body.status==='archived').length;
 await root.getByRole('button',{name:'Archive '+renamed,exact:true}).click();
 await root.getByRole('button',{name:'Cancel archive',exact:true}).click();
 assert.equal(archiveMutations(),0);assert.equal((await entry(id)).status,'active');
 await root.getByRole('button',{name:'Archive '+renamed,exact:true}).click();
 await root.getByRole('button',{name:'Confirm archive',exact:true}).focus();await page.keyboard.press('Escape');
 await root.getByRole('button',{name:'Confirm archive',exact:true}).waitFor({state:'hidden'});
 assert(await root.isVisible());assert.equal(archiveMutations(),0);
 await root.getByRole('button',{name:'Archive '+renamed,exact:true}).click();
 await root.getByRole('button',{name:'Confirm archive',exact:true}).dblclick();
 await page.waitForFunction(()=>!document.querySelector('#image-library .uil-card'));
 assert.equal(archiveMutations(),1,'a repeated native confirmation cannot issue duplicate archive writes');
 assert.equal((await list()).length,0);assert.deepEqual((await state()).scene,pinned);
 await filter('archived','violet signal');
 const archived=await entry(id,'archived');assert.equal(archived.status,'archived');assert.equal(archived.revision,settled.revision+1);assert.deepEqual(archived.version,original.version);
 assert.equal(await root.locator('.uil-card').count(),1);
 assert.equal(await root.getByRole('button',{name:/^Place /}).count(),0,'archived entries expose no new-placement control');
 await root.getByRole('button',{name:'Restore '+renamed,exact:true}).waitFor();
 await page.waitForFunction(()=>{const img=document.querySelector('#image-library .uil-card img');return img?.complete&&img.naturalWidth>0;});
 await page.screenshot({path:out+'/04-archived-thumbnail.png'});
 await closeLibrary();
 const archivedPixels=await visiblePink('05-archived-instance-still-renders',0,-.5);
 await clickWorld(-3.5,.5,.05);assert.equal((await editor()).selected,null);
 await clickWorld(0,-.5,.05);assert.equal((await editor()).selected,placed.id);
 await page.locator('#game').focus();await page.keyboard.press('d');
 assert.notEqual((await editor()).tool,'duplicate');assert.deepEqual((await state()).scene,pinned);
 assert.match(await page.locator('#toast').innerText(),/archiv|restor/i);
 const imageResponse=await fixtureRequest('get',base+assetPath(id)+`/versions/${original.version.versionId}/image`);
 assert.equal(imageResponse.status(),200);assert.deepEqual(await imageResponse.body(),bytes);
 await report('Archive cancellation and Escape are safe; repeated explicit confirmation commits once, hides active placement, preserves archived thumbnail and exact PNG, rendering and picking, and blocks keyboard duplication',{archivedPixels});

 await page.getByRole('button',{name:'Close editor',exact:true}).click();
 await page.locator('#editor').waitFor({state:'hidden'});await page.waitForTimeout(550);
 assert.equal(await page.locator('#editor').isVisible(),false,'Done must stay closed after nested library history');
 await page.locator('#game').focus();const beforeWalk=(await state()).position;
 await page.keyboard.down('Shift');await page.keyboard.down('w');
 await page.waitForFunction(p=>p.z-window.__universe.getState().position.z>.45,beforeWalk);
 await page.waitForTimeout(1400);await page.keyboard.up('w');await page.keyboard.up('Shift');
 const stopped=(await state()).position;assert(stopped.z>.28&&stopped.z<.4,`archived painted cells stop near z=.3: ${JSON.stringify(stopped)}`);
 assert(stopped.z<1.1,'actual player crosses the unpainted image row');
 await page.locator('#game').focus();await page.keyboard.down('Shift');await page.keyboard.down('w');await page.waitForTimeout(650);await page.keyboard.up('w');await page.keyboard.up('Shift');
 const stillStopped=(await state()).position;near(stillStopped.z,stopped.z,.04);
 await page.screenshot({path:out+'/06-archived-collision-stop.png'});
 await report('After archive, actual Shift/W walking crosses the clear row and remains stopped by the original painted collision cells',{beforeWalk,stopped,stillStopped});

 await build();await select();await clickWorld(0,-.5,.05);assert.equal((await editor()).selected,placed.id);
 await dragWorld({x:0,z:-.5},{x:0,z:-3.5});
 let moved=(await state()).scene.objects.find(o=>o.id===placed.id);near(moved.x,0);near(moved.z,-3);assert.deepEqual(moved.assetRef,placed.assetRef);
 await page.locator('#game').focus();await page.keyboard.press('r');
 moved=(await state()).scene.objects.find(o=>o.id===placed.id);assert.equal(moved.rotation,90);assert.equal(moved.name,originalName);
 await page.locator('#editor').getByRole('textbox',{name:'Name',exact:true}).fill('Edited archived instance');
 await page.locator('#editor').getByRole('textbox',{name:'Name',exact:true}).press('Tab');
 const archivedSaved=await save();
 await page.reload();await ready();assert.deepEqual((await state()).scene,archivedSaved);
 const loaded=(await state()).scene.objects.find(o=>o.id===placed.id);assert.equal(loaded.name,'Edited archived instance');assert.deepEqual(loaded.assetRef,placed.assetRef);assert.equal(loaded.rotation,90);
 await build();await select();await visiblePink('07-archived-moved-rotated-reloaded',.5,-3);
 await clickWorld(.5,-3,.05);assert.equal((await editor()).selected,placed.id);
 await page.locator('#game').focus();await page.keyboard.press('d');assert.notEqual((await editor()).tool,'duplicate');
 await report('Existing archived instance remains natively draggable, rotatable and renameable; Save/reload retains geometry, instance edits, exact ref and rendered PNG, with duplication still blocked');

 await filter('archived','violet signal');await root.getByRole('button',{name:'Restore '+renamed,exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('#image-library .uil-card'));
 const restored=await entry(id);assert.equal(restored.status,'active');assert.deepEqual(restored.version,original.version);assert.deepEqual(restored.metadata,{name:renamed,description,tags});
 assert.deepEqual((await state()).scene,archivedSaved,'restore cannot modify an existing instance');
 await choose(renamed);const fresh=await place(0,3);assert.equal(fresh.name,renamed);assert.deepEqual(fresh.assetRef,placed.assetRef);assert.notEqual(fresh.id,placed.id);
 await select();const restoredSaved=await save();await page.reload();await ready();assert.deepEqual((await state()).scene,restoredSaved);
 await report('Restore returns the same immutable version to active description search; new native placement uses current library name while the edited old instance stays unchanged, and both survive save/reload');

 await filter('active');await editDetails(renamed);
 await root.getByRole('textbox',{name:'Asset name',exact:true}).fill('Do not save when closing');
 const beforeClose=mutations.length;await closeLibrary();await openLibrary();
 assert.equal(await root.getByRole('heading',{name:'Edit image details',exact:true}).isVisible(),true,'reopening retains the uncommitted draft in the same room');
 assert.equal(await root.getByRole('textbox',{name:'Asset name',exact:true}).inputValue(),'Do not save when closing');
 assert.equal(mutations.length,beforeClose);assert.equal((await entry(id)).metadata.name,renamed);
 await root.getByRole('button',{name:'Cancel details',exact:true}).click();await detailsClosed();
 await editDetails(renamed);await root.getByRole('button',{name:'Cancel details',exact:true}).click();await detailsClosed();
 await editDetails(renamed);await root.getByRole('textbox',{name:'Asset name',exact:true}).fill('Context-specific unsaved draft');await closeLibrary();
 await visit('The Commons','commons');await openLibrary();assert.equal(await root.locator('.uil-card').count(),0);
 assert.equal((await editor()).tool,'select');assert.equal((await editor()).preview,null);
 await closeLibrary();await visit(roomName,roomId);await filter('active','violet signal');
 assert.equal(await root.locator('.uil-card').count(),1);
 assert.equal(await root.getByRole('heading',{name:'Edit image details',exact:true}).isVisible(),false,'room switch discards the old room management draft');
 assert.equal((await entry(id)).metadata.name,renamed);
 await root.getByRole('button',{name:'Close Custom image library',exact:true}).focus();await page.keyboard.press('Enter');await root.waitFor({state:'hidden'});
 await page.waitForTimeout(550);assert(await page.locator('#editor').isVisible());
 await page.screenshot({path:out+'/08-final-live-build.png'});
 await report('Repeated edit/Cancel and library Close/reopen preserve the correct uncommitted state without saving; room navigation clears old draft, cards and placement context; returning reloads the correct active asset and keyboard Close returns to live Build');
 assert.deepEqual(errors,[]);await report('No unhandled runtime exceptions during bounded actual-game lifecycle acceptance');
}catch(error){
 console.error(error);checks.push({name:'Actual-game lifecycle acceptance failure',status:'failed',error:error.stack});
 await page.screenshot({path:out+'/failure.png'}).catch(()=>{});
 await writeFile(out+'/failure-state.json',JSON.stringify({state:await state().catch(()=>null),editor:await editor().catch(()=>null),text:await page.locator('body').innerText().catch(()=>null),mutations},null,2));
 process.exitCode=1;
}finally{await persist();await context.close();await browser.close();await app.close();}
