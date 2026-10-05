import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deployPreview } from '../deploy/preview/controller.mjs';
import { GitHub } from '../deploy/preview/github.mjs';
import { LinuxHostSystem } from '../deploy/preview/host-system.mjs';
import { fingerprint } from '../deploy/preview/contracts.mjs';
import { assertReaderCompatible, descriptorBlobSha, IMAGE_SIZE_CAPABILITY as cap, FURNITURE_CAPABILITY as furnitureCap, IMAGE_READER_PATH, IMAGE_FLOOR_KEY } from '../deploy/preview/image-reader.mjs';
import { checkImageReaderCompatibility } from '../server/image-client-protocol.mjs';
import { fixture, readerEvidence, storage, digest, sha } from './preview/fixtures.mjs';
const mutations = f => f.adapter.calls.filter(Array.isArray);
const starts = f => mutations(f).filter(c => c[0] === 'start');
async function blocked(f, code) {
  await assert.rejects(deployPreview(f), { code });
  assert.deepEqual(mutations(f), []);
  assert.equal(f.adapter.state.version, 1, 'no durable mutation before compatibility proof');
}
function descriptorFor(f, targetDigest, descriptor) {
  const read = f.adapter.readImageReaderDescriptor.bind(f.adapter);
  f.adapter.readImageReaderDescriptor = async target => target.digest === targetDigest ? readerEvidence(target, descriptor) : read(target);
  const review = f.policy.imageReaderCompatibility.find(r => r.digest === targetDigest);
  review.descriptorBlobSha = descriptorBlobSha(Buffer.from(JSON.stringify(descriptor)));
}

