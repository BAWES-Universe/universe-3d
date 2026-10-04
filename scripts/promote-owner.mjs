import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { Store } from '../server/store.mjs';
import { promoteSetupOwner } from '../server/setup-mode.mjs';

let store;
try {
  if (process.argv.length !== 3) throw new Error('Usage: UNIVERSE_DB=/absolute/existing/database.sqlite node scripts/promote-owner.mjs EXACT_ACCOUNT_ID');
  const database = process.env.UNIVERSE_DB;
  if (!database || !isAbsolute(database) || !statSync(database).isFile()) throw new Error('UNIVERSE_DB must name the existing dedicated setup database');
  process.umask(0o077);
  store = new Store(database, [], Date.now, { claimUnownedOnCreate: false });
  const result = promoteSetupOwner(store, process.argv[2]);
  console.log(`Promoted initial owner account ID: ${result.accountId}. Restart with UNIVERSE_SETUP_ONLY=0.`);
} catch (error) {
  console.error(error.code ? `${error.code}: ${error.message}` : error.message);
  process.exitCode = 1;
} finally { store?.close(); }
