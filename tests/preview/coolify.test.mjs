import test from 'node:test';
import assert from 'node:assert/strict';
import { CoolifyApplication } from '../../deploy/preview/coolify.mjs';
import { createHostAdapter, CoolifyWithHostEvidenceAdapter } from '../../deploy/preview/host-adapter.mjs';
import { fixture, digest } from './fixtures.mjs';
function clientFixture(overrides = {}) {
  const calls = []; let t = 100000;
  const pin = `ghcr.io/bawes-universe/universe-3d-preview@${digest('2')}`;
  const fetcher = async (url, options) => {
    calls.push({ url, ...options });
    let body = {};
    if (url.endsWith('/version')) body = 'synthetic-version';
    else if (url.endsWith('/start')) body = { deployment_uuid: 'synthetic-deploy' };
    else if (url.includes('/deployments/')) body = { status: 'finished' };
    else if (options.method === 'GET') body = { uuid: 'isolated-preview', build_pack: 'dockerimage', docker_registry_image_name: pin, docker_registry_image_tag: '' };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const client = new CoolifyApplication({ origin: 'https://coolify.example.invalid', applicationId: 'isolated-preview', token: 'synthetic-not-a-credential', apiProfile: { reviewId: 'synthetic-profile', version: 'synthetic-version', digestBinding: 'name-at-digest-empty-tag' }, now: () => t, wait: async ms => { t += ms; }, fetcher, ...overrides });
  return { client, calls, pin, lease: { assertHeld: async () => {} } };
}
test('Coolify stop always sends docker_cleanup=false and makes no completion claim', async () => {
  const f = clientFixture(); await f.client.stop(f.lease);
  assert.equal(f.calls[0].url, 'https://coolify.example.invalid/api/v1/applications/isolated-preview/stop?docker_cleanup=false');
  assert.equal(f.calls[0].method, 'POST'); assert.equal(f.calls[0].redirect, 'error');
});
test('scoped API implements digest patch/readback/start/poll but not running evidence', async () => {
  const f = clientFixture(); const version = await f.client.installedVersion();
  const result = await f.client.startPinned(f.pin, version, f.lease);
  assert.equal(result.deploymentId, 'synthetic-deploy');
  assert.equal(JSON.parse(f.calls.find(c => c.method === 'PATCH').body).docker_registry_image_name, f.pin);
  assert(f.calls.some(c => c.url.endsWith('/start'))); assert(f.calls.some(c => c.url.endsWith('/deployments/synthetic-deploy')));
  assert.equal(result.healthy, undefined); assert.equal(result.runningDigest, undefined);
});
test('unknown installed version/digest binding refuses every mutation', async () => {
  const f = clientFixture({ apiProfile: { reviewId: 'synthetic', version: 'other', digestBinding: 'name-at-digest-empty-tag' } });
  await assert.rejects(f.client.startPinned(f.pin, { value: 'synthetic-version', observedAt: 100000 }, f.lease), { code: 'DIGEST_BINDING_UNVERIFIED' }); assert.equal(f.calls.length, 0);
});
test('malformed or mutable pins fail before PATCH', async () => {
  const f = clientFixture(); await assert.rejects(f.client.startPinned('image:latest', { value: 'synthetic-version', observedAt: 100000 }, f.lease), { code: 'INVALID_DIGEST_PIN' }); assert.equal(f.calls.length, 0);
});
test('no insecure origin, URL credentials or out-of-scope requests', async () => {
  for (const origin of ['http://example.invalid', 'https://user:pass@example.invalid', 'https://example.invalid/path']) assert.throws(() => clientFixture({ origin }), { code: 'INVALID_COOLIFY_ORIGIN' });
  const f = clientFixture(); await assert.rejects(f.client.request('/api/v1/applications/other/stop'), { code: 'COOLIFY_SCOPE_ESCAPE' }); assert.equal(f.calls.length, 0);
});
test('failed deployment and unknown polling state do not report success', async () => {
  for (const status of ['failed', 'alien']) {
    const original = clientFixture(); const f = clientFixture({ fetcher: async (url, options) => url.includes('/deployments/') ? { ok: true, json: async () => ({ status }) } : original.client.fetcher(url, options) });
    await assert.rejects(f.client.startPinned(f.pin, { value: 'synthetic-version', observedAt: 100000 }, f.lease), { code: status === 'failed' ? 'DEPLOYMENT_FAILED' : 'DEPLOYMENT_STATUS_UNKNOWN' });
  }
});
test('a queued deployment times out within a bounded polling budget', async () => {
  const original = clientFixture(); let calls = 0;
  const f = clientFixture({ fetcher: async (url, options) => { calls++; return url.includes('/deployments/') ? { ok: true, json: async () => ({ status: 'queued' }) } : original.client.fetcher(url, options); } });
  await assert.rejects(f.client.startPinned(f.pin, { value: 'synthetic-version', observedAt: 100000 }, f.lease), { code: 'DEPLOYMENT_TIMEOUT' }); assert(calls <= 124);
});
test('API errors do not echo token or sensitive response body', async () => {
  const f = clientFixture({ fetcher: async () => ({ ok: false, status: 403, json: async () => ({ secret: 'private' }) }) });
  await assert.rejects(f.client.inspect(), error => error.code === 'COOLIFY_REQUEST_FAILED' && !error.message.includes('private') && !error.message.includes('credential'));
});
test('configuring the API alone cannot fabricate host capabilities', async () => {
  const f = fixture(); Object.assign(f.policy, { hostAdapter: 'coolify-with-host-evidence', coolifyOrigin: 'https://coolify.example.invalid', apiProfile: { reviewId: 'synthetic', version: 'synthetic-version' } });
  let calls = 0; const adapter = createHostAdapter(f.policy, {}, { fetcher: async () => { calls++; throw Error('No network'); } });
  const capabilities = await adapter.capabilities();
  assert(!capabilities.includes('all-writer-termination')); assert(!capabilities.includes('fresh-host-capacity')); assert.equal(calls, 0);
});
test('concrete composed adapter independently rejects foreign or mutable recovery pins', async () => {
  const f = fixture(); const adapter = new CoolifyWithHostEvidenceAdapter({ policy: f.policy, client: {}, host: {} });
  await assert.rejects(adapter.startPinned({ applicationId: f.policy.applicationId, volumeId: f.policy.volumeId, pin: `ghcr.io/foreign/image@${digest('1')}`, replicas: 1 }, {}), { code: 'RESOURCE_SCOPE_MISMATCH' });
});