test('trusted deployment validator agrees with the application reader contract', () => {
  for (const requirement of [storage(), storage([cap]), storage([furnitureCap]), storage([cap, furnitureCap]), {}, { version: 2, requiredReaderCapabilities: [] }, storage(['future']), storage([cap, cap]), storage([furnitureCap, furnitureCap])]) {
    for (const descriptor of [undefined, null, {}, { version: 1, readerCapabilities: [] }, { version: 1, readerCapabilities: [cap] }, { version: 1, readerCapabilities: [furnitureCap] }, { version: 1, readerCapabilities: [cap, furnitureCap] }, { version: 1, readerCapabilities: ['future'] }, { version: 1, readerCapabilities: [cap, cap] }, { version: 1, readerCapabilities: [furnitureCap, furnitureCap] }, { version: 1, readerCapabilities: [cap], extra: true }]) {
      const expected = checkImageReaderCompatibility(requirement, descriptor);
      if (expected.compatible) assert.doesNotThrow(() => assertReaderCompatible(requirement, descriptor));
      else assert.throws(() => assertReaderCompatible(requirement, descriptor), { code: expected.code });
    }
  }
});
test('candidate and prior descriptor absence blocks even when storage has no floor', async t => {
  for (const target of ['candidate', 'prior']) await t.test(target, async () => {
    const f = fixture(); const read = f.adapter.readImageReaderDescriptor.bind(f.adapter);
    f.release.readerCapabilities = [cap]; // An artifact claim is never authority.
    f.adapter.readImageReaderDescriptor = async value => ({ ...await read(value), ...(value.digest === (target === 'candidate' ? f.release.digest : digest('1')) ? { descriptor: undefined } : {}) });
    await blocked(f, 'IMAGE_READER_DESCRIPTOR_MISSING');
  });
});
test('invalid or incompatible descriptors never reach stop', async t => {
  for (const descriptor of [{ version: 1, readerCapabilities: [] }, { version: 2, readerCapabilities: [cap] }, { version: 1, readerCapabilities: ['future'] }, { version: 1, readerCapabilities: [cap], extra: true }]) await t.test(JSON.stringify(descriptor), async () => {
    const f = fixture(); f.adapter.evidence.database.storageCompatibility = storage([cap]);
    descriptorFor(f, f.release.digest, descriptor);
    await blocked(f, descriptor.version === 1 && descriptor.readerCapabilities.length === 0 ? 'IMAGE_READER_CAPABILITY_MISSING' : 'IMAGE_READER_DESCRIPTOR_INVALID');
  });
});
test('startup floor advancement rejects an incapable prior before any row or mutation exists', async () => {
  const f = fixture(); descriptorFor(f, digest('1'), { version: 1, readerCapabilities: [] });
  assert.deepEqual(f.adapter.evidence.database.storageCompatibility, storage());
  assert.deepEqual(f.policy.imageReaderCompatibility[0].possibleStorageRequirements, storage(), 'even a claimed off flag cannot lower the conservative bound');
  await blocked(f, 'IMAGE_READER_CAPABILITY_MISSING');
});
test('a furniture-capable candidate cannot start while the rollback image is image-only', async () => {
  const f = fixture();
  descriptorFor(f, f.release.digest, { version: 1, readerCapabilities: [cap, furnitureCap] });
  assert.deepEqual(f.adapter.evidence.database.storageCompatibility, storage(), 'even legacy storage must retain a safe rollback after candidate writes');
  await blocked(f, 'IMAGE_READER_CAPABILITY_MISSING');
});
test('an observed furniture floor rejects an image-only candidate and prior', async t => {
  for (const target of ['candidate', 'prior']) await t.test(target, async () => {
    const f = fixture();
    f.adapter.evidence.database.storageCompatibility = storage([furnitureCap]);
    descriptorFor(f, target === 'candidate' ? digest('1') : f.release.digest, { version: 1, readerCapabilities: [cap, furnitureCap] });
    await blocked(f, 'IMAGE_READER_CAPABILITY_MISSING');
  });
});
test('reviewed furniture readers permit rollback while retaining both observed capabilities', async () => {
  const f = fixture();
  for (const target of [f.release.digest, digest('1')]) descriptorFor(f, target, { version: 1, readerCapabilities: [cap, furnitureCap] });
  f.adapter.failures.health = true;
  const start = f.adapter.startPinned.bind(f.adapter);
  f.adapter.startPinned = async options => { await start(options); f.adapter.evidence.database.storageCompatibility = storage([furnitureCap, cap]); };
  assert.equal((await deployPreview(f)).outcome, 'rolled-back');
  assert.deepEqual(f.adapter.state.current.storageCompatibility, storage([furnitureCap, cap]));
  assert.equal(starts(f).length, 2);
});
test('an unexpected furniture floor prevents rollback to an older image-only reader', async () => {
  const f = fixture(); f.adapter.failures.health = true;
  const start = f.adapter.startPinned.bind(f.adapter);
  f.adapter.startPinned = async options => { await start(options); f.adapter.evidence.database.storageCompatibility = storage([furnitureCap, cap]); };
  const result = await deployPreview(f);
  assert.equal(result.outcome, 'frozen-recovery-uncertain');
  assert.equal(result.recoveryError, 'IMAGE_READER_CAPABILITY_MISSING');
  assert.equal(starts(f).length, 1, 'never start the incompatible rollback writer');
});
test('descriptor review requires exact digest, SHA, tree, blob and a valid explicit potential bound', async t => {
  const cases = [
    row => { row.digest = digest('9'); }, row => { row.sha = sha('9'); }, row => { row.tree = sha('9'); },
    row => { row.descriptorBlobSha = sha('9'); }, row => { delete row.reviewId; }
  ];
  for (const [index, change] of cases.entries()) await t.test(String(index), async () => { const f = fixture(); change(f.policy.imageReaderCompatibility[0]); await blocked(f, 'IMAGE_READER_REVIEW_MISSING'); });
  const absent = fixture(); delete absent.policy.imageReaderCompatibility; await blocked(absent, 'IMAGE_READER_REVIEW_MISSING');
  const duplicate = fixture(); duplicate.policy.imageReaderCompatibility.push(duplicate.policy.imageReaderCompatibility[0]); await blocked(duplicate, 'IMAGE_READER_REVIEW_MISSING');
  for (const value of [undefined, {}, storage(['future'])]) { const f = fixture(); f.policy.imageReaderCompatibility[0].possibleStorageRequirements = value; await blocked(f, 'IMAGE_STORAGE_REQUIREMENT_INVALID'); }
});
test('wrong source identity or descriptor path cannot borrow a review', async t => {
  for (const key of ['digest', 'sha', 'tree', 'path', 'blobSha']) await t.test(key, async () => {
    const f = fixture(); const read = f.adapter.readImageReaderDescriptor.bind(f.adapter);
    f.adapter.readImageReaderDescriptor = async target => ({ ...await read(target), [key]: 'forged' });
    await blocked(f, 'IMAGE_READER_EVIDENCE_MISMATCH');
  });
});
test('missing, invalid or unproven storage requirements block before mutation', async t => {
  for (const value of [undefined, {}, storage(['future']), storage([cap, cap])]) await t.test(JSON.stringify(value), async () => { const f = fixture(); f.adapter.evidence.database.storageCompatibility = value; await blocked(f, 'IMAGE_STORAGE_REQUIREMENT_INVALID'); });
  const f = fixture(); delete f.adapter.evidence.database.storageEvidenceKind; await blocked(f, 'IMAGE_STORAGE_EVIDENCE_UNPROVEN');
});
test('durably observed floor cannot silently regress', async () => {
  const f = fixture(); f.adapter.state.current.storageCompatibility = storage([cap]);
  await blocked(f, 'IMAGE_STORAGE_FLOOR_REGRESSED');
});
test('post-stop floor is read again before candidate start and retained in healthy state', async () => {
  const f = fixture(); const stop = f.adapter.stop.bind(f.adapter);
  f.adapter.stop = async (...args) => { const value = await stop(...args); f.adapter.evidence.database.storageCompatibility = storage([cap]); return value; };
  const result = await deployPreview(f);
  assert.equal(result.outcome, 'healthy');
  assert.deepEqual(f.adapter.state.current.storageCompatibility, storage([cap]));
  assert(f.adapter.calls.lastIndexOf('preflight') > f.adapter.calls.indexOf('backup'));
});
test('unknown post-stop floor prevents both candidate and rollback starts', async () => {
  const f = fixture(); const stop = f.adapter.stop.bind(f.adapter);
  f.adapter.stop = async (...args) => { const value = await stop(...args); f.adapter.evidence.database.storageCompatibility = storage(['future']); return value; };
  const result = await deployPreview(f);
  assert.equal(result.outcome, 'frozen-recovery-uncertain'); assert.equal(result.recoveryError, 'IMAGE_STORAGE_REQUIREMENT_INVALID'); assert.deepEqual(starts(f), []);
});
test('candidate startup floor is checked against actual storage during compatible rollback', async () => {
  const f = fixture(); f.adapter.failures.health = true;
  assert.equal((await deployPreview(f)).outcome, 'rolled-back');
  assert.deepEqual(f.adapter.state.current.storageCompatibility, storage([cap]));
  assert.equal(starts(f).length, 2);
});
test('a floor observed at candidate runtime cannot disappear after a stale selection or bad health', async t => {
  for (const failure of ['stale-selection', 'bad-health']) await t.test(failure, async () => {
    const f = fixture(), verify = f.adapter.verifyRunning.bind(f.adapter);
    f.adapter.verifyRunning = async () => {
      const actual = await verify();
      assert.deepEqual(actual.storageCompatibility, storage([cap]));
      if (failure === 'stale-selection') f.desired.generation = 'e'.repeat(64);
      else actual.healthy = false;
      f.adapter.evidence.database.storageCompatibility = storage();
      return actual;
    };
    const result = await deployPreview(f);
    assert.equal(result.outcome, 'frozen-recovery-uncertain'); assert.equal(result.recoveryError, 'IMAGE_STORAGE_FLOOR_REGRESSED'); assert.equal(starts(f).length, 1);
  });
});
test('unknown or missing recovery requirements freeze instead of starting a rollback writer', async t => {
  for (const value of [undefined, storage(['future'])]) await t.test(JSON.stringify(value), async () => {
    const f = fixture(); f.adapter.failures.health = true; const read = f.adapter.readDatabaseSchema.bind(f.adapter);
    f.adapter.readDatabaseSchema = async () => ({ ...await read(), storageCompatibility: value });
    const result = await deployPreview(f);
    assert.equal(result.outcome, 'frozen-recovery-uncertain'); assert.equal(result.recoveryError, 'IMAGE_STORAGE_REQUIREMENT_INVALID'); assert.equal(starts(f).length, 1);
  });
});
test('final recovery preflight cannot reuse the earlier stopped storage snapshot', async () => {
  const f = fixture(); f.adapter.failures.health = true; const read = f.adapter.preflight.bind(f.adapter); let count = 0;
  f.adapter.preflight = async () => { const evidence = await read(); if (++count === 3) evidence.database.storageCompatibility = storage(['future']); return evidence; };
  const result = await deployPreview(f);
  assert.equal(result.outcome, 'frozen-recovery-uncertain'); assert.equal(result.recoveryError, 'IMAGE_STORAGE_REQUIREMENT_INVALID'); assert.equal(starts(f).length, 1);
});
test('slow desired-selection read cannot turn expired stopped evidence into start permission', async () => {
  const f = fixture(); let clock = f.now(); f.now = () => clock; let calls = 0; const read = f.desiredSource.read;
  f.desiredSource.read = async () => { if (++calls === 5) clock += f.policy.maxEvidenceAgeMs + 1; return read(); };
  const result = await deployPreview(f);
  assert.equal(result.outcome, 'frozen-recovery-uncertain'); assert.equal(starts(f).length, 0);
});

