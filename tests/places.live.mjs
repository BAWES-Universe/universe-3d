/** Real SQLite + HTTP + browser UI checks. Only the page shell is a fixture. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from '../scripts/browser.mjs';
import { createGameServer } from '../server/app.mjs';
const dir = await mkdtemp(join(tmpdir(), 'universe-places-live-'));
await writeFile(join(dir, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/places.css"><style>body{margin:0;background:#0b0911;color:white;font:14px Arial}#open{margin:20px}</style></head><body><button id="open">Open places</button><div id="root" hidden></div><script type="module" src="/fixture.js"></script></body></html>');
await writeFile(join(dir, 'fixture.js'), `import {mountPlaces} from '/places.js';
const api=window.api=async(path,options={})=>{const res=await fetch(path,{method:options.method||'GET',headers:options.body?{'Content-Type':'application/json'}:{},body:options.body?JSON.stringify(options.body):undefined});const data=await res.json();if(!res.ok)throw Object.assign(new Error(data.message||data.error),{status:res.status,data});return data};
let session;try{session=await api('/api/session')}catch{session=await api('/api/session',{method:'POST',body:{name:new URL(location.href).searchParams.get('name')||'Mira',woka:0}})}
const state=window.state={...session};state.room=(await api('/api/rooms/r1/join',{method:'POST',body:{}})).room;
window.gameKeys=[];window.addEventListener('keydown',event=>window.gameKeys.push(event.key));
const places=window.places=mountPlaces({root:document.querySelector('#root'),api,getState:()=>state,onNavigate:async id=>{state.room=(await api('/api/rooms/'+id+'/join',{method:'POST',body:{}})).room},toast:message=>{window.lastToast=message},onChanged:async()=>Object.assign(state,await api('/api/session'))});
document.querySelector('#open').onclick=()=>places.open('explore');
window.events=new EventSource('/api/events');for(const type of ['catalog','invitation','membership','role','access-revoked'])window.events.addEventListener(type,event=>places.onEvent({type,data:JSON.parse(event.data)}));window.ready=true;`);
for (const file of ['places.js', 'places.css', 'place-creation-flow.js']) await writeFile(join(dir, file), await readFile(new URL(`../src/${file}`, import.meta.url)));
const scene = {version:1,theme:'garden',bounds:{width:32,depth:26},spawn:{x:0,z:0},objects:[],areas:[]};
let serverTime=Date.now();
const app = createGameServer({clock:()=>serverTime,database: ':memory:', seeds: [{id:'w1',name:'Moon world',rooms:[{id:'r1',name:'Moon garden',scene},{id:'r2',name:'Quiet room',scene}]}],dist:dir});
const address=await app.listen(0),base=`http://127.0.0.1:${address.port}`;
const browser=await launch(), errors=[], checks=[];
const check=async(name,fn)=>{await fn();checks.push({name,status:'passed'});console.log('PASS',name)};
let a,b,mobileContext,alice,bob;
async function call(page,path,method='GET',body){return page.evaluate(async({path,method,body})=>window.api(path,{method,body}),{path,method,body})}
async function open(page,tab='explore'){await page.evaluate(tab=>window.places.open(tab),tab);await page.locator('#places-panel').waitFor();}
try{
  a=await browser.newContext({viewport:{width:1200,height:850}});b=await browser.newContext({viewport:{width:1200,height:850}});
  alice=await a.newPage();bob=await b.newPage();for(const p of [alice,bob])p.on('pageerror',e=>errors.push(e.message));
  await alice.goto(base+'/?name=Mira');await alice.waitForFunction(()=>window.ready);await bob.goto(base+'/?name=Ari');await bob.waitForFunction(()=>window.ready);
  await call(alice,'/api/account','POST',{username:'mira',password:'test-only-password-123'});await call(bob,'/api/account','POST',{username:'ari',password:'test-only-password-456'});await alice.evaluate(async()=>Object.assign(window.state,await window.api('/api/session')));await bob.evaluate(async()=>Object.assign(window.state,await window.api('/api/session')));
  await check('real hierarchy explorer has stable ancestry, travel and close-first focus',async()=>{
    await alice.getByRole('button',{name:'Open places'}).click();await alice.getByRole('button',{name:'Enter Quiet room',exact:true}).waitFor();assert.equal(await alice.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Close places');
    await alice.getByRole('button',{name:'Enter Quiet room',exact:true}).click();await alice.waitForFunction(()=>window.state.room.id==='r2');assert.equal(await alice.locator('#root').isHidden(),true);assert.equal(await alice.evaluate(()=>document.activeElement.id),'open');
  });
  let universeId,worldId,roomId;
  await check('universe, world and room creation use real SQLite authority and stable IDs',async()=>{
    await open(alice);await alice.getByRole('button',{name:'+ New universe',exact:true}).click();await alice.getByLabel('Universe name',{exact:true}).fill('Design Universe');await alice.getByLabel('Slug',{exact:true}).fill('design-universe');await alice.getByLabel('Description',{exact:true}).fill('Local design community');await alice.getByLabel('Public universe',{exact:true}).uncheck();await alice.getByRole('button',{name:'Create universe',exact:true}).click();await alice.getByRole('heading',{name:'Design Universe',exact:true}).waitFor();
    universeId=(await call(alice,'/api/universes')).universes.find(u=>u.name==='Design Universe').id;
    await alice.getByRole('button',{name:'+ New world',exact:true}).click();await alice.getByLabel('World name',{exact:true}).fill('Design World');await alice.getByLabel('Slug',{exact:true}).fill('design-world');await alice.getByRole('button',{name:'Create world',exact:true}).click();await alice.getByRole('heading',{name:'Design World',exact:true}).waitFor();
    worldId=(await call(alice,'/api/universes')).universes.find(u=>u.id===universeId).worlds[0].id;
    await alice.getByRole('button',{name:'+ New room',exact:true}).click();await alice.getByLabel('Room name',{exact:true}).fill('Design Room');await alice.getByLabel('Slug',{exact:true}).fill('design-room');await alice.getByRole('button',{name:'Create room',exact:true}).click();await alice.getByRole('heading',{name:'Design Room',exact:true}).waitFor();
    roomId=(await call(alice,'/api/universes')).universes.find(u=>u.id===universeId).worlds[0].rooms[0].id;
    assert(roomId&&worldId&&universeId);assert.equal((await call(alice,`/api/rooms/${roomId}`)).room.worldId,worldId);
  });
  await check('typing never leaks movement keys and dirty metadata survives catalog refresh',async()=>{
    await alice.getByRole('button',{name:'Edit details',exact:true}).click();await alice.getByLabel('Room name',{exact:true}).fill('Design draft');await alice.getByLabel('Description',{exact:true}).click();await alice.keyboard.type('wasd');assert.deepEqual(await alice.evaluate(()=>window.gameKeys),[]);
    await alice.evaluate(()=>window.places.refresh());assert.equal(await alice.getByLabel('Room name',{exact:true}).inputValue(),'Design draft');await alice.keyboard.press('Escape');assert.equal(await alice.locator('#root').isHidden(),true);await open(alice);assert.equal(await alice.getByLabel('Room name',{exact:true}).inputValue(),'Design draft');
  });
  await check('concurrent metadata produces visible conflict and requires deliberate rebase',async()=>{
    let room=(await call(alice,`/api/rooms/${roomId}`)).room;await call(alice,`/api/rooms/${roomId}`,'PATCH',{name:'Changed elsewhere',metadataRevision:room.metadataRevision});await alice.evaluate(()=>window.places.refresh());await alice.getByText('This place changed elsewhere.',{exact:false}).waitFor();assert.equal(await alice.getByRole('button',{name:'Save details',exact:true}).isDisabled(),true);assert.equal(await alice.getByLabel('Room name',{exact:true}).inputValue(),'Design draft');
    await alice.getByRole('button',{name:'Keep my draft on latest',exact:true}).click();await alice.getByRole('button',{name:'Keep my draft',exact:true}).click();await alice.getByRole('button',{name:'Save details',exact:true}).click();await alice.getByRole('heading',{name:'Design draft',exact:true}).waitFor();assert.equal((await call(alice,`/api/rooms/${roomId}`)).room.name,'Design draft');
  });
  await check('private ancestor stays hidden before targeted invitation; acceptance grants exact scoped access',async()=>{
    assert(!(await call(bob,'/api/universes')).universes.some(u=>u.id===universeId));
    assert.equal(await bob.evaluate(async id=>{try{await window.api('/api/rooms/'+id);return 200}catch(e){return e.status}},roomId),404);
    await alice.getByRole('button',{name:'View world Design World',exact:true}).click();await alice.getByRole('button',{name:'Members & invitations',exact:true}).click();await alice.getByLabel('Local account',{exact:true}).fill('ari');await alice.getByRole('button',{name:'Find account',exact:true}).click();await alice.getByRole('button',{name:'Select account ari',exact:true}).click();await alice.getByLabel('World role',{exact:true}).selectOption('editor');await alice.getByLabel('World-local tags',{exact:true}).fill('design, hosts');await alice.getByRole('button',{name:'Send invitation',exact:true}).click();await alice.getByText('Invitation sent to their local account inbox.',{exact:true}).waitFor();assert(!(await call(bob,'/api/memberships')).memberships.some(m=>m.worldId===worldId));
    await open(bob,'invitations');await bob.getByRole('button',{name:'Accept invitation',exact:true}).click();await bob.getByText('Invitation accepted. Your membership is ready.',{exact:true}).waitFor();const member=(await call(bob,'/api/memberships')).memberships.find(m=>m.worldId===worldId);assert.equal(member.role,'editor');assert.deepEqual(member.tags,['design','hosts']);assert((await call(bob,'/api/universes')).universes.some(u=>u.id===universeId));assert.equal((await call(bob,`/api/rooms/${roomId}`)).room.id,roomId);
  });
  await check('world editor UI exposes room edit but neither world metadata nor member management',async()=>{
    await open(bob);await bob.getByRole('button',{name:'View world Design World',exact:true}).click();assert.equal(await bob.getByRole('button',{name:'Edit details',exact:true}).count(),0);assert.equal(await bob.getByRole('button',{name:'Members & invitations',exact:true}).count(),0);assert.equal(await bob.getByRole('button',{name:'+ New room',exact:true}).count(),0);await bob.getByRole('button',{name:'View room Design draft',exact:true}).click();assert.equal(await bob.getByRole('button',{name:'Edit details',exact:true}).count(),1);await alice.screenshot({path:new URL('./places-desktop.png',import.meta.url).pathname});
  });
  await check('archive explains active occupants, retains identity and restores without permanent delete',async()=>{
    await alice.getByRole('button',{name:'View room Design draft',exact:true}).click();await alice.getByRole('button',{name:'Archive room',exact:true}).click();await alice.getByRole('alertdialog').getByText(/disconnects current occupants/).waitFor();await alice.getByRole('alertdialog').getByRole('button',{name:'Archive room',exact:true}).click();await alice.getByRole('button',{name:'Restore room',exact:true}).waitFor();assert.equal(await alice.getByRole('button',{name:'Enter Design draft',exact:true}).count(),0);await alice.getByRole('button',{name:'Restore room',exact:true}).click();await alice.getByRole('alertdialog').getByRole('button',{name:'Restore room',exact:true}).click();await alice.getByRole('button',{name:'Enter Design draft',exact:true}).waitFor();assert.equal((await call(alice,`/api/rooms/${roomId}`)).room.id,roomId);
  });
  await check('live world-role downgrade disables metadata save without discarding the open draft',async()=>{
    await bob.getByRole('button',{name:'Edit details',exact:true}).click();await bob.getByLabel('Description',{exact:true}).fill('Keep this unsaved local draft');
    await alice.getByRole('button',{name:'View world Design World',exact:true}).click();await alice.getByRole('button',{name:'Members & invitations',exact:true}).click();await alice.getByRole('button',{name:'Edit world membership for Ari',exact:true}).click();const form=alice.getByRole('form',{name:'Edit membership for Ari',exact:true});await form.getByLabel('World role',{exact:true}).selectOption('member');await form.getByLabel('World-local tags',{exact:true}).fill('reviewers');await form.getByRole('button',{name:'Save membership',exact:true}).click();await alice.getByRole('alertdialog').getByRole('button',{name:'Save membership',exact:true}).click();
    await bob.getByText('Your editing access changed.',{exact:false}).waitFor();assert.equal(await bob.getByRole('button',{name:'Save details',exact:true}).isDisabled(),true);assert.equal(await bob.getByLabel('Description',{exact:true}).inputValue(),'Keep this unsaved local draft');const member=(await call(bob,'/api/memberships')).memberships.find(m=>m.worldId===worldId);assert.equal(member.role,'member');assert.deepEqual(member.tags,['reviewers']);await bob.getByRole('button',{name:'View details, keep draft',exact:true}).click();
  });
  await check('leave updates exact world membership and explains access effects',async()=>{
    await open(bob,'memberships');await bob.getByRole('button',{name:'Leave world',exact:true}).click();await bob.getByRole('alertdialog').getByText(/Editing permissions end immediately/).waitFor();await bob.getByRole('alertdialog').getByRole('button',{name:'Leave world',exact:true}).click();await bob.getByText('You left the world membership.',{exact:true}).waitFor();assert(!(await call(bob,'/api/memberships')).memberships.some(m=>m.worldId===worldId));
  });
  await check('direct add and remove confirmations mutate only the selected world',async()=>{
    await alice.getByLabel('Local account',{exact:true}).fill('ari');await alice.getByRole('button',{name:'Find account',exact:true}).click();await alice.getByRole('button',{name:'Select account ari',exact:true}).click();await alice.getByLabel('World-local tags',{exact:true}).fill('hosts');await alice.getByRole('button',{name:'Add member now',exact:true}).click();await alice.getByRole('alertdialog').getByRole('button',{name:'Add member',exact:true}).click();const target=(await call(bob,'/api/session')).user.id;assert.deepEqual((await call(bob,'/api/memberships')).memberships.find(m=>m.worldId===worldId).tags,['hosts']);
    await call(alice,`/api/worlds/w1/members/${target}`,'PUT',{role:'member',tags:['elsewhere']});await alice.getByRole('button',{name:'Remove world membership for Ari',exact:true}).click();await alice.getByRole('alertdialog').getByRole('button',{name:'Remove membership',exact:true}).click();await alice.getByText('World membership removed.',{exact:true}).waitFor();const memberships=(await call(bob,'/api/memberships')).memberships;assert(!memberships.some(m=>m.worldId===worldId));assert.deepEqual(memberships.find(m=>m.worldId==='w1').tags,['elsewhere']);await call(alice,`/api/worlds/w1/members/${target}`,'DELETE',{});
  });
  let legacyTarget,siblingId,otherWorldId,otherRoomId;
  const seedLegacy=room=>app.store.run('INSERT INTO members(room_id,user_id,role,granted,needs_review) VALUES(?,?,?,?,?) ON CONFLICT(room_id,user_id) DO UPDATE SET role=excluded.role,granted=1,needs_review=1',room,legacyTarget,'editor',1,1);
  const status=async(page,path,method='GET',body)=>page.evaluate(async args=>{const response=await fetch(args.path,{method:args.method,headers:{'Content-Type':'application/json'},body:args.body===undefined?undefined:JSON.stringify(args.body)});return response.status;},{path,method,body});
  const assertInactiveLegacy=async()=>{
    assert(!(await call(bob,'/api/memberships')).memberships.some(m=>m.worldId===worldId));
    assert.equal((await call(alice,`/api/worlds/${worldId}/legacy-grants`)).grants.length,1);
    assert.equal(app.store.membership(roomId,legacyTarget).needs_review,1);
    for(const id of [roomId,siblingId,otherRoomId]){
      assert.equal(await status(bob,`/api/rooms/${id}`),404);
      assert.equal(await status(bob,`/api/rooms/${id}/files`),404);
      assert.equal(await status(bob,`/api/rooms/${id}/join`,'POST',{}),404);
    }
    for(const suffix of ['', '/members', '/legacy-grants', '/invitations'])assert.equal(await status(bob,`/api/worlds/${worldId}${suffix}`),404);
    assert(!(await call(bob,'/api/universes')).universes.some(u=>u.id===universeId));
  };
  await check('nonempty private-world legacy review renders current members and invitations without granting access',async()=>{
    legacyTarget=(await call(bob,'/api/session')).user.id;
    await call(alice,`/api/worlds/${worldId}`,'PATCH',{public:false});
    await call(alice,`/api/rooms/${roomId}`,'PATCH',{public:false});
    siblingId=(await call(alice,'/api/rooms','POST',{worldId,name:'Private sibling',public:false})).room.id;
    otherWorldId=(await call(alice,'/api/worlds','POST',{universeId,name:'Other private world',public:false})).world.id;
    otherRoomId=(await call(alice,'/api/rooms','POST',{worldId:otherWorldId,name:'Other private room',public:false})).room.id;
    // Synthetic post-migration records; hierarchy-migration.test.mjs verifies the migration itself.
    seedLegacy(roomId);seedLegacy(otherRoomId);
    await alice.evaluate(()=>window.places.refresh());
    assert.equal(await alice.getByText('child is not defined',{exact:true}).count(),0);
    await alice.getByRole('heading',{name:'Previous room grants need review',exact:true}).waitFor();
    await alice.getByText('Protected owner',{exact:true}).waitFor();
    await alice.getByText('World: admin',{exact:true}).waitFor();
    await alice.getByRole('heading',{name:'World invitations',exact:true}).waitFor();
    assert.equal(await alice.getByLabel('Local account',{exact:true}).isVisible(),true);
    assert.equal(await alice.getByRole('button',{name:'Find account',exact:true}).isEnabled(),true);
    await assertInactiveLegacy();
    await alice.getByRole('button',{name:'Review previous access for Ari in Design draft',exact:true}).click();
    assert.equal(await alice.getByLabel('World role',{exact:true}).inputValue(),'member');
    assert.equal(await alice.getByRole('button',{name:'Send invitation',exact:true}).isEnabled(),true);
    await assertInactiveLegacy();
    await alice.getByRole('button',{name:'Add member now',exact:true}).click();
    await alice.getByRole('alertdialog').getByText(/including access to all its private rooms/).waitFor();
    await alice.getByRole('alertdialog').getByRole('button',{name:'Cancel',exact:true}).click();
    await alice.getByRole('button',{name:'Close places',exact:true}).click();
    await alice.getByRole('button',{name:'Open places',exact:true}).click();
    await alice.getByRole('heading',{name:'Previous room grants need review',exact:true}).waitFor();
    await assertInactiveLegacy();
  });
  await check('explicit legacy approval clears only its world queue and retains manager and child-room authority',async()=>{
    await alice.getByRole('button',{name:'Add member now',exact:true}).click();
    await alice.getByRole('alertdialog').getByRole('button',{name:'Add member',exact:true}).click();
    await alice.getByText('World member added.',{exact:true}).waitFor();
    assert.equal((await call(alice,`/api/worlds/${worldId}/legacy-grants`)).grants.length,0);
    assert.equal(await alice.getByRole('heading',{name:'Previous room grants need review',exact:true}).count(),0);
    assert.equal((await call(bob,'/api/memberships')).memberships.find(m=>m.worldId===worldId).role,'member');
    assert.equal(app.store.membership(roomId,legacyTarget).needs_review,0);
    assert.equal((await call(bob,`/api/rooms/${roomId}`)).room.role,'editor');
    assert.equal((await call(bob,`/api/rooms/${siblingId}`)).room.role,'member');
    for(const suffix of ['/members','/legacy-grants','/invitations'])assert.equal(await status(bob,`/api/worlds/${worldId}${suffix}`),403);
    assert.equal(await status(bob,`/api/worlds/${worldId}/members/${legacyTarget}`,'PUT',{role:'admin'}),403);
    assert.equal(await status(bob,`/api/rooms/${siblingId}`,'PATCH',{name:'No permission expansion'}),403);
    assert.equal(await status(bob,`/api/rooms/${otherRoomId}`),404);
    assert.equal(app.store.membership(otherRoomId,legacyTarget).needs_review,1);
    assert.equal((await call(alice,`/api/worlds/${otherWorldId}/legacy-grants`)).grants.length,1);
    await call(alice,`/api/worlds/${worldId}/members/${legacyTarget}`,'DELETE',{});
  });
  await check('review invitation leaves legacy access inactive until acceptance and then clears the owner queue',async()=>{
    seedLegacy(roomId);
    await alice.evaluate(()=>window.places.refresh());
    await alice.getByRole('button',{name:'Review previous access for Ari in Design draft',exact:true}).click();
    await alice.getByRole('button',{name:'Send invitation',exact:true}).click();
    await alice.getByText('Invitation sent to their local account inbox.',{exact:true}).waitFor();
    await alice.getByRole('heading',{name:'Previous room grants need review',exact:true}).waitFor();
    await assertInactiveLegacy();
    const invitation=(await call(alice,`/api/worlds/${worldId}/invitations`)).invitations.find(i=>i.status==='pending');
    assert.equal(invitation.role,'member');
    await open(bob,'invitations');
    await bob.locator(`[data-invitation-id="${invitation.id}"]`).getByRole('button',{name:'Accept invitation',exact:true}).click();
    await bob.getByText('Invitation accepted. Your membership is ready.',{exact:true}).waitFor();
    await alice.getByRole('heading',{name:'Previous room grants need review',exact:true}).waitFor({state:'detached'});
    await alice.getByRole('button',{name:'Edit world membership for Ari',exact:true}).waitFor();
    assert.equal((await call(alice,`/api/worlds/${worldId}/legacy-grants`)).grants.length,0);
    assert.equal((await call(bob,`/api/rooms/${siblingId}`)).room.role,'member');
    assert.equal(app.store.membership(otherRoomId,legacyTarget).needs_review,1);
    assert.equal(await status(bob,`/api/rooms/${otherRoomId}`),404);
    await call(alice,`/api/worlds/${worldId}/members/${legacyTarget}`,'DELETE',{});
  });
  await check('decline, manager cancellation and expiry render one terminal outcome without membership',async()=>{
    const target=(await call(bob,'/api/session')).user.id;
    let invite=(await call(alice,`/api/worlds/${worldId}/invitations`,'POST',{userId:target,role:'member',tags:['newcomer']})).invitation;
    await open(bob,'invitations');await bob.locator(`[data-invitation-id="${invite.id}"]`).getByRole('button',{name:'Decline invitation',exact:true}).click();await bob.locator(`[data-invitation-id="${invite.id}"]`).getByText('rejected',{exact:true}).waitFor();
    invite=(await call(alice,`/api/worlds/${worldId}/invitations`,'POST',{userId:target,role:'member',tags:[]})).invitation;
    await open(alice);await alice.getByRole('button',{name:'View world Design World',exact:true}).click();await alice.getByRole('button',{name:'Members & invitations',exact:true}).click();const row=alice.locator(`[data-invitation-id="${invite.id}"]`);await row.getByRole('button',{name:'Cancel invitation',exact:true}).click();await alice.getByRole('alertdialog').getByRole('button',{name:'Cancel invitation',exact:true}).click();await row.getByText('cancelled',{exact:true}).waitFor();
    invite=(await call(alice,`/api/worlds/${worldId}/invitations`,'POST',{userId:target,role:'member',tags:[],expiresInDays:1})).invitation;
    serverTime+=2*86400000;await bob.evaluate(()=>window.places.refresh());const expired=bob.locator(`[data-invitation-id="${invite.id}"]`);await expired.getByText('expired',{exact:true}).waitFor();assert.equal(await expired.getByRole('button').count(),0);assert(!(await call(bob,'/api/memberships')).memberships.some(m=>m.worldId===worldId));
    await alice.getByRole('button',{name:'View room Design draft',exact:true}).click();
  });
  await check('starred room list follows saved server state',async()=>{
    await alice.getByRole('button',{name:'Star Design draft',exact:true}).click();await alice.getByRole('button',{name:'Unstar Design draft',exact:true}).waitFor();await alice.getByLabel('Places view',{exact:true}).selectOption('starred');assert.equal(await alice.getByRole('button',{name:'View room Moon garden',exact:true}).count(),0);assert.equal(await alice.getByRole('button',{name:'View room Design draft',exact:true}).count(),1);assert((await call(alice,'/api/stars')).rooms.some(r=>r.id===roomId));
  });
  await check('no accessible rooms shows a usable empty directory with private names filtered out',async()=>{
    const seed=(await call(alice,'/api/universes')).universes.find(u=>u.id!==universeId);await call(alice,`/api/universes/${seed.id}`,'PATCH',{public:false,metadataRevision:seed.metadataRevision});await open(bob);await bob.evaluate(()=>window.places.refresh());await bob.getByText('No places are available. Create your first universe.',{exact:true}).waitFor();assert.equal(await bob.getByRole('button',{name:/View room|View world|View universe/}).count(),0);assert.equal(await bob.getByRole('button',{name:'+ New universe',exact:true}).isEnabled(),true);
  });
  await check('320px touch, landscape and enlarged text stay inside viewport with usable close',async()=>{
    mobileContext=await browser.newContext({viewport:{width:320,height:640},isMobile:true,hasTouch:true,storageState:await a.storageState()});const page=await mobileContext.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.waitForFunction(()=>window.ready);
    for(const viewport of [{width:320,height:640},{width:667,height:320}]){await page.setViewportSize(viewport);await page.getByRole('button',{name:'Open places',exact:true}).tap();await page.getByRole('button',{name:'Close places',exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),viewport.width);const b=await page.getByRole('button',{name:'Close places',exact:true}).boundingBox();assert(b.x>=0&&b.x+b.width<=viewport.width&&b.y>=0&&b.y+b.height<=viewport.height);await page.screenshot({path:new URL(`./places-${viewport.width===320?'mobile':'landscape'}.png`,import.meta.url).pathname});await page.getByRole('button',{name:'Close places',exact:true}).tap();}
    await page.setViewportSize({width:320,height:640});await page.getByRole('button',{name:'Open places',exact:true}).tap();await page.addStyleTag({content:'.places-shell :is(p,span,label,h2,h3,h4,button,input,select,textarea,small){font-size:200%!important}'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),320);await page.getByRole('button',{name:'Close places',exact:true}).tap();assert.equal(await page.locator('#root').isHidden(),true);
  });
  assert.deepEqual(errors,[]);console.log(`PASS ${checks.length} real-backend places browser checks`);
}catch(error){console.error(error);checks.push({name:'run failure',status:'failed',error:error.stack});await alice?.screenshot({path:join(dir,'failure.png')}).catch(()=>{});console.error('Fixture and failure evidence:',dir);process.exitCode=1;}
finally{await writeFile(new URL('./places-live-results.json',import.meta.url),JSON.stringify({checks,errors,limits:['Isolated page shell with real SQLite HTTP authority. Integrated scene/history checks run separately.','Cloud Chromium only; physical phones and Firefox/Safari not tested.']},null,2));await a?.close();await b?.close();await mobileContext?.close();await browser.close();await app.close();if(!process.exitCode)await rm(dir,{recursive:true,force:true});}
