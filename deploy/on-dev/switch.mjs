import { writeFileSync, renameSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { REPOSITORY, APP, ORIGIN, SHA, DIGEST, validateSelected, identity, requireGate, GateError } from './contracts.mjs';
import { github } from './github.mjs';
import { coolify, publicSite } from './coolify.mjs';

export function checkBaseline(health, selected, before, baseline) {
  requireGate(health?.ok === true && health.persistence === 'sqlite', 'PREVIOUS_HEALTH_NOT_VERIFIED');
  if (health.build != null) {
    requireGate(health.build.compatibility === selected.compatibility, 'COMPATIBILITY_REVIEW_REQUIRED');
    return 'live-compatible-build';
  }
  // One explicit bootstrap of an older release without build metadata. This is
  // owner-supplied evidence, not runtime digest verification by this controller.
  requireGate(baseline?.schemaVersion === 1 && baseline.configuredPin === before.configuredPin
    && baseline.compatibility === selected.compatibility && SHA.test(baseline.sourceRevision)
    && baseline.ownerVerifiedBackup === true && baseline.ownerVerifiedRunningDigest === true
    && Number.isFinite(Date.parse(baseline.verifiedAt)), 'BASELINE_ACTIVATION_REQUIRED');
  return 'owner-attested-initial-baseline';
}

// Dependencies are injected: tests never contact GitHub, GHCR or Coolify.
export async function switchDev({ selected, wanted, initialBaseline = null, runUrl }, io) {
  validateSelected(selected);
  requireGate(selected.sha === wanted.sha && selected.controllerSha === wanted.mainSha, 'RELEASE_SELECTION_MISMATCH');
  const receipt = { schemaVersion: 1, outcome: 'PREFLIGHT', repository: REPOSITORY, applicationUuid: APP,
    url: ORIGIN, selected, wanted, runUrl, startedAt: new Date(io.now()).toISOString(),
    runtimeDigestVerified: false, automaticRollback: false };
  let lockId = null, mutationAttempted = false;
  const save = () => io.save(receipt);
  save();
  try {
    await io.github.assertUnlocked();
    if (!await io.github.stillWanted(wanted)) { receipt.outcome = 'SUPERSEDED'; save(); return receipt; }
    await io.coolify.verifyVersion();
    await io.coolify.assertIdle();
    const before = await io.coolify.inspect();
    receipt.before = before; save();
    const health = await io.site.health();
    const accessBefore = await io.site.access();
    receipt.baselineEvidence = checkBaseline(health, selected, before, initialBaseline);
    // A rerun can verify the same already-running exact build without restarting it.
    if (before.configuredPin === selected.pin && health.build?.revision === selected.sha
      && health.build?.runId === selected.runId && health.build?.buildAttempt === selected.buildAttempt && health.build?.tree === selected.tree) {
      requireGate(before.status === 'running:healthy', 'APPLICATION_NOT_HEALTHY');
      receipt.observed = await io.site.verify(selected, accessBefore);
      receipt.outcome = 'ALREADY_CURRENT'; save(); return receipt;
    }
    requireGate(before.status === 'running:healthy', 'PREVIOUS_APPLICATION_NOT_HEALTHY');
    requireGate(await io.github.stillWanted(wanted), 'SUPERSEDED_BEFORE_LOCK');
    // Durable marker BEFORE the first Coolify write. A crash, cancellation,
    // failed write or lost response leaves a marker the next run refuses to cross.
    lockId = await io.github.begin(selected, before);
    receipt.githubDeploymentId = lockId; receipt.outcome = 'LOCKED'; save();
    await io.github.status(lockId, 'in_progress', runUrl);
    const fresh = await io.coolify.inspect();
    requireGate(fresh.configurationHash === before.configurationHash && fresh.configuredPin === before.configuredPin, 'TARGET_DRIFT_BEFORE_WRITE');
    await io.coolify.assertIdle();
    if (!await io.github.stillWanted(wanted)) {
      await io.github.status(lockId, 'inactive', runUrl);
      receipt.outcome = 'SUPERSEDED'; save(); return receipt;
    }
    mutationAttempted = true; receipt.outcome = 'IMAGE_WRITE_ATTEMPTED'; save();
    await io.coolify.setImage(selected.digest);
    const configured = await io.coolify.inspect();
    requireGate(configured.configurationHash === before.configurationHash && configured.configuredPin === selected.pin, 'TARGET_DRIFT_AFTER_WRITE');
    // If the label/head changed after PATCH, do not start the withdrawn image.
    // Configuration may have moved, so freeze for review rather than guessing.
    await io.coolify.assertIdle();
    requireGate(await io.github.stillWanted(wanted), 'WITHDRAWN_AFTER_IMAGE_WRITE');
    receipt.outcome = 'START_ATTEMPTED'; save();
    receipt.coolifyDeploymentId = await io.coolify.start(); save();
    receipt.deploymentStatus = await io.coolify.waitFor(receipt.coolifyDeploymentId); save();
    const after = await io.coolify.inspect();
    requireGate(after.configurationHash === before.configurationHash && after.configuredPin === selected.pin
      && after.status === 'running:healthy', 'TARGET_NOT_VERIFIED_AFTER_DEPLOY');
    receipt.after = after;
    receipt.observed = await io.site.verify(selected, accessBefore);
    // Selection can change during a slow deployment. Record the actual outcome,
    // but don't report a withdrawn preview as current intent or roll data back.
    receipt.stillDesired = await io.github.stillWanted(wanted);
    receipt.outcome = receipt.stillDesired ? 'DEPLOYMENT_VERIFIED' : 'DEPLOYED_BUT_SUPERSEDED';
    save();
    await io.github.status(lockId, 'success', runUrl);
    receipt.completedAt = new Date(io.now()).toISOString(); save();
    return receipt;
  } catch (error) {
    receipt.outcome = mutationAttempted ? 'RECOVERY_REVIEW_REQUIRED' : 'BLOCKED';
    receipt.error = error instanceof GateError ? error.code : 'UNEXPECTED_CONTROLLER_ERROR';
    receipt.coolifyMutationAttempted = mutationAttempted; save();
    if (lockId) {
      try { await io.github.status(lockId, mutationAttempted ? 'failure' : 'inactive', runUrl); }
      catch { receipt.statusWriteUnconfirmed = true; save(); }
    }
    // No automatic rollback, stop, database restore, account bootstrap or volume
    // writes. Image rollback cannot reverse startup migrations or user writes.
    throw Object.assign(new GateError(receipt.error), { receipt });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const receiptPath = env.RECEIPT_PATH || 'deployment-receipt.json';
  const save = receipt => { writeFileSync(`${receiptPath}.tmp`, `${JSON.stringify(receipt, null, 2)}\n`); renameSync(`${receiptPath}.tmp`, receiptPath); };
  try {
    requireGate(env.GITHUB_REPOSITORY === REPOSITORY && env.UNIVERSE_DEV_ENABLED === 'true', 'CONTROLLER_DISABLED');
    const selected = JSON.parse(readFileSync(env.RELEASE_PATH || 'release.json', 'utf8'));
    const wanted = JSON.parse(readFileSync(env.WANTED_PATH || 'wanted.json', 'utf8'));
    requireGate(selected.runId === env.GITHUB_RUN_ID && selected.sha === env.SOURCE_SHA
      && selected.controllerSha === env.CONTROLLER_SHA, 'ARTIFACT_RUN_BINDING_MISMATCH');
    const initialBaseline = env.INITIAL_ACTIVATION === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
      ? JSON.parse(env.UNIVERSE_DEV_INITIAL_BASELINE || 'null') : null;
    if (initialBaseline) {
      requireGate(wanted.pr === null && wanted.sha === wanted.mainSha, 'INITIAL_ACTIVATION_MUST_USE_MAIN');
      requireGate(Date.now() - Date.parse(initialBaseline.verifiedAt) < 24 * 60 * 60 * 1000
        && Date.parse(initialBaseline.verifiedAt) <= Date.now(), 'INITIAL_BASELINE_EXPIRED');
    }
    const result = await switchDev({ selected, wanted, initialBaseline,
      runUrl: `https://github.com/${REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` }, {
      now: Date.now, save, github: github({ token: env.GH_TOKEN }),
      coolify: coolify({ base: env.COOLIFY_BASE, token: env.COOLIFY_TOKEN, expectedVersion: env.COOLIFY_EXPECTED_VERSION }), site: publicSite()
    });
    console.log(result.outcome);
  } catch (error) {
    if (!error.receipt) save({ schemaVersion: 1, outcome: 'BLOCKED', error: error instanceof GateError ? error.code : 'INVALID_CONTROLLER_INPUT', runtimeDigestVerified: false });
    console.error(error instanceof GateError ? error.code : 'INVALID_CONTROLLER_INPUT'); process.exitCode = 1;
  }
}
