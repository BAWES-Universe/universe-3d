import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';

const LOOPBACK = new Set(['127.0.0.1', '::1']);
const MODES = ['local', 'public'];
const fail = message => { throw new Error(`Invalid Universe runtime configuration: ${message}`); };

export function parseAuthority(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\s/@?#,\\]/.test(value)) return null;
  let hostname, port;
  if (value.startsWith('[')) {
    const match = value.match(/^\[([0-9a-f:.]+)\](?::([0-9]+))?$/i);
    if (!match || isIP(match[1]) !== 6) return null;
    hostname = `[${match[1].toLowerCase()}]`; port = match[2];
  } else {
    const match = value.match(/^([a-z0-9.-]+)(?::([0-9]+))?$/i);
    if (!match) return null;
    hostname = match[1].toLowerCase(); port = match[2];
    if (hostname.length > 253 || !hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  }
  if (port !== undefined && (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535)) return null;
  return hostname + (port === undefined ? '' : `:${port}`);
}

export function parseOrigin(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== value || !parseAuthority(url.host)) return null;
    return url.origin;
  } catch { return null; }
}

function list(env, key, parser) {
  if (env[key] === undefined) return null;
  const values = String(env[key]).split(',').map(value => value.trim());
  if (!values.length || values.some(value => !parser(value))) fail(`${key} must contain exact comma-separated values; wildcards, paths and empty entries are forbidden`);
  return Object.freeze([...new Set(values.map(parser))]);
}

