import { readdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fingerprint, requireGate } from './contracts.mjs';

export async function controllerCodeFingerprint(directory = import.meta.dirname) {
  const files = (await readdir(directory)).filter(name => name.endsWith('.mjs')).sort();
  const hash = createHash('sha256');
  for (const name of files) { hash.update(name + '\0'); hash.update(await readFile(join(directory, name))); }
  return hash.digest('hex');
}
/** Uses an existing owner-reviewed command route. It creates no connection,
 * installation, daemon, key or credential, and never invokes a shell.
 * The installed helper receives one bounded JSON request and exposes no raw exec.
 */
export async function invokeHost(policy, action, release, { executeCommand } = {}) {
  const route = policy.hostExecution;
  requireGate(route?.reviewId && Array.isArray(route.command) && route.command.length > 0 && route.command[0].startsWith('/') && route.command.every(arg => typeof arg === 'string' && !arg.includes('\0')), 'HOST_EXECUTION_ROUTE_NOT_APPROVED');
  requireGate(['capabilities', 'deploy'].includes(action), 'HOST_OPERATION_NOT_ALLOWED');
  const input = JSON.stringify({ schemaVersion: 1, action, policyFingerprint: fingerprint(policy), codeFingerprint: await controllerCodeFingerprint(), ...(release ? { release } : {}) });
  requireGate(Buffer.byteLength(input) <= 65536, 'HOST_REQUEST_TOO_LARGE');
  // Promisified execFile cannot take stdin via options; use a pipe explicitly.
  const run = executeCommand ?? ((command, args, stdin) => new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: 18 * 60 * 1000, maxBuffer: 2 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME } }, (error, stdout) => error ? reject(Object.assign(new Error('Approved host route failed; inspect its scoped receipt'), { code: 'HOST_ROUTE_FAILED' })) : resolve(stdout));
    child.stdin.end(stdin);
  }));
  const stdout = await run(route.command[0], route.command.slice(1), input);
  requireGate(Buffer.byteLength(stdout) <= 2 * 1024 * 1024, 'HOST_RESPONSE_TOO_LARGE');
  const response = JSON.parse(stdout);
  requireGate(response.schemaVersion === 1 && response.codeFingerprint === await controllerCodeFingerprint() && response.policyFingerprint === fingerprint(policy), 'HOST_IDENTITY_MISMATCH');
  requireGate(response.ok === true, response.errorCode ?? 'HOST_OPERATION_FAILED');
  return response.result;
}
