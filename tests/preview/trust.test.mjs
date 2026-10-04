import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { assertPolicy, assertRelease, assertProvenance, desiredSelection } from '../../deploy/preview/contracts.mjs';
import { fixture, sha, digest } from './fixtures.mjs';
import { GitHub } from '../../deploy/preview/github.mjs';
const code = expected => ({ code: expected });
test('pipeline checked in disabled, no pinned authority and no invented host route', async () => {
  const policy = JSON.parse(await readFile(new URL('../../deploy/preview/policy.json', import.meta.url)));
  assert.equal(policy.enabled, false); assert.equal(policy.hostAdapter, 'unimplemented'); assert.equal(policy.trustedRevision, null);
  assert.throws(() => execFileSync(process.execPath, ['deploy/preview/cli.mjs', 'gate'], { cwd: new URL('../../', import.meta.url), stdio: 'pipe' }), e => e.stderr.toString().includes('PIPELINE_DISABLED'));
});
test('a PR merge ref or merely moving its workflow onto main is not trusted', () => {
  const f = fixture();
  assert.throws(() => assertPolicy(f.policy, { ...f.context, ref: 'refs/pull/4/merge' }), code('UNTRUSTED_REF'));
  assert.throws(() => assertPolicy(f.policy, { ...f.context, workflowSha: sha('f') }), code('UNTRUSTED_WORKFLOW_REVISION'));
  assert.throws(() => assertPolicy(f.policy, { ...f.context, checkoutSha: sha('f') }), code('UNTRUSTED_CHECKOUT'));
});
test('release records reject mutable tags, forged source/tree/checks, foreign controller and unsafe inputs', () => {
  const f = fixture();
  for (const change of [{ pin: `${f.policy.image}:latest` }, { sha: '$(curl attacker)' }, { tree: '' }, { digest: 'sha256:no' }, { checks: { check: 'passed' } }, { controllerRevision: sha('f') }, { runAttempt: 0 }, { generation: 'same-label' }]) assert.throws(() => assertRelease({ ...f.release, ...change }, f.policy));
});
function provenanceFixture() {
  const f = fixture(); const run = { repository: { full_name: f.policy.repository }, head_repository: { full_name: f.policy.repository }, path: '.github/workflows/preview-build.yml', event: 'workflow_dispatch', head_branch: 'main', head_sha: sha('a'), id: 123, run_attempt: 2, status: 'completed', conclusion: 'success' };
  const jobs = ['checks', 'build', 'publish', 'smoke', 'record'].map(name => ({ name, run_id: 123, run_attempt: 2, status: 'completed', conclusion: 'success' }));
  return { ...f, run, jobs };
}
test('exact successful trusted build provenance passes', () => { const f = provenanceFixture(); assertProvenance(f.run, f.jobs, f.policy, f.run.path); });
test('workflow name alone, PR event, fork, failed run and non-pinned workflow cannot authorize deploy', () => {
  const f = provenanceFixture();
  for (const change of [{ event: 'pull_request' }, { event: 'pull_request_target' }, { path: '.github/workflows/forged.yml' }, { head_branch: 'feature' }, { head_sha: sha('f') }, { head_repository: { full_name: 'attacker/fork' } }, { conclusion: 'failure' }]) assert.throws(() => assertProvenance({ ...f.run, ...change }, f.jobs, f.policy, f.run.path));
});
test('skipped or previous-attempt smoke is not proof', () => {
  const f = provenanceFixture();
  f.jobs[2].conclusion = 'skipped'; assert.throws(() => assertProvenance(f.run, f.jobs, f.policy, f.run.path), code('JOB_NOT_SUCCESSFUL'));
  f.jobs[2].conclusion = 'success'; f.jobs[2].run_attempt = 1; assert.throws(() => assertProvenance(f.run, f.jobs, f.policy, f.run.path), code('JOB_NOT_SUCCESSFUL'));
});
test('label remove/re-add cannot replay old generation even for same source', () => {
  const f = fixture(); const pulls = [{ number: 3, state: 'open', labels: ['on-dev'], repository: f.policy.repository, base: 'main', sha: sha('b'), tree: sha('c') }];
  const a = desiredSelection({ pulls, epoch: 1 }, f.policy); const b = desiredSelection({ pulls, epoch: 3 }, f.policy);
  assert.notEqual(a.generation, b.generation);
});
test('empty selection returns explicit approved baseline, not prior preview or latest main', () => {
  const f = fixture(); const selected = desiredSelection({ pulls: [], epoch: 4, baseline: f.policy.approvedBaseline }, f.policy);
  assert.equal(selected.digest, digest('0')); assert.equal(selected.kind, 'approved-baseline');
  assert.throws(() => desiredSelection({ pulls: [], epoch: 4 }, f.policy), code('APPROVED_BASELINE_MISSING'));
});
test('ambiguous labels and foreign fork fail closed', () => {
  const f = fixture(); const p = { number: 3, state: 'open', labels: ['on-dev'], repository: 'attacker/fork', base: 'main', sha: sha('b'), tree: sha('c') };
  assert.throws(() => desiredSelection({ pulls: [p], epoch: 1 }, f.policy), code('UNTRUSTED_PULL_REQUEST'));
  assert.throws(() => desiredSelection({ pulls: [p, p], epoch: 1 }, f.policy), code('AMBIGUOUS_SELECTION'));
});
test('GitHub scope validation prevents URL/path injection before network use', async () => {
  let count = 0; const api = new GitHub({ token: 'synthetic', repository: 'BAWES-Universe/universe-3d', fetcher: async () => { count++; throw Error('Unexpected'); } });
  await assert.rejects(api.request('https://attacker.invalid'), code('GITHUB_SCOPE_ESCAPE')); assert.equal(count, 0);
});
test('workflows are inert on ordinary pushes and credentials appear only in trusted controller', async () => {
  const files = await Promise.all(['request', 'build', 'controller'].map(f => readFile(new URL(`../../.github/workflows/preview-${f}.yml`, import.meta.url), 'utf8')));
  for (const content of files) {
    assert(!/^\s+push:/m.test(content)); assert(content.includes("vars.UNIVERSE_PREVIEW_ENABLED == 'OWNER_APPROVED'"));
    assert(content.includes('github.workflow_sha == vars.UNIVERSE_PREVIEW_TRUSTED_REVISION'));
    for (const action of content.matchAll(/uses: ([^\n]+)/g)) assert(/@[a-f0-9]{40}$/.test(action[1]));
    assert(!content.includes('secrets: inherit')); assert(!content.includes('cache: npm'));
  }
  assert(!files[0].includes('COOLIFY_TOKEN')); assert(!files[1].includes('COOLIFY_TOKEN'));
  assert.equal((files.join('').match(/packages: write/g) ?? []).length, 1);
  assert(files[2].includes('workflow_run:')); assert(files[2].includes('environment: universe-3d-preview'));
});
test('historical baseline provenance is allowed only by an explicit approved build revision', () => {
  const f = provenanceFixture(); const historical = sha('b');
  f.run.head_sha = historical;
  assert.throws(() => assertProvenance(f.run, f.jobs, f.policy, f.run.path, historical), code('UNTRUSTED_RUN_REVISION'));
  f.policy.approvedBuildRevisions = [historical];
  assertProvenance(f.run, f.jobs, f.policy, f.run.path, historical);
});
test('historical attempt reads that attempt, never the latest rerun', async () => {
  const f = provenanceFixture(); const requested = [];
  const api = new GitHub({ token: 'synthetic', repository: f.policy.repository, fetcher: async url => {
    requested.push(url);
    return { ok: true, status: 200, json: async () => url.includes('/jobs?') ? { jobs: f.jobs } : f.run };
  } });
  await api.verifyBuildRun(123, f.policy, f.run.head_sha, 2);
  assert(requested[0].endsWith('/actions/runs/123/attempts/2'));
  assert(requested[1].includes('/attempts/2/jobs?'));
});
test('reviewed-release dispatch is narrowly reachable and has no arbitrary digest input', async () => {
  const { reviewedRelease } = await import('../../deploy/preview/contracts.mjs');
  const f = fixture(); const desired = { ...f.desired, epoch: 8 };
  const approved = { ...f.release, epoch: 8, approvalId: 'explicit-review' };
  f.policy.reviewedReleases = [approved];
  assert.equal(reviewedRelease(f.policy, desired).digest, f.release.digest);
  assert.throws(() => reviewedRelease(f.policy, { ...desired, epoch: 9 }), code('REVIEWED_RELEASE_MISSING_OR_AMBIGUOUS'));
  f.policy.reviewedReleases.push(approved);
  assert.throws(() => reviewedRelease(f.policy, desired), code('REVIEWED_RELEASE_MISSING_OR_AMBIGUOUS'));
  const workflow = await readFile(new URL('../../.github/workflows/preview-controller.yml', import.meta.url), 'utf8');
  assert(workflow.includes('options: [approved-baseline, reviewed-release]'));
  assert(workflow.includes('needs.provenance.outputs.releaseRun'));
  assert(!/^\s+(?:digest|runId|sha):$/m.test(workflow));
});
test('unrelated issue events do not invalidate a preview selection', async () => {
  const f = fixture(); f.policy.approvedBaseline.selectionEpoch = 1;
  const events = [{ id: 2, event: 'labeled', label: { name: 'on-dev' }, issue: { pull_request: {} } }, { id: 9999, event: 'labeled', label: { name: 'bug' }, issue: {} }];
  const pr = { number: 1, state: 'open', labels: [{ name: 'on-dev' }], head: { sha: f.release.sha, repo: { full_name: f.policy.repository } }, base: { ref: 'main' } };
  const api = new GitHub({ token: 'synthetic', repository: f.policy.repository, fetcher: async url => ({ ok: true, status: 200, json: async () => url.includes('/issues/events') ? events : url.includes('/pulls?') ? [pr] : url.includes('/timeline') ? [] : { tree: { sha: f.release.tree } } }) });
  const desired = await api.desired(f.policy); assert.equal(desired.epoch, 2);
});
