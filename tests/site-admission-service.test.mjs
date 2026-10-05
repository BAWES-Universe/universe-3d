import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { randomBytes, createHash, scrypt, scryptSync } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { bootstrapOwner, addReviewer } from '../server/operator-accounts.mjs';
import { BOOTSTRAP_KEY } from '../server/access-gate.mjs';
import { createSiteAdmission } from '../server/site-admission.mjs';
import { seedWorlds } from '../src/worlds.js';

const realHash = promisify(scrypt);
const token = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const ownerInput = { name: 'Synthetic Owner', username: 'synthetic_owner', password: 'synthetic owner fixture password' };
const signupInput = (invite, extra = {}) => ({ token: invite.token, clientOperationId: token(), name: 'Synthetic Visitor', username: 'synthetic_visitor', password: 'synthetic visitor fixture password', ...extra });
function pendingHash() {
  let start, release;
  const started = new Promise(resolve => { start = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  return { started, release, derivePassword: async (...args) => { start(); await paused; return realHash(...args); } };
}
async function fixture(t, options = {}) {
  let time = 2000000000000;
  const store = new Store(options.database ?? ':memory:', seedWorlds, () => time);
  t.after(() => store.close());
  const owner = await bootstrapOwner(store, ownerInput);
  const ownerSession = token();
  store.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', ownerSession, owner.id, time + 100 * 86400000);
  const config = { enabled: true, ...options.config };
  function service(overrides = {}, db = store) {
    return createSiteAdmission({ store: db, config, now: () => time,
      session(req, required = true) {
        const result = db.get('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?', req.sessionKey ?? '', time);
        if (!result && required) { const error = new Error('Sign in first'); error.status = 401; error.code = 'AUTH_REQUIRED'; throw error; }
        return result;
      },
      send(res, status, body) { res.status = status; res.body = body; },
      ...overrides,
    });
  }
  const admission = service(options.derivePassword ? { derivePassword: options.derivePassword } : {});
  async function request(path, { method = 'POST', body = {}, sessionKey, peer = '192.0.2.1', service: use = admission, headers = {}, encoded } = {}) {
    const req = new PassThrough();
    req.url = path; req.method = method; req.sessionKey = sessionKey;
    req.headers = { 'content-type': 'application/json', ...headers }; req.socket = { remoteAddress: peer };
    const res = {};
    const result = use.handle({ req, res, path: new URL(path, 'http://localhost').pathname, method, url: new URL(path, 'http://localhost') });
    req.end(encoded ?? JSON.stringify(body));
    try { res.handled = await result; } catch (error) { if (!error.status) throw error; res.status = error.status; res.body = { code: error.code, message: error.message }; }
    return res;
  }
  const mint = (body = {}, args = {}) => request('/api/site-invites', { sessionKey: ownerSession, body: { clientOperationId: token(), ...body }, ...args });
  const redeem = (body, args = {}) => request('/api/site-admission/redeem', { body, ...args });
  const check = (bearer, args = {}) => request('/api/site-admission/check', { body: { token: bearer }, ...args });
  const revoke = (id, args = {}) => request(`/api/site-invites/${id}/revoke`, { sessionKey: ownerSession, ...args });
  return { store, owner, ownerSession, admission, service, request, mint, redeem, check, revoke, setTime(value) { time = value; }, now: () => time };
}

const expectCode = (response, status, code) => { assert.equal(response.status, status, JSON.stringify(response.body)); assert.equal(response.body.code, code); };

test('bootstrap metadata alone controls management; disabled service remains closed', async t => {
  const f = await fixture(t);
  expectCode(await f.mint({}, { sessionKey: undefined }), 401, 'AUTH_REQUIRED');
  const visitor = await addReviewer(f.store, { name: 'Synthetic World Owner', username: 'world_owner', password: 'synthetic world owner password' });
  const visitorSession = token(); f.store.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', visitorSession, visitor.id, f.now() + 3600000);
  for (const table of ['universes', 'worlds', 'rooms']) f.store.run(`UPDATE ${table} SET owner_id=?`, visitor.id);
  assert.equal(f.admission.isSiteOwner(visitor.id), false);
  assert.equal(f.admission.isSiteOwner(f.owner.id), true);
  expectCode(await f.mint({}, { sessionKey: visitorSession }), 403, 'SITE_OWNER_REQUIRED');
  expectCode(await f.request('/api/site-invites', { method: 'GET', sessionKey: visitorSession }), 403, 'SITE_OWNER_REQUIRED');
  const minted = await f.mint(); assert.equal(minted.status, 201);
  expectCode(await f.revoke(minted.body.invite.id, { sessionKey: visitorSession }), 403, 'SITE_OWNER_REQUIRED');
  const disabled = f.service({ config: {} });
  expectCode(await f.mint({}, { service: disabled }), 403, 'SITE_ADMISSION_DISABLED');
  expectCode(await f.check(minted.body.token, { service: disabled }), 403, 'SITE_ADMISSION_DISABLED');
  assert.equal(disabled.publicPolicy({ user_id: f.owner.id }).canManage, false);
  assert.equal(JSON.stringify(f.admission.publicPolicy({ user_id: f.owner.id })).includes(f.owner.id), false);
});

test('mint retries are durable but return the random bearer only once, with sanitized audit', async t => {
  const f = await fixture(t);
  const operation = token();
  const first = await f.mint({ clientOperationId: operation, label: 'Synthetic review', expiresInMs: 3600000 });
  assert.equal(first.status, 201); assert.equal(Buffer.from(first.body.token, 'base64url').length, 32);
  assert.equal(first.body.invite.expiresAt - first.body.invite.createdAt, 3600000);
  const repeat = await f.mint({ clientOperationId: operation, label: 'Synthetic review', expiresInMs: 3600000 });
  assert.equal(repeat.status, 200); assert.equal(repeat.body.duplicate, true); assert.equal(repeat.body.linkRecoverable, false); assert.equal('token' in repeat.body, false);
  assert.equal(repeat.body.invite.id, first.body.invite.id);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM site_admission_invites').n, 1);
  assert.equal(f.store.get('SELECT token_hash FROM site_admission_invites').token_hash, hash(first.body.token));
  const list = await f.request('/api/site-invites', { method: 'GET', sessionKey: f.ownerSession });
  assert.equal(list.body.activeInvites, 1);
  const serialized = JSON.stringify({ rows: f.store.all('SELECT * FROM site_admission_invites'), audit: f.store.all('SELECT * FROM site_admission_audit'), metadata: f.store.all('SELECT * FROM metadata'), list: list.body, retry: repeat.body });
  for (const secret of [first.body.token, operation, ownerInput.password]) assert.equal(serialized.includes(secret), false);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM site_admission_audit').n, 1);
});

test('redemption creates an ordinary account only and receipt retry proves its salted password', async t => {
  const f = await fixture(t);
  const minted = (await f.mint()).body, input = signupInput(minted);
  f.store.run('UPDATE worlds SET owner_id=NULL'); f.store.run('UPDATE rooms SET owner_id=NULL'); f.store.run('UPDATE universes SET owner_id=NULL');
  const sessionsBefore = f.store.all('SELECT * FROM sessions');
  const first = await f.redeem(input);
  assert.equal(first.status, 201); assert.deepEqual(first.body, { created: true, username: input.username, duplicate: false, loginRequired: true });
  const account = f.store.get('SELECT * FROM accounts WHERE username=?', input.username);
  assert.equal(account.password_hash, scryptSync(input.password, account.salt, 64).toString('hex'));
  for (const table of ['universes', 'worlds', 'rooms']) assert.equal(f.store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id=?`, account.user_id).n, 0);
  for (const table of ['members', 'world_members']) assert.equal(f.store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`, account.user_id).n, 0);
  assert.deepEqual(f.store.all('SELECT * FROM sessions'), sessionsBefore);
  expectCode(await f.check(minted.token), 410, 'INVITE_UNAVAILABLE');
  const retry = await f.redeem(input); assert.equal(retry.status, 200); assert.equal(retry.body.duplicate, true);
  expectCode(await f.redeem({ ...input, password: 'a different synthetic password' }), 410, 'INVITE_UNAVAILABLE');
  expectCode(await f.redeem({ ...input, username: 'different_name' }), 410, 'INVITE_UNAVAILABLE');
  expectCode(await f.redeem({ ...input, clientOperationId: token() }), 410, 'INVITE_UNAVAILABLE');
  const rows = JSON.stringify({ invites: f.store.all('SELECT * FROM site_admission_invites'), audits: f.store.all('SELECT * FROM site_admission_audit'), metadata: f.store.all('SELECT * FROM metadata') });
  for (const secret of [input.token, input.clientOperationId, input.password, hash(input.password)]) assert.equal(rows.includes(secret), false);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM accounts').n, 2);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM site_admission_audit').n, 2);
});

