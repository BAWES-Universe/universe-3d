import { APP, VOLUME, IMAGE, ORIGIN, DIGEST, hash, requireGate, GateError } from './contracts.mjs';

const empty = value => value === null || value === '' || value === undefined;
const configKeys = ['uuid', 'build_pack', 'fqdn', 'ports_exposes', 'ports_mappings', 'destination_type', 'destination_id',
  'additional_servers_count', 'health_check_enabled', 'health_check_path', 'health_check_port', 'health_check_method',
  'health_check_scheme', 'health_check_return_code', 'health_check_type', 'health_check_command', 'custom_healthcheck_found', 'custom_docker_run_options', 'pre_deployment_command', 'post_deployment_command'];
export function configuredPin(app) {
  // Reviewed Coolify Docker Image digest encoding; arbitrary tags are not a pin.
  requireGate(app.docker_registry_image_name === IMAGE && /^sha256-[a-f0-9]{64}$/.test(app.docker_registry_image_tag), 'CONFIGURED_DIGEST_REQUIRED');
  return `${IMAGE}@${app.docker_registry_image_tag.replace('sha256-', 'sha256:')}`;
}
export function validateTarget(app, storage) {
  requireGate(app?.uuid === APP && app.build_pack === 'dockerimage' && app.fqdn === ORIGIN, 'WRONG_APPLICATION');
  requireGate(String(app.ports_exposes) === '4190' && empty(app.ports_mappings), 'PORT_CONFIGURATION_CHANGED');
  requireGate(app.destination_type === 'App\\Models\\StandaloneDocker' && app.destination_id != null
    && app.additional_servers_count === 0, 'SINGLE_STANDALONE_SERVER_REQUIRED');
  requireGate(app.settings?.is_consistent_container_name_enabled === true, 'SINGLE_DEPLOYMENT_WRITER_REQUIRED');
  const hardening = '--cap-drop=ALL --ulimit nproc=512:512 --ulimit nofile=4096:4096';
  requireGate(String(app.custom_docker_run_options || '').trim().replace(/\s+/g, ' ') === hardening, 'HARDENING_CONFIGURATION_CHANGED');
  requireGate(empty(app.pre_deployment_command) && empty(app.post_deployment_command), 'CUSTOM_EXECUTION_REVIEW_REQUIRED');
  requireGate(app.health_check_enabled === false || (app.custom_healthcheck_found === true
    || app.health_check_type === 'cmd' && app.health_check_command === 'node scripts/healthcheck.mjs'), 'HEALTH_CONFIGURATION_CHANGED');
  requireGate(Array.isArray(storage?.persistent_storages) && Array.isArray(storage.file_storages), 'STORAGE_RESPONSE_UNKNOWN');
  requireGate(storage.persistent_storages.length === 1 && storage.file_storages.length === 0, 'UNEXPECTED_STORAGE_OVERLAY');
  const volume = storage.persistent_storages[0];
  requireGate(volume.name === VOLUME && volume.mount_path === '/data' && empty(volume.host_path), 'DATA_VOLUME_CHANGED');
  const config = Object.fromEntries(configKeys.map(key => [key, app[key] ?? null]));
  const settings = Object.fromEntries(Object.entries(app.settings).filter(([key]) => !['id', 'created_at', 'updated_at', 'application_id'].includes(key)));
  const mounts = { name: volume.name, mountPath: volume.mount_path, hostPath: volume.host_path || null,
    uuid: volume.uuid, previewSuffix: volume.is_preview_suffix_enabled };
  requireGate(typeof mounts.uuid === 'string' && mounts.uuid.length > 0, 'STORAGE_ID_MISSING');
  return { configuredPin: configuredPin(app), configurationHash: hash({ config, settings, mounts }),
    applicationUuid: APP, dataVolume: VOLUME, mountPath: '/data', status: app.status,
    runningDigestVerified: false };
}
export function coolify({ base, token, fetcher = fetch, wait = ms => new Promise(r => setTimeout(r, ms)), now = Date.now } = {}) {
  const origin = new URL(base);
  requireGate(origin.protocol === 'https:' && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash, 'INVALID_COOLIFY_ORIGIN');
  requireGate(token, 'COOLIFY_TOKEN_MISSING');
  const applicationPath = `/api/v1/applications/${APP}`;
  async function request(path, method = 'GET', body) {
    const allowed = method === 'GET' && (path === '/api/v1/version' || path === applicationPath || path === `${applicationPath}/storages`
      || /^\/api\/v1\/deployments\/[A-Za-z0-9_-]+$/.test(path)
      || path.startsWith(`/api/v1/deployments/applications/${APP}?skip=`))
      || method === 'PATCH' && path === applicationPath || method === 'POST' && path === `${applicationPath}/start`;
    requireGate(allowed, 'COOLIFY_SCOPE_ESCAPE');
    try {
      const response = await fetcher(new URL(path, origin), { method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      requireGate(response.ok, `COOLIFY_${method}_HTTP_${response.status}`);
      if (path === '/api/v1/version') {
        const raw = (await response.text()).trim();
        try { const value = JSON.parse(raw); return typeof value === 'string' ? value : value.version; } catch { return raw; }
      }
      return await response.json();
    } catch (error) {
      if (error instanceof GateError) throw error;
      throw new GateError(method === 'GET' ? 'COOLIFY_READ_UNKNOWN' : 'COOLIFY_MUTATION_UNKNOWN');
    }
  }
  async function inspect() { return validateTarget(await request(applicationPath), await request(`${applicationPath}/storages`)); }
  return {
    inspect,
    async version() {
      const version = await request('/api/v1/version');
      requireGate(typeof version === 'string' && /^[a-zA-Z0-9.+_-]{1,80}$/.test(version), 'COOLIFY_VERSION_UNKNOWN');
      return version; // Record it; actual API responses and pin readback are the gates.
    },
    async assertIdle() {
      for (let skip = 0; skip <= 10000; skip += 100) {
        const result = await request(`/api/v1/deployments/applications/${APP}?skip=${skip}&take=100`);
        requireGate(Array.isArray(result.deployments) && Number.isSafeInteger(result.count), 'DEPLOYMENT_HISTORY_UNKNOWN');
        requireGate(result.deployments.every(d => ['finished', 'failed', 'cancelled', 'cancelled-by-user', 'canceled'].includes(d.status)), 'COOLIFY_DEPLOYMENT_ACTIVE');
        if (skip + result.deployments.length >= result.count) return;
        requireGate(result.deployments.length === 100, 'DEPLOYMENT_HISTORY_INCOMPLETE');
      }
      throw new GateError('DEPLOYMENT_HISTORY_LIMIT');
    },
    // No retries for mutations: a lost response can follow successful acceptance.
    async setImage(digest) {
      requireGate(DIGEST.test(digest), 'INVALID_DIGEST');
      await request(applicationPath, 'PATCH', { docker_registry_image_name: IMAGE, docker_registry_image_tag: digest.replace('sha256:', 'sha256-') });
    },
    async start() {
      const receipt = await request(`${applicationPath}/start`, 'POST');
      requireGate(/^[A-Za-z0-9_-]{1,100}$/.test(receipt.deployment_uuid || ''), 'DEPLOYMENT_ACCEPTANCE_UNKNOWN');
      return receipt.deployment_uuid;
    },
    async waitFor(id, timeout = 10 * 60 * 1000) {
      requireGate(/^[A-Za-z0-9_-]{1,100}$/.test(id), 'INVALID_DEPLOYMENT_ID');
      const deadline = now() + timeout;
      while (now() < deadline) {
        const result = await request(`/api/v1/deployments/${id}`);
        requireGate(result.deployment_uuid === id, 'DEPLOYMENT_ID_MISMATCH');
        requireGate(!['failed', 'cancelled', 'cancelled-by-user', 'canceled'].includes(result.status), 'DEPLOYMENT_FAILED');
        requireGate(['queued', 'in_progress', 'finished'].includes(result.status), 'DEPLOYMENT_STATUS_UNKNOWN');
        if (result.status === 'finished') return result.status;
        await wait(5000);
      }
      throw new GateError('DEPLOYMENT_TIMEOUT');
    }
  };
}
export function publicSite({ fetcher = fetch, now = Date.now, wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  async function read(path, json = true) {
    const response = await fetcher(`${ORIGIN}${path}${path.includes('?') ? '&' : '?'}on_dev_probe=${now()}`, {
      redirect: 'error', signal: AbortSignal.timeout(15000), cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
    requireGate(response.ok, 'PUBLIC_SITE_UNHEALTHY');
    return json ? response.json() : response.text();
  }
  return {
    health: () => read('/api/health'),
    async access() {
      const policy = await read('/api/access');
      requireGate(policy.setupOnly === false, 'OWNER_SETUP_INCOMPLETE');
      return hash(policy);
    },
    async verify(selected, accessBefore, timeout = 180000) {
      const deadline = now() + timeout;
      while (now() < deadline) {
        let health;
        try { health = await read('/api/health'); } catch { await wait(3000); continue; }
        if (health.ok === true && health.persistence === 'sqlite' && health.build?.revision === selected.sha
          && health.build?.tree === selected.tree
          && health.build?.controllerRevision === selected.controllerSha && health.build?.runId === selected.runId && health.build?.buildAttempt === selected.buildAttempt) {
          const accessAfter = await this.access();
          if (accessBefore !== null) requireGate(accessAfter === accessBefore, 'ACCESS_POLICY_CHANGED');
          requireGate((await read('/', false)).includes('/main.js'), 'PUBLIC_STATIC_SMOKE_FAILED');
          return { revision: health.build.revision, tree: health.build.tree, runId: health.build.runId, buildAttempt: health.build.buildAttempt, accessPolicyCompared: accessBefore !== null, ok: true };
        }
        await wait(3000);
      }
      throw new GateError('SERVED_REVISION_NOT_VERIFIED');
    }
  };
}
