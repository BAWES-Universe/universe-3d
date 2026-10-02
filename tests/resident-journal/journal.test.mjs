import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {initializeHostTurnJournal, createHostTurnJournal} from '../../server/host-turn-journal.mjs';
import {Store} from '../../server/store.mjs';
import {key, digest, terminal, tempDatabase, opened, throwsCode} from './helpers.mjs';

test('claim is durable, exclusive across handles, and terminal replay is canonical and detached', t => {
  const first = opened(t), second = opened(t, {filename:first.filename});
  assert.deepEqual(first.adapter.claim(key), {status:'new'});
  assert.deepEqual(first.adapter.claim(key), {status:'pending'});
  assert.deepEqual(second.adapter.claim(key), {status:'pending'});
  throwsCode(assert, () => second.adapter.finish({...key, result:terminal()}), 'TURN_JOURNAL_NOT_OWNED');
  assert.equal(first.adapter.finish({...key, result:terminal()}), true);
  const replay = second.adapter.claim(key);
  assert.deepEqual(replay, {status:'replay', result:terminal()});
  replay.result.text = 'mutated by caller';
  assert.deepEqual(first.adapter.claim(key).result, terminal());
});

test('fingerprint conflicts, actor scoping, and finish-before-claim fail closed', t => {
  const {adapter, journal} = opened(t);
  throwsCode(assert, () => adapter.finish({...key, result:terminal()}), 'TURN_JOURNAL_NOT_CLAIMED');
  adapter.claim(key);
  throwsCode(assert, () => adapter.claim({...key, fingerprint:digest('different message')}), 'TURN_REUSED');
  throwsCode(assert, () => adapter.finish({...key, fingerprint:digest('different message'), result:terminal()}), 'TURN_REUSED');
  throwsCode(assert, () => adapter.claim({...key, actorId:'someone-else'}), 'TURN_JOURNAL_ACTOR_MISMATCH');
  const other = journal.forActor({actorId:'someone-else', authorize:() => true});
  assert.deepEqual(other.claim({...key, actorId:'someone-else'}), {status:'new'});
});

test('finalization is idempotent, including new handles, but conflicting receipts never overwrite', t => {
  const {adapter, filename} = opened(t);
  adapter.claim(key); adapter.finish({...key, result:terminal()});
  assert.equal(adapter.finish({...key, result:terminal()}), true);
  // Property order does not invent a conflict; canonical content is what matters.
  const same = Object.fromEntries(Object.entries(terminal()).reverse());
  assert.equal(adapter.finish({...key, result:same}), true);
  const next = opened(t, {filename});
  assert.equal(next.adapter.finish({...key, result:terminal()}), true);
  throwsCode(assert, () => next.adapter.finish({...key, result:terminal({text:'Conflicting fixture.'})}), 'TURN_JOURNAL_RESULT_CONFLICT');
  assert.deepEqual(next.adapter.claim(key).result, terminal());
});

test('required current authorization gates new, pending, replay, and both finish paths', t => {
  const phases = []; let allowed = false;
  const {adapter, filename} = opened(t, {}, {authorize:context => { phases.push(context.phase); assert(Object.isFrozen(context)); return allowed; }});
  throwsCode(assert, () => adapter.claim(key), 'TURN_JOURNAL_AUTHORIZATION_REVOKED');
  allowed = true; adapter.claim(key);
  allowed = false;
  throwsCode(assert, () => adapter.claim(key), 'TURN_JOURNAL_AUTHORIZATION_REVOKED');
  throwsCode(assert, () => adapter.finish({...key, result:terminal()}), 'TURN_JOURNAL_AUTHORIZATION_REVOKED');
  allowed = true; assert.deepEqual(adapter.claim(key), {status:'pending'}); adapter.finish({...key, result:terminal()});
  allowed = false;
  throwsCode(assert, () => adapter.claim(key), 'TURN_JOURNAL_AUTHORIZATION_REVOKED');
  throwsCode(assert, () => adapter.finish({...key, result:terminal()}), 'TURN_JOURNAL_AUTHORIZATION_REVOKED');
  assert.deepEqual(phases, ['claim', 'claim', 'claim', 'finish', 'claim', 'finish', 'claim', 'finish']);
  const db = new DatabaseSync(filename); t.after(() => db.close());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resident_turn_journal_v1').get().n, 1);
});