test('signed-in guests and accounts cannot redeem or have their identity replaced', async t => {
  const f = await fixture(t), minted = (await f.mint()).body, input = signupInput(minted);
  const guest = f.store.createUser('Synthetic Guest', '0'), guestSession = token();
  f.store.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', guestSession, guest.id, f.now() + 3600000);
  for (const sessionKey of [guestSession, f.ownerSession]) expectCode(await f.redeem(input, { sessionKey }), 409, 'SIGNUP_SIGN_OUT_REQUIRED');
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM accounts').n, 1);
  assert.equal(f.store.user(guest.id).account, false);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM sessions').n, 2);
  assert.equal((await f.check(minted.token)).status, 200);
});

test('expiry, revoke, disabled configuration and lost issuer authority also block receipt replay', async t => {
  const f = await fixture(t), minted = (await f.mint()).body, input = signupInput(minted);
  assert.equal((await f.redeem(input)).status, 201);
  expectCode(await f.redeem(input, { service: f.service({ config: {} }) }), 403, 'SITE_ADMISSION_DISABLED');
  f.store.run('DELETE FROM metadata WHERE key=?', BOOTSTRAP_KEY);
  expectCode(await f.redeem(input), 410, 'INVITE_UNAVAILABLE');
  f.store.run('INSERT INTO metadata(key,value) VALUES(?,?)', BOOTSTRAP_KEY, f.owner.id);
  f.setTime(minted.invite.expiresAt); expectCode(await f.redeem(input), 410, 'INVITE_UNAVAILABLE');
  f.setTime(minted.invite.createdAt + 1);
  const revoked = await f.revoke(minted.invite.id, { body: { clientOperationId: token() } });
  assert.equal(revoked.body.invite.status, 'revoked'); assert.equal(revoked.body.invite.redeemedAt, minted.invite.createdAt);
  expectCode(await f.redeem(input), 410, 'INVITE_UNAVAILABLE');
  assert.equal((await f.revoke(minted.invite.id)).body.duplicate, true);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM accounts').n, 2);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM site_admission_audit').n, 3);
});

