import test from 'node:test';
import assert from 'node:assert/strict';
import {createImageObjectView} from '../src/image-object-view.js';
import {createAuthenticatedImageLoader, createImageTexturePool, imageAssetPath, resolveAuthorizedImageURL, validateAuthorizedImageURL} from '../src/image-asset-loader.js';
import {resolveImagePlacement} from '../src/image-asset-geometry.js';
import {renderContext, renderFixture, fakePort, fakeResource, deferred} from './image-asset-renderer-fixtures.mjs';
const settle = () => new Promise(resolve => setImmediate(resolve));
const makeView = (fixture, loader, extra = {}) => createImageObjectView({...fixture, context: renderContext, port: fakePort(), loadTexture: loader, ...extra});

test('renderer consumes authoritative frozen geometry without independent dimensional or pivot logic', async () => {
  for (const representation of ['standing', 'floor', 'custom']) for (const rotation of [0, 90, 180, 270]) {
    const fixture = renderFixture({metadata: {depthPreset: representation, ...(representation === 'custom' ? {depthPivot: .25} : {})}});
    fixture.instance = {...fixture.instance, x: 3.125, z: -4.25, rotation};
    const view = makeView(fixture, async () => fakeResource()); await view.ready;
    assert.deepEqual(view.node.placement, resolveImagePlacement(fixture.resolved, fixture.instance));
    assert.equal(Object.isFrozen(view.placement.render.worldCorners[0]), true);
    assert.deepEqual(view.getSelectionRecord().editBounds, view.placement.editBounds); view.dispose();
  }
});
test('loading and network failure are explicit, retain identity, never show a fabricated image, and allow retry', async () => {
  const pending = deferred(), resource = fakeResource(); let calls = 0;
  const view = makeView(renderFixture(), () => ++calls === 1 ? pending.promise : Promise.resolve(resource));
  assert.equal(view.getState().status, 'loading'); assert.equal(view.node.texture, undefined); assert.equal(view.acceptUV({u: .8, v: .2}), false);
  pending.reject(new Error('network failed')); await view.ready;
  assert.equal(view.getState().status, 'error'); assert.equal(view.node.texture, undefined); assert.equal(view.getSelectionRecord().id, 'i_a1');
  await view.retry(); assert.equal(view.getState().status, 'ready'); assert.equal(view.node.texture, resource.texture); view.dispose(); assert.equal(resource.disposed, 1);
});
test('transparent pixels pass through; fully transparent images retain list/keyboard identity and full footprint', async () => {
  const view = makeView(renderFixture(), async () => fakeResource()); await view.ready;
  assert.equal(view.acceptUV({u: .25, v: .25}), false); assert.equal(view.acceptUV({u: .75, v: .25}), true);
  assert.equal(view.acceptUV({u: .25, v: .75}), true); assert.equal(view.acceptUV({u: .75, v: .75}), false);
  assert.equal(view.acceptUV({u: -1, v: .5}), false); view.dispose();
  const invisible = makeView(renderFixture(), async () => fakeResource([0, 0, 0, 0])); await invisible.ready;
  assert.equal(invisible.acceptUV({u: .5, v: .5}), false); assert.deepEqual(invisible.getSelectionRecord().routes, ['list', 'keyboard']);
  assert.equal(invisible.getSelectionRecord().editBounds.width, 2); assert.equal(invisible.getSelectionRecord().editBounds.depth, 3); invisible.dispose();
});
test('room, authority and source changes cancel pending work and dispose late resources exactly once', async () => {
  for (const change of ['room', 'authority', 'source']) {
    const first = deferred(), late = fakeResource(), current = fakeResource(); let calls = 0, firstSignal;
    const fixture = renderFixture(), view = makeView(fixture, ({signal}) => { if (++calls === 1) { firstSignal = signal; return first.promise; } return Promise.resolve(current); });
    await settle(); const original = view.ready;
    const next = change === 'source' ? renderFixture({versionId: 'v2'}) : fixture;
    const context = change === 'room' ? {...renderContext, roomId: 'r2', roomEpoch: 2} : change === 'authority' ? {...renderContext, authorityEpoch: 2, canRead: false} : renderContext;
    await view.update({...next, context}); assert.equal(firstSignal.aborted, true);
    first.resolve(late); await original; assert.equal(late.disposed, 1);
    assert.equal(view.getState().status, change === 'source' ? 'ready' : 'revoked'); view.dispose();
    if (change === 'source') assert.equal(current.disposed, 1);
  }
});
test('same-version moves reuse ready texture; authority regrant reloads; repeated disposal is idempotent', async () => {
  const fixture = renderFixture(); let calls = 0; const resources = [];
  const view = makeView(fixture, async () => { calls++; const r = fakeResource(); resources.push(r); return r; }); await view.ready;
  await view.update({...fixture, instance: {...fixture.instance, x: 7, rotation: 90}, context: renderContext}); assert.equal(calls, 1); assert.equal(view.placement.editBounds.x, 7);
  await view.update({...fixture, context: {...renderContext, canRead: false, authorityEpoch: 2}}); assert.equal(resources[0].disposed, 1);
  await view.update({...fixture, context: {...renderContext, authorityEpoch: 3}}); assert.equal(calls, 2);
  view.dispose(); view.dispose(); assert.equal(resources[1].disposed, 1); assert.equal(view.getState().status, 'disposed');
});
test('unready or malformed injected texture resources cannot mark an image loaded', async () => {
  const resource = fakeResource(); resource.isReady = () => false;
  const view = makeView(renderFixture(), async () => resource); await view.ready;
  assert.equal(view.getState().status, 'error'); assert.equal(view.getState().error.code, 'INVALID_IMAGE_RESOURCE'); assert.equal(resource.disposed, 1); view.dispose();
});
test('safe route resolver rejects external URLs, document routes, query credentials, redirects and mismatched room', () => {
  const {resolved} = renderFixture(), args = {resolved, context: renderContext, origin: 'https://room.example'};
  assert.equal(resolveAuthorizedImageURL(args), 'https://room.example' + imageAssetPath(resolved));
  for (const candidate of ['https://evil.example' + imageAssetPath(resolved), '/api/files/image.png', imageAssetPath(resolved) + '?token=secret', imageAssetPath(resolved) + '#fragment', 'data:image/png;base64,AAAA', 'https://user:pass@room.example' + imageAssetPath(resolved)]) assert.throws(() => validateAuthorizedImageURL(candidate, args));
  assert.throws(() => resolveAuthorizedImageURL({...args, context: {...renderContext, roomId: 'r2'}}));
});
test('authenticated loader uses credentialed exact same-origin PNG route and verifies immutable digest before decode', async () => {
  const fixture = renderFixture(), resource = fakeResource(); let request, decoded = false;
  const load = createAuthenticatedImageLoader({origin: 'https://room.example', fetchImage: async (url, options) => { request = {url, options}; return new Response(fixture.bytes, {headers: {'content-type': 'image/png', 'content-length': String(fixture.bytes.length)}}); }, decodeTexture: async ({bytes}) => { decoded = true; assert.deepEqual(Buffer.from(bytes), fixture.bytes); return resource; }});
  assert.equal(await load({...fixture, context: renderContext}), resource); assert.equal(decoded, true);
  assert.equal(request.options.credentials, 'same-origin'); assert.equal(request.options.redirect, 'error'); assert.equal(request.options.cache, 'no-store'); assert.equal(request.options.mode, 'same-origin'); resource.dispose();
});
test('loader rejects denied, bad MIME, truncated, oversized and corrupted bytes without decoding', async () => {
  const fixture = renderFixture(); let decoded = 0;
  const corrupt = Buffer.from(fixture.bytes); corrupt[40] ^= 1;
  for (const [response, code] of [
    [new Response('denied', {status: 403}), 'IMAGE_ACCESS_DENIED'],
    [new Response(fixture.bytes, {headers: {'content-type': 'text/html'}}), 'IMAGE_MEDIA_TYPE'],
    [new Response(fixture.bytes.subarray(0, -1), {headers: {'content-type': 'image/png'}}), 'IMAGE_LENGTH_MISMATCH'],
    [new Response(Buffer.concat([fixture.bytes, Buffer.from([1])]), {headers: {'content-type': 'image/png'}}), 'IMAGE_TOO_LARGE'],
    [new Response(corrupt, {headers: {'content-type': 'image/png'}}), 'IMAGE_DIGEST_MISMATCH']
  ]) {
    const load = createAuthenticatedImageLoader({origin: 'https://room.example', fetchImage: async () => response, decodeTexture: () => { decoded++; }});
    await assert.rejects(load({...fixture, context: renderContext}), error => error.code === code);
  }
  assert.equal(decoded, 0);
});
test('resolver seam cannot authorize an external route and decode cancellation disposes late resources', async () => {
  const fixture = renderFixture(); let fetched = 0;
  const external = createAuthenticatedImageLoader({origin: 'https://room.example', resolveURL: () => 'https://evil.example/image', fetchImage: () => { fetched++; }, decodeTexture: () => {}});
  await assert.rejects(external({...fixture, context: renderContext}), error => error.code === 'UNSAFE_IMAGE_URL'); assert.equal(fetched, 0);
  const signal = new AbortController(), pending = deferred(), resource = fakeResource();
  const load = createAuthenticatedImageLoader({origin: 'https://room.example', fetchImage: async () => new Response(fixture.bytes, {headers: {'content-type': 'image/png'}}), decodeTexture: async () => { signal.abort(); return pending.promise; }});
  const task = load({...fixture, context: renderContext, signal: signal.signal}); await settle(); pending.resolve(resource);
  await assert.rejects(task, {name: 'AbortError'}); assert.equal(resource.disposed, 1);
});
test('immutable-version pool deduplicates pending decode and GPU texture, refcounts leases and frees last consumer', async () => {
  const fixture = renderFixture(), pending = deferred(), resource = fakeResource(); let calls = 0;
  const pool = createImageTexturePool({loadTexture: () => { calls++; return pending.promise; }});
  const args = {...fixture, context: renderContext}; const a = pool.acquire(args), b = pool.acquire(args); await settle(); assert.equal(calls, 1);
  pending.resolve(resource); const [first, second] = await Promise.all([a, b]); assert.equal(first.texture, second.texture); assert.equal(pool.getStats().leases, 2);
  first.dispose(); assert.equal(resource.disposed, 0); second.dispose(); second.dispose(); assert.equal(resource.disposed, 1); assert.equal(pool.getStats().entries, 0); pool.dispose();
});
for (const previewReady of [false, true]) test(`same-task ${previewReady ? 'ready' : 'loading'} preview transfer preserves one authenticated PNG load and immediate revocation`, async () => {
  const fixture = renderFixture(), decoded = deferred(), decoding = deferred(), resource = fakeResource(); let fetches = 0, requestSignal;
  const loader = createAuthenticatedImageLoader({origin: 'https://room.example', fetchImage: async (_url, options) => { fetches++; requestSignal = options.signal; assert.equal(options.cache, 'no-store'); return new Response(fixture.bytes, {headers: {'content-type': 'image/png'}}); }, decodeTexture: () => { decoding.resolve(); return decoded.promise; }});
  const pool = createImageTexturePool({loadTexture: loader}), preview = makeView(fixture, pool.acquire);
  assert.equal(fetches, 0, 'View construction must not dispatch network work'); await decoding.promise;
  if (previewReady) { decoded.resolve(resource); await preview.ready; }
  const placed = makeView({...fixture, instance: {...fixture.instance, id: 'placed-image'}}, pool.acquire);
  preview.dispose();
  assert.equal(pool.getStats().entries, 1); assert.equal(pool.getStats().leases, 1); assert.equal(requestSignal.aborted, false); assert.equal(resource.disposed, 0);
  decoded.resolve(resource); await placed.ready; await preview.ready;
  assert.equal(fetches, 1); assert.equal(placed.getState().status, 'ready'); assert.equal(placed.acceptUV({u: .75, v: .25}), true); assert.equal(placed.acceptUV({u: .25, v: .25}), false);
  const revoked = placed.update({...fixture, instance: {...fixture.instance, id: 'placed-image'}, context: {...renderContext, canRead: false, authorityEpoch: 2}});
  assert.equal(pool.getStats().entries, 0); assert.equal(pool.getStats().leases, 0); assert.equal(resource.disposed, 1); assert.equal(placed.acceptUV({u: .75, v: .25}), false);
  await revoked; placed.dispose(); pool.dispose(); assert.equal(resource.disposed, 1);
});
test('immediate view disposal cancels the acquired lease before any authenticated network work', async () => {
  const fixture = renderFixture(); let fetches = 0;
  const loader = createAuthenticatedImageLoader({origin: 'https://room.example', fetchImage: async () => { fetches++; return new Response(fixture.bytes, {headers: {'content-type': 'image/png'}}); }, decodeTexture: async () => fakeResource()});
  const pool = createImageTexturePool({loadTexture: loader}), view = makeView(fixture, pool.acquire); view.dispose();
  assert.equal(pool.getStats().entries, 0); assert.equal(pool.getStats().leases, 0); await view.ready; await settle(); assert.equal(fetches, 0); pool.dispose();
});
test('synchronous loader failures remain promised error states rather than escaping construction', async () => {
  const view = makeView(renderFixture(), () => { throw Error('Synchronous decoder failure'); });
  assert.equal(view.getState().status, 'loading'); await view.ready; assert.equal(view.getState().status, 'error'); assert.match(view.getState().error.message, /Synchronous decoder failure/); view.dispose();
});
test('reentrant authority loss during loading cancels acquisition before a new loader runs', async () => {
  const fixture = renderFixture(); let view, invalidate = false, calls = 0;
  view = makeView(fixture, async () => { calls++; return fakeResource(); }, {onState: state => { if (invalidate && state.status === 'loading') view.update({...fixture, context: {...renderContext, canRead: false, authorityEpoch: 2}}); }});
  await view.ready; invalidate = true; await view.update({...renderFixture({versionId: 'v2'}), context: renderContext});
  assert.equal(calls, 1); assert.equal(view.getState().status, 'revoked'); assert.equal(view.acceptUV({u: .75, v: .25}), false); view.dispose();
});
test('one cancelled pool consumer does not cancel another; final cancellation cancels request and late resources', async () => {
  const fixture = renderFixture(), pending = deferred(), resource = fakeResource(), aSignal = new AbortController(), bSignal = new AbortController(); let underlying;
  const pool = createImageTexturePool({loadTexture: ({signal}) => { underlying = signal; return pending.promise; }});
  const args = {...fixture, context: renderContext}; const a = pool.acquire({...args, signal: aSignal.signal}), b = pool.acquire({...args, signal: bSignal.signal});
  await settle(); aSignal.abort(); await assert.rejects(a, {name: 'AbortError'}); assert.equal(underlying.aborted, false);
  bSignal.abort(); await assert.rejects(b, {name: 'AbortError'}); assert.equal(underlying.aborted, true); pending.resolve(resource); await settle(); assert.equal(resource.disposed, 1); pool.dispose();
});
test('pool failure retries cleanly, authority scope does not reuse textures, and hard resident pixel budget is explicit', async () => {
  const fixture = renderFixture(); let calls = 0;
  const pool = createImageTexturePool({maxResidentPixels: 64 * 96, loadTexture: async () => { if (++calls === 1) throw Error('offline'); return fakeResource(); }});
  const args = {...fixture, context: renderContext}; await assert.rejects(pool.acquire(args), /offline/); assert.equal(pool.getStats().pixels, 0);
  const first = await pool.acquire(args); await assert.rejects(pool.acquire({...args, context: {...renderContext, authorityEpoch: 2}}), error => error.code === 'IMAGE_TEXTURE_BUDGET');
  first.dispose(); const second = await pool.acquire({...args, context: {...renderContext, authorityEpoch: 2}}); assert.notEqual(first.cacheKey, second.cacheKey);
  pool.dispose(); assert.equal(second.isReady(), false); assert.equal(pool.getStats().pixels, 0); second.dispose();
});
test('cached pool access cannot bypass read denial, room mismatch or deletion', async () => {
  const fixture = renderFixture(), pool = createImageTexturePool({loadTexture: async () => fakeResource()});
  const args = {...fixture, context: renderContext}, lease = await pool.acquire(args);
  for (const patch of [{context: {...renderContext, canRead: false}}, {context: {...renderContext, roomId: 'r2'}}, {resolved: {...fixture.resolved, status: 'deleted'}}]) await assert.rejects(pool.acquire({...args, ...patch}), error => error.code === 'IMAGE_ACCESS_UNAVAILABLE');
  lease.dispose(); pool.dispose();
});
test('PNG envelope and pinned dimensions are checked before browser decoder allocation', async () => {
  const {createHash} = await import('node:crypto'); let decoded = 0;
  for (const [mutate, code] of [[bytes => { bytes[0] = 0; }, 'IMAGE_PNG_ENVELOPE'], [bytes => { bytes.writeUInt32BE(50000, 16); }, 'IMAGE_DIMENSION_MISMATCH']]) {
    const fixture = renderFixture(), bytes = Buffer.from(fixture.bytes); mutate(bytes);
    const resolved = {...fixture.resolved, version: {...fixture.resolved.version, sha256: createHash('sha256').update(bytes).digest('hex')}};
    const load = createAuthenticatedImageLoader({origin: 'https://room.example', fetchImage: async () => new Response(bytes, {headers: {'content-type': 'image/png'}}), decodeTexture: () => { decoded++; }});
    await assert.rejects(load({resolved, context: renderContext}), error => error.code === code);
  }
  assert.equal(decoded, 0);
});
test('invalid or deleted source update hides prior bytes and retry cannot resurrect the previous reference', async () => {
  const fixture = renderFixture(), resource = fakeResource(); let calls = 0;
  const view = makeView(fixture, async () => { calls++; return resource; }); await view.ready;
  await view.update({...fixture, resolved: {...fixture.resolved, status: 'deleted'}, context: renderContext});
  assert.equal(view.getState().status, 'error'); assert.equal(view.getState().error.code, 'UNAVAILABLE_IMAGE_REFERENCE'); assert.equal(view.node.texture, null); assert.equal(resource.disposed, 1);
  await view.retry(); assert.equal(calls, 1); assert.equal(view.acceptUV({u: .75, v: .25}), false); view.dispose();
});


test('a texture426 reaches the common reload guard without decoding or treating it as a normal retry',async t=>{
 const original=globalThis.dispatchEvent,seen=[];globalThis.dispatchEvent=event=>{seen.push(event);return true;};t.after(()=>{if(original===undefined)delete globalThis.dispatchEvent;else globalThis.dispatchEvent=original;});
 const fixture=renderFixture();let decoded=false;
 const load=createAuthenticatedImageLoader({origin:'https://room.example',fetchImage:async()=>new Response('Reload',{status:426}),decodeTexture:()=>{decoded=true;}});
 await assert.rejects(load({...fixture,context:renderContext}),error=>error.code==='CLIENT_RELOAD_REQUIRED');assert.equal(decoded,false);assert.equal(seen.length,1);assert.equal(seen[0].type,'universe-client-reload-required');assert.equal(seen[0].detail.code,'CLIENT_RELOAD_REQUIRED');
});
