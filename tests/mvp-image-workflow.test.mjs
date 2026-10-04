import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, mkdir, rm, chmod, access} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const workflow = await readFile(new URL('../.github/workflows/mvp-image.yml', import.meta.url), 'utf8');
const verification = await readFile(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8');
function job(name) {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z_]+:|$(?![\\s\\S]))`, 'm'));
  assert.ok(match, name);
  return match[1];
}
function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, name);
  const rest = workflow.slice(start);
  const run = rest.indexOf('        run: |\n');
  assert.ok(run > 0);
  return rest.slice(run + '        run: |\n'.length).split('\n')
    .reduce((state, line) => {
      if (state.done) return state;
      if (line && !line.startsWith('          ')) return {...state, done: true};
      state.lines.push(line.slice(10));
      return state;
    }, {lines: [], done: false}).lines.join('\n');
}
const validateScript = step("Validate this run's archive and source labels");
const publishScript = step('Push one tag and confirm the registry digest');
const pullScript = step('Pull published digest anonymously');
const smokeScript = step('Smoke exact digest without retained credentials');
const sha = 'a'.repeat(40), tree = 'b'.repeat(40), blob = 'c'.repeat(40);
const imageId = `sha256:${'d'.repeat(64)}`, digest = `sha256:${'e'.repeat(64)}`;
const baseImage = workflow.match(/^  BASE_IMAGE: (.+)$/m)[1];
const canShellTest = spawnSync('bash', ['--version']).status === 0 && spawnSync('jq', ['--version']).status === 0;

async function fixture(t, changes = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'universe-mvp-workflow-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  await mkdir(join(dir, 'input')); await mkdir(join(dir, 'bin'));
  const archive = 'an image archive fixture';
  const source = {schemaVersion: 1, repository: 'BAWES-Universe/universe-3d',
    ref: 'refs/heads/release/mvp-open-signup', sha, tree, workflowSha: sha,
    workflowBlob: blob, runId: '42', buildAttempt: '1', imageId,
    archiveSha256: createHash('sha256').update(archive).digest('hex'), baseImage,
    platform: 'linux/amd64', ...changes};
  await writeFile(join(dir, 'input/image.tar'), archive);
  await writeFile(join(dir, 'input/source.json'), JSON.stringify(source));
  // Exercise the actual workflow shell and jq predicates with a deterministic
  // Docker boundary. This proves control flow/validation, not an image build.
  const mock = `#!${process.execPath}
import {appendFileSync, writeFileSync} from 'node:fs';
const a=process.argv.slice(2),e=process.env;
appendFileSync(e.MOCK_LOG,JSON.stringify(a)+'\\n');
if(a[0]==='login') { writeFileSync(e.DOCKER_CONFIG+'/config.json','fixture'); process.exit(0); }
if(a[0]==='pull' && e.MOCK_PULL_FAIL==='1') process.exit(1);
if(a[0]==='image' && a[1]==='inspect' && a.includes('--format')) { console.log(e.MOCK_ID||e.IMAGE_ID); process.exit(0); }
if(a[0]==='image' && a[1]==='inspect') console.log(JSON.stringify([{Id:e.MOCK_ID||e.IMAGE_ID,
 Architecture:'amd64',Os:'linux',Config:{User:'node:node',Labels:{
 'org.opencontainers.image.revision':e.MOCK_SHA||e.SOURCE_SHA,
 'net.bawes.universe.source-tree':e.SOURCE_TREE,
 'net.bawes.universe.workflow-sha':e.WORKFLOW_SHA,
 'net.bawes.universe.workflow-blob':e.WORKFLOW_BLOB}}}]));
