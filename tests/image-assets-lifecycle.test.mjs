import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createGameServer} from '../server/app.mjs';
import {initializeImageAssetSchema, createImageAssetRepository} from '../server/image-asset-store.mjs';
import {createImageAssetService, IMAGE_UPDATE_JSON_LIMIT} from '../server/image-assets.mjs';
import {validatePng} from '../server/png-validation.mjs';
import {seedWorlds} from '../src/worlds.js';
import {makePng} from '../fixtures/png-fixtures.mjs';

const emptyScene = (areas = []) => ({version: 1, theme: 'garden', bounds: {width: 32, depth: 26}, spawn: {x: 0, z: 10}, objects: [], areas});
const assetPath = (room, entry) => `/api/rooms/${room.id}/assets/${entry.definition.assetId}`;
const imagePath = (room, entry) => `${assetPath(room, entry)}/versions/${entry.version.versionId}/image`;
const ref = entry => ({assetId: entry.definition.assetId, versionId: entry.version.versionId});
const key = entry => `${entry.definition.assetId}:${entry.version.versionId}`;
const placed = (entry, id = 'placed-image') => ({id, type: 'image', name: 'My independent instance', assetRef: ref(entry), x: 6, z: 0, rotation: 0});
const describe = response => JSON.stringify({status: response.status, data: response.data});
function ok(response, status = 200) {assert.equal(response.status, status, describe(response)); return response.data;}
function errorCode(response) {return response.data?.error?.code ?? response.data?.code;}

