import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync, backup} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {Store} from '../../server/store.mjs';
import {initializeHostTurnJournal, createHostTurnJournal} from '../../server/host-turn-journal.mjs';
import {key, terminal, tempDatabase, opened, throwsCode} from './helpers.mjs';

function host(t) {
  const {filename, directory} = tempDatabase(t), store = new Store(filename);
  t.after(() => { if (store.db.isOpen) store.close(); });
  return {store, filename, directory};
}
function policy(store) {
  return Object.fromEntries(['journal_mode','synchronous','foreign_keys','busy_timeout','trusted_schema','wal_autocheckpoint','locking_mode','temp_store','cache_size','journal_size_limit','secure_delete','query_only']
    .map(name => [name, store.get(`PRAGMA ${name}`)]));
}
function oldData(store) {
  return store.all("SELECT name,sql FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'resident_turn_journal_%' ORDER BY name")
    .map(({name,sql}) => ({name,sql,rows:store.all(`SELECT * FROM "${name}"`)}));
}

test('explicit initialization and read-only attachment preserve actual Store policy, tables and data', t => {
  const {store, filename, directory} = host(t), beforePolicy = policy(store);
  const user = store.createUser('Synthetic host user', '{}');
  store.run("INSERT INTO metadata VALUES('host-marker','old app data')");
  const before = oldData(store);
  throwsCode(assert, () => createHostTurnJournal({database:store.db}), 'TURN_JOURNAL_NOT_INITIALIZED');
  assert.deepEqual(oldData(store), before);
  assert.equal(initializeHostTurnJournal({database:store.db}), true);
  const journal = createHostTurnJournal({database:store.db});
  const adapter = journal.forActor({actorId:user.id, authorize:() => true});
  const identity = {...key, actorId:user.id};
  adapter.claim(identity); adapter.finish({...identity, result:terminal()}); journal.close();
  assert.deepEqual(policy(store), beforePolicy);
  assert.deepEqual(oldData(store), before);
  assert.equal(store.db.location('main'), filename);
  assert.deepEqual(readdirSync(directory).filter(name => !name.endsWith('-wal') && !name.endsWith('-shm')), ['app.sqlite']);
  assert.equal(store.user(user.id).name, 'Synthetic host user');
  store.transaction(() => store.run("UPDATE metadata SET value='still usable' WHERE key='host-marker'"));
  assert.equal(store.get("SELECT value FROM metadata WHERE key='host-marker'").value, 'still usable');
});

test('initialization rejects outer BEGIN and SAVEPOINT without committing or rolling back caller data', t => {
  const {store} = host(t);
  for (const open of ['BEGIN IMMEDIATE', 'SAVEPOINT host_migration']) {
    store.db.exec(open);
    store.run("INSERT INTO metadata VALUES('not-committed','host')");
    throwsCode(assert, () => initializeHostTurnJournal({database:store.db}), 'TURN_JOURNAL_OUTER_TRANSACTION');
    assert.equal(store.db.isTransaction, true);
    assert.equal(store.get("SELECT value FROM metadata WHERE key='not-committed'").value, 'host');
    assert.equal(store.get("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name LIKE 'resident_turn_journal_%'").n, 0);
    store.db.exec('ROLLBACK');
    assert.equal(store.get("SELECT value FROM metadata WHERE key='not-committed'"), undefined);
  }
  initializeHostTurnJournal({database:store.db});
  store.db.exec('BEGIN');
  throwsCode(assert, () => createHostTurnJournal({database:store.db}), 'TURN_JOURNAL_OUTER_TRANSACTION');
  store.db.exec('ROLLBACK');
});

test('new/pending/replay claim and both finish paths reject outer transactions before authorization', t => {
  const {store, journal} = opened(t); let checks = 0;
  const adapter = journal.forActor({actorId:key.actorId, authorize:() => { checks++; return true; }});
  for (const state of ['absent', 'pending', 'terminal']) {
    if (state === 'pending') adapter.claim(key);
    if (state === 'terminal') adapter.finish({...key, result:terminal()});
    const previousChecks = checks;
    for (const open of ['BEGIN', 'BEGIN IMMEDIATE', 'SAVEPOINT host_request']) {
      store.db.exec(open);
      store.run("INSERT INTO metadata VALUES('outer-marker','preserved')");
      throwsCode(assert, () => adapter.claim(key), 'TURN_JOURNAL_OUTER_TRANSACTION');
      throwsCode(assert, () => adapter.finish({...key, result:terminal()}), 'TURN_JOURNAL_OUTER_TRANSACTION');
      assert.equal(checks, previousChecks);
      assert.equal(store.db.isTransaction, true);
      assert.equal(store.get("SELECT value FROM metadata WHERE key='outer-marker'").value, 'preserved');
      store.db.exec('ROLLBACK');
    }
  }
  assert.equal(adapter.claim(key).status, 'replay');
});

