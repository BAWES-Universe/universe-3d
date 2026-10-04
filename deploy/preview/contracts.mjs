import { createHash } from 'node:crypto';
export const SHA = /^[a-f0-9]{40}$/;
export const DIGEST = /^sha256:[a-f0-9]{64}$/;
export class GateError extends Error {
  constructor(code, message = code) { super(message); this.name = 'GateError'; this.code = code; }
}
export function requireGate(condition, code, message) {
  if (!condition) throw new GateError(code, message);
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');
export function assertPolicy(policy, context) {
  requireGate(policy.enabled === true, 'PIPELINE_DISABLED', 'Separate owner-approved activation is required');
  requireGate(SHA.test(policy.trustedRevision), 'TRUSTED_REVISION_MISSING');
  requireGate(context.repository === policy.repository, 'WRONG_REPOSITORY');
  requireGate(context.ref === `refs/heads/${policy.defaultBranch}`, 'UNTRUSTED_REF');
  requireGate(context.workflowSha === policy.trustedRevision, 'UNTRUSTED_WORKFLOW_REVISION');
  requireGate(context.checkoutSha === policy.trustedRevision, 'UNTRUSTED_CHECKOUT');
  requireGate(/^ghcr\.io\/[a-z0-9-]+\/[a-z0-9._-]+$/.test(policy.image), 'INVALID_IMAGE');
}
export function assertRelease(release, policy) {
  requireGate(release?.schemaVersion === 1 && release.repository === policy.repository, 'INVALID_RELEASE');
  requireGate(SHA.test(release.sha) && SHA.test(release.tree), 'INVALID_SOURCE');
  requireGate(DIGEST.test(release.digest) && release.image === policy.image && release.pin === `${policy.image}@${release.digest}`, 'INVALID_DIGEST_PIN');
  requireGate([policy.trustedRevision, ...(policy.approvedBuildRevisions ?? [])].includes(release.controllerRevision), 'UNTRUSTED_RELEASE');
  requireGate(/^[a-f0-9]{64}$/.test(release.generation), 'INVALID_GENERATION');
  requireGate(Number.isSafeInteger(release.runId) && release.runId > 0 && Number.isSafeInteger(release.runAttempt) && release.runAttempt > 0, 'INVALID_RUN');
  requireGate(['check', 'unit', 'build', 'package', 'containerFiles', 'imageSmoke'].every(k => release.checks?.[k] === 'passed'), 'CHECKS_INCOMPLETE');
  requireGate(typeof release.schema === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(release.schema), 'UNKNOWN_DATABASE_SCHEMA');
  return release;
}
// All values here come from fresh GitHub API reads, not an incoming event/artifact.
// Include the monotonic label-event epoch even when A -> B -> A selects the same SHA.
export function desiredSelection({ pulls, epoch, baseline }, policy) {
  requireGate(Number.isSafeInteger(epoch) && epoch > 0, 'SELECTION_EPOCH_MISSING');
  const selected = pulls.filter(p => p.state === 'open' && p.labels.includes(policy.label));
  requireGate(selected.length <= 1, 'AMBIGUOUS_SELECTION', 'Only one open pull request may carry on-dev');
  let target;
  if (selected.length) {
    const p = selected[0];
    requireGate(p.repository === policy.repository && p.base === policy.defaultBranch && SHA.test(p.sha) && SHA.test(p.tree), 'UNTRUSTED_PULL_REQUEST');
    target = { kind: 'pull-request', pr: p.number, sha: p.sha, tree: p.tree };
  } else {
    requireGate(baseline && baseline.approvalId && SHA.test(baseline.sha) && SHA.test(baseline.tree) && DIGEST.test(baseline.digest), 'APPROVED_BASELINE_MISSING');
    target = { kind: 'approved-baseline', pr: null, sha: baseline.sha, tree: baseline.tree, digest: baseline.digest, approvalId: baseline.approvalId };
  }
  return { ...target, epoch, generation: fingerprint({ epoch, target, policyRevision: policy.trustedRevision }) };
}
export function assertProvenance(run, jobs, policy, expectedPath, buildRevision = policy.trustedRevision) {
  requireGate(run.repository?.full_name === policy.repository && run.head_repository?.full_name === policy.repository, 'FOREIGN_RUN');
  requireGate(run.path === expectedPath && run.event === 'workflow_dispatch', 'UNTRUSTED_RUN_EVENT');
  requireGate([policy.trustedRevision, ...(policy.approvedBuildRevisions ?? [])].includes(buildRevision) && run.head_branch === policy.defaultBranch && run.head_sha === buildRevision, 'UNTRUSTED_RUN_REVISION');
  requireGate(run.status === 'completed' && run.conclusion === 'success', 'RUN_NOT_SUCCESSFUL');
  requireGate(Number.isSafeInteger(run.id) && Number.isSafeInteger(run.run_attempt), 'INVALID_RUN');
  // Only the jobs for this exact attempt count; skipped is not successful.
  for (const name of ['checks', 'build', 'publish', 'smoke', 'record']) {
    const matches = jobs.filter(j => j.name === name && j.run_id === run.id && j.run_attempt === run.run_attempt);
    requireGate(matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === 'success', 'JOB_NOT_SUCCESSFUL', `Missing successful ${name} in exact run attempt`);
  }
}
export function assertCurrent(release, desired) {
  requireGate(release.generation === desired.generation && release.sha === desired.sha && release.tree === desired.tree, 'STALE_SELECTION');
  if (desired.digest) requireGate(release.digest === desired.digest, 'BASELINE_DIGEST_MISMATCH');
}
export function assertFresh(evidence, now, maxAge, code = 'STALE_EVIDENCE') {
  requireGate(Number.isSafeInteger(evidence?.observedAt) && evidence.observedAt <= now && now - evidence.observedAt <= maxAge, code);
}

// An already published release is reusable only with an explicit trusted approval
// of its immutable identity AND the still-current selection epoch/source.
export function reviewedRelease(policy, desired) {
  const matches = (policy.reviewedReleases ?? []).filter(r => r.sha === desired.sha && r.tree === desired.tree && r.epoch === desired.epoch);
  requireGate(matches.length === 1, 'REVIEWED_RELEASE_MISSING_OR_AMBIGUOUS');
  const release = matches[0];
  requireGate(release.approvalId && DIGEST.test(release.digest) && Number.isSafeInteger(release.runId) && release.runId > 0 && Number.isSafeInteger(release.runAttempt) && release.runAttempt > 0 && [policy.trustedRevision, ...(policy.approvedBuildRevisions ?? [])].includes(release.controllerRevision), 'INVALID_REVIEWED_RELEASE');
  return release;
}
