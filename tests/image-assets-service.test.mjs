import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { initializeImageAssetSchema, createImageAssetRepository } from '../server/image-asset-store.mjs';
import { createImageAssetService, createImageAssetHttpHandler, IMAGE_UPLOAD_JSON_LIMIT, imageReferenceKey } from '../server/image-assets.mjs';
import { validatePng } from '../server/png-validation.mjs';
import { makePng, transparentPng, pngChunk, pngHeader, pngSignature } from '../fixtures/png-fixtures.mjs';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const code = expected => error => { assert.equal(error.code, expected); return true; };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); initializeImageAssetSchema(db);
  t.after(() => db.close());
  const repo = createImageAssetRepository(db), events = [];
  const state = { read: true, manage: true, session: { userId: 'alice', currentRoomId: 'room-a', expiresAt: NOW + 60_000, sessionEpoch: 1 } };
  const service = createImageAssetService({ repo, now: () => NOW,
    resolveSession: token => token === 'session-a' ? state.session : null,
    authorizeRead: () => state.read, authorizeManage: () => state.manage,
    validateImage: validatePng, afterCommit: event => events.push(event), ...options });
  const context = { roomId: 'room-a', userId: 'alice', sessionIdentity: 'session-a' };
  const upload = extra => ({ ...context, operationId: 'operation-a', mediaType: 'image/png', bytes: makePng(), draft: { name: '  Oak image  ', tags: 'Tree, green, TREE', floating: false, collisionGrid: [[0, 0], [1, 1], [1, 1]] }, ...extra });
  return { db, repo, service, state, context, upload, events };
}
const ref = entry => ({ assetId: entry.definition.assetId, versionId: entry.version.versionId });
const scene = entry => ({ objects: [{ id: 'placed-a', type: 'image', assetRef: ref(entry), x: 2, z: 3, rotation: 90 }] });

test('complete PNG decoder reconstructs every filter and supported color mode', () => {
  for (const colorType of [0, 2, 4, 6]) for (let filter = 0; filter <= 4; filter++) {
    const result = validatePng(makePng({ width: 13, height: 17, colorType, filter, pixel: () => [41, 0, 53, 0] }));
    assert.equal(result.width, 13); assert.equal(result.height, 17);
    assert.equal(result.hasTransparency, colorType === 4 || colorType === 6);
  }
  assert.equal(validatePng(transparentPng()).hasTransparency, true);
  assert.equal(validatePng(makePng({ pixel: () => [0, 0, 0, 255], filter: y => y % 5 })).hasTransparency, false);
});

