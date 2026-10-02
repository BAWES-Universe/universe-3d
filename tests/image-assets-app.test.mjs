import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds} from '../src/worlds.js';
import {makePng} from '../fixtures/png-fixtures.mjs';

// All HTTP requests and persisted records belong to fresh, local test servers.
const personalArea = (id = 'desk-a', x = -6) => ({id, name: id, x, z: 0, width: 8, depth: 8, action: 'welcome', personalArea: {mode: 'dynamic', allowedTags: []}});
const emptyScene = (areas = []) => ({version: 1, theme: 'garden', bounds: {width: 32, depth: 26}, spawn: {x: 0, z: 10}, objects: [], areas});
const reference = entry => ({assetId: entry.definition.assetId, versionId: entry.version.versionId});
const referenceKey = entry => `${entry.definition.assetId}:${entry.version.versionId}`;
const imagePath = (room, entry) => `/api/rooms/${room.id}/assets/${entry.definition.assetId}/versions/${entry.version.versionId}/image`;
const imageObject = (entry, id = 'placed-image', x = 6, z = 0, rotation = 0) => ({id, type: 'image', name: id, assetRef: reference(entry), x, z, rotation});
const uploadBody = (bytes = makePng(), draft = {name: '  Oak image  ', tags: 'Tree, green, TREE'}, operationId = randomUUID()) => ({draft, operationId, mediaType: 'image/png', pngBase64: bytes.toString('base64')});
const describe = response => JSON.stringify({status: response.status, data: response.data});

