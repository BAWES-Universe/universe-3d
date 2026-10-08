import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPOSITORY, IMAGE, APP, VOLUME, ORIGIN, GateError, validateSelected } from '../deploy/on-dev/contracts.mjs';
import { choose, github } from '../deploy/on-dev/github.mjs';
import { validateTarget, configuredPin, coolify, publicSite } from '../deploy/on-dev/coolify.mjs';
import { switchDev, checkBaseline } from '../deploy/on-dev/switch.mjs';
import { compatibility } from '../deploy/on-dev/source.mjs';
import { readBuildInfo } from '../server/build-info.mjs';
import { createGameServer } from '../server/app.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40), TREE = 'c'.repeat(40), C = 'd'.repeat(64);
const D1 = `sha256:${'1'.repeat(64)}`, D2 = `sha256:${'2'.repeat(64)}`;
const wanted = { pr: 7, sha: A, mainSha: B, branch: 'feature/friends', labelEvent: 90 };
const selected = { schemaVersion: 1, repository: REPOSITORY, sha: A, tree: TREE, controllerSha: B,
  compatibility: C, runId: '123', buildAttempt: '1', imageId: `sha256:${'3'.repeat(64)}`, digest: D2, pin: `${IMAGE}@${D2}` };
const holder = (number = 7, event = 90) => ({ number, labelEvent: event, state: 'open', draft: false, base: 'main',
  baseRepository: REPOSITORY, headRepository: REPOSITORY, labels: ['on-dev'], authorizedLabeler: true, sha: A, branch: 'feature/friends' });
const fixture = () => ({
  app: { uuid: APP, build_pack: 'dockerimage', fqdn: ORIGIN, ports_exposes: '4190', ports_mappings: null,
    destination_type: 'App\\Models\\StandaloneDocker', destination_id: 5, additional_servers_count: 0,
    health_check_enabled: true, health_check_path: '/api/health', health_check_type: 'cmd', health_check_command: 'node scripts/healthcheck.mjs', custom_healthcheck_found: false, status: 'running:healthy',
    docker_registry_image_name: IMAGE, docker_registry_image_tag: D1.replace(':', '-'),
    settings: { is_consistent_container_name_enabled: true, is_auto_deploy_enabled: false, is_preview_deployments_enabled: false } },
  storage: { persistent_storages: [{ uuid: 'volume-uuid', name: VOLUME, mount_path: '/data', host_path: null, is_preview_suffix_enabled: false }], file_storages: [] }
});
const buildHealth = (patch = {}) => ({ ok: true, persistence: 'sqlite', build: { revision: B, tree: TREE, compatibility: C,
  runId: '122', buildAttempt: '1', controllerRevision: B, ...patch } });
const gate = code => error => error.code === code;

