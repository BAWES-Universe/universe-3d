import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {key, digest, terminal, tempDatabase, opened, throwsCode} from './helpers.mjs';

const fixture = new URL('./fixtures/process-worker.mjs', import.meta.url);
function worker(t) {
  const process = fork(fixture, [], {stdio:['ignore', 'pipe', 'pipe', 'ipc']});
  let stderr = ''; process.stderr.on('data', data => { stderr += data; });
  t.after(() => { if (process.exitCode === null) process.kill('SIGKILL'); });
  async function request(message) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => done(new Error(`Fixture timeout: ${stderr}`)), 15000);
      const onExit = () => done(new Error(`Fixture exited: ${stderr}`));
      const onMessage = result => done(null, result);
      function done(error, result) {
        clearTimeout(timeout); process.off('exit', onExit); process.off('message', onMessage);
        if (error) reject(error); else resolve(result);
      }
      process.once('exit', onExit); process.once('message', onMessage); process.send(message);
    });
  }
  return {process, request};
}

test('SIGKILL after committed claim survives restart and cannot be reclaimed or finalized by a replacement', async t => {
  const {filename} = tempDatabase(t), first = worker(t);
  assert.deepEqual(await first.request({command:'open', filename, key}), {event:'ready'});
  assert.deepEqual(await first.request({command:'claim', key}), {event:'claimed', outcome:{status:'new'}});
  const killed = once(first.process, 'exit'); first.process.kill('SIGKILL'); await killed;
  const replacement = opened(t, {filename});
  assert.equal(replacement.store.get("SELECT value FROM metadata WHERE key='host-before-process'").value, 'old app data survives');
  assert.deepEqual(replacement.adapter.claim(key), {status:'pending'});
  throwsCode(assert, () => replacement.adapter.finish({...key, result:terminal()}), 'TURN_JOURNAL_NOT_OWNED');
  replacement.journal.close();
  const third = worker(t);
  await third.request({command:'open', filename, key});
  assert.deepEqual(await third.request({command:'claim', key}), {event:'claimed', outcome:{status:'pending'}});
  await third.request({command:'close'});
});

test('SIGKILL after finalization replays the exact terminal receipt after process restart', async t => {
  const {filename} = tempDatabase(t), first = worker(t);
  await first.request({command:'open', filename, key}); await first.request({command:'claim', key});
  assert.deepEqual(await first.request({command:'finish', key}), {event:'finished', saved:true});
  const killed = once(first.process, 'exit'); first.process.kill('SIGKILL'); await killed;
  const second = worker(t); await second.request({command:'open', filename, key});
  assert.deepEqual(await second.request({command:'claim', key}), {event:'claimed', outcome:{status:'replay', result:terminal()}});
  assert.deepEqual(await second.request({command:'finish', key}), {event:'finished', saved:true});
  await second.request({command:'close'});
});

test('eight real processes racing the same actor+turn grant exactly one committed new claim', async t => {
  const {filename, directory} = tempDatabase(t), marker = join(directory, 'synthetic-admitted-work.txt');
  const workers = Array.from({length:8}, () => worker(t));
  const openedResults = await Promise.all(workers.map(child => child.request({command:'open', filename, key})));
  assert(openedResults.every(result => result.event === 'ready'));
  const results = await Promise.all(workers.map(child => child.request({command:'claim', key, marker})));
  assert.equal(results.filter(result => result.outcome?.status === 'new').length, 1);
  assert.equal(results.filter(result => result.outcome?.status === 'pending').length, 7);
  assert.equal(readFileSync(marker, 'utf8').trim().split('\n').length, 1);
  const ownerIndex = results.findIndex(result => result.outcome?.status === 'new');
  assert.deepEqual(await workers[ownerIndex].request({command:'finish', key}), {event:'finished', saved:true});
  const replays = await Promise.all(workers.map(child => child.request({command:'claim', key})));
  for (const replay of replays) assert.deepEqual(replay, {event:'claimed', outcome:{status:'replay', result:terminal()}});
  await Promise.all(workers.map(child => child.request({command:'close'})));
});

test('process race with conflicting fingerprints never acquires a second identity', async t => {
  const {filename} = tempDatabase(t);
  const workers = Array.from({length:6}, () => worker(t));
  await Promise.all(workers.map(child => child.request({command:'open', filename, key})));
  const identities = workers.map((_, index) => ({...key, fingerprint:digest(`synthetic-variant-${index % 2}`)}));
  const outcomes = await Promise.all(workers.map((child, index) => child.request({command:'claim', key:identities[index]})));
  assert.equal(outcomes.filter(result => result.outcome?.status === 'new').length, 1);
  assert.equal(outcomes.filter(result => result.outcome?.status === 'pending').length, 2);
  assert.equal(outcomes.filter(result => result.code === 'TURN_REUSED').length, 3);
  const db = new DatabaseSync(filename); t.after(() => db.close());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resident_turn_journal_v1').get().n, 1);
  await Promise.all(workers.map(child => child.request({command:'close'})));
});

test('capacity check and insert are one transaction across competing processes', async t => {
  const {filename} = tempDatabase(t), workers = Array.from({length:4}, () => worker(t));
  await Promise.all(workers.map(child => child.request({command:'open', filename, key, options:{maxTurns:1}})));
  const results = await Promise.all(workers.map((child, index) => child.request({command:'claim', key:{...key, turnId:`turn-${index}`}})));
  assert.equal(results.filter(result => result.outcome?.status === 'new').length, 1);
  assert.equal(results.filter(result => result.code === 'TURN_JOURNAL_CAPACITY').length, 3);
  await Promise.all(workers.map(child => child.request({command:'close'})));
});
