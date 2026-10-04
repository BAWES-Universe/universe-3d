import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, readlink, realpath, lstat, statfs, mkdir, mkdtemp, rm, copyFile, open } from 'node:fs/promises';
import { join, resolve, relative, posix } from 'node:path';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fingerprint, requireGate } from './contracts.mjs';
import { observeImageStorage } from './image-reader.mjs';
const execute = promisify(execFile);
const inside = (path, directory) => path === directory || (directory === '/' ? path.startsWith('/') : path.startsWith(directory + '/'));
const unescapeMount = value => value.replace(/\\([0-7]{3})/g, (_, n) => String.fromCharCode(parseInt(n, 8)));
function parseMounts(text) {
  return text.trim().split('\n').filter(Boolean).map(line => {
    const fields = line.split(' '), separator = fields.indexOf('-');
    requireGate(separator >= 6 && fields.length > separator + 2 && /^[0-9]+:[0-9]+$/.test(fields[2]), 'INVALID_MOUNT_INVENTORY');
    return { device: fields[2].split(':').map(Number).join(':'), root: unescapeMount(fields[3]), point: unescapeMount(fields[4]), type: fields[separator + 1] };
  });
}
function covering(path, inventory) { return inventory.filter(m => inside(path, m.point)).sort((a, b) => b.point.length - a.point.length)[0]; }
function fileDevice(stat) {
  const dev = BigInt(stat.dev);
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
  const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
  return `${major}:${minor}`;
}


/** Real observations, invoked only by an explicitly installed host-local runner.
 * No Docker mutation, shell evaluation, socket exposure, SSH setup or secret IO.
 */