async function start(database = ':memory:') {
  const app = createGameServer({database, seeds: seedWorlds});
  const {port} = await app.listen(0), base = `http://127.0.0.1:${port}`;
  const client = (cookie = '') => ({cookie, async call(path, method = 'GET', body, headers = {}) {
    const response = await fetch(base + path, {method,
      headers: {Cookie: this.cookie, ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers},
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body)});
    const setCookie = response.headers.get('set-cookie'); if (setCookie) this.cookie = setCookie.split(';')[0];
    const bytes = Buffer.from(await response.arrayBuffer());
    return {status: response.status, headers: response.headers, bytes, data: bytes.length && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes) : undefined};
  }});
  const account = async name => {const c = client(); c.user = ok(await c.call('/api/session', 'POST', {name}), 201).user; return c;};
  return {app, port, client, account};
}
async function joinRoom(client, room) {return ok(await client.call(`/api/rooms/${room.id}/join`, 'POST', {})).room;}
async function latest(client, room) {return ok(await client.call(`/api/rooms/${room.id}`)).room;}
async function makeRoom(owner, world, areas = []) {return ok(await owner.call('/api/rooms', 'POST', {worldId: world.id, name: 'Lifecycle room ' + randomUUID().slice(0, 8), scene: emptyScene(areas)}), 201).room;}
async function setup(t, areas = []) {
  const f = await start(); t.after(() => f.app.close());
  const owner = await f.account('Library manager'), reader = await f.account('Library reader');
  const world = ok(await owner.call('/api/worlds', 'POST', {name: 'Lifecycle local tests'}), 201).world;
  const room = await makeRoom(owner, world, areas); await joinRoom(owner, room); await joinRoom(reader, room);
  return {...f, owner, reader, world, room};
}
async function upload(client, room) {
  return ok(await client.call(`/api/rooms/${room.id}/assets`, 'POST', {operationId: randomUUID(), draft: {name: 'Original oak', tags: ['green', 'tree']}, mediaType: 'image/png', pngBase64: makePng().toString('base64')}), 201);
}
async function patch(client, room, entry, change, revision = entry.revision) {
  return client.call(assetPath(room, entry), 'PATCH', {expectedRevision: revision, ...change});
}
async function save(client, room, mutate) {
  const current = await latest(client, room), scene = structuredClone(current.scene); mutate(scene);
  return client.call(`/api/rooms/${room.id}/scene`, 'PUT', {revision: current.revision, scene, personalAreaRevisions: Object.fromEntries(current.personalAreas.map(area => [area.areaId, area.revision]))});
}
function snapshot(store, room, entry) {
  return store.get('SELECT a.definition_json,a.metadata_json,a.revision,a.archived_at,a.deleted_at,v.version_json,v.bytes FROM room_image_assets a JOIN room_image_asset_versions v ON v.room_id=a.room_id AND v.asset_id=a.asset_id WHERE a.room_id=? AND a.asset_id=? AND v.version_id=?', room.id, entry.definition.assetId, entry.version.versionId);
}
function partialJson(port, cookie, path, method, payload) {
  const encoded = Buffer.from(JSON.stringify(payload)), split = Math.max(1, Math.floor(encoded.length / 2)); let request;
  const result = new Promise((resolve, reject) => {
    request = http.request({host: '127.0.0.1', port, path, method, headers: {Cookie: cookie, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked'}}, response => {
      let raw = ''; response.on('data', bytes => {raw += bytes;}); response.on('end', () => resolve({status: response.statusCode, data: raw ? JSON.parse(raw) : undefined}));
    });
    request.on('error', reject); request.write(encoded.subarray(0, split));
  });
  return {result, finish: () => request.end(encoded.subarray(split)), destroy: () => request.destroy()};
}
function watchAuthorization(app, userId) {
  let resolve; const admitted = new Promise(done => {resolve = done;});
  const original = app.store.authorize.bind(app.store);
  app.store.authorize = (...args) => {const result = original(...args); if (args[1] === userId) resolve(); return result;};
  return {admitted, restore: () => {app.store.authorize = original;}};
}
async function admission(watch, pending) {await Promise.race([watch.admitted, pending.result.then(response => assert.fail(`Ended before body admission: ${describe(response)}`))]);}

// All databases, accounts, uploads and sockets in this suite are disposable local fixtures.
test('image lifecycle HTTP metadata edit is normalized, revisioned, searchable, and leaves immutable data and instance names unchanged', async t => {
  const {app, owner, room} = await setup(t), entry = await upload(owner, room);
  assert.equal(entry.revision, 1); assert.deepEqual(entry.metadata, {name: 'Original oak', description: '', tags: ['green', 'tree']});
  ok(await save(owner, room, scene => scene.objects.push(placed(entry))));
  const before = snapshot(app.store, room, entry), changed = ok(await patch(owner, room, entry, {metadata: {name: '  Forest display  ', description: '  A moonlit woodland  ', tags: 'Night, purple, NIGHT'}}));
  assert.equal(changed.revision, 2); assert.deepEqual(changed.metadata, {name: 'Forest display', description: 'A moonlit woodland', tags: ['Night', 'purple']});
  assert.deepEqual(changed.definition, entry.definition); assert.deepEqual(changed.version, entry.version);
  const after = snapshot(app.store, room, entry);
  assert.equal(after.definition_json, before.definition_json); assert.equal(after.version_json, before.version_json); assert.deepEqual(after.bytes, before.bytes);
  const current = await latest(owner, room); assert.equal(current.scene.objects[0].name, placed(entry).name); assert.equal(current.imageDefinitions[key(entry)].revision, 2);
  assert.equal(ok(await owner.call(`/api/rooms/${room.id}/assets?query=moonlit%20PURPLE`)).entries.length, 1);
  assert.equal(ok(await owner.call(`/api/rooms/${room.id}/assets?query=original`)).entries.length, 0);
  for (const change of [{metadata: {name: 'Overwrite', description: ''}}, {status: 'archived'}]) {
    const stale = await patch(owner, room, entry, change); assert.equal(stale.status, 409); assert.equal(errorCode(stale), 'IMAGE_REVISION_CONFLICT');
    assert.deepEqual(snapshot(app.store, room, entry), after);
  }
  // Even an unchanged accepted edit consumes a revision; replaying its expected
  // revision never silently succeeds or applies stale state.
  const unchanged = ok(await patch(owner, room, changed, {metadata: changed.metadata})); assert.equal(unchanged.revision, 3);
  assert.equal((await patch(owner, room, changed, {metadata: changed.metadata})).status, 409);
});

test('image lifecycle PATCH rejects unknown fields, mixed changes, malformed metadata and oversized bodies without writes', async t => {
  const {app, owner, room} = await setup(t), entry = await upload(owner, room), before = snapshot(app.store, room, entry);
  const invalid = [
    {}, {expectedRevision: '1', status: 'archived'}, {expectedRevision: 0, status: 'archived'},
    {expectedRevision: 1, status: 'deleted'}, {expectedRevision: 1, status: 'archived', metadata: {name: 'x', description: ''}},
    {expectedRevision: 1, metadata: {name: 'x'}}, {expectedRevision: 1, metadata: {name: '', description: ''}},
    {expectedRevision: 1, metadata: {name: 'x'.repeat(121), description: ''}},
    {expectedRevision: 1, metadata: {name: 'x', description: 'x'.repeat(2001)}},
    {expectedRevision: 1, metadata: {name: 'x', description: '', tags: [], url: 'invalid'}},
    {expectedRevision: 1, metadata: {name: 'x', description: ''}, roomId: room.id},
    {expectedRevision: 1, status: 'archived', canManage: true}, {expectedRevision: 1, status: 'active', version: entry.version},
  ];
  for (const body of invalid) {const response = await owner.call(assetPath(room, entry), 'PATCH', body); assert.equal(response.status, 400, describe(response));}
  assert.equal((await owner.call(assetPath(room, entry), 'PATCH', Buffer.alloc(IMAGE_UPDATE_JSON_LIMIT + 1, 32))).status, 413);
  assert.equal((await owner.call(assetPath(room, entry), 'PATCH', {expectedRevision: 1, status: 'archived'}, {'Content-Encoding': 'gzip'})).status, 415);
  assert.equal((await owner.call(`/api/rooms/${room.id}/assets?status=deleted`)).status, 400);
  assert.deepEqual(snapshot(app.store, room, entry), before);
});

test('image lifecycle full editors manage archives, ordinary readers cannot, and copied IDs never cross room boundaries', async t => {
  const {owner, reader, room, world} = await setup(t), entry = await upload(owner, room);
  for (const change of [{status: 'archived'}, {metadata: {name: 'Unauthorized', description: ''}}]) assert.equal((await patch(reader, room, entry, change)).status, 403);
  const archived = ok(await patch(owner, room, entry, {status: 'archived'}));
  assert.deepEqual(ok(await owner.call(`/api/rooms/${room.id}/assets`)).entries, []);
  assert.equal(ok(await owner.call(`/api/rooms/${room.id}/assets?status=archived`)).entries[0].revision, 2);
  assert.equal((await reader.call(`/api/rooms/${room.id}/assets?status=archived`)).status, 403);
  for (const method of ['GET', 'HEAD']) {
    assert.equal((await reader.call(imagePath(room, entry), method)).status, 404);
    const response = await owner.call(imagePath(room, entry), method); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(response.bytes, method === 'HEAD' ? Buffer.alloc(0) : makePng());
  }
  for (const role of ['editor']) {
    ok(await owner.call(`/api/rooms/${room.id}/members/${reader.user.id}`, 'PUT', {role}));
    assert.equal(ok(await reader.call(`/api/rooms/${room.id}/assets?status=archived`)).entries.length, 1);
    assert.equal((await reader.call(imagePath(room, entry))).status, 200);
  }
  const restored = ok(await patch(reader, room, archived, {status: 'active'})); assert.equal(restored.revision, 3);
  const other = await makeRoom(owner, world); await joinRoom(owner, other);
  assert.equal((await patch(owner, other, restored, {status: 'archived'})).status, 404);
  assert.equal((await owner.call(imagePath(other, entry))).status, 404);
  assert.equal((await patch(owner, room, restored, {status: 'archived'})).status, 401);
  await joinRoom(owner, room);
  assert.equal(ok(await owner.call(`/api/rooms/${room.id}/assets`)).entries[0].revision, 3);
});

test('archived pinned instances render and can move, rotate, rename, change actions and delete, but cannot duplicate or return after committed removal', async t => {
  const {owner, reader, room} = await setup(t), entry = await upload(owner, room);
  ok(await save(owner, room, scene => scene.objects.push(placed(entry))));
  const archived = ok(await patch(owner, room, entry, {status: 'archived'}));
  assert.equal((await latest(reader, room)).imageDefinitions[key(entry)].status, 'archived');
  for (const method of ['GET', 'HEAD']) assert.equal((await reader.call(imagePath(room, entry), method)).status, 200);
  ok(await save(owner, room, scene => Object.assign(scene.objects[0], {x: 5, rotation: 90, name: 'Retained art', actions: [{id: 'inspect', type: 'message', message: 'Still pinned', trigger: 'interact'}]})));
  const before = await latest(owner, room);
  for (const mutate of [scene => scene.objects.push({...scene.objects[0], id: 'duplicate'}), scene => {scene.objects[0].id = 'replacement';}]) {
    const rejected = await save(owner, room, mutate); assert.equal(rejected.status, 409, describe(rejected)); assert.equal(errorCode(rejected), 'IMAGE_ARCHIVED');
    assert.deepEqual((await latest(owner, room)).scene, before.scene);
  }
  ok(await save(owner, room, scene => {scene.objects = [];}));
  assert.equal((await reader.call(imagePath(room, entry))).status, 404);
  assert.equal((await owner.call(imagePath(room, entry))).status, 200);
  const undo = await save(owner, room, scene => scene.objects.push(before.scene.objects[0])); assert.equal(undo.status, 409); assert.equal(errorCode(undo), 'IMAGE_ARCHIVED');
  const restored = ok(await patch(owner, room, archived, {status: 'active'}));
  assert.deepEqual(restored.version, entry.version); assert.equal(restored.revision, 3);
  ok(await save(owner, room, scene => scene.objects.push(before.scene.objects[0])));
  assert.equal((await reader.call(imagePath(room, entry))).status, 200);
});

for (const mutation of ['role-revoke', 'private-ancestor', 'logout', 'leave-and-return']) {
  test(`image lifecycle streamed PATCH rechecks authority after ${mutation}`, {timeout: 15000}, async t => {
    const {app, port, owner, reader, room, world} = await setup(t), entry = await upload(owner, room);
    ok(await owner.call(`/api/rooms/${room.id}/members/${reader.user.id}`, 'PUT', {role: 'editor'}));
    const before = snapshot(app.store, room, entry), watch = watchAuthorization(app, reader.user.id); t.after(watch.restore);
    const pending = partialJson(port, reader.cookie, assetPath(room, entry), 'PATCH', {expectedRevision: 1, metadata: {name: 'Unauthorized change', description: 'Must roll back'}});
    t.after(pending.destroy); await admission(watch, pending);
    if (mutation === 'role-revoke') ok(await owner.call(`/api/rooms/${room.id}/members/${reader.user.id}`, 'PUT', {role: 'member'}));
    if (mutation === 'private-ancestor') {
      ok(await owner.call(`/api/rooms/${room.id}/members/${reader.user.id}`, 'DELETE'));
      ok(await owner.call(`/api/worlds/${world.id}`, 'PATCH', {public: false}));
    }
    if (mutation === 'logout') ok(await reader.call('/api/logout', 'POST', {}));
    if (mutation === 'leave-and-return') {ok(await reader.call(`/api/rooms/${room.id}/leave`, 'POST', {})); await joinRoom(reader, room);}
    pending.finish(); const response = await pending.result;
    assert.ok([401, 403, 404, 409].includes(response.status), describe(response));
    if (mutation === 'leave-and-return') assert.equal(errorCode(response), 'IMAGE_SESSION_CHANGED');
    assert.deepEqual(snapshot(app.store, room, entry), before);
  });
}

test('image lifecycle mutation authority is checked again inside the actual SQLite write transaction', async t => {
  const {app, owner, room} = await setup(t), entry = await upload(owner, room), before = snapshot(app.store, room, entry);
  const authorize = app.store.authorize.bind(app.store); let outside = 0, inside = 0;
  app.store.authorize = (...args) => {
    const answer = authorize(...args);
    if (args[1] === owner.user.id) {
      if (app.store.db.isTransaction) {inside++; return {...answer, role: 'member'};}
      outside++;
    }
    return answer;
  };
  t.after(() => {app.store.authorize = authorize;});
  const denied = await patch(owner, room, entry, {status: 'archived'});
  assert.equal(denied.status, 403); assert.ok(outside > 0); assert.ok(inside > 0); assert.deepEqual(snapshot(app.store, room, entry), before);
});

test('image lifecycle archive wins over an in-flight new placement and cannot resurrect via an old scene request', {timeout: 15000}, async t => {
  const {app, port, owner, room} = await setup(t), entry = await upload(owner, room), before = await latest(owner, room);
  const scene = structuredClone(before.scene); scene.objects.push(placed(entry));
  const watch = watchAuthorization(app, owner.user.id); t.after(watch.restore);
  const pending = partialJson(port, owner.cookie, `/api/rooms/${room.id}/scene`, 'PUT', {revision: before.revision, scene});
  t.after(pending.destroy); await admission(watch, pending);
  ok(await patch(owner, room, entry, {status: 'archived'}));
  pending.finish(); const rejected = await pending.result;
  assert.equal(rejected.status, 409, describe(rejected)); assert.equal(errorCode(rejected), 'IMAGE_ARCHIVED');
  const fresh = await latest(owner, room); assert.equal(fresh.revision, before.revision); assert.deepEqual(fresh.scene, before.scene);
});

test('image lifecycle placement committed while archive body waits becomes an exact retained pin', {timeout: 15000}, async t => {
  const {app, port, owner, reader, room} = await setup(t), entry = await upload(owner, room);
  const watch = watchAuthorization(app, owner.user.id); t.after(watch.restore);
  const pending = partialJson(port, owner.cookie, assetPath(room, entry), 'PATCH', {expectedRevision: 1, status: 'archived'});
  t.after(pending.destroy); await admission(watch, pending);
  ok(await save(owner, room, scene => scene.objects.push(placed(entry))));
  pending.finish(); const archived = ok(await pending.result); assert.equal(archived.status, 'archived');
  const fresh = await latest(reader, room); assert.equal(fresh.imageDefinitions[key(entry)].status, 'archived');
  assert.deepEqual(fresh.scene.objects[0].assetRef, ref(entry)); assert.equal((await reader.call(imagePath(room, entry))).status, 200);
});

test('image lifecycle metadata, archived status, exact pins and bytes survive SQLite restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'universe-image-lifecycle-')), database = join(directory, 'game.sqlite');
  let f; t.after(async () => {if (f) await f.app.close(); await rm(directory, {recursive: true, force: true});});
  f = await start(database);
  const owner = await f.account('Durable manager'), reader = await f.account('Durable reader');
  const world = ok(await owner.call('/api/worlds', 'POST', {name: 'Durable lifecycle'}), 201).world, room = await makeRoom(owner, world);
  await joinRoom(owner, room); await joinRoom(reader, room);
  const entry = await upload(owner, room); ok(await save(owner, room, scene => scene.objects.push(placed(entry))));
  const renamed = ok(await patch(owner, room, entry, {metadata: {name: 'Saved title', description: 'Persistent description'}}));
  const archived = ok(await patch(owner, room, renamed, {status: 'archived'})), stored = snapshot(f.app.store, room, entry);
  const ownerCookie = owner.cookie, readerCookie = reader.cookie;
  await f.app.close(); f = await start(database);
  const recoveredOwner = f.client(ownerCookie), recoveredReader = f.client(readerCookie);
  assert.deepEqual(ok(await recoveredOwner.call(`/api/rooms/${room.id}/assets?status=archived&query=persistent`)).entries, [archived]);
  assert.deepEqual((await latest(recoveredReader, room)).imageDefinitions[key(entry)], archived);
  assert.deepEqual((await recoveredReader.call(imagePath(room, entry))).bytes, makePng());
  assert.deepEqual(snapshot(f.app.store, room, entry), stored);
  const restored = ok(await patch(recoveredOwner, room, archived, {status: 'active'})); assert.equal(restored.revision, 4);
  assert.deepEqual(restored.metadata, renamed.metadata); assert.deepEqual(restored.version, entry.version);
});

