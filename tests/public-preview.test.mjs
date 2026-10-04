import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createGameServer } from '../server/app.mjs';
import { Store } from '../server/store.mjs';
import { readRuntimeConfig } from '../server/runtime-config.mjs';
import { bootstrapOwner, addReviewer } from '../server/operator-accounts.mjs';
import { seedWorlds } from '../src/worlds.js';

const ownerInput = { name: 'HTTP Fixture Owner', username: 'http_test_owner', password: 'synthetic HTTP owner password only' };
const reviewerInput = { name: 'HTTP Fixture Reviewer', username: 'http_test_reviewer', password: 'synthetic HTTP reviewer password only' };
const envFor = database => ({
  UNIVERSE_MODE: 'public', UNIVERSE_BIND_ADDRESS: '127.0.0.1', PORT: '4190',
  UNIVERSE_DB: database, UNIVERSE_ALLOWED_HOSTS: 'preview.example.test',
  UNIVERSE_ALLOWED_ORIGINS: 'https://preview.example.test',
  UNIVERSE_TLS_MODE: 'external', UNIVERSE_COOKIE_SECURE: 'always',
  UNIVERSE_REGISTRATION_MODE: 'disabled',
});

// Actual HTTP sockets always target loopback. The fictional public Host is only
// a header fixture; no DNS lookup, remote server or real credential is used.
function call(port, path, { method = 'GET', body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const json = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: {
      Host: 'preview.example.test', ...(json === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) }),
      ...(cookie ? { Cookie: cookie } : {}), ...headers,
    } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', data => { text += data; });
      res.on('end', () => { try { resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(text) }); } catch (error) { reject(error); } });
      res.on('error', reject);
    });
    req.on('error', reject); req.end(json);
  });
}
const change = (body, cookie, headers = {}) => ({ method: 'POST', body, cookie, headers: { Origin: 'https://preview.example.test', ...headers } });

test('public server refuses the fresh database before listening, while local factory ignores ambient env', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'universe-public-start-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'fixture.sqlite');
  assert.throws(() => createGameServer({ database, seeds: seedWorlds, runtimeConfig: readRuntimeConfig(envFor(database)) }), error => error.code === 'OPERATOR_BOOTSTRAP_REQUIRED');
  const inspect = new Store(database, seedWorlds); assert.equal(inspect.get('SELECT COUNT(*) AS n FROM users').n, 0); inspect.close();
  const before = process.env.UNIVERSE_MODE; process.env.UNIVERSE_MODE = 'public';
  let local;
  try { local = createGameServer({ seeds: seedWorlds }); } finally { if (before === undefined) delete process.env.UNIVERSE_MODE; else process.env.UNIVERSE_MODE = before; }
  t.after(() => local.close()); const { port } = await local.listen(0);
  const response = await call(port, '/api/access', { headers: { Host: `127.0.0.1:${port}` } });
  assert.equal(response.data.guestCreation, true); assert.equal(response.data.mode, 'local');
});

