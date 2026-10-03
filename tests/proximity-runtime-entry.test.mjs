// Synthetic child processes and temporary SQLite only; no operator deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGameServer} from '../server/app.mjs';
import {proximityFixture} from './fixtures/proximity-config.mjs';

const enabled = {membership:proximityFixture, text:{enabled:true}};
const off = {membership:{enabled:false}, text:{enabled:false}};
// Observe any bind attempt independently of the entry's post-listen ready signal.
const probe = 'data:text/javascript,' + encodeURIComponent(`
  import {Server} from 'node:net';
  const listen = Server.prototype.listen;
  Server.prototype.listen = function(...args) {
    process.send?.({type:'synthetic-listen-attempt'});
    return Reflect.apply(listen, this, args);
  };
`);

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'universe-proximity-runtime-'));
  t.after(() => rm(path, {recursive:true, force:true}));
  return path;
}

function start(t, database, env = {}) {
  // Deliberately do not inherit ambient deployment, ICE, Node options or secrets.
  const child = fork(new URL('../server.mjs', import.meta.url), [], {
    cwd:new URL('..', import.meta.url), execArgv:['--import', probe],
    env:{PORT:'0', UNIVERSE_DB:database, ...env}, stdio:['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages = [];
  let output = '';
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { output += value; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({code, signal}));
  });
  const ready = new Promise((resolve, reject) => {
    child.on('message', message => { messages.push(message); if (message.type === 'ready') resolve(message); });
    exited.then(({code}) => reject(Error(`Synthetic entry exited before ready (${code}): ${output}`)), reject);
  });
  // Invalid configurations are expected to reject ready; their tests await exited.
  ready.catch(() => {});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  });
  return {ready, exited, messages, output:() => output};
}

async function member(base, name) {
  const response = await fetch(base + '/api/session', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({name, woka:0})});
  assert.equal(response.status, 201);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const joined = await fetch(base + '/api/rooms/commons/join', {method:'POST', headers:{cookie, 'content-type':'application/json'}, body:'{}'});
  assert.equal(joined.status, 200);
  return cookie;
}

async function nearbyContext(base, cookie) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  const response = await fetch(base + '/api/events', {headers:{cookie}, signal:controller.signal});
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      const {value, done} = await reader.read();
      assert.equal(done, false, 'SSE must provide the enabled Nearby context');
      buffered += decoder.decode(value, {stream:true});
      let end;
      while ((end = buffered.indexOf('\n\n')) >= 0) {
        const block = buffered.slice(0, end); buffered = buffered.slice(end + 2);
        if (block.startsWith('event: proximity-text-context\n')) return JSON.parse(block.match(/^data: (.+)$/m)[1]);
      }
    }
  } finally { clearTimeout(timer); controller.abort(); await reader.cancel().catch(() => {}); }
}

for (const [label, config, membershipOn, textOn] of [
  ['absent', undefined, false, false],
  ['explicit off', off, false, false],
  ['membership only', {...enabled, text:{enabled:false}}, true, false],
  ['both explicitly enabled', enabled, true, true],
]) test(`real process entry: ${label}`, {timeout:15000}, async t => {
  const path = await directory(t), env = config === undefined ? {} : {UNIVERSE_PROXIMITY_CONFIG:JSON.stringify(config)};
  const child = start(t, join(path, 'synthetic.sqlite'), env);
  const {port} = await child.ready, base = `http://127.0.0.1:${port}`;
  assert.equal(child.messages.filter(message => message.type === 'synthetic-listen-attempt').length, 1);
  const cookie = await member(base, 'Synthetic A');
  await member(base, 'Synthetic B');
  const media = await (await fetch(base + '/api/media', {headers:{cookie}})).json();
  assert.equal(Object.hasOwn(media, 'proximityMembership'), membershipOn);
  assert.equal(media.enabled, false); // Process config never grants microphone consent.
  if (membershipOn) {
    assert.equal(media.proximityMembership.transport.memberCount, 2);
    assert.equal(media.proximityMembership.conversationRecipients.length, 1);
  } else assert.equal(media.limits.proximityParticipants, 4);
  if (textOn) {
    const context = await nearbyContext(base, cookie);
    assert.equal(context.available, true); assert.equal(context.canSend, true);
    assert.equal(context.recipientCount, 1);
  } else {
    const context = await (await fetch(base + '/api/proximity-text', {headers:{cookie}})).json();
    assert.deepEqual(context, {protocol:'proximity-text-v1', available:false, canSend:false, reason:'disabled'});
    const post = await fetch(base + '/api/proximity-text/messages', {method:'POST', headers:{cookie, 'content-type':'application/json'}, body:'{}'});
    assert.equal(post.status, 404);
  }
});