for (const change of ['revoke', 'expire', 'authority', 'quota']) test(`redemption revalidates ${change} after asynchronous scrypt`, async t => {
  const pause = pendingHash(), f = await fixture(t, { derivePassword: pause.derivePassword, config: { maxAccounts: 2 } });
  const minted = (await f.mint()).body, input = signupInput(minted);
  const pending = f.redeem(input); await pause.started;
  if (change === 'revoke') await f.revoke(minted.invite.id);
  if (change === 'expire') f.setTime(minted.invite.expiresAt);
  if (change === 'authority') f.store.run('DELETE FROM metadata WHERE key=?', BOOTSTRAP_KEY);
  if (change === 'quota') await addReviewer(f.store, { name: 'Synthetic Concurrent', username: 'concurrent_user', password: 'synthetic concurrent account password' });
  pause.release();
  expectCode(await pending, change === 'quota' ? 409 : 410, change === 'quota' ? 'ACCOUNT_LIMIT_REACHED' : 'INVITE_UNAVAILABLE');
  assert.equal(f.store.get('SELECT 1 FROM accounts WHERE username=?', input.username), undefined);
  assert.equal(f.store.get('SELECT redeemed_at FROM site_admission_invites WHERE id=?', minted.invite.id).redeemed_at, null);
});

