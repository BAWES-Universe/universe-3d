import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {createGameServer} from '../server/app.mjs';
import {createImageAssetRepository, initializeImageAssetSchema} from '../server/image-asset-store.mjs';
import {createImageAssetService, createImageAssetHttpHandler} from '../server/image-assets.mjs';
import {validatePng} from '../server/png-validation.mjs';
import {seedWorlds} from '../src/worlds.js';
import {resolveImagePlacement} from '../src/image-asset-geometry.js';
import {createImageObjectView} from '../src/image-object-view.js';
import {imageTextureKey, createAuthenticatedImageLoader} from '../src/image-asset-loader.js';
import {makePng} from '../fixtures/png-fixtures.mjs';

// Independent black-box requests and raw SQLite observations. No production
// canonicalization, operation-digest, setup-normalization or request helpers.
// Every account, socket, database and byte fixture is disposable and local.
const bytes = makePng({width: 64, height: 96, filter: y => y % 5});
const hash = createHash('sha256').update(bytes).digest('hex');
const sortedJson = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(sortedJson).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + sortedJson(value[key])).join(',') + '}';
const hashJson = value => createHash('sha256').update(sortedJson(value)).digest('hex');
const initialGrid = [[0, 0], [1, 0], [0, 1]];
const revisedGrid = [[1, 0], [0, 0], [0, 0]];
const floorSetup = () => ({depthPreset: 'floor', depthPivot: 0.5, collisionGrid: structuredClone(revisedGrid)});
const customSetup = () => ({depthPreset: 'custom', depthPivot: 0.25, collisionGrid: null});
const ref = entry => ({assetId: entry.definition.assetId, versionId: entry.version.versionId});
const key = entry => `${entry.definition.assetId}:${entry.version.versionId}`;
const root = room => `/api/rooms/${room.id}/assets`;
const assetPath = (room, entry) => `${root(room)}/${entry.definition.assetId}`;
const versionsPath = (room, entry) => `${assetPath(room, entry)}/versions`;
const receiptPath = (room, entry, op) => `${versionsPath(room, entry)}/operations/${op}`;
const imagePath = (room, entry) => `${versionsPath(room, entry)}/${entry.version.versionId}/image`;
const payload = (entry, setup = floorSetup(), operationId = randomUUID()) => ({operationId, expectedRevision: entry.revision, expectedVersionId: entry.version.versionId, setup});
const uploadPayload = (operationId = randomUUID(), draft = {}) => ({operationId, mediaType: 'image/png', pngBase64: bytes.toString('base64'), draft: {name: 'Original immutable name', tags: ['original'], floating: false, depthPreset: 'standing', depthPivot: 1, collisionGrid: structuredClone(initialGrid), ...draft}});
const scene = (areas = []) => ({version: 1, theme: 'garden', bounds: {width: 32, depth: 26}, spawn: {x: 0, z: 10}, objects: [], areas});
const instance = (entry, id = 'old-pin', x = 6) => ({id, type: 'image', name: 'Instance keeps its name', assetRef: ref(entry), x, z: 0, rotation: 0});
const describe = response => JSON.stringify({status: response.status, data: response.data});
function ok(response, status = 200) {assert.equal(response.status, status, describe(response)); return response.data;}
function code(response) {return response.data?.error?.code ?? response.data?.code;}
function reject(response, status = 409, expected) {assert.equal(response.status, status, describe(response)); if (expected) assert.equal(code(response), expected); return response;}
function publishedEntry(result) {return result.entry;}
function client(base, cookie = '') {
  return {cookie, async call(path, method = 'GET', body, extraHeaders = {}) {
    const response = await fetch(base + path, {method, headers: {Cookie: this.cookie, ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...extraHeaders}, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body)});
    if (response.headers.get('set-cookie')) this.cookie = response.headers.get('set-cookie').split(';')[0];
    const raw = Buffer.from(await response.arrayBuffer());
    return {status: response.status, headers: response.headers, bytes: raw, data: response.headers.get('content-type')?.includes('application/json') && raw.length ? JSON.parse(raw) : undefined};
  }};
}
async function startApp(database = ':memory:') {
  const app = createGameServer({database, seeds: seedWorlds});
  const {port} = await app.listen(0), base = `http://127.0.0.1:${port}`;
  const account = async name => {const c = client(base); c.user = ok(await c.call('/api/session', 'POST', {name}), 201).user; return c;};
  return {app, port, base, client: cookie => client(base, cookie), account};
}
async function joinRoom(actor, room) {const data = ok(await actor.call(`/api/rooms/${room.id}/join`, 'POST', {})); actor.admission = Object.fromEntries(['admissionId', 'admissionEpoch', 'admissionRevision'].map(key => [key, data.arrival[key]])); return data.room;}
async function latest(actor, room) {return ok(await actor.call(`/api/rooms/${room.id}`)).room;}
async function newRoom(owner, world, areas = []) {return ok(await owner.call('/api/rooms', 'POST', {worldId: world.id, name: 'Version authority ' + randomUUID(), scene: scene(areas)}), 201).room;}
async function fixture(t, areas = []) {
  const f = await startApp(); t.after(() => f.app.close());
  const owner = await f.account('Version manager'), peer = await f.account('Independent version editor'), reader = await f.account('Ordinary image reader');
  const world = ok(await owner.call('/api/worlds', 'POST', {name: 'Independent local version fixture'}), 201).world;
  const room = await newRoom(owner, world, areas);
  for (const c of [owner, peer, reader]) await joinRoom(c, room);
  ok(await owner.call(`/api/rooms/${room.id}/members/${peer.user.id}`, 'PUT', {role: 'editor'}));
  return {...f, owner, peer, reader, world, room};
}
async function upload(actor, room, body = uploadPayload()) {return ok(await actor.call(root(room), 'POST', body), 201);}
async function publish(actor, room, entry, body = payload(entry)) {return ok(await actor.call(versionsPath(room, entry), 'POST', body), 201);}
async function save(actor, room, mutate) {
  const current = await latest(actor, room), next = structuredClone(current.scene); mutate(next);
  return actor.call(`/api/rooms/${room.id}/scene`, 'PUT', {revision: current.revision, scene: next, personalAreaRevisions: Object.fromEntries(current.personalAreas.map(area => [area.areaId, area.revision]))});
}
function snapshot(db) {
  return {
    assets: db.prepare('SELECT * FROM room_image_assets ORDER BY room_id,asset_id').all(),
    versions: db.prepare('SELECT room_id,asset_id,version_id,sequence,version_json,sha256,byte_length,hex(bytes) AS bytes_hex FROM room_image_asset_versions ORDER BY room_id,asset_id,sequence').all(),
    operations: db.prepare('SELECT * FROM room_image_asset_operations ORDER BY room_id,user_id,operation_id').all(),
  };
}
function actualUsage(db, room) {return {...db.prepare('SELECT count(*) AS versions,coalesce(sum(length(bytes)),0) AS bytes FROM room_image_asset_versions WHERE room_id=?').get(room.id)};}
function expectPublication(result, before, setup, actorId) {
  const next = publishedEntry(result);
  assert.equal(result.status, 'committed');
  assert.deepEqual(next.definition, before.definition);
  assert.deepEqual(next.metadata, before.metadata);
  assert.equal(next.status, 'active'); assert.equal(next.revision, before.revision + 1);
  assert.deepEqual(result.published, {assetId: before.definition.assetId, versionId: next.version.versionId, sequence: before.version.sequence + 1});
  assert.notEqual(next.version.versionId, before.version.versionId);
  assert.deepEqual(next.version, {...before.version, versionId: next.version.versionId, sequence: before.version.sequence + 1, createdAt: next.version.createdAt, createdBy: actorId,
    representation: setup.depthPreset === 'floor' ? 'floor' : 'upright', depthPreset: setup.depthPreset, depthPivot: setup.depthPivot, collisionGrid: setup.collisionGrid});
  assert.equal(next.version.sha256, hash); assert.equal(next.version.byteLength, bytes.length);
  return next;
}
function partial(port, cookie, path, body, method = 'POST') {
  const encoded = Buffer.from(JSON.stringify(body)), split = Math.floor(encoded.length / 2); let request;
  const result = new Promise((resolve, rejectPromise) => {
    request = http.request({host: '127.0.0.1', port, path, method, headers: {Cookie: cookie, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked'}}, response => {
      let raw = ''; response.on('data', chunk => {raw += chunk;}); response.on('end', () => resolve({status: response.statusCode, data: raw ? JSON.parse(raw) : undefined}));
    });
    request.on('error', rejectPromise); request.write(encoded.subarray(0, split));
  });
  return {result, finish: () => request.end(encoded.subarray(split)), destroy: () => request.destroy()};
}
function watchAdmission(t, app, userId) {
  let resolve; const admitted = new Promise(done => {resolve = done;}), original = app.store.authorize.bind(app.store);
  app.store.authorize = (...args) => {const value = original(...args); if (args[1] === userId) resolve(); return value;};
  t.after(() => {app.store.authorize = original;});
  return admitted;
}
async function admitted(promise, pending) {await Promise.race([promise, pending.result.then(response => assert.fail('Request ended before streamed admission: ' + describe(response)))]);}

test('independent versions: trusted image facts and saved exact pins survive a setup publication', async t => {
  const f = await fixture(t), {owner, room, reader, app} = f;
  let v1 = await upload(owner, room);
  v1 = ok(await owner.call(assetPath(room, v1), 'PATCH', {expectedRevision: 1, metadata: {name: 'Discovery renamed', description: 'Mutable discovery only', tags: ['renamed']}}));
  ok(await save(owner, room, draft => draft.objects.push(instance(v1))));
  const before = await latest(reader, room), persisted = app.store.get('SELECT scene,revision FROM rooms WHERE id=?', room.id);
  const oldGeometry = resolveImagePlacement(before.imageDefinitions[key(v1)], before.scene.objects[0]);
  assert.deepEqual(oldGeometry.render.localCorners, [{x: -1, y: 3, z: 1.5}, {x: 1, y: 3, z: 1.5}, {x: 1, y: 0, z: 1.5}, {x: -1, y: 0, z: 1.5}]);
  assert.deepEqual(oldGeometry.collisionCells.map(cell => [cell.row, cell.col, cell.x, cell.z]), [[1, 0, 5.5, 0], [2, 1, 6.5, 1]]);
  const body = payload(v1), result = await publish(owner, room, v1, body), v2 = expectPublication(result, v1, body.setup, owner.user.id);
  assert.equal(v2.version.name, 'Original immutable name'); assert.deepEqual(v2.version.tags, ['original']);
  assert.deepEqual(app.store.get('SELECT scene,revision FROM rooms WHERE id=?', room.id), persisted);
  const after = await latest(reader, room);
  assert.deepEqual(after.scene, before.scene); assert.deepEqual(after.imageDefinitions[key(v1)].version, v1.version);
  assert.equal(after.imageDefinitions[key(v2)], undefined);
  assert.deepEqual(resolveImagePlacement(after.imageDefinitions[key(v1)], after.scene.objects[0]), oldGeometry);
  for (const entry of [v1, v2]) for (const method of ['GET', 'HEAD']) {
    const response = await reader.call(imagePath(room, entry), method); ok(response);
    assert.deepEqual(response.bytes, method === 'HEAD' ? Buffer.alloc(0) : bytes);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
  reject(await save(reader, room, draft => draft.objects.push(instance(v2, 'reader-forged', -6))), 403);
  ok(await save(owner, room, draft => draft.objects.push(instance(v2, 'explicit-v2', -6))));
  const saved = await latest(reader, room);
  assert.deepEqual(saved.scene.objects.map(object => object.assetRef), [ref(v1), ref(v2)]);
  const v2Geometry = resolveImagePlacement(saved.imageDefinitions[key(v2)], saved.scene.objects[1]);
  assert.equal(v2Geometry.render.representation, 'floor');
  assert.deepEqual(v2Geometry.collisionCells.map(cell => [cell.row, cell.col, cell.x, cell.z]), [[0, 0, -6.5, -1]]);
  assert.deepEqual(actualUsage(app.store.db, room), {versions: 2, bytes: bytes.length * 2});
});

test('independent versions: stale competing editors cannot overwrite pointer or reserve losing operation', async t => {
  const {owner, peer, room, app} = await fixture(t), v1 = await upload(owner, room);
  const a = payload(v1, floorSetup(), 'editor-a'), b = payload(v1, customSetup(), 'editor-b');
  const responses = await Promise.all([owner.call(versionsPath(room, v1), 'POST', a), peer.call(versionsPath(room, v1), 'POST', b)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  const winner = responses.find(response => response.status === 201).data;
  const after = snapshot(app.store.db);
  for (const [actor, body] of [[owner, a], [peer, b]]) {
    const receipt = ok(await actor.call(receiptPath(room, v1, body.operationId)));
    if (winner.published.versionId === responses[actor === owner ? 0 : 1].data?.published?.versionId) assert.equal(receipt.status, 'committed');
    else {assert.deepEqual(receipt, {status: 'not-found'}); reject(await actor.call(versionsPath(room, v1), 'POST', body));}
  }
  assert.deepEqual(snapshot(app.store.db), after); assert.equal(actualUsage(app.store.db, room).versions, 2);
  assert.equal(ok(await owner.call(root(room))).entries[0].version.versionId, winner.published.versionId);
});

test('independent versions: concurrent duplicate HTTP saves emit one minimal durable room invalidation', {timeout: 15000}, async t => {
  const {owner, reader, room, app, base} = await fixture(t), v1 = await upload(owner, room), body = payload(v1, floorSetup(), 'same-operation');
  const abort = new AbortController(), response = await fetch(base + '/api/events', {headers: {Cookie: reader.cookie}, signal: abort.signal}); assert.equal(response.status, 200);
  const events = [], waiters = []; let buffered = '';
  const reading = (async () => {
    try {
      for await (const chunk of response.body) {
        buffered += new TextDecoder().decode(chunk); let end;
        while ((end = buffered.indexOf('\n\n')) !== -1) {
          const record = buffered.slice(0, end); buffered = buffered.slice(end + 2);
          const event = record.match(/^event: (.+)$/m)?.[1], data = record.match(/^data: (.+)$/m)?.[1];
          if (event && data) {const value = {event, data: JSON.parse(data)}; events.push(value); for (const waiter of waiters) if (waiter.predicate(value)) waiter.resolve(value);}
        }
      }
    } catch (error) {if (!abort.signal.aborted) throw error;}
  })();
  const close = async () => {abort.abort(); await reading;}; t.after(close);
  const waitFor = predicate => events.find(predicate) ?? new Promise(resolve => waiters.push({predicate, resolve}));
  await waitFor(event => event.event === 'hello');
  const [first, duplicate] = await Promise.all([publish(owner, room, v1, body), publish(owner, room, v1, body)]); assert.deepEqual(duplicate, first);
  const v2 = publishedEntry(first), delivered = await waitFor(event => event.event === 'image-assets' && event.data.revision === 2);
  assert.deepEqual(delivered.data, {type: 'imageAsset.versionCreated', roomId: room.id, assetId: v1.definition.assetId, versionId: v2.version.versionId, revision: 2, status: 'active'});
  const before = snapshot(app.store.db); assert.deepEqual(await publish(owner, room, v1, body), first); assert.deepEqual(snapshot(app.store.db), before);
  // A later ordered SSE event is a barrier for all earlier replay work, so this
  // exact-one assertion does not depend on a sleep or absence timeout.
  ok(await owner.call(assetPath(room, v2), 'PATCH', {expectedRevision: 2, metadata: {name: 'Ordered barrier', description: ''}}));
  await waitFor(event => event.event === 'image-assets' && event.data.revision === 3);
  assert.equal(events.filter(event => event.event === 'image-assets' && event.data.type === 'imageAsset.versionCreated').length, 1);
  assert.equal(events.filter(event => event.event === 'scene').length, 0); assert.equal(actualUsage(app.store.db, room).versions, 2);
  await close();
});

test('independent versions: saved-v2 then peer-v3 replay reports current-v3 and original published-v2', async t => {
  const {owner, peer, room, app} = await fixture(t), v1 = await upload(owner, room), body = payload(v1, floorSetup(), 'save-v2');
  const result2 = await publish(owner, room, v1, body), v2 = publishedEntry(result2);
  const result3 = await publish(peer, room, v2, payload(v2, customSetup(), 'peer-v3')), v3 = publishedEntry(result3), before = snapshot(app.store.db);
  for (let repeat = 0; repeat < 2; repeat++) {
    const replay = await publish(owner, room, v1, body);
    assert.deepEqual(replay, {status: 'committed', entry: v3, published: result2.published});
    assert.deepEqual(ok(await owner.call(receiptPath(room, v1, body.operationId))), {status: 'committed', entry: v3, published: result2.published});
  }
  // Object key ordering is irrelevant; changing any exact operation input is not.
  assert.deepEqual(await publish(owner, room, v1, {setup: {collisionGrid: body.setup.collisionGrid, depthPivot: 0.5, depthPreset: 'floor'}, expectedVersionId: body.expectedVersionId, expectedRevision: body.expectedRevision, operationId: body.operationId}), {status: 'committed', entry: v3, published: result2.published});
  for (const change of [{expectedRevision: 2}, {expectedVersionId: v2.version.versionId}, {setup: customSetup()}]) reject(await owner.call(versionsPath(room, v1), 'POST', {...body, ...change}), 409, 'IMAGE_OPERATION_CONFLICT');
  assert.deepEqual(snapshot(app.store.db), before);
});

test('independent versions: operation kinds, actor, asset and room remain disjoint', async t => {
  const {owner, peer, reader, room, app, world} = await fixture(t), legacyBody = uploadPayload('legacy-op'), v1 = await upload(owner, room, legacyBody), otherAsset = await upload(owner, room);
  const before = snapshot(app.store.db);
  reject(await owner.call(versionsPath(room, v1), 'POST', payload(v1, floorSetup(), 'legacy-op')), 409, 'IMAGE_OPERATION_CONFLICT');
  assert.deepEqual(snapshot(app.store.db), before);
  const body = payload(v1, floorSetup(), 'version-op'), result = await publish(owner, room, v1, body);
  reject(await owner.call(root(room), 'POST', uploadPayload('version-op')), 409, 'IMAGE_OPERATION_CONFLICT');
  reject(await owner.call(versionsPath(room, otherAsset), 'POST', {...body, expectedVersionId: otherAsset.version.versionId}), 409, 'IMAGE_OPERATION_CONFLICT');
  assert.deepEqual(ok(await peer.call(receiptPath(room, v1, body.operationId))), {status: 'not-found'});
  assert.deepEqual(ok(await owner.call(receiptPath(room, otherAsset, body.operationId))), {status: 'not-found'});
  reject(await reader.call(receiptPath(room, v1, body.operationId)), 403);
  assert.deepEqual(await upload(owner, room, legacyBody), {...v1, revision: 2});
  assert.deepEqual(ok(await owner.call(`${root(room)}/operations/legacy-op`)).entry, {...v1, revision: 2});
  const foreign = await newRoom(owner, world); await joinRoom(owner, foreign);
  reject(await owner.call(versionsPath(foreign, v1), 'POST', payload(v1)), 404);
  assert.deepEqual(ok(await owner.call(receiptPath(foreign, v1, body.operationId))), {status: 'not-found'});
  reject(await owner.call(versionsPath(room, v1), 'POST', body), 401);
  await joinRoom(owner, room);
  assert.deepEqual((await publish(owner, room, v1, body)).published, result.published);
});

test('independent versions: unknown keys, forged facts, malformed grids and invalid setup leave all rows unchanged', async t => {
  const {owner, room, app} = await fixture(t), v1 = await upload(owner, room), good = payload(v1), before = snapshot(app.store.db);
  const invalid = [null, [], {}, {...good, expectedRevision: '1'}, {...good, expectedRevision: 0}, {...good, expectedRevision: Number.MAX_SAFE_INTEGER + 1}, {...good, expectedVersionId: 'bad/id'},
    {...good, operationId: ''}, {...good, roomId: room.id}, {...good, userId: owner.user.id}, {...good, canManage: true}, {...good, version: v1.version}, {...good, bytes: []}, {...good, pngBase64: bytes.toString('base64')},
    ...[null, [], {}, {depthPreset: 'floor'}, {depthPreset: 'floor', depthPivot: 1, collisionGrid: null}, {depthPreset: 'custom', depthPivot: -0.01, collisionGrid: null}, {depthPreset: 'custom', depthPivot: 1.01, collisionGrid: null}, {depthPreset: 'custom', depthPivot: '0.5', collisionGrid: null}, {depthPreset: 'standing', depthPivot: 1, collisionGrid: [[1]]}, {depthPreset: 'standing', depthPivot: 1, collisionGrid: [[0, 0], [0, 0], [0, true]]}, {depthPreset: 'standing', depthPivot: 1, collisionGrid: [[0, 0], [0, 0], [0, 2]]}, ...['floating', 'representation', 'widthPixels', 'heightPixels', 'sha256', 'name', 'tags', 'versionId'].map(field => ({...floorSetup(), [field]: v1.version[field]}))].map(setup => ({...good, setup}))];
  for (const body of invalid) reject(await owner.call(versionsPath(room, v1), 'POST', body), 400);
  reject(await owner.call(versionsPath(room, v1), 'POST', good, {'Content-Encoding': 'gzip'}), 415);
  reject(await owner.call(versionsPath(room, v1), 'POST', Buffer.alloc(64 * 1024, 32)), 413);
  assert.deepEqual(snapshot(app.store.db), before);
});

test('independent versions: no-op reserves nothing, both CAS coordinates matter, and floating remains immutable', async t => {
  const {owner, room, app} = await fixture(t), v1 = await upload(owner, room), before = snapshot(app.store.db);
  const unchanged = {depthPreset: 'standing', depthPivot: 1, collisionGrid: initialGrid}, body = payload(v1, unchanged, 'unchanged-then-valid');
  reject(await owner.call(versionsPath(room, v1), 'POST', body), 400, 'IMAGE_SETUP_UNCHANGED');
  reject(await owner.call(versionsPath(room, v1), 'POST', {...body, setup: floorSetup(), expectedVersionId: 'different-version'}), 409, 'IMAGE_VERSION_CONFLICT');
  reject(await owner.call(versionsPath(room, v1), 'POST', {...body, setup: floorSetup(), expectedRevision: 2}), 409, 'IMAGE_REVISION_CONFLICT');
  assert.deepEqual(ok(await owner.call(receiptPath(room, v1, body.operationId))), {status: 'not-found'}); assert.deepEqual(snapshot(app.store.db), before);
  const next = expectPublication(await publish(owner, room, v1, {...body, setup: floorSetup()}), v1, floorSetup(), owner.user.id); assert.equal(next.version.floating, false);
  const floating = await upload(owner, room, uploadPayload('floating-fixture', {floating: true, collisionGrid: null})), floatingBefore = snapshot(app.store.db);
  reject(await owner.call(versionsPath(room, floating), 'POST', payload(floating, floorSetup())), 400);
  reject(await owner.call(versionsPath(room, floating), 'POST', payload(floating, {...customSetup(), floating: false})), 400);
  assert.deepEqual(snapshot(app.store.db), floatingBefore);
  const changedFloating = expectPublication(await publish(owner, room, floating, payload(floating, customSetup())), floating, customSetup(), owner.user.id); assert.equal(changedFloating.version.floating, true);
});

test('independent versions: archive retains every byte, restricts exact reads and denies fresh publication', async t => {
  const {owner, reader, room, app} = await fixture(t), v1 = await upload(owner, room), body = payload(v1), result = await publish(owner, room, v1, body), v2 = publishedEntry(result);
  ok(await save(owner, room, draft => draft.objects.push(instance(v1))));
  const archived = ok(await owner.call(assetPath(room, v2), 'PATCH', {expectedRevision: v2.revision, status: 'archived'})), before = snapshot(app.store.db);
  reject(await owner.call(versionsPath(room, v2), 'POST', payload(archived, customSetup())), 409, 'IMAGE_ARCHIVED');
  for (const method of ['GET', 'HEAD']) {
    ok(await reader.call(imagePath(room, v1), method)); reject(await reader.call(imagePath(room, v2), method), 404);
    ok(await owner.call(imagePath(room, v1), method)); ok(await owner.call(imagePath(room, v2), method));
  }
  assert.deepEqual(await publish(owner, room, v1, body), {status: 'committed', entry: archived, published: result.published});
  assert.deepEqual(ok(await owner.call(receiptPath(room, v1, body.operationId))), {status: 'committed', entry: archived, published: result.published});
  assert.deepEqual(snapshot(app.store.db), before); assert.deepEqual(actualUsage(app.store.db, room), {versions: 2, bytes: bytes.length * 2});
  reject(await save(owner, room, draft => draft.objects.push(instance(v2, 'new-archived', -6))), 409);
  ok(await save(owner, room, draft => {draft.objects = [];}));
  reject(await reader.call(imagePath(room, v1)), 404);
  const restored = ok(await owner.call(assetPath(room, v2), 'PATCH', {expectedRevision: archived.revision, status: 'active'}));
  expectPublication(await publish(owner, room, restored, payload(restored, customSetup())), restored, customSetup(), owner.user.id);
});

test('independent versions: demoted publisher loses version receipt access even for pinned versions', async t => {
  const {owner, peer, room} = await fixture(t), v1 = await upload(owner, room), body = payload(v1), result = await publish(peer, room, v1, body), v2 = publishedEntry(result);
  ok(await save(owner, room, draft => draft.objects.push(instance(v2))));
  ok(await owner.call(`/api/rooms/${room.id}/members/${peer.user.id}`, 'PUT', {role: 'member'}));
  reject(await peer.call(receiptPath(room, v1, body.operationId)), 403);
  reject(await peer.call(versionsPath(room, v1), 'POST', body), 403);
  ok(await peer.call(imagePath(room, v2)));
});

test('independent versions: scoped owner may explicitly place current version inside owned area, never publish', async t => {
  const area = {id: 'desk', name: 'Desk', x: -6, z: 0, width: 8, depth: 8, action: 'welcome', personalArea: {mode: 'dynamic', allowedTags: []}};
  const {owner, reader, room} = await fixture(t, [area]), v1 = await upload(owner, room), body = payload(v1), v2 = publishedEntry(await publish(owner, room, v1, body));
  ok(await reader.call('/api/account', 'POST', {username: 'iv_' + randomUUID().replaceAll('-', '').slice(0, 18), password: 'disposable independent fixture password'}), 201);
  const target = (await joinRoom(reader, room)).personalAreas[0];
  ok(await reader.call('/api/presence', 'POST', {roomId: room.id, x: -6, z: 0}));
  ok(await reader.call(`/api/rooms/${room.id}/personal-areas/desk/claim`, 'POST', {revision: target.revision, clientOperationId: randomUUID()}));
  reject(await reader.call(versionsPath(room, v2), 'POST', payload(v2, customSetup())), 403);
  reject(await reader.call(receiptPath(room, v1, body.operationId)), 403);
  ok(await save(reader, room, draft => draft.objects.push(instance(v2, 'owned-current', -6))));
  reject(await save(reader, room, draft => {draft.objects[0].x = -2.9;}), 403);
  const current = await latest(owner, room), owned = current.personalAreas[0];
  ok(await owner.call(`/api/rooms/${room.id}/personal-areas/desk/revoke`, 'POST', {revision: owned.revision, roomRevision: current.revision, objectHandling: 'keep', clientOperationId: randomUUID()}));
  reject(await save(reader, room, draft => draft.objects.push(instance(v2, 'revoked-copy', -7))), 403);
});

for (const mutation of ['role', 'private-ancestor', 'room-switch', 'leave-rejoin', 'logout', 'actor-swap', 'expiry']) for (const mode of ['fresh', 'receipt-replay']) {
  test(`independent versions: streamed ${mode} rejects ${mutation} before any write`, {timeout: 15000}, async t => {
    const {app, port, owner, peer, room, world} = await fixture(t), v1 = await upload(owner, room), foreign = mutation === 'room-switch' ? await newRoom(owner, world) : null;
    const body = payload(v1); if (mode === 'receipt-replay') await publish(peer, room, v1, body);
    const before = snapshot(app.store.db), access = watchAdmission(t, app, peer.user.id), pending = partial(port, peer.cookie, versionsPath(room, v1), body);
    t.after(pending.destroy); await admitted(access, pending);
    if (mutation === 'role') ok(await owner.call(`/api/rooms/${room.id}/members/${peer.user.id}`, 'PUT', {role: 'member'}));
    if (mutation === 'private-ancestor') {ok(await owner.call(`/api/rooms/${room.id}/members/${peer.user.id}`, 'DELETE')); ok(await owner.call(`/api/worlds/${world.id}`, 'PATCH', {public: false}));}
    if (mutation === 'room-switch') await joinRoom(peer, foreign);
    if (mutation === 'leave-rejoin') {ok(await peer.call(`/api/rooms/${room.id}/leave`, 'POST', {})); await joinRoom(peer, room);}
    if (mutation === 'logout') ok(await peer.call('/api/logout', 'POST', {}));
    if (mutation === 'actor-swap') app.store.run('UPDATE sessions SET user_id=? WHERE user_id=?', owner.user.id, peer.user.id);
    if (mutation === 'expiry') app.store.run('UPDATE sessions SET expires_at=0 WHERE user_id=?', peer.user.id);
    pending.finish(); const response = await pending.result;
    assert.ok([401, 403, 404, 409].includes(response.status), describe(response));
    if (mutation === 'leave-rejoin') assert.equal(code(response), 'IMAGE_SESSION_CHANGED');
    assert.deepEqual(snapshot(app.store.db), before);
  });
}

test('independent versions: write-transaction authority denial wins over initial HTTP authorization', async t => {
  const {app, owner, room} = await fixture(t), v1 = await upload(owner, room), before = snapshot(app.store.db), original = app.store.authorize.bind(app.store); let inside = 0;
  app.store.authorize = (...args) => {const result = original(...args); if (args[1] === owner.user.id && app.store.db.isTransaction) {inside++; return {...result, role: 'member'};} return result;};
  t.after(() => {app.store.authorize = original;});
  reject(await owner.call(versionsPath(room, v1), 'POST', payload(v1)), 403); assert.ok(inside > 0); assert.deepEqual(snapshot(app.store.db), before);
});

test('independent versions: archive and metadata races invalidate pending setup without changing scene', {timeout: 15000}, async t => {
  for (const mutation of ['archive', 'metadata']) {
    const {app, port, owner, peer, room} = await fixture(t), v1 = await upload(owner, room), access = watchAdmission(t, app, peer.user.id), pending = partial(port, peer.cookie, versionsPath(room, v1), payload(v1));
    t.after(pending.destroy); await admitted(access, pending);
    const change = mutation === 'archive' ? {status: 'archived'} : {metadata: {name: 'Race winner', description: ''}};
    ok(await owner.call(assetPath(room, v1), 'PATCH', {expectedRevision: 1, ...change})); const before = snapshot(app.store.db);
    pending.finish(); reject(await pending.result); assert.deepEqual(snapshot(app.store.db), before);
  }
});

test('independent versions: a pending saved placement keeps its reviewed version when library publication wins first', {timeout: 15000}, async t => {
  const {app, port, owner, peer, reader, room} = await fixture(t), v1 = await upload(owner, room), current = await latest(peer, room), next = structuredClone(current.scene);
  next.objects.push(instance(v1));
  const access = watchAdmission(t, app, peer.user.id), pending = partial(port, peer.cookie, `/api/rooms/${room.id}/scene`, {revision: current.revision, scene: next}, 'PUT');
  t.after(pending.destroy); await admitted(access, pending);
  const v2 = publishedEntry(await publish(owner, room, v1));
  pending.finish(); ok(await pending.result);
  const saved = await latest(reader, room);
  assert.deepEqual(saved.scene.objects[0].assetRef, ref(v1)); assert.deepEqual(saved.imageDefinitions[key(v1)].version, v1.version); assert.equal(saved.imageDefinitions[key(v2)], undefined);
  assert.equal(resolveImagePlacement(saved.imageDefinitions[key(v1)], saved.scene.objects[0]).collisionCells.length, 2);
});

test('independent versions: a pending explicit new-version placement still loses to current authority revocation', {timeout: 15000}, async t => {
  const {app, port, owner, peer, room} = await fixture(t), v1 = await upload(owner, room), v2 = publishedEntry(await publish(owner, room, v1)), current = await latest(peer, room), next = structuredClone(current.scene);
  next.objects.push(instance(v2));
  const access = watchAdmission(t, app, peer.user.id), pending = partial(port, peer.cookie, `/api/rooms/${room.id}/scene`, {revision: current.revision, scene: next}, 'PUT');
  t.after(pending.destroy); await admitted(access, pending);
  ok(await owner.call(`/api/rooms/${room.id}/members/${peer.user.id}`, 'PUT', {role: 'member'}));
  pending.finish(); reject(await pending.result, 403);
  const saved = await latest(owner, room); assert.deepEqual(saved.scene, current.scene); assert.equal(saved.revision, current.revision);
});

test('independent versions: current v2 scene protocol retains prepared old pins and reauthorizes explicit new placements', async t => {
  const {owner, peer, reader, room} = await fixture(t), v1 = await upload(owner, room), base = await latest(owner, room);
  // This fixture has no areas or terrain. Object-only operations have exactly
  // this dependency preimage, independently constructed from its known scene.
  const batch = (actor, snapshot, placed) => ({version: 2, operationId: randomUUID(), baseRevision: snapshot.revision,
    contextHash: hashJson({version: 1}), dependenciesHash: hashJson({version: 1, bounds: snapshot.scene.bounds, spawn: snapshot.scene.spawn, areas: [], objects: [], terrain: []}),
    operations: [{kind: 'object', id: placed.id, before: null, after: placed}], personalAreaRevisions: {}, admission: actor.admission});
  const preparedOld = batch(owner, base, instance(v1)), v2 = publishedEntry(await publish(owner, room, v1));
  const post = (actor, body) => actor.call(`/api/rooms/${room.id}/scene/operations`, 'POST', body);
  ok(await post(owner, preparedOld));
  const oldSaved = await latest(reader, room); assert.deepEqual(oldSaved.scene.objects[0].assetRef, ref(v1)); assert.deepEqual(oldSaved.imageDefinitions[key(v1)].version, v1.version);
  const preparedNew = batch(peer, oldSaved, instance(v2, 'explicit-v2-operation', -6));
  ok(await owner.call(`/api/rooms/${room.id}/members/${peer.user.id}`, 'PUT', {role: 'member'}));
  reject(await post(peer, preparedNew), 403); assert.deepEqual((await latest(owner, room)).scene, oldSaved.scene);
  const accepted = ok(await post(owner, batch(owner, oldSaved, instance(v2, 'explicit-v2-operation', -6))));
  assert.deepEqual(accepted.room.scene.objects.map(object => object.assetRef), [ref(v1), ref(v2)]);
  const first = resolveImagePlacement(accepted.room.imageDefinitions[key(v1)], accepted.room.scene.objects[0]), second = resolveImagePlacement(accepted.room.imageDefinitions[key(v2)], accepted.room.scene.objects[1]);
  assert.equal(first.render.representation, 'upright'); assert.equal(first.collisionCells.length, 2); assert.equal(second.render.representation, 'floor'); assert.equal(second.collisionCells.length, 1);
});

// A standalone HTTP host retains the same public transport and SQLite schema,
// while allowing deliberately tiny quotas and deterministic write-fault hooks.
async function storageHost(t, {database = ':memory:', limits = {}, events = [], loseResponse = false, closeAutomatically = true} = {}) {
  const db = new DatabaseSync(database); db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000'); initializeImageAssetSchema(db);
  const repo = createImageAssetRepository(db), state = {manage: true, read: true, epoch: 1};
  const service = createImageAssetService({repo, limits, validateImage: validatePng, now: () => Date.parse('2026-10-04T00:00:00.000Z'),
    resolveSession: token => token === 'local-manager' ? {userId: 'manager', currentRoomId: 'fixture-room', expiresAt: Date.parse('2026-10-05T00:00:00.000Z'), sessionEpoch: state.epoch} : null,
    authorizeRead: () => state.read, authorizeManage: () => state.manage,
    afterCommit: event => {assert.equal(db.isTransaction, false); events.push(event);},
  });
  const handler = createImageAssetHttpHandler({service, getIdentity: req => ({userId: 'manager', sessionIdentity: req.headers.cookie})});
  let lose = loseResponse;
  const server = http.createServer(async (req, res) => {
    if (lose && req.method === 'POST' && /\/versions$/.test(req.url)) {lose = false; res.end = () => res.destroy();}
    if (!await handler(req, res)) {res.writeHead(404); res.end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  const close = async () => {if (closed) return; closed = true; await new Promise(resolve => server.close(resolve)); db.close();};
  if (closeAutomatically) t.after(close);
  return {db, repo, service, state, events, close, port: server.address().port, actor: client(`http://127.0.0.1:${server.address().port}`, 'local-manager'), room: {id: 'fixture-room'}};
}

test('independent versions: actual retained BLOB quota and idempotent events remain honest after archive', async t => {
  const {db, repo, actor, room, events} = await storageHost(t, {limits: {maxRoomBytes: bytes.length * 2}}), v1 = await upload(actor, room), body = payload(v1), result = await publish(actor, room, v1, body), v2 = publishedEntry(result);
  assert.deepEqual(actualUsage(db, room), {versions: 2, bytes: bytes.length * 2}); assert.equal(repo.usage(room.id).bytes, bytes.length * 2); assert.equal(events.length, 2);
  assert.deepEqual(await publish(actor, room, v1, body), result); assert.equal(events.length, 2);
  const before = snapshot(db); reject(await actor.call(versionsPath(room, v2), 'POST', payload(v2, customSetup())), 409, 'IMAGE_ROOM_QUOTA'); assert.deepEqual(snapshot(db), before);
  const archived = ok(await actor.call(assetPath(room, v2), 'PATCH', {expectedRevision: 2, status: 'archived'})); assert.equal(events.length, 3);
  assert.equal(repo.usage(room.id).bytes, bytes.length * 2); reject(await actor.call(root(room), 'POST', uploadPayload()), 409, 'IMAGE_ROOM_QUOTA');
  assert.deepEqual(await publish(actor, room, v1, body), {status: 'committed', entry: archived, published: result.published}); assert.equal(events.length, 3);
});

test('independent versions: lost HTTP response, SQLite reopen and double replay cannot duplicate receipt bytes or event', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'independent-image-version-')); t.after(() => rm(directory, {recursive: true, force: true}));
  const database = join(directory, 'images.sqlite'), events = [];
  let f = await storageHost(t, {database, events, loseResponse: true, closeAutomatically: false}); t.after(() => f.close());
  const v1 = await upload(f.actor, f.room), body = payload(v1, floorSetup(), 'lost-response');
  await assert.rejects(f.actor.call(versionsPath(f.room, v1), 'POST', body));
  assert.equal(events.length, 2); const committed = snapshot(f.db); assert.equal(committed.versions.length, 2);
  await f.close(); f = await storageHost(t, {database, events, closeAutomatically: false});
  const receipt = ok(await f.actor.call(receiptPath(f.room, v1, body.operationId))); assert.equal(receipt.status, 'committed');
  for (let count = 0; count < 2; count++) assert.deepEqual(await publish(f.actor, f.room, v1, body), {status: 'committed', entry: receipt.entry, published: receipt.published});
  assert.equal(events.length, 2); assert.deepEqual(snapshot(f.db), committed);
});

test('independent versions: pre-kind upload receipts migrate without changing digest or replay identity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'independent-image-migration-')); t.after(() => rm(directory, {recursive: true, force: true}));
  const database = join(directory, 'images.sqlite'); let f = await storageHost(t, {database, closeAutomatically: false}); t.after(() => f.close());
  const body = uploadPayload('old-upload-receipt'), v1 = await upload(f.actor, f.room, body);
  // Independently reproduce the legacy request digest from known raw request
  // fields. This intentionally does not import the implementation's helper.
  const expectedDigest = createHash('sha256').update(sortedJson({draft: body.draft, mediaType: 'image/png', sha256: hash})).digest('hex');
  assert.equal(f.db.prepare('SELECT request_digest FROM room_image_asset_operations WHERE operation_id=?').get(body.operationId).request_digest, expectedDigest);
  f.db.exec('ALTER TABLE room_image_asset_operations DROP COLUMN operation_kind'); const legacy = snapshot(f.db); await f.close();
  f = await storageHost(t, {database, closeAutomatically: false});
  assert.deepEqual(snapshot(f.db).assets, legacy.assets); assert.deepEqual(snapshot(f.db).versions, legacy.versions);
  const migrated = f.db.prepare('SELECT * FROM room_image_asset_operations WHERE operation_id=?').get(body.operationId); assert.equal(migrated.operation_kind, 'upload'); assert.equal(migrated.request_digest, expectedDigest);
  assert.deepEqual(await upload(f.actor, f.room, body), v1);
  assert.deepEqual(ok(await f.actor.call(`${root(f.room)}/operations/${body.operationId}`)), {status: 'committed', entry: v1});
  reject(await f.actor.call(versionsPath(f.room, v1), 'POST', payload(v1, floorSetup(), body.operationId)), 409, 'IMAGE_OPERATION_CONFLICT');
  const result = await publish(f.actor, f.room, v1), v2 = publishedEntry(result);
  const renamed = ok(await f.actor.call(assetPath(f.room, v2), 'PATCH', {expectedRevision: v2.revision, metadata: {name: 'Post-migration', description: ''}}));
  const archived = ok(await f.actor.call(assetPath(f.room, v2), 'PATCH', {expectedRevision: renamed.revision, status: 'archived'})); assert.equal(archived.revision, 4);
  assert.equal(actualUsage(f.db, f.room).versions, 2);
});

for (const stage of ['version', 'pointer', 'receipt']) {
  test(`independent versions: ${stage} write fault rolls back pointer, every row, receipt and bytes`, async t => {
    const {db, actor, room, events} = await storageHost(t), v1 = await upload(actor, room), before = snapshot(db), body = payload(v1, floorSetup(), 'retry-after-fault');
    const target = stage === 'version' ? 'BEFORE INSERT ON room_image_asset_versions' : stage === 'pointer' ? 'BEFORE UPDATE OF current_version_id ON room_image_assets' : 'BEFORE INSERT ON room_image_asset_operations';
    db.exec(`CREATE TRIGGER independent_write_fault ${target} BEGIN SELECT RAISE(ABORT,'independent injected write fault'); END`);
    reject(await actor.call(versionsPath(room, v1), 'POST', body), 500); assert.deepEqual(snapshot(db), before); assert.equal(events.length, 1); assert.equal(db.isTransaction, false);
    db.exec('DROP TRIGGER independent_write_fault');
    expectPublication(await publish(actor, room, v1, body), v1, body.setup, 'manager'); assert.equal(events.length, 2);
  });
}

function insertVersion(db, first, sequence) {
  const version = {...first.version, versionId: 'fixture-version-' + sequence, sequence};
  db.prepare('INSERT INTO room_image_asset_versions(room_id,asset_id,version_id,sequence,version_json,sha256,byte_length,bytes) VALUES(?,?,?,?,?,?,?,?)').run(first.definition.roomId, first.definition.assetId, version.versionId, sequence, JSON.stringify(version), hash, bytes.length, bytes);
  db.prepare('UPDATE room_image_assets SET current_version_id=? WHERE room_id=? AND asset_id=?').run(version.versionId, first.definition.roomId, first.definition.assetId);
  return version;
}
test('independent versions: one hundred retained versions is a hard per-definition bound', async t => {
  const {db, actor, room} = await storageHost(t), v1 = await upload(actor, room);
  for (let sequence = 2; sequence <= 99; sequence++) insertVersion(db, v1, sequence);
  const current = ok(await actor.call(root(room))).entries[0], result = await publish(actor, room, current), v100 = publishedEntry(result);
  assert.equal(v100.version.sequence, 100); assert.equal(actualUsage(db, room).versions, 100);
  const before = snapshot(db); reject(await actor.call(versionsPath(room, v100), 'POST', payload(v100, customSetup()))); assert.deepEqual(snapshot(db), before);
});

for (const field of ['revision', 'sequence']) {
  test(`independent versions: ${field} safe-integer exhaustion cannot advance or reserve an operation`, async t => {
    const {db, actor, room} = await storageHost(t), v1 = await upload(actor, room);
    if (field === 'revision') db.prepare('UPDATE room_image_assets SET revision=?').run(Number.MAX_SAFE_INTEGER);
    else {db.exec('DROP TRIGGER image_version_sequence'); insertVersion(db, v1, Number.MAX_SAFE_INTEGER); initializeImageAssetSchema(db);}
    const current = ok(await actor.call(root(room))).entries[0], before = snapshot(db);
    reject(await actor.call(versionsPath(room, current), 'POST', payload(current))); assert.deepEqual(snapshot(db), before);
  });
}

test('independent versions: independent SQLite hosts observe one CAS winner and shared actual quota', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'independent-image-hosts-')); t.after(() => rm(directory, {recursive: true, force: true}));
  const database = join(directory, 'images.sqlite'), a = await storageHost(t, {database, limits: {maxRoomBytes: bytes.length * 2}}), b = await storageHost(t, {database, limits: {maxRoomBytes: bytes.length * 2}}), v1 = await upload(a.actor, a.room);
  const responses = await Promise.all([a.actor.call(versionsPath(a.room, v1), 'POST', payload(v1, floorSetup(), 'connection-a')), b.actor.call(versionsPath(b.room, v1), 'POST', payload(v1, customSetup(), 'connection-b'))]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  assert.deepEqual(snapshot(a.db), snapshot(b.db)); assert.equal(actualUsage(a.db, a.room).bytes, bytes.length * 2);
  assert.equal(a.events.length + b.events.length, 2);
});

test('independent versions: renderer never substitutes newest geometry for an old pin or shares a version cache key', async t => {
  const {actor, room} = await storageHost(t), v1 = await upload(actor, room), v2 = publishedEntry(await publish(actor, room, v1));
  const context = {roomId: room.id, roomEpoch: 1, authorityEpoch: 1, canRead: true}, placed = instance(v1);
  assert.notEqual(imageTextureKey({resolved: v1, context}), imageTextureKey({resolved: v2, context}));
  const loads = [], resources = [];
  const port = {createNode: placement => ({placement}), updatePlacement: (node, placement) => {node.placement = placement;}, setState: (node, state) => {node.state = state;}, setTexture: (node, texture) => {node.texture = texture;}, clearTexture: node => {node.texture = null;}, dispose: node => {node.disposed = true;}};
  const loader = createAuthenticatedImageLoader({origin: 'http://fixture.local', fetchImage: async url => {
    loads.push(url); return new Response(bytes, {status: 200, headers: {'Content-Type': 'image/png', 'Content-Length': String(bytes.length)}});
  }, decodeTexture: async ({bytes: decoded, resolved}) => {
    assert.equal(createHash('sha256').update(decoded).digest('hex'), hash);
    const resource = {texture: {versionId: resolved.version.versionId}, alphaMask: {width: 1, height: 1, alpha: [255]}, isReady: () => !resource.disposed, disposed: false, dispose() {this.disposed = true;}}; resources.push(resource); return resource;
  }});
  const view = createImageObjectView({resolved: v1, instance: placed, context, port, loadTexture: loader}); t.after(() => view.dispose());
  assert.equal((await view.ready).status, 'ready'); const before = structuredClone(view.placement);
  assert.equal((await view.update({resolved: {...v1, revision: 2}, instance: placed, context})).status, 'ready'); assert.deepEqual(view.placement, before); assert.equal(loads.length, 1);
  assert.equal((await view.update({resolved: v2, instance: placed, context})).status, 'error'); assert.deepEqual(view.placement, before); assert.equal(view.node.texture, null); assert.equal(resources[0].disposed, true); assert.equal(loads.length, 1);
  const explicit = instance(v2, 'explicit-new'); assert.equal((await view.update({resolved: v2, instance: explicit, context})).status, 'ready');
  assert.equal(view.placement.render.representation, 'floor'); assert.equal(loads.length, 2); assert.ok(loads[0].includes(v1.version.versionId)); assert.ok(loads[1].includes(v2.version.versionId));
  assert.equal((await view.update({resolved: v2, instance: explicit, context: {...context, authorityEpoch: 2, canRead: false}})).status, 'revoked'); assert.equal(view.node.texture, null); assert.equal(resources[1].disposed, true);
});
