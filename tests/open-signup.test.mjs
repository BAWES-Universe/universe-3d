import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from '../server/store.mjs';
import { createGameServer } from '../server/app.mjs';
import { bootstrapOwner } from '../server/operator-accounts.mjs';
import { normalizeEmail } from '../server/account-identity.mjs';
import { assertOpenAccountSchema } from '../server/open-signup.mjs';
import { createSetupMode, promoteSetupOwner, SETUP_KEY, PROMOTION_AUDIT_KEY } from '../server/setup-mode.mjs';
import { BOOTSTRAP_KEY, createAccessGate } from '../server/access-gate.mjs';
import { readRuntimeConfig, createRequestSecurity } from '../server/runtime-config.mjs';
import { readSiteAdmissionConfig } from '../server/site-admission-config.mjs';
import { seedWorlds } from '../src/worlds.js';

const ownerInput = { name: 'Synthetic owner', username: 'synthetic_owner', password: 'synthetic owner password only' };
const input = (email = 'tester+one@example.test') => ({ email, password: 'synthetic open signup password only', name: 'Synthetic Explorer' });
const code = expected => error => error.code === expected;
const publicEnv = (database, extra = {}) => ({ UNIVERSE_MODE: 'public', UNIVERSE_BIND_ADDRESS: '127.0.0.1', PORT: '4190', UNIVERSE_DB: database, UNIVERSE_ALLOWED_HOSTS: 'preview.example.test', UNIVERSE_ALLOWED_ORIGINS: 'https://preview.example.test', UNIVERSE_TLS_MODE: 'external', UNIVERSE_COOKIE_SECURE: 'always', UNIVERSE_REGISTRATION_MODE: 'open', ...extra });
function request(port, path, { method = 'GET', body, raw, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const allHeaders = { Host: 'preview.example.test', ...(bytes === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) }), ...(method === 'GET' ? {} : { Origin: 'https://preview.example.test' }), ...(cookie ? { Cookie: cookie } : {}), ...headers };
    for (const key of Object.keys(allHeaders)) if (allHeaders[key] === undefined) delete allHeaders[key];
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: allHeaders }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let data; try { data = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, data }); }); res.on('error', reject);
    }); req.on('error', reject); req.end(bytes);
  });
}
async function fixture(t, { setup = false, maxAccounts, mode = 'open' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'open-signup-')), database = join(directory, 'game.sqlite'), dist = join(directory, 'dist');
  await mkdir(dist);
  for (const name of ['signup.html', 'signup.js', 'signup.css', 'site-admission.css', 'universe-tokens.css', 'index.html', 'game.js']) await writeFile(join(dist, name), name.endsWith('.html') ? '<!doctype html><title>Signup fixture</title>' : '/* fixture */');
  if (!setup) { const store = new Store(database, seedWorlds); await bootstrapOwner(store, ownerInput); store.close(); }
  let env = publicEnv(database, { UNIVERSE_REGISTRATION_MODE: mode, ...(setup ? { UNIVERSE_SETUP_ONLY: '1' } : {}), ...(maxAccounts ? { UNIVERSE_SITE_MAX_ACCOUNTS: String(maxAccounts) } : {}) });
  let app, port;
  const start = async () => { app = createGameServer({ database, dist, seeds: seedWorlds, runtimeConfig: readRuntimeConfig(env), siteAdmissionConfig: readSiteAdmissionConfig(env) }); port = (await app.listen(0)).port; };
  await start();
  t.after(async () => { if (app) await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { database, get app() { return app; }, get port() { return port; }, call: (path, options) => request(port, path, options), async restart(extra = {}) { await app.close(); app = null; env = { ...env, ...extra }; await start(); } };
}
async function signup(f, data = input()) { const r = await f.call('/api/signup', { method: 'POST', body: data }); assert.equal(r.status, 201, r.text); assert.deepEqual(r.data, { created: true, loginRequired: true }); assert.equal(r.headers['set-cookie'], undefined); return data; }
async function login(f, data = input()) { const r = await f.call('/api/login', { method: 'POST', body: data }); assert.equal(r.status, 200, r.text); return { ...r.data, cookie: r.headers['set-cookie'][0].split(';')[0], response: r }; }
function assertPrivate(value, email = 'tester+one@example.test') { const encoded = JSON.stringify(value); assert.equal(encoded.includes(email), false); assert.equal(encoded.includes('"email"'), false); assert.equal(encoded.includes('password_hash'), false); assert.equal(encoded.includes('"salt"'), false); }

test('Signup/login/normalize/race/cap: explicit config, shared ASCII normalization, bounded input, legacy login and atomic races', async t => {
  assert.equal(readSiteAdmissionConfig({ UNIVERSE_REGISTRATION_MODE: 'open' }).maxAccounts, 10000);
  assert.equal(readSiteAdmissionConfig({}).maxAccounts, 50);
  assert.equal(readRuntimeConfig(publicEnv('/synthetic/db', { UNIVERSE_REGISTRATION_MODE: undefined })).registrationMode, 'disabled');
  assert.equal(normalizeEmail('  Tester+ONE@Example.Test  '), 'tester+one@example.test');
  assert.equal(normalizeEmail(`${'x'.repeat(64)}@example.test`).length, 77);
  const maxEmail = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`; assert.equal(maxEmail.length, 254); assert.equal(normalizeEmail(maxEmail), maxEmail);
  for (const value of [null, '', 'a@localhost', 'a..b@example.test', '.a@example.test', 'a.@example.test', 'a b@example.test', 'ü@example.test', 'a@é.test', 'K@example.test', 'a@K.test', 'a@-bad.test', 'a@bad-.test', 'a@@example.test', `${'x'.repeat(65)}@example.test`, `${maxEmail}x`]) assert.throws(() => normalizeEmail(value), code('INVALID_EMAIL'));
  const f = await fixture(t), policy = await f.call('/api/signup'); assert.equal(policy.data.enabled, true); assert.equal(policy.data.maxAccounts, 10000);
  const data = await signup(f, input('  Tester+ONE@Example.Test  '));
  const row = f.app.store.get('SELECT * FROM accounts WHERE email=?', 'tester+one@example.test');
  assert.match(row.username, /^u_[a-f0-9]{24}$/); assert.equal(Buffer.from(row.salt, 'hex').length, 16); assert.equal(Buffer.from(row.password_hash, 'hex').length, 64); assert.equal(row.password_hash, scryptSync(data.password, row.salt, 64).toString('hex'));
  const signed = await login(f, { email: ' TESTER+ONE@EXAMPLE.TEST ', password: data.password }); assert.equal(signed.user.id, row.user_id);
  assert.equal((await login(f, { username: row.username, password: data.password })).user.id, row.user_id);
  assert.equal((await login(f, ownerInput)).user.username, ownerInput.username);
  assert.equal((await f.call('/api/login', { method: 'POST', body: { email: data.email, password: 'incorrect password only' } })).data.code, 'INVALID_CREDENTIALS');
  assert.equal((await f.call('/api/signup', { method: 'POST', body: input('TESTER+one@example.test') })).data.code, 'EMAIL_TAKEN');
  assert.equal((await f.call('/api/signup', { method: 'POST', cookie: signed.cookie, body: input('other@example.test') })).data.code, 'SIGNUP_SIGN_OUT_REQUIRED');
  for (const body of [ { ...input(), role: 'owner' }, { ...input(), password: 'short' }, { ...input(), password: ' leading whitespace password' }, { ...input(), password: 'x'.repeat(257) }, { ...input(), name: 'bad\nname' } ]) assert.equal((await f.call('/api/signup', { method: 'POST', body })).status, 400);
  assert.equal((await f.call('/api/signup', { method: 'POST', raw: 'x'.repeat(8193) })).status, 413);
  assert.equal((await f.call('/api/signup', { method: 'POST', raw: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const race = await fixture(t, { maxAccounts: 4 });
  const same = await Promise.all([signupAttempt(race, input('race@example.test')), signupAttempt(race, input('RACE@EXAMPLE.TEST'))]); assert.deepEqual(same.map(r => r.status).sort(), [201, 409]);
  const secondEnv = publicEnv(race.database, { UNIVERSE_SITE_MAX_ACCOUNTS: '4' });
  const secondApp = createGameServer({ database: race.database, seeds: seedWorlds, runtimeConfig: readRuntimeConfig(secondEnv), siteAdmissionConfig: readSiteAdmissionConfig(secondEnv) }); t.after(() => secondApp.close()); const secondPort = (await secondApp.listen(0)).port;
  const capacity = await Promise.all(['a', 'b', 'c', 'd'].map((name, index) => index % 2 ? request(secondPort, '/api/signup', { method: 'POST', body: input(`${name}@example.test`) }) : signupAttempt(race, input(`${name}@example.test`)))); assert.equal(capacity.filter(r => r.status === 201).length, 2); assert.equal(capacity.filter(r => r.data.code === 'ACCOUNT_LIMIT_REACHED').length, 2);
  assert.equal(race.app.store.get('SELECT COUNT(*) AS n FROM users').n, 4); assert.equal(race.app.store.get('SELECT COUNT(*) AS n FROM accounts').n, 4);
});
const signupAttempt = (f, body) => f.call('/api/signup', { method: 'POST', body });

test('Email privacy: self, member, presence, chat, DM, directory and event projections omit credential email', async t => {
  const f = await fixture(t); const data = await signup(f), a = await login(f, data), b = await login(f, ownerInput);
  const call = (path, method = 'GET', body, cookie = a.cookie) => f.call(path, { method, body, cookie });
  for (const result of [a, await call('/api/session'), await call('/api/setup/me'), await call('/api/access')]) assertPrivate(result);
  const entered = await call('/api/rooms/commons/join', 'POST', {}); assert.equal(entered.status, 200, entered.text); assertPrivate(entered);
  assert.equal((await call('/api/rooms/commons/join', 'POST', {}, b.cookie)).status, 200);
  const chat = await call('/api/rooms/commons/messages', 'POST', { text: 'Synthetic message' }); assert.equal(chat.status, 201, chat.text); assertPrivate(chat);
  for (const path of ['/api/users', '/api/rooms/commons', '/api/rooms/commons/messages']) assertPrivate(await call(path));
  const dm = await call(`/api/dm/${b.user.id}/messages`, 'POST', { text: 'Synthetic direct message' }); assert.equal(dm.status, 201, dm.text); assertPrivate(dm); assertPrivate(await call('/api/conversations'));
  const hello = await new Promise((resolve, reject) => { const req = http.get({ hostname: '127.0.0.1', port: f.port, path: '/api/events', headers: { Host: 'preview.example.test', Cookie: a.cookie } }, res => { let text = ''; res.on('data', part => { text += part; if (text.includes('event: hello')) { req.destroy(); resolve(text); } }); }); req.on('error', reject); });
  assert.equal(hello.includes(data.email), false); assert.equal(hello.includes('"email"'), false); assertPrivate([...f.app.presence.values()]);
});

test('Ordinary isolation: no implicit ownership or membership, separate private worlds and explicit grants only', async t => {
  const f = await fixture(t), people = [];
  for (const tag of ['a', 'b']) { const data = await signup(f, input(`${tag}@example.test`)); const person = await login(f, data); people.push(person); for (const table of ['universes', 'worlds', 'rooms']) assert.equal(f.app.store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id=?`, person.user.id).n, 0); for (const table of ['members', 'world_members']) assert.equal(f.app.store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`, person.user.id).n, 0); }
  const [a, b] = people; const post = (who, path, body) => f.call(path, { method: 'POST', cookie: who.cookie, body });
  const universe = (await post(a, '/api/universes', { name: 'Private universe', public: false })).data.universe;
  const world = (await post(a, '/api/worlds', { universeId: universe.id, name: 'Private world', public: false })).data.world;
  const room = (await post(a, '/api/rooms', { worldId: world.id, name: 'Private room', public: false })).data.room;
  assert.equal((await f.call(`/api/rooms/${room.id}`, { cookie: b.cookie })).status, 404);
  const invitation = await post(a, `/api/worlds/${world.id}/invitations`, { userId: b.user.id, role: 'editor' }); assert.equal(invitation.status, 201, invitation.text);
  assert.equal((await post(b, `/api/invitations/${invitation.data.invitation.id}/accept`, {})).status, 200);
  assert.equal((await f.call(`/api/rooms/${room.id}`, { cookie: b.cookie })).data.room.role, 'editor');
  assert.equal((await post(b, '/api/account', { username: 'no_upgrade', password: 'synthetic password only' })).data.code, 'REGISTRATION_DISABLED');
  assert.equal((await f.call('/api/session', { method: 'POST', body: { name: 'No guest' } })).data.code, 'GUEST_CREATION_DISABLED');
  assert.equal((await post(a, '/api/site-invites', {})).data.code, 'SITE_ADMISSION_DISABLED');
  await f.restart(); assert.equal((await f.call(`/api/rooms/${room.id}`, { cookie: b.cookie })).data.room.role, 'editor');
});

test('Restart durability: pending setup survives signup/login; completed setup cannot reopen; old schemas are refused without email migration', async t => {
  const f = await fixture(t, { setup: true }); const originalState = f.app.store.get('SELECT value FROM metadata WHERE key=?', SETUP_KEY).value;
  f.app.store.db.exec("CREATE TRIGGER reject_signup BEFORE INSERT ON accounts WHEN NEW.email='rollback@example.test' BEGIN SELECT RAISE(ABORT,'synthetic account insertion failure'); END");
  const before = f.app.store.get('SELECT COUNT(*) AS n FROM users').n; const rollback = await signupAttempt(f, input('rollback@example.test')); assert.equal(rollback.status, 500); assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM users').n, before); f.app.store.db.exec('DROP TRIGGER reject_signup');
  const data = await signup(f), me = await login(f, data); await f.restart(); assert.equal(f.app.store.get('SELECT value FROM metadata WHERE key=?', SETUP_KEY).value, originalState); assert.equal((await f.call('/api/setup/me', { cookie: me.cookie })).data.accountId, me.user.id); assert.equal((await login(f, data)).user.id, me.user.id);
  const other = await signup(f, input('other@example.test')); const otherId = (await login(f, other)).user.id;
  promoteSetupOwner(f.app.store, me.user.id); assert.throws(() => promoteSetupOwner(f.app.store, otherId), code('SETUP_ALREADY_INITIALIZED')); assert.equal((await signupAttempt(f, input('after@example.test'))).data.code, 'SETUP_ALREADY_INITIALIZED');
  await f.restart({ UNIVERSE_SETUP_ONLY: '0' }); assert.equal((await login(f, data)).setupOnly, false); assert.equal((await f.call('/api/session', { cookie: me.cookie })).data.user.id, me.user.id); assert.equal(f.app.store.get('SELECT owner_id FROM universes').owner_id, me.user.id); assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM world_members WHERE user_id=?', otherId).n, 0);
  assert.throws(() => createSetupMode({ store: f.app.store, config: { registrationMode: 'open', setupOnly: true }, accessGate: {} }), code('SETUP_ALREADY_INITIALIZED'));
  const directory = await mkdtemp(join(tmpdir(), 'old-email-schema-')); t.after(() => rm(directory, { recursive: true, force: true })); const oldDb = join(directory, 'old.sqlite'); const raw = new DatabaseSync(oldDb); raw.exec('CREATE TABLE accounts(username TEXT PRIMARY KEY COLLATE NOCASE,user_id TEXT NOT NULL UNIQUE,salt TEXT NOT NULL,password_hash TEXT NOT NULL)'); raw.close();
  assert.throws(() => createGameServer({ database: oldDb, seeds: seedWorlds, runtimeConfig: readRuntimeConfig({ UNIVERSE_REGISTRATION_MODE: 'open' }) }), code('OPEN_SIGNUP_SCHEMA_REQUIRED'));
  const inspect = new DatabaseSync(oldDb); assert.equal(inspect.prepare('PRAGMA table_info(accounts)').all().some(column => column.name === 'email'), false); inspect.close();
  const malformed = new Store(':memory:', seedWorlds); t.after(() => malformed.close()); malformed.db.exec('DROP TABLE accounts; CREATE TABLE accounts(username TEXT PRIMARY KEY, email TEXT COLLATE BINARY UNIQUE,user_id TEXT,salt TEXT,password_hash TEXT)'); assert.throws(() => assertOpenAccountSchema(malformed), code('OPEN_SIGNUP_SCHEMA_REQUIRED'));
});

test('Setup allowlist/promotion: identity only, strict gates, fresh eligibility, rollback, exact account ID and credential-free CLI', async t => {
  const f = await fixture(t, { setup: true }), data = await signup(f), signed = await login(f, data);
  assert.deepEqual(Object.keys(signed.response.data).sort(), ['accountId', 'setupOnly', 'user']); assert.equal(signed.setupOnly, true);
  assert.equal((await f.call('/api/setup/me')).status, 401); assert.equal((await f.call('/api/setup/me', { cookie: signed.cookie })).data.accountId, signed.user.id);
  for (const path of ['/', '/index.html', '/game.js', '/join.html', '/api/events', '/api/session', '/api/worlds', '/api/universes', '/api/rooms/commons', '/api/site-invites', '/api/client-protocol', '/api/signup?extra=1', '/api/setup/me?userId=other', '/%73ignup.html']) assert.equal((await f.call(path, { cookie: signed.cookie })).data.code, 'SETUP_ONLY', path);
  for (const path of ['/api/account', '/api/session', '/api/logout', '/api/rooms/commons/join']) assert.equal((await f.call(path, { method: 'POST', cookie: signed.cookie, body: {} })).data.code, 'SETUP_ONLY', path);
  for (const path of ['/signup.html', '/signup.js', '/signup.css', '/site-admission.css', '/universe-tokens.css', '/api/health', '/api/access']) assert.equal((await f.call(path)).status, 200, path);
  const page = await f.call('/signup.html'); assert.equal(page.headers['cache-control'], 'no-store'); assert.equal(page.headers['referrer-policy'], 'no-referrer'); assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.throws(() => promoteSetupOwner(f.app.store, 'tester+one@example.test'), code('INVALID_ACCOUNT_ID')); assert.throws(() => promoteSetupOwner(f.app.store, randomUUID()), code('SETUP_ACCOUNT_REQUIRED'));
  const wrong = randomUUID(); f.app.store.run('INSERT INTO users(id,name,woka,created_at) VALUES(?,?,?,?)', wrong, 'Wrong context', '0', Date.now()); f.app.store.run('INSERT INTO accounts(username,email,user_id,salt,password_hash) VALUES(?,?,?,?,?)', 'wrong_context', 'wrong@example.test', wrong, '00', '00'); assert.throws(() => promoteSetupOwner(f.app.store, wrong), code('SETUP_ACCOUNT_REQUIRED'));
  // Synthetic failure after ownership updates must roll back every grant/marker/audit.
  f.app.store.db.exec("CREATE TRIGGER reject_promotion BEFORE INSERT ON metadata WHEN NEW.key='operator-promotion-audit-v1' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.throws(() => promoteSetupOwner(f.app.store, signed.user.id), /synthetic failure/);
  assert.equal(f.app.store.get('SELECT 1 FROM metadata WHERE key=?', BOOTSTRAP_KEY), undefined); assert.equal(f.app.store.get('SELECT 1 FROM metadata WHERE key=?', PROMOTION_AUDIT_KEY), undefined);
  for (const table of ['universes', 'worlds', 'rooms']) assert.equal(f.app.store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id IS NOT NULL`).n, 0); assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM world_members').n, 0); assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM members').n, 0);
  f.app.store.db.exec('DROP TRIGGER reject_promotion');
  const run = id => new Promise((resolve, reject) => { const child = spawn(process.execPath, ['scripts/promote-owner.mjs', id], { cwd: new URL('..', import.meta.url), env: { ...process.env, UNIVERSE_DB: f.database }, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x); child.once('error', reject); child.once('exit', exit => resolve({ exit, output })); });
  const promoted = await run(signed.user.id); assert.equal(promoted.exit, 0, promoted.output); assert.equal(promoted.output.includes(data.email), false); assert.equal(promoted.output.includes(data.password), false); assert.equal((await run(signed.user.id)).exit, 1);
  const audit = JSON.parse(f.app.store.get('SELECT value FROM metadata WHERE key=?', PROMOTION_AUDIT_KEY).value); assert.equal(audit.accountId, signed.user.id); assert.equal(audit.event, 'setup-owner-promoted'); assertPrivate(audit);
  for (const row of f.app.store.all('SELECT * FROM members')) assert.equal(row.role, 'owner');
  const initialized = new Store(':memory:', seedWorlds); t.after(() => initialized.close()); const accessGate = createAccessGate({ store: initialized, config: { mode: 'local', registrationMode: 'local-open' } }); createSetupMode({ store: initialized, accessGate, config: { mode: 'local', registrationMode: 'local-open' } }); assert.throws(() => createSetupMode({ store: initialized, accessGate, config: { registrationMode: 'open', setupOnly: true } }), code('SETUP_ALREADY_INITIALIZED'));
  const dirty = new Store(':memory:', seedWorlds, Date.now, { claimUnownedOnCreate: false }); t.after(() => dirty.close()); dirty.createUser('Existing user', '0'); assert.throws(() => createSetupMode({ store: dirty, accessGate, config: { registrationMode: 'open', setupOnly: true } }), code('SETUP_DATABASE_NOT_FRESH'));
});