for (const [label, value] of [
  ['blank', ''], ['null', 'null'], ['partial root', '{"membership":{"enabled":false}}'],
  ['partial policy', JSON.stringify({membership:{enabled:true}, text:{enabled:true}})],
  ['malformed JSON', '{"SYNTHETIC_NOT_A_CREDENTIAL":'],
  ['unknown field', JSON.stringify({...off, SYNTHETIC_NOT_A_CREDENTIAL:'SYNTHETIC_NOT_A_CREDENTIAL'})],
  ['text alone', JSON.stringify({...off, text:{enabled:true}})],
  ['invalid policy', JSON.stringify({...enabled, membership:{...proximityFixture, memberTtlMs:60001}})],
]) test(`real process rejects ${label} before bind or storage creation`, {timeout:15000}, async t => {
  const path = await directory(t);
  const child = start(t, join(path, 'must-not-exist', 'synthetic.sqlite'), {UNIVERSE_PROXIMITY_CONFIG:value, SYNTHETIC_UNUSED_CREDENTIAL:'SYNTHETIC_NOT_A_CREDENTIAL'});
  const result = await child.exited;
  assert.equal(result.code, 1);
  assert.deepEqual(child.messages, []);
  assert.deepEqual(await readdir(path), []);
  assert.match(child.output(), /Invalid UNIVERSE_PROXIMITY_CONFIG:/);
  assert.equal(child.output().includes('SYNTHETIC_NOT_A_CREDENTIAL'), false);
});

test('invalid process configuration leaves an existing synthetic database byte-for-byte intact', {timeout:15000}, async t => {
  const path = await directory(t), database = join(path, 'synthetic.sqlite');
  const app = createGameServer({database, questsEnabled:false});
  app.store.run('INSERT INTO metadata(key,value) VALUES(?,?)', 'synthetic-sentinel', 'keep');
  await app.close();
  const before = await readFile(database), files = await readdir(path);
  const child = start(t, database, {UNIVERSE_PROXIMITY_CONFIG:'{}'});
  assert.equal((await child.exited).code, 1);
  assert.deepEqual(child.messages, []);
  assert.deepEqual(await readFile(database), before);
  assert.deepEqual(await readdir(path), files);
});

for (const config of [JSON.stringify(enabled), 'malformed']) test(`reusable factory ignores ${config === 'malformed' ? 'malformed' : 'enabled'} ambient proximity input`, {timeout:15000}, async t => {
  const saved = process.env.UNIVERSE_PROXIMITY_CONFIG;
  process.env.UNIVERSE_PROXIMITY_CONFIG = config;
  try {
    const scene = {version:1, theme:'garden', bounds:{width:32, depth:26}, spawn:{x:0, z:0}, objects:[], areas:[]};
    const app = createGameServer({questsEnabled:false, seeds:[{id:'synthetic', name:'Synthetic', rooms:[{id:'commons', name:'Synthetic room', scene}]}]});
    t.after(() => app.close());
    const {port} = await app.listen(0), base = `http://127.0.0.1:${port}`, cookie = await member(base, 'Synthetic factory');
    const media = await (await fetch(base + '/api/media', {headers:{cookie}})).json();
    const text = await (await fetch(base + '/api/proximity-text', {headers:{cookie}})).json();
    assert.equal(Object.hasOwn(media, 'proximityMembership'), false);
    assert.equal(media.limits.proximityParticipants, 4);
    assert.equal(text.available, false); assert.equal(text.reason, 'disabled');
  } finally {
    if (saved === undefined) delete process.env.UNIVERSE_PROXIMITY_CONFIG;
    else process.env.UNIVERSE_PROXIMITY_CONFIG = saved;
  }
});
