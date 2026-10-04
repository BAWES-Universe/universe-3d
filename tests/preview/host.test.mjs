import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, lstat, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { HostStore } from '../../deploy/preview/host-store.mjs';
import { LinuxHostSystem } from '../../deploy/preview/host-system.mjs';
import { LinuxHostEvidence } from '../../deploy/preview/host-evidence.mjs';
import { handleHostRequest } from '../../deploy/preview/host-runner.mjs';
import { invokeHost, controllerCodeFingerprint } from '../../deploy/preview/host-protocol.mjs';
import { fingerprint } from '../../deploy/preview/contracts.mjs';
import { fixture, digest, readerEvidence, storage } from './fixtures.mjs';
async function temporary(t) { const root = await mkdtemp(join(tmpdir(), 'universe-host-test-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function scenario(t) {
  const f = fixture(); const directory = await temporary(t); const store = new HostStore(directory);
  await store.write('state.json', f.adapter.state);
  const facts = { running: true, digest: digest('1'), schema: 'v1', pending: [], unmanaged: 0, calls: [], failStart: false, terminalFailure: false };
  Object.assign(f.policy, { hostAdapter: 'host-command', coolifyOrigin: 'https://coolify.example.invalid', apiProfile: { reviewId: 'synthetic-profile', version: 'synthetic-version', queueListIncludesPending: true, automaticDeploymentField: 'settings.is_auto_deploy_enabled' }, hostExecution: { reviewId: 'synthetic-route', command: ['/not-executed/helper'] }, hostLocal: { dockerSocket: '/synthetic/docker.sock', hostIdentity: { reviewId: 'synthetic-host' }, installationReviewId: 'synthetic-install', exclusiveMutationAuthorityReviewId: 'synthetic-exclusive', containerLabel: { key: 'preview.app', value: 'isolated-preview' }, database: 'universe.sqlite', stateDirectory: directory, backupDirectory: directory + '/backups', allowedHost: 'preview.example.invalid', schemaFingerprints: [{ fingerprint: 'synthetic', schema: 'v1', reviewId: 'synthetic' }], reservedMemoryBytes: 100, reservedDiskBytes: 100, maximumBackupBytes: 10000 } });
  f.policy.reviewedReleases = [{ ...f.release, approvalId: 'synthetic-release-approval' }];
  const container = () => ({ Id: '1'.repeat(64), Config: { Labels: { 'preview.app': 'isolated-preview' } }, State: { Running: facts.running, Restarting: false, Health: { Status: 'healthy' } }, HostConfig: { Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'], NetworkMode: 'private', PidMode: '', RestartPolicy: { Name: 'no' } }, Mounts: [{ Name: f.policy.volumeId, Destination: '/data', Type: 'volume' }] });
  const system = {
    verifyStoragePaths: async () => {},
    inventory: async () => ({ path: '/synthetic-volume', stat: { uid: 1000, gid: 1000, mode: 0o700 }, all: [container()], unmanagedWriters: facts.unmanaged, managedProcessReferences: facts.running ? 1 : 0, managedFileReferences: facts.running ? 1 : 0, observedAt: Date.now() }),
    capacity: async () => ({ observedAt: Date.now(), freeMemoryBytes: 10000, freeDiskBytes: 10000, reservedCapacityExcluded: true }),
    schema: async () => ({ observedAt: Date.now(), schema: facts.schema, storageCompatibility: storage(), storageEvidenceKind: 'sqlite-metadata-and-image-rows' }),
    backup: async () => { facts.calls.push('backup'); return { observedAt: Date.now(), reference: 'synthetic-backup', consistent: true, retained: true }; },
    running: async () => ({ runningDigest: facts.digest, sourceSha: facts.digest === f.release.digest ? f.release.sha : f.adapter.state.current.sha, healthy: true })
  };
  const client = {
    inspect: async () => ({ uuid: f.policy.applicationId, id: 23, build_pack: 'dockerimage', settings: { is_auto_deploy_enabled: false } }),
    pendingDeployments: async () => facts.pending,
    reachableResources: async () => [f.policy.applicationId],
    installedVersion: async () => ({ value: 'synthetic-version', observedAt: Date.now() }),
    stop: async () => { facts.calls.push('stop'); facts.running = false; },
    startPinned: async pin => {
      facts.calls.push('start'); facts.digest = pin.split('@')[1]; facts.running = true;
      if (facts.digest === f.release.digest) facts.schema = 'v2';
      if (facts.failStart) { facts.pending.push({ status: 'queued' }); throw Error('Response lost after queueing'); }
      if (facts.terminalFailure && facts.digest === f.release.digest) throw Object.assign(Error('Known terminal failure'), { code: 'DEPLOYMENT_FAILED' });
    }
  };
  const github = { verifyBuildRun: async () => ({}), imageReaderDescriptor: async target => readerEvidence(target), request: async () => ({ tree: { sha: f.release.tree } }), desired: async () => ({ sha: f.release.sha, tree: f.release.tree, generation: f.release.generation }) };
  const request = { schemaVersion: 1, action: 'deploy', release: f.release, policyFingerprint: fingerprint(f.policy), codeFingerprint: await controllerCodeFingerprint() };
  return { ...f, directory, store, facts, system, client, github, request, env: { UNIVERSE_PREVIEW_HOST_LOCAL: 'OWNER_APPROVED', COOLIFY_TOKEN: 'synthetic-not-a-credential' } };
}
test('host store provides real exclusive lock and durable atomic CAS on synthetic local files', async t => {
  const directory = await temporary(t); const store = new HostStore(directory); await store.write('state.json', { version: 1 });
  await store.withExclusiveLease('preview', async lease => {
    await assert.rejects(store.withExclusiveLease('preview', async () => {}), { code: 'HOST_CONTROLLER_LOCKED' });
    await store.commitState({ version: 2, frozen: true }, 1, lease);
    assert.deepEqual(await store.readState(lease), { version: 2, frozen: true });
    await assert.rejects(store.commitState({ version: 3 }, 1, lease), { code: 'STATE_CAS_CONFLICT' });
  });
  await store.withExclusiveLease('preview', async lease => assert.equal((await store.readState(lease)).version, 2));
});
test('host store never steals stale locks and rejects writable/symlink state directories', async t => {
  const directory = await temporary(t); const store = new HostStore(directory);
  await mkdir(join(directory, 'controller.lock')); await writeFile(join(directory, 'controller.lock/owner'), 'dead-process');
  await assert.rejects(store.withExclusiveLease('preview', async () => {}), { code: 'HOST_CONTROLLER_LOCKED' });
  await chmod(directory, 0o777); await assert.rejects(store.verifyDirectory(), { code: 'UNSAFE_STATE_DIRECTORY' }); await chmod(directory, 0o700);
  const alias = directory + '-alias'; await symlink(directory, alias); t.after(() => rm(alias));
  await assert.rejects(new HostStore(alias).verifyDirectory(), { code: 'UNSAFE_STATE_DIRECTORY' });
});
test('host-local helper completes the real controller with injected synthetic external IO', async t => {
  const f = await scenario(t); const receipt = await handleHostRequest(f.request, f.policy, f.env, f);
  assert.equal(receipt.outcome, 'healthy'); assert.deepEqual(f.facts.calls, ['stop', 'backup', 'start']);
  const durable = await f.store.read('state.json'); assert.equal(durable.frozen, false); assert.equal(durable.current.digest, f.release.digest);
});
test('lost asynchronous start response freezes and forbids even a recovery stop/start', async t => {
  const f = await scenario(t); f.facts.failStart = true;
  const receipt = await handleHostRequest(f.request, f.policy, f.env, f);
  assert.equal(receipt.outcome, 'frozen-recovery-uncertain'); assert.equal(receipt.recoveryError, 'ASYNC_REQUEST_UNCERTAIN');
  assert.deepEqual(f.facts.calls, ['stop', 'backup', 'start']); assert.equal((await f.store.read('state.json')).frozen, true);
  assert.equal((await f.store.read('mutation.json')).status, 'uncertain');
});
test('positively observed terminal deployment failure allows compatible rollback', async t => {
  const f = await scenario(t); f.facts.terminalFailure = true;
  const receipt = await handleHostRequest(f.request, f.policy, f.env, f);
  assert.equal(receipt.outcome, 'rolled-back'); assert.equal(f.facts.digest, digest('1')); assert.equal((await f.store.read('state.json')).frozen, true);
});
test('pending external jobs or unmanaged processes block before any mutation', async t => {
  for (const mode of ['pending', 'unmanaged']) {
    const f = await scenario(t); if (mode === 'pending') f.facts.pending = [{}]; else f.facts.unmanaged = 1;
    await assert.rejects(handleHostRequest(f.request, f.policy, f.env, f)); assert.deepEqual(f.facts.calls, []);
  }
});
test('host helper rejects mismatched source package/config and inactive installation', async t => {
  const f = await scenario(t);
  await assert.rejects(handleHostRequest({ ...f.request, codeFingerprint: 'forged' }, f.policy, f.env, f), { code: 'HOST_IDENTITY_MISMATCH' });
  await assert.rejects(handleHostRequest({ ...f.request, policyFingerprint: 'forged' }, f.policy, f.env, f), { code: 'HOST_IDENTITY_MISMATCH' });
  await assert.rejects(handleHostRequest(f.request, f.policy, {}, f), { code: 'HOST_INSTALLATION_NOT_APPROVED' }); assert.deepEqual(f.facts.calls, []);
});
test('approved command bridge sends bounded data, never credentials or arbitrary shell text', async t => {
  const f = await scenario(t);
  const result = await invokeHost(f.policy, 'capabilities', undefined, { executeCommand: async (command, args, stdin) => {
    assert.equal(command, '/not-executed/helper'); assert.deepEqual(args, []); const request = JSON.parse(stdin); assert.equal(request.action, 'capabilities'); assert(!stdin.includes('synthetic-not-a-credential'));
    return JSON.stringify({ schemaVersion: 1, ok: true, codeFingerprint: request.codeFingerprint, policyFingerprint: request.policyFingerprint, result: ['synthetic'] });
  } });
  assert.deepEqual(result, ['synthetic']);
  await assert.rejects(invokeHost({ ...f.policy, hostExecution: null }, 'deploy'), { code: 'HOST_EXECUTION_ROUTE_NOT_APPROVED' });
});
test('real SQLite schema observation is read-only and requires a reviewed exact fingerprint', async t => {
  const directory = await temporary(t); const db = new DatabaseSync(join(directory, 'universe.sqlite')); db.exec('CREATE TABLE example(id INTEGER PRIMARY KEY, value TEXT)');
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(); db.close();
  const system = new LinuxHostSystem();
  await assert.rejects(system.schema(directory, 'universe.sqlite', []), { code: 'DATABASE_SCHEMA_UNREVIEWED' });
  const result = await system.schema(directory, 'universe.sqlite', [{ fingerprint: fingerprint(rows), schema: 'example-v1', reviewId: 'synthetic-review' }]); assert.equal(result.schema, 'example-v1');
});
test('backup copies only the synthetic stopped volume and retains prior backup', async t => {
  const root = await temporary(t), source = join(root, 'source'), destination = join(root, 'backups');
  await mkdir(source, { mode: 0o700 }); await mkdir(destination, { mode: 0o700 }); await writeFile(join(source, 'universe.sqlite'), 'synthetic bytes');
  const system = new LinuxHostSystem(); const backup = await system.backup(source, destination, 'operation-1', 1000);
  assert.equal(await readFile(join(backup.reference, 'universe.sqlite'), 'utf8'), 'synthetic bytes');
  await assert.rejects(system.backup(source, destination, 'operation-1', 1000), { code: 'EEXIST' });
  await symlink('/etc/passwd', join(source, 'escape')); await assert.rejects(system.backup(source, destination, 'operation-2', 1000), { code: 'UNSAFE_BACKUP_ENTRY' });
});
async function processFixture(t) {
  const root = await temporary(t), proc = join(root, 'proc'), volume = join(root, 'volume');
  await mkdir(proc); await mkdir(join(proc, 'self')); await writeFile(join(proc, 'self/mountinfo'), '20 1 8:1 / / rw - ext4 /dev/example rw\n'); await mkdir(volume, { mode: 0o700 }); await mkdir(join(proc, '10')); await mkdir(join(proc, '10/fd'));
  await writeFile(join(proc, '10/maps'), '');
  await writeFile(join(proc, '10/cgroup'), '0::/system.slice/example');
  await writeFile(join(proc, '10/mountinfo'), '20 1 8:1 / / rw - ext4 /dev/example rw\n');
  await writeFile(join(proc, 'meminfo'), 'MemAvailable: 10000 kB\n');
  const id = 'a'.repeat(64); const containers = [{ Id: id, Config: { Labels: { 'preview.app': 'preview' } }, Mounts: [{ Name: 'volume', Source: volume }] }];
  const system = new LinuxHostSystem({ proc });
  system.verifyHost = async () => {}; // Explicit synthetic host identity, never live proof
  system.docker = async args => args[0] === 'volume' ? JSON.stringify([{ Name: 'volume', Driver: 'local', Options: null, Mountpoint: volume }]) : args[0] === 'ps' ? id : JSON.stringify(containers);
  return { root, proc, volume, id, containers, system, label: { key: 'preview.app', value: 'preview' } };
}
test('real observation parser inventories synthetic Docker containers and process namespaces', async t => {
  const f = await processFixture(t); const inventory = await f.system.inventory('volume', f.label);
  assert.equal(inventory.all.length, 1); assert.equal(inventory.unmanagedWriters, 0);
  await symlink(join(f.volume, 'universe.sqlite'), join(f.proc, '10/fd/3'));
  assert.equal((await f.system.inventory('volume', f.label)).unmanagedWriters, 1);
  await writeFile(join(f.proc, '10/cgroup'), `0::/docker/${f.id}`);
  assert.equal((await f.system.inventory('volume', f.label)).unmanagedWriters, 0);
});
test('unmanaged namespace bind mounts count even with no open DB descriptor', async t => {
  const f = await processFixture(t); await writeFile(join(f.proc, '10/mountinfo'), `20 1 8:1 ${f.volume} /alias rw - ext4 /dev/example rw\n`);
  assert.equal((await f.system.inventory('volume', f.label)).unmanagedWriters, 1);
});
test('container root/ancestor bind mounts cannot conceal access to the preview volume', async t => {
  const f = await processFixture(t); f.containers[0].Mounts = [{ Type: 'bind', Source: '/', Destination: '/host' }];
  const inventory = await f.system.inventory('volume', f.label); assert.equal(inventory.all.length, 1);
});
test('network-backed named volumes and incomplete process visibility fail closed', async t => {
  const f = await processFixture(t); const docker = f.system.docker;
  f.system.docker = async args => args[0] === 'volume' ? JSON.stringify([{ Name: 'volume', Driver: 'local', Options: { type: 'nfs' }, Mountpoint: f.volume }]) : docker(args);
  await assert.rejects(f.system.inventory('volume', f.label), { code: 'UNSUPPORTED_VOLUME_DRIVER' });
  f.system.docker = docker;
  await rm(join(f.proc, '10/mountinfo')); await mkdir(join(f.proc, '10/mountinfo'));
  await assert.rejects(f.system.inventory('volume', f.label), { code: 'INCOMPLETE_PROCESS_INVENTORY' });
});
test('fresh capacity subtracts explicit host reservations', async t => {
  const f = await processFixture(t); const capacity = await f.system.capacity(f.volume, { memoryBytes: 100, diskBytes: 100 });
  assert.equal(capacity.freeMemoryBytes, 10000 * 1024 - 100); assert(capacity.freeDiskBytes > 0); assert.equal(capacity.reservedCapacityExcluded, true);
});
test('host evidence rejects auto-deploy and restart bypasses before mutation', async t => {
  const f = await scenario(t); f.client.inspect = async () => ({ uuid: f.policy.applicationId, id: 23, build_pack: 'dockerimage', settings: { is_auto_deploy_enabled: true } });
  await assert.rejects(handleHostRequest(f.request, f.policy, f.env, f), { code: 'AUTOMATIC_DEPLOYMENT_NOT_DISABLED' }); assert.deepEqual(f.facts.calls, []);
});
test('an unmanaged mmap survives closed FDs and is counted through namespace aliases', async t => {
  const f = await processFixture(t);
  await writeFile(join(f.proc, '10/mountinfo'), `20 1 8:1 ${f.volume} /alias rw - ext4 /dev/example rw\n`);
  await writeFile(join(f.proc, '10/maps'), '7f00-8f00 rw-s 00000000 08:01 555 /alias/universe.sqlite\n');
  assert.equal((await f.system.inventory('volume', f.label)).unmanagedWriters, 1);
});
test('invisible process memory mappings fail closed rather than certifying no writers', async t => {
  const f = await processFixture(t); await rm(join(f.proc, '10/maps')); await mkdir(join(f.proc, '10/maps'));
  await assert.rejects(f.system.inventory('volume', f.label), { code: 'INCOMPLETE_PROCESS_INVENTORY' });
});
test('Docker local driver on a host network filesystem is not local durable storage proof', async t => {
  const f = await processFixture(t); await writeFile(join(f.proc, 'self/mountinfo'), '20 1 8:1 / / rw - nfs server:/data rw\n');
  await assert.rejects(f.system.inventory('volume', f.label), { code: 'UNSUPPORTED_HOST_FILESYSTEM' });
});
test('a successful run cannot authorize a mismatched host release tuple', async t => {
  const f = await scenario(t); f.policy.reviewedReleases[0].digest = digest('9'); f.request.policyFingerprint = fingerprint(f.policy);
  await assert.rejects(handleHostRequest(f.request, f.policy, f.env, f), { code: 'HOST_RELEASE_TUPLE_UNAPPROVED' }); assert.deepEqual(f.facts.calls, []);
});
test('host initializer only records the observed approved baseline and never overwrites state', async t => {
  const { initializeHostState } = await import('../../deploy/preview/host-initialize.mjs');
  const f = await scenario(t); f.policy.approvedBaseline = { approvalId: 'synthetic-baseline', sha: f.release.sha, tree: f.release.tree, digest: f.release.digest, release: f.release }; f.policy.hostLocal.stateInitializationApprovalId = 'synthetic-initialization';
  await assert.rejects(initializeHostState(f.policy, f.env, f), { code: 'HOST_STATE_EXISTS' });
  await rm(join(f.directory, 'state.json')); f.facts.digest = f.release.digest; f.facts.schema = f.release.schema;
  const result = await initializeHostState(f.policy, f.env, f); assert.equal(result.initialized, true); assert.deepEqual(f.facts.calls, []); assert.equal((await f.store.read('state.json')).current.digest, f.release.digest);
});
test('host initializer cannot certify a descriptor-less legacy baseline', async t => {
  const { initializeHostState } = await import('../../deploy/preview/host-initialize.mjs');
  const f = await scenario(t); f.policy.approvedBaseline = { approvalId: 'synthetic-baseline', sha: f.release.sha, tree: f.release.tree, digest: f.release.digest, release: f.release }; f.policy.hostLocal.stateInitializationApprovalId = 'synthetic-initialization';
  await rm(join(f.directory, 'state.json'));
  f.github.imageReaderDescriptor = async target => ({ ...readerEvidence(target), descriptor: undefined });
  await assert.rejects(initializeHostState(f.policy, f.env, f), { code: 'IMAGE_READER_DESCRIPTOR_MISSING' });
  await assert.rejects(f.store.read('state.json'), { code: 'ENOENT' }); assert.deepEqual(f.facts.calls, []);
});
test('closed-FD mmap is detected by device/inode even when its visible path is an unrelated alias', async t => {
  const f = await processFixture(t); const database = join(f.volume, 'universe.sqlite'); await writeFile(database, 'synthetic'); const stat = await lstat(database); const dev = BigInt(stat.dev);
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n), minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
  await writeFile(join(f.proc, '10/maps'), `7f00-8f00 rw-s 00000000 ${major.toString(16)}:${minor.toString(16)} ${stat.ino} /unrelated/alias\n`);
  assert.equal((await f.system.inventory('volume', f.label)).unmanagedWriters, 1);
});
test('host identity binds engine, machine and full PID namespace using synthetic filesystem facts', async t => {
  const root = await temporary(t); await mkdir(join(root, 'self/ns'), { recursive: true }); await mkdir(join(root, '1/ns'), { recursive: true });
  await symlink('pid:[synthetic-host]', join(root, 'self/ns/pid')); await symlink('pid:[synthetic-host]', join(root, '1/ns/pid')); await writeFile(join(root, 'machine-id'), 'synthetic-machine\n');
  const system = new LinuxHostSystem({ proc: root, machineIdPath: join(root, 'machine-id'), identity: { reviewId: 'synthetic', engineId: 'synthetic-engine', machineId: 'synthetic-machine', pidNamespace: 'pid:[synthetic-host]' } });
  system.docker = async () => JSON.stringify({ ID: 'synthetic-engine', OSType: 'linux' }); await system.verifyHost();
  system.docker = async () => JSON.stringify({ ID: 'other-engine', OSType: 'linux' }); await assert.rejects(system.verifyHost(), { code: 'WRONG_DOCKER_HOST_NAMESPACE' });
});
test('stopped container metadata cannot hide a lingering managed mmap process', async t => {
  const f = await processFixture(t); f.containers[0].State = { Running: false, Restarting: false };
  await writeFile(join(f.proc, '10/cgroup'), `0::/docker/${f.id}`);
  await writeFile(join(f.proc, '10/maps'), `7f00-8f00 rw-s 00000000 08:01 555 ${f.volume}/universe.sqlite\n`);
  const inventory = await f.system.inventory('volume', f.label); assert.equal(inventory.unmanagedWriters, 0); assert.equal(inventory.managedProcessReferences, 1);
  const task = await scenario(t); task.facts.running = false; const observe = task.system.inventory;
  task.system.inventory = async (...args) => ({ ...await observe(...args), managedProcessReferences: 1 });
  const host = new LinuxHostEvidence({ policy: task.policy, client: task.client, system: task.system, store: task.store, wait: async () => {} });
  await host.withExclusiveLease(task.policy.applicationId, async lease => {
    await assert.rejects(host.waitForAllWritersTerminated(task.policy.volumeId, lease), { code: 'WRITER_TERMINATION_TIMEOUT' });
  });
});
test('healthy Docker healthcheck namespace access is not a second database writer', async t => {
  const f = await scenario(t); const inventory = f.system.inventory;
  f.system.inventory = async (...args) => ({ ...await inventory(...args), managedProcessReferences: f.facts.running ? 2 : 0, managedFileReferences: f.facts.running ? 1 : 0 });
  assert.equal((await handleHostRequest(f.request, f.policy, f.env, f)).outcome, 'healthy');
  const p = await processFixture(t); await writeFile(join(p.proc, '10/cgroup'), `0::/docker/${p.id}`); await writeFile(join(p.proc, '10/mountinfo'), `20 1 8:1 ${p.volume} /data rw - ext4 /dev/example rw\n`);
  const actual = await p.system.inventory('volume', p.label); assert.equal(actual.managedProcessReferences, 1); assert.equal(actual.managedFileReferences, 0);
});