test('complete PNG validation rejects local malformed, unsupported and excessive fixtures', () => {
  const png = makePng(), badCrc = Buffer.from(png); badCrc[25] ^= 1;
  const encoded = data => Buffer.concat([pngSignature, pngHeader(1, 1), pngChunk('IDAT', data), pngChunk('IEND')]);
  const malformed = [
    [Buffer.from('<svg/>'), 'IMAGE_FORMAT'], [png.subarray(0, png.length - 2), 'IMAGE_TRUNCATED'],
    [badCrc, 'IMAGE_CRC'], [Buffer.concat([png, Buffer.from('x')]), 'IMAGE_ORDER'],
    [makePng({ extraChunks: [pngChunk('acTL', Buffer.alloc(8))] }), 'IMAGE_UNSUPPORTED'],
    [makePng({ extraChunks: [pngChunk('iCCP', Buffer.from('unsupported profile'))] }), 'IMAGE_UNSUPPORTED'],
    [makePng({ extraChunks: [pngChunk('gAMA', Buffer.from([0, 0, 177, 143]))] }), 'IMAGE_UNSUPPORTED'],
    [makePng({ extraChunks: [pngChunk('sRGB', Buffer.from([4]))] }), 'IMAGE_UNSUPPORTED'],
    [makePng({ extraChunks: [pngChunk('sRGB', Buffer.from([0])), pngChunk('sRGB', Buffer.from([0]))] }), 'IMAGE_UNSUPPORTED'],
    [Buffer.concat([pngSignature, pngHeader(1, 1, { colorType: 3 }), pngChunk('IEND')]), 'IMAGE_UNSUPPORTED'],
    [Buffer.concat([pngSignature, pngHeader(1, 1, { bitDepth: 16 }), pngChunk('IEND')]), 'IMAGE_UNSUPPORTED'],
    [Buffer.concat([pngSignature, pngHeader(1, 1, { interlace: 1 }), pngChunk('IEND')]), 'IMAGE_UNSUPPORTED'],
    [Buffer.concat([pngSignature, pngHeader(2049, 1), pngChunk('IEND')]), 'IMAGE_DIMENSIONS'],
    [Buffer.concat([pngSignature, pngHeader(1, 1), pngHeader(1, 1), pngChunk('IEND')]), 'IMAGE_HEADER'],
    [encoded(Buffer.from('bad IDAT')), 'IMAGE_DECODE'], [encoded(deflateSync(Buffer.alloc(4))), 'IMAGE_DECODE'],
    [encoded(deflateSync(Buffer.alloc(8192))), 'IMAGE_DECODE'],
    [encoded(deflateSync(Buffer.from([5, 0, 0, 0, 0]))), 'IMAGE_FILTER'],
    [encoded(Buffer.concat([deflateSync(Buffer.alloc(5)), Buffer.from('trailing')])), 'IMAGE_DECODE'],
  ];
  for (const [bytes, expected] of malformed) assert.throws(() => validatePng(bytes), code(expected));
  assert.throws(() => validatePng(png, { mediaType: 'image/svg+xml' }), code('IMAGE_MIME'));
  assert.throws(() => validatePng(png, { limits: { maxBytes: png.length - 1 } }), code('IMAGE_TOO_LARGE'));
  assert.throws(() => validatePng(png, { limits: { maxPixels: 100 } }), code('IMAGE_DIMENSIONS'));
  assert.throws(() => validatePng(png, { limits: { maxChunks: 2 } }), code('IMAGE_CHUNKS'));
  assert.equal(validatePng(makePng({ extraChunks: [pngChunk('sRGB', Buffer.from([0]))] })).width, 64);
});