test('Store public-creation guard blocks all first-profile ownership even below HTTP admission', t => {
  const store = new Store(':memory:', seedWorlds, Date.now, { claimUnownedOnCreate: false }); t.after(() => store.close());
  const user = store.createUser('Synthetic unprivileged profile', 0);
  for (const table of ['universes', 'worlds', 'rooms']) assert.equal(store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id IS NOT NULL`).n, 0);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM world_members WHERE user_id=?', user.id).n, 0);
});

test('real HTTP private preview enforces origin, admission, Secure cookies and reviewer authority', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'universe-public-http-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'fixture.sqlite'), provision = new Store(database, seedWorlds);
  const owner = await bootstrapOwner(provision, ownerInput), reviewer = await addReviewer(provision, reviewerInput); provision.close();
  const runtimeConfig = readRuntimeConfig(envFor(database));
  const app = createGameServer({ database, seeds: seedWorlds, runtimeConfig }); t.after(() => app.close());
  const { port } = await app.listen(0);
  let result = await call(port, '/api/access');
  assert.deepEqual(result.data, { mode: 'public', guestCreation: false, registration: false, login: true, provisioning: 'operator', inviteRegistration:false, siteAdmission:{enabled:false,canManage:false,inviteTtlMs:86400000,maxActiveInvites:25,maxAccounts:50} });
  result = await call(port, '/api/health'); assert.equal(result.status, 200); assert.equal(result.data.scope, 'standalone-private-preview');
  result = await call(port, '/api/session'); assert.equal(result.status, 401);
  result = await call(port, '/api/session', change({ name: 'Internet claimant' })); assert.equal(result.status, 403); assert.equal(result.data.code, 'GUEST_CREATION_DISABLED');
  assert.equal(app.store.get('SELECT COUNT(*) AS n FROM users').n, 2);
  for (const bad of [
    { Host: 'evil.test', 'X-Forwarded-Host': 'preview.example.test' },
    { Host: '127.0.0.1', Forwarded: 'host=preview.example.test;proto=https' },
    { Origin: 'http://preview.example.test' }, { Origin: 'https://evil.test' }, { 'Sec-Fetch-Site': 'cross-site' },
  ]) assert.equal((await call(port, '/api/health', { headers: bad })).status, 403);
  result = await call(port, '/api/login', { method: 'POST', body: ownerInput, headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(result.status, 403); assert.equal(result.data.code, 'ORIGIN_REQUIRED');
  result = await call(port, '/api/login', change({ username: ownerInput.username, password: 'synthetic wrong password' })); assert.equal(result.status, 401);
  result = await call(port, '/api/login', change(ownerInput, undefined, { 'X-Forwarded-Proto': 'http' })); assert.equal(result.status, 200);
  const cookieHeader = result.headers['set-cookie'][0], ownerCookie = cookieHeader.split(';')[0];
  assert.match(cookieHeader, /; Secure/); assert.match(cookieHeader, /; HttpOnly/); assert.match(cookieHeader, /; SameSite=Strict/);
  assert.equal(result.data.user.id, owner.id);
  result = await call(port, '/api/session', change({}, ownerCookie)); assert.equal(result.status, 200); assert.equal(result.data.user.id, owner.id);
  result = await call(port, '/api/account', change({ username: 'attempted_account', password: 'synthetic attempted new password' }, ownerCookie)); assert.equal(result.status, 403); assert.equal(result.data.code, 'REGISTRATION_DISABLED');
  result = await call(port, '/api/login', change(reviewerInput)); assert.equal(result.status, 200); const reviewerCookie = result.headers['set-cookie'][0].split(';')[0];
  result = await call(port, '/api/rooms/commons/join', change({}, reviewerCookie)); assert.equal(result.status, 200); assert.equal(result.data.room.role, 'guest'); assert.equal(result.data.room.capabilities.canEditScene, false);
  assert.equal(app.store.get('SELECT COUNT(*) AS n FROM world_members WHERE user_id=?', reviewer.id).n, 0);
  result = await call(port, '/api/rooms/commons/join', change({}, ownerCookie)); assert.equal(result.data.room.role, 'owner');
  result = await call(port, '/api/logout', change({}, ownerCookie)); assert.equal(result.status, 200); assert.match(result.headers['set-cookie'][0], /Max-Age=0; Secure/);
  result = await call(port, '/api/session', { cookie: ownerCookie }); assert.equal(result.status, 401);
  assert.equal(app.store.get('SELECT COUNT(*) AS n FROM users').n, 2);
  assert.equal(app.store.claimUnownedOnCreate, false);

  const healthExit = async overrides => {
    const child = spawn(process.execPath, ['scripts/healthcheck.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, ...envFor(database), PORT: String(port), ...overrides }, stdio: 'ignore' });
    return new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  };
  assert.equal(await healthExit({}), 0);
  assert.equal(await healthExit({ UNIVERSE_ALLOWED_HOSTS: 'wrong.example.test', UNIVERSE_ALLOWED_ORIGINS: 'https://wrong.example.test' }), 1);
});