test('Deploy/HTTPS/SSE: synthetic security coverage only; real hosting, HTTPS and SSE remain operator-pending', async t => {
  const f = await fixture(t); f.app.setImagePhysicalSizeEnabledForTest(true); await signup(f); const signed = await login(f); assert.equal((await f.call('/api/setup/me', { cookie: signed.cookie })).status, 200); assert.match(signed.response.headers['set-cookie'][0], /HttpOnly; SameSite=Strict.*; Secure/);
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-User': '?1' }; assert.equal((await f.call('/signup.html', { headers: navigation })).status, 200);
  for (const path of ['/signup.html?email=x', '/signup.html/', '/signup.js', '/api/signup', '/join.html', '/']) assert.equal((await f.call(path, { headers: navigation })).status, 403);
  for (const headers of [{ Origin: undefined }, { Origin: 'https://evil.test' }, { Host: 'evil.test', 'X-Forwarded-Host': 'preview.example.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await signupAttemptWithHeaders(f, headers)).status, 403);
  const security = createRequestSecurity(readRuntimeConfig(publicEnv('/synthetic/db'))); for (const method of ['HEAD', 'POST']) assert.throws(() => security.assertRequest({ method, url: '/signup.html', headers: { host: 'preview.example.test', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-user': '?1' }, socket: {} }), code('ORIGIN_REJECTED'));
  for (const mode of ['disabled', 'invite-only']) { const closed = await fixture(t, { mode }); assert.equal((await closed.call('/api/signup')).data.enabled, false); assert.equal((await signupAttempt(closed, input())).data.code, 'SIGNUP_DISABLED'); }
});
const signupAttemptWithHeaders = (f, headers) => f.call('/api/signup', { method: 'POST', body: input('secure@example.test'), headers });