test('create commits reusable immutable records, authorized bytes and name/tag discovery', async t => {
  const f = fixture(t), input = f.upload(), entry = await f.service.create(input);
  assert.equal(entry.version.name, 'Oak image'); assert.deepEqual(entry.version.tags, ['Tree', 'green']);
  assert.equal(entry.version.sha256, createHash('sha256').update(input.bytes).digest('hex'));
  assert.equal(entry.definition.createdAt, new Date(NOW).toISOString());
  assert.equal(entry.status, 'active'); assert.ok(Object.isFrozen(entry.version.collisionGrid[1]));
  assert.equal(f.service.list({ ...f.context, query: 'GREEN oak' }).entries.length, 1);
  assert.equal(f.service.list({ ...f.context, query: 'unknown' }).entries.length, 0);
  assert.equal(JSON.stringify(entry).includes('bytes'), false);
  const image = f.service.readImage({ ...f.context, ...ref(entry) });
  assert.deepEqual(image.bytes, input.bytes); assert.equal(image.headers['Content-Type'], 'image/png');
  assert.equal(image.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(image.headers['Cache-Control'], 'private, no-store');
  assert.equal(image.headers['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.equal(f.service.readImage({ ...f.context, ...ref(entry), head: true }).bytes, null);
  assert.equal(f.events.length, 1); assert.equal(f.repo.usage('room-a').definitions, 1);
  const second = await f.service.create(f.upload({ operationId: 'operation-b' }));
  assert.notEqual(second.definition.assetId, entry.definition.assetId);
  assert.equal(f.service.list(f.context).entries.length, 2);
});

test('idempotency returns committed identity; changed bytes or exact draft conflicts', async t => {
  const f = fixture(t), input = f.upload(), first = await f.service.create(input);
  assert.deepEqual(await f.service.create(input), first);
  await assert.rejects(f.service.create(f.upload({ draft: { ...input.draft, name: 'Oak image' } })), code('IMAGE_OPERATION_CONFLICT'));
  await assert.rejects(f.service.create(f.upload({ bytes: makePng({ pixel: () => [1, 2, 3, 4] }) })), code('IMAGE_OPERATION_CONFLICT'));
  assert.equal(f.events.length, 1); assert.equal(f.repo.usage('room-a').definitions, 1);
  assert.deepEqual(f.service.reconcileCreate({ ...f.context, operationId: 'operation-a' }), { status: 'committed', entry: first });
  assert.deepEqual(f.service.reconcileCreate({ ...f.context, operationId: 'unknown' }), { status: 'not-found' });
  f.state.session.userId = 'bob';
  assert.deepEqual(f.service.reconcileCreate({ ...f.context, userId: 'bob', operationId: 'operation-a' }), { status: 'not-found' });
});

test('failed image decode or invalid metadata stores no record, blob or idempotency reservation', async t => {
  const f = fixture(t);
  await assert.rejects(f.service.create(f.upload({ bytes: Buffer.from('<html/>') })), code('IMAGE_FORMAT'));
  await assert.rejects(f.service.create(f.upload({ mediaType: 'text/html' })), code('IMAGE_MIME'));
  await assert.rejects(f.service.create(f.upload({ draft: { name: 'invalid', url: '/api/rooms/room-a/files/protected' } })));
  assert.deepEqual(f.repo.usage('room-a'), { definitions: 0, bytes: 0 });
  assert.equal(f.repo.getOperation('room-a', 'alice', 'operation-a'), null);
  assert.equal(f.events.length, 0);
});

test('private room list/image/HEAD/resolve and foreign copied IDs are denied', async t => {
  const f = fixture(t), entry = await f.service.create(f.upload());
  f.state.read = false;
  for (const head of [false, true]) assert.throws(() => f.service.readImage({ ...f.context, ...ref(entry), head }), code('IMAGE_NOT_FOUND'));
  assert.throws(() => f.service.list(f.context), code('IMAGE_NOT_FOUND'));
  assert.throws(() => f.repo.transaction(() => f.service.resolveSceneReferences({ ...f.context, scene: scene(entry) })), code('IMAGE_NOT_FOUND'));
  f.state.read = true; f.state.session.currentRoomId = 'room-b';
  assert.throws(() => f.service.readImage({ ...f.context, roomId: 'room-b', ...ref(entry) }), code('IMAGE_NOT_FOUND'));
  assert.throws(() => f.service.readImage({ ...f.context, roomId: 'room-b', assetId: 'missing', versionId: 'missing' }), code('IMAGE_NOT_FOUND'));
});

test('area-only owner may read assets but cannot manage library', async t => {
  const f = fixture(t), entry = await f.service.create(f.upload()); f.state.manage = false;
  assert.equal(f.service.list(f.context).entries.length, 1);
  await assert.rejects(f.service.create(f.upload({ operationId: 'operation-b' })), code('IMAGE_MANAGE_DENIED'));
  const map = f.repo.transaction(() => f.service.resolveSceneReferences({ ...f.context, scene: scene(entry) }));
  assert.equal(map[imageReferenceKey(ref(entry))].version.name, entry.version.name);
});

for (const revoke of ['role', 'read', 'logout', 'actor', 'room', 'expiry', 'epoch']) {
  test(`revocation wins after asynchronous validation: ${revoke}`, async t => {
    const gate = deferred(), f = fixture(t, { validateImage: async (...args) => { await gate.promise; return validatePng(...args); } });
    const pending = f.service.create(f.upload());
    if (revoke === 'role') f.state.manage = false;
    if (revoke === 'read') f.state.read = false;
    if (revoke === 'logout') f.state.session = null;
    if (revoke === 'actor') f.state.session.userId = 'bob';
    if (revoke === 'room') f.state.session.currentRoomId = 'room-b';
    if (revoke === 'expiry') f.state.session.expiresAt = NOW;
    if (revoke === 'epoch') f.state.session.sessionEpoch++;
    gate.resolve(); await assert.rejects(pending);
    assert.deepEqual(f.repo.usage('room-a'), { definitions: 0, bytes: 0 }); assert.equal(f.events.length, 0);
  });
}

test('caller and decoder mutation cannot change stored bytes or draft after await', async t => {
  const gate = deferred();
  const f = fixture(t, { validateImage: async (bytes, info) => { const result = validatePng(bytes, info); bytes.fill(0); await gate.promise; return result; } });
  const input = f.upload(), expected = Buffer.from(input.bytes), pending = f.service.create(input);
  input.bytes.fill(0); input.draft.name = 'replacement'; input.draft.collisionGrid[1][0] = 0;
  gate.resolve(); const entry = await pending;
  assert.equal(entry.version.name, 'Oak image'); assert.equal(entry.version.collisionGrid[1][0], 1);
  assert.deepEqual(f.service.readImage({ ...f.context, ...ref(entry) }).bytes, expected);
});

test('concurrent same-operation uploads consume quota once and notify once', async t => {
  const gate = deferred(), f = fixture(t, { validateImage: async (...args) => { await gate.promise; return validatePng(...args); }, limits: { maxRoomDefinitions: 1 } });
  const pending = [f.service.create(f.upload()), f.service.create(f.upload())]; gate.resolve();
  const entries = await Promise.all(pending); assert.deepEqual(entries[0], entries[1]);
  assert.equal(f.repo.usage('room-a').definitions, 1); assert.equal(f.events.length, 1);
});

test('room quotas are enforced atomically against competing valid uploads', async t => {
  const gate = deferred(), f = fixture(t, { validateImage: async (...args) => { await gate.promise; return validatePng(...args); }, limits: { maxRoomDefinitions: 1 } });
  const pending = [f.service.create(f.upload()), f.service.create(f.upload({ operationId: 'operation-b' }))]; gate.resolve();
  const results = await Promise.allSettled(pending);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.find(x => x.status === 'rejected').reason.code, 'IMAGE_ROOM_QUOTA');
  assert.equal(f.repo.usage('room-a').definitions, 1);
});

test('byte quotas include retained tombstones and no deleted reference can reenter scene', async t => {
  const bytes = makePng(), f = fixture(t, { limits: { maxRoomBytes: bytes.length } });
  const entry = await f.service.create(f.upload());
  f.db.prepare('UPDATE room_image_assets SET deleted_at=? WHERE room_id=? AND asset_id=?').run(new Date(NOW).toISOString(), 'room-a', entry.definition.assetId);
  assert.equal(f.service.list(f.context).entries.length, 0);
  assert.equal(f.repo.usage('room-a').bytes, bytes.length);
  await assert.rejects(f.service.create(f.upload({ operationId: 'operation-b' })), code('IMAGE_ROOM_QUOTA'));
  assert.throws(() => f.repo.transaction(() => f.service.resolveSceneReferences({ ...f.context, scene: scene(entry) })), code('IMAGE_NOT_FOUND'));
});

test('scene references resolve only in transaction, reject authority extras and preserve host rollback', async t => {
  const f = fixture(t), entry = await f.service.create(f.upload()), draft = scene(entry);
  assert.throws(() => f.service.resolveSceneReferences({ ...f.context, scene: draft }), /SAME transaction/);
  for (const extra of [{ width: 0.01 }, { solid: false }, { url: '/files/protected' }, { createdBy: 'alice' }, { sha256: 'forged' }]) {
    assert.throws(() => f.repo.transaction(() => f.service.resolveSceneReferences({ ...f.context, scene: { objects: [{ ...draft.objects[0], ...extra }] } })));
  }
  f.db.exec('CREATE TABLE scene_fixture(scene TEXT NOT NULL)');
  assert.throws(() => f.service.withResolvedSceneReferences({ ...f.context, scene: draft }, resolved => {
    assert.ok(Object.isFrozen(resolved[imageReferenceKey(ref(entry))].version));
    f.db.prepare('INSERT INTO scene_fixture VALUES(?)').run(JSON.stringify(draft)); throw new Error('host area/actor/CAS denial');
  }), /host area/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM scene_fixture').get().n, 0);
  f.service.withResolvedSceneReferences({ ...f.context, scene: draft }, () => f.db.prepare('INSERT INTO scene_fixture VALUES(?)').run(JSON.stringify(draft)));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM scene_fixture').get().n, 1);
});

test('afterCommit delivery failure leaves durable success and idempotent recovery', async t => {
  const f = fixture(t, { afterCommit: () => { throw new Error('local notification unavailable'); } });
  const entry = await f.service.create(f.upload());
  assert.equal(f.repo.usage('room-a').definitions, 1); assert.deepEqual(await f.service.create(f.upload()), entry);
});

test('SQLite rejects mutation of immutable definition/version data and async transactions', async t => {
  const f = fixture(t), entry = await f.service.create(f.upload());
  assert.throws(() => f.db.prepare('UPDATE room_image_asset_versions SET bytes=?').run(Buffer.alloc(entry.version.byteLength)), /immutable/);
  assert.throws(() => f.db.exec('DELETE FROM room_image_asset_versions'), /Retain/);
  assert.throws(() => f.db.exec("UPDATE room_image_assets SET definition_json='{}'"), /immutable/);
  assert.throws(() => f.db.exec('DELETE FROM room_image_assets'), /Tombstone/);
  assert.throws(() => f.repo.transaction(() => Promise.resolve()), /synchronous/);
  assert.equal(f.db.isTransaction, false);
});

test('dedicated HTTP GET/POST/HEAD preserves protected image headers and actor-scoped recovery', async t => {
  const f = fixture(t), handler = createImageAssetHttpHandler({ service: f.service, getIdentity: () => ({ userId: 'alice', sessionIdentity: 'session-a' }) });
  const server = createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`, input = f.upload();
  const response = await fetch(`${base}/api/rooms/room-a/assets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draft: input.draft, mediaType: 'image/png', operationId: input.operationId, pngBase64: input.bytes.toString('base64') }) });
  assert.equal(response.status, 201); const entry = await response.json();
  for (const method of ['GET', 'HEAD']) {
    const image = await fetch(`${base}/api/rooms/room-a/assets/${entry.definition.assetId}/versions/${entry.version.versionId}/image`, { method });
    assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(image.headers.get('cache-control'), 'private, no-store'); assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(image.headers.get('cross-origin-resource-policy'), 'same-origin'); assert.equal(image.headers.get('access-control-allow-origin'), null);
    assert.equal((await image.arrayBuffer()).byteLength, method === 'HEAD' ? 0 : input.bytes.length);
  }
  assert.equal((await (await fetch(`${base}/api/rooms/room-a/assets/operations/operation-a`)).json()).status, 'committed');
  assert.equal((await fetch(`${base}/api/rooms/room-a/files/protected`)).status, 404);
  f.state.read = false;
  assert.equal((await fetch(`${base}/api/rooms/room-a/assets/${entry.definition.assetId}/versions/${entry.version.versionId}/image`, { method: 'HEAD' })).status, 404);
});