test('detaching while a caller transaction exists does not touch it or close the host', t => {
  const {store, journal, adapter} = opened(t);
  store.db.exec('BEGIN'); store.run("INSERT INTO metadata VALUES('host-uncommitted','yes')");
  journal.close(); journal.close();
  assert.equal(store.db.isTransaction, true); assert.equal(store.db.isOpen, true);
  throwsCode(assert, () => adapter.claim(key), 'TURN_JOURNAL_CLOSED');
  store.db.exec('COMMIT');
  assert.equal(store.get("SELECT value FROM metadata WHERE key='host-uncommitted'").value, 'yes');
});

test('foreign, memory, temporary and closed handles are rejected without closing caller handles', t => {
  for (const database of [null, {}, {isOpen:true, isTransaction:false}]) {
    throwsCode(assert, () => initializeHostTurnJournal({database}), 'TURN_JOURNAL_INVALID_DATABASE');
  }
  for (const filename of [':memory:', '']) {
    const database = new DatabaseSync(filename); t.after(() => database.close());
    throwsCode(assert, () => initializeHostTurnJournal({database}), 'TURN_JOURNAL_INVALID_DATABASE');
    assert.equal(database.isOpen, true);
  }
  const {store, journal, adapter} = opened(t); store.close();
  throwsCode(assert, () => adapter.claim(key), 'TURN_JOURNAL_HOST_CLOSED');
  throwsCode(assert, () => createHostTurnJournal({database:store.db}), 'TURN_JOURNAL_HOST_CLOSED');
  journal.close();
});