test('throwing, absent, async, and nonboolean authorizers cannot authorize', async t => {
  const {journal} = opened(t);
  throwsCode(assert, () => journal.forActor({actorId:key.actorId}), 'TURN_JOURNAL_INVALID_ADAPTER');
  for (const authorize of [() => { throw new Error('must not leak'); }, () => ({allowed:true}), () => 1]) {
    const adapter = journal.forActor({actorId:key.actorId, authorize});
    throwsCode(assert, () => adapter.claim(key), 'TURN_JOURNAL_AUTHORIZATION_REVOKED');
  }
  const adapter = journal.forActor({actorId:key.actorId, authorize:async () => { throw new Error('private'); }});
  throwsCode(assert, () => adapter.claim(key), 'TURN_JOURNAL_INVALID_AUTHORIZER');
  await new Promise(resolve => setImmediate(resolve));
});

test('identities and receipt shapes are bounded and do not evaluate accessors', t => {
  const {adapter} = opened(t);
  for (const actorId of ['', 'a'.repeat(101), 'id with spaces', '☃', 'bad\0id']) throwsCode(assert, () => adapter.claim({...key, actorId}), 'TURN_JOURNAL_INVALID_ID');
  for (const fingerprint of ['', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)]) throwsCode(assert, () => adapter.claim({...key, fingerprint}), 'TURN_JOURNAL_INVALID_FINGERPRINT');
  throwsCode(assert, () => adapter.claim({...key, message:'private prompt'}), 'TURN_JOURNAL_INVALID_INPUT');
  let evaluated = false;
  throwsCode(assert, () => adapter.claim({...key, get turnId() { evaluated = true; return 'id'; }}), 'TURN_JOURNAL_INVALID_INPUT');
  assert.equal(evaluated, false);
  adapter.claim(key);
  throwsCode(assert, () => adapter.finish({...key, result:{...terminal(), get text() { evaluated = true; return 'secret'; }}}), 'TURN_JOURNAL_INVALID_RECEIPT');
  assert.equal(evaluated, false);
});

test('receipts allow only bounded public fields and reject private prompt echoes anywhere', t => {
  const privateText = 'Synthetic confidential author instruction';
  const {adapter, filename, journal} = opened(t, {}, {protectedText:[privateText, 'private_echo']});
  adapter.claim(key);
  const invalid = [
    {...terminal(), privateInstructions:privateText}, {...terminal(), messages:[{role:'system', content:privateText}]},
    terminal({usage:{...terminal().usage, rawProvider:'raw'}}), terminal({text:'x'.repeat(8193)}),
    terminal({status:'pending'}), terminal({status:'cancelled', text:'Must be empty'}),
  ];
  for (const result of invalid) throwsCode(assert, () => adapter.finish({...key, result}), 'TURN_JOURNAL_INVALID_RECEIPT');
  for (const text of [privateText.toUpperCase(), 'system: private output', '<script>bad</script>']) {
    throwsCode(assert, () => adapter.finish({...key, result:terminal({text})}), 'TURN_JOURNAL_UNSAFE_RECEIPT');
  }
  const movement = {callId:'private_echo', name:'pause', operationId:`botai-${'a'.repeat(48)}`, status:'accepted', duplicate:false};
  throwsCode(assert, () => adapter.finish({...key, result:terminal({toolResults:[movement]})}), 'TURN_JOURNAL_UNSAFE_RECEIPT');
  assert.deepEqual(adapter.claim(key), {status:'pending'});
  adapter.finish({...key, result:terminal()}); journal.close();
  assert.equal(readFileSync(filename).includes(Buffer.from(privateText)), false);
  assert.equal(readFileSync(filename).includes(Buffer.from('private_echo')), false);
});