test('a changed request session after scrypt rejects signup without creating an account', async t => {
  const pause = pendingHash(), f = await fixture(t, { derivePassword: pause.derivePassword });
  const minted = (await f.mint()).body, sessionKey = token();
  const pending = f.redeem(signupInput(minted), { sessionKey }); await pause.started;
  f.store.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', sessionKey, f.owner.id, f.now() + 3600000);
  pause.release(); expectCode(await pending, 409, 'SIGNUP_SESSION_CHANGED');
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM accounts').n, 1);
});

test('same-invite concurrent retries create one account and prove the winner password', async t => {
  const f = await fixture(t), minted = (await f.mint()).body, input = signupInput(minted);
  const results = await Promise.all([f.redeem(input), f.redeem(input)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM accounts').n, 2);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM site_admission_audit').n, 2);
});

test('same invite competing operations have one winner, and different invites cannot exceed account quota', async t => {
  const f = await fixture(t, { config: { maxAccounts: 2 } });
  const one = (await f.mint()).body, two = (await f.mint()).body;
  const results = await Promise.all([f.redeem(signupInput(one)), f.redeem(signupInput(two, { username: 'other_visitor' }))]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM accounts').n, 2);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM site_admission_invites WHERE redeemed_at IS NOT NULL').n, 1);
  // A receipt remains retryable when its account already fills the quota.
  expectCode(await f.check(results[0].status === 201 ? two.token : one.token), 409, 'ACCOUNT_LIMIT_REACHED');
});

test('active invite and durable history limits cannot be bypassed by retries or revoke churn', async t => {
  const f = await fixture(t, { config: { maxActiveInvites: 1, maxInviteRecords: 2 } });
  const operation = token(), one = (await f.mint({ clientOperationId: operation })).body;
  expectCode(await f.mint(), 409, 'ACTIVE_INVITE_LIMIT_REACHED');
  assert.equal((await f.mint({ clientOperationId: operation })).status, 200);
  await f.revoke(one.invite.id);
  const two = (await f.mint()).body;
  await f.revoke(two.invite.id);
  expectCode(await f.mint(), 409, 'INVITE_HISTORY_LIMIT_REACHED');
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM site_admission_invites').n, 2);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM site_admission_audit').n, 4);
});

test('scrypt concurrency is bounded without queueing submitted passwords', async t => {
  const pause = pendingHash(), f = await fixture(t, { derivePassword: pause.derivePassword, config: { maxConcurrentHashes: 1 } });
  const one = (await f.mint()).body, two = (await f.mint()).body;
  const pending = f.redeem(signupInput(one)); await pause.started;
  expectCode(await f.redeem(signupInput(two, { username: 'second_visitor' })), 429, 'SIGNUP_BUSY');
  pause.release(); assert.equal((await pending).status, 201);
  assert.equal((await f.redeem(signupInput(two, { username: 'second_visitor' }))).status, 201);
});

test('rate limits expire, bound independent peers, and valid invite limits span peers', async t => {
  const f = await fixture(t, { config: { checkPerMinute: 2 } });
  const one = (await f.mint()).body;
  assert.equal((await f.check(one.token, { peer: '192.0.2.10' })).status, 200);
  assert.equal((await f.check(one.token, { peer: '192.0.2.11' })).status, 200);
  expectCode(await f.check(one.token, { peer: '192.0.2.12' }), 429, 'RATE_LIMITED');
  f.setTime(f.now() + 60000);
  assert.equal((await f.check(one.token, { peer: '192.0.2.12' })).status, 200);
  expectCode(await f.check(token(), { peer: '192.0.2.99' }), 410, 'INVITE_UNAVAILABLE');
  expectCode(await f.check(token(), { peer: '192.0.2.99' }), 410, 'INVITE_UNAVAILABLE');
  expectCode(await f.check(token(), { peer: '192.0.2.99' }), 429, 'RATE_LIMITED');
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM site_admission_audit').n, 1);
});

