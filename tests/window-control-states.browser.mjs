/** Native-button/CSS fixture with real shell DOM, not an actual-game integration test. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { launch } from '../scripts/browser.mjs';

const ids = ['dock-explore', 'dock-chat', 'dock-people', 'dock-media', 'dock-emote', 'dock-settings'];
const targets = ['places', 'social', 'social', 'media', 'express', 'social'];
const source = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const shell = source.replace(/<script[^>]+src="\/main.js"[^>]*><\/script>/, '')
  .replace('<link rel="stylesheet" href="/main.css">', '')
  .replace('</body>', `<section aria-label="Isolated CSS state probes" style="position:absolute;top:180px;left:30px;display:flex;gap:16px">
    <button id="probe-on" class="u-control" aria-pressed="true">On</button>
    <button id="probe-muted" class="u-control is-muted">Muted</button>
    <button id="probe-primary" class="primary">Primary</button>
    <button id="probe-selected" aria-pressed="true">Unrelated selection</button>
  </section><script type="module">
    import {createWindowControlStates} from '/src/window-control-states.js';
    const ids=${JSON.stringify(ids)}, targets=${JSON.stringify(targets)};
    document.getElementById('welcome').hidden=true;
    window.openStates=Object.fromEntries(ids.map(id=>[id,false]));
    window.nodes=ids.map(id=>document.getElementById(id));
    window.sync=createWindowControlStates(ids.map((id,index)=>({button:window.nodes[index],controls:targets[index],isOpen:()=>window.openStates[id]})));
    window.setOpen=(id,value)=>{window.openStates[id]=value;return window.sync()};
    window.activations=0;
    for(const [index,id] of ids.entries())window.nodes[index].addEventListener('click',()=>{window.activations++;window.setOpen(id,!window.openStates[id])});
    document.getElementById('dock-build').classList.add('active');
    document.getElementById('camera-pan').setAttribute('aria-pressed','true');
    window.sync();window.ready=true;
  </script></body>`);

const server = http.createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/') { response.setHeader('content-type', 'text/html'); response.end(shell); return; }
    const local = path.startsWith('/src/') ? `..${path}` : `../public${path}`;
    response.setHeader('content-type', path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.ttf') ? 'font/ttf' : path.endsWith('.woff2') ? 'font/woff2' : path.endsWith('.png') ? 'image/png' : 'image/svg+xml');
    response.end(await readFile(new URL(local, import.meta.url)));
  } catch { response.statusCode = 404; response.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await launch(), checks = [], errors = [];
await mkdir('evidence', { recursive: true });
const sample = locator => locator.evaluate(element => {
  const css = getComputedStyle(element), bounds = element.getBoundingClientRect();
  return { color: css.backgroundColor, image: css.backgroundImage, shadow: css.boxShadow, outline: css.outlineColor, outlineWidth: css.outlineWidth, outlineOffset: css.outlineOffset, opacity: css.opacity, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } };
});
const waitColor = (page, id, color) => page.waitForFunction(({ id, color }) => getComputedStyle(document.getElementById(id)).backgroundColor === color, { id, color });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.waitForFunction(() => window.ready); await page.evaluate(() => document.fonts.ready);
  const chat = page.locator('#dock-chat'), bounds = (await sample(chat)).bounds;
  const baseline = await page.locator('#probe-selected').evaluate(element => getComputedStyle(element).backgroundColor);
  assert.equal((await sample(chat)).color, 'rgba(0, 0, 0, 0)');
  await chat.hover(); await waitColor(page, 'dock-chat', 'rgba(255, 255, 255, 0.08)');
  await page.mouse.down(); await waitColor(page, 'dock-chat', 'rgba(255, 255, 255, 0.12)');
  assert.deepEqual((await sample(chat)).bounds, bounds);
  await page.mouse.up();
  assert.equal(await chat.getAttribute('aria-expanded'), 'true');
  await waitColor(page, 'dock-chat', 'rgba(255, 255, 255, 0.18)');
  await page.mouse.move(1, 1); await waitColor(page, 'dock-chat', 'rgba(255, 255, 255, 0.14)');
  assert.equal((await sample(chat)).shadow, 'rgba(255, 255, 255, 0.1) 0px 0px 0px 1px inset');
  assert.equal((await sample(chat)).image, 'none');
  assert.deepEqual((await sample(chat)).bounds, bounds);
  await chat.hover(); await page.mouse.down(); await waitColor(page, 'dock-chat', 'rgba(255, 255, 255, 0.12)');
  await page.mouse.up(); await page.mouse.move(1, 1);
  assert.equal(await chat.getAttribute('aria-expanded'), 'false');
  checks.push('Normal .08 hover, .12 pointer press, .14 open with .10 inset edge, .18 open hover; unchanged bounds');

  // Stale legacy active flags never override a bound window's current visibility.
  await chat.evaluate(element => element.classList.add('active'));
  await waitColor(page, 'dock-chat', 'rgba(0, 0, 0, 0)');
  await chat.hover(); await waitColor(page, 'dock-chat', 'rgba(255, 255, 255, 0.08)');
  await page.evaluate(() => window.setOpen('dock-chat', true));
  await waitColor(page, 'dock-chat', 'rgba(255, 255, 255, 0.18)');
  await page.mouse.move(1, 1);
  const identitiesAndWrites = await page.evaluate(async () => {
    let changes = 0;
    const observer = new MutationObserver(records => { changes += records.length; });
    for (const node of window.nodes) observer.observe(node, { attributes: true, childList: true });
    for (let frame = 0; frame < 600; frame++) window.sync();
    await Promise.resolve(); observer.disconnect();
    return { changes, sameNodes: window.nodes.every(node => document.getElementById(node.id) === node) };
  });
  assert.deepEqual(identitiesAndWrites, { changes: 0, sameNodes: true });
  checks.push('Stale .active is ignored; 600 unchanged polls produce no native DOM mutations or rebuilding');

  // Arrive by an actual Tab event; then exercise the browser's native button keys.
  await page.locator('#dock-explore').focus(); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'dock-chat');
  let focus = await sample(chat);
  assert.equal(focus.outline, 'rgb(255, 255, 255)'); assert.equal(focus.outlineWidth, '2px'); assert.equal(focus.outlineOffset, '-3px');
  await page.screenshot({ path: 'evidence/window-control-keyboard-open.png' });
  await page.keyboard.press('Enter'); assert.equal(await chat.getAttribute('aria-expanded'), 'false');
  await page.keyboard.press('Space'); assert.equal(await chat.getAttribute('aria-expanded'), 'true');
  focus = await sample(chat); assert.equal(focus.outline, 'rgb(255, 255, 255)'); assert.deepEqual(focus.bounds, bounds);
  assert.equal(await chat.getAttribute('aria-controls'), 'social');
  assert.equal(await chat.locator('label').textContent(), 'Chat');
  checks.push('Keyboard Tab produces the separate white 2px ring; Enter/Space preserve native activation and accessible label');

  for (const id of ['dock-build', 'camera-follow', 'camera-pan', 'probe-on', 'probe-primary']) {
    const control = page.locator(`#${id}`), initial = await sample(control);
    assert.match(initial.image, /linear-gradient/); assert.match(initial.image, /rgb\(134, 41, 252\)/);
    assert.equal(await control.getAttribute('data-window-control'), null);
    await control.hover(); assert.match((await sample(control)).image, /linear-gradient/);
    await page.mouse.down(); assert.match((await sample(control)).image, /linear-gradient/); assert.deepEqual((await sample(control)).bounds, initial.bounds);
    await page.mouse.up(); await page.mouse.move(1, 1);
  }
  assert.equal(await page.locator('#probe-selected').evaluate(element => getComputedStyle(element).backgroundColor), baseline);
  const muted = page.locator('#probe-muted');
  assert.equal((await sample(muted)).color, 'rgb(233, 109, 81)');
  await muted.hover(); await waitColor(page, 'probe-muted', 'rgb(212, 85, 58)');
  await page.mouse.down(); assert.equal((await sample(muted)).image, 'none');
  assert(['rgb(233, 109, 81)', 'rgb(212, 85, 58)', 'rgb(196, 74, 48)'].includes((await sample(muted)).color));
  await page.mouse.up(); await page.mouse.move(1, 1);
  checks.push('Build, Follow, Pan and primary/on probes retain gradients; unrelated selection stays unchanged; muted remains coral');

  const connect = page.locator('#dock-media'), connectBounds = (await sample(connect)).bounds;
  await page.evaluate(() => { window.setOpen('dock-media', true); document.getElementById('dock-media').disabled = true; });
  await connect.hover(); await waitColor(page, 'dock-media', 'rgba(255, 255, 255, 0.14)');
  const before = await page.evaluate(() => window.activations);
  await page.mouse.down(); await page.mouse.up(); await connect.evaluate(element => element.click());
  assert.equal(await page.evaluate(() => window.activations), before);
  assert.equal((await sample(connect)).opacity, '0.5'); assert.deepEqual((await sample(connect)).bounds, connectBounds);
  await page.evaluate(() => window.setOpen('dock-media', false));
  await waitColor(page, 'dock-media', 'rgba(0, 0, 0, 0)');
  await page.locator('#dock-people').focus(); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'dock-emote');
  checks.push('Native disabled Connect remains inert, dimmed and skipped by Tab in both open and closed states');
  await context.close();

  for (const viewport of [{ width: 1023, height: 800 }, { width: 1024, height: 800 }, { width: 1920, height: 1080 }, { width: 390, height: 844 }]) {
    const coarse = viewport.width === 390;
    const c = await browser.newContext({ viewport, hasTouch: coarse, isMobile: coarse, reducedMotion: 'reduce' }), p = await c.newPage();
    p.on('pageerror', error => errors.push(error.message));
    await p.goto(base); await p.waitForFunction(() => window.ready); await p.evaluate(() => document.fonts.ready);
    const beforeGeometry = await p.locator('#dock button').evaluateAll(elements => elements.map(element => { const b = element.getBoundingClientRect(); return { id: element.id, x: b.x, y: b.y, width: b.width, height: b.height }; }));
    await p.evaluate(() => { for (const id of Object.keys(window.openStates)) window.openStates[id] = true; window.sync(); });
    const afterGeometry = await p.locator('#dock button').evaluateAll(elements => elements.map(element => { const b = element.getBoundingClientRect(); return { id: element.id, x: b.x, y: b.y, width: b.width, height: b.height }; }));
    assert.deepEqual(afterGeometry, beforeGeometry);
    for (const id of ids) {
      assert.equal(await p.locator(`#${id}`).getAttribute('aria-expanded'), 'true');
      assert.equal(await p.locator(`#${id}`).evaluate(element => Boolean(document.getElementById(element.getAttribute('aria-controls')))), true);
    }
    if (coarse) {
      assert.equal(await p.evaluate(() => matchMedia('(hover: hover)').matches), false);
      for (const b of afterGeometry) { assert(b.width >= 48, `${b.id} width`); assert(b.height >= 48, `${b.id} height`); }
      await p.screenshot({ path: 'evidence/window-control-coarse-open.png' });
    }
    checks.push(`${viewport.width}px ${coarse ? 'coarse' : 'fine'}: all six indicators preserve geometry and reference existing surfaces`);
    await c.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, scope: 'Isolated real-shell DOM/CSS and native browser interaction; actual game shortcuts/history are verified separately by the integration owner.' }, null, 2));
} catch (error) { errors.push(error.stack); console.error(error); process.exitCode = 1; }
finally {
  await writeFile('evidence/window-control-states-results.json', JSON.stringify({ checks, errors, scope: 'Isolated native-button/CSS fixture; no renderer, camera, world, provider or media capture was started.' }, null, 2));
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