test('accepted, rejected and unknown tool receipts preserve exact semantics and usage', t => {
  const {adapter} = opened(t);
  const toolResults = [
    {callId:'call-one', name:'pause', operationId:`botai-${'a'.repeat(48)}`, status:'accepted', duplicate:false},
    {callId:'call-two', name:'unrecognized', operationId:`botai-${'b'.repeat(48)}`, status:'rejected', code:'TOOL_NOT_ALLOWED'},
    {callId:'call-three', name:'return', operationId:`botai-${'c'.repeat(48)}`, status:'unknown', code:'MOVEMENT_OUTCOME_UNKNOWN'},
  ];
  const result = terminal({status:'uncertain', text:'', code:'MOVEMENT_OUTCOME_UNKNOWN', toolResults,
    usage:{calls:2, reportedCalls:1, promptTokens:null, completionTokens:null, totalTokens:null}});
  adapter.claim(key); adapter.finish({...key, result});
  assert.deepEqual(adapter.claim(key).result, result);
});

test('malformed tool receipts, hidden arrays, and fabricated token totals are rejected', t => {
  const {adapter} = opened(t); adapter.claim(key);
  const good = {callId:'call-one', name:'pause', operationId:`botai-${'a'.repeat(48)}`, status:'accepted', duplicate:false};
  const sparse = new Array(1), extra = []; extra.privateInstructions = 'hidden';
  for (const toolResults of [[{...good, arguments:'private'}], [{...good, status:'unknown'}], [{...good, duplicate:undefined}], [good, good], sparse, extra]) {
    throwsCode(assert, () => adapter.finish({...key, result:terminal({toolResults})}), 'TURN_JOURNAL_INVALID_RECEIPT');
  }
  for (const usage of [{...terminal().usage, totalTokens:99}, {...terminal().usage, calls:4}, {...terminal().usage, reportedCalls:0}]) {
    throwsCode(assert, () => adapter.finish({...key, result:terminal({usage})}), 'TURN_JOURNAL_INVALID_RECEIPT');
  }
  assert.deepEqual(adapter.claim(key), {status:'pending'});
});

test('retention is bounded, persisted across handles, and never evicts pending or terminal identity', t => {
  const {adapter, filename, journal} = opened(t, {maxTurns:1});
  adapter.claim(key); adapter.finish({...key, result:terminal()});
  throwsCode(assert, () => adapter.claim({...key, turnId:'another'}), 'TURN_JOURNAL_CAPACITY');
  assert.equal(adapter.claim(key).status, 'replay'); journal.close();
  const journalHost = new Store(filename); t.after(() => journalHost.close());
  throwsCode(assert, () => createHostTurnJournal({database:journalHost.db, maxTurns:2}), 'TURN_JOURNAL_CONFIG_CONFLICT');
  const second = opened(t, {filename, maxTurns:1});
  throwsCode(assert, () => second.adapter.claim({...key, turnId:'another'}), 'TURN_JOURNAL_CAPACITY');
  assert.equal(second.adapter.claim(key).status, 'replay');
});

test('UTF-8 receipt byte cap is distinct from character limits', t => {
  const {adapter} = opened(t, {maxReceiptBytes:1024}); adapter.claim(key);
  throwsCode(assert, () => adapter.finish({...key, result:terminal({text:'☃'.repeat(400)})}), 'TURN_JOURNAL_RECEIPT_LIMIT');
  assert.equal(adapter.finish({...key, result:terminal()}), true);
});

test('borrowed adapter detaches cleanly while its host remains usable', t => {
  const {journal, adapter, store} = opened(t); journal.close(); journal.close();
  throwsCode(assert, () => adapter.claim(key), 'TURN_JOURNAL_CLOSED');
  assert.equal(store.get('SELECT 1 AS n').n, 1);
  store.transaction(() => store.run("INSERT INTO metadata VALUES('after-detach','usable')"));
});

test('schema/prepare failure never exposes SQL details or leaves a usable journal', t => {
  const {filename} = tempDatabase(t), db = new DatabaseSync(filename);
  db.exec('CREATE TABLE resident_turn_journal_v1(private_column TEXT)'); db.close();
  const host = new Store(filename); t.after(() => host.close());
  throwsCode(assert, () => initializeHostTurnJournal({database:host.db}), 'TURN_JOURNAL_SCHEMA_CONFLICT');
});