test('image lifecycle migrates pre-metadata SQLite tables safely and legacy deleted assets cannot be restored or read', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); db.exec('PRAGMA foreign_keys=ON');
  db.exec(`CREATE TABLE room_image_assets (
    room_id TEXT NOT NULL, asset_id TEXT NOT NULL, definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
    current_version_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), deleted_at TEXT,
    PRIMARY KEY(room_id,asset_id), CHECK(json_extract(definition_json,'$.roomId') IS room_id), CHECK(json_extract(definition_json,'$.assetId') IS asset_id),
    FOREIGN KEY(room_id,asset_id,current_version_id) REFERENCES room_image_asset_versions(room_id,asset_id,version_id) DEFERRABLE INITIALLY DEFERRED
  )`);
  initializeImageAssetSchema(db); initializeImageAssetSchema(db);
  const repo = createImageAssetRepository(db), context = {roomId: 'room-a', userId: 'owner', sessionIdentity: 'cookie'};
  const service = createImageAssetService({repo, now: () => 1000, validateImage: validatePng,
    resolveSession: () => ({userId: 'owner', currentRoomId: 'room-a', expiresAt: 2000}), authorizeRead: () => true, authorizeManage: () => true});
  const entry = await service.create({...context, operationId: 'original', draft: {name: 'Legacy fallback'}, bytes: makePng()});
  db.prepare('UPDATE room_image_assets SET metadata_json=NULL').run();
  initializeImageAssetSchema(db);
  assert.deepEqual(service.list(context).entries[0].metadata, {name: 'Legacy fallback', description: '', tags: []});
  assert.equal(service.list(context).entries[0].revision, 1);
  db.prepare('UPDATE room_image_assets SET deleted_at=?,archived_at=?').run('legacy-delete', 'legacy-archive');
  assert.deepEqual(service.list({...context, status: 'archived'}).entries, []);
  await assert.rejects(service.update({...context, assetId: entry.definition.assetId, change: {expectedRevision: 1, status: 'active'}}), {code: 'IMAGE_NOT_FOUND'});
  assert.throws(() => service.readImage({...context, ...ref(entry)}), {code: 'IMAGE_NOT_FOUND'});
  assert.throws(() => repo.transaction(() => service.resolveSceneReferences({...context, scene: {objects: [placed(entry)]}, allowArchived: true})), {code: 'IMAGE_NOT_FOUND'});
  assert.deepEqual(repo.getBytes('room-a', entry.definition.assetId, entry.version.versionId), makePng());
});