if(a[0]==='buildx') console.log(JSON.stringify(a.includes('--raw') ? {config:{digest:e.MOCK_CONFIG||e.IMAGE_ID}} : {digest:e.MOCK_DIGEST||'${digest}'}));
`;
  await writeFile(join(dir, 'bin/docker'), mock); await chmod(join(dir, 'bin/docker'), 0o700);
  const env = {...process.env, PATH: join(dir, 'bin') + ':' + process.env.PATH,
    SOURCE_SHA: sha, SOURCE_TREE: tree, WORKFLOW_SHA: sha, WORKFLOW_BLOB: blob,
    BUILD_ATTEMPT: '1', BASE_IMAGE: baseImage, GITHUB_REPOSITORY: source.repository,
    GITHUB_REF: source.ref, GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2', GITHUB_SHA: sha,
    GITHUB_ACTOR: 'fixture-actor', GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_OUTPUT: join(dir, 'outputs'), GITHUB_STEP_SUMMARY: join(dir, 'summary'),
    IMAGE_ID: imageId, IMAGE: 'ghcr.io/bawes-universe/universe-3d', PACKAGE_TOKEN: 'fixture-token',
    DOCKER_CONFIG: join(dir, 'docker-config'), MOCK_LOG: join(dir, 'docker.log')};
  return {dir, env, run: (script, more = {}) => spawnSync('bash', ['-eo', 'pipefail', '-c', script], {cwd: dir, env: {...env, ...more}, encoding: 'utf8'})};
}

test('MVP publication is exact-branch, verified-SHA and publish-only', () => {
  assert.match(workflow, /on:\n  push:\n    branches: \[release\/mvp-open-signup\]/);
  assert.doesNotMatch(workflow, /workflow_dispatch:|issue_comment:|pull_request_target:|secrets\.|COOLIFY|preview\/cli/);
  assert.match(job('verify'), /github\.workflow_sha == github\.sha/);
  assert.match(job('verify'), /uses: \.\/\.github\/workflows\/verify.yml/);
  assert.match(job('build'), /needs: verify/);
  assert.match(job('publish'), /needs: \[verify, build\]/);
  assert.equal((workflow.match(/packages: write/g) || []).length, 1);
  assert.match(job('publish'), /packages: write/);
  assert.doesNotMatch(job('publish'), /uses: actions\/checkout|docker (?:run|exec|build) |npm |node /);
  assert.match(job('smoke'), /permissions: \{\}/);
  assert.doesNotMatch(job('smoke'), /github\.token|docker login|packages:/);
  assert.match(baseImage, /^node:24-bookworm-slim@sha256:[a-f0-9]{64}$/);
  for (const contents of [workflow, verification]) {
    for (const use of contents.matchAll(/uses: (actions\/[^\s]+)/g)) assert.match(use[1], /^actions\/[a-z-]+@[a-f0-9]{40}$/);
    const checkouts = contents.split('uses: actions/checkout@').slice(1);
    for (const checkout of checkouts) assert.match(checkout.split(/\n      - /)[0], /persist-credentials: false/);
  }
  assert.match(verification, /workflow_call:/);
  assert.match(verification, /value: \$\{\{ jobs\.verify\.outputs\.tree \}\}/);
  assert.equal((verification.match(/ref: \$\{\{ github\.sha \}\}/g) || []).length, 2);
  assert.match(workflow, /git -C source rev-parse HEAD\^\{tree\}/);
  assert.match(workflow, /artifact-ids: \$\{\{ needs\.build\.outputs\.artifact \}\}/);
});

test('packaging retains disabled defaults and includes the promotion helper', async () => {
  for (const path of ['Dockerfile', 'deploy/preview/Dockerfile']) {
    const dockerfile = await readFile(new URL('../' + path, import.meta.url), 'utf8');
    assert.match(dockerfile, /UNIVERSE_REGISTRATION_MODE=disabled/);
    assert.match(dockerfile, /COPY scripts\/operator-account.mjs scripts\/promote-owner.mjs scripts\/healthcheck.mjs \.\/scripts\//);
  }
  const ignore = await readFile(new URL('../.dockerignore', import.meta.url), 'utf8');
  assert.ok(ignore.startsWith('**\n'));
  assert.match(ignore, /^!scripts\/promote-owner.mjs$/m);
  assert.match(ignore, /^\*\*\/\.env\*$/m);
  assert.doesNotMatch(smokeScript, /--read-only|--publish|--volume|docker\.sock/);
});

test('same-run receipt and image labels validate before any package credential', {skip: !canShellTest}, async t => {
  const f = await fixture(t); const r = f.run(validateScript);
  assert.equal(r.status, 0, r.stderr);
  assert.match(await readFile(f.env.GITHUB_OUTPUT, 'utf8'), new RegExp(`image_id=${imageId}`));
  assert.doesNotMatch(await readFile(f.env.MOCK_LOG, 'utf8'), /login|push|run|exec/);
});

for (const [name, changes, env] of [
  ['wrong source SHA', {sha: '0'.repeat(40)}, {}],
  ['wrong source tree', {tree: '0'.repeat(40)}, {}],
  ['wrong workflow revision', {workflowSha: '0'.repeat(40)}, {}],
  ['wrong workflow blob', {workflowBlob: '0'.repeat(40)}, {}],
  ['wrong run', {runId: '7'}, {}],
  ['wrong build attempt', {buildAttempt: '3'}, {}],
  ['wrong base digest', {baseImage: 'node:24'}, {}],
  ['tampered archive', {archiveSha256: '0'.repeat(64)}, {}],
  ['shell-like image ID', {imageId: 'id; run something'}, {}],
  ['mismatched image label', {}, {MOCK_SHA: '0'.repeat(40)}],
  ['mismatched image ID', {}, {MOCK_ID: `sha256:${'0'.repeat(64)}`}],
]) test(`reject ${name}`, {skip: !canShellTest}, async t => {
  const f = await fixture(t, changes); const r = f.run(validateScript, env);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
});

test('publication records registry digest and both build/publish attempts, then removes credentials', {skip: !canShellTest}, async t => {
  const f = await fixture(t); const r = f.run(publishScript);
  assert.equal(r.status, 0, r.stderr);
  const receipt = JSON.parse(await readFile(join(f.dir, 'release.json'), 'utf8'));
  assert.equal(receipt.pin, `${f.env.IMAGE}@${digest}`);
  assert.equal(receipt.tag, `${f.env.IMAGE}:sha-${sha}-42-2`);
  assert.equal(receipt.buildAttempt, '1'); assert.equal(receipt.runAttempt, '2');
  assert.equal(receipt.sha, sha); assert.equal(receipt.tree, tree); assert.equal(receipt.workflowBlob, blob);
  assert.equal(receipt.smoke, 'pending'); assert.equal(receipt.published, true);
  assert.match(await readFile(f.env.MOCK_LOG, 'utf8'), /"buildx","imagetools","inspect"/);
  await assert.rejects(access(f.env.DOCKER_CONFIG));
});

for (const [name, env] of [
  ['invalid registry digest', {MOCK_DIGEST: 'latest'}],
  ['different registry image config', {MOCK_CONFIG: `sha256:${'0'.repeat(64)}`}],
]) test(`registry confirmation rejects ${name} and removes credentials`, {skip: !canShellTest}, async t => {
  const f = await fixture(t); const r = f.run(publishScript, env);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  await assert.rejects(access(join(f.dir, 'release.json')));
  await assert.rejects(access(f.env.DOCKER_CONFIG));
});

test('failed anonymous pull never logs in or executes the application', {skip: !canShellTest}, async t => {
  const f = await fixture(t); const r = f.run(pullScript, {PIN: `${f.env.IMAGE}@${digest}`, MOCK_PULL_FAIL: '1'});
  assert.notEqual(r.status, 0);
  const calls = (await readFile(f.env.MOCK_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [['pull', `${f.env.IMAGE}@${digest}`]]);
  await assert.rejects(access(f.env.DOCKER_CONFIG));
});


test('smoke executes only the pulled digest with no network, credentials or host mounts', {skip: !canShellTest}, async t => {
  const f = await fixture(t);
  const pin = `${f.env.IMAGE}@${digest}`;
  const r = f.run(smokeScript, {PIN: pin, PACKAGE_TOKEN: '', DOCKER_CONFIG: ''});
  assert.equal(r.status, 0, r.stderr);
  const calls = (await readFile(f.env.MOCK_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
  const run = calls.find(a => a[0] === 'run');
  assert.ok(run); assert.equal(run.at(-1), pin);
  for (const [flag, value] of [['--pull', 'never'], ['--network', 'none'], ['--user', '1000:1000'],
    ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges']]) assert.equal(run[run.indexOf(flag) + 1], value);
  assert.ok(!run.some(a => /TOKEN|PASSWORD|SECRET|docker\.sock|--volume|--publish/.test(a)));
  assert.ok(calls.some(a => a[0] === 'exec' && a.includes('scripts/healthcheck.mjs')));
  assert.equal(calls.at(-1)[0], 'rm');
});

test('smoke rejects a different downloaded image before application execution', {skip: !canShellTest}, async t => {
  const f = await fixture(t); const r = f.run(smokeScript, {PIN: `${f.env.IMAGE}@${digest}`, MOCK_ID: `sha256:${'0'.repeat(64)}`});
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(await readFile(f.env.MOCK_LOG, 'utf8'), /"run"|"exec"/);
});
