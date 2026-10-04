import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { assertPolicy, assertRelease, assertCurrent, reviewedRelease, requireGate, SHA, DIGEST } from './contracts.mjs';
import { GitHub } from './github.mjs';
import { deployPreview } from './controller.mjs';
import { createHostAdapter } from './host-adapter.mjs';
import { REQUIRED_CAPABILITIES } from './controller.mjs';
import { invokeHost } from './host-protocol.mjs';

const root = resolve(import.meta.dirname, '../..');
const policy = JSON.parse(await readFile(resolve(root, 'deploy/preview/policy.json'), 'utf8'));
policy.trustedRevision = process.env.UNIVERSE_PREVIEW_TRUSTED_REVISION ?? policy.trustedRevision;
const command = process.argv[2];
const context = { repository: process.env.GITHUB_REPOSITORY, ref: process.env.GITHUB_REF, workflowSha: process.env.GITHUB_WORKFLOW_SHA, checkoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() };
const github = new GitHub({ token: process.env.GH_TOKEN, repository: policy.repository });
const output = async values => {
  for (const [key, value] of Object.entries(values)) {
    requireGate(!String(value).includes('\n'), 'INVALID_OUTPUT');
    await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
};
const readJson = async path => {
  const bytes = await readFile(path); requireGate(bytes.length <= 32768, 'OVERSIZED_RECORD');
  return JSON.parse(bytes.toString('utf8'));
};
assertPolicy(policy, context); // Intentionally blocks every operational command in the checked-in state.
if (command === 'request') {
  const event = await readJson(process.env.GITHUB_EVENT_PATH);
  requireGate(process.env.GITHUB_EVENT_NAME === 'pull_request_target', 'UNTRUSTED_REQUEST_EVENT');
  requireGate(event.pull_request?.head?.repo?.full_name === policy.repository, 'FOREIGN_PULL_REQUEST');
  const desired = await github.desired(policy);
  if (desired.kind === 'approved-baseline') await github.dispatch('preview-controller.yml', policy, { mode: 'approved-baseline' });
  else await github.dispatch('preview-build.yml', policy, { sha: desired.sha, tree: desired.tree, generation: desired.generation });
} else if (command === 'select') {
  requireGate(process.env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'UNTRUSTED_BUILD_EVENT');
  const event = await readJson(process.env.GITHUB_EVENT_PATH);
  const desired = await github.desired(policy);
  requireGate(desired.kind === 'pull-request', 'BUILD_NOT_SELECTED');
  assertCurrent({ ...event.inputs }, desired);
  requireGate(/^node:24[^@]*@sha256:[a-f0-9]{64}$/.test(policy.baseImage), 'BASE_IMAGE_NOT_PINNED');
  await writeFile(process.argv[3], JSON.stringify({ ...desired, controllerRevision: policy.trustedRevision, repository: policy.repository, image: policy.image, runId: Number(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) }));
  await output({ sha: desired.sha, tree: desired.tree, generation: desired.generation, image: policy.image, baseImage: policy.baseImage });
} else if (command === 'validate-build') {
  const record = await readJson(process.argv[3]);
  const desired = await github.desired(policy);
  assertCurrent(record, desired);
  requireGate(record.repository === policy.repository && record.controllerRevision === policy.trustedRevision && record.runId === Number(process.env.GITHUB_RUN_ID) && record.runAttempt === Number(process.env.GITHUB_RUN_ATTEMPT), 'BUILD_RECORD_MISMATCH');
  requireGate(SHA.test(record.sha) && SHA.test(record.tree), 'INVALID_SOURCE');
  await output({ image: policy.image, tag: `${policy.image}:sha-${record.sha}-run-${record.runId}-${record.runAttempt}`, sha: record.sha, tree: record.tree });
} else if (command === 'record') {
  const record = await readJson(process.argv[3]);
  assertCurrent(record, await github.desired(policy));
  requireGate(DIGEST.test(process.env.IMAGE_DIGEST), 'INVALID_DIGEST_PIN');
  // Reviewed schema compatibility lives in trusted policy, never in PR metadata.
  const compat = policy.compatibility.find(c => c.digest === process.env.IMAGE_DIGEST && c.reviewId);
  // Publication can precede compatibility approval; such releases cannot deploy.
  const release = { ...record, schemaVersion: 1, digest: process.env.IMAGE_DIGEST, pin: `${policy.image}@${process.env.IMAGE_DIGEST}`, schema: compat?.toSchema ?? 'unreviewed', checks: { check: 'passed', unit: 'passed', build: 'passed', package: 'passed', containerFiles: 'passed', imageSmoke: 'passed' } };
  await writeFile(process.argv[4], JSON.stringify(release, null, 2) + '\n');
} else if (command === 'controller') {
  const event = await readJson(process.env.GITHUB_EVENT_PATH);
  const desiredSource = { read: () => github.desired(policy) };
  let release;
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && event.inputs?.mode === 'approved-baseline') {
    const desired = await desiredSource.read();
    requireGate(desired.kind === 'approved-baseline', 'BASELINE_NOT_SELECTED');
    release = { ...policy.approvedBaseline.release, generation: desired.generation };
    await github.verifyBuildRun(release.runId, policy, release.controllerRevision, release.runAttempt);
    requireGate(release.digest === desired.digest && release.sha === desired.sha && release.tree === desired.tree, 'BASELINE_RELEASE_MISMATCH');
  } else {
    const desired = await desiredSource.read();
    let run;
    if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
      requireGate(event.inputs?.mode === 'reviewed-release' && desired.kind === 'pull-request', 'HUMAN_APPROVED_EXCEPTION_REQUIRED');
      const approved = reviewedRelease(policy, desired);
      run = await github.verifyBuildRun(approved.runId, policy, approved.controllerRevision, approved.runAttempt);
      release = await readJson(process.argv[3]);
      requireGate(release.digest === approved.digest, 'REVIEWED_DIGEST_MISMATCH');
    } else {
      requireGate(process.env.GITHUB_EVENT_NAME === 'workflow_run', 'UNTRUSTED_CONTROLLER_EVENT');
      run = await github.verifyBuildRun(event.workflow_run.id, policy, event.workflow_run.head_sha, event.workflow_run.run_attempt);
      release = await readJson(process.argv[3]);
    }
    requireGate(release.runId === run.id && release.runAttempt === run.run_attempt && release.controllerRevision === run.head_sha, 'RELEASE_RUN_MISMATCH');
    // A reviewed policy can approve a historical digest without rebuilding it.
    // Rebind only policy revision; never rebind label/force-push epoch or source.
    requireGate(release.epoch === desired.epoch && release.sha === desired.sha && release.tree === desired.tree, 'STALE_SELECTION');
    release = { ...release, generation: desired.generation };
  }
  assertRelease(release, policy);
  const reviewed = policy.compatibility.find(c => c.digest === release.digest && c.reviewId && c.toSchema);
  requireGate(reviewed, 'UPDATE_COMPATIBILITY_UNKNOWN');
  release = { ...release, schema: reviewed.toSchema };
  const source = await github.request(`/repos/${policy.repository}/git/commits/${release.sha}`);
  requireGate(source.tree.sha === release.tree, 'SOURCE_TREE_MISMATCH');
  const receipt = policy.hostAdapter === 'host-command'
    ? await invokeHost(policy, 'deploy', release)
    : await deployPreview({ policy, context, release, desiredSource, adapter: createHostAdapter(policy, process.env) });
  await writeFile(process.argv[4], JSON.stringify(receipt, null, 2) + '\n');
  requireGate(receipt.outcome === 'healthy', 'DEPLOYMENT_NOT_HEALTHY');
} else if (command === 'verify-upstream') {
  const event = await readJson(process.env.GITHUB_EVENT_PATH);
  let run;
  if (process.env.GITHUB_EVENT_NAME === 'workflow_run') {
    run = await github.verifyBuildRun(event.workflow_run.id, policy, event.workflow_run.head_sha, event.workflow_run.run_attempt);
  } else {
    requireGate(process.env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'UNTRUSTED_CONTROLLER_EVENT');
    if (event.inputs?.mode === 'reviewed-release') {
      const desired = await github.desired(policy);
      requireGate(desired.kind === 'pull-request', 'BASELINE_NOT_SELECTED');
      const approved = reviewedRelease(policy, desired);
      run = await github.verifyBuildRun(approved.runId, policy, approved.controllerRevision, approved.runAttempt);
    } else requireGate(event.inputs?.mode === 'approved-baseline', 'UNTRUSTED_CONTROLLER_EVENT');
  }
  const capabilities = policy.hostAdapter === 'host-command'
    ? await invokeHost(policy, 'capabilities')
    : await createHostAdapter(policy, {}).capabilities();
  requireGate(REQUIRED_CAPABILITIES.every(c => capabilities.includes(c)), 'HOST_PREFLIGHT_UNIMPLEMENTED', 'No verified live host evidence adapter exists; refusing credentialed job');
  await output({ ready: 'true', artifactNeeded: !!run, releaseRun: run?.id ?? '', releaseAttempt: run?.run_attempt ?? '' });
} else if (command === 'gate') {
  await output({ enabled: 'true' });
} else throw new Error('Unknown preview command');
