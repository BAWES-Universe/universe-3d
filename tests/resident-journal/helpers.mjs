import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Store} from '../../server/store.mjs';
import {initializeHostTurnJournal, createHostTurnJournal} from '../../server/host-turn-journal.mjs';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const key = {actorId:'actor-one', turnId:'turn-one', fingerprint:digest('synthetic-message')};
export function terminal(overrides = {}) {
  return {status:'completed', text:'Synthetic fixture response.', textTrust:'untrusted-provider-output', toolResults:[],
    usage:{calls:1, reportedCalls:1, promptTokens:11, completionTokens:5, totalTokens:16}, ...overrides};
}
export function tempDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), 'universe-host-journal-'));
  t.after(() => rmSync(directory, {recursive:true, force:true}));
  const filename = join(directory, 'app.sqlite');
  // Run real current app Store migrations once before subprocess races start.
  const store = new Store(filename);
  store.run("INSERT INTO metadata VALUES('host-before-process','old app data survives')");
  store.close();
  return {directory, filename};
}
export function opened(t, options = {}, adapterOptions = {}) {
  const {filename, directory} = options.filename ? options : tempDatabase(t);
  const store = new Store(filename);
  t.after(() => { if (store.db.isOpen) store.close(); });
  // A test fixture may choose its host policy. The borrowed adapter never sets it.
  if (options.busyTimeoutMs !== undefined) store.db.exec(`PRAGMA busy_timeout=${options.busyTimeoutMs}`);
  initializeHostTurnJournal({...options, database:store.db});
  const journal = createHostTurnJournal({...options, database:store.db});
  t.after(() => journal.close());
  return {filename, directory, store, journal, adapter:journal.forActor({actorId:key.actorId, authorize:() => true, ...adapterOptions})};
}
export function throwsCode(assert, callback, code) {
  assert.throws(callback, error => error.code === code && error.message === code);
}
