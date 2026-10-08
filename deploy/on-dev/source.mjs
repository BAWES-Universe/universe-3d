import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPOSITORY, SHA, hash, requireGate } from './contracts.mjs';

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
// Conservative storage compatibility: identical server implementation and its
// shared local imports, dependencies and reviewed Node runtime. Frontend-only
// changes pass automatically; backend/shared-format changes require a separately
// approved compatibility/migration review. This does not promise bug-free code.
export function compatibility(root, ref) {
  requireGate(SHA.test(ref), 'INVALID_SOURCE_REF');
  const files = git(root, 'ls-tree', '-r', '--name-only', ref).split('\n');
  const protectedFiles = new Set(files.filter(path => ['scripts/healthcheck.mjs', 'scripts/operator-account.mjs', 'scripts/promote-owner.mjs'].includes(path) || path === 'server.mjs' || path.startsWith('server/') && !/\.md$/.test(path) || /\.sql$/.test(path)));
  requireGate(protectedFiles.has('server/store.mjs'), 'MIGRATION_SOURCES_MISSING');
  // Include shared runtime schema/geometry/protocol code transitively. Import
  // declarations in this repository are static; nonliteral dynamic imports in
  // the runtime closure are rejected rather than treated as UI-only changes.
  const queue = [...protectedFiles];
  for (const path of queue) {
    if (!/\.(mjs|js)$/.test(path)) continue;
    const code = git(root, 'show', `${ref}:${path}`);
    requireGate(!/\bimport\s*\((?!\s*['"])/.test(code), 'DYNAMIC_RUNTIME_IMPORT_REVIEW_REQUIRED');
    const imports = [...code.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)['"]([^'"]+)['"]/g)];
    for (const [, specifier] of imports) {
      if (!specifier.startsWith('.')) continue;
      const dependency = posix.normalize(posix.join(posix.dirname(path), specifier));
      requireGate(files.includes(dependency), 'RUNTIME_IMPORT_MISSING');
      if (!protectedFiles.has(dependency)) { protectedFiles.add(dependency); queue.push(dependency); }
    }
  }
  for (const path of ['package.json', 'package-lock.json']) protectedFiles.add(path);
  if (files.includes('deploy/on-dev/Dockerfile')) protectedFiles.add('deploy/on-dev/Dockerfile');
  const records = [...protectedFiles].sort().map(path => [path, hash(git(root, 'show', `${ref}:${path}`))]);
  // BASE_IMAGE is trusted workflow configuration, not a branch build argument.
  const workflow = files.includes('.github/workflows/dev-on-dev.yml') ? git(root, 'show', `${ref}:.github/workflows/dev-on-dev.yml`) : '';
  const baseImage = workflow.match(/^  BASE_IMAGE: (.+)$/m)?.[1];
  if (baseImage) records.push(['@node-base-image', baseImage]);
  return { hash: hash(records), files: [...protectedFiles].sort() };
}
export function prepareSource({ source, trusted, sha, controllerSha, runId, buildAttempt, output }) {
  requireGate(SHA.test(sha) && SHA.test(controllerSha), 'INVALID_SOURCE_REF');
  requireGate(git(source, 'rev-parse', 'HEAD') === sha && git(trusted, 'rev-parse', 'HEAD') === controllerSha, 'SOURCE_CHECKOUT_MISMATCH');
  // Branches may not alter the deployment authority or runtime image recipe.
  const protectedPaths = ['.github', 'deploy', 'Dockerfile', '.dockerignore', 'scripts/build.mjs'];
  for (const path of protectedPaths) {
    requireGate(git(source, 'rev-parse', `${sha}:${path}`) === git(trusted, 'rev-parse', `${controllerSha}:${path}`), 'TRUSTED_PATH_CHANGED');
  }
  const candidate = compatibility(source, sha), current = compatibility(trusted, controllerSha);
  requireGate(candidate.hash === current.hash, 'MIGRATION_REVIEW_REQUIRED');
  const selected = { schemaVersion: 1, repository: REPOSITORY, sha, tree: git(source, 'rev-parse', 'HEAD^{tree}'),
    controllerSha, compatibility: candidate.hash, runId: String(runId), buildAttempt: String(buildAttempt), platform: 'linux/amd64' };
  requireGate(/^\d+$/.test(selected.runId) && /^[1-9]\d*$/.test(selected.buildAttempt), 'INVALID_RUN_ID');
  writeFileSync(output, `${JSON.stringify(selected, null, 2)}\n`);
  return selected;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'compatibility') console.log(JSON.stringify(compatibility(process.argv[3], process.argv[4]), null, 2));
  else if (process.argv[2] === 'prepare') {
    const e = process.env;
    prepareSource({ source: e.SOURCE_DIR, trusted: e.TRUSTED_DIR, sha: e.SOURCE_SHA,
      controllerSha: e.CONTROLLER_SHA, runId: e.GITHUB_RUN_ID, buildAttempt: e.GITHUB_RUN_ATTEMPT, output: e.SOURCE_OUTPUT });
  } else throw new Error('usage: source.mjs compatibility ROOT SHA | prepare');
}
