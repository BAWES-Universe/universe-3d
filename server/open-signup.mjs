import { randomBytes, randomUUID, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { validateAppearance } from '../src/avatar-spec.js';
import { readSiteAdmissionBody } from './site-admission.mjs';
import { normalizeEmail, validateAccountPassword } from './account-identity.mjs';
import * as v from './validation.mjs';

const passwordHash = promisify(scrypt);

/** New databases only: open signup never alters a previous account schema. */
export function assertOpenAccountSchema(store) {
  const email = store.all('PRAGMA table_info(accounts)').find(column => column.name === 'email');
  const sql = store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='accounts'")?.sql ?? '';
  const unique = store.all('PRAGMA index_list(accounts)').some(index => {
    if (!index.unique || index.partial) return false;
    const keys = store.all('SELECT * FROM pragma_index_xinfo(?)', index.name).filter(column => column.key);
    return keys.length === 1 && keys[0].name === 'email' && keys[0].coll === 'NOCASE';
  });
  if (!email || email.type.toUpperCase() !== 'TEXT' || email.notnull || !/\bemail\s+TEXT\s+COLLATE\s+NOCASE\b/i.test(sql) || !unique) {
    throw Object.assign(new Error('Open signup requires the new nullable, case-insensitive unique accounts.email schema. Use a fresh dedicated database; no email migration is performed.'), { code: 'OPEN_SIGNUP_SCHEMA_REQUIRED' });
  }
}

export function createOpenSignup({ store, config, setup, session, send, limitSignup, derivePassword = passwordHash }) {
  const enabled = config.registrationMode === 'open';
  if (enabled) assertOpenAccountSchema(store);
  const policy = () => ({ enabled, registrationMode: config.registrationMode, setupOnly: setup.active, maxAccounts: config.maxAccounts });
  function assertCapacity() {
    if (store.get('SELECT COUNT(*) AS count FROM accounts').count >= config.maxAccounts) v.fail(409, 'ACCOUNT_LIMIT_REACHED', 'This site has reached its account limit');
  }
  async function handle({ req, res, path, method, url }) {
    if (path !== '/api/signup') return false;
    if (url.search) v.fail(400, 'QUERY_NOT_ALLOWED', 'Signup does not accept query parameters');
    if (method === 'GET') { send(res, 200, policy()); return true; }
    if (method !== 'POST') v.fail(405, 'METHOD_NOT_ALLOWED', 'Use GET for signup policy or POST with a JSON body');
    if (!enabled) v.fail(403, 'SIGNUP_DISABLED', 'Open signup is disabled');
    setup.assertPending();
    limitSignup(req);
    const previous = session(req, false);
    if (previous&&!store.isPublicGuest(previous.user_id)) v.fail(409, 'SIGNUP_SIGN_OUT_REQUIRED', 'Sign out before creating an account');
    const input = await readSiteAdmissionBody(req);
    if (Object.keys(input).some(key => !['email', 'password', 'name', 'appearance', 'woka'].includes(key))) v.fail(400, 'INVALID_INPUT', 'Unexpected request fields');
    const email = normalizeEmail(input.email), password = validateAccountPassword(input.password);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 40 || /[\u0000-\u001f\u007f]/.test(input.name)) v.fail(400, 'INVALID_NAME', 'Display name must be 1–40 characters with no control characters');
    const woka = input.appearance !== undefined ? JSON.stringify(validateAppearance(input.appearance)) : JSON.stringify(v.integer(input.woka ?? 0, 'woka', 0, 31));
    assertCapacity();
    const salt = randomBytes(16).toString('hex');
    const hash = await derivePassword(password, salt, 64);
    store.transaction(() => {
      setup.assertPending();
      const live=session(req,false);
      if ((live?.token_hash??null)!==(previous?.token_hash??null)||(live?.user_id??null)!==(previous?.user_id??null)) v.fail(409, 'SIGNUP_SESSION_CHANGED', 'Your session changed. Open signup again.');
      if(live&&!store.isPublicGuest(live.user_id))v.fail(409,'SIGNUP_SIGN_OUT_REQUIRED','Sign out before creating an account');
      assertCapacity();
      if (store.get('SELECT 1 FROM accounts WHERE email=?', email)) v.fail(409, 'EMAIL_TAKEN', 'That email already has an account. Sign in instead.');
      const id = randomUUID(), username = `u_${randomBytes(12).toString('hex')}`;
      // Deliberately bypass Store.createUser and its local seed-claim behavior.
      store.run('INSERT INTO users(id,name,woka,created_at) VALUES(?,?,?,?)', id, input.name.trim(), woka, store.now());
      store.run('INSERT INTO accounts(username,email,user_id,salt,password_hash) VALUES(?,?,?,?,?)', username, email, id, salt, hash.toString('hex'));
      setup.recordAccount(id);
    });
    send(res, 201, { created: true, loginRequired: true });
    return true;
  }
  return Object.freeze({ handle, policy });
}
