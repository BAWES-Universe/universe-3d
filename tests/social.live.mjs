import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createGameServer } from '../server/app.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const pack = (await import(require.resolve('@sparticuz/chromium'))).default;
const dir = await mkdtemp(join(tmpdir(), 'universe-social-live-'));
const fixture = String.raw`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/social.css"><style>body{margin:0;background:#0b0911;font:14px Arial}#root{width:360px;height:800px}</style></head><body><div id="root"></div><script type="module">
import { mountSocial } from '/social.js';
const api=async(path,options={})=>{const res=await fetch(path,{method:options.method||'GET',headers:options.body?{'Content-Type':'application/json'}:{},body:options.body?JSON.stringify(options.body):undefined});const result=await res.json();if(!res.ok)throw Object.assign(new Error(result.message),{status:res.status});return result};
window.api=api;let session;try{session=await api('/api/session')}catch{session=await api('/api/session',{method:'POST',body:{name:new URL(location.href).searchParams.get('name')||'Mira',woka:0}})}
const joined=await api('/api/rooms/r1/join',{method:'POST',body:{}});
const state=window.state={...session,room:joined.room,people:joined.presence};
const social=window.social=mountSocial({root:document.querySelector('#root'),api,getState:()=>state,onNavigate:async id=>{const result=await api('/api/rooms/'+id+'/join',{method:'POST',body:{}});state.room=result.room;state.people=result.presence;social.render()},toast:message=>{window.lastToast=message}});
const events=window.events=new EventSource('/api/events');
for(const type of ['message','dm','presence','members','room','moderation','role'])events.addEventListener(type,event=>{const data=JSON.parse(event.data);if(type==='presence'&&data.roomId===state.room.id)state.people=data.presence;if(type==='members')for(const person of state.people){const member=data.members.find(item=>item.id===person.id);if(member)Object.assign(person,member)}if(type==='role')state.room.role=data.role;social.onEvent({type,data})});
window.ready=true;
</script></body></html>`;
const scriptStart = fixture.indexOf('<script type="module">');
const scriptEnd = fixture.indexOf('</script>', scriptStart);
await writeFile(join(dir, 'fixture.js'), fixture.slice(scriptStart + '<script type="module">'.length, scriptEnd));
await writeFile(join(dir, 'index.html'), fixture.slice(0, scriptStart) + '<script type="module" src="/fixture.js"></script>' + fixture.slice(scriptEnd + '</script>'.length));
for (const file of ['signup-navigation.js', 'travel-location.js', 'arrivals.js', 'worlds.js', 'media-policy-copy.js', 'image-asset-schema.js', 'image-asset-context.js', 'image-asset-geometry.js', 'terrain.js', 'password-policy.js', 'social.js', 'social.css', 'permissions.js', 'proximity-text.js', 'proximity-typing.js', 'social-sheet-layout.js', 'universe-icons.js']) await writeFile(join(dir,file),await readFile(new URL(`../src/${file}`,import.meta.url)));
try { await cp(new URL('../public/assets',import.meta.url),join(dir,'assets'),{recursive:true}); } catch {}
const scene={version:1,theme:'garden',bounds:{width:32,depth:26},spawn:{x:0,z:0},objects:[],areas:[]};
const app=createGameServer({database:':memory:',seeds:[{id:'w1',name:'Test universe',rooms:[{id:'r1',name:'Moon garden',scene},{id:'r2',name:'Quiet room',scene}]}],dist:dir});
const address=await app.listen(0);
const browser=await chromium.launch({executablePath:await pack.executablePath(),headless:true,args:['--no-sandbox','--no-zygote','--single-process','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const browser2=await chromium.launch({executablePath:await pack.executablePath(),headless:true,args:['--no-sandbox','--no-zygote','--single-process','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const errors=[];let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS',name)}
try {
  const a=await browser.newContext({viewport:{width:900,height:850}}), b=await browser2.newContext({viewport:{width:900,height:850}});
  const alice=await a.newPage(), bob=await b.newPage();
  for(const page of [alice,bob])page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message)});
  const base=`http://127.0.0.1:${address.port}`;
  await alice.goto(base+'/?name=Mira');await alice.waitForFunction(()=>window.ready);
  await bob.goto(base+'/?name=Ari');await bob.waitForFunction(()=>window.ready);
  await check('live SSE room send is persisted and reaches the second session',async()=>{
    await alice.getByRole('textbox',{name:'Message the room'}).fill('The garden is open');
    await alice.getByRole('button',{name:'Send message',exact:true}).click();
    await bob.getByText('The garden is open',{exact:true}).waitFor();
    assert.equal(await bob.evaluate(async()=> (await window.api('/api/rooms/r1/messages')).messages.at(-1).text),'The garden is open');
  });
  await check('live own edit and another user reaction synchronize',async()=>{
    await alice.locator('.social-message-options summary').click();
    await alice.getByRole('button',{name:'Edit your message'}).click();
    await alice.getByRole('textbox',{name:'Message the room'}).fill('Meet me in the garden');
    await alice.getByRole('button',{name:'Save edited message'}).click();
    await bob.getByText('Meet me in the garden',{exact:true}).waitFor();
    await bob.locator('.social-message-options summary').click();
    await alice.locator('.social-message-options summary').click();
    await bob.getByRole('button',{name:'Add ❤️ reaction',exact:true}).click();
    await alice.getByRole('button',{name:'Add ❤️ reaction (1)',exact:true}).waitFor();
  });
  await check('server denies unauthorized edit and the member UI hides that action',async()=>{
    assert.equal(await bob.getByRole('button',{name:'Edit your message'}).count(),0);
    assert.equal(await bob.evaluate(async()=>{const message=(await window.api('/api/rooms/r1/messages')).messages[0];try{await window.api('/api/messages/'+message.id,{method:'PATCH',body:{text:'not allowed'}});return 200}catch(e){return e.status}}),403);
  });
  await check('live DM reaches only the two participants and reload restores history',async()=>{
    const peerId=await bob.evaluate(()=>window.state.user.id);
    await alice.evaluate(id=>window.social.openDm(window.state.people.find(p=>p.id===id)),peerId);
    await alice.getByRole('textbox',{name:'Message Ari',exact:true}).fill('A note for you');
    await alice.getByRole('button',{name:'Send message',exact:true}).click();
    const aliceId=await alice.evaluate(()=>window.state.user.id);
    await bob.evaluate(id=>window.social.openDm(window.state.people.find(p=>p.id===id)),aliceId);
    await bob.getByText('A note for you',{exact:true}).waitFor();
    await bob.reload();await bob.waitForFunction(()=>window.ready);
    await bob.getByRole('button',{name:'Open direct messages'}).click();
    await bob.getByRole('button',{name:'Open messages with Mira'}).click();
    await bob.getByText('A note for you',{exact:true}).waitFor();
  });
  await check('profile and Woka changes persist in authenticated session',async()=>{
    await alice.getByRole('tab',{name:'Profile',exact:true}).click();
    await alice.getByRole('textbox',{name:'Display name'}).fill('Mira Moon');
    await alice.getByRole('button',{name:'Choose Woka 3',exact:true}).click();
    await alice.getByRole('button',{name:'Save profile'}).click();
    await alice.getByText('Profile saved. Everyone in the room sees your updated character.').waitFor();
    assert.deepEqual(await alice.evaluate(async()=>{const{user}=await window.api('/api/session');return[user.name,user.woka]}),['Mira Moon',2]);
  });
  await check('targeted world invitation admits only its registered recipient to the private room',async()=>{
    await alice.getByRole('tab',{name:'Explore',exact:true}).click();
    await alice.getByRole('button',{name:'+ Room',exact:true}).click();
    await alice.getByRole('textbox',{name:'Room name'}).fill('Secret garden');
    await alice.getByRole('combobox',{name:'Visibility',exact:true}).selectOption('private');
    await alice.getByRole('button',{name:'Create room',exact:true}).click();
    await alice.getByRole('button',{name:'Secret garden, current room'}).waitFor();
    const privateId=await alice.evaluate(()=>window.state.room.id);
    assert.equal(await bob.evaluate(async id=>{try{await window.api('/api/rooms/'+id+'/join',{method:'POST',body:{}});return 200}catch(e){return e.status}},privateId),404);
    await bob.evaluate(async()=>window.api('/api/account',{method:'POST',body:{username:'ari_invited',password:'local-test-password-only'}}));
    const bobId=await bob.evaluate(()=>window.state.user.id);
    const invitation=await alice.evaluate(async userId=>window.api('/api/worlds/w1/invitations',{method:'POST',body:{userId,role:'member',tags:['invited'],clientOperationId:crypto.randomUUID()}}),bobId);
    await bob.evaluate(async id=>window.api('/api/invitations/'+id+'/accept',{method:'POST',body:{}}),invitation.invitation.id);
    assert.equal(await bob.evaluate(async id=>(await window.api('/api/rooms/'+id+'/join',{method:'POST',body:{}})).room.name,privateId),'Secret garden');
  });
  await check('moderator mute denies room sending on the server and shows the failure',async()=>{
    const bobId=await bob.evaluate(()=>window.state.user.id);
    const privateId=await alice.evaluate(()=>window.state.room.id);
    await alice.evaluate(async id=>window.api('/api/rooms/'+window.state.room.id+'/moderate',{method:'POST',body:{userId:id,action:'mute',minutes:10}}),bobId);
    await bob.evaluate(async id=>{const result=await window.api('/api/rooms/'+id);window.state.room=result.room;window.state.people=result.presence;window.social.setTab('chat');window.social.render()},privateId);
    // Reset the DM view by using the room control if a DM is still selected.
    const roomBack=bob.getByRole('button',{name:'Open room chat',exact:true});if(await roomBack.count())await roomBack.click();
    await bob.getByRole('textbox',{name:'Message the room'}).fill('Muted message draft');
    await bob.getByRole('button',{name:'Send message',exact:true}).click();
    await bob.getByRole('alert').getByText('You are temporarily muted in this room',{exact:true}).waitFor();
    assert.equal(await bob.getByRole('textbox',{name:'Message the room'}).inputValue(),'Muted message draft');
  });
  await alice.screenshot({path:join(tmpdir(),'universe-social-live.png')});
  assert.deepEqual(errors,[]);
  console.log(`${passed} live-backend social checks passed; no JavaScript errors.`);
}finally{await browser.close();await browser2.close();await app.close();await rm(dir,{recursive:true,force:true});}