test('untrusted inputs cannot enter URLs, cause token-bearing errors, or create partial accounts', async t => {
  const f = await fixture(t), minted = (await f.mint()).body, input = signupInput(minted);
  expectCode(await f.request(`/api/site-admission/check?token=${minted.token}`, { body: { token: minted.token } }), 400, 'QUERY_NOT_ALLOWED');
  const attempts = [
    { ...input, role: 'owner' }, { ...input, name: '\nBad' }, { ...input, username: 'INVALID SPACE' },
    { ...input, password: 'too short' }, { ...input, password: ' ' + input.password }, { ...input, password: input.password + '\n' },
    { ...input, clientOperationId: 'weak-id' }, { ...input, woka: { role: 'owner' } },
  ];
  for (const bad of attempts) {
    const result = await f.redeem(bad, { peer: '192.0.2.' + (attempts.indexOf(bad) + 1) });
    assert.equal(result.status, 400); assert.equal(JSON.stringify(result.body).includes(minted.token), false); assert.equal(JSON.stringify(result.body).includes(input.password), false);
  }
  expectCode(await f.request('/api/site-admission/redeem', { body: input, headers: { 'content-type': 'text/plain' } }), 415, 'JSON_REQUIRED');
  expectCode(await f.request('/api/site-admission/redeem', { encoded: '{"token":"' + minted.token }), 400, 'INVALID_JSON');
  expectCode(await f.request('/api/site-admission/redeem', { encoded: 'x'.repeat(8193), peer: '192.0.2.100' }), 413, 'TOO_LARGE');
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM accounts').n, 1);
});

test('SQLite restart and a second connection preserve idempotency and receipt authority', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'universe-site-admission-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'synthetic.sqlite');
  const f = await fixture(t, { database });
  const operation = token(), minted = (await f.mint({ clientOperationId: operation })).body, input = signupInput(minted);
  const second = new Store(database, seedWorlds, f.now); t.after(() => second.close());
  const restarted = f.service({}, second);
  const results = await Promise.all([f.redeem(input), f.redeem(input, { service: restarted })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
  assert.equal((await f.mint({ clientOperationId: operation }, { service: restarted })).body.linkRecoverable, false);
  assert.equal((await f.redeem(input, { service: restarted })).body.duplicate, true);
  await f.revoke(minted.invite.id);
  expectCode(await f.redeem(input, { service: restarted }), 410, 'INVITE_UNAVAILABLE');
  // Check real SQLite bytes and WAL without exposing secret values on failure.
  for (const suffix of ['', '-wal']) {
    const bytes = await readFile(database + suffix).catch(() => Buffer.alloc(0));
    for (const value of [minted.token, operation, input.password, input.clientOperationId]) assert.equal(bytes.includes(Buffer.from(value)), false, 'raw secret must not be stored');
  }
});

test('changed mint payload conflicts and bounded cursor pages enumerate every invite once', async t => {
  const f = await fixture(t), operation = token();
  const original = await f.mint({ clientOperationId: operation, label: 'Original', expiresInMs: 3600000 });
  expectCode(await f.mint({ clientOperationId: operation, label: 'Changed', expiresInMs: 3600000 }), 409, 'CLIENT_OPERATION_CONFLICT');
  expectCode(await f.mint({ clientOperationId: operation, label: 'Original', expiresInMs: 7200000 }), 409, 'CLIENT_OPERATION_CONFLICT');
  const ids = [original.body.invite.id];
  for (let i = 0; i < 4; i++) ids.push((await f.mint()).body.invite.id);
  const seen = [];
  let cursor = null;
  do {
    const page = await f.request('/api/site-invites?limit=2' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), { method: 'GET', sessionKey: f.ownerSession });
    assert.equal(page.status, 200); assert.ok(page.body.invites.length <= 2);
    seen.push(...page.body.invites.map(row => row.id));
    assert.equal(page.body.hasMore, !!page.body.nextCursor);
    cursor = page.body.nextCursor;
  } while (cursor);
  assert.deepEqual(seen.sort(), ids.sort());
  for (const query of ['limit=101', 'limit=0', 'limit=1&limit=2', 'cursor=invalid', 'token=' + token()]) {
    assert.equal((await f.request('/api/site-invites?' + query, { method: 'GET', sessionKey: f.ownerSession })).status, 400);
  }
});

test('same token with competing operations has one account winner and no second receipt', async t => {
  const f = await fixture(t), minted = (await f.mint()).body;
  const results = await Promise.all([f.redeem(signupInput(minted)), f.redeem(signupInput(minted, { username: 'other_visitor' }))]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 410]);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM accounts').n, 2);
});

