import test from 'node:test';
import assert from 'node:assert/strict';
import { readRuntimeConfig, createRequestSecurity, parseAuthority, parseOrigin } from '../server/runtime-config.mjs';

const publicEnv = overrides => ({
  UNIVERSE_MODE: 'public', UNIVERSE_BIND_ADDRESS: '0.0.0.0', PORT: '4190',
  UNIVERSE_DB: '/synthetic-preview/universe.sqlite',
  UNIVERSE_ALLOWED_HOSTS: 'preview.example.test', UNIVERSE_ALLOWED_ORIGINS: 'https://preview.example.test',
  UNIVERSE_TLS_MODE: 'external', UNIVERSE_COOKIE_SECURE: 'always', ...overrides,
});
const request = (headers = {}, extra = {}) => ({ headers: { host: 'preview.example.test', ...headers }, method: 'GET', socket: {}, ...extra });
const rejected = (callback, code) => assert.throws(callback, error => error.status === 403 && error.code === code);

test('local defaults bind loopback with port-exact DNS-rebinding protection', () => {
  const config = readRuntimeConfig({}, { root: '/synthetic-app' });
  assert.equal(config.mode, 'local'); assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, '/synthetic-app/data/universe.sqlite');
  assert.equal(config.registrationMode, 'local-open');
  const security = createRequestSecurity(config, { listeningPort: () => 51234 });
  for (const host of ['localhost:51234', '127.0.0.1:51234', '[::1]:51234']) security.assertRequest(request({ host }, { method: 'POST' }));
  for (const host of ['localhost', '127.0.0.1:4190', '[::2]:51234', '[evil]:51234', 'evil.test:51234', '127.0.0.1.evil.test:51234', '127.0.0.1:51234@evil.test', 'localhost.:51234']) rejected(() => security.assertRequest(request({ host })), 'HOST_REJECTED');
  security.assertRequest(request({ host: 'localhost:51234', origin: 'http://localhost:51234' }, { method: 'POST' }));
  rejected(() => security.assertRequest(request({ host: 'localhost:51234', origin: 'https://localhost:51234' })), 'ORIGIN_REJECTED');
  assert.equal(security.secureCookie(request({ 'x-forwarded-proto': 'https' })), false);
  assert.equal(security.secureCookie(request({}, { socket: { encrypted: true } })), true);
});

test('public configuration fails closed on every missing security requirement', () => {
  const config = readRuntimeConfig(publicEnv());
  assert.equal(config.registrationMode, 'disabled'); assert.equal(config.cookieSecure, 'always');
  for (const key of ['UNIVERSE_BIND_ADDRESS', 'UNIVERSE_DB', 'UNIVERSE_ALLOWED_HOSTS', 'UNIVERSE_ALLOWED_ORIGINS', 'UNIVERSE_TLS_MODE', 'UNIVERSE_COOKIE_SECURE']) {
    const env = publicEnv(); delete env[key]; assert.throws(() => readRuntimeConfig(env), /Invalid Universe runtime configuration/, key);
  }
  for (const overrides of [
    { UNIVERSE_MODE: 'production' }, { UNIVERSE_BIND_ADDRESS: 'localhost' },
    { PORT: '0' }, { PORT: '4190.5' }, { PORT: '65536' },
    { UNIVERSE_DB: ':memory:' }, { UNIVERSE_DB: './shared.sqlite' },
    { UNIVERSE_ALLOWED_HOSTS: '*.example.test' }, { UNIVERSE_ALLOWED_HOSTS: 'preview.example.test,' },
    { UNIVERSE_ALLOWED_HOSTS: 'https://preview.example.test' },
    { UNIVERSE_ALLOWED_ORIGINS: 'http://preview.example.test' },
    { UNIVERSE_ALLOWED_ORIGINS: 'https://preview.example.test/' },
    { UNIVERSE_ALLOWED_ORIGINS: 'https://preview.example.test/path' },
    { UNIVERSE_ALLOWED_ORIGINS: 'https://preview.example.test.evil.test' },
    { UNIVERSE_ALLOWED_ORIGINS: 'null' }, { UNIVERSE_COOKIE_SECURE: 'false' },
    { UNIVERSE_TLS_MODE: 'forwarded' }, { UNIVERSE_REGISTRATION_MODE: 'local-open' },
    { UNIVERSE_REGISTRATION_MODE: 'invite' },
  ]) assert.throws(() => readRuntimeConfig(publicEnv(overrides)), /Invalid Universe runtime configuration/, JSON.stringify(overrides));
  assert.throws(() => readRuntimeConfig({ UNIVERSE_BIND_ADDRESS: '0.0.0.0' }), /public mode/);
  assert.throws(() => readRuntimeConfig({ UNIVERSE_ALLOWED_HOSTS: 'preview.example.test', UNIVERSE_ALLOWED_ORIGINS: 'https://preview.example.test' }), /loopback Host/);
  assert.throws(() => readRuntimeConfig({ UNIVERSE_ALLOWED_HOSTS: 'localhost:4190' }), /both Host and Origin/);
});