test('image lifecycle afterCommit events carry minimal invalidation only after durability; delivery failures never undo a commit', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); db.exec('PRAGMA foreign_keys=ON'); initializeImageAssetSchema(db);
  const repo = createImageAssetRepository(db), events = [], context = {roomId: 'room-a', userId: 'owner', sessionIdentity: 'cookie'};
  const service = createImageAssetService({repo, now: () => 1000, validateImage: validatePng,
    resolveSession: () => ({userId: 'owner', currentRoomId: 'room-a', expiresAt: 2000}), authorizeRead: () => true, authorizeManage: () => true,
    afterCommit(event) {assert.equal(db.isTransaction, false); events.push(event); throw new Error('Fixture event transport unavailable');}});
  const entry = await service.create({...context, operationId: 'created', draft: {name: 'Event original'}, bytes: makePng()});
  const archived = await service.update({...context, assetId: entry.definition.assetId, change: {expectedRevision: 1, status: 'archived'}});
  assert.equal(events[0].type, 'imageAsset.created');
  assert.deepEqual(events[1], {type: 'imageAsset.lifecycle', roomId: 'room-a', assetId: entry.definition.assetId, versionId: entry.version.versionId, status: 'archived', revision: 2});
  assert.deepEqual(repo.getCurrent('room-a', entry.definition.assetId), archived);
  await assert.rejects(service.update({...context, assetId: entry.definition.assetId, change: {expectedRevision: 1, status: 'active'}}), {code: 'IMAGE_REVISION_CONFLICT'});
  assert.equal(events.length, 2);
});