async function start(database = ':memory:') {
  const app = createGameServer({database, seeds: seedWorlds});
  const {port} = await app.listen(0), base = `http://127.0.0.1:${port}`;
  const client = (cookie = '') => ({cookie, async call(path, method = 'GET', body, headers = {}) {
    const response = await fetch(base + path, {
      method, headers: {Cookie: this.cookie, ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers},
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const bytes = Buffer.from(await response.arrayBuffer());
    return {status: response.status, headers: response.headers, bytes, data: bytes.length && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes) : undefined};
  }});
  const account = async (name, registered = false) => {
    const c = client(), response = await c.call('/api/session', 'POST', {name});
    assert.equal(response.status, 201, describe(response)); c.user = response.data.user;
    if (registered) assert.equal((await c.call('/api/account', 'POST', {username: 'img_' + randomUUID().replaceAll('-', '').slice(0, 20), password: 'local image test account password'})).status, 201);
    return c;
  };
  return {app, port, base, client, account};
}
async function joinRoom(client, room) {const response = await client.call(`/api/rooms/${room.id}/join`, 'POST', {}); assert.equal(response.status, 200, describe(response)); return response.data.room;}
async function latest(client, room) {const response = await client.call(`/api/rooms/${room.id}`); assert.equal(response.status, 200, describe(response)); return response.data.room;}
async function createRoom(owner, world, areas = [], name = 'Image test room') {
  const response = await owner.call('/api/rooms', 'POST', {worldId: world.id, name, scene: emptyScene(areas)});
  assert.equal(response.status, 201, describe(response)); return response.data.room;
}
async function setup(t, areas = []) {
  const f = await start(); t.after(() => f.app.close());
  const owner = await f.account('Image manager'), alice = await f.account('Image Alice', true), bob = await f.account('Image Bob');
  const created = await owner.call('/api/worlds', 'POST', {name: 'Image asset integration'});
  assert.equal(created.status, 201, describe(created)); const world = created.data.world;
  const room = await createRoom(owner, world, areas); await joinRoom(owner, room);
  return {...f, owner, alice, bob, world, room};
}
async function upload(client, room, body = uploadBody(), headers) {
  const response = await client.call(`/api/rooms/${room.id}/assets`, 'POST', body, headers);
  assert.equal(response.status, 201, describe(response)); return response.data;
}
async function save(client, room, mutate, extra = {}) {
  const current = await latest(client, room), scene = structuredClone(current.scene); mutate(scene);
  return client.call(`/api/rooms/${room.id}/scene`, 'PUT', {revision: current.revision, scene, personalAreaRevisions: Object.fromEntries(current.personalAreas.map(area => [area.areaId, area.revision])), ...extra});
}
async function claim(client, room, areaId = 'desk-a') {
  const current = await joinRoom(client, room), area = current.personalAreas.find(value => value.areaId === areaId);
  assert.equal((await client.call('/api/presence', 'POST', {roomId: room.id, x: area.x, z: area.z})).status, 200);
  const response = await client.call(`/api/rooms/${room.id}/personal-areas/${areaId}/claim`, 'POST', {revision: area.revision, clientOperationId: randomUUID()});
  assert.equal(response.status, 200, describe(response)); return response.data.room;
}
async function assertRejectedUnchanged(client, room, mutate, status = 400, extra = {}) {
  const before = await latest(client, room), response = await save(client, room, mutate, extra);
  assert.equal(response.status, status, describe(response));
  const after = await latest(client, room); assert.equal(after.revision, before.revision); assert.deepEqual(after.scene, before.scene);
}

function assertImageResponse(response, bytes, method = 'GET') {
  assert.equal(response.status, 200, describe(response));
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(response.bytes, method === 'HEAD' ? Buffer.alloc(0) : bytes);
}

test('image assets app: upload, pinned scene, authorized metadata/bytes and receipts survive SQLite restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'universe-image-app-'));
  let f; t.after(async () => {if (f) await f.app.close(); await rm(directory, {recursive: true, force: true});});
  const database = join(directory, 'game.sqlite'); f = await start(database);
  const owner = await f.account('Durable image owner'), viewer = await f.account('Durable image viewer');
  const world = (await owner.call('/api/worlds', 'POST', {name: 'Durable images'})).data.world;
  const room = await createRoom(owner, world); await joinRoom(owner, room); await joinRoom(viewer, room);
  const bytes = makePng({filter: y => y % 5}), body = uploadBody(bytes, {name: '  Oak image  ', tags: 'Tree, green, TREE', floating: false, collisionGrid: [[0, 0], [1, 1], [1, 1]]}, 'durable-upload');
  const entry = await upload(owner, room, body), ref = reference(entry), key = referenceKey(entry);
  assert.equal(entry.schemaVersion, 1); assert.equal(entry.status, 'active');
  assert.equal(entry.definition.roomId, room.id); assert.equal(entry.definition.createdBy, owner.user.id);
  assert.equal(entry.version.name, 'Oak image'); assert.deepEqual(entry.version.tags, ['Tree', 'green']);
  assert.equal(entry.version.widthPixels, 64); assert.equal(entry.version.heightPixels, 96);
  assert.equal(entry.version.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(entry.version.sequence, 1); assert.equal(entry.version.byteLength, bytes.length);
  assert.deepEqual(await upload(owner, room, body), entry);
  assert.equal((await owner.call(`/api/rooms/${room.id}/assets?query=GREEN%20oak`)).data.entries.length, 1);
  assert.deepEqual((await viewer.call(`/api/rooms/${room.id}/assets/operations/durable-upload`)).data, {status: 'not-found'});
  const placed = imageObject(entry), saved = await save(owner, room, scene => scene.objects.push(placed));
  assert.equal(saved.status, 200, describe(saved)); assert.deepEqual(saved.data.room.scene.objects[0].assetRef, ref);
  assert.deepEqual(saved.data.room.imageDefinitions[key], entry);
  assert.equal(Object.hasOwn(saved.data.room.scene, 'imageDefinitions'), false);
  const storedScene = JSON.parse(f.app.store.get('SELECT scene FROM rooms WHERE id=?', room.id).scene);
  assert.deepEqual(storedScene.objects, [placed]); assert.equal(Object.hasOwn(storedScene, 'imageDefinitions'), false);
  for (const method of ['GET', 'HEAD']) assertImageResponse(await viewer.call(imagePath(room, entry), method), bytes, method);
  assert.equal((await owner.call(imagePath(room, entry), 'PUT', {name: 'replace bytes'})).status, 405);
  const ownerCookie = owner.cookie, viewerCookie = viewer.cookie, revision = saved.data.room.revision;
  await f.app.close(); f = await start(database);
  const recoveredOwner = f.client(ownerCookie), recoveredViewer = f.client(viewerCookie);
  const recovered = await latest(recoveredViewer, room);
  assert.equal(recovered.revision, revision); assert.deepEqual(recovered.scene, storedScene); assert.deepEqual(recovered.imageDefinitions[key], entry);
  assert.deepEqual((await recoveredOwner.call(`/api/rooms/${room.id}/assets/operations/durable-upload`)).data, {status: 'committed', entry});
  assert.deepEqual(await upload(recoveredOwner, room, body), entry);
  assert.equal((await recoveredOwner.call(`/api/rooms/${room.id}/assets`)).data.entries.length, 1);
  assertImageResponse(await recoveredViewer.call(imagePath(room, entry)), bytes);
  assert.throws(() => f.app.store.run('UPDATE room_image_asset_versions SET bytes=? WHERE room_id=? AND asset_id=? AND version_id=?', Buffer.alloc(bytes.length), room.id, ref.assetId, ref.versionId), /immutable/i);
  assertImageResponse(await recoveredViewer.call(imagePath(room, entry)), bytes);
});

test('image assets app: scoped owners can read/place full transparent extents but cannot upload or forge geometry', async t => {
  const {owner, alice, room} = await setup(t, [personalArea()]);
  const bytes = makePng({width: 192, height: 64, pixel: () => [0, 0, 0, 0]});
  const entry = await upload(owner, room, uploadBody(bytes, {name: 'Transparent six-by-two image'}));
  const claimed = await claim(alice, room);
  assert.equal(claimed.capabilities.canBuild, true); assert.equal(claimed.capabilities.canEditScene, false);
  assert.equal((await alice.call(`/api/rooms/${room.id}/assets`)).data.entries[0].definition.assetId, entry.definition.assetId);
  assertImageResponse(await alice.call(imagePath(room, entry)), bytes);
  assert.equal((await alice.call(`/api/rooms/${room.id}/assets`, 'POST', uploadBody())).status, 403);
  // 192 x 64 pixels is exactly 6 x 2 metres. Empty alpha must not shrink it.
  let response = await save(alice, room, scene => scene.objects.push(imageObject(entry, 'transparent', -5, 3)));
  assert.equal(response.status, 200, describe(response));
  assert.equal(response.data.room.personalAreas[0].objectCount, 1); assert.equal(response.data.room.personalAreas[0].ownedObjectCount, 1);
  await assertRejectedUnchanged(alice, room, scene => {scene.objects[0].x = -4.99;}, 403);
  await assertRejectedUnchanged(alice, room, scene => {scene.objects[0].z = 3.01;}, 403);
  await assertRejectedUnchanged(alice, room, scene => {scene.objects[0].rotation = 90;}, 403);
  response = await save(alice, room, scene => {Object.assign(scene.objects[0], {x: -6, z: 1, rotation: 90});});
  assert.equal(response.status, 200, describe(response));
  await assertRejectedUnchanged(alice, room, scene => {scene.objects[0].z = 1.01;}, 403);
  for (const field of ['width', 'height', 'depth', 'scale', 'widthPixels', 'collisionGrid', 'definition', 'version', 'ownerId']) {
    await assertRejectedUnchanged(alice, room, scene => {scene.objects[0][field] = field === 'collisionGrid' ? [[0]] : 0.01;});
  }
  response = await save(alice, room, scene => {scene.objects[0].name = 'My pinned transparent image'; scene.objects[0].actions = [{id: 'note', type: 'message', message: 'Local image action', trigger: 'interact'}];});
  assert.equal(response.status, 200, describe(response)); assert.deepEqual(response.data.room.scene.objects[0].assetRef, reference(entry));
});

test('image assets app: old and new pinned footprints both gate scoped edits, deletion and ownership counts', async t => {
  const {owner, alice, room} = await setup(t, [personalArea()]);
  const wide = await upload(owner, room, uploadBody(makePng({width: 192, height: 64}), {name: 'Wide sparse collider', floating: false, collisionGrid: [[1, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]]}));
  const small = await upload(owner, room, uploadBody(makePng({width: 32, height: 32}), {name: 'Small image'}));
  await claim(alice, room);
  assert.equal((await save(alice, room, scene => scene.objects.push(imageObject(small, 'owned-image', -3, 0)))).status, 200);
  // Replacing a one-metre image with a six-metre version must use new metadata.
  await assertRejectedUnchanged(alice, room, scene => {scene.objects[0].assetRef = reference(wide);}, 403);
  assert.equal((await save(alice, room, scene => {scene.objects[0] = imageObject(wide, 'owned-image', -6, 2);})).status, 200);
  // A full editor moves this same attributed instance out; a scoped editor must
  // not pull it back, rename it or delete it using only the proposed new bounds.
  assert.equal((await save(owner, room, scene => {scene.objects[0].x = -1;})).status, 200);
  assert.equal((await latest(owner, room)).personalAreas[0].ownedObjectCount, 0);
  for (const mutate of [scene => {scene.objects[0].x = -6;}, scene => {scene.objects[0].name = 'outside edit';}, scene => {scene.objects = [];}]) {
    await assertRejectedUnchanged(alice, room, mutate, 403);
  }
  assert.equal((await save(owner, room, scene => {scene.objects[0].x = -6;})).status, 200);
  assert.equal((await latest(owner, room)).personalAreas[0].ownedObjectCount, 1);
  const current = await latest(owner, room), a = current.personalAreas[0];
  const revoked = await owner.call(`/api/rooms/${room.id}/personal-areas/desk-a/revoke`, 'POST', {revision: a.revision, roomRevision: current.revision, objectHandling: 'remove-owned', clientOperationId: randomUUID()});
  assert.equal(revoked.status, 200, describe(revoked)); assert.deepEqual(revoked.data.operation.removedObjectIds, ['owned-image']); assert.deepEqual(revoked.data.room.scene.objects, []);
  // Revoke removes the scene instance, never the reusable room library entry.
  assert.equal((await owner.call(`/api/rooms/${room.id}/assets`)).data.entries.length, 2);
});

test('image assets app: malformed, missing and foreign references and client scene metadata fail atomically', async t => {
  const {owner, room, world} = await setup(t), entry = await upload(owner, room);
  assert.equal((await save(owner, room, scene => scene.objects.push(imageObject(entry)))).status, 200);
  const other = await createRoom(owner, world, [], 'Other image room'); await joinRoom(owner, other);
  const foreign = await upload(owner, other); await joinRoom(owner, room);
  const missing = {assetId: 'missing-asset', versionId: 'missing-version'};
  for (const ref of [missing, reference(foreign)]) await assertRejectedUnchanged(owner, room, scene => {scene.objects[0].assetRef = ref;}, 404);
  for (const ref of [undefined, null, {assetId: entry.definition.assetId}, {...reference(entry), versionId: 'latest'}, {...reference(entry), roomId: other.id}, {...reference(entry), url: imagePath(other, foreign)}]) {
    const expected = ref?.versionId === 'latest' ? 404 : 400;
    await assertRejectedUnchanged(owner, room, scene => {scene.objects[0].assetRef = ref;}, expected);
  }
  for (const rotation of [45, '90']) await assertRejectedUnchanged(owner, room, scene => {scene.objects[0].rotation = rotation;});
  for (const field of ['imageDefinitions', 'imageAssets', 'assetDefinitions']) await assertRejectedUnchanged(owner, room, scene => {scene[field] = {[referenceKey(entry)]: entry};});
  await assertRejectedUnchanged(owner, room, () => {}, 400, {imageDefinitions: {[referenceKey(entry)]: entry}});
  await assertRejectedUnchanged(owner, room, scene => {scene.objects[0].actions = [{id: 'script', type: 'javascript', script: 'alert(1)'}];});
  const rejectedCreate = await owner.call('/api/rooms', 'POST', {worldId: world.id, name: 'Foreign seed is invalid', scene: {...emptyScene(), objects: [imageObject(entry)]}});
  assert.ok([400, 404].includes(rejectedCreate.status), describe(rejectedCreate));
});

test('image assets app: upload validation and idempotency never reserve failed or conflicting records', async t => {
  const {owner, alice, room} = await setup(t), bytes = makePng(), body = uploadBody(bytes, {name: 'Valid'}, 'reusable-operation');
  for (const invalid of [
    {...body, pngBase64: Buffer.from('<html>not a PNG</html>').toString('base64')},
    {...body, pngBase64: body.pngBase64 + '\n'}, {...body, mediaType: 'text/html'},
    {...body, draft: {...body.draft, widthPixels: 1}}, {...body, draft: {...body.draft, url: '/files/arbitrary'}},
    {...body, userId: alice.user.id}, {...body, sessionIdentity: owner.cookie}, {...body, canManage: true},
  ]) {
    const response = await owner.call(`/api/rooms/${room.id}/assets`, 'POST', invalid);
    assert.equal(response.status, 400, describe(response));
    assert.deepEqual((await owner.call(`/api/rooms/${room.id}/assets/operations/reusable-operation`)).data, {status: 'not-found'});
  }
  assert.equal((await owner.call(`/api/rooms/${room.id}/assets`, 'POST', body, {'Content-Encoding': 'gzip'})).status, 415);
  assert.equal((await owner.call(`/api/rooms/${room.id}/assets`)).data.entries.length, 0);
  const entry = await upload(owner, room, body);
  assert.equal((await owner.call(`/api/rooms/${room.id}/assets`, 'POST', {...body, draft: {name: 'Different'}})).status, 409);
  assert.equal((await owner.call(`/api/rooms/${room.id}/assets`, 'POST', {...body, pngBase64: makePng({pixel: () => [1, 2, 3, 255]}).toString('base64')})).status, 409);
  assert.equal((await owner.call(`/api/rooms/${room.id}/assets`)).data.entries.length, 1);
  assertImageResponse(await owner.call(imagePath(room, entry)), bytes);
});

test('image assets app: reads require live current-room cookies and hierarchy authority; copied IDs stay room-scoped', async t => {
  const {client, owner, alice, bob, room, world} = await setup(t), bytes = makePng(), entry = await upload(owner, room, uploadBody(bytes));
  assert.equal((await client().call(imagePath(room, entry))).status, 401);
  assert.equal((await alice.call(`/api/rooms/${room.id}/assets`)).status, 401);
  await joinRoom(alice, room); assertImageResponse(await alice.call(imagePath(room, entry)), bytes);
  const other = await createRoom(owner, world, [], 'No borrowed images'); await joinRoom(alice, other);
  assert.equal((await alice.call(imagePath(other, entry))).status, 404);
  assert.equal((await alice.call(imagePath(room, entry))).status, 401);
  await joinRoom(alice, room); await joinRoom(bob, room);
  assert.equal((await owner.call(`/api/worlds/${world.id}`, 'PATCH', {public: false})).status, 200);
  for (const path of [`/api/rooms/${room.id}/assets`, imagePath(room, entry)]) {
    const response = await alice.call(path); assert.ok([401, 404].includes(response.status), describe(response));
  }
  assert.equal((await owner.call(`/api/worlds/${world.id}`, 'PATCH', {public: true})).status, 200);
  await joinRoom(alice, room); const staleCookie = alice.cookie;
  assert.equal((await alice.call('/api/logout', 'POST', {})).status, 200);
  const revoked = client(staleCookie); assert.equal((await revoked.call(imagePath(room, entry), 'HEAD')).status, 401);
  assert.equal((await revoked.call(`/api/rooms/${room.id}/assets`)).status, 401);
  assertImageResponse(await owner.call(imagePath(room, entry)), bytes);
});

// Deliberately stop a real request midway, after initial host authorization.
// No clocks, sleeps or service-only fake identity is needed to exercise races.
function partialJson(port, cookie, path, method, payload) {
  const encoded = JSON.stringify(payload), split = Math.max(1, Math.floor(encoded.length / 2));
  let request;
  const result = new Promise((resolve, reject) => {
    request = http.request({host: '127.0.0.1', port, path, method, headers: {Cookie: cookie, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked'}}, response => {
      let raw = ''; response.on('data', bytes => {raw += bytes;});
      response.on('end', () => resolve({status: response.statusCode, data: raw ? JSON.parse(raw) : undefined}));
    });
    request.on('error', reject); request.write(encoded.slice(0, split));
  });
  return {result, finish: () => request.end(encoded.slice(split)), destroy: () => request.destroy()};
}
function watchAuthorization(app, userId) {
  let resolve; const admitted = new Promise(done => {resolve = done;});
  const original = app.store.authorize.bind(app.store);
  app.store.authorize = (...args) => {const answer = original(...args); if (args[1] === userId) resolve(); return answer;};
  return {admitted, restore: () => {app.store.authorize = original;}};
}
async function awaitAdmission(watch, pending) {
  await Promise.race([watch.admitted, pending.result.then(response => {assert.fail(`Request ended before initial authorization: ${describe(response)}`);})]);
}

for (const mutation of ['role-revoke', 'private-ancestor', 'logout', 'leave-and-return']) {
  test(`image assets app: streamed upload reauthorizes after ${mutation}`, {timeout: 15000}, async t => {
    const {app, port, owner, alice, room, world} = await setup(t);
    assert.equal((await owner.call(`/api/rooms/${room.id}/members/${alice.user.id}`, 'PUT', {role: 'editor'})).status, 200);
    await joinRoom(alice, room);
    const watch = watchAuthorization(app, alice.user.id); t.after(watch.restore);
    const operationId = 'pending-' + mutation, pending = partialJson(port, alice.cookie, `/api/rooms/${room.id}/assets`, 'POST', uploadBody(makePng(), {name: 'Uncommitted streamed image'}, operationId));
    t.after(pending.destroy); await awaitAdmission(watch, pending);
    if (mutation === 'role-revoke') assert.equal((await owner.call(`/api/rooms/${room.id}/members/${alice.user.id}`, 'PUT', {role: 'member'})).status, 200);
    // A direct room grant remains valid inside a private world, so remove it
    // before hiding the ancestor while this actor still has public room access.
    if (mutation === 'private-ancestor') {
      assert.equal((await owner.call(`/api/rooms/${room.id}/members/${alice.user.id}`, 'DELETE')).status, 200);
      assert.equal((await owner.call(`/api/worlds/${world.id}`, 'PATCH', {public: false})).status, 200);
    }
    if (mutation === 'logout') assert.equal((await alice.call('/api/logout', 'POST', {})).status, 200);
    if (mutation === 'leave-and-return') {
      assert.equal((await alice.call(`/api/rooms/${room.id}/leave`, 'POST', {})).status, 200);
      await joinRoom(alice, room);
    }
    pending.finish(); const response = await pending.result;
    assert.ok([401, 403, 404, 409].includes(response.status), describe(response));
    if (mutation === 'leave-and-return') assert.equal(response.data.error?.code ?? response.data.code, 'IMAGE_SESSION_CHANGED');
    assert.equal((await owner.call(`/api/rooms/${room.id}/assets`)).data.entries.length, 0);
    assert.equal(app.store.get('SELECT COUNT(*) AS n FROM room_image_asset_versions WHERE room_id=?', room.id).n, 0);
  });
}

for (const mutation of ['logout', 'leave-and-return']) {
  test(`image assets app: streamed pinned scene save rechecks session after ${mutation}`, {timeout: 15000}, async t => {
    const {app, port, owner, alice, room} = await setup(t), entry = await upload(owner, room);
    assert.equal((await owner.call(`/api/rooms/${room.id}/members/${alice.user.id}`, 'PUT', {role: 'editor'})).status, 200);
    const current = await joinRoom(alice, room), scene = structuredClone(current.scene); scene.objects.push(imageObject(entry));
    const watch = watchAuthorization(app, alice.user.id); t.after(watch.restore);
    const pending = partialJson(port, alice.cookie, `/api/rooms/${room.id}/scene`, 'PUT', {revision: current.revision, scene});
    t.after(pending.destroy); await awaitAdmission(watch, pending);
    if (mutation === 'logout') assert.equal((await alice.call('/api/logout', 'POST', {})).status, 200);
    else {assert.equal((await alice.call(`/api/rooms/${room.id}/leave`, 'POST', {})).status, 200); await joinRoom(alice, room);}
    pending.finish(); const response = await pending.result;
    assert.ok([401, 403, 409].includes(response.status), describe(response));
    const fresh = await latest(owner, room); assert.equal(fresh.revision, current.revision); assert.deepEqual(fresh.scene, current.scene);
  });
}

test('image assets app: decoded collision cells protect arrival and live players while metadata edits stay allowed', async t => {
  const {owner, alice, room} = await setup(t);
  const solid = await upload(owner, room, uploadBody(makePng({width: 32, height: 32}), {name: 'One metre collider', floating: false, collisionGrid: [[1]]}));
  // 0.5 m half-cell + 0.75 m arrival padding, including its exact boundary.
  const arrival = await save(owner, room, scene => scene.objects.push(imageObject(solid, 'arrival-block', 0, 8.75)));
  assert.equal(arrival.status, 400, describe(arrival)); assert.equal(arrival.data.code, 'IMAGE_BLOCKS_ARRIVAL');
  assert.equal((await latest(owner, room)).revision, 0);
  let saved = await save(owner, room, scene => scene.objects.push(imageObject(solid, 'arrival-clear', 0, 8.74)));
  assert.equal(saved.status, 200, describe(saved));
  await joinRoom(alice, room);
  assert.equal((await alice.call('/api/presence', 'POST', {roomId: room.id, x: 6.89, z: 0})).status, 200);
  const before = await latest(owner, room), player = await save(owner, room, scene => scene.objects.push(imageObject(solid, 'player-block', 6, 0)));
  assert.equal(player.status, 409, describe(player)); assert.equal(player.data.code, 'IMAGE_BLOCKS_PLAYER');
  assert.equal((await latest(owner, room)).revision, before.revision);
  assert.equal((await alice.call('/api/presence', 'POST', {roomId: room.id, x: 6.91, z: 0})).status, 200);
  saved = await save(owner, room, scene => scene.objects.push(imageObject(solid, 'player-clear', 6, 0)));
  assert.equal(saved.status, 200, describe(saved));
  // Presence can report standing on an existing collider. An unrelated rename
  // or action edit must not accidentally become a new placement operation.
  assert.equal((await alice.call('/api/presence', 'POST', {roomId: room.id, x: 6, z: 0})).status, 200);
  saved = await save(owner, room, scene => {scene.objects[1].name = 'Same geometry'; scene.objects[1].actions = [{id: 'inspect', type: 'message', message: 'No geometry changed', trigger: 'interact'}];});
  assert.equal(saved.status, 200, describe(saved));
  await assertRejectedUnchanged(owner, room, scene => {scene.objects[1].x = 6.1;}, 409);
});

test('image assets app: the final image collider cannot close a previously open arrival route', async t => {
  const {owner, room} = await setup(t);
  const solid = await upload(owner, room, uploadBody(makePng({width: 32, height: 32}), {name: 'Route cell', floating: false, collisionGrid: [[1]]}));
  const ring = [];
  for (let z = -2; z <= 2; z++) for (const x of [-2, 2]) ring.push(imageObject(solid, `side-${x}-${z}`.replaceAll('-', 'n'), x, z));
  for (const x of [-1, 0, 1]) ring.push(imageObject(solid, `north-${x}`.replaceAll('-', 'n'), x, -2));
  for (const x of [-1, 1]) ring.push(imageObject(solid, `south-${x}`.replaceAll('-', 'n'), x, 2));
  const initial = await save(owner, room, scene => {scene.spawn = {x: 0, z: 0}; scene.objects = ring;});
  assert.equal(initial.status, 200, describe(initial));
  const closing = await save(owner, room, scene => scene.objects.push(imageObject(solid, 'last-opening', 0, 2)));
  assert.equal(closing.status, 400, describe(closing)); assert.equal(closing.data.code, 'IMAGE_BLOCKS_ROUTE');
  const unchanged = await latest(owner, room); assert.equal(unchanged.revision, initial.data.room.revision); assert.deepEqual(unchanged.scene, initial.data.room.scene);
});

test('image assets app: item actions use pinned full extents and committed action data for distance checks', async t => {
  const {owner, alice, room} = await setup(t);
  const entry = await upload(owner, room, uploadBody(makePng({width: 192, height: 64}), {name: 'Wide interactive art'}));
  const placed = {...imageObject(entry, 'interactive-image', 0, 0), actions: [{id: 'inspect', type: 'message', message: 'Committed image message', trigger: 'interact'}]};
  const saved = await save(owner, room, scene => scene.objects.push(placed)); assert.equal(saved.status, 200, describe(saved));
  await joinRoom(alice, room);
  const action = {entityType: 'item', entityId: placed.id, actionId: 'inspect', revision: saved.data.room.revision};
  assert.equal((await alice.call('/api/presence', 'POST', {roomId: room.id, x: 5.6, z: 0})).status, 200);
  const near = await alice.call(`/api/rooms/${room.id}/actions/resolve`, 'POST', {...action, message: 'Forged', width: 0.01, assetRef: {assetId: 'fake', versionId: 'fake'}});
  assert.equal(near.status, 200, describe(near)); assert.equal(near.data.action.message, 'Committed image message');
  assert.equal((await alice.call('/api/presence', 'POST', {roomId: room.id, x: 5.71, z: 0})).status, 200);
  const far = await alice.call(`/api/rooms/${room.id}/actions/resolve`, 'POST', {...action, width: 500});
  assert.equal(far.status, 403, describe(far)); assert.equal(far.data.code, 'ITEM_TOO_FAR');
  const rotated = await save(owner, room, scene => {scene.objects[0].rotation = 90;}); assert.equal(rotated.status, 200, describe(rotated));
  const stale = await alice.call(`/api/rooms/${room.id}/actions/resolve`, 'POST', action); assert.equal(stale.status, 409);
  assert.equal((await alice.call('/api/presence', 'POST', {roomId: room.id, x: 0, z: 5.6})).status, 200);
  const newEdge = await alice.call(`/api/rooms/${room.id}/actions/resolve`, 'POST', {...action, revision: rotated.data.room.revision});
  assert.equal(newEdge.status, 200, describe(newEdge));
});

test('image assets app: resident spawn validation uses pinned sparse collision cells and permits empty/floating pixels', async t => {
  const {owner, room} = await setup(t);
  const colliding = await upload(owner, room, uploadBody(makePng({width: 64, height: 32, pixel: () => [0, 0, 0, 0]}), {name: 'Transparent sparse blocker', floating: false, collisionGrid: [[1, 0]]}));
  const floating = await upload(owner, room, uploadBody(makePng({width: 64, height: 32}), {name: 'Floating image'}));
  const saved = await save(owner, room, scene => scene.objects.push(imageObject(colliding, 'sparse-blocker', 6, 0), imageObject(floating, 'floating', -6, 0)));
  assert.equal(saved.status, 200, describe(saved));
  const endpoint = `/api/rooms/${room.id}/bots`;
  const blocked = await owner.call(endpoint, 'POST', {clientOperationId: 'blocked-image-resident', config: {name: 'Cannot occupy solid cell', spawn: {x: 5.5, z: 0}}});
  assert.equal(blocked.status, 400, describe(blocked)); assert.equal(blocked.data.code, 'BOT_SPAWN_BLOCKED');
  assert.equal((await owner.call(endpoint)).data.bots.length, 0);
  for (const [name, x] of [['Empty grid cell resident', 6.5], ['Floating image resident', -6]]) {
    const made = await owner.call(endpoint, 'POST', {clientOperationId: randomUUID(), config: {name, spawn: {x, z: 0}}});
    assert.equal(made.status, 201, describe(made)); assert.deepEqual(made.data.bot.spawn, {x, z: 0});
  }
  assert.equal((await owner.call(endpoint)).data.bots.length, 2);
});
