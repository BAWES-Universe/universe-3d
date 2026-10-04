import { REQUIRED_CAPABILITIES } from '../../deploy/preview/controller.mjs';
import { requireGate } from '../../deploy/preview/contracts.mjs';
import { descriptorBlobSha, IMAGE_READER_PATH, IMAGE_SIZE_CAPABILITY } from '../../deploy/preview/image-reader.mjs';
export const sha = c => c.repeat(40), digest = c => `sha256:${c.repeat(64)}`;
export const storage = (required = []) => ({ version: 1, requiredReaderCapabilities: required });
export function readerEvidence(target, descriptor = { version: 1, readerCapabilities: [IMAGE_SIZE_CAPABILITY] }) {
  return { digest: target.digest, sha: target.sha, tree: target.tree, path: IMAGE_READER_PATH, blobSha: descriptorBlobSha(Buffer.from(JSON.stringify(descriptor))), descriptor };
}
export function fixture() {
  const now = 100000;
  const policy = {
    enabled: true, repository: 'BAWES-Universe/universe-3d', defaultBranch: 'main', trustedRevision: sha('a'), label: 'on-dev', image: 'ghcr.io/bawes-universe/universe-3d-preview', applicationId: 'isolated-preview', volumeId: 'isolated-data', acceptedCredentialResources: ['isolated-preview'], maxEvidenceAgeMs: 30000, minimumFreeMemoryBytes: 1000, minimumFreeDiskBytes: 1000,
    approvedBaseline: { digest: digest('0'), approvalId: 'owner-baseline-1', sha: sha('0'), tree: sha('1') },
    compatibility: [
      { digest: digest('2'), fromSchema: 'v1', toSchema: 'v2', intermediateSchemas: ['v1', 'v2'], reviewId: 'review-new' },
      { digest: digest('1'), readWriteSchemas: ['v1', 'v2'], reviewId: 'review-prior' }
    ]
  };
  const context = { repository: policy.repository, ref: 'refs/heads/main', workflowSha: sha('a'), checkoutSha: sha('a') };
  const release = { schemaVersion: 1, repository: policy.repository, sha: sha('b'), tree: sha('c'), digest: digest('2'), image: policy.image, pin: `${policy.image}@${digest('2')}`, controllerRevision: sha('a'), generation: 'd'.repeat(64), runId: 123, runAttempt: 1, schema: 'v2', checks: Object.fromEntries(['check', 'unit', 'build', 'package', 'containerFiles', 'imageSmoke'].map(k => [k, 'passed'])) };
  policy.imageReaderCompatibility = [release, { digest: digest('1'), sha: sha('1'), tree: sha('2') }].map(target => ({ digest: target.digest, sha: target.sha, tree: target.tree, descriptorBlobSha: readerEvidence(target).blobSha, reviewId: 'synthetic-reader-review', possibleStorageRequirements: storage() }));
  const desired = { sha: release.sha, tree: release.tree, generation: release.generation };
  const adapter = new SyntheticHostAdapter(policy, release, now);
  return { policy, context, release, desiredSource: { read: async () => structuredClone(desired) }, desired, adapter, now: () => now };
}
/** Synthetic only. This is deliberately not exported from operational modules. */
export class SyntheticHostAdapter {
  constructor(policy, release, now) {
    Object.assign(this, { policy, release, now, calls: [], active: 0, maxActive: 0, tail: Promise.resolve(), currentDigest: digest('1'), schema: 'v1', running: true, failures: {}, fenceHeld: true });
    this.state = { version: 1, frozen: false, approvedBaseline: structuredClone(policy.approvedBaseline), current: { digest: digest('1'), pin: `${policy.image}@${digest('1')}`, sha: sha('1'), tree: sha('2'), schema: 'v1' }, consumed: [] };
    this.evidence = {
      version: { observedAt: now, value: 'SYNTHETIC-not-an-installed-version' },
      scope: { observedAt: now, applicationId: policy.applicationId, resources: [policy.applicationId] },
      capacity: { observedAt: now, freeMemoryBytes: 10000, freeDiskBytes: 10000, reservedCapacityExcluded: true },
      mounts: { observedAt: now, volumeId: policy.volumeId, uid: 1000, gid: 1000, mode: '0700', localDurableStorage: true, completeHostInventory: true, containers: [{ applicationId: policy.applicationId, volumeId: policy.volumeId }], unmanagedWriters: 0 },
      database: { observedAt: now, volumeId: policy.volumeId, schema: 'v1', storageCompatibility: storage(), storageEvidenceKind: 'sqlite-metadata-and-image-rows' }
    };
    this.termination = { observedAt: now, volumeId: policy.volumeId, completeHostInventory: true, containers: [{ running: false, restartDisabled: true }], unmanagedWriters: 0, writerCount: 0, pendingDeploymentCount: 0, staleStartsFenced: true, evidenceKind: 'host-process-and-mount-inventory' };
  }
  async capabilities() { return [...REQUIRED_CAPABILITIES]; }
  async withExclusiveLease(resource, fn) {
    const previous = this.tail; let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    this.active++; this.maxActive = Math.max(this.active, this.maxActive);
    try { return await fn({ assertHeld: async () => requireGate(this.fenceHeld, 'LEASE_LOST') }); }
    finally { this.active--; release(); }
  }
  async readState() { return structuredClone(this.state); }
  async readImageReaderDescriptor(target) { return readerEvidence(target); }
  async preflight() { this.calls.push('preflight'); return structuredClone({ ...this.evidence, database: { ...this.evidence.database, schema: this.schema === 'v1' ? this.evidence.database.schema : this.schema } }); }
  async stop(options) {
    this.calls.push(['stop', options]);
    requireGate(options.docker_cleanup === false, 'DESTRUCTIVE_STOP');
    if (this.failures.stop) throw new Error('synthetic stop failed');
    this.running = false;
    return { message: 'Application stopping request queued' };
  }
  async waitForAllWritersTerminated() { this.calls.push('termination'); return structuredClone(this.termination); }
  async backupStoppedVolume() { this.calls.push('backup'); return { observedAt: this.now, volumeId: this.policy.volumeId, consistent: true, retained: true, reference: 'SYNTHETIC-BACKUP' }; }
  async startPinned({ pin }) {
    this.calls.push(['start', pin]); this.currentDigest = pin.split('@')[1]; this.running = true;
    if (this.currentDigest === this.release.digest) { this.schema = this.failures.unexpectedSchema ?? this.release.schema; this.evidence.database.storageCompatibility = storage([IMAGE_SIZE_CAPABILITY]); }
    if (this.failures.start && this.currentDigest === this.release.digest) throw new Error('synthetic candidate failure');
  }
  async verifyRunning() {
    this.calls.push('verify');
    return { observedAt: this.now, applicationId: this.policy.applicationId, volumeId: this.policy.volumeId, runningDigest: this.currentDigest, sourceSha: this.currentDigest === this.release.digest ? this.release.sha : this.state.current.sha, schema: this.schema, storageCompatibility: structuredClone(this.evidence.database.storageCompatibility), storageEvidenceKind: 'sqlite-metadata-and-image-rows', healthy: !(this.failures.health && this.currentDigest === this.release.digest), replicas: 1, writerCount: 1 };
  }
  async readDatabaseSchema() { return { observedAt: this.now, volumeId: this.policy.volumeId, schema: this.schema, storageCompatibility: structuredClone(this.evidence.database.storageCompatibility), storageEvidenceKind: 'sqlite-metadata-and-image-rows' }; }
  async commitState(next, version) { requireGate(version === this.state.version, 'STATE_CAS_CONFLICT'); this.state = structuredClone(next); this.calls.push('commit'); }
}