function mockHttp(handler, headers = {}) {
  const req = new EventEmitter(); Object.assign(req, { url: '/api/rooms/room-a/assets', method: 'POST', headers: { 'content-type': 'application/json', ...headers }, resume() {} });
  const res = { status: null, headersSent: false, writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders; this.headersSent = true; }, end(body) { this.body = body; }, destroy() {} };
  return { req, res, pending: handler(req, res) };
}

test('HTTP body has a dedicated cap and rejects aborted, malformed and forged-identity bodies', async t => {
  const f = fixture(t), handler = createImageAssetHttpHandler({ service: f.service, getIdentity: () => f.context });
  const oversized = mockHttp(handler, { 'content-length': String(IMAGE_UPLOAD_JSON_LIMIT + 1) });
  await oversized.pending; assert.equal(oversized.res.status, 413);
  const chunked = mockHttp(handler); chunked.req.emit('data', Buffer.alloc(IMAGE_UPLOAD_JSON_LIMIT + 1)); await chunked.pending; assert.equal(chunked.res.status, 413);
  const aborted = mockHttp(handler); aborted.req.emit('data', Buffer.from('{')); aborted.req.emit('aborted'); await aborted.pending; assert.equal(aborted.res.status, 400);
  for (const body of ['{', JSON.stringify({ userId: 'alice' }), JSON.stringify({ pngBase64: '%%%%' })]) {
    const request = mockHttp(handler); request.req.emit('data', Buffer.from(body)); request.req.emit('end'); await request.pending; assert.equal(request.res.status, 400);
  }
  assert.deepEqual(f.repo.usage('room-a'), { definitions: 0, bytes: 0 });
});

