import { assertFresh, DIGEST, requireGate } from './contracts.mjs';

/** Narrow application HTTP transport. Does not imply app-bound credential scope.
 * An installed-version-reviewed digest binding profile is mandatory before PATCH.
 * No GET application status is ever promoted to host-wide writer/running proof.
 */
export class CoolifyApplication {
  constructor({ origin, applicationId, token, apiProfile, fetcher = fetch, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    const url = new URL(origin);
    requireGate(url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'INVALID_COOLIFY_ORIGIN');
    requireGate(/^[a-zA-Z0-9_-]{1,100}$/.test(applicationId), 'INVALID_APPLICATION_ID');
    Object.assign(this, { origin: url.origin, applicationId, token, apiProfile, fetcher, now, wait });
  }
  async request(path, { method = 'GET', body, text = false } = {}) {
    requireGate((method === 'GET' && ['/api/v1/version', '/api/v1/resources', '/api/v1/deployments'].includes(path)) || [ `/api/v1/applications/${this.applicationId}`, `/api/v1/applications/${this.applicationId}/start`, `/api/v1/applications/${this.applicationId}/stop?docker_cleanup=false` ].includes(path) || /^\/api\/v1\/deployments\/[a-zA-Z0-9_-]+$/.test(path), 'COOLIFY_SCOPE_ESCAPE');
    const response = await this.fetcher(`${this.origin}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    // Never include a potentially sensitive response body or token in errors.
    requireGate(response.ok, 'COOLIFY_REQUEST_FAILED', `Scoped Coolify request failed (${response.status})`);
    return text ? response.text() : response.json();
  }
  async installedVersion() {
    const raw = (await this.request('/api/v1/version', { text: true })).trim();
    let version = raw;
    try { const parsed = JSON.parse(raw); version = typeof parsed === 'string' ? parsed : parsed.version; } catch {}
    requireGate(typeof version === 'string' && /^[a-zA-Z0-9.+_-]{1,80}$/.test(version), 'INSTALLED_VERSION_UNKNOWN');
    return { observedAt: this.now(), value: version };
  }
  async reachableResources() {
    const resources = await this.request('/api/v1/resources');
    requireGate(Array.isArray(resources) && resources.length <= 10000 && resources.every(r => typeof r.uuid === 'string'), 'RESOURCE_INVENTORY_UNKNOWN');
    return [...new Set(resources.map(r => r.uuid))].sort();
  }
  async pendingDeployments(applicationNumericId) {
    requireGate(applicationNumericId !== undefined, 'APPLICATION_ID_UNKNOWN');
    requireGate(this.apiProfile?.queueListIncludesPending === true, 'QUEUE_PROFILE_UNREVIEWED');
    const deployments = await this.request('/api/v1/deployments');
    requireGate(Array.isArray(deployments) && deployments.length <= 10000 && deployments.every(d => d.application_id !== undefined && typeof d.status === 'string'), 'DEPLOYMENT_QUEUE_UNKNOWN');
    return deployments.filter(d => String(d.application_id) === String(applicationNumericId) && !['finished', 'failed', 'cancelled', 'canceled'].includes(d.status));
  }
  inspect() { return this.request(`/api/v1/applications/${this.applicationId}`); }
  async stop(lease) {
    await lease.assertHeld();
    return this.request(`/api/v1/applications/${this.applicationId}/stop?docker_cleanup=false`, { method: 'POST' });
  }
  async startPinned(pin, version, lease) {
    requireGate(/^ghcr\.io\/[a-z0-9-]+\/[a-z0-9._-]+@sha256:[a-f0-9]{64}$/.test(pin) && DIGEST.test(pin.split('@')[1]), 'INVALID_DIGEST_PIN');
    assertFresh(version, this.now(), 30000);
    requireGate(this.apiProfile?.reviewId && this.apiProfile.version === version.value && this.apiProfile.digestBinding === 'name-at-digest-empty-tag', 'DIGEST_BINDING_UNVERIFIED', 'Installed Coolify digest-field semantics need explicit version-specific review');
    await lease.assertHeld();
    await this.request(`/api/v1/applications/${this.applicationId}`, { method: 'PATCH', body: { docker_registry_image_name: pin, docker_registry_image_tag: '' } });
    const app = await this.inspect();
    requireGate(app.uuid === this.applicationId && app.build_pack === 'dockerimage' && app.docker_registry_image_name === pin && !app.docker_registry_image_tag, 'PIN_READBACK_MISMATCH');
    await lease.assertHeld();
    const start = await this.request(`/api/v1/applications/${this.applicationId}/start`, { method: 'POST' });
    requireGate(/^[a-zA-Z0-9_-]{1,100}$/.test(start.deployment_uuid), 'DEPLOYMENT_ID_MISSING');
    const deadline = this.now() + 10 * 60 * 1000;
    for (let reads = 0; reads < 121 && this.now() < deadline; reads++) {
      await lease.assertHeld();
      const deployment = await this.request(`/api/v1/deployments/${start.deployment_uuid}`);
      requireGate(!['failed', 'cancelled', 'canceled'].includes(deployment.status), 'DEPLOYMENT_FAILED');
      if (deployment.status === 'finished') return { deploymentId: start.deployment_uuid };
      requireGate(['queued', 'in_progress', 'pending'].includes(deployment.status), 'DEPLOYMENT_STATUS_UNKNOWN');
      await this.wait(5000);
    }
    throw Object.assign(new Error('Deployment polling deadline exceeded'), { code: 'DEPLOYMENT_TIMEOUT' });
  }
}
