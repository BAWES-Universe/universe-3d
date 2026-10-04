import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { createSiteAdmission } from '../server/site-admission.mjs';
import { readSiteAdmissionConfig, validateSiteAdmissionConfig } from '../server/site-admission-config.mjs';
import { BOOTSTRAP_KEY } from '../server/access-gate.mjs';
import { HttpError } from '../server/validation.mjs';

const secret = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
// Deliberately cheap, credential-dependent derivation for deterministic races.
// Real scrypt and the actual login route are covered by site-admission-http.
const derive = async (password, salt) => createHash('sha512').update(salt).update(password).digest();
const credentials = token => ({ token, clientOperationId: secret(), name: 'Synthetic Friend', username: 'synthetic_friend', password: 'synthetic unique friend password', woka: 2 });

function fixture(t, { config = {}, derivePassword = derive } = {}) {
  let time = 1_800_000_000_000;
  const store = new Store(':memory:', [], () => time);
  t.after(() => store.close());
  for (const [id, username] of [['owner', 'synthetic_owner'], ['other', 'synthetic_other']]) {
    store.run('INSERT INTO users(id,name,woka,created_at) VALUES(?,?,?,?)', id, username, '0', time);
    store.run('INSERT INTO accounts(username,user_id,salt,password_hash) VALUES(?,?,?,?)', username, id, 'synthetic-salt', '00'.repeat(64));
  }
  store.run('INSERT INTO metadata(key,value) VALUES(?,?)', BOOTSTRAP_KEY, 'owner');
  const owner = { token_hash: 'synthetic-owner-session', user_id: 'owner' };
  const service = createSiteAdmission({
    store, config: { enabled: true, ...config }, now: () => time, derivePassword,
    session(req, required = true) {
      if (!req.liveSession && required) throw new HttpError(401, 'AUTH_REQUIRED');
      return req.liveSession ?? null;
    },
    send(res, status, data) { Object.assign(res, { status, data }); },
  });
  function start(path, { body, raw, method = 'POST', session = null, address = '192.0.2.1', headers = {} } = {}) {
    const req = new PassThrough();
    req.url = path; req.method = method; req.socket = { remoteAddress: address };
    req.headers = { 'content-type': 'application/json', ...headers }; req.liveSession = session;
    const res = {};
    const done = service.handle({ req, res, path: new URL(path, 'http://synthetic.test').pathname, url: new URL(path, 'http://synthetic.test'), method }).then(handled => ({ ...res, handled })).catch(error => ({ status: error.status ?? 500, data: { code: error.code, message: error.message }, error }));
    return { req, done, finish() { req.end(raw === undefined ? JSON.stringify(body ?? {}) : raw); return done; } };
  }
  const call = (path, options) => start(path, options).finish();
  const mint = async (body = {}, options = {}) => {
    const result = await call('/api/site-invites', { session: owner, body: { clientOperationId: secret(), ...body }, ...options });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data;
  };
  return { store, service, owner, start, call, mint, advance(ms) { time += ms; }, setTime(value) { time = value; } };
}

function controlledHash() {
  const pending = [];
  return {
    pending,
    derivePassword: (password, salt) => new Promise((resolve, reject) => pending.push({ password, salt, resolve: () => derive(password, salt).then(resolve), reject })),
    async reach(count) { for (let i = 0; i < 20 && pending.length < count; i++) await new Promise(resolve => setImmediate(resolve)); assert.equal(pending.length, count); },
  };
}

test('independent: config is disabled by default and rejects malformed bounds', () => {
  const defaults = readSiteAdmissionConfig({});
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.inviteTtlMs, 86_400_000);
  assert.equal(defaults.maxActiveInvites, 25);
  assert.equal(defaults.maxAccounts, 50);
  for (const value of [null, [], { enabled: 1 }, { maxAccounts: NaN }, { maxAccounts: Infinity }, { maxAccounts: 1.5 }, { maxAccounts: 10001 }, { maxConcurrentHashes: 5 }, { unknown: 1 }]) assert.throws(() => validateSiteAdmissionConfig(value));
  for (const value of ['0', '-1', '1.2', ' 10', '10 ', '1e2', 'Infinity', '9007199254740993']) assert.throws(() => readSiteAdmissionConfig({ UNIVERSE_SITE_MAX_ACCOUNTS: value }));
});