function githubFixture(change = () => {}) {
  const f = fixture(), bytes = Buffer.from(JSON.stringify({ version: 1, readerCapabilities: [cap] }));
  const file = { type: 'file', path: IMAGE_READER_PATH, encoding: 'base64', size: bytes.length, sha: descriptorBlobSha(bytes), content: bytes.toString('base64') };
  change(file); const paths = [];
  const github = new GitHub({ repository: f.policy.repository, fetcher: async url => { paths.push(url); return { ok: true, status: 200, json: async () => url.includes('/git/commits/') ? { tree: { sha: f.release.tree } } : file }; } });
  return { ...f, github, paths, file };
}
test('descriptor source reads are pinned to exact commit/tree and verified as Git blob data', async () => {
  const f = githubFixture(); const evidence = await f.github.imageReaderDescriptor(f.release);
  assert.equal(evidence.blobSha, f.file.sha); assert.equal(evidence.digest, f.release.digest);
  assert(f.paths[0].endsWith(`/git/commits/${f.release.sha}`)); assert(f.paths[1].endsWith(`/${IMAGE_READER_PATH}?ref=${f.release.sha}`));
});
test('descriptor source rejects wrong tree, absent file, symlink, oversized or hash-mismatched data', async t => {
  for (const change of [f => { f.type = 'symlink'; }, f => { f.path = 'other.json'; }, f => { f.size = 4097; }, f => { f.content = ''; }, f => { f.sha = sha('9'); }]) await t.test(String(change), async () => { const f = githubFixture(change); await assert.rejects(f.github.imageReaderDescriptor(f.release)); });
  const f = githubFixture(); await assert.rejects(f.github.imageReaderDescriptor({ ...f.release, tree: sha('9') }), { code: 'SOURCE_TREE_MISMATCH' });
  assert.equal(f.paths.length, 1);
  const absent = new GitHub({ repository: f.policy.repository, fetcher: async () => ({ ok: false, status: 404 }) });
  await assert.rejects(absent.imageReaderDescriptor(f.release), { code: 'GITHUB_READ_FAILED' });
});

