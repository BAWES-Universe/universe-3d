import { readFileSync } from 'node:fs';

// Optional for ordinary local development; malformed metadata never masquerades
// as an identified release. This contains public build facts, never credentials.
export function readBuildInfo(path) {
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Invalid deployment build metadata'); }
  if (raw.schemaVersion !== 1 || raw.repository !== 'BAWES-Universe/universe-3d'
    || !/^[a-f0-9]{40}$/.test(raw.sha) || !/^[a-f0-9]{40}$/.test(raw.tree)
    || !/^[a-f0-9]{40}$/.test(raw.controllerSha) || !/^[a-f0-9]{64}$/.test(raw.compatibility)
    || !/^\d+$/.test(String(raw.runId)) || !/^[1-9]\d*$/.test(String(raw.buildAttempt))) throw new Error('Invalid deployment build metadata');
  return Object.freeze({ revision: raw.sha, tree: raw.tree, compatibility: raw.compatibility,
    controllerRevision: raw.controllerSha, runId: String(raw.runId), buildAttempt: String(raw.buildAttempt) });
}
