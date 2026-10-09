import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { REPOSITORY, SHA, requireGate } from './contracts.mjs';

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
export function prepareSource({ source, trusted, sha, controllerSha, runId, buildAttempt, output }) {
  requireGate(SHA.test(sha) && SHA.test(controllerSha), 'INVALID_SOURCE_REF');
  requireGate(git(source, 'rev-parse', 'HEAD') === sha && git(trusted, 'rev-parse', 'HEAD') === controllerSha, 'SOURCE_CHECKOUT_MISMATCH');
  // Execution authority and Docker recipe come from the trusted checkout;
  // candidate copies of those files are never run with publication/deploy secrets.
  // Ordinary backend and migration code are built/tested like the rest of the app.
  // Only an explicitly declared data-loss release is outside this routine path.
  const hasSafety = git(source, 'ls-tree', '--name-only', sha, '--', 'deploy/release-safety.json');
  const safety = hasSafety ? JSON.parse(git(source, 'show', `${sha}:deploy/release-safety.json`)) : { destructiveDataChange: false };
  requireGate(safety.destructiveDataChange === false, 'EXPLICIT_DATA_LOSS_APPROVAL_REQUIRED');
  const selected = { schemaVersion: 1, repository: REPOSITORY, sha, tree: git(source, 'rev-parse', 'HEAD^{tree}'),
    controllerSha, runId: String(runId), buildAttempt: String(buildAttempt), platform: 'linux/amd64' };
  requireGate(/^\d+$/.test(selected.runId) && /^[1-9]\d*$/.test(selected.buildAttempt), 'INVALID_RUN_ID');
  writeFileSync(output, `${JSON.stringify(selected, null, 2)}\n`);
  return selected;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'prepare') {
    const e = process.env;
    prepareSource({ source: e.SOURCE_DIR, trusted: e.TRUSTED_DIR, sha: e.SOURCE_SHA,
      controllerSha: e.CONTROLLER_SHA, runId: e.GITHUB_RUN_ID, buildAttempt: e.GITHUB_RUN_ATTEMPT, output: e.SOURCE_OUTPUT });
  } else throw new Error('usage: source.mjs prepare');
}
