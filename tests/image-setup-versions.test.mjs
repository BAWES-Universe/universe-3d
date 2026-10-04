import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {EventEmitter} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeImageAssetSchema, createImageAssetRepository} from '../server/image-asset-store.mjs';
import {createImageAssetService, createImageAssetHttpHandler, IMAGE_UPDATE_JSON_LIMIT, imageReferenceKey} from '../server/image-assets.mjs';
import {normalizeImageAssetSetup} from '../src/image-asset-schema.js';
import {validatePng} from '../server/png-validation.mjs';
import {makePng} from '../fixtures/png-fixtures.mjs';

const NOW = Date.parse('2026-10-04T00:00:00.000Z');
const context = {roomId: 'room-a', userId: 'alice', sessionIdentity: 'session-a'};
const initialGrid = [[0, 0], [1, 1], [1, 1]];
const setup = (depthPivot = .25) => ({depthPreset: 'custom', depthPivot, collisionGrid: [[0, 0], [0, 1], [0, 1]]});
const ref = entry => ({assetId: entry.definition.assetId, versionId: entry.version.versionId});
const scene = entry => ({objects: [{id: 'old-pin', type: 'image', assetRef: ref(entry), x: 2, z: 3, name: 'Instance name', rotation: 90}]});
const change = (entry, operationId = 'setup-op', edited = setup()) => ({operationId, expectedRevision: entry.revision, expectedVersionId: entry.version.versionId, setup: edited});
function fixture(t, {filename = ':memory:', ...options} = {}) {
  const db = new DatabaseSync(filename); db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000'); initializeImageAssetSchema(db);
  let closed = false; const close = () => {if (!closed) {db.close(); closed = true;}}; t.after(close);
  const repo = createImageAssetRepository(db), events = [];
  const state = {read: true, manage: true, decodes: 0, session: {userId: 'alice', currentRoomId: 'room-a', expiresAt: NOW + 10000, sessionEpoch: 1}};
  const makeService = extra => createImageAssetService({repo, now: () => NOW,
    resolveSession: token => token === context.sessionIdentity ? state.session : null,
    authorizeRead: () => state.read, authorizeManage: () => state.manage,
    validateImage: (...args) => {state.decodes++; return validatePng(...args);},
    afterCommit: event => {assert.equal(db.isTransaction, false); events.push(event);}, ...options, ...extra});
  const service = makeService();
  const uploadInput = { ...context, operationId: 'upload-op', draft: {name: 'Original name', tags: ['original'], floating: false, collisionGrid: initialGrid}, bytes: makePng() };
  return {db, repo, service, makeService, state, events, close, uploadInput,
    upload: () => service.create(uploadInput), publish: (entry, operationId, edited) => service.createVersion({...context, assetId: entry.definition.assetId, change: change(entry, operationId, edited)})};
}

