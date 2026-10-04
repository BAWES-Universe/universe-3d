import { GateError, requireGate } from './contracts.mjs';
import { CoolifyApplication } from './coolify.mjs';

/** The missing operational boundary, not an imaginary monitoring endpoint.
 * An existing, separately authorized host execution route must supply fresh
 * observations and a durable resource lease/state. Nothing is installed here.
 */
export class UnimplementedHostEvidence {
  async capabilities() { return []; }
  async withExclusiveLease() { throw new GateError('HOST_PREFLIGHT_UNIMPLEMENTED'); }
}
export class UnimplementedHostAdapter extends UnimplementedHostEvidence {}

/** All deployment HTTP mechanics are implemented; only host evidence/lease IO
 * is injected. A review of the actual installed version must also establish the
 * name-at-digest-empty-tag mapping before it is allowed in apiProfile.
 */
export class CoolifyWithHostEvidenceAdapter {
  constructor({ policy, client, host }) { Object.assign(this, { policy, client, host }); }
  async capabilities() {
    const available = await this.host.capabilities();
    if (!this.policy.apiProfile?.reviewId) return available;
    return [...available, 'app-stop-no-cleanup', 'digest-pinned-start', 'installed-version'];
  }
  withExclusiveLease(id, fn) { requireGate(id === this.policy.applicationId, 'RESOURCE_SCOPE_MISMATCH'); return this.host.withExclusiveLease(id, fn); }
  readState(lease) { return this.host.readState(lease); }
  readImageReaderDescriptor(target, lease) { return this.host.readImageReaderDescriptor(target, lease); }
  commitState(state, expected, lease) { return this.host.commitState(state, expected, lease); }
  async preflight(lease) {
    const evidence = await this.host.preflight(lease);
    const version = await this.client.installedVersion();
    requireGate(version.value === this.policy.apiProfile?.version, 'UNREVIEWED_COOLIFY_VERSION');
    const app = await this.client.inspect();
    requireGate(app.uuid === this.policy.applicationId && app.build_pack === 'dockerimage', 'APPLICATION_CONFIG_MISMATCH');
    this.version = version;
    return { ...evidence, version };
  }
  stop({ applicationId, docker_cleanup }, lease) {
    requireGate(applicationId === this.policy.applicationId && docker_cleanup === false, 'DESTRUCTIVE_STOP');
    return this.host.runFencedMutation('stop', lease, () => this.client.stop(lease));
  }
  waitForAllWritersTerminated(volume, lease) { requireGate(volume === this.policy.volumeId, 'VOLUME_SCOPE_MISMATCH'); return this.host.waitForAllWritersTerminated(volume, lease); }
  backupStoppedVolume(volume, lease) { requireGate(volume === this.policy.volumeId, 'VOLUME_SCOPE_MISMATCH'); return this.host.backupStoppedVolume(volume, lease); }
  async startPinned({ applicationId, volumeId, pin, replicas }, lease) {
    requireGate(applicationId === this.policy.applicationId && volumeId === this.policy.volumeId && replicas === 1 && pin.startsWith(`${this.policy.image}@`), 'RESOURCE_SCOPE_MISMATCH');
    // Version evidence may age while stopping/backup; reread immediately.
    const version = await this.client.installedVersion();
    return this.host.runFencedMutation('start-pinned', lease, () => this.client.startPinned(pin, version, lease));
  }
  verifyRunning(lease) { return this.host.verifyRunning(lease); }
  readDatabaseSchema(lease) { return this.host.readDatabaseSchema(lease); }
}
export function createHostAdapter(policy, env, { host = new UnimplementedHostEvidence(), fetcher = fetch } = {}) {
  if (policy.hostAdapter !== 'coolify-with-host-evidence' || !policy.coolifyOrigin) return new UnimplementedHostAdapter();
  const client = new CoolifyApplication({ origin: policy.coolifyOrigin, applicationId: policy.applicationId, token: env.COOLIFY_TOKEN, apiProfile: policy.apiProfile, fetcher });
  return new CoolifyWithHostEvidenceAdapter({ policy, client, host });
}