for (const [description, change] of [
  ['fork', h => { h.headRepository = 'outsider/fork'; }],
  ['wrong base', h => { h.base = 'release/mvp-open-signup'; }],
  ['closed', h => { h.state = 'closed'; }],
  ['draft', h => { h.draft = true; }],
  ['removed label', h => { h.labels = []; }],
  ['untrusted labeler', h => { h.authorizedLabeler = false; }],
  ['bad source SHA', h => { h.sha = 'branch;evil'; }],
  ['missing label generation', h => { h.labelEvent = 0; }]
]) test(`selection rejects ${description}`, () => {
  const h = holder(); change(h); assert.equal(choose([h], B).sha, B); assert.equal(choose([h], B).pr, null);
});
test('fresh labels deterministically choose latest generation, not stale triggering event', () => {
  assert.equal(choose([holder(8, 90), holder(4, 100)], B).pr, 4);
  assert.equal(choose([holder(8, 90), holder(4, 90)], B).pr, 8);
});
test('removal selects next eligible held label, removal of all returns main', () => {
  assert.equal(choose([holder(8, 90)], B).pr, 8);
  assert.deepEqual(choose([], B), { pr: null, sha: B, branch: 'main', labelEvent: null, mainSha: B });
});
test('immutable image attribution rejects tags, other registry/repo and malformed identity', () => {
  assert.equal(validateSelected(selected), selected);
  for (const patch of [{ pin: `${IMAGE}:latest` }, { digest: 'latest' }, { repository: 'fork/repo' },
    { controllerSha: 'main' }, { runId: 'x' }, { compatibility: 'unknown' }]) assert.throws(() => validateSelected({ ...selected, ...patch }));
});
test('API-only prior pin is explicitly configured evidence, never running digest proof', () => {
  const { app, storage } = fixture(); const result = validateTarget(app, storage);
  assert.equal(result.configuredPin, `${IMAGE}@${D1}`); assert.equal(result.runningDigestVerified, false);
  assert.throws(() => configuredPin({ ...app, docker_registry_image_tag: 'latest' }), gate('CONFIGURED_DIGEST_REQUIRED'));
});
for (const [description, change] of [
  ['app UUID', f => { f.app.uuid = 'other'; }], ['domain', f => { f.app.fqdn = 'https://prod.bawes.net'; }],
  ['Swarm', f => { f.app.destination_type = 'App\\Models\\SwarmDocker'; }],
  ['multiple servers', f => { f.app.additional_servers_count = 1; }],
  ['missing server count', f => { delete f.app.additional_servers_count; }],
  ['rolling updates', f => { f.app.settings.is_consistent_container_name_enabled = false; }],
  ['external auto deployment', f => { f.app.settings.is_auto_deploy_enabled = true; }],
  ['volume name', f => { f.storage.persistent_storages[0].name = 'empty-new-volume'; }],
  ['mount path', f => { f.storage.persistent_storages[0].mount_path = '/other'; }],
  ['bind mount', f => { f.storage.persistent_storages[0].host_path = '/host'; }],
  ['file overlay', f => { f.storage.file_storages.push({ mount_path: '/data/universe.sqlite' }); }],
  ['omitted storage response', f => { f.storage = {}; }],
  ['custom startup command', f => { f.app.pre_deployment_command = 'reset data'; }],
  ['unusable curl health check', f => { f.app.health_check_type = 'http'; }],
  ['host mount argument', f => { f.app.custom_docker_run_options = '-v /data:/data'; }]
]) test(`target guard rejects ${description}`, () => { const f = fixture(); change(f); assert.throws(() => validateTarget(f.app, f.storage)); });

