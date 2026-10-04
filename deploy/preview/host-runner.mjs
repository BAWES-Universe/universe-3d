import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { controllerCodeFingerprint } from './host-protocol.mjs';
import { assertRelease, fingerprint, requireGate } from './contracts.mjs';
import { GitHub } from './github.mjs';
import { CoolifyApplication } from './coolify.mjs';
import { LinuxHostEvidence } from './host-evidence.mjs';
import { CoolifyWithHostEvidenceAdapter } from './host-adapter.mjs';
import { deployPreview } from './controller.mjs';

export async function handleHostRequest(request, policy, env, { github, client, system, store } = {}) {
  requireGate(request.schemaVersion === 1 && ['capabilities', 'deploy'].includes(request.action), 'INVALID_HOST_REQUEST');
  requireGate(request.codeFingerprint === await controllerCodeFingerprint() && request.policyFingerprint === fingerprint(policy), 'HOST_IDENTITY_MISMATCH');
  requireGate(policy.enabled === true && policy.hostAdapter === 'host-command' && env.UNIVERSE_PREVIEW_HOST_LOCAL === 'OWNER_APPROVED', 'HOST_INSTALLATION_NOT_APPROVED');
  github ??= new GitHub({ token: env.GH_TOKEN, repository: policy.repository });
  client ??= new CoolifyApplication({ origin: policy.coolifyOrigin, applicationId: policy.applicationId, token: env.COOLIFY_TOKEN, apiProfile: policy.apiProfile });
  const host = new LinuxHostEvidence({ policy, client, github, ...(system ? { system } : {}), ...(store ? { store } : {}) });
  const adapter = new CoolifyWithHostEvidenceAdapter({ policy, client, host });
  if (request.action === 'capabilities') {
    await host.store.verifyDirectory();
    return adapter.capabilities();
  }
  requireGate(typeof env.COOLIFY_TOKEN === 'string' && env.COOLIFY_TOKEN.length > 0, 'EXISTING_DEPLOYMENT_AUTHORITY_MISSING');
  const release = assertRelease(request.release, policy);
  const authorities = [...(policy.reviewedReleases ?? []), ...(policy.approvedBaseline?.approvalId && policy.approvedBaseline.release ? [{ ...policy.approvedBaseline.release, approvalId: policy.approvedBaseline.approvalId }] : [])];
  requireGate(authorities.some(r => r.approvalId && ['runId', 'runAttempt', 'controllerRevision', 'sha', 'tree', 'digest', 'pin'].every(key => r[key] === release[key])), 'HOST_RELEASE_TUPLE_UNAPPROVED');
  // Verify the release again on the host, rather than trusting the caller's claim.
  await github.verifyBuildRun(release.runId, policy, release.controllerRevision, release.runAttempt);
  const source = await github.request(`/repos/${policy.repository}/git/commits/${release.sha}`);
  requireGate(source.tree.sha === release.tree, 'SOURCE_TREE_MISMATCH');
  const reviewed = policy.compatibility.find(c => c.digest === release.digest && c.reviewId && c.toSchema === release.schema);
  requireGate(reviewed, 'UPDATE_COMPATIBILITY_UNKNOWN');
  return deployPreview({ policy, release, context: { repository: policy.repository, ref: `refs/heads/${policy.defaultBranch}`, workflowSha: policy.trustedRevision, checkoutSha: policy.trustedRevision }, desiredSource: { read: () => github.desired(policy) }, adapter });
}

async function main() {
  requireGate(process.argv.length === 4 && process.argv[2] === '--config', 'HOST_CONFIG_REQUIRED');
  const path = resolve(process.argv[3]); const stat = await lstat(path);
  requireGate(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o022) === 0 && stat.size <= 65536 && await realpath(path) === path, 'UNSAFE_HOST_CONFIG');
  const policy = JSON.parse(await readFile(path, 'utf8'));
  policy.trustedRevision = process.env.UNIVERSE_PREVIEW_TRUSTED_REVISION ?? policy.trustedRevision;
  let input = ''; for await (const chunk of process.stdin) { input += chunk; requireGate(Buffer.byteLength(input) <= 65536, 'HOST_REQUEST_TOO_LARGE'); }
  const identity = { schemaVersion: 1, codeFingerprint: await controllerCodeFingerprint(), policyFingerprint: fingerprint(policy) };
  try { process.stdout.write(JSON.stringify({ ...identity, ok: true, result: await handleHostRequest(JSON.parse(input), policy, process.env) }) + '\n'); }
  catch (error) { process.stdout.write(JSON.stringify({ ...identity, ok: false, errorCode: error.code ?? 'HOST_OPERATION_FAILED' }) + '\n'); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('Host runner configuration or request rejected'); process.exitCode = 1; });
