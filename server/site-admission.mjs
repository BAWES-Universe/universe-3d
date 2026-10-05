import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { BOOTSTRAP_KEY } from './access-gate.mjs';
import { validateSiteAdmissionConfig } from './site-admission-config.mjs';
import * as v from './validation.mjs';
import { validateAccountPassword } from './account-identity.mjs';

const passwordHash = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const credentialBinding = account => digest(`${account.salt}:${account.password_hash}`);
const MAX_BODY_BYTES = 8192;
const BODY_TIMEOUT_MS = 10000;
const MAX_RATE_BUCKETS = 1024;
const WINDOW_MS = 60000;
const retry = (code, message, seconds = 60) => { const error = new v.HttpError(429, code, message); error.retryAfter = seconds; throw error; };
const unavailable = () => v.fail(410, 'INVITE_UNAVAILABLE', 'This site invite is unavailable. Ask the site owner for a new link.');

function secret(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, 'base64url').toString('base64url') !== value) {
    v.fail(400, 'INVALID_INPUT', `Supply a valid ${label}`);
  }
  return value;
}
function only(input, allowed) {
  v.record(input);
  if (Object.keys(input).some(key => !allowed.includes(key))) v.fail(400, 'INVALID_INPUT', 'Unexpected request fields');
  return input;
}
function accountInput(input) {
  only(input, ['token', 'clientOperationId', 'name', 'username', 'password', 'woka']);
  const token = secret(input.token, 'site invite'), operation = secret(input.clientOperationId, 'client operation ID');
  const { name, username, password } = input;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 40 || /[\u0000-\u001f\u007f]/.test(name)) v.fail(400, 'INVALID_NAME', 'Display name must be 1–40 characters with no control characters');
  if (typeof username !== 'string' || !/^[a-z0-9_]{3,32}$/.test(username)) v.fail(400, 'INVALID_USERNAME', 'Use 3–32 lowercase letters, numbers or underscores');
  validateAccountPassword(password);
  // Signup starts with an ordinary catalog avatar. Rich appearance edits happen
  // after authentication and cannot smuggle authority into account creation.
  const woka = v.integer(input.woka ?? 0, 'woka', 0, 31);
  return { tokenHash: digest(token), operationHash: digest(operation), name: name.trim(), username, password, woka: JSON.stringify(woka) };
}
export async function readSiteAdmissionBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) v.fail(415, 'JSON_REQUIRED', 'Use Content-Type: application/json');
  if (req.headers['content-length'] !== undefined && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > MAX_BODY_BYTES)) v.fail(413, 'TOO_LARGE', 'Request is too large');
  const encoded = await new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const cleanup = () => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); };
    const error = cause => { cleanup(); req.once('error', () => {}); reject(cause?.status ? cause : new v.HttpError(400, 'INVALID_REQUEST', 'The request could not be read')); };
    const aborted = () => error(new v.HttpError(400, 'INVALID_REQUEST', 'The request was interrupted'));
    const data = chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { error(new v.HttpError(413, 'TOO_LARGE', 'Request is too large')); req.resume(); }
      else chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); };
    const timer = setTimeout(() => {
      error(new v.HttpError(408, 'REQUEST_TIMEOUT', 'The signup request took too long'));
      req.resume();
    }, BODY_TIMEOUT_MS);
    timer.unref?.();
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted);
  });
  try { return v.record(JSON.parse(encoded)); }
  catch (error) { if (error.status) throw error; v.fail(400, 'INVALID_JSON', 'The request body is not valid JSON'); }
}

