import { REPOSITORY, DEFAULT_BRANCH, LABEL, ENVIRONMENT, SHA, requireGate, identity } from './contracts.mjs';

// Events wake the reconciler; they never select code. Read every page of live PRs.
export function choose(holders, mainSha) {
  requireGate(SHA.test(mainSha), 'INVALID_MAIN_SHA');
  const eligible = holders.filter(pr => pr.state === 'open' && !pr.draft && pr.base === DEFAULT_BRANCH
    && pr.headRepository === REPOSITORY && pr.baseRepository === REPOSITORY && pr.labels.includes(LABEL)
    && pr.authorizedLabeler && SHA.test(pr.sha) && Number.isSafeInteger(pr.labelEvent) && pr.labelEvent > 0);
  eligible.sort((a, b) => b.labelEvent - a.labelEvent || b.number - a.number);
  const owner = eligible[0];
  return owner ? { pr: owner.number, sha: owner.sha, branch: owner.branch, labelEvent: owner.labelEvent, mainSha }
    : { pr: null, sha: mainSha, branch: DEFAULT_BRANCH, labelEvent: null, mainSha };
}

export function github({ token, fetcher = fetch } = {}) {
  requireGate(token, 'GITHUB_TOKEN_MISSING');
  async function request(path, { method = 'GET', body } = {}) {
    requireGate(path.startsWith(`repos/${REPOSITORY}/`) || path === `repos/${REPOSITORY}`, 'GITHUB_SCOPE_ESCAPE');
    const response = await fetcher(`https://api.github.com/${path}`, { method, redirect: 'error',
      signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    requireGate(response.ok, `GITHUB_HTTP_${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  const path = suffix => `repos/${REPOSITORY}/${suffix}`;
  async function pages(suffix) {
    const all = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await request(path(`${suffix}${suffix.includes('?') ? '&' : '?'}per_page=100&page=${page}`));
      requireGate(Array.isArray(batch), 'INVALID_GITHUB_LIST'); all.push(...batch);
      if (batch.length < 100) return all;
    }
    throw new Error('GITHUB_PAGINATION_LIMIT');
  }
  async function desired() {
    const repo = await request(`repos/${REPOSITORY}`);
    requireGate(repo.default_branch === DEFAULT_BRANCH, 'DEFAULT_BRANCH_MUST_BE_MAIN');
    const main = await request(path(`git/ref/heads/${DEFAULT_BRANCH}`));
    const issues = await pages(`issues?state=open&labels=${LABEL}`);
    const holders = [];
    for (const issue of issues.filter(issue => issue.pull_request)) {
      const pr = await request(path(`pulls/${issue.number}`));
      if (pr.head?.repo?.full_name !== REPOSITORY || pr.base?.ref !== DEFAULT_BRANCH || pr.draft || pr.state !== 'open') continue;
      const events = await pages(`issues/${pr.number}/events`);
      const event = events.filter(e => ['labeled', 'unlabeled'].includes(e.event) && e.label?.name === LABEL).at(-1);
      if (event?.event !== 'labeled' || !event.actor?.login) continue;
      const permission = await request(path(`collaborators/${encodeURIComponent(event.actor.login)}/permission`));
      holders.push({ number: pr.number, state: pr.state, draft: pr.draft, base: pr.base.ref,
        headRepository: pr.head.repo.full_name, baseRepository: pr.base.repo.full_name,
        labels: pr.labels.map(l => l.name), sha: pr.head.sha, branch: pr.head.ref, labelEvent: event.id,
        authorizedLabeler: ['admin', 'maintain', 'write'].includes(permission.permission) });
    }
    return choose(holders, main.object.sha);
  }
  return { request, pages, desired,
    stillWanted: async want => identity(await desired()) === identity(want),
    async begin(selected, before) {
      const deployment = await request(path('deployments'), { method: 'POST', body: {
        ref: selected.sha, task: 'universe-3d-on-dev', auto_merge: false, required_contexts: [],
        environment: ENVIRONMENT, transient_environment: false, production_environment: false,
        description: 'Serialized Universe 3D dev image switch',
        payload: { schemaVersion: 1, pin: selected.pin, revision: selected.sha,
          runId: selected.runId, buildAttempt: selected.buildAttempt, controllerSha: selected.controllerSha,
          previousConfiguredPin: before.configuredPin, runningDigestVerified: false }
      } });
      requireGate(Number.isSafeInteger(deployment.id), 'DEPLOYMENT_LOCK_ID_MISSING');
      return deployment.id;
    },
    status: (id, state, runUrl) => request(path(`deployments/${id}/statuses`), { method: 'POST', body: {
      state, auto_inactive: false, environment: ENVIRONMENT, log_url: runUrl,
      description: state === 'success' ? 'Digest selected; health and served revision verified' :
        state === 'inactive' ? 'No runtime switch performed' : 'Read the deployment receipt before reconciling again',
      ...(state === 'success' ? { environment_url: 'https://3d.dev.bawes.net' } : {})
    } })
  };
}