test('setup creates a new immutable version from retained PNG bytes and never changes old pins or discovery text', async t => {
  const f = fixture(t), first = await f.upload();
  const sourceRow = f.db.prepare('SELECT * FROM room_image_asset_versions').get();
  const renamed = await f.service.update({...context, assetId: first.definition.assetId, change: {expectedRevision: 1, metadata: {name: 'Library title', description: 'Discovery only', tags: ['latest']}}});
  const pinned = scene(first), unsaved = structuredClone(pinned), draft = setup();
  const result = await f.publish(renamed, 'setup-op', draft), next = result.entry;
  draft.collisionGrid[1][1] = 0;
  assert.equal(f.state.decodes, 1); assert.equal(next.revision, 3); assert.equal(next.version.sequence, 2);
  assert.deepEqual(next.definition, first.definition); assert.deepEqual(next.metadata, renamed.metadata);
  assert.deepEqual(result.published, {...ref(next), sequence: 2}); assert.equal(result.status, 'committed');
  for (const field of ['name', 'tags', 'widthPixels', 'heightPixels', 'byteLength', 'mediaType', 'sha256', 'floating']) assert.deepEqual(next.version[field], first.version[field]);
  assert.deepEqual(next.version.collisionGrid, setup().collisionGrid); assert.equal(next.version.depthPivot, .25);
  assert.deepEqual(f.db.prepare('SELECT * FROM room_image_asset_versions WHERE version_id=?').get(first.version.versionId), sourceRow);
  assert.deepEqual(pinned, unsaved); assert.deepEqual(f.service.readImage({...context, ...ref(next)}).bytes, makePng());
  const resolved = f.repo.transaction(() => f.service.resolveSceneReferences({...context, scene: unsaved}));
  assert.deepEqual(resolved[imageReferenceKey(ref(first))].version, first.version);
  assert.deepEqual(f.service.list(context).entries, [next]);
  assert.deepEqual(f.repo.usage(context.roomId), {definitions: 1, bytes: 2 * makePng().length});
  assert.deepEqual(f.events.at(-1), {type: 'imageAsset.versionCreated', roomId: context.roomId, assetId: first.definition.assetId, versionId: next.version.versionId, revision: 3, status: 'active'});
  assert.throws(() => f.db.prepare('UPDATE room_image_asset_versions SET bytes=? WHERE version_id=?').run(makePng(), next.version.versionId), /immutable/);
});

test('setup helper rejects every mutation outside setup and retains definition floating mode', async t => {
  const f = fixture(t), first = await f.upload();
  for (const extra of [{floating: true}, {representation: 'floor'}, {name: 'Changed'}, {widthPixels: 32}, {bytes: []}, {sha256: 'a'.repeat(64)}, {metadata: {name: 'Changed'}}]) {
    assert.throws(() => normalizeImageAssetSetup({...setup(), ...extra}, first.version), {code: 'UNSUPPORTED_IMAGE_FIELD'});
    await assert.rejects(f.publish(first, 'invalid-op', {...setup(), ...extra}));
  }
  for (const invalid of [{}, {...setup(), depthPivot: 2}, {...setup(), collisionGrid: [[1]]}, {...setup(), collisionGrid: [[0, 0], [0, 2], [0, 0]]}, {...setup(), depthPreset: 'standing'}, {...setup(), collisionGrid: undefined}]) await assert.rejects(f.publish(first, 'invalid-op', invalid));
  const floating = await f.service.create({...f.uploadInput, operationId: 'floating-op', draft: {name: 'Floating', floating: true}});
  await assert.rejects(f.publish(floating, 'floating-grid', setup()), /Floating/);
  const updated = await f.publish(floating, 'floating-depth', {...setup(), collisionGrid: null});
  assert.equal(updated.entry.version.floating, true); assert.equal(updated.entry.version.collisionGrid, null);
  assert.equal(f.repo.versionStats(context.roomId, first.definition.assetId).count, 1);
});

test('unchanged, stale revision/source and malformed operation requests have no side effects or receipts', async t => {
  const f = fixture(t), first = await f.upload(), original = change(first);
  const attempts = [
    [{...original, setup: {depthPreset: 'standing', depthPivot: 1, collisionGrid: initialGrid}}, 'IMAGE_SETUP_UNCHANGED'],
    [{...original, expectedRevision: 2}, 'IMAGE_REVISION_CONFLICT'],
    [{...original, expectedVersionId: 'other-version'}, 'IMAGE_VERSION_CONFLICT'],
    [{...original, expectedRevision: 0}, 'IMAGE_REVISION'],
    [{...original, expectedRevision: '1'}, 'IMAGE_REVISION'],
    [{...original, operationId: ''}, 'IMAGE_INVALID_ID'],
    [{...original, bytes: []}, 'IMAGE_BODY'],
    [{...original, userId: 'forged'}, 'IMAGE_BODY'],
  ];
  for (const [candidate, code] of attempts) await assert.rejects(f.service.createVersion({...context, assetId: first.definition.assetId, change: candidate}), {code});
  assert.deepEqual(f.repo.getCurrent(context.roomId, first.definition.assetId), first);
  assert.equal(f.repo.getOperation(context.roomId, context.userId, original.operationId), null);
  assert.deepEqual(f.repo.usage(context.roomId), {definitions: 1, bytes: makePng().length}); assert.equal(f.events.length, 1);
});

