/** Real bundled app + public stylesheet; native edit, retry and touch emotes. */
import assert from 'node:assert/strict';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds} from '../src/worlds.js';
import {launch} from '../scripts/browser.mjs';

const app = createGameServer({database: ':memory:', seeds: structuredClone(seedWorlds), dist: new URL('../dist', import.meta.url).pathname});
const {port} = await app.listen(0), base = `http://127.0.0.1:${port}`;
const browser = await launch(), results = [], geometry = [], errors = [];
const output = `evidence/compact-layout-${process.env.COMPACT_LAYOUT_PHASE || 'current'}`;
await mkdir(output, {recursive: true});
async function check(name, fn) {
  try { await fn(); results.push({name, status: 'PASS'}); console.log('PASS', name); }
  catch (error) { results.push({name, status: 'FAIL', error: error.stack}); console.error('FAIL', name, error.message); process.exitCode = 1; }
}
async function measure(page, viewport, state) {
  await page.locator('#social textarea').scrollIntoViewIfNeeded();
  await page.getByRole('button', {name: /^(Send message|Save edited message)$/}).scrollIntoViewIfNeeded();
  const value = await page.evaluate(() => {
    const rect = node => { const r = node.getBoundingClientRect(); return {x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom}; };
    const shell = document.querySelector('#social'), form = shell.querySelector('.social-composer');
    const textarea = form.querySelector('textarea'), send = form.querySelector('.social-composer-actions button');
    const s = send.getBoundingClientRect(), hit = document.elementFromPoint(s.x+s.width/2, s.y+s.height/2);
    return {shell:rect(shell), form:rect(form), textarea:rect(textarea), send:rect(send), sendHit:hit===send || send.contains(hit), overflow:document.documentElement.scrollWidth>innerWidth || form.scrollWidth>form.clientWidth+1};
  });
  geometry.push({viewport, state, ...value});
  await page.screenshot({path:`${output}/${viewport.width}x${viewport.height}-${state}.png`, scale:'css'});
  await check(`${viewport.width}x${viewport.height} ${state} usable composer geometry`, async () => {
    assert(value.textarea.width >= 120, `Textarea width ${value.textarea.width}px is not usable`);
    assert(value.textarea.x >= 0 && value.textarea.right <= viewport.width+1);
    assert(value.textarea.y >= value.shell.y && value.textarea.bottom <= Math.min(value.shell.bottom, viewport.height)+1);
    assert(value.send.width >= 48 && value.send.height >= 48);
    assert(value.send.right <= viewport.width+1 && value.send.bottom <= Math.min(value.shell.bottom, viewport.height)+1);
    assert(value.sendHit, 'Send must receive a native pointer action');
    assert(!value.overflow, 'No horizontal overflow');
    assert(Math.abs(value.textarea.bottom-value.send.bottom) < 2, 'Composer and Send share their control row');
  });
}
// Drive real touch scroll rather than changing scrollTop or relying on locator auto-scroll.
async function reachWithTouch(page, context, control, viewport) {
  const cdp=await context.newCDPSession(page);
  try {
    for(let attempt=0;attempt<10;attempt++) {
      const layout=await control.evaluate(node=>{
        const box=node.getBoundingClientRect(), header=document.querySelector('.social-header').getBoundingClientRect();
        const clips=[];
        for(let p=node.parentElement;p;p=p.parentElement) {
          if(!/(auto|scroll)/.test(getComputedStyle(p).overflowY)||p.scrollHeight<=p.clientHeight+1)continue;
          const r=p.getBoundingClientRect();
          if(box.y<r.y-.5||box.bottom>r.bottom+.5)clips.push(r.toJSON());
        }
        const hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);
        return {box:box.toJSON(),header:header.toJSON(),clip:clips.at(-1),visible:!clips.length&&box.y>=header.bottom-.5&&box.bottom<=innerHeight+.5&&(hit===node||node.contains(hit))};
      });
      if(layout.visible)return;
      const area=layout.clip||await page.locator('.social-panel').boundingBox();
      const bottom=Math.min(viewport.height,area.y+area.height)-10, top=Math.max(layout.header.bottom,area.y)+10;
      assert(bottom-top>20,'A native scroll region must remain available');
      const up=layout.box.bottom>bottom, distance=Math.min(bottom-top,Math.max(30,up?layout.box.bottom-bottom+20:top-layout.box.y+20));
      const start=up?bottom:top, end=start+(up?-distance:distance),x=area.x+8;
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x,y:start}]});
      for(let step=1;step<=5;step++) {await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:1,x,y:start+(end-start)*step/5}]});await page.waitForTimeout(25);}
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await page.waitForTimeout(100);
    }
    assert.fail(`Control remains clipped after native touch scroll: ${await control.getAttribute('aria-label')}`);
  } finally {await cdp.detach();}
}
try {
  for (const viewport of [{width:320,height:568},{width:390,height:844},{width:568,height:320},{width:1280,height:850}]) {
    const context = await browser.newContext({viewport, hasTouch:true, isMobile:viewport.width<700});
    const page = await context.newPage(), requests = [];
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', req => { if (['POST','PATCH'].includes(req.method()) && /\/api\/(rooms\/commons\/(messages|emote)|messages\/)/.test(req.url())) requests.push({path:new URL(req.url()).pathname, method:req.method(), body:req.postDataJSON()}); });
    try {
      await page.goto(base); await page.locator('#display-name').fill(`Layout ${viewport.width}`); await page.locator('#join-button').click();
      await page.waitForFunction(() => window.__universe?.getState().ready);
      await page.locator('#dock-chat').tap();
      const composer = page.getByRole('textbox', {name:'Message the room'}), send = page.getByRole('button',{name:'Send message',exact:true});
      const original = `Edit target ${viewport.width}`, draft = `Separate draft ${viewport.width}`;
      await composer.fill(original); await send.tap(); await page.locator('.social-message-text').getByText(original,{exact:true}).waitFor();
      await composer.fill(draft);
      const row = page.locator('.social-message').filter({hasText:original});
      await row.locator('summary').tap(); await row.getByRole('button',{name:'Edit your message'}).tap();
      await measure(page, viewport, 'editing');
      await check(`${viewport.width}x${viewport.height} cancel preserves draft without mutation`, async () => {
        const before = requests.filter(r=>r.method==='PATCH').length;
        await page.locator('.social-edit-label').getByRole('button',{name:'Cancel',exact:true}).tap();
        assert.equal(await composer.inputValue(),draft); assert.equal(requests.filter(r=>r.method==='PATCH').length,before);
      });
      await check(`${viewport.width}x${viewport.height} save edits once and restores draft`, async () => {
        await row.locator('summary').tap(); await row.getByRole('button',{name:'Edit your message'}).tap();
        await composer.fill(original+' saved'); await page.getByRole('button',{name:'Save edited message'}).tap();
        await page.locator('.social-message-text').getByText(original+' saved',{exact:true}).waitFor();
        await page.waitForFunction(value=>document.querySelector('#social textarea').value===value,draft);
        const edits = requests.filter(r=>r.method==='PATCH'); assert.equal(edits.length,1); assert.equal(edits[0].body.text,original+' saved');
      });
      await page.route('**/api/rooms/commons/messages', route => route.request().method()==='POST' ? route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary test interruption'})}) : route.continue());
      await send.tap(); await page.getByRole('alert').getByText('Temporary test interruption',{exact:true}).waitFor();
      assert.equal(await composer.inputValue(),draft);
      await measure(page, viewport, 'send-error');
      await check(`${viewport.width}x${viewport.height} retry keeps operation ID and commits one message`, async () => {
        await page.unroute('**/api/rooms/commons/messages'); await send.tap();
        await page.locator('.social-message-text').getByText(draft,{exact:true}).waitFor();
        await page.waitForFunction(()=>document.querySelector('#social textarea').value==='');
        const pair=requests.filter(r=>r.path==='/api/rooms/commons/messages'&&r.body.text===draft);
        assert.equal(pair.length,2); assert.deepEqual(pair[0].body,pair[1].body);
        const response=await context.request.get(base+'/api/rooms/commons/messages');
        assert.equal((await response.json()).messages.filter(m=>m.text===draft).length,1);
        assert.equal(await page.getByRole('alert').count(),0);
      });
      await check(`${viewport.width}x${viewport.height} native emote, return to compose and Close remain reachable`, async () => {
        await page.locator('summary[aria-label="Avatar emotes"]').tap();
        const emote=page.getByRole('button',{name:'Show 👋 emote'});
        assert.equal(await emote.isVisible(),true, 'Expanded emotes must be visible with the public stylesheet');
        await emote.scrollIntoViewIfNeeded(); const box=await emote.boundingBox();
        assert(box.width>=48 && box.height>=48, 'Touch emotes are at least 48px');
        const before=requests.filter(r=>r.path.endsWith('/emote')).length;
        const reply=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/rooms/commons/emote'&&r.request().method()==='POST');
        await emote.tap(); assert.equal((await reply).ok(),true);
        const calls=requests.filter(r=>r.path.endsWith('/emote')); assert.equal(calls.length,before+1); assert.equal(calls.at(-1).body.emoji,'👋');
        await page.screenshot({path:`${output}/${viewport.width}x${viewport.height}-emotes.png`,scale:'css'});
        await reachWithTouch(page,context,composer,viewport);
        const afterEmote=`After emote ${viewport.width}`;
        await composer.fill(afterEmote);
        await reachWithTouch(page,context,send,viewport);
        const close=page.getByRole('button',{name:'Close social panel'}),closeBox=await close.boundingBox();
        assert(closeBox.y>=0 && closeBox.y+closeBox.height<=viewport.height,'Close stays on screen while composing');
        await page.screenshot({path:`${output}/${viewport.width}x${viewport.height}-compose-after-emote.png`,scale:'css'});
        await send.tap(); await page.locator('.social-message-text').getByText(afterEmote,{exact:true}).waitFor({state:'attached'});
        await page.waitForFunction(()=>document.querySelector('#social textarea').value==='');
        assert.equal(requests.filter(r=>r.path==='/api/rooms/commons/messages'&&r.body.text===afterEmote).length,1);
        await close.tap(); await page.locator('#social').waitFor({state:'hidden'});
      });
    } catch (error) { await check(`${viewport.width}x${viewport.height} native journey`, async()=>{throw error;}); }
    finally { await context.close(); }
  }
  await check('No page errors', async()=>assert.deepEqual(errors,[]));
} finally {
  const hashes={}; for(const file of ['src/social.js','src/social.css','src/social-sheet-layout.js','public/style.css','dist/main.js','dist/main.css']) hashes[file]=createHash('sha256').update(await readFile(file)).digest('hex');
  await writeFile(`${output}/results.json`,JSON.stringify({results,geometry,errors,hashes,scope:'Baseline main, real bundle and public CSS; Chromium software WebGL with synthetic isolated accounts and emulated viewports/touch. No external A shell or physical-device claim.'},null,2));
  await browser.close(); await app.close();
}
