import { REQUIRED_CAPABILITIES } from './controller.mjs';
import { HostStore } from './host-store.mjs';
import { LinuxHostSystem } from './host-system.mjs';
import { requireGate, GateError } from './contracts.mjs';

/** Host-local authority, NOT a remote Coolify fencing claim. One installed helper
 * owns every preview mutation under a crash-persistent lock. An uncertain request
 * poisons the transaction, keeps its durable freeze, and cannot be followed by a
 * recovery start. A lost runner leaves its lock for explicit reconciliation.
 */
export class LinuxHostEvidence {
  constructor({ policy, client, github, system, store, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    Object.assign(this, { policy, client, github, system: system ?? new LinuxHostSystem({ socket: policy.hostLocal?.dockerSocket, identity: policy.hostLocal?.hostIdentity }), store: store ?? new HostStore(policy.hostLocal?.stateDirectory), now, wait, uncertainRequest: false });
  }
  async capabilities() {
    const c = this.policy.hostLocal;
    requireGate(c?.installationReviewId && c.dockerSocket?.startsWith('/') && c.hostIdentity?.reviewId && c.exclusiveMutationAuthorityReviewId && c.containerLabel?.key && c.containerLabel?.value && c.database === 'universe.sqlite' && c.stateDirectory?.startsWith('/') && c.backupDirectory?.startsWith('/') && c.allowedHost && c.schemaFingerprints?.length && Number.isSafeInteger(c.reservedMemoryBytes) && c.reservedMemoryBytes >= 0 && Number.isSafeInteger(c.reservedDiskBytes) && c.reservedDiskBytes >= 0 && Number.isSafeInteger(c.maximumBackupBytes) && c.maximumBackupBytes > 0, 'HOST_INSTALLATION_NOT_APPROVED');
    requireGate(this.policy.apiProfile?.queueListIncludesPending === true && this.policy.apiProfile.automaticDeploymentField, 'QUEUE_PROFILE_UNREVIEWED');
    return REQUIRED_CAPABILITIES.filter(c => !['installed-version', 'app-stop-no-cleanup', 'digest-pinned-start'].includes(c));
  }
  withExclusiveLease(id, callback) {
    requireGate(id === this.policy.applicationId, 'RESOURCE_SCOPE_MISMATCH');
    return this.store.withExclusiveLease(id, async lease => {
      this.uncertainRequest = false;
      return callback(lease);
    });
  }
  readState(lease) { return this.store.readState(lease); }
  async readImageReaderDescriptor(target, lease) {
    await lease.assertHeld();
    requireGate(this.github?.imageReaderDescriptor, 'IMAGE_READER_SOURCE_UNAVAILABLE');
    return this.github.imageReaderDescriptor(target);
  }
  commitState(next, expected, lease) { return this.store.commitState(next, expected, lease); }
  async runFencedMutation(operation, lease, request) {
    await lease.assertHeld();
    requireGate(!this.uncertainRequest, 'ASYNC_REQUEST_UNCERTAIN', 'No further host mutation is safe until operator reconciliation');
    requireGate(['stop', 'start-pinned'].includes(operation), 'HOST_OPERATION_NOT_ALLOWED');
    const state = await this.store.readState(lease);
    requireGate(state.frozen === true && state.inProgress?.operationId, 'DURABLE_INTENT_MISSING');
    await this.store.journal({ operation, operationId: state.inProgress.operationId, status: 'request-in-progress', at: this.now() }, lease);
    try {
      const response = await request();
      await this.store.journal({ operation, operationId: state.inProgress.operationId, status: 'request-confirmed', at: this.now() }, lease);
      return response;
    } catch (error) {
      // Only a positively observed terminal deployment failure is known safe to
      // recover. Timeout, HTTP loss, unknown state or a lost journal write freezes.
      this.uncertainRequest = error.code !== 'DEPLOYMENT_FAILED';
      try { await this.store.journal({ operation, operationId: state.inProgress.operationId, status: this.uncertainRequest ? 'uncertain' : 'terminal-failed', at: this.now() }, lease); } catch { this.uncertainRequest = true; }
      if (this.uncertainRequest) throw new GateError('ASYNC_REQUEST_UNCERTAIN');
      throw error;
    }
  }
  async observe(lease) {
    await lease.assertHeld();
    const c = this.policy.hostLocal;
    const app = await this.client.inspect();
    requireGate(app.uuid === this.policy.applicationId && app.build_pack === 'dockerimage', 'APPLICATION_CONFIG_MISMATCH');
    const automatic = this.policy.apiProfile.automaticDeploymentField.split('.').reduce((value, key) => value?.[key], app);
    requireGate(automatic === false, 'AUTOMATIC_DEPLOYMENT_NOT_DISABLED');
    const pending = await this.client.pendingDeployments(app.id);
    const inventory = await this.system.inventory(this.policy.volumeId, c.containerLabel);
    for (const container of inventory.all) {
      requireGate(container.Config?.Labels?.[c.containerLabel.key] === c.containerLabel.value, 'SHARED_VOLUME_WRITER');
      requireGate(container.HostConfig?.Privileged === false && container.HostConfig?.ReadonlyRootfs === true && container.HostConfig?.CapDrop?.includes('ALL') && container.HostConfig?.NetworkMode !== 'host' && container.HostConfig?.PidMode !== 'host' && container.Mounts.filter(m => m.Type !== 'tmpfs').every(m => m.Name === this.policy.volumeId && m.Destination === '/data'), 'CONTAINER_ISOLATION_UNPROVEN');
      requireGate(container.HostConfig?.RestartPolicy?.Name === 'no', 'RESTART_PATH_UNPROVEN');
    }
    this.lastPath = inventory.path;
    return { app, pending, inventory };
  }
  async preflight(lease) {
    const { pending, inventory } = await this.observe(lease);
    requireGate(pending.length === 0 && !this.uncertainRequest, 'PENDING_DEPLOYMENT_BLOCKS_UPDATE');
    const c = this.policy.hostLocal;
    requireGate(![c.stateDirectory, c.backupDirectory].some(path => path === inventory.path || path.startsWith(inventory.path + '/')), 'CONTROL_STATE_ON_APPLICATION_VOLUME');
    await this.system.verifyStoragePaths([c.stateDirectory, c.backupDirectory]);
    const schema = await this.system.schema(inventory.path, c.database, c.schemaFingerprints);
    const resources = await this.client.reachableResources();
    return {
      scope: { observedAt: this.now(), applicationId: this.policy.applicationId, resources },
      capacity: await this.system.capacity(inventory.path, { memoryBytes: c.reservedMemoryBytes, diskBytes: c.reservedDiskBytes }),
      mounts: { observedAt: inventory.observedAt, volumeId: this.policy.volumeId, uid: inventory.stat.uid, gid: inventory.stat.gid, mode: (inventory.stat.mode & 0o777).toString(8).padStart(4, '0'), localDurableStorage: true, completeHostInventory: true, containers: inventory.all.map(container => ({ id: container.Id, applicationId: this.policy.applicationId, volumeId: this.policy.volumeId })), unmanagedWriters: inventory.unmanagedWriters },
      database: { ...schema, volumeId: this.policy.volumeId }
    };
  }
  async waitForAllWritersTerminated(volume, lease) {
    requireGate(volume === this.policy.volumeId, 'VOLUME_SCOPE_MISMATCH');
    for (let i = 0; i < 60; i++) {
      requireGate(!this.uncertainRequest, 'ASYNC_REQUEST_UNCERTAIN');
      const { pending, inventory } = await this.observe(lease);
      const writers = inventory.all.filter(c => c.State?.Running || c.State?.Restarting);
      if (pending.length === 0 && writers.length === 0 && inventory.unmanagedWriters === 0 && inventory.managedProcessReferences === 0) {
        return { observedAt: this.now(), volumeId: volume, completeHostInventory: true, unmanagedWriters: 0, containers: inventory.all.map(c => ({ id: c.Id, running: false, restartDisabled: c.HostConfig.RestartPolicy.Name === 'no' })), writerCount: 0, pendingDeploymentCount: 0,
          // Guaranteed by this host's held no-steal lock + disabled alternative
          // automatic routes + no uncertain start; never a Coolify fence token.
          staleStartsFenced: true, evidenceKind: 'host-process-and-mount-inventory' };
      }
      await this.wait(1000);
    }
    throw new GateError('WRITER_TERMINATION_TIMEOUT');
  }
  async backupStoppedVolume(volume, lease) {
    await this.waitForAllWritersTerminated(volume, lease);
    const state = await this.readState(lease);
    const backup = await this.system.backup(this.lastPath, this.policy.hostLocal.backupDirectory, state.inProgress.operationId, this.policy.hostLocal.maximumBackupBytes);
    await this.waitForAllWritersTerminated(volume, lease);
    return { ...backup, volumeId: volume };
  }
  async readDatabaseSchema(lease) {
    const { inventory } = await this.observe(lease);
    return { ...await this.system.schema(inventory.path, this.policy.hostLocal.database, this.policy.hostLocal.schemaFingerprints), volumeId: this.policy.volumeId };
  }
  async verifyRunning(lease) {
    for (let i = 0; i < 60; i++) {
      const { pending, inventory } = await this.observe(lease);
      const running = inventory.all.filter(c => c.State?.Running);
      requireGate(inventory.unmanagedWriters === 0 && inventory.managedFileReferences <= 1 && running.length <= 1 && pending.length === 0, 'RUNTIME_WRITER_INVARIANT_FAILED');
      if (running.length === 1 && inventory.managedFileReferences === 1 && running[0].State?.Health?.Status === 'healthy') {
        const actual = await this.system.running(running[0], this.policy.image, this.policy.hostLocal.allowedHost);
        const database = await this.system.schema(inventory.path, this.policy.hostLocal.database, this.policy.hostLocal.schemaFingerprints);
        return { ...actual, schema: database.schema, storageCompatibility: database.storageCompatibility, storageEvidenceKind: database.storageEvidenceKind, observedAt: this.now(), applicationId: this.policy.applicationId, volumeId: this.policy.volumeId, replicas: 1, writerCount: 1 };
      }
      await this.wait(1000);
    }
    throw new GateError('RUNTIME_VERIFICATION_FAILED');
  }
}