test('exact setup receipts recover once after v3, metadata edits and archive without regressing current or enabling archived placement', async t => {
  const f = fixture(t), first = await f.upload(), second = await f.publish(first), third = await f.publish(second.entry, 'third-op', setup(.75));
  const renamed = await f.service.update({...context, assetId: first.definition.assetId, change: {expectedRevision: third.entry.revision, metadata: {name: 'Newest title', description: '', tags: []}}});
  const archived = await f.service.update({...context, assetId: first.definition.assetId, change: {expectedRevision: renamed.revision, status: 'archived'}});
  const count = f.events.length, expected = {status: 'committed', entry: archived, published: second.published};
  assert.deepEqual(await f.publish(first), expected);
  assert.deepEqual(f.service.reconcileVersion({...context, assetId: first.definition.assetId, operationId: 'setup-op'}), expected);
  await assert.rejects(f.publish(archived, 'after-archive'), {code: 'IMAGE_ARCHIVED'});
  await assert.rejects(f.publish(first, 'setup-op', setup(.5)), {code: 'IMAGE_OPERATION_CONFLICT'});
  assert.throws(() => f.repo.transaction(() => f.service.resolveSceneReferences({...context, scene: scene(second.entry)})), {code: 'IMAGE_ARCHIVED'});
  assert.equal(f.events.length, count); assert.equal(f.repo.versionStats(context.roomId, first.definition.assetId).count, 3);
  f.state.manage = false;
  await assert.rejects(f.publish(first), {code: 'IMAGE_MANAGE_DENIED'});
  assert.throws(() => f.service.reconcileVersion({...context, assetId: first.definition.assetId, operationId: 'setup-op'}), {code: 'IMAGE_MANAGE_DENIED'});
});

test('operation kind, asset, actor and room remain isolated while legacy upload digest/reconciliation stay compatible', async t => {
  const f = fixture(t), first = await f.upload(), uploadedReceipt = f.repo.getOperation(context.roomId, context.userId, 'upload-op');
  await assert.rejects(f.publish(first, 'upload-op'), {code: 'IMAGE_OPERATION_CONFLICT'});
  assert.deepEqual(f.service.reconcileVersion({...context, assetId: first.definition.assetId, operationId: 'upload-op'}), {status: 'not-found'});
  await f.publish(first);
  assert.deepEqual(f.service.reconcileCreate({...context, operationId: 'setup-op'}), {status: 'not-found'});
  await assert.rejects(f.service.create({...f.uploadInput, operationId: 'setup-op'}), {code: 'IMAGE_OPERATION_CONFLICT'});
  assert.deepEqual(f.service.reconcileVersion({...context, assetId: 'other-asset', operationId: 'setup-op'}), {status: 'not-found'});
  await assert.rejects(f.service.createVersion({...context, assetId: 'other-asset', change: change(first)}), {code: 'IMAGE_OPERATION_CONFLICT'});
  assert.equal((await f.upload()).version.versionId, first.version.versionId);
  assert.deepEqual(f.repo.getOperation(context.roomId, context.userId, 'upload-op'), uploadedReceipt);
  f.state.session.userId = 'bob';
  assert.deepEqual(f.service.reconcileVersion({...context, userId: 'bob', assetId: first.definition.assetId, operationId: 'setup-op'}), {status: 'not-found'});
  f.state.session.currentRoomId = 'room-b';
  assert.deepEqual(f.service.reconcileVersion({...context, userId: 'bob', roomId: 'room-b', assetId: first.definition.assetId, operationId: 'setup-op'}), {status: 'not-found'});
  await assert.rejects(f.service.createVersion({...context, userId: 'bob', roomId: 'room-b', assetId: first.definition.assetId, change: change(first, 'new-foreign-op')}), {code: 'IMAGE_NOT_FOUND'});
});