test('image lifecycle scoped personal-area owners can retain their own archived image but cannot manage, duplicate or cross their area boundary', async t => {
  const area = {id: 'desk-a', name: 'Desk A', x: -6, z: 0, width: 8, depth: 8, action: 'welcome', personalArea: {mode: 'dynamic', allowedTags: []}};
  const {owner, reader, room} = await setup(t, [area]), entry = await upload(owner, room);
  ok(await reader.call('/api/account', 'POST', {username: 'lifecycle_' + randomUUID().replaceAll('-', '').slice(0, 16), password: 'local lifecycle test account password'}), 201);
  const before = await joinRoom(reader, room), target = before.personalAreas[0];
  ok(await reader.call('/api/presence', 'POST', {roomId: room.id, x: target.x, z: target.z}));
  ok(await reader.call(`/api/rooms/${room.id}/personal-areas/${target.areaId}/claim`, 'POST', {revision: target.revision, clientOperationId: randomUUID()}));
  ok(await save(reader, room, scene => scene.objects.push({...placed(entry), x: -6, z: 0})));
  const archived = ok(await patch(owner, room, entry, {status: 'archived'}));
  assert.equal((await patch(reader, room, archived, {status: 'active'})).status, 403);
  assert.equal((await patch(reader, room, archived, {metadata: {name: 'My library name', description: ''}})).status, 403);
  assert.equal((await reader.call(`/api/rooms/${room.id}/assets?status=archived`)).status, 403);
  assert.equal((await reader.call(imagePath(room, entry))).status, 200);
  ok(await save(reader, room, scene => Object.assign(scene.objects[0], {x: -6, z: 1, rotation: 90, name: 'My retained display'})));
  assert.equal((await save(reader, room, scene => {scene.objects[0].x = 1;})).status, 403);
  assert.equal((await save(reader, room, scene => scene.objects.push({...scene.objects[0], id: 'copy'}))).status, 409);
  ok(await save(reader, room, scene => {scene.objects = [];}));
  assert.equal((await reader.call(imagePath(room, entry))).status, 404);
});

