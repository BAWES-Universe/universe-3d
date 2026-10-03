import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const chromiumPack = (await import(require.resolve('@sparticuz/chromium'))).default;

const fixture = String.raw`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/social.css"><style>body{margin:0;background:#0b0911;font:14px Arial}#root{width:360px;height:800px}</style></head><body><div id="root"></div><script type="module">
import { mountSocial } from '/social.js';
const self={id:'me',name:'Mira',woka:0,status:'online'};
const peer={id:'ari',name:'Ari <b>unsafe</b>',woka:1,status:'away',role:'member'};
window.state={user:self,room:{id:'r1',worldId:'w1',name:'Moon garden',role:'owner',ownerId:'me'},people:[self,peer],worlds:[{id:'w1',name:'Little universe',ownerId:'me',public:true,rooms:[{id:'r1',name:'Moon garden',public:true,role:'owner'},{id:'r2',name:'Quiet room',public:true,role:'owner'}]}]};
window.calls=[]; window.toasts=[];window.gameKeys=0;window.seq=3;
window.messages={r1:[{id:'m1',roomId:'r1',userId:'ari',author:peer,text:'Hello <img src=x onerror=alert(1)>',createdAt:1000,reactions:{}},{id:'m2',roomId:'r1',userId:'me',author:self,text:'Welcome aboard',createdAt:2000,reactions:{}}],r2:[]};
window.dms=[];window.pendingSends=[];window.holdSends=false;window.rejectNext=false;window.profileEvents=0;
window.addEventListener('keydown',()=>window.gameKeys++);window.addEventListener('profile-updated',()=>window.profileEvents++);
window.api=async(path,options={})=>{
 const method=options.method||'GET';const body=options.body||{};window.calls.push({path,method,body});
 if(window.rejectNext){window.rejectNext=false;throw new Error('Connection interrupted. Try again.')}
 if(path==='/api/worlds'&&method==='GET')return {worlds:structuredClone(window.state.worlds)};
 if(path==='/api/worlds'&&method==='POST'){const world={...body,id:'newworld',ownerId:'me',rooms:[]};window.state.worlds.push(world);return {world}}
 if(path==='/api/rooms'&&method==='POST'){const room={...body,id:'newroom',role:'owner'};window.state.worlds.find(w=>w.id===body.worldId).rooms.push(room);return {room}}
 if(path==='/api/me'){Object.assign(window.state.user,body);return {user:structuredClone(window.state.user)}}
 if(path==='/api/conversations')return {conversations:window.dms.length?[{user:peer,userId:'ari',lastMessage:window.dms.at(-1)}]:[]};
 if(path.includes('/invites'))return {url:'/?invite=test-invite',expiresAt:Date.now()+604800000};
 if(path.includes('/moderate')||path.includes('/members/')||path.includes('/emote'))return {ok:true};
 const dm=path.match(/^\/api\/dm\/([^/]+)\/messages/);
 if(dm){if(method==='GET')return {messages:structuredClone(window.dms)};const message={id:'dm'+window.seq++,userId:'me',recipientId:dm[1],author:self,text:body.text,createdAt:Date.now()};window.dms.push(message);return {message}}
 const room=path.match(/^\/api\/rooms\/([^/]+)\/messages/);
 if(room){const list=window.messages[room[1]]||=[];if(method==='GET')return {messages:structuredClone(list)};if(window.holdSends)await new Promise(resolve=>window.pendingSends.push(resolve));const message={id:'m'+window.seq++,roomId:room[1],userId:'me',author:self,text:body.text,createdAt:Date.now(),reactions:{}};list.push(message);return {message}}
 const msg=path.match(/^\/api\/messages\/([^/]+)(\/reactions)?$/);
 if(msg){const message=Object.values(window.messages).flat().find(m=>m.id===msg[1]);if(msg[2]){const ids=message.reactions[body.emoji]||=[];message.reactions[body.emoji]=ids.includes('me')?ids.filter(id=>id!=='me'):[...ids,'me']}else if(method==='PATCH'){message.text=body.text;message.editedAt=Date.now()}else if(method==='DELETE'){message.deleted=true;message.text=''}return {message:structuredClone(message)}}
 throw new Error('Unsupported fixture endpoint: '+path)
};
window.social=mountSocial({root:document.querySelector('#root'),api:window.api,getState:()=>window.state,onNavigate:async id=>{const room=window.state.worlds.flatMap(w=>w.rooms).find(r=>r.id===id);window.state.room={...room,worldId:'w1',ownerId:'me'};window.social.render()},toast:(...args)=>window.toasts.push(args)});
</script></body></html>`;
const server = http.createServer(async (req, res) => {
  if (req.url === '/social.js' || req.url === '/social.css' || req.url === '/permissions.js' || req.url === '/proximity-text.js' || req.url === '/proximity-typing.js') {
    res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript');
    res.end(await readFile(new URL(`../src${req.url}`, import.meta.url)));
  } else if (req.url.startsWith('/assets/')) { res.statusCode = 204; res.end(); }
  else { res.setHeader('Content-Type', 'text/html'); res.end(fixture); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || await chromiumPack.executablePath(), headless: true, args: ['--no-sandbox', '--no-zygote', '--single-process', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 900, height: 860 } });
const errors = [];
page.on('pageerror', error => { errors.push(error.message); console.error('PAGE ERROR', error.message); });
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
async function checkCoveredChat(kind) {
  const before = await page.locator('#root textarea').evaluate(node => {
    node.setSelectionRange(2, 7, 'backward');
    window.coveredComposer = node;
    window.coveredTimeline = document.querySelector('.social-timeline');
    return { draft: node.value, history: [...coveredTimeline.querySelectorAll('[data-message-id]')].map(row => row.dataset.messageId) };
  });
  await page.evaluate(kind => {
    const root = document.querySelector('#root');
    root.inert = true;
    const message = { id: `covered-${kind}`, roomId: state.room.id, userId: 'ari', author: state.people[1], text: `Arrived under content (${kind})`, createdAt: Date.now(), reactions: {}, ...(kind === 'dm' ? {recipientId: 'me'} : {}) };
    social.onEvent({type: kind === 'dm' ? 'dm' : 'message', data: {message}});
    social.onEvent({type: kind === 'dm' ? 'dm' : 'message', data: {message}});
    social.render();
    social.setTab('chat');
  }, kind);
  assert.equal(await page.locator('#root').evaluate(node => node.hidden), false);
  assert.equal(await page.locator('#social-tab-chat .social-unread').textContent(), '1');
  assert.deepEqual(await page.locator('#root textarea').evaluate(node => ({same: node === coveredComposer, draft: node.value, selection: [node.selectionStart, node.selectionEnd, node.selectionDirection]})), {same: true, draft: before.draft, selection: [2, 7, 'backward']});
  assert.equal(await page.locator('.social-timeline').evaluate(node => node === coveredTimeline), true);
  const history = await page.locator('[data-message-id]').evaluateAll(rows => rows.map(row => row.dataset.messageId));
  assert.deepEqual(history.filter(id => id !== `covered-${kind}`), before.history);
  assert.equal(history.filter(id => id === `covered-${kind}`).length, 1);
  await page.evaluate(() => { document.querySelector('#root').inert = false; social.render(); });
  assert.equal(await page.locator('#social-tab-chat .social-unread').textContent(), '1');
  await page.evaluate(() => social.setTab('chat'));
  assert.equal(await page.locator('#social-tab-chat .social-unread').count(), 0);
  assert.equal(await page.locator('#root textarea').evaluate(node => node === coveredComposer), true);
}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText('Welcome aboard', { exact: true }).waitFor();
  await check('chat renders hostile text literally and no null text', async () => {
    assert.equal(await page.locator('.social-message-text img').count(), 0);
    assert.equal(await page.locator('.social-message-text').first().textContent(), 'Hello <img src=x onerror=alert(1)>');
    assert.equal(await page.getByRole('tab', { name: 'Chat', exact: true }).count(), 1);
  });
  await check('form keyboard events never steer the game', async () => {
    await page.getByRole('textbox', { name: 'Message the room' }).fill('Typing safely');
    await page.getByRole('textbox', { name: 'Message the room' }).press('ArrowLeft');
    assert.equal(await page.evaluate(() => window.gameKeys), 0);
  });
  await check('duplicate send is gated and a newer draft survives an in-flight send', async () => {
    await page.evaluate(() => { window.holdSends = true; });
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message the room' }).fill('A newer draft');
    await page.getByRole('textbox', { name: 'Message the room' }).press('Enter');
    assert.equal(await page.evaluate(() => window.calls.filter(c => c.path === '/api/rooms/r1/messages' && c.method === 'POST').length), 1);
    await page.evaluate(() => { window.holdSends = false; window.pendingSends.shift()(); });
    await page.getByText('Typing safely', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Message the room' }).inputValue(), 'A newer draft');
  });
  await check('room navigation keeps drafts separate and restores them', async () => {
    await page.evaluate(() => { window.state.room = { id: 'r2', worldId: 'w1', name: 'Quiet room', role: 'owner', ownerId: 'me' }; window.social.render(); });
    assert.equal(await page.getByRole('textbox', { name: 'Message the room' }).inputValue(), '');
    await page.getByRole('textbox', { name: 'Message the room' }).fill('Quiet-room draft');
    await page.evaluate(() => { window.state.room = { id: 'r1', worldId: 'w1', name: 'Moon garden', role: 'owner', ownerId: 'me' }; window.social.render(); });
    assert.equal(await page.getByRole('textbox', { name: 'Message the room' }).inputValue(), 'A newer draft');
  });
  await check('inert Room chat counts new messages once and retains mounted draft, selection and history', () => checkCoveredChat('room'));
  await check('own message editing preserves the separate unsent draft', async () => {
    await page.locator('[data-message-id="m2"]').getByRole('button', { name: 'Edit your message' }).click();
    await page.getByRole('textbox', { name: 'Message the room' }).fill('Welcome, everyone');
    await page.getByRole('button', { name: 'Save edited message' }).click();
    await page.getByText('Welcome, everyone', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Message the room' }).inputValue(), 'A newer draft');
  });
  await check('server-confirmed reaction toggles and own deletion works', async () => {
    await page.locator('[data-message-id="m2"]').getByRole('button', { name: 'Add 👍 reaction', exact: true }).click();
    assert.equal(await page.locator('[data-message-id="m2"]').getByRole('button', { name: 'Remove 👍 reaction (1)', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.locator('[data-message-id="m2"]').getByRole('button', { name: 'Delete your message' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await page.locator('[data-message-id="m2"]').getByText('Message deleted').waitFor();
  });
  await check('failed send keeps draft and exposes a retryable error', async () => {
    await page.evaluate(() => window.rejectNext = true);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Message the room' }).inputValue(), 'A newer draft');
  });
  await check('emotes use the actual room API', async () => {
    await page.getByRole('button', { name: 'Show 👋 emote' }).click();
    assert(await page.evaluate(() => window.calls.some(c => c.path === '/api/rooms/r1/emote' && c.body.emoji === '👋')));
  });
  await check('people preserve search input during presence updates', async () => {
    await page.getByRole('tab', { name: 'People', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search people' }).fill('Ari');
    await page.evaluate(() => { window.state.people[1].x = 10; window.social.render(); });
    assert.equal(await page.getByRole('searchbox', { name: 'Search people' }).inputValue(), 'Ari');
    assert.equal(await page.locator('.social-person').count(), 1);
  });
  await check('DM sends and history show no unsupported mutation actions', async () => {
    await page.getByRole('button', { name: 'Message Ari <b>unsafe</b>', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message Ari <b>unsafe</b>', exact: true }).fill('Hello privately');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Hello privately', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Edit your message' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: /reaction/ }).count(), 0);
  });
  await check('inert Direct chat counts new messages once and retains mounted draft, selection and history', async () => {
    await page.getByRole('textbox', { name: 'Message Ari <b>unsafe</b>', exact: true }).fill('A private draft');
    await checkCoveredChat('dm');
  });
  await check('DM SSE updates the conversation list immediately', async () => {
    await page.getByRole('button', { name: 'Open direct messages' }).click();
    await page.getByText('Hello privately', { exact: true }).waitFor();
    await page.evaluate(() => window.social.onEvent({ type: 'dm', data: { message: { id: 'dm-in', userId: 'ari', recipientId: 'me', author: window.state.people[1], text: 'See you by the pond', createdAt: Date.now() } } }));
    await page.getByText('See you by the pond', { exact: true }).waitFor();
  });
  await check('moderation is hidden for members and protected owners', async () => {
    await page.evaluate(() => { window.state.room.role = 'member'; window.social.setTab('people'); });
    assert.equal(await page.getByRole('button', { name: /Manage Ari/ }).count(), 0);
    await page.evaluate(() => { window.state.room.role = 'owner'; window.social.render(); });
    await page.getByRole('button', { name: /Manage Ari/ }).click();
    await page.evaluate(() => { window.state.people[1].x = 20; window.social.render(); });
    assert.equal(await page.getByRole('button', { name: 'Mute for 10 min', exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
  });
  await check('profile saves and notifies the renderer without draft reset', async () => {
    await page.getByRole('tab', { name: 'Profile', exact: true }).click();
    await page.getByRole('textbox', { name: 'Display name' }).fill('New Mira');
    await page.evaluate(() => window.social.render());
    assert.equal(await page.getByRole('textbox', { name: 'Display name' }).inputValue(), 'New Mira');
    await page.getByRole('button', { name: 'Choose Woka 4', exact: true }).click();
    await page.getByRole('combobox', { name: 'Availability', exact: true }).selectOption('busy');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await page.getByText('Profile saved. Everyone in the room sees your updated character.').waitFor();
    assert.deepEqual(await page.evaluate(() => [window.state.user.name, window.state.user.woka, window.state.user.status, window.profileEvents]), ['New Mira', 3, 'busy', 1]);
  });
  await check('explore create world, create room, and enter persist through APIs', async () => {
    await page.getByRole('tab', { name: 'Explore', exact: true }).click();
    await page.getByRole('button', { name: '+ World', exact: true }).click();
    await page.getByRole('textbox', { name: 'World name' }).fill('A new world');
    await page.getByRole('button', { name: 'Create world', exact: true }).click();
    await page.getByRole('heading', { name: 'A new world', exact: true }).waitFor();
    await page.getByRole('button', { name: '+ Room', exact: true }).click();
    await page.getByRole('textbox', { name: 'Room name' }).fill('A new room');
    await page.getByRole('combobox', { name: 'Choose world', exact: true }).selectOption('newworld');
    await page.getByRole('button', { name: 'Create room', exact: true }).click();
    await page.getByRole('button', { name: 'A new room, current room' }).waitFor();
    assert.equal(await page.evaluate(() => window.state.room.id), 'newroom');
  });
  await check('owner room invite shows the actual backend link', async () => {
    await page.getByRole('button', { name: 'Create an invite to this room' }).click();
    assert.match(await page.getByRole('textbox', { name: 'Invite link for A new room' }).inputValue(), /\?invite=test-invite$/);
  });
  await check('mobile panel stays inside viewport and closes/reopens cleanly', async () => {
    await page.setViewportSize({ width: 390, height: 720 });
    await page.evaluate(() => window.social.setTab('chat'));
    const rect = await page.locator('#root').boundingBox();
    assert(rect.height <= 640 && rect.width <= 390);
    await page.getByRole('button', { name: 'Close social panel' }).click();
    assert.equal(await page.locator('#root').isVisible(), false);
    await page.evaluate(() => window.social.setTab('chat'));
    assert.equal(await page.locator('#root').isVisible(), true);
  });
  assert.deepEqual(errors, []);
  console.log(`${passed} social browser checks passed; no JavaScript errors.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