export class LinuxHostSystem {
  constructor({ docker = '/usr/bin/docker', socket, identity, proc = '/proc', machineIdPath = '/etc/machine-id', now = Date.now } = {}) { Object.assign(this, { dockerPath: docker, socket, identity, proc, machineIdPath, now }); }
  async docker(args) {
    requireGate(this.socket?.startsWith('/') && !this.socket.includes('\0'), 'LOCAL_DOCKER_SOCKET_REQUIRED');
    const socket = await lstat(this.socket);
    requireGate(socket.isSocket() && !socket.isSymbolicLink() && socket.uid === 0 && await realpath(this.socket) === this.socket, 'UNSAFE_DOCKER_SOCKET');
    const config = await mkdtemp(join(tmpdir(), 'universe-docker-read-'));
    try {
      // Never inherit DOCKER_HOST, DOCKER_CONTEXT, proxy/auth environment or a
      // saved Docker context/config. Only the reviewed local Unix socket is used.
      const { stdout } = await execute(this.dockerPath, ['--config', config, '--host', `unix://${this.socket}`, ...args], { timeout: 15000, maxBuffer: 8 * 1024 * 1024, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } });
      return stdout.trim();
    } finally { await rm(config, { recursive: true, force: true }); }
  }
  async verifyHost() {
    requireGate(this.identity?.reviewId && this.identity.engineId && this.identity.machineId && this.identity.pidNamespace, 'HOST_IDENTITY_UNREVIEWED');
    const engine = JSON.parse(await this.docker(['info', '--format', '{{json .}}']));
    const machineId = (await readFile(this.machineIdPath, 'utf8')).trim();
    const namespace = await readlink(join(this.proc, 'self/ns/pid'));
    requireGate(engine.ID === this.identity.engineId && machineId === this.identity.machineId && namespace === this.identity.pidNamespace && await readlink(join(this.proc, '1/ns/pid')) === namespace && engine.OSType === 'linux', 'WRONG_DOCKER_HOST_NAMESPACE');
  }
  async verifyStoragePaths(paths) {
    const inventory = parseMounts(await readFile(join(this.proc, 'self/mountinfo'), 'utf8'));
    for (const path of paths) { const mount = covering(path, inventory); requireGate(mount && ['ext4', 'xfs', 'btrfs'].includes(mount.type), 'UNSUPPORTED_CONTROL_FILESYSTEM'); }
  }
  async inventory(volumeId, label) {
    await this.verifyHost();
    const [volume] = JSON.parse(await this.docker(['volume', 'inspect', volumeId]));
    requireGate(volume.Name === volumeId && volume.Driver === 'local' && (!volume.Options || Object.keys(volume.Options).length === 0), 'UNSUPPORTED_VOLUME_DRIVER');
    const path = await realpath(volume.Mountpoint);
    requireGate(path === volume.Mountpoint && resolve(path) === path, 'UNSAFE_VOLUME_PATH');
    const stat = await lstat(path);
    const hostMounts = parseMounts(await readFile(join(this.proc, 'self/mountinfo'), 'utf8'));
    const hostMount = covering(path, hostMounts);
    requireGate(hostMount && ['ext4', 'xfs', 'btrfs'].includes(hostMount.type), 'UNSUPPORTED_HOST_FILESYSTEM');
    const volumeRoot = posix.join(hostMount.root, relative(hostMount.point, path));
    const volumeFiles = new Set(); let entries = 0;
    const indexFiles = async directory => {
      for (const name of await readdir(directory)) {
        requireGate(++entries <= 100000, 'VOLUME_INVENTORY_TOO_LARGE');
        const item = join(directory, name), metadata = await lstat(item);
        requireGate(!metadata.isSymbolicLink() && (metadata.isDirectory() || metadata.isFile()), 'UNSAFE_VOLUME_ENTRY');
        if (metadata.isDirectory()) await indexFiles(item);
        else { requireGate(metadata.nlink === 1, 'VOLUME_HARDLINK_UNPROVEN'); volumeFiles.add(`${fileDevice(metadata)}:${metadata.ino}`); }
      }
    };
    await indexFiles(path);
    requireGate(stat.isDirectory() && !stat.isSymbolicLink(), 'UNSAFE_VOLUME_PATH');
    const ids = (await this.docker(['ps', '-aq', '--no-trunc'])).split('\n').filter(Boolean);
    requireGate(ids.length <= 1000 && ids.every(id => /^[a-f0-9]{64}$/.test(id)), 'INCOMPLETE_CONTAINER_INVENTORY');
    const all = ids.length ? JSON.parse(await this.docker(['inspect', ...ids])) : [];
    requireGate(all.length === ids.length, 'INCOMPLETE_CONTAINER_INVENTORY');
    const mounts = all.filter(c => c.Mounts?.some(m => m.Name === volumeId || inside(m.Source ?? '', path) || inside(path, m.Source ?? '\0')));
    const processes = await readdir(this.proc);
    requireGate(processes.filter(p => /^\d+$/.test(p)).length <= 100000, 'INCOMPLETE_PROCESS_INVENTORY');
    let unmanagedWriters = 0, managedProcessReferences = 0, managedFileReferences = 0;
    for (const pid of processes.filter(p => /^\d+$/.test(p))) {
      try {
        const cgroup = await readFile(join(this.proc, pid, 'cgroup'), 'utf8');
        const managed = mounts.some(c => c.Config?.Labels?.[label.key] === label.value && cgroup.includes(c.Id));
        // Inspect every namespace, not only open file descriptors in our namespace.
        const namespace = parseMounts(await readFile(join(this.proc, pid, 'mountinfo'), 'utf8'));
        const inVolume = target => {
          const mount = covering(target, namespace);
          return mount?.device === hostMount.device && inside(posix.join(mount.root, relative(mount.point, target)), volumeRoot);
        };
        let references = namespace.some(m => m.device === hostMount.device && inside(m.root, volumeRoot));
        let fileReferences = false;
        // A mapped SQLite file can stay writable after its FD is closed. Match
        // both device/inode and the pathname resolved through THIS namespace.
        const maps = await readFile(join(this.proc, pid, 'maps'), 'utf8');
        for (const mapping of maps.split('\n').filter(Boolean)) {
          const fields = mapping.trim().split(/\s+/);
          requireGate(fields.length >= 5 && /^[0-9a-f]+:[0-9a-f]+$/i.test(fields[3]), 'INCOMPLETE_PROCESS_INVENTORY');
          const device = fields[3].split(':').map(n => parseInt(n, 16)).join(':');
          const target = fields.slice(5).join(' ').replace(/ \(deleted\)$/, '');
          if (volumeFiles.has(`${device}:${fields[4]}`) || (target.startsWith('/') && inVolume(target))) fileReferences = true;
        }
        for (const fd of await readdir(join(this.proc, pid, 'fd'))) {
          try { const target = await readlink(join(this.proc, pid, 'fd', fd)); if (inVolume(target.replace(/ \(deleted\)$/, '')) || inside(target.replace(/ \(deleted\)$/, ''), path)) fileReferences = true; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        references ||= fileReferences;
        if (references) { if (managed) managedProcessReferences++; else unmanagedWriters++; }
        if (managed && fileReferences) managedFileReferences++;
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw Object.assign(new Error('Complete process visibility unavailable'), { code: 'INCOMPLETE_PROCESS_INVENTORY' }); }
    }
    const after = (await this.docker(['ps', '-aq', '--no-trunc'])).split('\n').filter(Boolean);
    requireGate(fingerprint(ids.sort()) === fingerprint(after.sort()), 'CONTAINER_INVENTORY_CHANGED');
    return { path, stat, all: mounts, unmanagedWriters, managedProcessReferences, managedFileReferences, observedAt: this.now() };
  }
  async capacity(path, reserve) {
    const memory = await readFile(join(this.proc, 'meminfo'), 'utf8');
    const match = memory.match(/^MemAvailable:\s+(\d+) kB$/m); requireGate(match, 'HOST_CAPACITY_UNAVAILABLE');
    const disk = await statfs(path, { bigint: true });
    const freeMemoryBytes = Number(match[1]) * 1024 - reserve.memoryBytes;
    const freeDiskBytes = Number(disk.bavail * disk.bsize) - reserve.diskBytes;
    requireGate(Number.isSafeInteger(freeMemoryBytes) && Number.isSafeInteger(freeDiskBytes), 'HOST_CAPACITY_UNAVAILABLE');
    return { observedAt: this.now(), freeMemoryBytes, freeDiskBytes, reservedCapacityExcluded: true };
  }
  async schema(volumePath, relativeDatabase, schemas) {
    requireGate(relativeDatabase === 'universe.sqlite', 'DATABASE_PATH_NOT_ALLOWED');
    const path = join(volumePath, relativeDatabase), stat = await lstat(path);
    requireGate(stat.isFile() && !stat.isSymbolicLink(), 'UNSAFE_DATABASE_PATH');
    const db = new DatabaseSync(path, { readOnly: true }); let rows, storageCompatibility;
    try {
      db.exec('BEGIN');
      rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
      storageCompatibility = observeImageStorage(db);
      db.exec('ROLLBACK');
    }
    finally { db.close(); }
    const schemaHash = fingerprint(rows);
    const schema = schemas.find(s => s.fingerprint === schemaHash && s.reviewId)?.schema;
    requireGate(schema, 'DATABASE_SCHEMA_UNREVIEWED');
    return { observedAt: this.now(), schema, schemaHash, storageCompatibility, storageEvidenceKind: 'sqlite-metadata-and-image-rows' };
  }
  async backup(source, destinationRoot, operationId, maximumBytes) {
    const root = await lstat(destinationRoot);
    requireGate(root.isDirectory() && !root.isSymbolicLink() && (root.mode & 0o777) === 0o700 && root.uid === process.getuid() && await realpath(destinationRoot) === destinationRoot && !inside(destinationRoot, source), 'UNSAFE_BACKUP_DIRECTORY');
    const target = join(destinationRoot, createHash('sha256').update(operationId).digest('hex'));
    await mkdir(target, { mode: 0o700 }); // Never overwrite or delete an old backup.
    const manifest = []; let bytes = 0;
    const copy = async (from, to) => {
      for (const entry of await readdir(from, { withFileTypes: true })) {
        const input = join(from, entry.name), output = join(to, entry.name), stat = await lstat(input);
        requireGate(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()) && stat.nlink <= (stat.isDirectory() ? 100000 : 1), 'UNSAFE_BACKUP_ENTRY');
        if (stat.isDirectory()) { await mkdir(output, { mode: 0o700 }); await copy(input, output); }
        else {
          bytes += stat.size; requireGate(bytes <= maximumBytes, 'BACKUP_LIMIT_EXCEEDED');
          await copyFile(input, output, 1);
          const file = await open(output, 'r'); try { await file.sync(); } finally { await file.close(); }
          const hash = createHash('sha256'); for await (const chunk of createReadStream(output)) hash.update(chunk);
          manifest.push({ path: relative(source, input), bytes: stat.size, sha256: hash.digest('hex') });
        }
      }
      const directory = await open(to, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    };
    await copy(source, target);
    const file = await open(join(target, 'backup-manifest.json'), 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(manifest)); await file.sync(); } finally { await file.close(); }
    const dir = await open(target, 'r'); try { await dir.sync(); } finally { await dir.close(); }
    const parent = await open(destinationRoot, 'r'); try { await parent.sync(); } finally { await parent.close(); }
    return { observedAt: this.now(), reference: target, consistent: true, retained: true, bytes };
  }
  async running(container, imageName, host) {
    requireGate(container.State?.Running === true && container.State?.Health?.Status === 'healthy', 'APPLICATION_NOT_HEALTHY');
    const [image] = JSON.parse(await this.docker(['image', 'inspect', container.Image]));
    const pin = image.RepoDigests?.find(value => value.startsWith(`${imageName}@`)); requireGate(pin, 'RUNNING_DIGEST_UNKNOWN');
    const address = Object.values(container.NetworkSettings.Networks ?? {}).map(n => n.IPAddress).find(isIP);
    requireGate(address, 'HEALTH_ADDRESS_UNKNOWN');
    const response = await fetch(`http://${address}:4190/api/health`, { headers: { Host: host }, redirect: 'error', signal: AbortSignal.timeout(5000) });
    requireGate(response.status === 200 && (await response.json()).ok === true, 'APPLICATION_NOT_HEALTHY');
    return { runningDigest: pin.split('@')[1], sourceSha: image.Config.Labels?.['org.opencontainers.image.revision'], healthy: true };
  }
}
