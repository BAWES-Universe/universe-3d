import { assertProvenance, desiredSelection, requireGate, SHA, DIGEST } from './contracts.mjs';
import { IMAGE_READER_PATH, descriptorBlobSha, assertReaderCompatible } from './image-reader.mjs';

export class GitHub {
  constructor({ token, repository, fetcher = fetch }) { this.token = token; this.repository = repository; this.fetcher = fetcher; }
  async request(path, { method = 'GET', body } = {}) {
    requireGate(path.startsWith(`/repos/${this.repository}/`), 'GITHUB_SCOPE_ESCAPE');
    const result = await this.fetcher(`https://api.github.com${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    requireGate(result.ok, 'GITHUB_READ_FAILED', `GitHub ${method} failed (${result.status})`);
    return result.status === 204 ? null : result.json();
  }
  async all(path, key) {
    const items = [];
    for (let page = 1; page <= 100; page++) {
      const response = await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const batch = key ? response[key] : response;
      requireGate(Array.isArray(batch), 'INVALID_GITHUB_RESPONSE');
      items.push(...batch);
      if (batch.length < 100) return items;
    }
    throw new Error('GitHub inventory exceeds bounded pagination; refusing incomplete selection');
  }
  async desired(policy) {
    const base = `/repos/${this.repository}`;
    // An event epoch prevents old results being reused after label remove/re-add.
    const epoch = async () => {
      const events = await this.all(`${base}/issues/events`);
      return Math.max(policy.approvedBaseline?.selectionEpoch ?? 0, ...events.filter(e => e.issue?.pull_request && ((['labeled', 'unlabeled'].includes(e.event) && e.label?.name === policy.label) || ['closed', 'reopened'].includes(e.event))).map(e => e.id));
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await epoch();
      const all = await this.all(`${base}/pulls?state=open`);
      const pulls = [];
      let forcePushEpoch = 0;
      for (const pr of all.filter(p => p.labels.some(l => l.name === policy.label))) {
        const timeline = await this.all(`${base}/issues/${pr.number}/timeline`);
        forcePushEpoch = Math.max(forcePushEpoch, ...timeline.filter(e => e.event === 'head_ref_force_pushed').map(e => e.id));
        const commit = await this.request(`${base}/git/commits/${pr.head.sha}`);
        pulls.push({ number: pr.number, state: pr.state, labels: pr.labels.map(l => l.name), repository: pr.head.repo?.full_name, base: pr.base.ref, sha: pr.head.sha, tree: commit.tree.sha });
      }
      const after = await epoch();
      if (before === after) return desiredSelection({ pulls, epoch: Math.max(after, forcePushEpoch), baseline: policy.approvedBaseline }, policy);
    }
    throw new Error('Selection changed during read; retry on next event');
  }
  async verifyBuildRun(id, policy, buildRevision = null, expectedAttempt = null) {
    requireGate(Number.isSafeInteger(id) && id > 0, 'INVALID_RUN');
    const base = `/repos/${this.repository}/actions/runs/${id}`;
    const run = await this.request(expectedAttempt === null ? base : `${base}/attempts/${expectedAttempt}`);
    const jobs = await this.all(`${base}/attempts/${run.run_attempt}/jobs`, 'jobs');
    if (expectedAttempt !== null) requireGate(run.run_attempt === expectedAttempt, 'RELEASE_ATTEMPT_MISMATCH');
    assertProvenance(run, jobs, policy, '.github/workflows/preview-build.yml', buildRevision ?? run.head_sha);
    return run;
  }
  async imageReaderDescriptor(target) {
    requireGate(SHA.test(target.sha) && SHA.test(target.tree) && DIGEST.test(target.digest), 'IMAGE_READER_TARGET_INVALID');
    const base = `/repos/${this.repository}`;
    const commit = await this.request(`${base}/git/commits/${target.sha}`);
    requireGate(commit.tree?.sha === target.tree, 'SOURCE_TREE_MISMATCH');
    // Bounded JSON data at an immutable commit, never fetched code or a merge ref.
    const file = await this.request(`${base}/contents/${IMAGE_READER_PATH}?ref=${target.sha}`);
    requireGate(file?.type === 'file' && file.path === IMAGE_READER_PATH && file.encoding === 'base64' && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= 4096 && typeof file.content === 'string' && file.content.length <= 8192 && SHA.test(file.sha), 'IMAGE_READER_DESCRIPTOR_MISSING');
    const bytes = Buffer.from(file.content, 'base64');
    requireGate(bytes.length === file.size && descriptorBlobSha(bytes) === file.sha, 'IMAGE_READER_BLOB_MISMATCH');
    let descriptor;
    try { descriptor = JSON.parse(bytes.toString('utf8')); } catch { requireGate(false, 'IMAGE_READER_DESCRIPTOR_INVALID'); }
    assertReaderCompatible({ version: 1, requiredReaderCapabilities: [] }, descriptor);
    return { digest: target.digest, sha: target.sha, tree: target.tree, path: IMAGE_READER_PATH, blobSha: file.sha, descriptor };
  }
  async dispatch(workflow, policy, inputs) {
    requireGate(['preview-build.yml', 'preview-controller.yml'].includes(workflow), 'WORKFLOW_NOT_ALLOWED');
    return this.request(`/repos/${this.repository}/actions/workflows/${workflow}/dispatches`, { method: 'POST', body: { ref: policy.defaultBranch, inputs } });
  }
}
