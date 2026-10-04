import { lstat, realpath, readFile, open, rename, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireGate } from './contracts.mjs';

/** Host-local lock and CAS ledger. No daemon, network endpoint or credentials.
 * A crash leaves the lock directory intact: never steal a stale lock by age/PID.
 * An operator must reconcile the frozen state and any queued jobs before clearing it.
 */
export class HostStore {
  constructor(directory, { uid = process.getuid?.() } = {}) { this.directory = resolve(directory); this.uid = uid; }
  async verifyDirectory() {
    const stat = await lstat(this.directory);
    requireGate(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === this.uid && (stat.mode & 0o777) === 0o700 && await realpath(this.directory) === this.directory, 'UNSAFE_STATE_DIRECTORY');
  }
  async read(name) {
    requireGate(/^[a-z-]+\.json$/.test(name), 'INVALID_LEDGER_NAME');
    const path = join(this.directory, name), stat = await lstat(path);
    requireGate(stat.isFile() && !stat.isSymbolicLink() && stat.uid === this.uid && (stat.mode & 0o777) === 0o600 && stat.size <= 2 * 1024 * 1024, 'UNSAFE_STATE_FILE');
    return JSON.parse(await readFile(path, 'utf8'));
  }
  async write(name, value) {
    requireGate(/^[a-z-]+\.json$/.test(name), 'INVALID_LEDGER_NAME');
    const bytes = JSON.stringify(value) + '\n'; requireGate(Buffer.byteLength(bytes) <= 2 * 1024 * 1024, 'STATE_TOO_LARGE');
    const temporary = join(this.directory, `.write-${randomUUID()}`), path = join(this.directory, name);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
  }
  async withExclusiveLease(applicationId, fn) {
    await this.verifyDirectory();
    const lock = join(this.directory, 'controller.lock');
    try { await mkdir(lock, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') requireGate(false, 'HOST_CONTROLLER_LOCKED'); throw error; }
    const owner = randomUUID();
    const lockFile = await open(join(lock, 'owner'), 'wx', 0o600);
    try { await lockFile.writeFile(owner); await lockFile.sync(); } finally { await lockFile.close(); }
    const lease = { applicationId, owner, assertHeld: async () => {
      await this.verifyDirectory();
      requireGate(await readFile(join(lock, 'owner'), 'utf8') === owner, 'LEASE_LOST');
    } };
    try { return await fn(lease); }
    finally {
      // Never remove a lock we no longer own. If killed, this finally does not run.
      await lease.assertHeld(); await rm(lock, { recursive: true });
      const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    }
  }
  async readState(lease) { await lease.assertHeld(); return this.read('state.json'); }
  async commitState(next, expectedVersion, lease) {
    await lease.assertHeld(); const current = await this.read('state.json');
    requireGate(current.version === expectedVersion && next.version === expectedVersion + 1, 'STATE_CAS_CONFLICT');
    await this.write('state.json', next);
  }
  async journal(entry, lease) { await lease.assertHeld(); await this.write('mutation.json', entry); }
}
