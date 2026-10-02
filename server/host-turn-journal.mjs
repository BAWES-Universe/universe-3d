import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {TurnJournalError, exact, fail, id, fingerprint, integer, publicReceipt} from './receipt.mjs';

export {TurnJournalError} from './receipt.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const identityKeys = ['actorId', 'turnId', 'fingerprint'];
const table = 'resident_turn_journal_v1';
const configTable = 'resident_turn_journal_config_v1';
// Shares reentrancy/poison state across all adapters borrowing this connection.
// This is not durable turn ownership; that remains scoped to each forActor adapter.
const connectionStates = new WeakMap();
const schema = `        CREATE TABLE IF NOT EXISTS resident_turn_journal_config_v1 (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          version INTEGER NOT NULL CHECK(version=1),
          max_turns INTEGER NOT NULL CHECK(max_turns BETWEEN 1 AND 1000000),
          max_receipt_bytes INTEGER NOT NULL CHECK(max_receipt_bytes BETWEEN 1024 AND 65536)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS ${table} (
          actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 100 AND actor_id NOT GLOB '*[^A-Za-z0-9_-]*'),
          turn_id TEXT NOT NULL CHECK(length(turn_id) BETWEEN 1 AND 100 AND turn_id NOT GLOB '*[^A-Za-z0-9_-]*'),
          fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
          state TEXT NOT NULL CHECK(state IN ('pending','terminal')),
          receipt_json TEXT,
          receipt_sha256 TEXT,
          created_at INTEGER NOT NULL CHECK(created_at>=0),
          finished_at INTEGER CHECK(finished_at>=0),
          PRIMARY KEY(actor_id,turn_id),
          CHECK((state='pending' AND receipt_json IS NULL AND receipt_sha256 IS NULL AND finished_at IS NULL)
             OR (state='terminal' AND receipt_json IS NOT NULL AND length(receipt_json)<=65536
                 AND length(receipt_sha256)=64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*' AND finished_at IS NOT NULL))
        ) STRICT, WITHOUT ROWID;
`;
const expectedSchema = new Map(schema.trim().split(/;\s*/).filter(Boolean).map(sql => [
  sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)[1], canonicalSchema(sql),
]));
function canonicalSchema(sql) { return sql.replace(/IF NOT EXISTS\s+/i, '').replace(/\s+/g, '').replace(/;$/, ''); }
function storageError(error) {
  if (error instanceof TurnJournalError) throw error;
  // Never expose raw SQL, bound values, paths, or host exceptions.
  fail('TURN_JOURNAL_STORAGE_ERROR');
}
function settings(maxTurns, maxReceiptBytes) {
  integer(maxTurns, 1, 1000000); integer(maxReceiptBytes, 1024, 65536);
}
function connection(database) {
  if (!(database instanceof DatabaseSync)) fail('TURN_JOURNAL_INVALID_DATABASE');
  let state = connectionStates.get(database);
  if (!state) { state = {inTransaction:false, unusable:false}; connectionStates.set(database, state); }
  return state;
}
function inspectHost(database, state) {
  if (state.unusable) fail('TURN_JOURNAL_UNUSABLE');
  if (!database.isOpen) fail('TURN_JOURNAL_HOST_CLOSED');
  // Native SQLite transaction state detects BEGIN and outer SAVEPOINT alike.
  // Never attempt rollback of a transaction that the journal did not begin.
  if (typeof database.isTransaction !== 'boolean') fail('TURN_JOURNAL_INVALID_DATABASE');
  if (database.isTransaction) fail('TURN_JOURNAL_OUTER_TRANSACTION');
  const location = database.location('main');
  if (typeof location !== 'string' || !isAbsolute(location) || location.includes('\0')) fail('TURN_JOURNAL_INVALID_DATABASE');
  if (state.location && state.location !== location) fail('TURN_JOURNAL_INVALID_DATABASE');
  state.location = location;
  const mode = database.prepare('PRAGMA main.journal_mode').get().journal_mode;
  const sync = database.prepare('PRAGMA main.synchronous').get().synchronous;
  if (mode !== 'wal' || ![2, 3].includes(sync)) fail('TURN_JOURNAL_DURABILITY_UNAVAILABLE');
  const foreignKeys = database.prepare('PRAGMA foreign_keys').get().foreign_keys;
  const busyTimeout = database.prepare('PRAGMA busy_timeout').get().timeout;
  const queryOnly = database.prepare('PRAGMA query_only').get().query_only;
  if (foreignKeys !== 1 || queryOnly !== 0 || !Number.isSafeInteger(busyTimeout) || busyTimeout < 0 || busyTimeout > 10000) fail('TURN_JOURNAL_HOST_POLICY');
}
function transact(database, state, work) {
  if (state.inTransaction) fail('TURN_JOURNAL_REENTRANT');
  let began = false;
  try {
    inspectHost(database, state);
    state.inTransaction = true;
    database.exec('BEGIN IMMEDIATE'); began = true;
    if (!database.isTransaction) { state.unusable = true; fail('TURN_JOURNAL_UNUSABLE'); }
    const result = work();
    // The trusted authorization hook must be read-only and leave our transaction intact.
    if (!database.isOpen || !database.isTransaction) { state.unusable = true; fail('TURN_JOURNAL_UNUSABLE'); }
    database.exec('COMMIT');
    if (database.isTransaction) fail('TURN_JOURNAL_STORAGE_ERROR');
    began = false;
    return result;
  } catch (error) {
    if (began) {
      try { database.exec('ROLLBACK'); }
      catch { state.unusable = true; }
      // A rollback failure poisons all borrowers but NEVER closes a caller-owned DB.
    }
    storageError(error);
  } finally { state.inTransaction = false; }
}
function checkSchema(database, maxTurns, maxReceiptBytes) {
  for (const [name, sql] of expectedSchema) {
    const row = database.prepare('SELECT type,sql FROM main.sqlite_schema WHERE name=?').get(name);
    if (!row) fail('TURN_JOURNAL_NOT_INITIALIZED');
    if (row.type !== 'table' || canonicalSchema(row.sql) !== sql) fail('TURN_JOURNAL_SCHEMA_CONFLICT');
  }
  const config = database.prepare(`SELECT * FROM main.${configTable} WHERE singleton=1`).get();
  if (!config || config.version !== 1 || config.max_turns !== maxTurns || config.max_receipt_bytes !== maxReceiptBytes) fail('TURN_JOURNAL_CONFIG_CONFLICT');
}