test('HTTP session/role checks cover the body-read await before image validation', async t => {
  const f = fixture(t), handler = createImageAssetHttpHandler({ service: f.service, getIdentity: () => f.context }), input = f.upload();
  const request = mockHttp(handler);
  f.state.manage = false;
  request.req.emit('data', Buffer.from(JSON.stringify({ draft: input.draft, operationId: input.operationId, mediaType: 'image/png', pngBase64: input.bytes.toString('base64') })));
  request.req.emit('end'); await request.pending;
  assert.equal(request.res.status, 403); assert.deepEqual(f.repo.usage('room-a'), { definitions: 0, bytes: 0 });
});

test('physical write switch defaults off, preserves legacy creation and allows receipt reads without new sized writes',async t=>{
 let enabled=false,decodes=0;
 const f=fixture(t,{isPhysicalSizeEnabled:()=>enabled,validateImage:(...args)=>{decodes++;return validatePng(...args);}});
 const sized=f.upload({operationId:'sized',draft:{name:'Sized',widthMetres:2,heightMetres:3}});
 await assert.rejects(f.service.create(sized),code('IMAGE_PHYSICAL_SIZE_DISABLED'));assert.equal(decodes,0);assert.equal(f.repo.usage('room-a').definitions,0);
 const legacy=await f.service.create(f.upload({operationId:'legacy'}));assert.equal(Object.hasOwn(legacy.version,'widthMetres'),false);
 enabled=true;const entry=await f.service.create(sized);const before=f.repo.usage('room-a');enabled=false;
 assert.deepEqual(await f.service.create(sized),entry,'exact committed receipt is still recoverable');
 await assert.rejects(f.service.createVersion({...f.context,assetId:entry.definition.assetId,change:{operationId:'inherited-size',expectedRevision:entry.revision,expectedVersionId:entry.version.versionId,setup:{depthPreset:'floor',depthPivot:.5,collisionGrid:null}}}),code('IMAGE_PHYSICAL_SIZE_DISABLED'));
 assert.deepEqual(f.repo.usage('room-a'),before);assert.equal(f.repo.getOperation('room-a','alice','inherited-size'),null);
});