test('independent: only the bootstrap identity with a real account manages invites', async t => {
  const f = fixture(t);
  f.store.run('INSERT INTO universes(id,name,slug,owner_id,public,created_at) VALUES(?,?,?,?,?,?)', 'other-universe', 'Other owner', 'other-universe', 'other', 0, 1);
  const mint = await f.mint();
  for (const session of [null, { token_hash: 'other-session', user_id: 'other' }]) {
    for (const [path, method] of [['/api/site-invites', 'GET'], ['/api/site-invites', 'POST'], [`/api/site-invites/${mint.invite.id}/revoke`, 'POST']]) {
      const r = await f.call(path, { method, session, body: { clientOperationId: secret() } });
      assert.equal(r.status, session ? 403 : 401);
    }
  }
  f.store.run('DELETE FROM accounts WHERE user_id=?', 'owner');
  assert.equal(f.service.isSiteOwner('owner'), false);
  assert.equal((await f.call('/api/site-invites', { method: 'GET', session: f.owner })).status, 403);
  assert.equal((await f.call('/api/site-admission/check', { body: { token: mint.token } })).status, 410);
});

test('independent: owner session expiration during a slow body cannot mint or revoke', async t => {
  const f = fixture(t), invite = await f.mint();
  for (const path of ['/api/site-invites', `/api/site-invites/${invite.invite.id}/revoke`]) {
    const active = f.start(path, { session: f.owner, body: { clientOperationId: secret() } });
    active.req.liveSession = null;
    assert.equal((await active.finish()).status, 401);
  }
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM site_admission_invites').n, 1);
  assert.equal(f.store.get('SELECT revoked_at FROM site_admission_invites').revoked_at, null);
});

test('independent: mint retry keeps one record and rejects changed operation payload', async t => {
  const f = fixture(t), clientOperationId = secret();
  const minted = await f.mint({ clientOperationId, label: 'First friend', expiresInMs: 3_600_000 });
  const repeated = await f.call('/api/site-invites', { session: f.owner, body: { clientOperationId, label: 'First friend', expiresInMs: 3_600_000 } });
  assert.equal(repeated.status, 200); assert.equal(repeated.data.duplicate, true); assert.equal(repeated.data.token, undefined);
  for (const changed of [{ label: 'Second friend', expiresInMs: 3_600_000 }, { label: 'First friend', expiresInMs: 7_200_000 }]) {
    const result = await f.call('/api/site-invites', { session: f.owner, body: { clientOperationId, ...changed } });
    assert.equal(result.status, 409, 'operation ID reused with different mint payload must conflict');
  }
  const row = f.store.get('SELECT * FROM site_admission_invites');
  assert.equal(row.token_hash, digest(minted.token)); assert.equal(row.label, 'First friend');
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM site_admission_invites').n, 1);
});

test('independent: token is canonical 32-byte secret and never enters DB, list, audit or errors', async t => {
  const f = fixture(t), minted = await f.mint(), input = credentials(minted.token);
  assert.equal(Buffer.from(minted.token, 'base64url').length, 32);
  const result = await f.call('/api/site-admission/redeem', { body: input }); assert.equal(result.status, 201);
  const listed = await f.call('/api/site-invites', { method: 'GET', session: f.owner });
  const error = await f.call('/api/site-admission/check', { body: { token: minted.token } });
  const records = [listed.data, error.data, f.store.all('SELECT * FROM site_admission_invites'), f.store.all('SELECT * FROM site_admission_audit'), f.store.all('SELECT * FROM accounts')];
  for (const record of records) for (const value of [minted.token, input.clientOperationId, input.password]) assert.equal(JSON.stringify(record).includes(value), false);
  for (const field of ['token_hash', 'create_operation_hash', 'redeem_operation_hash', 'redeemed_user_id', 'salt', 'password_hash']) assert.equal(JSON.stringify(listed.data).includes(field), false);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM sessions').n, 0);
  const friend = f.store.get('SELECT user_id FROM accounts WHERE username=?', input.username).user_id;
  for (const table of ['members', 'world_members']) assert.equal(f.store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`, friend).n, 0);
  for (const table of ['universes', 'worlds', 'rooms']) assert.equal(f.store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id=?`, friend).n, 0);
});

