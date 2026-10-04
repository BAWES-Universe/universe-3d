import { lstat, realpath, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertRelease, fingerprint, requireGate } from './contracts.mjs';
import { CoolifyApplication } from './coolify.mjs';
import { LinuxHostEvidence } from './host-evidence.mjs';
import { CoolifyWithHostEvidenceAdapter } from './host-adapter.mjs';
import { inspectPreflight } from './controller.mjs';
import { GitHub } from './github.mjs';
import { reviewedReader, assertReaderCompatible, mergeRequirements } from './image-reader.mjs';

/** Local operator-only setup step. Not exposed by the command protocol/workflow.
 * Establishes initial state only after observing the already-running approved
 * baseline. It never starts/stops an app or replaces an existing ledger.
 */
export async function initializeHostState(policy, env, { client, github, system, store } = {}) {
  requireGate(policy.enabled && policy.hostLocal?.stateInitializationApprovalId && env.UNIVERSE_PREVIEW_HOST_LOCAL === 'OWNER_APPROVED' && env.COOLIFY_TOKEN, 'HOST_INITIALIZATION_NOT_APPROVED');
  const baseline = assertRelease(policy.approvedBaseline?.release, policy);
  requireGate(policy.approvedBaseline.approvalId && ['sha', 'tree', 'digest'].every(key => policy.approvedBaseline[key] === baseline[key]), 'BASELINE_RELEASE_MISMATCH');
  client ??= new CoolifyApplication({ origin: policy.coolifyOrigin, applicationId: policy.applicationId, token: env.COOLIFY_TOKEN, apiProfile: policy.apiProfile });
  github ??= new GitHub({ token: env.GH_TOKEN, repository: policy.repository });
  const host = new LinuxHostEvidence({ policy, client, github, ...(system ? { system } : {}), ...(store ? { store } : {}) });
  const adapter = new CoolifyWithHostEvidenceAdapter({ policy, host, client }); await adapter.capabilities();
  return host.withExclusiveLease(policy.applicationId, async lease => {
    try { await host.readState(lease); requireGate(false, 'HOST_STATE_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const current = { digest: baseline.digest, pin: baseline.pin, sha: baseline.sha, tree: baseline.tree, schema: baseline.schema };
    const reader = reviewedReader(policy, baseline, await adapter.readImageReaderDescriptor(baseline, lease));
    const evidence = await adapter.preflight(lease); inspectPreflight(evidence, policy, { current }, Date.now());
    assertReaderCompatible(mergeRequirements(evidence.database.storageCompatibility, reader.possible), reader.descriptor);
    const actual = await adapter.verifyRunning(lease);
    requireGate(actual.runningDigest === current.digest && actual.sourceSha === current.sha && actual.schema === current.schema && actual.healthy && actual.replicas === 1 && actual.writerCount === 1, 'BASELINE_RUNTIME_MISMATCH');
    requireGate(actual.storageEvidenceKind === 'sqlite-metadata-and-image-rows', 'IMAGE_STORAGE_EVIDENCE_UNPROVEN');
    assertReaderCompatible(mergeRequirements(actual.storageCompatibility, reader.possible), reader.descriptor);
    requireGate(evidence.database.storageCompatibility.requiredReaderCapabilities.every(cap => actual.storageCompatibility.requiredReaderCapabilities.includes(cap)), 'IMAGE_STORAGE_FLOOR_REGRESSED');
    current.storageCompatibility = actual.storageCompatibility;
    await host.store.write('state.json', { version: 1, frozen: false, inProgress: null, current, approvedBaseline: policy.approvedBaseline, consumed: [], initialization: { approvalId: policy.hostLocal.stateInitializationApprovalId, policyFingerprint: fingerprint(policy), observedAt: Date.now() } });
    return { initialized: true, digest: current.digest, applicationId: policy.applicationId };
  });
}
async function main() {
  requireGate(process.argv.length === 4 && process.argv[2] === '--config', 'HOST_CONFIG_REQUIRED');
  const path = resolve(process.argv[3]), stat = await lstat(path);
  requireGate(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o022) === 0 && stat.size <= 65536 && await realpath(path) === path, 'UNSAFE_HOST_CONFIG');
  const policy = JSON.parse(await readFile(path, 'utf8')); policy.trustedRevision = process.env.UNIVERSE_PREVIEW_TRUSTED_REVISION ?? policy.trustedRevision;
  console.log(JSON.stringify(await initializeHostState(policy, process.env)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.code ?? 'HOST_INITIALIZATION_FAILED'); process.exitCode = 1; });
