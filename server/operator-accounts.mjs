import { randomBytes, randomUUID, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { BOOTSTRAP_KEY, createAccessGate } from './access-gate.mjs';

const passwordHash = promisify(scrypt);
const publicConfig = Object.freeze({ mode: 'public', registrationMode: 'disabled' });
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['name', 'username', 'password'].includes(key))) fail('INVALID_ACCOUNT', 'Supply only name, username and password');
  const { name, username, password } = input;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 40 || /[\u0000-\u001f\u007f]/.test(name)) fail('INVALID_NAME', 'Display name must be 1–40 characters with no control characters');
  if (typeof username !== 'string' || !/^[a-z0-9_]{3,32}$/.test(username)) fail('INVALID_USERNAME', 'Username must be 3–32 lowercase letters, digits or underscores');
  // Login currently trims text inputs. Refuse ambiguous surrounding whitespace
  // here rather than provision a password the current login cannot reproduce.
  if (typeof password !== 'string' || password.length < 16 || password.length > 256 || password !== password.trim() || /[\u0000-\u001f\u007f]/.test(password)) fail('INVALID_PASSWORD', 'Use a unique 16–256 character password without outer whitespace or control characters');
  return { name: name.trim(), username, password };
}

async function prepare(input) {
  const validated = validate(input);
  const salt = randomBytes(16).toString('hex');
  const hash = await passwordHash(validated.password, salt, 64);
  return { id: randomUUID(), name: validated.name, username: validated.username, salt, hash: hash.toString('hex') };
}

function insertAccount(store, account) {
  if (store.get('SELECT 1 FROM accounts WHERE username=?', account.username)) fail('USERNAME_TAKEN', 'That username is already provisioned');
  // Do not call createUser: local-mode first-guest ownership must never be used
  // by the public provisioning path or by later ordinary reviewer accounts.
  store.run('INSERT INTO users(id,name,woka,created_at) VALUES(?,?,?,?)', account.id, account.name, '0', store.now());
  store.run('INSERT INTO accounts(username,user_id,salt,password_hash) VALUES(?,?,?,?)', account.username, account.id, account.salt, account.hash);
}

/** One explicit offline bootstrap, on a new dedicated database only. */
export async function bootstrapOwner(store, input) {
  const account = await prepare(input);
  store.transaction(() => {
    if (store.get('SELECT 1 FROM metadata WHERE key=?', BOOTSTRAP_KEY)) fail('ALREADY_BOOTSTRAPPED', 'Owner bootstrap already completed; it cannot be repeated');
    if (store.get('SELECT 1 FROM users') || store.get('SELECT 1 FROM accounts') || store.get('SELECT 1 FROM sessions')) fail('DATABASE_NOT_FRESH', 'Owner bootstrap requires a new dedicated database with no profiles, accounts or sessions');
    for (const table of ['universes', 'worlds', 'rooms']) {
      if (store.get(`SELECT 1 FROM ${table} WHERE owner_id IS NOT NULL`)) fail('DATABASE_NOT_FRESH', 'Owner bootstrap refuses existing place ownership');
    }
    if (!store.get('SELECT 1 FROM universes')) fail('SEEDS_REQUIRED', 'Initialize the standalone seed hierarchy before owner bootstrap');
    insertAccount(store, account);
    store.run('UPDATE worlds SET owner_id=? WHERE owner_id IS NULL', account.id);
    store.run('UPDATE rooms SET owner_id=? WHERE owner_id IS NULL', account.id);
    store.claimUnowned(account.id);
    store.run('INSERT INTO metadata(key,value) VALUES(?,?)', BOOTSTRAP_KEY, account.id);
    createAccessGate({ store, config: publicConfig }).assertReady();
  });
  return store.user(account.id);
}

/** An ordinary login identity; grants no ownership, role or durable membership. */
export async function addReviewer(store, input) {
  createAccessGate({ store, config: publicConfig }).assertReady();
  const account = await prepare(input);
  store.transaction(() => {
    createAccessGate({ store, config: publicConfig }).assertReady();
    insertAccount(store, account);
  });
  return store.user(account.id);
}