test('independent: lost-response retry requires the same operation and credential proof', async t => {
  const f = fixture(t), { token } = await f.mint(), input = credentials(token);
  assert.equal((await f.call('/api/site-admission/redeem', { body: input })).status, 201);
  for (const changed of [{ password: 'synthetic different password' }, { username: 'different_friend' }, { clientOperationId: secret() }]) assert.equal((await f.call('/api/site-admission/redeem', { body: { ...input, ...changed } })).status, 410);
  const receipt = await f.call('/api/site-admission/redeem', { body: input });
  assert.equal(receipt.status, 200); assert.equal(receipt.data.duplicate, true);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM accounts').n, 3);
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM site_admission_audit WHERE event='redeemed'").n, 1);
});

test('independent: offline account credential rotation or rename cannot repurpose the original receipt', async t => {
  for (const kind of ['password', 'username']) await t.test(kind, async t => {
    const f = fixture(t), { token } = await f.mint(), input = credentials(token);
    assert.equal((await f.call('/api/site-admission/redeem', { body: input })).status, 201);
    let changed;
    if (kind === 'password') {
      changed = { ...input, password: 'synthetic replacement account password' };
      const salt = 'synthetic-rotated-salt', hash = await derive(changed.password, salt);
      f.store.run('UPDATE accounts SET salt=?,password_hash=? WHERE username=?', salt, hash.toString('hex'), input.username);
    } else {
      changed = { ...input, username: 'synthetic_renamed_friend' };
      f.store.run('UPDATE accounts SET username=? WHERE username=?', changed.username, input.username);
    }
    assert.equal((await f.call('/api/site-admission/redeem', { body: changed })).status, 410);
    assert.equal((await f.call('/api/site-admission/redeem', { body: input })).status, 410);
    assert.equal(f.store.get('SELECT COUNT(*) AS n FROM accounts').n, 3);
    assert.equal(f.store.get("SELECT COUNT(*) AS n FROM site_admission_audit WHERE event='redeemed'").n, 1);
  });
});

test('independent: concurrent equal redemption proves the winning salt and creates one account', async t => {
  const hashing = controlledHash(), f = fixture(t, hashing), { token } = await f.mint(), input = credentials(token);
  const first = f.call('/api/site-admission/redeem', { body: input });
  const second = f.call('/api/site-admission/redeem', { body: input });
  await hashing.reach(2); await hashing.pending[0].resolve(); assert.equal((await first).status, 201);
  await hashing.pending[1].resolve(); await hashing.reach(3); await hashing.pending[2].resolve();
  const receipt = await second; assert.equal(receipt.status, 200); assert.equal(receipt.data.duplicate, true);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM accounts').n, 3);
});

test('independent: concurrent changed credential does not receive a successful receipt', async t => {
  const hashing = controlledHash(), f = fixture(t, hashing), { token } = await f.mint(), input = credentials(token);
  const first = f.call('/api/site-admission/redeem', { body: input });
  const second = f.call('/api/site-admission/redeem', { body: { ...input, password: 'synthetic wrong concurrent password' } });
  await hashing.reach(2); await hashing.pending[0].resolve(); assert.equal((await first).status, 201);
  await hashing.pending[1].resolve(); await hashing.reach(3); await hashing.pending[2].resolve();
  assert.equal((await second).status, 410); assert.equal(f.store.get('SELECT COUNT(*) AS n FROM accounts').n, 3);
});

test('independent: expiry, revoke and bootstrap authority changes during hashing prevent admission', async t => {
  for (const kind of ['expiry', 'revocation', 'bootstrap']) await t.test(kind, async t => {
    const hashing = controlledHash(), f = fixture(t, hashing), invite = await f.mint({ expiresInMs: 3_600_000 });
    const pending = f.call('/api/site-admission/redeem', { body: credentials(invite.token) }); await hashing.reach(1);
    if (kind === 'expiry') f.advance(3_600_000);
    if (kind === 'revocation') assert.equal((await f.call(`/api/site-invites/${invite.invite.id}/revoke`, { session: f.owner, body: {} })).status, 200);
    if (kind === 'bootstrap') f.store.run('UPDATE metadata SET value=? WHERE key=?', 'other', BOOTSTRAP_KEY);
    await hashing.pending[0].resolve(); assert.equal((await pending).status, 410);
    assert.equal(f.store.get('SELECT COUNT(*) AS n FROM accounts').n, 2);
    assert.equal(f.store.get('SELECT redeemed_at FROM site_admission_invites').redeemed_at, null);
  });
});