test('disable during PNG decode and client retirement during decode both reject before reservation or commit',async t=>{
 for(const kind of ['disable','retire'])await t.test(kind,async t=>{
  const hold=deferred(),entered=deferred();let enabled=true,retired=false;
  const f=fixture(t,{isPhysicalSizeEnabled:()=>enabled,validateImage:async(...args)=>{entered.resolve();await hold.promise;return validatePng(...args);}});
  const work=f.service.create(f.upload({operationId:'held-'+kind,draft:{name:'Held',widthMetres:2,heightMetres:3},checkClient:()=>{if(retired){const e=Error('Reload');e.status=426;e.code='CLIENT_RELOAD_REQUIRED';throw e;}}}));
  await entered.promise;if(kind==='disable')enabled=false;else retired=true;hold.resolve();
  await assert.rejects(work,code(kind==='disable'?'IMAGE_PHYSICAL_SIZE_DISABLED':'CLIENT_RELOAD_REQUIRED'));
  assert.equal(f.repo.usage('room-a').definitions,0);assert.equal(f.repo.getOperation('room-a','alice','held-'+kind),null);assert.equal(f.events.length,0);
 });
});

test('receipt committed during parallel decode remains recoverable after publishing is disabled',async t=>{
 const hold=deferred(),entered=deferred();let enabled=true,decodes=0;
 const f=fixture(t,{isPhysicalSizeEnabled:()=>enabled,validateImage:async(...args)=>{if(++decodes===2){entered.resolve();await hold.promise;}return validatePng(...args);}});
 const input=f.upload({operationId:'parallel-size-receipt',draft:{name:'Parallel sized PNG',widthMetres:2,heightMetres:3}});
 const first=f.service.create(input),second=f.service.create(input);await entered.promise;const committed=await first;enabled=false;hold.resolve();
 assert.deepEqual(await second,committed,'a replay needs no newly enabled write');assert.equal(f.repo.usage('room-a').definitions,1);assert.equal(f.events.length,1);
});