test('image lifecycle archived byte retention authorizes only the exact saved version and hierarchy access remains live', async t => {
  const {app, owner, reader, room, world} = await setup(t), entry = await upload(owner, room);
  ok(await save(owner, room, scene => scene.objects.push(placed(entry))));
  // Fixture-only second immutable version proves the reader cannot use one saved
  // version's pin as authority for the asset's other retained versions.
  const next = {...entry.version, versionId: randomUUID(), sequence: 2};
  app.store.transaction(() => {
    app.store.run('INSERT INTO room_image_asset_versions(room_id,asset_id,version_id,sequence,version_json,sha256,byte_length,bytes) VALUES(?,?,?,?,?,?,?,?)', room.id, entry.definition.assetId, next.versionId, next.sequence, JSON.stringify(next), next.sha256, next.byteLength, makePng());
    app.store.run('UPDATE room_image_assets SET current_version_id=? WHERE room_id=? AND asset_id=?', next.versionId, room.id, entry.definition.assetId);
  });
  const current = {...entry, version: next};
  ok(await patch(owner, room, entry, {status: 'archived'}));
  assert.equal((await reader.call(imagePath(room, entry))).status, 200);
  assert.equal((await reader.call(imagePath(room, current))).status, 404);
  assert.equal((await owner.call(imagePath(room, current))).status, 200);
  const changedRef = await save(owner, room, scene => {scene.objects[0].assetRef = ref(current);}); assert.equal(changedRef.status, 409); assert.equal(errorCode(changedRef), 'IMAGE_ARCHIVED');
  ok(await owner.call(`/api/worlds/${world.id}`, 'PATCH', {public: false}));
  assert.ok([401, 404].includes((await reader.call(imagePath(room, entry))).status));
  assert.equal((await owner.call(imagePath(room, entry))).status, 200);
});