/** Additive migration: existing world invitation tables and their meaning stay untouched. */
export function migrateSiteAdmission(store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS site_admission_invites (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL REFERENCES users(id),
      create_operation_hash TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      redeemed_at INTEGER,
      redeemed_user_id TEXT REFERENCES users(id),
      redeem_operation_hash TEXT,
      redeemed_username TEXT,
      redeem_credential_binding TEXT,
      UNIQUE(created_by, create_operation_hash),
      CHECK ((redeemed_at IS NULL AND redeemed_user_id IS NULL AND redeem_operation_hash IS NULL AND redeemed_username IS NULL AND redeem_credential_binding IS NULL)
        OR (redeemed_at IS NOT NULL AND redeemed_user_id IS NOT NULL AND redeem_operation_hash IS NOT NULL AND redeemed_username IS NOT NULL AND redeem_credential_binding IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS site_admission_audit (
      id TEXT PRIMARY KEY,
      invite_id TEXT NOT NULL REFERENCES site_admission_invites(id),
      event TEXT NOT NULL CHECK(event IN ('created', 'revoked', 'redeemed')),
      actor_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      UNIQUE(invite_id, event)
    );
    CREATE INDEX IF NOT EXISTS site_admission_created ON site_admission_invites(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS site_admission_active ON site_admission_invites(created_by, expires_at)
      WHERE revoked_at IS NULL AND redeemed_at IS NULL;
  `);
}

/** All request routes must run after the application's Host/Origin security gate. */
export function createSiteAdmission({ store, config = {}, now = Date.now, session, send, derivePassword = passwordHash }) {
  config = validateSiteAdmissionConfig(config);
  migrateSiteAdmission(store);
  const rates = new Map();
  let inFlightHashes = 0;

  function audit(event, inviteId, actorId) {
    store.run('INSERT INTO site_admission_audit(id,invite_id,event,actor_id,created_at) VALUES(?,?,?,?,?)', randomUUID(), inviteId, event, actorId, now());
  }
  function ownerId() {
    const id = store.get('SELECT value FROM metadata WHERE key=?', BOOTSTRAP_KEY)?.value;
    return id && store.get('SELECT 1 FROM accounts WHERE user_id=?', id) ? id : null;
  }
  function isSiteOwner(userId) { return !!userId && userId === ownerId(); }
  function assertEnabled() {
    if (!config.enabled) v.fail(403, 'SITE_ADMISSION_DISABLED', 'Site invite signup is disabled');
  }
  function assertOwner(req, expected) {
    assertEnabled();
    const live = session(req);
    if (expected && (live.token_hash !== expected.token_hash || live.user_id !== expected.user_id)) v.fail(401, 'AUTH_REQUIRED', 'Sign in again');
    if (!isSiteOwner(live.user_id)) v.fail(403, 'SITE_OWNER_REQUIRED', 'Only the bootstrapped site owner can manage site invites');
    return live;
  }
  function publicPolicy(s) {
    return { enabled: config.enabled, canManage: config.enabled && isSiteOwner(s?.user_id), inviteTtlMs: config.inviteTtlMs, maxActiveInvites: config.maxActiveInvites, maxAccounts: config.maxAccounts };
  }
  function limit(req, kind, maximum, inviteId = null) {
    const time = now();
    // Bounded memory and one global ceiling supplement the direct socket bucket.
    // Forwarded headers and submitted tokens never create trusted client identities.
    for (const [key, bucket] of rates) if (time >= bucket.start + WINDOW_MS) rates.delete(key);
    const keys = inviteId ? [`invite:${kind}:${inviteId}`] : [`global:${kind}`, `${kind}:${digest(String(req.socket?.remoteAddress ?? 'unknown'))}`];
    for (const [index, key] of keys.entries()) {
      let bucket = rates.get(key);
      if (!bucket) {
        if (rates.size >= MAX_RATE_BUCKETS) retry('RATE_LIMITED', 'Please slow down and try again shortly');
        bucket = { start: time, count: 0 }; rates.set(key, bucket);
      }
      if (++bucket.count > (!inviteId && index === 0 ? maximum * 10 : maximum)) retry('RATE_LIMITED', 'Please slow down and try again shortly');
    }
  }
  function accountCount() { return store.get('SELECT COUNT(*) AS count FROM accounts').count; }
  function assertCapacity() {
    if (accountCount() >= config.maxAccounts) v.fail(409, 'ACCOUNT_LIMIT_REACHED', 'This site has reached its account limit');
  }
  function activeCount() {
    return store.get('SELECT COUNT(*) AS count FROM site_admission_invites WHERE revoked_at IS NULL AND redeemed_at IS NULL AND expires_at>?', now()).count;
  }
  function safeInvite(row) {
    return { id: row.id, label: row.label, createdAt: row.created_at, expiresAt: row.expires_at, status: row.revoked_at !== null ? 'revoked' : row.redeemed_at !== null ? 'redeemed' : row.expires_at <= now() ? 'expired' : row.created_by !== ownerId() ? 'unavailable' : 'active', revokedAt: row.revoked_at, redeemedAt: row.redeemed_at };
  }
  function available(row, allowRedeemed = false) {
    assertEnabled();
    if (!row || row.revoked_at !== null || row.expires_at <= now() || row.created_by !== ownerId() || (!allowRedeemed && row.redeemed_at !== null)) unavailable();
    return row;
  }
  function findInvite(hash, allowRedeemed = false) {
    return available(store.get('SELECT * FROM site_admission_invites WHERE token_hash=?', hash), allowRedeemed);
  }
  function assertSessionFence(req, previous) {
    const live = session(req, false);
    if ((live?.token_hash ?? null) !== (previous?.token_hash ?? null) || (live?.user_id ?? null) !== (previous?.user_id ?? null)) v.fail(409, 'SIGNUP_SESSION_CHANGED', 'Your session changed. Open signup again.');
    return live;
  }
  function assertSignupSession(s) {
    if (s) v.fail(409, 'SIGNUP_SIGN_OUT_REQUIRED', 'Sign out before creating an account');
  }
  function receiptAccount(row, input) {
    if (row.redeem_operation_hash !== input.operationHash || row.redeemed_username !== input.username) unavailable();
    const account = store.get('SELECT * FROM accounts WHERE user_id=?', row.redeemed_user_id);
    if (!account || account.username !== row.redeemed_username || credentialBinding(account) !== row.redeem_credential_binding) unavailable();
    return account;
  }
  async function redeem(req, input, previous) {
    const first = findInvite(input.tokenHash, true);
    assertSignupSession(previous);
    limit(req, 'redeem', config.redeemPerMinute, first.id);
    if (first.redeemed_at === null) assertCapacity();
    // Reject immediately instead of maintaining an unbounded queue of passwords.
    if (inFlightHashes >= config.maxConcurrentHashes) retry('SIGNUP_BUSY', 'Signup is busy. Please try again shortly.', 1);
    inFlightHashes++;
    try {
      const known = first.redeemed_at !== null ? receiptAccount(first, input) : null;
      const salt = known?.salt ?? randomBytes(16).toString('hex');
      let derived = await derivePassword(input.password, salt, 64);
      let row = findInvite(input.tokenHash, true);
      let live = assertSessionFence(req, previous);
      assertSignupSession(live);
      // A concurrent request may have committed while this request derived its
      // candidate credential. Prove the committed credential before any replay.
      if (row.redeemed_at !== null) {
        const account = receiptAccount(row, input);
        if (account.salt !== salt) derived = await derivePassword(input.password, account.salt, 64);
        return store.transaction(() => {
          row = findInvite(input.tokenHash, true);
          const current = receiptAccount(row, input);
          live = assertSessionFence(req, previous);
          assertSignupSession(live);
          if (current.salt !== account.salt || current.password_hash !== account.password_hash || !timingSafeEqual(Buffer.from(current.password_hash, 'hex'), derived)) unavailable();
          return { created: true, username: current.username, duplicate: true, loginRequired: true };
        });
      }
      return store.transaction(() => {
        row = findInvite(input.tokenHash);
        live = assertSessionFence(req, previous);
        assertSignupSession(live);
        assertCapacity();
        if (store.get('SELECT 1 FROM accounts WHERE username=?', input.username)) v.fail(409, 'USERNAME_TAKEN', 'That username is already used');
        const userId = randomUUID();
        // Never use createUser: its local-mode seed ownership is not admission.
        store.run('INSERT INTO users(id,name,woka,created_at) VALUES(?,?,?,?)', userId, input.name, input.woka, now());
        store.run('INSERT INTO accounts(username,user_id,salt,password_hash) VALUES(?,?,?,?)', input.username, userId, salt, derived.toString('hex'));
        store.run('UPDATE site_admission_invites SET redeemed_at=?,redeemed_user_id=?,redeem_operation_hash=?,redeemed_username=?,redeem_credential_binding=? WHERE id=?', now(), userId, input.operationHash, input.username, credentialBinding({ salt, password_hash: derived.toString('hex') }), row.id);
        audit('redeemed', row.id, userId);
        return { created: true, username: input.username, duplicate: false, loginRequired: true };
      });
    } finally { inFlightHashes--; }
  }

  async function handle({ req, res, path, method, url }) {
    const revoke = path.match(/^\/api\/site-invites\/([A-Za-z0-9_-]{1,80})\/revoke$/);
    const management = path === '/api/site-invites' || !!revoke;
    const admission = ['/api/site-admission/check', '/api/site-admission/redeem'].includes(path);
    if (!management && !admission) return false;
    // Bearer links are fragment-only. Only owner-list pagination accepts query
    // parameters; a token in the query is rejected even beside a valid body.
    const query = (url ?? new URL(req.url, 'http://127.0.0.1')).searchParams;
    const listing = path === '/api/site-invites' && method === 'GET';
    if ([...query.keys()].some(key => !listing || !['limit', 'cursor'].includes(key) || query.getAll(key).length !== 1)) v.fail(400, 'QUERY_NOT_ALLOWED', 'Only owner list pagination may use query parameters');
    assertEnabled();
    if (management) {
      const owner = assertOwner(req);
      limit(req, 'owner', config.ownerPerMinute);
      if (path === '/api/site-invites' && method === 'GET') {
        const requestedLimit = query.get('limit') ?? '50';
        if (!/^[1-9][0-9]{0,2}$/.test(requestedLimit) || Number(requestedLimit) > 100) v.fail(400, 'INVALID_PAGINATION', 'Choose a page size from 1 to 100');
        const size = Number(requestedLimit), cursor = query.get('cursor');
        let rows;
        if (cursor !== null) {
          const match = /^([0-9]{1,16})_([A-Za-z0-9_-]{1,80})$/.exec(cursor);
          if (!match || !Number.isSafeInteger(Number(match[1]))) v.fail(400, 'INVALID_PAGINATION', 'Use the supplied next cursor');
          rows = store.all('SELECT * FROM site_admission_invites WHERE created_at<? OR (created_at=? AND id<?) ORDER BY created_at DESC, id DESC LIMIT ?', Number(match[1]), Number(match[1]), match[2], size + 1);
        } else rows = store.all('SELECT * FROM site_admission_invites ORDER BY created_at DESC, id DESC LIMIT ?', size + 1);
        const hasMore = rows.length > size; rows = rows.slice(0, size); const last = rows.at(-1);
        send(res, 200, { invites: rows.map(safeInvite), activeInvites: activeCount(), accountCount: accountCount(), maxActiveInvites: config.maxActiveInvites, maxAccounts: config.maxAccounts, hasMore, nextCursor: hasMore && last ? `${last.created_at}_${last.id}` : null });
        return true;
      }
      if (method !== 'POST') v.fail(405, 'METHOD_NOT_ALLOWED', 'Use the documented site invite method');
      const body = await readSiteAdmissionBody(req);
      if (revoke) {
        only(body, ['clientOperationId']);
        if (body.clientOperationId !== undefined) secret(body.clientOperationId, 'client operation ID');
        const result = store.transaction(() => {
          assertOwner(req, owner);
          const row = store.get('SELECT * FROM site_admission_invites WHERE id=?', revoke[1]);
          if (!row) v.fail(404, 'INVITE_NOT_FOUND', 'Site invite not found');
          const duplicate = row.revoked_at !== null;
          if (!duplicate) {
            store.run('UPDATE site_admission_invites SET revoked_at=? WHERE id=?', now(), row.id);
            audit('revoked', row.id, owner.user_id);
          }
          return { invite: safeInvite(store.get('SELECT * FROM site_admission_invites WHERE id=?', row.id)), duplicate };
        });
        send(res, 200, result); return true;
      }
      only(body, ['clientOperationId', 'label', 'expiresInMs']);
      const label = body.label === undefined ? '' : v.text(body.label, 'label', 80, { empty: true });
      const lifetime = body.expiresInMs === undefined ? config.inviteTtlMs : v.integer(body.expiresInMs, 'expiresInMs', 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
      const operationHash = digest(secret(body.clientOperationId, 'client operation ID'));
      const result = store.transaction(() => {
        assertOwner(req, owner);
        const existing = store.get('SELECT * FROM site_admission_invites WHERE created_by=? AND create_operation_hash=?', owner.user_id, operationHash);
        if (existing) {
          if (existing.label !== label || existing.expires_at - existing.created_at !== lifetime) v.fail(409, 'CLIENT_OPERATION_CONFLICT', 'This operation was already used for a different invite request');
          return { invite: safeInvite(existing), duplicate: true, linkRecoverable: false, message: 'This link was shown only once. Revoke this invite and create another if you did not save it.' };
        }
        assertCapacity();
        if (store.get('SELECT COUNT(*) AS count FROM site_admission_invites').count >= config.maxInviteRecords) v.fail(409, 'INVITE_HISTORY_LIMIT_REACHED', 'Site invite history is full. Ask the operator to review storage capacity.');
        if (activeCount() >= config.maxActiveInvites) v.fail(409, 'ACTIVE_INVITE_LIMIT_REACHED', 'Revoke or wait for an active invite before creating another');
        const token = randomBytes(32).toString('base64url'), id = randomUUID(), time = now();
        store.run('INSERT INTO site_admission_invites(id,token_hash,created_by,create_operation_hash,label,created_at,expires_at) VALUES(?,?,?,?,?,?,?)', id, digest(token), owner.user_id, operationHash, label, time, time + lifetime);
        audit('created', id, owner.user_id);
        return { invite: safeInvite(store.get('SELECT * FROM site_admission_invites WHERE id=?', id)), token, duplicate: false, linkRecoverable: true };
      });
      send(res, result.duplicate ? 200 : 201, result); return true;
    }
    if (method !== 'POST') v.fail(405, 'METHOD_NOT_ALLOWED', 'Use POST with a JSON body');
    const checking = path.endsWith('/check');
    limit(req, checking ? 'check' : 'redeem', checking ? config.checkPerMinute : config.redeemPerMinute);
    const previous = session(req, false);
    const body = await readSiteAdmissionBody(req);
    assertSessionFence(req, previous);
    if (checking) {
      only(body, ['token']);
      const row = findInvite(digest(secret(body.token, 'site invite')));
      limit(req, 'check', config.checkPerMinute, row.id);
      assertCapacity();
      send(res, 200, { valid: true, expiresAt: row.expires_at }); return true;
    }
    const result = await redeem(req, accountInput(body), previous);
    send(res, result.duplicate ? 200 : 201, result);
    return true;
  }
  return Object.freeze({ handle, publicPolicy, isSiteOwner, limitSignup: req => limit(req, 'open-signup', config.redeemPerMinute) });
}
