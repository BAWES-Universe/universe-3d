import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { scryptSync } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { createAccessGate, BOOTSTRAP_KEY } from '../server/access-gate.mjs';
import { bootstrapOwner, addReviewer } from '../server/operator-accounts.mjs';
import { seedWorlds } from '../src/worlds.js';

// These fixed credentials are deliberately synthetic and confined to disposable
// test stores. They must never be copied into any operator/deployment example.
const ownerInput = { name: 'Synthetic Owner', username: 'test_owner', password: 'synthetic test fixture password only' };
const reviewerInput = { name: 'Synthetic Reviewer', username: 'test_reviewer', password: 'synthetic reviewer fixture password' };
const config = { mode: 'public', registrationMode: 'disabled' };
const gate = store => createAccessGate({ store, config });
const code = expected => error => error.code === expected;

test('invite-only never opens legacy guest or account upgrade routes',t=>{
 const store=new Store(':memory:',seedWorlds);t.after(()=>store.close());
 for(const mode of ['local','public']){
  const admission=createAccessGate({store,config:{mode,registrationMode:'invite-only'}});
  assert.throws(()=>admission.assertGuestCreationAllowed(),code('GUEST_CREATION_DISABLED'));
  assert.throws(()=>admission.assertRegistrationAllowed(),code('REGISTRATION_DISABLED'));
  assert.equal(admission.publicPolicy().registration,false);
 }
});

test('public admission defaults closed and requires controlled owner bootstrap', async t => {
  const store = new Store(':memory:', seedWorlds); t.after(() => store.close());
  assert.throws(() => gate(store).assertReady(), code('OPERATOR_BOOTSTRAP_REQUIRED'));
  assert.throws(() => gate(store).assertGuestCreationAllowed(), code('GUEST_CREATION_DISABLED'));
  assert.throws(() => gate(store).assertRegistrationAllowed(), code('REGISTRATION_DISABLED'));
  assert.deepEqual(gate(store).publicPolicy(), { mode: 'public', guestCreation: false, registration: false, login: true, provisioning: 'operator' });
  const local = createAccessGate({ store, config: { mode: 'local', registrationMode: 'local-open' } });
  local.assertReady(); local.assertGuestCreationAllowed(); local.assertRegistrationAllowed();
  assert.equal(local.publicPolicy().guestCreation, true);
  const owner = await bootstrapOwner(store, ownerInput); gate(store).assertReady();
  assert.equal(owner.account, true);
  assert.equal(store.get('SELECT value FROM metadata WHERE key=?', BOOTSTRAP_KEY).value, owner.id);
  for (const table of ['universes', 'worlds', 'rooms']) assert.equal(store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id!=? OR owner_id IS NULL`, owner.id).n, 0);
  const account = store.get('SELECT * FROM accounts WHERE user_id=?', owner.id);
  assert.equal(account.password_hash, scryptSync(ownerInput.password, account.salt, 64).toString('hex'));
  assert.notEqual(account.password_hash, ownerInput.password);
  await assert.rejects(bootstrapOwner(store, { ...ownerInput, username: 'second_owner' }), code('ALREADY_BOOTSTRAPPED'));
  assert.equal(store.get('SELECT COUNT(*) AS n FROM users').n, 1);
});

test('reviewers receive no seed ownership or durable grants and restart preserves bootstrap', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'universe-gate-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'fixture.sqlite'); let store = new Store(database, seedWorlds);
  t.after(() => store.close());
  await assert.rejects(addReviewer(store, reviewerInput), code('OPERATOR_BOOTSTRAP_REQUIRED'));
  const owner = await bootstrapOwner(store, ownerInput), reviewer = await addReviewer(store, reviewerInput);
  assert.equal(reviewer.account, true);
  for (const table of ['universes', 'worlds', 'rooms']) assert.equal(store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id=?`, reviewer.id).n, 0);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM world_members WHERE user_id=?', reviewer.id).n, 0);
  assert.equal(store.role(store.roomRow('commons'), reviewer.id), 'guest');
  await assert.rejects(addReviewer(store, reviewerInput), code('USERNAME_TAKEN'));
  assert.equal(store.get('SELECT COUNT(*) AS n FROM users').n, 2);
  store.close(); store = new Store(database, seedWorlds); gate(store).assertReady();
  assert.equal(store.role(store.roomRow('commons'), owner.id), 'owner');
  assert.equal(store.user(reviewer.id).username, reviewerInput.username);
});

test('bootstrap never adopts an existing local guest, account or ownership', async t => {
  const store = new Store(':memory:', seedWorlds); t.after(() => store.close());
  const original = store.createUser('Existing local guest', 0);
  await assert.rejects(bootstrapOwner(store, ownerInput), code('DATABASE_NOT_FRESH'));
  assert.equal(store.get('SELECT owner_id FROM universes').owner_id, original.id);
  assert.equal(store.get('SELECT value FROM metadata WHERE key=?', BOOTSTRAP_KEY), undefined);
  assert.throws(() => gate(store).assertReady(), code('OPERATOR_BOOTSTRAP_REQUIRED'));
});

test('public readiness catches corrupt ownership and unprovisioned profiles', async t => {
  const store = new Store(':memory:', seedWorlds); t.after(() => store.close());
  const owner = await bootstrapOwner(store, ownerInput);
  store.run('UPDATE rooms SET owner_id=NULL WHERE id=?', 'commons');
  assert.throws(() => gate(store).assertReady(), code('UNCLAIMED_SEEDS'));
  store.run('UPDATE rooms SET owner_id=? WHERE id=?', owner.id, 'commons');
  store.run('INSERT INTO users(id,name,woka,created_at) VALUES(?,?,?,?)', 'synthetic-orphan', 'Orphan', '0', 1);
  assert.throws(() => gate(store).assertReady(), code('UNPROVISIONED_PROFILES'));
  await assert.rejects(addReviewer(store, reviewerInput), code('UNPROVISIONED_PROFILES'));
});

test('credential validation is bounded and invalid input makes no partial identity', async t => {
  const store = new Store(':memory:', seedWorlds); t.after(() => store.close());
  for (const input of [null, {}, { ...ownerInput, role: 'owner' }, { ...ownerInput, username: 'INVALID SPACE' }, { ...ownerInput, password: 'short' }, { ...ownerInput, password: ' leading spaces are ambiguous' }, { ...ownerInput, password: 'x'.repeat(257) }, { ...ownerInput, name: '\nBad' }]) await assert.rejects(bootstrapOwner(store, input));
  assert.equal(store.get('SELECT COUNT(*) AS n FROM users').n, 0);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM accounts').n, 0);
});

test('operator CLI accepts only explicit action/path and never logs submitted secrets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'universe-operator-cli-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'fixture.sqlite');
  async function run(action, data, path = database) {
    const child = spawn(process.execPath, ['scripts/operator-account.mjs', action], { cwd: new URL('..', import.meta.url), env: { ...process.env, UNIVERSE_DB: path }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.stdin.end(JSON.stringify(data));
    const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(output.includes(ownerInput.password), false); assert.equal(output.includes(reviewerInput.password), false);
    return { exit, output };
  }
  assert.equal((await run('bootstrap-owner', ownerInput, '')).exit, 1);
  assert.equal((await run('unknown-action', ownerInput)).exit, 1);
  assert.equal((await run('bootstrap-owner', ownerInput)).exit, 0);
  assert.equal((await stat(database)).mode & 0o077, 0);
  assert.equal((await run('bootstrap-owner', ownerInput)).exit, 1);
  assert.equal((await run('add-reviewer', reviewerInput)).exit, 0);
});
