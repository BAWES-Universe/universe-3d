import { randomUUID, createHash } from 'node:crypto';
import { BOOTSTRAP_KEY, createAccessGate } from './access-gate.mjs';
import { assertOpenAccountSchema } from './open-signup.mjs';

export const SETUP_KEY = 'open-signup-setup-v1';
export const PROMOTION_AUDIT_KEY = 'operator-promotion-audit-v1';
const candidateKey = id => `setup-account-v1:${id}`;
const fail = (code, message) => { throw Object.assign(new Error(message), { status: 503, code }); };
const staticPaths = new Set(['/signup.html', '/signup.js', '/signup.css', '/site-admission.css', '/universe-tokens.css', '/assets/bawes-universe-logo.png', '/assets/space-grotesk.ttf', '/assets/inter-variable.ttf']);
const apiMethods = new Map([
  ['/api/signup', new Set(['GET', 'POST'])], ['/api/login', new Set(['POST'])],
  ['/api/setup/me', new Set(['GET'])], ['/api/access', new Set(['GET'])], ['/api/health', new Set(['GET'])],
]);
function state(store) {
  const raw = store.get('SELECT value FROM metadata WHERE key=?', SETUP_KEY)?.value;
  if (!raw) return null;
  try { const value = JSON.parse(raw); if (!['pending', 'initialized'].includes(value.state)) throw Error(); return value; }
  catch { fail('SETUP_STATE_INVALID', 'Setup state is invalid; inspect the dedicated database offline'); }
}
function hierarchyFingerprint(store) {
  return createHash('sha256').update(JSON.stringify([
    store.all('SELECT id FROM universes ORDER BY id'),
    store.all('SELECT id,universe_id FROM worlds ORDER BY id'),
    store.all('SELECT id,world_id FROM rooms ORDER BY id'),
  ])).digest('hex');
}
function assertUnowned(store) {
  for (const table of ['universes', 'worlds', 'rooms']) if (store.get(`SELECT 1 FROM ${table} WHERE owner_id IS NOT NULL`)) fail('SETUP_DATABASE_NOT_FRESH', 'Setup refuses existing place ownership');
  for (const table of ['members', 'world_members']) if (store.get(`SELECT 1 FROM ${table}`)) fail('SETUP_DATABASE_NOT_FRESH', 'Setup refuses existing membership grants');
}
function assertPending(store, expected) {
  const current = state(store);
  if (!current || current.state !== 'pending' || current.id !== expected?.id || store.get('SELECT 1 FROM metadata WHERE key=?', BOOTSTRAP_KEY)) fail('SETUP_ALREADY_INITIALIZED', 'Setup is finished or unavailable. Restart with UNIVERSE_SETUP_ONLY=0 after owner promotion.');
  if (current.hierarchy !== hierarchyFingerprint(store)) fail('SETUP_CONTEXT_CHANGED', 'The setup seed hierarchy changed; inspect the dedicated database offline');
  assertUnowned(store);
  return current;
}