function mockIO({ failAt, wantedResponses = [true], health = buildHealth(), already = false } = {}) {
  const f = fixture(), calls = [], receipts = [], statuses = [];
  if (already) f.app.docker_registry_image_tag = D2.replace(':', '-');
  const act = (name, value) => { calls.push(name); if (failAt === name) throw new GateError(`FAIL_${name}`); return value; };
  let i = 0;
  const io = { now: () => 1_800_000_000_000, save: receipt => receipts.push(structuredClone(receipt)),
    github: { assertUnlocked: async () => act('unlocked'), stillWanted: async () => act('wanted', wantedResponses[Math.min(i++, wantedResponses.length - 1)]),
      begin: async () => act('begin', 42), status: async (_id, state) => { act(`status_${state}`); statuses.push(state); } },
    coolify: { verifyVersion: async () => act('version'), inspect: async () => act('inspect', validateTarget(f.app, f.storage)), assertIdle: async () => act('idle'),
      setImage: async digest => { act('patch'); f.app.docker_registry_image_tag = digest.replace(':', '-'); },
      start: async () => act('start', 'deployment-id'), waitFor: async () => act('poll', 'finished') },
    site: { health: async () => act('health', health), access: async () => act('access', 'access-hash'),
      verify: async () => act('verify', { revision: A, tree: TREE, runId: '123', ok: true }) } };
  return { io, calls, receipts, statuses, f };
}
const run = (mock, extra = {}) => switchDev({ selected, wanted, runUrl: 'https://github.com/run/123', ...extra }, mock.io);
test('successful switch keeps config/mount hash, durable marker first, verifies exact live revision', async () => {
  const m = mockIO(); const result = await run(m);
  assert.equal(result.outcome, 'DEPLOYMENT_VERIFIED'); assert.equal(result.runtimeDigestVerified, false);
  assert.equal(result.before.configurationHash, result.after.configurationHash);
  assert(m.calls.indexOf('begin') < m.calls.indexOf('patch')); assert(m.calls.indexOf('verify') < m.calls.indexOf('status_success'));
  assert.deepEqual(m.statuses, ['in_progress', 'success']); assert.equal(m.calls.filter(c => c === 'start').length, 1);
});
test('already current exact build is reverified without restart or new deployment', async () => {
  const m = mockIO({ already: true, health: buildHealth({ revision: A, runId: '123' }) });
  assert.equal((await run(m)).outcome, 'ALREADY_CURRENT'); assert(!m.calls.includes('patch')); assert(!m.calls.includes('begin'));
});
test('changed head/removed label before switch cannot deploy stale build', async () => {
  const m = mockIO({ wantedResponses: [false] }); assert.equal((await run(m)).outcome, 'SUPERSEDED'); assert(!m.calls.includes('patch'));
});
test('label removal after durable lock exits inactive with no mutation', async () => {
  const m = mockIO({ wantedResponses: [true, true, false] }); assert.equal((await run(m)).outcome, 'SUPERSEDED');
  assert(!m.calls.includes('patch')); assert.deepEqual(m.statuses, ['in_progress', 'inactive']);
});
test('label removal after image write never starts withdrawn image and freezes', async () => {
  const m = mockIO({ wantedResponses: [true, true, true, false] }); await assert.rejects(run(m), gate('WITHDRAWN_AFTER_IMAGE_WRITE'));
  assert(!m.calls.includes('start')); assert(m.statuses.includes('failure')); assert.equal(m.receipts.at(-1).outcome, 'RECOVERY_REVIEW_REQUIRED');
});
test('label change during deployment records supersession honestly', async () => {
  const m = mockIO({ wantedResponses: [true, true, true, true, false] }); assert.equal((await run(m)).outcome, 'DEPLOYED_BUT_SUPERSEDED');
});
for (const stage of ['unlocked', 'version', 'idle', 'inspect', 'health', 'access', 'begin', 'status_in_progress', 'patch', 'start', 'poll', 'verify', 'status_success']) {
  test(`failure at ${stage} is never success and never retries a mutation`, async () => {
    const m = mockIO({ failAt: stage }); await assert.rejects(run(m));
    assert(['BLOCKED', 'RECOVERY_REVIEW_REQUIRED'].includes(m.receipts.at(-1).outcome));
    assert(m.calls.filter(c => c === 'patch').length <= 1); assert(m.calls.filter(c => c === 'start').length <= 1);
    assert.equal(m.receipts.at(-1).automaticRollback, false);
  });
}
test('schema/migration mismatch blocks routine release before first write', async () => {
  const m = mockIO({ health: buildHealth({ compatibility: 'f'.repeat(64) }) });
  await assert.rejects(run(m), gate('COMPATIBILITY_REVIEW_REQUIRED')); assert(!m.calls.includes('patch'));
});
test('first rollout needs exact explicit owner attestation rather than old digest assumption', async () => {
  const before = validateTarget(...Object.values(fixture()));
  const baseline = { schemaVersion: 1, configuredPin: before.configuredPin, sourceRevision: B, compatibility: C,
    ownerVerifiedBackup: true, ownerVerifiedRunningDigest: true, verifiedAt: '2026-10-08T10:00:00Z' };
  assert.equal(checkBaseline({ ok: true, persistence: 'sqlite' }, selected, before, baseline), 'owner-attested-initial-baseline');
  assert.throws(() => checkBaseline(buildHealth({ compatibility: 'f'.repeat(64) }), selected, before, baseline), gate('COMPATIBILITY_REVIEW_REQUIRED'));
  for (const patch of [{ configuredPin: selected.pin }, { compatibility: 'x' }, { ownerVerifiedBackup: false }, { ownerVerifiedRunningDigest: false }]) {
    assert.throws(() => checkBaseline({ ok: true, persistence: 'sqlite' }, selected, before, { ...baseline, ...patch }), gate('BASELINE_ACTIVATION_REQUIRED'));
  }
});
test('real HTTP transport restricts writes to two image fields and one target', async () => {
  const calls = [], f = fixture();
  const api = coolify({ base: 'https://coolify.example.test', token: 'mock-token', fetcher: async (url, options) => {
    calls.push({ path: url.pathname, ...options }); return new Response(JSON.stringify({ uuid: APP }), { status: 200 });
  } });
  await api.setImage(D2); assert.deepEqual(JSON.parse(calls[0].body), { docker_registry_image_name: IMAGE, docker_registry_image_tag: D2.replace(':', '-') });
  assert.equal(calls[0].path, `/api/v1/applications/${APP}`); assert.equal(calls[0].redirect, 'error');
  assert.throws(() => coolify({ base: 'http://insecure.test', token: 'mock' }));
});
for (const [name, result] of [['missing UUID', {}], ['bad UUID', { deployment_uuid: '../other' }]]) test(`start response ${name} is uncertain and not retried`, async () => {
  let count = 0;
  const api = coolify({ base: 'https://coolify.example.test', token: 'mock', fetcher: async () => { count++; return Response.json(result); } });
  await assert.rejects(api.start(), gate('DEPLOYMENT_ACCEPTANCE_UNKNOWN')); assert.equal(count, 1);
});
test('lost mutation response is unknown and never blindly repeated', async () => {
  let count = 0; const api = coolify({ base: 'https://coolify.example.test', token: 'mock', fetcher: async () => { count++; throw new Error('private response details'); } });
  await assert.rejects(api.start(), gate('COOLIFY_MUTATION_UNKNOWN')); assert.equal(count, 1);
});
for (const status of ['failed', 'cancelled-by-user', 'unexpected']) test(`polling ${status} cannot pass`, async () => {
  const api = coolify({ base: 'https://coolify.example.test', token: 'mock', fetcher: async () => Response.json({ deployment_uuid: 'x', status }) });
  await assert.rejects(api.waitFor('x'));
});
test('polling validates receipt identity and bounded timeout', async () => {
  const mismatch = coolify({ base: 'https://coolify.example.test', token: 'mock', fetcher: async () => Response.json({ deployment_uuid: 'other', status: 'finished' }) });
  await assert.rejects(mismatch.waitFor('x'), gate('DEPLOYMENT_ID_MISMATCH'));
  let clock = 0;
  const timed = coolify({ base: 'https://coolify.example.test', token: 'mock', now: () => clock, wait: async ms => { clock += ms; },
    fetcher: async () => Response.json({ deployment_uuid: 'x', status: 'in_progress' }) });
  await assert.rejects(timed.waitFor('x', 10000), gate('DEPLOYMENT_TIMEOUT'));
});
test('GitHub durable unresolved marker blocks next run, successful/inactive allow it', async () => {
  for (const state of ['in_progress', 'failure', 'error', 'success', 'inactive', null]) {
    const api = github({ token: 'mock', fetcher: async url => {
      if (url.includes('/statuses')) return Response.json(state ? [{ state }] : []);
      return Response.json([{ id: 1, task: 'universe-3d-on-dev' }]);
    } });
    if (['success', 'inactive'].includes(state)) await api.assertUnlocked();
    else await assert.rejects(api.assertUnlocked(), gate('RECOVERY_REVIEW_REQUIRED'));
  }
});
test('GitHub selection paginates all labels and rejects fork without reading its source', async () => {
  const urls = [];
  const api = github({ token: 'mock', fetcher: async url => {
    urls.push(url);
    if (url.endsWith(REPOSITORY)) return Response.json({ default_branch: 'main' });
    if (url.includes('/git/ref/')) return Response.json({ object: { sha: B } });
    if (url.includes('/issues?') && new URL(url).searchParams.get('page') === '1') return Response.json(Array.from({ length: 100 }, (_, number) => ({ number })));
    if (url.includes('/issues?')) return Response.json([{ number: 9, pull_request: {} }]);
    if (url.includes('/pulls/')) return Response.json({ number: 9, head: { repo: { full_name: 'evil/fork' } } });
    throw new Error('unexpected request');
  } });
  assert.equal((await api.desired()).sha, B); assert(urls.some(url => url.includes('page=2')));
});
test('served health checks exact build attribution and stable access, not HTTP 200 alone', async () => {
  let clock = 0;
  const make = revision => publicSite({ now: () => clock, wait: async ms => { clock += ms; }, fetcher: async url => {
    if (url.includes('/api/health')) return Response.json(buildHealth({ revision, runId: '123', controllerRevision: B }));
    if (url.includes('/api/access')) return Response.json({ setupOnly: false, openSignup: true });
    return new Response('<script src="/main.js"></script>');
  } });
  const good = make(A), access = await good.access(); assert.equal((await good.verify(selected, access)).revision, A);
  await assert.rejects(make(B).verify(selected, access, 5000), gate('SERVED_REVISION_NOT_VERIFIED'));
});
test('build metadata loads explicit public fields and serves exact revision from real local server', async () => {
  const root = mkdtempSync(join(tmpdir(), 'universe-build-'));
  try {
    assert.equal(readBuildInfo(join(root, 'missing.json')), null);
    writeFileSync(join(root, 'build.json'), JSON.stringify(selected)); const buildInfo = readBuildInfo(join(root, 'build.json'));
    const app = createGameServer({ buildInfo }); const address = await app.listen(0);
    try { const health = await (await fetch(`http://127.0.0.1:${address.port}/api/health`)).json(); assert.equal(health.build.revision, A); assert.equal(health.build.compatibility, C); }
    finally { await app.close(); }
    writeFileSync(join(root, 'build.json'), JSON.stringify({ ...selected, sha: 'main' })); assert.throws(() => readBuildInfo(join(root, 'build.json')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('runtime storage gate catches format/SQL/dependency changes, permits frontend-only change', () => {
  const root = mkdtempSync(join(tmpdir(), 'universe-schema-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  const commit = () => { git('add', '.'); git('-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  try {
    git('init', '-q'); mkdirSync(join(root, 'server')); mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'server/store.mjs'), 'import { version } from "../src/protocol.js"; const sql="CREATE TABLE users (id TEXT)";');
    writeFileSync(join(root, 'src/protocol.js'), 'export const version=1;');
    writeFileSync(join(root, 'server/capabilities.json'), '{"format":1}');
    writeFileSync(join(root, 'package.json'), '{}'); writeFileSync(join(root, 'package-lock.json'), '{}');
    writeFileSync(join(root, 'src/ui.js'), 'export const text="hello";');
    const first = compatibility(root, commit()); writeFileSync(join(root, 'src/ui.js'), 'export const text="friends";');
    assert.equal(compatibility(root, commit()).hash, first.hash);
    writeFileSync(join(root, 'src/protocol.js'), 'export const version=2;');
    assert.notEqual(compatibility(root, commit()).hash, first.hash);
    writeFileSync(join(root, 'src/protocol.js'), 'export const version=1;');
    writeFileSync(join(root, 'server/capabilities.json'), '{"format":2}');
    assert.notEqual(compatibility(root, commit()).hash, first.hash);
    writeFileSync(join(root, 'server/capabilities.json'), '{"format":1}');
    writeFileSync(join(root, 'server/extra.mjs'), 'const sql="ALTER TABLE users ADD name TEXT";');
    assert.notEqual(compatibility(root, commit()).hash, first.hash);
    rmSync(join(root, 'server/extra.mjs')); writeFileSync(join(root, 'package-lock.json'), '{"changed":true}');
    assert.notEqual(compatibility(root, commit()).hash, first.hash);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('workflow trust boundaries, serialized switch, artifact IDs and always receipt stay explicit', () => {
  const workflow = readFileSync(new URL('../.github/workflows/dev-on-dev.yml', import.meta.url), 'utf8');
  assert(workflow.includes('pull_request_target:')); assert(workflow.includes('group: universe-3d-dev-switch\n      cancel-in-progress: false'));
  assert(workflow.includes('artifact-ids: ${{ needs.build.outputs.artifact }}'));
  const build = workflow.split('\n  build:')[1].split('\n  publish:')[0];
  const verify = workflow.split('\n  verify:')[1].split('\n  build:')[0];
  for (const job of [build, verify]) { assert(!job.includes('secrets.')); assert(!job.includes('packages: write')); assert(!job.includes('PACKAGE_TOKEN')); }
  const switchJob = workflow.split('\n  switch:')[1]; assert(!switchJob.includes('docker run')); assert(switchJob.includes('if: always()'));
  assert(readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8').includes('!deploy-build.json'));
});
test('served revision from an earlier build attempt cannot pass a rerun', async () => {
  let clock = 0;
  const site = publicSite({ now: () => clock, wait: async ms => { clock += ms; }, fetcher: async () =>
    Response.json(buildHealth({ revision: A, runId: '123', buildAttempt: '1' })) });
  await assert.rejects(site.verify({ ...selected, buildAttempt: '2' }, 'ignored', 5000), gate('SERVED_REVISION_NOT_VERIFIED'));
});
test('installed Coolify version changes fail before mutations', async () => {
  const api = coolify({ base: 'https://coolify.example.test', token: 'mock', expectedVersion: '4.0.0-reviewed',
    fetcher: async () => new Response('4.0.0-different') });
  await assert.rejects(api.verifyVersion(), gate('COOLIFY_VERSION_REVIEW_REQUIRED'));
});
test('adding build identity preserves synthetic persistent accounts, rooms and asset bytes across restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'universe-persist-')), database = join(root, 'universe.sqlite');
  const { seedWorlds } = await import('../src/worlds.js');
  let app;
  try {
    app = createGameServer({ database, seeds: seedWorlds }); await app.listen(0);
    const user = app.store.createUser('Fixture account', '{}');
    app.store.run('INSERT INTO accounts(username,email,user_id,salt,password_hash) VALUES(?,?,?,?,?)', 'fixture-account', 'fixture@example.test', user.id, 'fixture-salt', 'fixture-hash');
    const room = app.store.get('SELECT id FROM rooms LIMIT 1');
    app.store.run('INSERT INTO room_files(id,room_id,name,content_type,size,bytes,sha256,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      'fixture-file', room.id, 'fixture.txt', 'text/plain', 5, Buffer.from('hello'), 'fixture-digest', user.id, 1);
    const snapshot = () => ({ accounts: app.store.all('SELECT * FROM accounts'), rooms: app.store.all('SELECT * FROM rooms ORDER BY id'), files: app.store.all('SELECT * FROM room_files') });
    const before = snapshot(); await app.close(); app = null;
    app = createGameServer({ database, seeds: seedWorlds, buildInfo: { revision: A, tree: TREE, compatibility: C, controllerRevision: B, runId: '123', buildAttempt: '1' } });
    await app.listen(0); assert.deepEqual(snapshot(), before);
  } finally { if (app) await app.close(); rmSync(root, { recursive: true, force: true }); }
});
test('PR image validation uses pinned matching base and no publish/deploy authority', () => {
  const verify = readFileSync(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8').split('\n  dev-image:')[1];
  const live = readFileSync(new URL('../.github/workflows/dev-on-dev.yml', import.meta.url), 'utf8');
  assert(verify); assert(!verify.includes('secrets.')); assert(!verify.includes('packages: write'));
  assert(!verify.includes('environment:')); assert(!verify.includes('docker push')); assert(!verify.includes('docker login'));
  assert(verify.includes('deploy/on-dev/Dockerfile')); assert(verify.includes('container-smoke.sh "$IMAGE_ID"'));
  const base = /BASE_IMAGE: (node:[^\n]+)/;
  assert.equal(verify.match(base)[1], live.match(base)[1]);
  const smoke = readFileSync(new URL('../deploy/on-dev/container-smoke.sh', import.meta.url), 'utf8');
  assert(smoke.includes('--network none')); assert(smoke.includes('--tmpfs /data:')); assert(smoke.includes('--user 1000:1000'));
  assert(smoke.includes('--pull never')); assert(!smoke.includes('/var/run/docker.sock')); assert(!smoke.includes('docker pull'));
});