test('independent: session changes across body or hashing prevent unauthenticated signup', async t => {
  const hashing = controlledHash(), f = fixture(t, hashing), { token } = await f.mint();
  const active = f.start('/api/site-admission/redeem', { body: credentials(token) }); active.req.liveSession = f.owner;
  assert.equal((await active.finish()).data.code, 'SIGNUP_SESSION_CHANGED');
  const second = f.start('/api/site-admission/redeem', { body: credentials(token) }); const pending = second.finish(); await hashing.reach(1);
  second.req.liveSession = f.owner; await hashing.pending[0].resolve();
  assert.equal((await pending).data.code, 'SIGNUP_SESSION_CHANGED'); assert.equal(f.store.get('SELECT COUNT(*) AS n FROM accounts').n, 2);
});

test('independent: concurrency and account capacity are rechecked at commit', async t => {
  const hashing = controlledHash(), f = fixture(t, { ...hashing, config: { maxAccounts: 3, maxConcurrentHashes: 2 } });
  const invitations = await Promise.all([f.mint(), f.mint(), f.mint()]);
  const first = f.call('/api/site-admission/redeem', { body: credentials(invitations[0].token) });
  const second = f.call('/api/site-admission/redeem', { body: { ...credentials(invitations[1].token), username: 'synthetic_second' } });
  await hashing.reach(2);
  const busy = await f.call('/api/site-admission/redeem', { body: { ...credentials(invitations[2].token), username: 'synthetic_third' } });
  assert.equal(busy.data.code, 'SIGNUP_BUSY');
  await hashing.pending[0].resolve(); assert.equal((await first).status, 201);
  await hashing.pending[1].resolve(); assert.equal((await second).data.code, 'ACCOUNT_LIMIT_REACHED');
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM accounts').n, 3);
});

test('independent: active invite, permanent history and audit bounds do not rely on rate windows', async t => {
  const f = fixture(t, { config: { maxActiveInvites: 1, maxInviteRecords: 2 } }), one = await f.mint();
  const mintRequest = () => f.call('/api/site-invites', { session: f.owner, body: { clientOperationId: secret() } });
  assert.equal((await mintRequest()).data.code, 'ACTIVE_INVITE_LIMIT_REACHED');
  await f.call(`/api/site-invites/${one.invite.id}/revoke`, { session: f.owner });
  const two = await f.mint(); await f.call(`/api/site-invites/${two.invite.id}/revoke`, { session: f.owner });
  f.advance(60_001);
  assert.equal((await mintRequest()).data.code, 'INVITE_HISTORY_LIMIT_REACHED');
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM site_admission_invites').n, 2);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM site_admission_audit').n, 4);
});

test('independent: invalid tokens use the global ceiling and a real invite has its own ceiling', async t => {
  const f = fixture(t, { config: { checkPerMinute: 2 } }), { token } = await f.mint();
  for (let i = 0; i < 2; i++) assert.equal((await f.call('/api/site-admission/check', { address: `192.0.2.${i + 1}`, body: { token } })).status, 200);
  assert.equal((await f.call('/api/site-admission/check', { address: '192.0.2.99', body: { token } })).status, 429);
  f.advance(60_001);
  for (let i = 0; i < 20; i++) assert.equal((await f.call('/api/site-admission/check', { address: `198.51.100.${i + 1}`, body: { token: secret() } })).status, 410);
  assert.equal((await f.call('/api/site-admission/check', { address: '198.51.100.99', body: { token: secret() } })).status, 429);
});