/** This is an operator configuration contract, never derived from forwarded headers. */
export function readRuntimeConfig(env = process.env, { root = process.cwd() } = {}) {
  const mode = env.UNIVERSE_MODE ?? 'local';
  if (!MODES.includes(mode)) fail('UNIVERSE_MODE must be local or public');
  const isPublic = mode === 'public';
  const host = env.UNIVERSE_BIND_ADDRESS ?? '127.0.0.1';
  if (!isIP(host)) fail('UNIVERSE_BIND_ADDRESS must be an explicit IPv4 or IPv6 address');
  if (isPublic && env.UNIVERSE_BIND_ADDRESS === undefined) fail('public mode requires UNIVERSE_BIND_ADDRESS');
  if (!isPublic && !LOOPBACK.has(host)) fail('non-loopback binding requires public mode');
  const portText = String(env.PORT ?? '4190');
  if (!/^(?:0|[1-9][0-9]{0,4})$/.test(portText) || Number(portText) > 65535) fail('PORT must be an integer from 0 to 65535');
  const port = Number(portText);
  if (isPublic && port === 0) fail('public mode requires a fixed nonzero PORT');
  const allowedHosts = list(env, 'UNIVERSE_ALLOWED_HOSTS', parseAuthority);
  const allowedOrigins = list(env, 'UNIVERSE_ALLOWED_ORIGINS', parseOrigin);
  if (isPublic && (!allowedHosts || !allowedOrigins)) fail('public mode requires UNIVERSE_ALLOWED_HOSTS and UNIVERSE_ALLOWED_ORIGINS');
  if (!!allowedHosts !== !!allowedOrigins) fail('configure both Host and Origin allowlists together');
  if (allowedOrigins && allowedOrigins.some(origin => !allowedHosts.includes(new URL(origin).host))) fail('every allowed Origin must have an exact corresponding allowed Host');
  if (allowedHosts && allowedHosts.some(authority => !allowedOrigins.some(origin => new URL(origin).host === authority))) fail('every allowed Host must have a corresponding allowed Origin');
  if (!isPublic && allowedHosts?.some(authority => !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${authority}`).hostname))) fail('local mode only accepts loopback Host allowlists');
  if (isPublic && allowedOrigins.some(origin => !origin.startsWith('https://'))) fail('public origins must use HTTPS');
  const tlsMode = env.UNIVERSE_TLS_MODE ?? 'local-http';
  const cookieSecure = env.UNIVERSE_COOKIE_SECURE ?? 'socket';
  if (!['local-http', 'external'].includes(tlsMode)) fail('UNIVERSE_TLS_MODE must be local-http or external');
  if (!['socket', 'always'].includes(cookieSecure)) fail('UNIVERSE_COOKIE_SECURE must be socket or always');
  if (isPublic && (tlsMode !== 'external' || cookieSecure !== 'always')) fail('public mode requires explicit UNIVERSE_TLS_MODE=external and UNIVERSE_COOKIE_SECURE=always');
  if (tlsMode === 'external' && cookieSecure !== 'always') fail('external TLS requires Secure cookies unconditionally');
  const registrationMode = env.UNIVERSE_REGISTRATION_MODE ?? (isPublic ? 'disabled' : 'local-open');
  if (!['local-open', 'disabled', 'invite-only', 'open'].includes(registrationMode) || (isPublic && registrationMode === 'local-open')) fail('registration must be disabled, invite-only or open publicly; local-open is local-only');
  const setupFlag = env.UNIVERSE_SETUP_ONLY ?? '0';
  if (!['0', '1'].includes(setupFlag)) fail('UNIVERSE_SETUP_ONLY must be 0 or 1');
  const setupOnly = setupFlag === '1';
  if (setupOnly && registrationMode !== 'open') fail('UNIVERSE_SETUP_ONLY=1 requires UNIVERSE_REGISTRATION_MODE=open');
  const database = env.UNIVERSE_DB ?? resolve(root, 'data/universe.sqlite');
  if (isPublic && (env.UNIVERSE_DB === undefined || !isAbsolute(database) || database === ':memory:')) fail('public mode requires an explicit absolute UNIVERSE_DB path on dedicated persistent storage');
  const imagePhysicalSizeFlag=env.UNIVERSE_IMAGE_PHYSICAL_SIZE_ENABLED??'0';
  if(!['0','1'].includes(imagePhysicalSizeFlag))fail('UNIVERSE_IMAGE_PHYSICAL_SIZE_ENABLED must be 0 or 1');
  const imagePhysicalSizeEnabled=imagePhysicalSizeFlag==='1';
  return Object.freeze({ mode, host, port, database, allowedHosts, allowedOrigins, tlsMode, cookieSecure, registrationMode, setupOnly, imagePhysicalSizeEnabled });
}

function reject(code, message) {
  const error = new Error(message); error.status = 403; error.code = code; throw error;
}

/** Validate the actual Host/Origin only. Forwarded and X-Forwarded-* are deliberately ignored. */
export function createRequestSecurity(config, { listeningPort = () => config.port } = {}) {
  return Object.freeze({
    assertRequest(req) {
      if (req.rawHeaders && req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host').length !== 1) reject('HOST_REJECTED', 'Exactly one Host header is required');
      const authority = parseAuthority(req.headers.host);
      const port = listeningPort();
      const localSuffix = port === 80 ? '' : `:${port}`;
      const hosts = config.allowedHosts ?? ['127.0.0.1', 'localhost', '[::1]'].map(host => host + localSuffix);
      if (!authority || !hosts.includes(authority)) reject('HOST_REJECTED', 'The request Host is not allowed');
      const userDocumentNavigation = req.method === 'GET' &&
        req.headers['sec-fetch-mode'] === 'navigate' &&
        req.headers['sec-fetch-dest'] === 'document' &&
        req.headers['sec-fetch-user'] === '?1';
      const invitationNavigation = userDocumentNavigation &&
        ((config.registrationMode === 'invite-only' && req.url === '/join.html') ||
        (config.registrationMode === 'open' && req.url === '/signup.html'));
      // Only public/open/ready shell documents and generated destination links.
      // Match the raw target, not a normalized pathname: aliases, extra queries
      // and invitation capabilities never acquire this navigation exception.
      const publicEntryNavigation = userDocumentNavigation && config.mode === 'public' &&
        config.registrationMode === 'open' && config.setupOnly === false &&
        typeof req.url === 'string' &&
        /^(?:\/|\/index\.html)(?:\?room=[A-Za-z0-9_-]{1,80}(?:&entry=[a-z0-9][a-z0-9_-]{0,63})?)?(?![\s\S])/.test(req.url);
      if (req.headers['sec-fetch-site'] === 'cross-site' && !invitationNavigation && !publicEntryNavigation) reject('ORIGIN_REJECTED', 'Cross-site requests are not allowed');
      const suppliedOrigin = req.headers.origin;
      const origin = suppliedOrigin === undefined ? null : parseOrigin(suppliedOrigin);
      const origins = config.allowedOrigins ?? [`${req.socket?.encrypted ? 'https' : 'http'}://${authority}`];
      if (suppliedOrigin !== undefined && (!origin || !origins.includes(origin) || new URL(origin).host !== authority)) reject('ORIGIN_REJECTED', 'The request Origin is not allowed');
      if (config.mode === 'public' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !origin) reject('ORIGIN_REQUIRED', 'Public-mode changes require an allowed Origin');
    },
    secureCookie(req) { return config.cookieSecure === 'always' || !!req.socket?.encrypted; },
  });
}