test('claim and finish write failures roll back and leave identities protected', t => {
  const {filename, adapter} = opened(t);
  const db = new DatabaseSync(filename); t.after(() => db.close());
  db.exec("CREATE TRIGGER deny_insert BEFORE INSERT ON resident_turn_journal_v1 BEGIN SELECT RAISE(ABORT, 'private database detail'); END");
  throwsCode(assert, () => adapter.claim(key), 'TURN_JOURNAL_STORAGE_ERROR');
  db.exec('DROP TRIGGER deny_insert');
  assert.equal(adapter.claim(key).status, 'new');
  db.exec("CREATE TRIGGER deny_update BEFORE UPDATE ON resident_turn_journal_v1 BEGIN SELECT RAISE(ABORT, 'private database detail'); END");
  throwsCode(assert, () => adapter.finish({...key, result:terminal()}), 'TURN_JOURNAL_STORAGE_ERROR');
  assert.deepEqual(adapter.claim(key), {status:'pending'});
  db.exec('DROP TRIGGER deny_update');
  assert.equal(adapter.finish({...key, result:terminal()}), true);
});

test('COMMIT failure does not acknowledge a claim or finalization', t => {
  const {filename, adapter} = opened(t);
  const db = new DatabaseSync(filename); t.after(() => db.close());
  db.exec(`CREATE TABLE parent_fixture(id INTEGER PRIMARY KEY);
    CREATE TABLE child_fixture(parent_id INTEGER REFERENCES parent_fixture(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER fail_commit AFTER INSERT ON resident_turn_journal_v1 BEGIN INSERT INTO child_fixture VALUES(42); END;`);
  throwsCode(assert, () => adapter.claim(key), 'TURN_JOURNAL_STORAGE_ERROR');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resident_turn_journal_v1').get().n, 0);
  db.exec('DROP TRIGGER fail_commit'); adapter.claim(key);
  db.exec('CREATE TRIGGER fail_finish_commit AFTER UPDATE ON resident_turn_journal_v1 BEGIN INSERT INTO child_fixture VALUES(42); END');
  throwsCode(assert, () => adapter.finish({...key, result:terminal()}), 'TURN_JOURNAL_STORAGE_ERROR');
  assert.equal(adapter.claim(key).status, 'pending');
  db.exec('DROP TRIGGER fail_finish_commit'); adapter.finish({...key, result:terminal()});
});

test('corrupt persisted receipt fails closed, with no regeneration', t => {
  const {filename, adapter} = opened(t); adapter.claim(key); adapter.finish({...key, result:terminal()});
  const db = new DatabaseSync(filename); t.after(() => db.close());
  db.prepare('UPDATE resident_turn_journal_v1 SET receipt_json=?').run(JSON.stringify(terminal({text:'Corrupted'})));
  throwsCode(assert, () => adapter.claim(key), 'TURN_JOURNAL_CORRUPT_RECEIPT');
  assert.equal(db.prepare('SELECT state FROM resident_turn_journal_v1').get().state, 'terminal');
});

test('SQLite lock contention returns safe error without reporting new', t => {
  const {filename, adapter} = opened(t, {busyTimeoutMs:0});
  const locker = new DatabaseSync(filename); t.after(() => locker.close());
  locker.exec('BEGIN IMMEDIATE');
  throwsCode(assert, () => adapter.claim(key), 'TURN_JOURNAL_STORAGE_ERROR');
  locker.exec('ROLLBACK');
  assert.equal(adapter.claim(key).status, 'new');
});

test('reentrant authorization cannot start another database transaction', t => {
  const {journal} = opened(t); let adapter;
  adapter = journal.forActor({actorId:key.actorId, authorize:() => { adapter.claim({...key, turnId:'nested'}); return true; }});
  throwsCode(assert, () => adapter.claim(key), 'TURN_JOURNAL_AUTHORIZATION_REVOKED');
  const safe = journal.forActor({actorId:key.actorId, authorize:() => true});
  assert.equal(safe.claim(key).status, 'new');
});