test('independent: malformed/oversized input never creates an account or consumes an invite', async t => {
  const f = fixture(t), { token } = await f.mint(), valid = credentials(token);
  for (const raw of ['null', '[]', '"string"', '{', ' '.repeat(8193)]) assert.ok([400, 413].includes((await f.call('/api/site-admission/redeem', { raw })).status));
  f.advance(60_001);
  for (const changed of [{ woka: '2' }, { woka: -1 }, { password: 'short' }, { role: 'owner' }, { token: 'x'.repeat(43) }, { clientOperationId: 'short' }, { name: 'bad\u0000name' }]) {
    const result = await f.call('/api/site-admission/redeem', { body: { ...valid, ...changed } }); assert.equal(result.status, 400);
  }
  f.advance(60_001);
  assert.equal((await f.call('/api/site-admission/redeem', { raw: JSON.stringify(valid).replace('"woka":2', '"woka":1e309') })).status, 400);
  assert.equal((await f.call('/api/site-admission/check?token=synthetic', { body: { token } })).data.code, 'QUERY_NOT_ALLOWED');
  assert.equal((await f.call('/api/site-admission/check', { body: { token }, headers: { 'content-length': '8193' } })).status, 413);
  assert.equal((await f.call('/api/site-admission/check', { body: { token }, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM accounts').n, 2); assert.equal(f.store.get('SELECT redeemed_at FROM site_admission_invites').redeemed_at, null);
});

test('independent: incomplete body has a bounded lifetime and cannot consume a token', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), { token } = await f.mint();
  const active = f.start('/api/site-admission/check'); active.req.write(JSON.stringify({ token }).slice(0, 20));
  t.mock.timers.tick(10_001);
  const result = await active.done; assert.equal(result.status, 408);
  active.req.end(); assert.equal(f.store.get('SELECT redeemed_at FROM site_admission_invites').redeemed_at, null);
});

test('independent: history pages are bounded and traverse equal timestamps without missing records', async t => {
  const f = fixture(t, { config: { ownerPerMinute: 120, maxActiveInvites: 200 } }), ids = new Set();
  for (let i = 0; i < 105; i++) ids.add((await f.mint({ label: `Synthetic invite ${i}` })).invite.id);
  f.advance(60_001);
  const first = await f.call('/api/site-invites', { session: f.owner, method: 'GET' });
  assert.equal(first.status, 200); assert.equal(first.data.invites.length, 50); assert.equal(first.data.hasMore, true);
  const second = await f.call(`/api/site-invites?cursor=${encodeURIComponent(first.data.nextCursor)}`, { session: f.owner, method: 'GET' });
  assert.equal(second.status, 200); assert.equal(second.data.invites.length, 50); assert.equal(second.data.hasMore, true);
  const third = await f.call(`/api/site-invites?cursor=${encodeURIComponent(second.data.nextCursor)}`, { session: f.owner, method: 'GET' });
  assert.equal(third.status, 200); assert.equal(third.data.invites.length, 5); assert.equal(third.data.hasMore, false); assert.equal(third.data.nextCursor, null);
  const seen = [...first.data.invites, ...second.data.invites, ...third.data.invites].map(row => row.id);
  assert.equal(seen.length, new Set(seen).size); assert.deepEqual(new Set(seen), ids);
  assert.equal((await f.call('/api/site-invites?limit=100', { session: f.owner, method: 'GET' })).data.invites.length, 100);
  for (const query of ['limit=101', 'limit=0', 'limit=-1', 'limit=1.1', 'limit=01', 'limit=10&limit=20', 'cursor=bad', 'cursor=9007199254740992_id', 'token=synthetic', 'limit=10&token=synthetic']) {
    assert.equal((await f.call(`/api/site-invites?${query}`, { session: f.owner, method: 'GET' })).status, 400, query);
  }
});

test('independent: audit failures roll back mint, redemption and revocation atomically', async t => {
  const f = fixture(t), invite = await f.mint();
  const originalRun = f.store.run.bind(f.store);
  let failAudit = true;
  f.store.run = (sql, ...args) => {
    if (failAudit && sql.startsWith('INSERT INTO site_admission_audit')) throw new Error('synthetic audit write failure');
    return originalRun(sql, ...args);
  };
  assert.equal((await f.call('/api/site-invites', { session: f.owner, body: { clientOperationId: secret() } })).status, 500);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM site_admission_invites').n, 1);
  const input = credentials(invite.token);
  assert.equal((await f.call('/api/site-admission/redeem', { body: input })).status, 500);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM accounts').n, 2);
  assert.equal(f.store.get('SELECT redeemed_at FROM site_admission_invites').redeemed_at, null);
  assert.equal((await f.call(`/api/site-invites/${invite.invite.id}/revoke`, { session: f.owner })).status, 500);
  assert.equal(f.store.get('SELECT revoked_at FROM site_admission_invites').revoked_at, null);
  failAudit = false;
  assert.equal((await f.call('/api/site-admission/redeem', { body: input })).status, 201);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM site_admission_audit').n, 2);
});

test('independent: failed password derivation releases capacity for a later valid request', async t => {
  const hashing = controlledHash(), f = fixture(t, { ...hashing, config: { maxConcurrentHashes: 1 } }), { token } = await f.mint(), input = credentials(token);
  const first = f.call('/api/site-admission/redeem', { body: input }); await hashing.reach(1); hashing.pending[0].reject(new Error('synthetic derivation failure'));
  assert.equal((await first).status, 500);
  const retry = f.call('/api/site-admission/redeem', { body: input }); await hashing.reach(2); await hashing.pending[1].resolve();
  assert.equal((await retry).status, 201);
});
