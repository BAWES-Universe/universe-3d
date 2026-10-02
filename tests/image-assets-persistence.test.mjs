import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeImageAssetSchema, createImageAssetRepository } from '../server/image-asset-store.mjs';
import { createImageAssetService, imageReferenceKey } from '../server/image-assets.mjs';
import { validatePng } from '../server/png-validation.mjs';
import { makePng } from '../fixtures/png-fixtures.mjs';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const context = { roomId: 'room-a', userId: 'alice', sessionIdentity: 'session-a' };
const draft = { name: 'Oak panel', tags: ['garden', 'tree'], floating: false, collisionGrid: [[0, 0], [1, 1], [1, 1]], depthPreset: 'custom', depthPivot: 0.75 };
const input = () => ({ ...context, draft, bytes: makePng(), mediaType: 'image/png', operationId: 'saved-operation' });
const reference = entry => ({ assetId: entry.definition.assetId, versionId: entry.version.versionId });
function store(filename, overrides = {}) {
  const db = new DatabaseSync(filename); db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000');
  initializeImageAssetSchema(db);
  const repo = createImageAssetRepository(db), state = { read: true, manage: true };
  const service = createImageAssetService({ repo, now: () => NOW,
    resolveSession: token => token === 'session-a' ? { userId: 'alice', currentRoomId: 'room-a', expiresAt: NOW + 10000 } : null,
    authorizeRead: () => state.read, authorizeManage: () => state.manage, validateImage: validatePng, ...overrides });
  return { db, repo, service, state };
}
function temporary(t) {
  const path = mkdtempSync(join(tmpdir(), 'image-assets-owned-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return join(path, 'images.sqlite');
}
function insertFixtureVersion(db, entry, version, bytes = makePng()) {
  db.prepare('INSERT INTO room_image_asset_versions(room_id,asset_id,version_id,sequence,version_json,sha256,byte_length,bytes) VALUES(?,?,?,?,?,?,?,?)').run(entry.definition.roomId, entry.definition.assetId, version.versionId, version.sequence, JSON.stringify(version), version.sha256, bytes.length, bytes);
}

test('file-backed restart preserves exact image bytes, metadata, identities and scene reference pins', async t => {
  const filename = temporary(t);
  let f = store(filename);
  const entry = await f.service.create(input());
  const savedScene = { objects: [{ id: 'one', type: 'image', assetRef: reference(entry), x: 2, z: 3, rotation: 90, name: 'My renamed instance', actions: [] }, { id: 'two', type: 'image', assetRef: reference(entry), x: 5, z: 6, rotation: 180 }] };
  f.db.exec('CREATE TABLE owned_scene_fixture(room_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,scene TEXT NOT NULL)');
  f.service.withResolvedSceneReferences({ ...context, scene: savedScene }, resolved => {
    assert.deepEqual(resolved[imageReferenceKey(reference(entry))], entry);
    f.db.prepare('INSERT INTO owned_scene_fixture VALUES(?,?,?)').run('room-a', 1, JSON.stringify(savedScene));
  });
  f.db.close();
  f = store(filename); t.after(() => f.db.close());
  const row = f.db.prepare('SELECT * FROM owned_scene_fixture WHERE room_id=?').get('room-a');
  assert.equal(row.revision, 1); assert.deepEqual(JSON.parse(row.scene), savedScene);
  const resolved = f.repo.transaction(() => f.service.resolveSceneReferences({ ...context, scene: JSON.parse(row.scene) }));
  assert.deepEqual(resolved[imageReferenceKey(reference(entry))], entry);
  assert.deepEqual(f.service.readImage({ ...context, ...reference(entry) }).bytes, makePng());
  assert.deepEqual(f.service.list({ ...context, query: 'GARDEN' }).entries, [entry]);
  assert.deepEqual(await f.service.create(input()), entry);
  assert.deepEqual(f.service.reconcileCreate({ ...context, operationId: 'saved-operation' }), { status: 'committed', entry });
  assert.equal(f.repo.usage('room-a').definitions, 1);
  f.state.read = false;
  assert.throws(() => f.service.readImage({ ...context, ...reference(entry), head: true }), { code: 'IMAGE_NOT_FOUND' });
  assert.throws(() => f.repo.transaction(() => f.service.resolveSceneReferences({ ...context, scene: savedScene })), { code: 'IMAGE_NOT_FOUND' });
});

test('current-version fixture changes discovery but never upgrades an older pinned scene', async t => {
  const filename = temporary(t); let f = store(filename);
  const entry = await f.service.create(input());
  const next = { ...entry.version, versionId: 'version-next', sequence: 2, name: 'Oak updated', tags: ['new'], depthPivot: 0.25 };
  // Fixture-only SQL models a later host-owned atomic version transaction. There
  // is intentionally no public publish/delete service in this first slice.
  f.repo.transaction(() => {
    insertFixtureVersion(f.db, entry, next);
    f.db.prepare('UPDATE room_image_assets SET current_version_id=?,revision=revision+1 WHERE room_id=? AND asset_id=?').run(next.versionId, 'room-a', entry.definition.assetId);
  });
  f.db.close(); f = store(filename); t.after(() => f.db.close());
  assert.equal(f.service.list(context).entries[0].version.versionId, next.versionId);
  const resolved = f.repo.transaction(() => f.service.resolveSceneReferences({ ...context, scene: { objects: [{ id: 'old', type: 'image', assetRef: reference(entry), x: 0, z: 0 }] } }));
  assert.equal(resolved[imageReferenceKey(reference(entry))].version.name, 'Oak panel');
  assert.equal(resolved[imageReferenceKey(reference(entry))].version.depthPivot, 0.75);
  assert.equal(f.repo.usage('room-a').bytes, 2 * makePng().length);
  assert.deepEqual(await f.service.create(input()), entry);
});

test('storage enforces consecutive immutable versions, fixed floating and room-bound current pointer', async t => {
  const f = store(temporary(t)); t.after(() => f.db.close());
  const entry = await f.service.create(input());
  assert.throws(() => f.repo.transaction(() => insertFixtureVersion(f.db, entry, { ...entry.version, versionId: 'skip-version', sequence: 3 })), /consecutive/);
  assert.throws(() => f.repo.transaction(() => insertFixtureVersion(f.db, entry, { ...entry.version, versionId: 'floating-version', sequence: 2, floating: true, collisionGrid: null })), /Floating/);
  assert.throws(() => f.repo.transaction(() => insertFixtureVersion(f.db, entry, { ...entry.version, versionId: 'foreign-version', sequence: 2, roomId: 'room-b' })), /CHECK constraint/);
  assert.throws(() => f.repo.transaction(() => f.db.prepare('UPDATE room_image_assets SET current_version_id=? WHERE room_id=? AND asset_id=?').run('missing', 'room-a', entry.definition.assetId)), /FOREIGN KEY/);
  assert.equal(f.repo.usage('room-a').definitions, 1); assert.equal(f.repo.usage('room-a').bytes, makePng().length);
});

test('storage failures roll back definition, version, bytes and operation together', async t => {
  const f = store(temporary(t)); t.after(() => f.db.close());
  const brokenRepo = new Proxy(f.repo, { get(target, name) {
    if (name === 'insertCreated') return value => { target.insertCreated(value); throw new Error('fixture write fault'); };
    return Reflect.get(target, name);
  } });
  const service = createImageAssetService({ repo: brokenRepo, now: () => NOW,
    resolveSession: () => ({ userId: 'alice', currentRoomId: 'room-a', expiresAt: NOW + 10000 }),
    authorizeRead: () => true, authorizeManage: () => true, validateImage: validatePng });
  await assert.rejects(service.create(input()), /fixture write fault/);
  assert.deepEqual(f.repo.usage('room-a'), { definitions: 0, bytes: 0 });
  assert.equal(f.repo.getOperation('room-a', 'alice', 'saved-operation'), null);
  assert.equal(f.db.isTransaction, false);
});

test('independent SQLite connections cannot overbook quota after asynchronous decode', async t => {
  const filename = temporary(t); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const options = { limits: { maxRoomDefinitions: 1 }, validateImage: async (...args) => { await gate; return validatePng(...args); } };
  const a = store(filename, options), b = store(filename, options); t.after(() => { a.db.close(); b.db.close(); });
  const pending = [a.service.create(input()), b.service.create({ ...input(), operationId: 'second' })];
  release(); const results = await Promise.allSettled(pending);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'IMAGE_ROOM_QUOTA');
  assert.equal(a.repo.usage('room-a').definitions, 1); assert.equal(b.repo.usage('room-a').definitions, 1);
});

test('nested host scene transaction can roll back resolved references and its scene writes', async t => {
  const f = store(temporary(t)); t.after(() => f.db.close()); const entry = await f.service.create(input());
  f.db.exec('CREATE TABLE owned_scene_fixture(revision INTEGER NOT NULL,scene TEXT NOT NULL)');
  f.db.exec('BEGIN IMMEDIATE');
  const draftScene = { objects: [{ id: 'placed', type: 'image', assetRef: reference(entry), x: 0, z: 0 }] };
  f.service.withResolvedSceneReferences({ ...context, scene: draftScene }, () => f.db.prepare('INSERT INTO owned_scene_fixture VALUES(?,?)').run(1, JSON.stringify(draftScene)));
  assert.equal(f.db.isTransaction, true);
  f.db.exec('ROLLBACK');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM owned_scene_fixture').get().n, 0);
  assert.equal(f.repo.usage('room-a').definitions, 1);
});
