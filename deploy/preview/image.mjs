import { execFileSync } from 'node:child_process';
import { readFile, appendFile } from 'node:fs/promises';
import { SHA, DIGEST, requireGate } from './contracts.mjs';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 180000 });
const [command, argument, recordPath] = process.argv.slice(2);
const inspect = image => JSON.parse(docker(['image', 'inspect', image]))[0];
if (command === 'load') {
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  requireGate(SHA.test(record.sha) && SHA.test(record.tree), 'INVALID_SOURCE');
  // Docker consumes archive data. Never unpack it over the trusted checkout,
  // source/shell/evaluate it, or execute its entrypoint in this publish-only job.
  docker(['image', 'load', '--input', argument]);
  const loaded = inspect(`universe-preview-build:${record.sha}`);
  requireGate(loaded.Config.Labels?.['org.opencontainers.image.revision'] === record.sha && loaded.Config.Labels?.['net.bawes.universe.source-tree'] === record.tree, 'IMAGE_SOURCE_MISMATCH');
  requireGate(/^sha256:[a-f0-9]{64}$/.test(loaded.Id), 'INVALID_IMAGE_ID');
  await appendFile(process.env.GITHUB_OUTPUT, `imageId=${loaded.Id}\n`);
} else if (command === 'digest') {
  const data = inspect(argument);
  const match = data.RepoDigests?.find(d => d.startsWith(process.env.EXPECTED_IMAGE + '@'));
  requireGate(match && DIGEST.test(match.split('@')[1]), 'PUBLISHED_DIGEST_MISSING');
  await appendFile(process.env.GITHUB_OUTPUT, `digest=${match.split('@')[1]}\n`);
} else if (command === 'smoke') {
  requireGate(/^ghcr\.io\/[a-z0-9-]+\/[a-z0-9._-]+@sha256:[a-f0-9]{64}$/.test(argument), 'SMOKE_REQUIRES_DIGEST');
  const name = `universe-preview-smoke-${process.pid}`;
  const constraints = ['--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=768m', '--cpus=1', '--tmpfs=/data:rw,noexec,nosuid,size=128m,uid=1000,gid=1000,mode=0700', '--tmpfs=/tmp:rw,noexec,nosuid,size=16m'];
  try {
    docker(['run', '-d', '--name', name, ...constraints, '-e', 'UNIVERSE_MODE=local', '-e', 'UNIVERSE_BIND_ADDRESS=127.0.0.1', '-e', 'UNIVERSE_TLS_MODE=local-http', '-e', 'UNIVERSE_COOKIE_SECURE=socket', argument]);
    let healthy = false;
    const probe = `const r=await fetch('http://127.0.0.1:4190/api/health');if(r.status!==200||(await r.json()).ok!==true)process.exit(1);const p=await fetch('http://127.0.0.1:4190/');if(p.status!==200||!(await p.text()).includes('/main.js'))process.exit(2);`;
    for (let i = 0; i < 20; i++) {
      try { docker(['exec', name, 'node', '--input-type=module', '-e', probe]); healthy = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
    requireGate(healthy, 'IMAGE_SMOKE_FAILED');
  } finally { try { docker(['rm', '-f', name]); } catch {} }
  console.log('Exact-digest isolated image health/static smoke passed; no public TLS, host capacity, durable data or real media proof');
} else throw new Error('Unknown image operation');
