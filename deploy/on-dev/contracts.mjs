import { createHash } from 'node:crypto';

export const REPOSITORY = 'BAWES-Universe/universe-3d';
export const DEFAULT_BRANCH = 'main';
export const LABEL = 'on-dev';
export const IMAGE = 'ghcr.io/bawes-universe/universe-3d';
export const APP = 'qwgitldz6ttlyqotoiy6fegd';
export const VOLUME = `${APP}-data`;
export const ORIGIN = 'https://3d.dev.bawes.net';
export const ENVIRONMENT = 'universe-3d-dev';
export const SHA = /^[a-f0-9]{40}$/;
export const DIGEST = /^sha256:[a-f0-9]{64}$/;
export class GateError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function requireGate(value, code) { if (!value) throw new GateError(code); }
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
export const identity = want => `${want.mainSha}:${want.pr || 'main'}:${want.sha}:${want.labelEvent || ''}`;
export function validateSelected(selected) {
  requireGate(selected?.repository === REPOSITORY && SHA.test(selected.sha) && SHA.test(selected.tree)
    && SHA.test(selected.controllerSha) && DIGEST.test(selected.digest) && DIGEST.test(selected.imageId)
    && /^\d+$/.test(String(selected.runId))
    && /^[1-9]\d*$/.test(String(selected.buildAttempt)), 'INVALID_RELEASE');
  requireGate(selected.pin === `${IMAGE}@${selected.digest}`, 'WRONG_IMAGE');
  return selected;
}