test('unsuitable durability and host policies fail closed and are never silently changed', t => {
  const {store} = host(t);
  for (const [assignment, code] of [
    ['synchronous=NORMAL','TURN_JOURNAL_DURABILITY_UNAVAILABLE'],
    ['synchronous=OFF','TURN_JOURNAL_DURABILITY_UNAVAILABLE'],
    ['journal_mode=DELETE','TURN_JOURNAL_DURABILITY_UNAVAILABLE'],
    ['foreign_keys=OFF','TURN_JOURNAL_HOST_POLICY'],
    ['busy_timeout=10001','TURN_JOURNAL_HOST_POLICY'],
    ['query_only=ON','TURN_JOURNAL_HOST_POLICY'],
  ]) {
    store.db.exec(`PRAGMA ${assignment}`); const before = policy(store);
    throwsCode(assert, () => initializeHostTurnJournal({database:store.db}), code);
    assert.deepEqual(policy(store), before); assert.equal(store.db.isOpen, true);
    assert.equal(store.get("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name LIKE 'resident_turn_journal_%'").n, 0);
    store.db.exec('PRAGMA query_only=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  }
  store.db.exec('PRAGMA synchronous=EXTRA');
  assert.equal(initializeHostTurnJournal({database:store.db}), true);
  assert.equal(store.get('PRAGMA synchronous').synchronous, 3);
});

test('host policy is rechecked before every claim/finish and failure preserves pending ownership', t => {
  const {store, adapter} = opened(t);
  store.db.exec('PRAGMA synchronous=NORMAL');
  throwsCode(assert, () => adapter.claim(key), 'TURN_JOURNAL_DURABILITY_UNAVAILABLE');
  assert.equal(store.get('SELECT COUNT(*) AS n FROM resident_turn_journal_v1').n, 0);
  store.db.exec('PRAGMA synchronous=FULL'); adapter.claim(key);
  store.db.exec('PRAGMA synchronous=NORMAL');
  throwsCode(assert, () => adapter.finish({...key, result:terminal()}), 'TURN_JOURNAL_DURABILITY_UNAVAILABLE');
  assert.equal(store.get('SELECT state FROM resident_turn_journal_v1').state, 'pending');
  store.db.exec('PRAGMA synchronous=FULL'); assert.equal(adapter.finish({...key, result:terminal()}), true);
});

test('failed initialization rolls back its tables, preserves legacy data, and never closes host', t => {
  const {store} = host(t);
  store.db.exec('CREATE TABLE resident_turn_journal_v1(private_column TEXT)');
  const before = oldData(store), beforePolicy = policy(store);
  throwsCode(assert, () => initializeHostTurnJournal({database:store.db}), 'TURN_JOURNAL_SCHEMA_CONFLICT');
  assert.equal(store.db.isOpen, true); assert.equal(store.db.isTransaction, false);
  assert.equal(store.get("SELECT name FROM sqlite_schema WHERE name='resident_turn_journal_config_v1'"), undefined);
  assert.deepEqual(oldData(store), before); assert.deepEqual(policy(store), beforePolicy);
});

test('repeat initialization is idempotent and rejects persisted capacity changes without closing host', t => {
  const {store, adapter} = opened(t, {maxTurns:2}); adapter.claim(key);
  assert.equal(initializeHostTurnJournal({database:store.db, maxTurns:2}), true);
  throwsCode(assert, () => initializeHostTurnJournal({database:store.db, maxTurns:3}), 'TURN_JOURNAL_CONFIG_CONFLICT');
  assert.equal(store.get('SELECT max_turns FROM resident_turn_journal_config_v1').max_turns, 2);
  assert.equal(adapter.claim(key).status, 'pending'); assert.equal(store.db.isOpen, true);
});

test('current authorization reads real host session, room and world-manager state inside each transaction', t => {
  const {store, journal} = opened(t);
  const user = store.createUser('Synthetic manager', '{}'), owner = store.createUser('Synthetic owner', '{}');
  store.run("INSERT INTO worlds(id,name,universe_id,slug,created_at) VALUES('world-one','World','universe-main','world',0)");
  store.run("INSERT INTO rooms(id,world_id,name,slug,scene,created_at) VALUES('room-one','world-one','Room','room','{}',0)");
  store.run('UPDATE universes SET owner_id=?', owner.id);
  store.run("INSERT INTO world_members(world_id,user_id,role,created_at) VALUES('world-one',?,'editor',0)", user.id);
  store.run("INSERT INTO sessions(token_hash,user_id,expires_at,current_room_id) VALUES('synthetic-session',?,?,'room-one')", user.id, Date.now()+100000);
  const identity = {...key, actorId:user.id}, phases = [];
  const adapter = journal.forActor({actorId:user.id, authorize:context => {
    assert.equal(store.db.isTransaction, true); phases.push(context.phase);
    const session = store.get("SELECT * FROM sessions WHERE token_hash='synthetic-session' AND expires_at>?", Date.now());
    if (!session || session.user_id !== context.actorId || session.current_room_id !== 'room-one') return false;
    const {row} = store.authorize('room-one', context.actorId);
    return ['owner','admin','editor'].includes(store.worldRole(store.worldRow(row.world_id), context.actorId));
  }});
  adapter.claim(identity);
  store.run("UPDATE world_members SET role='member' WHERE user_id=?", user.id);
  throwsCode(assert, () => adapter.claim(identity), 'TURN_JOURNAL_AUTHORIZATION_REVOKED');
  throwsCode(assert, () => adapter.finish({...identity, result:terminal()}), 'TURN_JOURNAL_AUTHORIZATION_REVOKED');
  store.run("UPDATE world_members SET role='editor' WHERE user_id=?", user.id);
  adapter.finish({...identity, result:terminal()});
  store.run("UPDATE sessions SET current_room_id=NULL WHERE token_hash='synthetic-session'");
  throwsCode(assert, () => adapter.claim(identity), 'TURN_JOURNAL_AUTHORIZATION_REVOKED');
  store.run("UPDATE sessions SET current_room_id='room-one' WHERE token_hash='synthetic-session'");
  store.run("UPDATE rooms SET archived_at=1 WHERE id='room-one'");
  throwsCode(assert, () => adapter.claim(identity), 'TURN_JOURNAL_AUTHORIZATION_REVOKED');
  store.run("UPDATE rooms SET archived_at=NULL WHERE id='room-one'");
  assert.equal(adapter.claim(identity).status, 'replay');
  store.run("DELETE FROM sessions WHERE token_hash='synthetic-session'");
  throwsCode(assert, () => adapter.finish({...identity, result:terminal()}), 'TURN_JOURNAL_AUTHORIZATION_REVOKED');
  assert(phases.includes('claim') && phases.includes('finish'));
});

test('multiple borrowers cannot recursively use or close a connection during authorization', t => {
  const {store, journal} = opened(t), other = createHostTurnJournal({database:store.db});
  t.after(() => other.close());
  const safe = other.forActor({actorId:key.actorId, authorize:() => true});
  for (const action of [() => safe.claim(key), () => journal.close(), () => other.close(), () => initializeHostTurnJournal({database:store.db})]) {
    const adapter = journal.forActor({actorId:key.actorId, authorize:() => { action(); return true; }});
    throwsCode(assert, () => adapter.claim(key), 'TURN_JOURNAL_AUTHORIZATION_REVOKED');
    assert.equal(store.db.isTransaction, false);
  }
  assert.equal(safe.claim(key).status, 'new');
});

test('rollback failure poisons every borrower but caller DB remains open for explicit recovery', t => {
  const {store, journal, adapter} = opened(t), other = createHostTurnJournal({database:store.db});
  const otherAdapter = other.forActor({actorId:key.actorId, authorize:() => true});
  const originalExec = store.db.exec;
  store.db.exec("CREATE TRIGGER deny_host_insert BEFORE INSERT ON resident_turn_journal_v1 BEGIN SELECT RAISE(ABORT,'must not leak'); END");
  store.db.exec = function(sql) { if (sql === 'ROLLBACK') throw new Error('synthetic rollback failure'); return originalExec.call(this, sql); };
  try { throwsCode(assert, () => adapter.claim(key), 'TURN_JOURNAL_STORAGE_ERROR'); }
  finally { store.db.exec = originalExec; }
  assert.equal(store.db.isOpen, true); assert.equal(store.db.isTransaction, true);
  throwsCode(assert, () => otherAdapter.claim(key), 'TURN_JOURNAL_UNUSABLE');
  // Only the host owner chooses how to recover its connection.
  store.db.exec('ROLLBACK'); assert.equal(store.get('SELECT 1 AS n').n, 1);
  throwsCode(assert, () => adapter.claim(key), 'TURN_JOURNAL_UNUSABLE');
  throwsCode(assert, () => createHostTurnJournal({database:store.db}), 'TURN_JOURNAL_UNUSABLE');
  journal.close(); other.close(); assert.equal(store.db.isOpen, true);
});

test('same-name TEMP tables cannot shadow durable main journal data', t => {
  const {store, adapter} = opened(t);
  store.db.exec('CREATE TEMP TABLE resident_turn_journal_v1(actor_id TEXT,turn_id TEXT,fingerprint TEXT,state TEXT,receipt_json TEXT,receipt_sha256 TEXT,created_at INTEGER,finished_at INTEGER)');
  store.db.exec('CREATE TEMP TABLE resident_turn_journal_config_v1(singleton INTEGER,version INTEGER,max_turns INTEGER,max_receipt_bytes INTEGER)');
  assert.equal(adapter.claim(key).status, 'new'); adapter.finish({...key, result:terminal()});
  assert.equal(adapter.claim(key).status, 'replay');
  assert.equal(store.get('SELECT COUNT(*) AS n FROM main.resident_turn_journal_v1').n, 1);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM temp.resident_turn_journal_v1').n, 0);
  const another = createHostTurnJournal({database:store.db}); another.close();
});

test('one SQLite backup contains old app data plus terminal and permanently pending journal identities', async t => {
  const {store, directory, adapter} = opened(t);
  store.run("INSERT INTO metadata VALUES('backup-marker','same app snapshot')");
  adapter.claim(key); adapter.finish({...key, result:terminal()});
  const pending = {...key, turnId:'pending-at-snapshot'}; adapter.claim(pending);
  const snapshot = join(directory, 'consistent-snapshot.sqlite');
  await backup(store.db, snapshot);
  const restored = opened(t, {filename:snapshot});
  assert.equal(restored.store.get("SELECT value FROM metadata WHERE key='backup-marker'").value, 'same app snapshot');
  assert.deepEqual(restored.adapter.claim(key), {status:'replay', result:terminal()});
  assert.deepEqual(restored.adapter.claim(pending), {status:'pending'});
  throwsCode(assert, () => restored.adapter.finish({...pending, result:terminal()}), 'TURN_JOURNAL_NOT_OWNED');
});

test('rejected private receipt never reaches any host main/WAL bytes', t => {
  const privateText = 'Synthetic private author text with a uniquely long forbidden echo';
  const {directory, adapter} = opened(t, {}, {protectedText:[privateText]});
  adapter.claim(key);
  throwsCode(assert, () => adapter.finish({...key, result:terminal({text:privateText})}), 'TURN_JOURNAL_UNSAFE_RECEIPT');
  adapter.finish({...key, result:terminal()});
  for (const file of readdirSync(directory)) assert.equal(readFileSync(join(directory,file)).includes(Buffer.from(privateText)), false);
});

test('lookup is exact-identity, current-authorized, validated, detached and never admits or finalizes', t => {
  const {store, journal, adapter} = opened(t); let allowed = true;
  const phases = [], reader = journal.forActor({actorId:key.actorId, authorize:({phase}) => { phases.push(phase); return allowed; }});
  const changed = () => store.get('SELECT total_changes() AS count').count;
  let before = changed();
  assert.deepEqual(reader.lookup(key), {status:'absent'}); assert.equal(changed(), before);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM resident_turn_journal_v1').n, 0);
  adapter.claim(key); before = changed();
  assert.deepEqual(reader.lookup(key), {status:'pending'}); assert.equal(changed(), before);
  throwsCode(assert, () => reader.finish({...key, result:terminal()}), 'TURN_JOURNAL_NOT_OWNED');
  adapter.finish({...key, result:terminal()}); before = changed();
  const outcome = reader.lookup(key); assert.deepEqual(outcome, {status:'replay', result:terminal()}); assert.equal(changed(), before);
  outcome.result.text = 'caller mutation'; assert.deepEqual(reader.lookup(key).result, terminal());
  throwsCode(assert, () => reader.lookup({actorId:key.actorId, turnId:key.turnId}), 'TURN_JOURNAL_INVALID_INPUT');
  throwsCode(assert, () => reader.lookup({...key, fingerprint:'b'.repeat(64)}), 'TURN_REUSED');
  throwsCode(assert, () => reader.lookup({...key, actorId:'other'}), 'TURN_JOURNAL_ACTOR_MISMATCH');
  allowed = false; throwsCode(assert, () => reader.lookup(key), 'TURN_JOURNAL_AUTHORIZATION_REVOKED');
  allowed = true; store.db.exec('SAVEPOINT host_reader');
  throwsCode(assert, () => reader.lookup(key), 'TURN_JOURNAL_OUTER_TRANSACTION'); store.db.exec('ROLLBACK');
  store.run("UPDATE resident_turn_journal_v1 SET receipt_json='{}'");
  throwsCode(assert, () => reader.lookup(key), 'TURN_JOURNAL_CORRUPT_RECEIPT');
  assert(phases.includes('lookup'));
});

test('a swallowed COMMIT cannot acknowledge durable new or terminal completion', t => {
  const {store, adapter} = opened(t), originalExec = store.db.exec;
  function swallowCommit(sql) { if (sql === 'COMMIT') return; return originalExec.call(this,sql); }
  store.db.exec = swallowCommit;
  try { throwsCode(assert, () => adapter.claim(key), 'TURN_JOURNAL_STORAGE_ERROR'); }
  finally { store.db.exec = originalExec; }
  assert.equal(store.db.isTransaction, false); assert.equal(store.get('SELECT COUNT(*) AS n FROM resident_turn_journal_v1').n, 0);
  adapter.claim(key); store.db.exec = swallowCommit;
  try { throwsCode(assert, () => adapter.finish({...key, result:terminal()}), 'TURN_JOURNAL_STORAGE_ERROR'); }
  finally { store.db.exec = originalExec; }
  assert.equal(store.db.isTransaction, false); assert.equal(adapter.claim(key).status, 'pending');
  adapter.finish({...key, result:terminal()});
});

test('host authorizer closing its DB never yields new and poisons borrowed adapters safely', t => {
  const {store, journal} = opened(t);
  const adapter = journal.forActor({actorId:key.actorId, authorize:() => { store.close(); return true; }});
  throwsCode(assert, () => adapter.claim(key), 'TURN_JOURNAL_STORAGE_ERROR');
  assert.equal(store.db.isOpen, false);
  throwsCode(assert, () => adapter.claim(key), 'TURN_JOURNAL_UNUSABLE');
  journal.close();
});

test('existing original v1 journal schema and receipts attach without rewriting identities', {skip:'Original standalone adapter was lost; retained historical compatibility test is not recovery evidence'}, async t => {
  const {openSqliteTurnJournal} = await import('../../universe-game-bot-turn-journal/server/sqlite-turn-journal.mjs');
  const {filename} = tempDatabase(t), original = openSqliteTurnJournal({filename});
  const writer = original.forActor({actorId:key.actorId, authorize:() => true});
  writer.claim(key); writer.finish({...key, result:terminal()}); original.close();
  const store = new Store(filename); t.after(() => store.close());
  const journal = createHostTurnJournal({database:store.db}); t.after(() => journal.close());
  const reader = journal.forActor({actorId:key.actorId, authorize:() => true});
  assert.deepEqual(reader.lookup(key), {status:'replay', result:terminal()});
  assert.equal(initializeHostTurnJournal({database:store.db}), true);
  assert.deepEqual(reader.claim(key), {status:'replay', result:terminal()});
});