test('a failing audit insertion rolls back account, invite and user together', async t => {
  const f = await fixture(t), minted = (await f.mint()).body;
  f.store.db.exec("CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON site_admission_audit WHEN NEW.event='redeemed' BEGIN SELECT RAISE(ABORT,'synthetic injected failure'); END");
  await assert.rejects(f.redeem(signupInput(minted)), /synthetic injected failure/);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM accounts').n, 1);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM users').n, 1);
  assert.equal(f.store.get('SELECT redeemed_at FROM site_admission_invites').redeemed_at, null);
});

test('stalled and aborted JSON bodies terminate with sanitized errors', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const req = new PassThrough(); req.url = '/api/site-admission/check'; req.method = 'POST'; req.headers = { 'content-type': 'application/json' }; req.socket = { remoteAddress: '192.0.2.1' };
  const pending = f.admission.handle({ req, res: {}, path: req.url, method: req.method });
  t.mock.timers.tick(10000);
  await assert.rejects(pending, error => error.status === 408 && error.code === 'REQUEST_TIMEOUT');
  assert.equal(req.listenerCount('data'), 0);
  // IncomingMessage may emit a transport error after aborted/timeout; it must
  // not become an uncaught process error after body listeners were cleaned up.
  req.emit('error', new Error('synthetic late transport error')); req.end();
});

test('many hostile peer identities hit bounded rate storage and never grow durable history', async t => {
  const f = await fixture(t, { config: { checkPerMinute: 120 } });
  let blocked = false;
  for (let i = 0; i < 1100; i++) {
    const response = await f.check(token(), { peer: `synthetic-${i}` });
    if (response.status === 429) { blocked = true; break; }
    assert.equal(response.status, 410);
  }
  assert.equal(blocked, true);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM site_admission_invites').n, 0);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM site_admission_audit').n, 0);
  f.setTime(f.now() + 60000);
  assert.equal((await f.check(token(), { peer: 'synthetic-new-peer' })).status, 410);
});

test('receipt is bound to the original signup credentials even after offline account edits', async t => {
  const f = await fixture(t), minted = (await f.mint()).body, input = signupInput(minted);
  assert.equal((await f.redeem(input)).status, 201);
  const account = f.store.get('SELECT * FROM accounts WHERE username=?', input.username);
  f.store.run('UPDATE accounts SET username=? WHERE user_id=?', 'renamed_visitor', account.user_id);
  expectCode(await f.redeem({ ...input, username: 'renamed_visitor' }), 410, 'INVITE_UNAVAILABLE');
  expectCode(await f.redeem(input), 410, 'INVITE_UNAVAILABLE');
  const newPassword = 'replacement synthetic password', newSalt = randomBytes(16).toString('hex');
  f.store.run('UPDATE accounts SET username=?,salt=?,password_hash=? WHERE user_id=?', input.username, newSalt, scryptSync(newPassword, newSalt, 64).toString('hex'), account.user_id);
  expectCode(await f.redeem({ ...input, password: newPassword }), 410, 'INVITE_UNAVAILABLE');
  expectCode(await f.redeem(input), 410, 'INVITE_UNAVAILABLE');
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM accounts').n, 2);
});

test('invite redemption shares 10–256 boundaries, rejects controls/outer whitespace, and preserves salted scrypt',async t=>{
 const f=await fixture(t),minted=(await f.mint()).body;
 for(const password of [null,9,'x'.repeat(9),'x'.repeat(257),' tenletters','tenletters ','ten\tletters','ten\x7fletters']){
  expectCode(await f.redeem(signupInput(minted,{password})),400,'INVALID_PASSWORD');
 }
 for(const [username,password,invite]of[['minimum_friend','tenletters',minted],['maximum_friend','x'.repeat(256),(await f.mint()).body]]){
  const result=await f.redeem(signupInput(invite,{username,password}));assert.equal(result.status,201,JSON.stringify(result.body));
  const account=f.store.get('SELECT * FROM accounts WHERE username=?',username);assert.equal(Buffer.from(account.salt,'hex').length,16);assert.equal(account.password_hash,scryptSync(password,account.salt,64).toString('hex'));
 }
});
