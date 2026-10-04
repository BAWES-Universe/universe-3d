import { assertCurrent, assertFresh, assertPolicy, assertRelease, requireGate, GateError, fingerprint } from './contracts.mjs';
import { assertStorageRequirements, assertReaderCompatible, reviewedReader, assertReaderTransition, mergeRequirements } from './image-reader.mjs';

export const REQUIRED_CAPABILITIES = Object.freeze([
  'exclusive-fenced-resource-lease', 'fenced-asynchronous-deployments', 'deployment-queue-drained', 'durable-cas-state', 'installed-version',
  'credential-resource-inventory', 'fresh-host-capacity', 'complete-volume-mount-inventory',
  'all-writer-termination', 'app-stop-no-cleanup', 'digest-pinned-start',
  'running-digest-and-health', 'database-schema', 'consistent-retained-backup',
  'database-reader-requirements', 'immutable-image-reader-descriptors'
]);

function storageRequirements(database) {
  requireGate(database.storageEvidenceKind === 'sqlite-metadata-and-image-rows', 'IMAGE_STORAGE_EVIDENCE_UNPROVEN');
  return assertStorageRequirements(database.storageCompatibility);
}
function assertFloorRetained(previous, actual) {
  if (previous) {
    assertStorageRequirements(previous);
    requireGate(previous.requiredReaderCapabilities.every(cap => actual.requiredReaderCapabilities.includes(cap)), 'IMAGE_STORAGE_FLOOR_REGRESSED');
  }
}

export function inspectPreflight(evidence, policy, state, now) {
  const fresh = item => assertFresh(item, now, policy.maxEvidenceAgeMs);
  for (const key of ['version', 'scope', 'capacity', 'mounts', 'database']) fresh(evidence[key]);
  requireGate(typeof evidence.version.value === 'string' && evidence.version.value.length > 0, 'INSTALLED_VERSION_UNKNOWN');
  requireGate(evidence.scope.applicationId === policy.applicationId && evidence.scope.resources.includes(policy.applicationId), 'WRONG_RESOURCE_SCOPE');
  requireGate(fingerprint([...evidence.scope.resources].sort()) === fingerprint([...policy.acceptedCredentialResources].sort()), 'UNAPPROVED_CREDENTIAL_SCOPE');
  requireGate(evidence.capacity.freeMemoryBytes >= policy.minimumFreeMemoryBytes && evidence.capacity.freeDiskBytes >= policy.minimumFreeDiskBytes && evidence.capacity.reservedCapacityExcluded === true, 'INSUFFICIENT_HOST_CAPACITY');
  requireGate(evidence.mounts.completeHostInventory === true && evidence.mounts.volumeId === policy.volumeId && evidence.mounts.uid === 1000 && evidence.mounts.gid === 1000 && evidence.mounts.mode === '0700' && evidence.mounts.localDurableStorage === true, 'MOUNT_OWNERSHIP_UNPROVEN');
  requireGate(evidence.mounts.containers.every(c => c.applicationId === policy.applicationId && c.volumeId === policy.volumeId) && evidence.mounts.unmanagedWriters === 0, 'SHARED_VOLUME_WRITER');
  requireGate(evidence.database.volumeId === policy.volumeId && evidence.database.schema === state.current.schema, 'DATABASE_STATE_MISMATCH');
  assertFloorRetained(state.current.storageCompatibility, storageRequirements(evidence.database));
}
function assertTerminated(proof, policy, now) {
  assertFresh(proof, now, policy.maxEvidenceAgeMs);
  requireGate(proof.volumeId === policy.volumeId && proof.completeHostInventory === true && proof.unmanagedWriters === 0 && proof.containers.every(c => c.running === false && c.restartDisabled === true) && proof.writerCount === 0 && proof.pendingDeploymentCount === 0 && proof.staleStartsFenced === true, 'WRITER_TERMINATION_UNPROVEN');
  // Queued stop, a free SQLite lock, quiet WAL, closed port and a stored app status are insufficient.
  requireGate(proof.evidenceKind === 'host-process-and-mount-inventory', 'WRITER_TERMINATION_UNPROVEN');
}
function compatibility(policy, state, release) {
  const migration = policy.compatibility.find(c => c.digest === release.digest && c.fromSchema === state.current.schema && c.toSchema === release.schema);
  const previous = policy.compatibility.find(c => c.digest === state.current.digest && c.readWriteSchemas?.includes(release.schema));
  requireGate(migration?.reviewId && migration.intermediateSchemas?.length > 0 && migration.intermediateSchemas.includes(state.current.schema) && migration.intermediateSchemas.includes(release.schema), 'UPDATE_COMPATIBILITY_UNKNOWN');
  requireGate(previous?.reviewId && migration.intermediateSchemas.every(s => previous.readWriteSchemas.includes(s)), 'ROLLBACK_COMPATIBILITY_UNKNOWN');
  return { migration, previous };
}
function assertRunning(actual, release, policy, now, reader, previousRequirements) {
  assertFresh(actual, now, policy.maxEvidenceAgeMs);
  requireGate(actual.applicationId === policy.applicationId && actual.volumeId === policy.volumeId && actual.runningDigest === release.digest && actual.sourceSha === release.sha && actual.healthy === true && actual.schema === release.schema && actual.replicas === 1 && actual.writerCount === 1, 'RUNTIME_VERIFICATION_FAILED');
  const storage = storageRequirements(actual);
  assertFloorRetained(previousRequirements, storage);
  assertReaderCompatible(storage, reader.descriptor);
  return storage;
}