test('real duplicate BLOB quota counts every version and archived asset; lowering version count cap never releases history', async t => {
  const size = makePng().length, f = fixture(t, {limits: {maxRoomBytes: 3 * size, maxRoomDefinitions: 1, maxVersionsPerAsset: 3}}), first = await f.upload();
  const second = await f.publish(first), third = await f.publish(second.entry, 'third-op', setup(.75));
  assert.equal(f.db.prepare('SELECT sum(length(bytes)) AS n FROM room_image_asset_versions').get().n, size * 3);
  await assert.rejects(f.publish(third.entry, 'version-limit', setup(.5)), {code: 'IMAGE_VERSION_LIMIT'});
  const unlimitedVersions = f.makeService({limits: {maxRoomBytes: 3 * size}});
  await assert.rejects(unlimitedVersions.createVersion({...context, assetId: first.definition.assetId, change: change(third.entry, 'byte-limit', setup(.5))}), {code: 'IMAGE_ROOM_QUOTA'});
  const archived = await f.service.update({...context, assetId: first.definition.assetId, change: {expectedRevision: third.entry.revision, status: 'archived'}});
  assert.deepEqual(f.repo.usage(context.roomId), {definitions: 1, bytes: 3 * size});
  await assert.rejects(unlimitedVersions.create({...f.uploadInput, operationId: 'another-definition'}), {code: 'IMAGE_ROOM_QUOTA'});
  const restored = await f.service.update({...context, assetId: first.definition.assetId, change: {expectedRevision: archived.revision, status: 'active'}});
  await assert.rejects(f.publish(restored, 'still-full', setup(.5)), {code: 'IMAGE_VERSION_LIMIT'});
  assert.deepEqual(f.service.reconcileVersion({...context, assetId: first.definition.assetId, operationId: 'setup-op'}).published, second.published);
  assert.equal(f.repo.getOperation(context.roomId, context.userId, 'byte-limit'), null);
});

test('revision and legacy sequence bounds fail before arithmetic and do not create partial state', async t => {
  const f = fixture(t), first = await f.upload();
  f.db.prepare('UPDATE room_image_assets SET revision=?').run(Number.MAX_SAFE_INTEGER);
  await assert.rejects(f.publish({...first, revision: Number.MAX_SAFE_INTEGER}), {code: 'IMAGE_REVISION_LIMIT'});
  f.db.prepare('UPDATE room_image_assets SET revision=1').run();
  const guarded = f.makeService({repo: {...f.repo, get inTransaction() {return f.repo.inTransaction;}, versionStats: () => ({count: 1, sequence: Number.MAX_SAFE_INTEGER})}});
  await assert.rejects(guarded.createVersion({...context, assetId: first.definition.assetId, change: change(first)}), {code: 'IMAGE_VERSION_LIMIT'});
  assert.equal(f.repo.versionStats(context.roomId, first.definition.assetId).count, 1);
  assert.equal(f.repo.getOperation(context.roomId, context.userId, 'setup-op'), null);
});

test('version, current pointer, revision, BLOB and receipt roll back together on storage failure and notify only after commit', async t => {
  const f = fixture(t), first = await f.upload();
  for (const table of ['room_image_asset_versions', 'room_image_asset_operations']) {
    f.db.exec(`CREATE TRIGGER setup_test_fail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected storage failure'); END`);
    await assert.rejects(f.publish(first), /injected storage failure/);
    f.db.exec('DROP TRIGGER setup_test_fail');
    assert.deepEqual(f.repo.getCurrent(context.roomId, first.definition.assetId), first);
    assert.deepEqual(f.repo.usage(context.roomId), {definitions: 1, bytes: makePng().length});
    assert.equal(f.repo.getOperation(context.roomId, context.userId, 'setup-op'), null); assert.equal(f.events.length, 1);
  }
  let deliveries = 0;
  const service = f.makeService({afterCommit() {deliveries++; throw new Error('notification lost');}});
  const args = {...context, assetId: first.definition.assetId, change: change(first)};
  const result = await service.createVersion(args);
  assert.deepEqual(await service.createVersion(args), result); assert.equal(deliveries, 1);
  assert.equal(f.repo.getCurrent(context.roomId, first.definition.assetId).version.versionId, result.published.versionId);
});

