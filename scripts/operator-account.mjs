import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { Store } from '../server/store.mjs';
import { bootstrapOwner, addReviewer } from '../server/operator-accounts.mjs';
import { seedWorlds } from '../src/worlds.js';

async function readAccount() {
  if (!process.stdin.isTTY) {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 8192) throw new Error('Account input is too large');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Standard input must contain one JSON object with name, username and password'); }
  }
  let hidden = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!hidden) process.stdout.write(chunk, encoding); callback(); } });
  const prompt = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const name = await prompt.question('Display name: ');
    const username = await prompt.question('Username (lowercase): ');
    process.stdout.write('Password (hidden; at least 16 characters): '); hidden = true;
    const password = await prompt.question(''); hidden = false; process.stdout.write('\nConfirm password (hidden): '); hidden = true;
    const confirmation = await prompt.question(''); hidden = false; process.stdout.write('\n');
    if (password !== confirmation) throw new Error('Passwords do not match; nothing was provisioned');
    return { name, username, password };
  } finally { hidden = false; prompt.close(); }
}

let store;
try {
  if (process.argv.length !== 3 || !['bootstrap-owner', 'add-reviewer'].includes(process.argv[2])) throw new Error('Usage: UNIVERSE_DB=/absolute/dedicated/path/universe.sqlite node scripts/operator-account.mjs bootstrap-owner|add-reviewer');
  const database = process.env.UNIVERSE_DB;
  if (!database || !isAbsolute(database)) throw new Error('Set UNIVERSE_DB to the new standalone service’s explicit absolute database path');
  // Owner-only database/sidecar permissions for newly created files. The
  // operator must also keep the volume directory private to the service UID.
  process.umask(0o077);
  const input = await readAccount();
  store = new Store(database, seedWorlds);
  const user = await (process.argv[2] === 'bootstrap-owner' ? bootstrapOwner : addReviewer)(store, input);
  console.log(`Provisioned ${process.argv[2] === 'bootstrap-owner' ? 'initial owner' : 'ordinary reviewer'}: ${user.username}`);
} catch (error) {
  console.error(error.code ? `${error.code}: ${error.message}` : error.message);
  process.exitCode = 1;
} finally { store?.close(); }
