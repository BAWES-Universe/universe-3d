import { writeFileSync, appendFileSync } from 'node:fs';
import { github } from './github.mjs';
import { REPOSITORY, requireGate } from './contracts.mjs';
const e = process.env;
requireGate(e.GITHUB_REPOSITORY === REPOSITORY && e.UNIVERSE_DEV_ENABLED === 'true', 'CONTROLLER_DISABLED');
const desired = await github({ token: e.GH_TOKEN }).desired();
// Event workflow stays tied to its trusted main revision. A newer main run owns
// reconciliation after controller changes; never run PR-supplied authority.
if (desired.mainSha !== e.CONTROLLER_SHA) {
  appendFileSync(e.GITHUB_OUTPUT, 'sha=\n');
  console.log('SUPERSEDED: trusted main changed');
} else {
  writeFileSync('wanted.json', `${JSON.stringify(desired, null, 2)}\n`);
  appendFileSync(e.GITHUB_OUTPUT, `sha=${desired.sha}\npr=${desired.pr || ''}\n`);
  console.log(`Selected ${desired.sha} (${desired.pr ? `PR #${desired.pr}` : 'main'})`);
}