test('version authority and epoch are rechecked inside the write transaction, including receipt recovery', async t => {
  const f = fixture(t), first = await f.upload(); await f.publish(first);
  for (const existing of [true, false]) {
    const service = f.makeService({transaction(fn) {f.state.manage = false; return f.repo.transaction(fn);}});
    await assert.rejects(service.createVersion({...context, assetId: first.definition.assetId, change: change(first, existing ? 'setup-op' : 'new-op')}), {code: 'IMAGE_MANAGE_DENIED'});
    f.state.manage = true;
  }
  const stamp = f.service.checkAccess(context, {manage: true}); f.state.session.sessionEpoch++;
  await assert.rejects(f.service.createVersion({...context, assetId: first.definition.assetId, change: change(first), expectedSessionStamp: stamp}), {code: 'IMAGE_SESSION_CHANGED'});
  assert.equal(f.repo.versionStats(context.roomId, first.definition.assetId).count, 2);
});

test('independent SQLite connections serialize duplicate setup retries and competing source revisions without overbooking', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'image-versions-')); t.after(() => rmSync(directory, {recursive: true, force: true}));
  const filename = join(directory, 'images.sqlite'), a = fixture(t, {filename}), first = await a.upload(), b = fixture(t, {filename});
  const same = await Promise.all([a.publish(first), b.publish(first)]);
  assert.deepEqual(same[0], same[1]); assert.equal(a.events.length + b.events.length, 2);
  const results = await Promise.allSettled([a.publish(same[0].entry, 'competitor-a', setup(.5)), b.publish(same[1].entry, 'competitor-b', setup(.75))]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.find(value => value.status === 'rejected').reason.code, 'IMAGE_REVISION_CONFLICT');
  assert.equal(a.repo.usage(context.roomId).bytes, 3 * makePng().length);
  a.close(); b.close();
});

test('restart preserves setup history, migrated legacy receipts, current discovery and exact saved/unsaved pins', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'image-versions-restart-')); t.after(() => rmSync(directory, {recursive: true, force: true}));
  const filename = join(directory, 'images.sqlite'); let f = fixture(t, {filename});
  const first = await f.upload(), initialReceipt = f.repo.getOperation(context.roomId, context.userId, 'upload-op');
  f.db.exec('ALTER TABLE room_image_asset_operations DROP COLUMN operation_kind');
  initializeImageAssetSchema(f.db);
  assert.deepEqual(f.repo.getOperation(context.roomId, context.userId, 'upload-op'), initialReceipt);
  f.db.exec('CREATE TABLE saved_pin(scene TEXT NOT NULL)'); f.db.prepare('INSERT INTO saved_pin VALUES(?)').run(JSON.stringify(scene(first)));
  const second = await f.publish(first); f.close(); f = fixture(t, {filename});
  const pinned = JSON.parse(f.db.prepare('SELECT scene FROM saved_pin').get().scene);
  const resolved = f.repo.transaction(() => f.service.resolveSceneReferences({...context, scene: pinned}));
  assert.deepEqual(resolved[imageReferenceKey(ref(first))].version, first.version);
  assert.deepEqual(f.service.list(context).entries, [second.entry]);
  assert.deepEqual(f.service.reconcileVersion({...context, assetId: first.definition.assetId, operationId: 'setup-op'}), second);
  assert.deepEqual(await f.publish(first), second); assert.equal(f.events.length, 0);
  assert.deepEqual(f.service.readImage({...context, ...ref(first)}).bytes, makePng());
  assert.deepEqual(f.service.readImage({...context, ...ref(second.entry)}).bytes, makePng()); f.close();
});