test('image lifecycle concurrent real HTTP CAS updates commit once and stale retry cannot overwrite the winner', async t => {
  const {app, owner, room} = await setup(t), entry = await upload(owner, room);
  const responses = await Promise.all([
    patch(owner, room, entry, {metadata: {name: 'Competing editor', description: 'First revision'}}),
    patch(owner, room, entry, {status: 'archived'}),
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal(errorCode(responses.find(response => response.status === 409)), 'IMAGE_REVISION_CONFLICT');
  const winner = snapshot(app.store, room, entry); assert.equal(winner.revision, 2);
  assert.equal((await patch(owner, room, entry, {status: 'active'})).status, 409);
  assert.deepEqual(snapshot(app.store, room, entry), winner);
});

test('image lifecycle room SSE invalidation never reveals archived unpinned metadata to ordinary readers', {timeout: 15000}, async t => {
  const {port, owner, reader, room} = await setup(t), entry = await upload(owner, room);
  const abort = new AbortController(), response = await fetch(`http://127.0.0.1:${port}/api/events`, {headers: {Cookie: reader.cookie}, signal: abort.signal});
  assert.equal(response.status, 200);
  const events = [], waiters = new Set(); let buffer = '';
  const reading = (async () => {
    try {
      for await (const chunk of response.body) {
        buffer += new TextDecoder().decode(chunk);
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const record = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const event = record.match(/^event: (.+)$/m)?.[1], raw = record.match(/^data: (.+)$/m)?.[1];
          if (!event || !raw) continue;
          const value = {event, data: JSON.parse(raw)}; events.push(value);
          for (const waiter of [...waiters]) if (waiter.predicate(value)) {waiters.delete(waiter); waiter.resolve(value);}
        }
      }
    } catch (error) {if (!abort.signal.aborted) throw error;}
  })();
  const close = async () => {abort.abort(); await reading;}; t.after(close);
  const wait = predicate => events.find(predicate) ?? new Promise(resolve => {waiters.add({predicate, resolve});});
  await wait(event => event.event === 'hello');
  const archived = ok(await patch(owner, room, entry, {status: 'archived'}));
  await wait(event => event.event === 'image-assets' && event.data.revision === 2);
  const hidden = {name: 'Hidden library title', description: 'Private archived description', tags: ['hidden-archive-tag']};
  const updated = ok(await patch(owner, room, archived, {metadata: hidden}));
  const delivered = await wait(event => event.event === 'image-assets' && event.data.revision === 3);
  assert.deepEqual(delivered.data, {type: 'imageAsset.lifecycle', roomId: room.id, assetId: entry.definition.assetId, versionId: entry.version.versionId, status: 'archived', revision: 3});
  const allEvents = JSON.stringify(events);
  for (const text of [hidden.name, hidden.description, ...hidden.tags]) assert.equal(allEvents.includes(text), false);
  for (const event of events.filter(event => event.event === 'image-assets')) {
    for (const field of ['metadata', 'name', 'description', 'tags']) assert.equal(Object.hasOwn(event.data, field), false);
  }
  assert.equal((await reader.call(`/api/rooms/${room.id}/assets?status=archived`)).status, 403);
  assert.equal((await reader.call(imagePath(room, entry))).status, 404);
  assert.deepEqual(ok(await owner.call(`/api/rooms/${room.id}/assets?status=archived`)).entries, [updated]);
  assert.deepEqual((await latest(reader, room)).imageDefinitions, {});
  await close();
});

test('image lifecycle upload receipts do not reveal later hidden archive metadata to a demoted original uploader', async t => {
  const {owner, reader, room} = await setup(t);
  ok(await owner.call(`/api/rooms/${room.id}/members/${reader.user.id}`, 'PUT', {role: 'editor'}));
  const operationId = 'former-editor-upload';
  const entry = ok(await reader.call(`/api/rooms/${room.id}/assets`, 'POST', {operationId, draft: {name: 'Former editor image'}, pngBase64: makePng().toString('base64')}), 201);
  ok(await save(owner, room, scene => scene.objects.push(placed(entry))));
  const archived = ok(await patch(owner, room, entry, {status: 'archived'}));
  ok(await owner.call(`/api/rooms/${room.id}/members/${reader.user.id}`, 'PUT', {role: 'member'}));
  const receipt = `/api/rooms/${room.id}/assets/operations/${operationId}`;
  assert.deepEqual(ok(await reader.call(receipt)), {status: 'committed', entry: archived});
  ok(await save(owner, room, scene => {scene.objects = [];}));
  ok(await patch(owner, room, archived, {metadata: {name: 'Hidden after demotion', description: 'A later private archive edit', tags: ['hidden']}}));
  const denied = await reader.call(receipt); assert.equal(denied.status, 404); assert.equal(errorCode(denied), 'IMAGE_NOT_FOUND');
  assert.equal(JSON.stringify(denied.data).includes('Hidden after demotion'), false);
});