/** Pure orchestration: concrete live adapters are deliberately not supplied.
 * Every adapter method is narrowly application/volume-scoped. No PR code or
 * executable artifact is ever evaluated by this controller.
 */
export async function deployPreview({ policy, context, release, desiredSource, adapter, now = Date.now, mode = 'routine' }) {
  assertPolicy(policy, context);
  assertRelease(release, policy);
  requireGate(mode === 'routine', 'HUMAN_APPROVED_EXCEPTION_REQUIRED', 'Explicit-digest and reset operations require a separate approved operator procedure');
  const capabilities = await adapter.capabilities();
  requireGate(REQUIRED_CAPABILITIES.every(c => capabilities.includes(c)), 'HOST_CAPABILITY_MISSING', 'Live host preflight/lease adapter is not implemented or lacks required evidence');
  requireGate(policy.applicationId && policy.volumeId && policy.acceptedCredentialResources.length, 'ISOLATION_NOT_CONFIGURED');
  return adapter.withExclusiveLease(policy.applicationId, async lease => {
    const guard = async () => { await lease.assertHeld(); assertCurrent(release, await desiredSource.read()); };
    await guard(); // Fresh selection, AFTER acquiring the resource lock.
    let state = await adapter.readState(lease);
    requireGate(state && !state.frozen, 'PREVIEW_FROZEN');
    requireGate(state.approvedBaseline?.digest === policy.approvedBaseline?.digest && state.approvedBaseline?.approvalId === policy.approvedBaseline?.approvalId, 'BASELINE_POLICY_MISMATCH');
    requireGate(state.current?.digest && state.current?.schema, 'PRIOR_HEALTHY_RELEASE_MISSING');
    requireGate(state.current.pin === `${policy.image}@${state.current.digest}`, 'PRIOR_PIN_MISMATCH');
    const key = `${release.runId}:${release.runAttempt}:${release.digest}:${release.generation}`;
    requireGate(!state.consumed.includes(key), 'REPLAYED_RELEASE');
    // Reject rollback-incompatible releases before stop, patch, snapshot, start or reset.
    compatibility(policy, state, release);
    const candidateReader = reviewedReader(policy, release, await adapter.readImageReaderDescriptor(release, lease));
    const previousReader = reviewedReader(policy, state.current, await adapter.readImageReaderDescriptor(state.current, lease));
    const preflight = await adapter.preflight(lease);
    inspectPreflight(preflight, policy, state, now());
    let observedRequirements = storageRequirements(preflight.database);
    const retainRequirements = database => {
      assertFresh(database, now(), policy.maxEvidenceAgeMs);
      requireGate(database.volumeId === policy.volumeId, 'WRONG_RECOVERY_VOLUME');
      const actual = storageRequirements(database);
      assertFloorRetained(observedRequirements, actual);
      observedRequirements = actual;
      return actual;
    };
    const possibleRequirements = assertReaderTransition(observedRequirements, candidateReader, previousReader);
    const prior = structuredClone(state.current);
    const receipt = { schemaVersion: 1, generation: release.generation, requested: release.pin, previousHealthy: prior, approvedBaseline: state.approvedBaseline, phase: 'preflight', outcome: 'pending', evidence: { version: preflight.version.value, imageReaders: { candidateReview: candidateReader.reviewId, previousReview: previousReader.reviewId, candidateBlob: candidateReader.blobSha, previousBlob: previousReader.blobSha, observedRequirements, possibleRequirements } }, mutations: [] };
    // Persist the intent/freeze BEFORE the first host mutation. A killed runner
    // leaves a durable closed gate, not an apparently healthy old state.
    const save = async next => {
      await lease.assertHeld();
      const desiredState = { ...next, version: state.version + 1 };
      try { await adapter.commitState(desiredState, state.version, lease); }
      catch (error) {
        // CAS success followed by a lost response is not a deployment failure.
        // Reconcile exact idempotent operation state before deciding to recover.
        let observed;
        try { observed = await adapter.readState(lease); }
        catch { throw new GateError('STATE_WRITE_UNCONFIRMED'); }
        requireGate(fingerprint(observed) === fingerprint(desiredState), 'STATE_WRITE_UNCONFIRMED');
      }
      state = desiredState;
    };
    await save({ ...state, frozen: true, inProgress: { operationId: key, generation: release.generation, requested: release.pin, previousHealthy: prior }, receipt });
    let mutationStarted = false;
    const mutate = async (operation, fn) => { await lease.assertHeld(); mutationStarted = true; receipt.mutations.push(operation); return fn(); };
    const stopAndProve = async () => {
      await mutate('stop', () => adapter.stop({ applicationId: policy.applicationId, docker_cleanup: false }, lease));
      assertTerminated(await adapter.waitForAllWritersTerminated(policy.volumeId, lease), policy, now());
    };
    try {
      await guard();
      receipt.phase = 'stop';
      await stopAndProve();
      await guard();
      const backup = await adapter.backupStoppedVolume(policy.volumeId, lease);
      assertFresh(backup, now(), policy.maxEvidenceAgeMs);
      requireGate(backup.volumeId === policy.volumeId && backup.consistent === true && backup.retained === true && backup.reference, 'BACKUP_UNPROVEN');
      receipt.backup = backup.reference;
      receipt.phase = 'start';
      await guard();
      assertTerminated(await adapter.waitForAllWritersTerminated(policy.volumeId, lease), policy, now());
      // Read actual storage after the last writer has gone, immediately before
      // start. Running-process preflight alone could miss its final floor write.
      const stopped = await adapter.preflight(lease);
      inspectPreflight(stopped, policy, state, now());
      assertFloorRetained(observedRequirements, storageRequirements(stopped.database));
      observedRequirements = storageRequirements(stopped.database);
      assertReaderTransition(observedRequirements, candidateReader, previousReader);
      await guard();
      inspectPreflight(stopped, policy, state, now());
      await mutate('start-pinned', () => adapter.startPinned({ applicationId: policy.applicationId, volumeId: policy.volumeId, pin: release.pin, replicas: 1 }, lease));
      const actual = await adapter.verifyRunning(lease);
      // Retain valid storage evidence even when another runtime check fails.
      // Recovery must not forget a floor observed after candidate startup.
      retainRequirements(actual);
      const actualRequirements = assertRunning(actual, release, policy, now(), candidateReader, observedRequirements);
      assertReaderCompatible(actualRequirements, previousReader.descriptor);
      await guard();
      receipt.phase = 'complete'; receipt.outcome = 'healthy';
      await save({ ...state, frozen: false, inProgress: null, current: { digest: release.digest, pin: release.pin, sha: release.sha, tree: release.tree, schema: release.schema, storageCompatibility: actualRequirements }, previousHealthy: prior, consumed: [...state.consumed, key], receipt });
      return receipt;
    } catch (error) {
      receipt.error = error.code ?? 'ADAPTER_FAILURE';
      // Never roll back against uncertain durable state. If the final commit
      // landed, the verified candidate agrees with it. If it did not, the
      // pre-mutation freeze remains. Reconciliation needs the same fenced lock.
      if (error.code === 'STATE_WRITE_UNCONFIRMED') {
        receipt.outcome = 'state-reconciliation-required'; receipt.durableReceipt = 'unconfirmed'; return receipt;
      }
      if (!mutationStarted) throw error;
      // Recovery is itself serialized and fenced. If termination, DB schema,
      // lease or compatibility is uncertain, freeze; never blindly start a writer.
      try {
        await lease.assertHeld();
        await stopAndProve();
        const database = await adapter.readDatabaseSchema(lease);
        assertFresh(database, now(), policy.maxEvidenceAgeMs);
        requireGate(database.volumeId === policy.volumeId, 'WRONG_RECOVERY_VOLUME');
        const recoveryRequirements = retainRequirements(database);
        assertReaderCompatible(mergeRequirements(recoveryRequirements, previousReader.possible), previousReader.descriptor);
        const previous = policy.compatibility.find(c => c.digest === prior.digest && c.reviewId && c.readWriteSchemas?.includes(database.schema));
        requireGate(previous, 'RECOVERY_COMPATIBILITY_UNKNOWN');
        assertTerminated(await adapter.waitForAllWritersTerminated(policy.volumeId, lease), policy, now());
        const recovery = await adapter.preflight(lease);
        inspectPreflight(recovery, policy, { ...state, current: { ...prior, schema: database.schema } }, now());
        const finalRequirements = retainRequirements(recovery.database);
        assertReaderCompatible(mergeRequirements(finalRequirements, previousReader.possible), previousReader.descriptor);
        await mutate('rollback-pinned', () => adapter.startPinned({ applicationId: policy.applicationId, volumeId: policy.volumeId, pin: prior.pin, replicas: 1 }, lease));
        const recovered = await adapter.verifyRunning(lease);
        retainRequirements(recovered);
        const actualRequirements = assertRunning(recovered, { ...prior, schema: database.schema }, policy, now(), previousReader, finalRequirements);
        receipt.outcome = 'rolled-back';
        await save({ ...state, frozen: true, inProgress: null, current: { ...prior, schema: database.schema, storageCompatibility: actualRequirements }, consumed: [...state.consumed, key], receipt });
      } catch (recoveryError) {
        receipt.outcome = 'frozen-recovery-uncertain'; receipt.recoveryError = recoveryError.code ?? 'ADAPTER_FAILURE';
        // A lost fence prevents even state mutation. Do not conceal this behind success.
        try { await lease.assertHeld(); await save({ ...state, frozen: true, consumed: [...state.consumed, key], receipt }); }
        catch { receipt.durableReceipt = 'unconfirmed'; }
      }
      return receipt;
    }
  });
}