function httpRequest(handler, entry, {method = 'POST', suffix = '', headers = {}} = {}) {
  const req = new EventEmitter(); Object.assign(req, {url: `/api/rooms/room-a/assets/${entry.definition.assetId}/versions${suffix}`, method, headers: {'content-type': 'application/json', ...headers}, resume() {}});
  const res = {headersSent: false, writeHead(status, headers) {Object.assign(this, {status, headers, headersSent: true});}, end(body) {this.body = JSON.parse(body);}, destroy() {}};
  const pending = handler(req, res);
  return {req, res, pending, async finish(body) {req.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))); req.emit('end'); await pending; return res;}};
}

test('setup HTTP is bounded strict JSON, rejects byte/authority claims and never consumes an aborted operation', async t => {
  const f = fixture(t), first = await f.upload(), handler = createImageAssetHttpHandler({service: f.service, getIdentity: () => context});
  for (const headers of [{'content-length': String(IMAGE_UPDATE_JSON_LIMIT + 1)}, {'content-type': 'text/plain'}, {'content-encoding': 'gzip'}]) {
    const request = httpRequest(handler, first, {headers}); await request.pending; assert.ok([413, 415].includes(request.res.status));
  }
  for (const body of [Buffer.alloc(IMAGE_UPDATE_JSON_LIMIT + 1, 32), Buffer.from('{'), Buffer.from([0xff]), {...change(first), pngBase64: 'AAAA'}, {...change(first), roomId: 'room-b'}, {...change(first), canManage: true}]) {
    const result = await httpRequest(handler, first).finish(body); assert.ok([400, 413].includes(result.status));
  }
  const aborted = httpRequest(handler, first); aborted.req.emit('data', Buffer.from('{')); aborted.req.emit('aborted'); await aborted.pending;
  assert.equal(aborted.res.status, 400); assert.equal(f.repo.getOperation(context.roomId, context.userId, 'setup-op'), null);
  const result = await httpRequest(handler, first).finish(change(first)); assert.equal(result.status, 201);
  const reconciled = httpRequest(handler, first, {method: 'GET', suffix: '/operations/setup-op'}); await reconciled.pending;
  assert.deepEqual(reconciled.res.body, result.body); assert.equal(reconciled.res.headers['Cache-Control'], 'private, no-store');
});

for (const mutation of ['role', 'read', 'logout', 'actor', 'room', 'expiry', 'epoch']) test(`setup HTTP rechecks ${mutation} after body admission for fresh requests and exact retries`, async t => {
  const f = fixture(t), first = await f.upload(), second = await f.publish(first), handler = createImageAssetHttpHandler({service: f.service, getIdentity: () => context});
  const originalSession = structuredClone(f.state.session);
  for (const [entry, operationId] of [[second.entry, 'new-op'], [first, 'setup-op']]) {
    Object.assign(f.state, {read: true, manage: true, session: structuredClone(originalSession)});
    const request = httpRequest(handler, first);
    if (mutation === 'role') f.state.manage = false;
    if (mutation === 'read') f.state.read = false;
    if (mutation === 'logout') f.state.session = null;
    if (mutation === 'actor') f.state.session.userId = 'other';
    if (mutation === 'room') f.state.session.currentRoomId = 'room-b';
    if (mutation === 'expiry') f.state.session.expiresAt = NOW;
    if (mutation === 'epoch') f.state.session.sessionEpoch++;
    const result = await request.finish(change(entry, operationId, operationId === 'new-op' ? setup(.75) : setup()));
    assert.ok([401, 403, 404, 409].includes(result.status));
    if (mutation === 'epoch') assert.equal(result.body.error.code, 'IMAGE_SESSION_CHANGED');
  }
  assert.equal(f.repo.versionStats(context.roomId, first.definition.assetId).count, 2); assert.equal(f.events.length, 2);
});