/** Persist eligibility before the first browser account; never reopen it later. */
export function createSetupMode({ store, config, accessGate }) {
  const active = config.setupOnly === true;
  let pending;
  store.transaction(() => {
    const previous = state(store);
    if (active) {
      if (config.registrationMode !== 'open') fail('SETUP_OPEN_REQUIRED', 'Setup requires explicit open registration');
      assertOpenAccountSchema(store);
      if (previous) { pending = assertPending(store, previous); return; }
      if (store.get('SELECT 1 FROM metadata WHERE key=?', BOOTSTRAP_KEY) || store.get('SELECT 1 FROM users') || store.get('SELECT 1 FROM accounts') || store.get('SELECT 1 FROM sessions')) fail('SETUP_DATABASE_NOT_FRESH', 'Setup requires a genuinely fresh database with no profiles, accounts, sessions or prior initialization');
      assertUnowned(store);
      pending = { state: 'pending', id: randomUUID(), hierarchy: hierarchyFingerprint(store), startedAt: store.now() };
      store.run('INSERT INTO metadata(key,value) VALUES(?,?)', SETUP_KEY, JSON.stringify(pending));
    } else {
      if (previous?.state === 'pending') fail('SETUP_PENDING', 'This database is awaiting owner promotion. Continue with UNIVERSE_SETUP_ONLY=1.');
      accessGate.assertReady();
      if (!previous) store.run('INSERT INTO metadata(key,value) VALUES(?,?)', SETUP_KEY, JSON.stringify({ state: 'initialized', initializedAt: store.now() }));
    }
  });
  return Object.freeze({
    active,
    assertPending() { if (active) assertPending(store, pending); },
    assertReady() { if (active) assertPending(store, pending); else accessGate.assertReady(); },
    recordAccount(id) { if (active) { assertPending(store, pending); store.run('INSERT INTO metadata(key,value) VALUES(?,?)', candidateKey(id), pending.id); } },
    assertRequest(req, path, url) {
      if (!active) return;
      const allowed = (staticPaths.has(path) && ['GET', 'HEAD'].includes(req.method)) || apiMethods.get(path)?.has(req.method);
      if (!allowed || url.search || req.url.split('?')[0] !== path) fail('SETUP_ONLY', 'Owner setup is pending. Use /signup.html to create an account and sign in.');
    },
  });
}

/** Operator-selected immutable ID only; no credential creation or account lookup by email. */
export function promoteSetupOwner(store, accountId) {
  if (typeof accountId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(accountId)) fail('INVALID_ACCOUNT_ID', 'Supply the exact immutable account ID shown after signing in');
  assertOpenAccountSchema(store);
  store.transaction(() => {
    const pending = assertPending(store, state(store));
    const account = store.get('SELECT user_id FROM accounts WHERE user_id=? AND email IS NOT NULL', accountId);
    if (!account || store.get('SELECT value FROM metadata WHERE key=?', candidateKey(accountId))?.value !== pending.id) fail('SETUP_ACCOUNT_REQUIRED', 'That ID is not an account created in this pending setup');
    if (!store.get('SELECT 1 FROM universes') || !store.get('SELECT 1 FROM worlds') || !store.get('SELECT 1 FROM rooms')) fail('SEEDS_REQUIRED', 'Owner promotion requires the standalone seed hierarchy');
    store.run('UPDATE worlds SET owner_id=? WHERE owner_id IS NULL', accountId);
    store.run('UPDATE rooms SET owner_id=? WHERE owner_id IS NULL', accountId);
    store.claimUnowned(accountId);
    for (const room of store.all('SELECT id FROM rooms')) store.run("INSERT INTO members(room_id,user_id,role,granted) VALUES(?,?,'owner',1)", room.id, accountId);
    store.run('INSERT INTO metadata(key,value) VALUES(?,?)', BOOTSTRAP_KEY, accountId);
    const time = store.now();
    store.run('INSERT INTO metadata(key,value) VALUES(?,?)', PROMOTION_AUDIT_KEY, JSON.stringify({ event: 'setup-owner-promoted', accountId, at: time }));
    store.run('UPDATE metadata SET value=? WHERE key=?', JSON.stringify({ state: 'initialized', initializedAt: time }), SETUP_KEY);
    createAccessGate({ store, config: { mode: 'public', registrationMode: 'open' } }).assertReady();
    for (const table of ['universes', 'worlds', 'rooms']) if (store.get(`SELECT 1 FROM ${table} WHERE owner_id IS NULL OR owner_id!=?`, accountId)) fail('PROMOTION_INCOMPLETE', 'Seed ownership readiness check failed');
    if (store.get("SELECT 1 FROM worlds w LEFT JOIN world_members m ON m.world_id=w.id AND m.user_id=? WHERE m.role IS NULL OR m.role!='admin'", accountId) || store.get("SELECT 1 FROM rooms r LEFT JOIN members m ON m.room_id=r.id AND m.user_id=? WHERE m.role IS NULL OR m.role!='owner'", accountId)) fail('PROMOTION_INCOMPLETE', 'Owner membership readiness check failed');
  });
  return { accountId, promoted: true };
}
