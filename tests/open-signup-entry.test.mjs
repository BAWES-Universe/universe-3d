import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const listenProbe = 'data:text/javascript,' + encodeURIComponent("import{Server}from'node:net';const original=Server.prototype.listen;Server.prototype.listen=function(...args){process.send?.({type:'test-listen-attempt'});return Reflect.apply(original,this,args);};");
async function database(t) { const directory = await mkdtemp(join(tmpdir(), 'open-signup-entry-')); t.after(() => rm(directory, { recursive: true, force: true })); return join(directory, 'fixture.sqlite'); }
function start(t, path, env = {}) {
  const child = fork(new URL('../server.mjs', import.meta.url), [], { cwd: new URL('..', import.meta.url), execArgv: ['--import', listenProbe], env: { PORT: '0', UNIVERSE_DB: path, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; const messages = []; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x);
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  const ready = new Promise((resolve, reject) => { child.on('message', message => { messages.push(message); if (message.type === 'ready') resolve(message); }); exited.then(({ code }) => reject(Error(`entry exited ${code}: ${output}`)), reject); }); ready.catch(() => {});
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; };
  t.after(stop);
  return { ready, exited, messages, stop, output: () => output };
}

test('Signup/login/normalize/race/cap: process entry explicitly enables open mode and defaults to 10,000 accounts', async t => {
  const path = await database(t), running = start(t, path, { UNIVERSE_REGISTRATION_MODE: 'open', UNIVERSE_SETUP_ONLY: '1' }), { port } = await running.ready;
  const policy = await (await fetch(`http://127.0.0.1:${port}/api/signup`)).json(); assert.equal(policy.enabled, true); assert.equal(policy.maxAccounts, 10000); assert.equal(policy.setupOnly, true);
  const created = await fetch(`http://127.0.0.1:${port}/api/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'process+test@example.test', name: 'Synthetic process account', password: 'synthetic process signup password only' }) }); assert.equal(created.status, 201); assert.equal(created.headers.get('set-cookie'), null);
  await running.stop();
  const restarted = start(t, path, { UNIVERSE_REGISTRATION_MODE: 'open', UNIVERSE_SETUP_ONLY: '1', UNIVERSE_SITE_MAX_ACCOUNTS: '17' }), next = await restarted.ready;
  const login = await fetch(`http://127.0.0.1:${next.port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ' PROCESS+TEST@EXAMPLE.TEST ', password: 'synthetic process signup password only' }) }); assert.equal(login.status, 200); const identity = await login.json(); assert.equal(identity.setupOnly, true); assert.equal('rooms' in identity, false); assert.equal('worlds' in identity, false);
  assert.equal((await (await fetch(`http://127.0.0.1:${next.port}/api/signup`)).json()).maxAccounts, 17);
});

test('Setup allowlist/promotion: invalid flags, pending-mode escape and old account schemas fail before listening', async t => {
  for (const env of [{ UNIVERSE_SETUP_ONLY: 'true' }, { UNIVERSE_SETUP_ONLY: '1', UNIVERSE_REGISTRATION_MODE: 'disabled' }, { UNIVERSE_SETUP_ONLY: '1', UNIVERSE_REGISTRATION_MODE: 'invite-only' }, { UNIVERSE_REGISTRATION_MODE: 'open', UNIVERSE_SITE_MAX_ACCOUNTS: '10001' }]) {
    const failed = start(t, await database(t), env); assert.notEqual((await failed.exited).code, 0); assert.equal(failed.messages.some(message => message.type === 'test-listen-attempt'), false);
  }
  const path = await database(t), setup = start(t, path, { UNIVERSE_REGISTRATION_MODE: 'open', UNIVERSE_SETUP_ONLY: '1' }); await setup.ready; await setup.stop();
  const escaped = start(t, path, { UNIVERSE_REGISTRATION_MODE: 'local-open' }); assert.notEqual((await escaped.exited).code, 0); assert.equal(escaped.messages.some(message => message.type === 'test-listen-attempt'), false); assert.match(escaped.output(), /awaiting owner promotion/);
  const oldPath = await database(t), old = new DatabaseSync(oldPath); old.exec('CREATE TABLE accounts(username TEXT PRIMARY KEY,user_id TEXT UNIQUE,salt TEXT,password_hash TEXT)'); old.close();
  const incompatible = start(t, oldPath, { UNIVERSE_REGISTRATION_MODE: 'open', UNIVERSE_SETUP_ONLY: '1' }); assert.notEqual((await incompatible.exited).code, 0); assert.equal(incompatible.messages.some(message => message.type === 'test-listen-attempt'), false); assert.match(incompatible.output(), /no email migration/);
});