async function databaseFixture(t, extraSchema = '') {
  const directory = await mkdtemp(join(tmpdir(), 'preview-reader-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'universe.sqlite'), db = new DatabaseSync(path);
  db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE room_image_asset_versions(version_json TEXT)');
  if (extraSchema) db.exec(extraSchema);
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const schemas = [{ fingerprint: fingerprint(rows), schema: 'synthetic-v1', reviewId: 'synthetic-schema-review' }];
  t.after(() => db.close());
  return { directory, path, db, observe: () => new LinuxHostSystem().schema(directory, 'universe.sqlite', schemas) };
}
test('real read-only SQLite observer finds startup floor without rows and sized rows without floor', async t => {
  const f = await databaseFixture(t); assert.deepEqual((await f.observe()).storageCompatibility, storage());
  f.db.prepare('INSERT INTO metadata VALUES(?,?)').run(IMAGE_FLOOR_KEY, cap);
  const before = await readFile(f.path); const observed = await f.observe();
  assert.deepEqual(observed.storageCompatibility, storage([cap])); assert.equal(observed.storageEvidenceKind, 'sqlite-metadata-and-image-rows');
  assert.deepEqual(await readFile(f.path), before, 'observation does not persist or rewrite metadata');
  f.db.prepare('DELETE FROM metadata').run(); f.db.prepare('INSERT INTO room_image_asset_versions VALUES(?)').run('{"widthMetres":null}');
  assert.deepEqual((await f.observe()).storageCompatibility, storage([cap]));
});
test('invalid floor and malformed image JSON cannot masquerade as legacy-safe storage', async t => {
  const f = await databaseFixture(t);
  for (const value of ['', null, 'image-physical-size-v2']) {
    f.db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run(IMAGE_FLOOR_KEY, value);
    await assert.rejects(f.observe(), { code: 'IMAGE_STORAGE_REQUIREMENT_INVALID' });
  }
  f.db.prepare('DELETE FROM metadata').run(); f.db.prepare('INSERT INTO room_image_asset_versions VALUES(?)').run('{');
  await assert.rejects(f.observe(), { code: 'IMAGE_STORAGE_REQUIREMENT_INVALID' });
});
const furnitureSchema = 'CREATE TABLE rooms(id TEXT PRIMARY KEY,scene TEXT); CREATE TABLE room_furniture_protocol_floor(room_id TEXT PRIMARY KEY,capability TEXT)';
test('legacy scenes and an empty furniture-floor table introduce no reader requirement', async t => {
  const f = await databaseFixture(t, furnitureSchema);
  f.db.prepare('INSERT INTO rooms VALUES(?,?)').run('legacy', JSON.stringify({ objects: [{ type: 'cube' }, { type: 'image' }, null, 'composition'] }));
  assert.deepEqual((await f.observe()).storageCompatibility, storage());
});
test('read-only SQLite observes furniture floor even after all composition placements are removed', async t => {
  const f = await databaseFixture(t, furnitureSchema);
  f.db.prepare('INSERT INTO rooms VALUES(?,?)').run('room', '{"objects":[]}');
  f.db.prepare('INSERT INTO room_furniture_protocol_floor VALUES(?,?)').run('room', furnitureCap);
  const before = await readFile(f.path);
  assert.deepEqual((await f.observe()).storageCompatibility, storage([furnitureCap]));
  assert.deepEqual(await readFile(f.path), before, 'observation leaves every persisted byte unchanged');
});
test('composition scene rows require the reader even without a floor table', async t => {
  const f = await databaseFixture(t, 'CREATE TABLE rooms(id TEXT PRIMARY KEY,scene TEXT)');
  f.db.prepare('INSERT INTO rooms VALUES(?,?)').run('room', JSON.stringify({ objects: [{ type: 'composition', assetRef: { assetId: 'asset', revision: 1 } }] }));
  assert.deepEqual((await f.observe()).storageCompatibility, storage([furnitureCap]));
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='room_furniture_protocol_floor'").get(), undefined, 'observer never migrates legacy data');
  f.db.prepare('INSERT INTO metadata VALUES(?,?)').run(IMAGE_FLOOR_KEY, cap);
  assert.deepEqual((await f.observe()).storageCompatibility, storage([furnitureCap, cap]));
});
test('invalid furniture floors and malformed scene JSON fail closed', async t => {
  const f = await databaseFixture(t, furnitureSchema);
  for (const value of ['', null, 'composition-furniture-v2', cap]) {
    f.db.prepare('INSERT OR REPLACE INTO room_furniture_protocol_floor VALUES(?,?)').run('room', value);
    await assert.rejects(f.observe(), { code: 'IMAGE_STORAGE_REQUIREMENT_INVALID' });
  }
  f.db.prepare('DELETE FROM room_furniture_protocol_floor').run();
  for (const value of ['{', null]) {
    f.db.prepare('INSERT OR REPLACE INTO rooms VALUES(?,?)').run('room', value);
    await assert.rejects(f.observe(), { code: 'IMAGE_STORAGE_REQUIREMENT_INVALID' });
  }
});