test('invite-only is opt-in and permits only the exact user-activated landing navigation', () => {
  const config=readRuntimeConfig(publicEnv({UNIVERSE_REGISTRATION_MODE:'invite-only'}));
  assert.equal(config.registrationMode,'invite-only');
  assert.equal(readRuntimeConfig({UNIVERSE_REGISTRATION_MODE:'invite-only'}).registrationMode,'invite-only');
  const security=createRequestSecurity(config);
  const headers={'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document','sec-fetch-user':'?1'};
  security.assertRequest(request(headers,{url:'/join.html'}));
  for(const url of ['/','/join.html?invite=opaque','/join.html/','/api/site-admission/check','/site-admission.js','/%6aoin.html'])rejected(()=>security.assertRequest(request(headers,{url})),'ORIGIN_REJECTED');
  for(const method of ['HEAD','POST','OPTIONS'])rejected(()=>security.assertRequest(request(headers,{url:'/join.html',method})),'ORIGIN_REJECTED');
  for(const changed of [{'sec-fetch-mode':'cors'},{'sec-fetch-dest':'iframe'},{'sec-fetch-user':undefined}])rejected(()=>security.assertRequest(request({...headers,...changed},{url:'/join.html'})),'ORIGIN_REJECTED');
  rejected(()=>security.assertRequest(request({...headers,origin:'https://evil.test'},{url:'/join.html'})),'ORIGIN_REJECTED');
  rejected(()=>security.assertRequest(request({...headers,host:'evil.test'},{url:'/join.html'})),'HOST_REJECTED');
  const disabled=createRequestSecurity(readRuntimeConfig(publicEnv()));
  rejected(()=>disabled.assertRequest(request(headers,{url:'/join.html'})),'ORIGIN_REJECTED');
  // Older browsers without Fetch Metadata keep the existing safe GET policy.
  security.assertRequest(request({},{url:'/join.html'}));
});

test('public requests enforce exact Host, HTTPS Origin, and same-host mutations', () => {
  const security = createRequestSecurity(readRuntimeConfig(publicEnv()));
  security.assertRequest(request()); // Health check and navigation may omit Origin.
  security.assertRequest(request({ origin: 'https://preview.example.test' }, { method: 'POST' }));
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) rejected(() => security.assertRequest(request({}, { method })), 'ORIGIN_REQUIRED');
  for (const host of ['evil.test', 'preview.example.test:4190', 'preview.example.test.evil.test', 'preview.example.test.', 'preview.example.test,evil.test', '', undefined]) rejected(() => security.assertRequest(request({ host, 'x-forwarded-host': 'preview.example.test' })), 'HOST_REJECTED');
  for (const origin of ['http://preview.example.test', 'https://preview.example.test:4190', 'https://preview.example.test/', 'https://user@preview.example.test', 'https://evil.test', 'null', '', ['https://preview.example.test']]) rejected(() => security.assertRequest(request({ origin }, { method: 'POST' })), 'ORIGIN_REJECTED');
  rejected(() => security.assertRequest(request({ 'sec-fetch-site': 'cross-site', origin: 'https://preview.example.test' })), 'ORIGIN_REJECTED');
  rejected(() => security.assertRequest(request({}, { rawHeaders: ['Host', 'preview.example.test', 'Host', 'evil.test'] })), 'HOST_REJECTED');
  security.assertRequest(request({}, { rawHeaders: ['Host', 'preview.example.test'] }));
});

test('TLS is an explicit deployment contract and never inferred from forwarded headers', () => {
  const security = createRequestSecurity(readRuntimeConfig(publicEnv()));
  for (const proto of ['http', 'https', 'https,http', undefined]) assert.equal(security.secureCookie(request({ 'x-forwarded-proto': proto })), true);
  rejected(() => security.assertRequest(request({ host: 'evil.test', forwarded: 'proto=https;host=preview.example.test', 'x-forwarded-host': 'preview.example.test' })), 'HOST_REJECTED');
  const two = createRequestSecurity(readRuntimeConfig(publicEnv({ UNIVERSE_ALLOWED_HOSTS: 'preview.example.test,review.example.test', UNIVERSE_ALLOWED_ORIGINS: 'https://preview.example.test,https://review.example.test' })));
  rejected(() => two.assertRequest(request({ origin: 'https://review.example.test' }, { method: 'POST' })), 'ORIGIN_REJECTED');
});

test('authority/origin parsers reject wildcard, credential, malformed IPv6 and URL tricks', () => {
  for (const authority of ['[', '[::2]evil', '[::1]:0', 'foo:00080', 'foo:65536', '*', 'https://foo', 'foo/bar', 'a..b', '-a.test', 'a-.test', 'foo#bar', 'foo\\bar', 'foo?bar', 'foo\nbar']) assert.equal(parseAuthority(authority), null, authority);
  assert.equal(parseAuthority('PREVIEW.example.test'), 'preview.example.test');
  assert.equal(parseAuthority('[::1]:4190'), '[::1]:4190');
  for (const origin of ['null', 'file://test', 'https://example.test:443', 'https://EXAMPLE.test', 'https://example.test#hash', 'https://example.test?query']) assert.equal(parseOrigin(origin), null, origin);
  assert.equal(parseOrigin('https://example.test:8443'), 'https://example.test:8443');
});

test('physical image sizing is explicitly default off and accepts only the documented process flag',()=>{
 assert.equal(readRuntimeConfig({}).imagePhysicalSizeEnabled,false);
 assert.equal(readRuntimeConfig({UNIVERSE_IMAGE_PHYSICAL_SIZE_ENABLED:'1'}).imagePhysicalSizeEnabled,true);
 assert.equal(readRuntimeConfig({UNIVERSE_IMAGE_PHYSICAL_SIZE_ENABLED:'0'}).imagePhysicalSizeEnabled,false);
 for(const value of ['true','false','2','',1])assert.throws(()=>readRuntimeConfig({UNIVERSE_IMAGE_PHYSICAL_SIZE_ENABLED:value}),/UNIVERSE_IMAGE_PHYSICAL_SIZE_ENABLED/);
});