/** Explicit host migration step. Requires autocommit, commits only these two tables. */
export function initializeHostTurnJournal({database, maxTurns = 10000, maxReceiptBytes = 65536} = {}) {
  settings(maxTurns, maxReceiptBytes);
  const state = connection(database);
  return transact(database, state, () => {
    // Main qualification prevents a TEMP table from shadowing journal identities.
    database.exec(schema.replaceAll('CREATE TABLE IF NOT EXISTS ', 'CREATE TABLE IF NOT EXISTS main.'));
    database.prepare(`INSERT OR IGNORE INTO main.${configTable} VALUES(1,1,?,?)`).run(maxTurns, maxReceiptBytes);
    checkSchema(database, maxTurns, maxReceiptBytes);
    return true;
  });
}

/** Borrows an initialized Store.db. Opens no file and never closes or retunes the host. */
export function createHostTurnJournal({database, maxTurns = 10000, maxReceiptBytes = 65536} = {}) {
  settings(maxTurns, maxReceiptBytes);
  const state = connection(database);
  let closed = false;
  // Attachment is read-only and cannot create/migrate tables as a side effect.
  try {
    if (state.inTransaction) fail('TURN_JOURNAL_REENTRANT');
    inspectHost(database, state);
    checkSchema(database, maxTurns, maxReceiptBytes);
  } catch (error) { storageError(error); }
  function transaction(work) {
    if (closed) fail('TURN_JOURNAL_CLOSED');
    return transact(database, state, work);
  }
  let get, count, insert, finish;
  try {
    get = database.prepare(`SELECT fingerprint,state,receipt_json,receipt_sha256 FROM main.${table} WHERE actor_id=? AND turn_id=?`);
    count = database.prepare(`SELECT COUNT(*) AS count FROM main.${table}`);
    insert = database.prepare(`INSERT INTO main.${table}(actor_id,turn_id,fingerprint,state,created_at) VALUES(?,?,?,'pending',?)`);
    finish = database.prepare(`UPDATE main.${table} SET state='terminal',receipt_json=?,receipt_sha256=?,finished_at=? WHERE actor_id=? AND turn_id=? AND fingerprint=? AND state='pending'`);
  } catch (error) { storageError(error); }
  function forActor({actorId, authorize, protectedText = []} = {}) {
    if (closed) fail('TURN_JOURNAL_CLOSED');
    id(actorId);
    if (typeof authorize !== 'function' || !Array.isArray(protectedText) || protectedText.length > 32
        || protectedText.some(value => typeof value !== 'string' || !value.trim() || value.length > 8192)) fail('TURN_JOURNAL_INVALID_ADAPTER');
    const protectedStrings = protectedText.map(value => value.trim().toLowerCase());
    // Ownership is intentionally process-local. A lost pending owner never reacquires implicitly.
    const owned = new Set();
    function authorizeNow(identity, phase) {
      let allowed;
      try { allowed = authorize(Object.freeze({...identity, phase})); }
      catch { fail('TURN_JOURNAL_AUTHORIZATION_REVOKED'); }
      if (allowed?.then) { allowed.catch?.(() => {}); fail('TURN_JOURNAL_INVALID_AUTHORIZER'); }
      if (allowed !== true) fail('TURN_JOURNAL_AUTHORIZATION_REVOKED');
    }
    function identity(input, withResult = false) {
      exact(input, withResult ? [...identityKeys, 'result'] : identityKeys);
      id(input.actorId); id(input.turnId); fingerprint(input.fingerprint);
      if (input.actorId !== actorId) fail('TURN_JOURNAL_ACTOR_MISMATCH');
      return {actorId, turnId:input.turnId, fingerprint:input.fingerprint};
    }
    function currentRow(key) {
      const row = get.get(key.actorId, key.turnId);
      if (row && row.fingerprint !== key.fingerprint) fail('TURN_REUSED');
      return row;
    }
    function readTerminal(row) {
      if (typeof row.receipt_json !== 'string' || hash(row.receipt_json) !== row.receipt_sha256) fail('TURN_JOURNAL_CORRUPT_RECEIPT');
      let input; try { input = JSON.parse(row.receipt_json); } catch { fail('TURN_JOURNAL_CORRUPT_RECEIPT'); }
      const receipt = publicReceipt(input, {maxReceiptBytes, protectedText:protectedStrings});
      if (receipt.json !== row.receipt_json) fail('TURN_JOURNAL_CORRUPT_RECEIPT');
      return receipt;
    }
    return Object.freeze({
      lookup(input) {
        const key = identity(input);
        return transaction(() => {
          authorizeNow(key, 'lookup');
          const row = currentRow(key);
          if (row?.state === 'terminal') return {status:'replay', result:readTerminal(row).result};
          return {status:row ? 'pending' : 'absent'};
        });
      },
      claim(input) {
        const key = identity(input);
        const outcome = transaction(() => {
          authorizeNow(key, 'claim');
          const row = currentRow(key);
          if (row?.state === 'terminal') return {status:'replay', result:readTerminal(row).result};
          if (row) return {status:'pending'};
          if (count.get().count >= maxTurns) fail('TURN_JOURNAL_CAPACITY');
          insert.run(key.actorId, key.turnId, key.fingerprint, Date.now());
          return {status:'new'};
        });
        // Never return `new` or retain finish authority before the COMMIT acknowledgement.
        if (outcome.status === 'new') owned.add(key.turnId);
        return outcome;
      },
      finish(input) {
        const key = identity(input, true);
        const success = transaction(() => {
          authorizeNow(key, 'finish');
          const row = currentRow(key);
          if (!row) fail('TURN_JOURNAL_NOT_CLAIMED');
          const receipt = publicReceipt(input.result, {maxReceiptBytes, protectedText:protectedStrings});
          if (row.state === 'terminal') {
            if (readTerminal(row).json !== receipt.json) fail('TURN_JOURNAL_RESULT_CONFLICT');
            return true;
          }
          if (!owned.has(key.turnId)) fail('TURN_JOURNAL_NOT_OWNED');
          const changed = finish.run(receipt.json, hash(receipt.json), Date.now(), key.actorId, key.turnId, key.fingerprint);
          if (changed.changes !== 1) fail('TURN_JOURNAL_STORAGE_ERROR');
          return true;
        });
        if (success) owned.delete(key.turnId);
        return success;
      },
    });
  }
  return Object.freeze({forActor,
    close() {
      if (state.inTransaction) fail('TURN_JOURNAL_REENTRANT');
      // Detach only: no SQL, COMMIT, ROLLBACK, checkpoint, policy change or DB close.
      closed = true;
    },
  });
}
