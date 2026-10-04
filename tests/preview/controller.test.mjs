import test from 'node:test';
import assert from 'node:assert/strict';
import { deployPreview, REQUIRED_CAPABILITIES } from '../../deploy/preview/controller.mjs';
import { UnimplementedHostAdapter } from '../../deploy/preview/host-adapter.mjs';
import { fixture, digest } from './fixtures.mjs';
const noMutation = f => assert.equal(f.adapter.calls.some(c => Array.isArray(c) && ['stop', 'start'].includes(c[0])), false);
async function rejected(f, code) { await assert.rejects(deployPreview(f), { code }); noMutation(f); }

test('healthy exact-digest release retains approved baseline separately from previous preview', async () => {
  const f = fixture(); const result = await deployPreview(f);
  assert.equal(result.outcome, 'healthy');
  assert.equal(f.adapter.state.current.digest, f.release.digest);
  assert.equal(f.adapter.state.previousHealthy.digest, digest('1'));
  assert.equal(f.adapter.state.approvedBaseline.digest, digest('0'));
  assert.deepEqual(f.adapter.calls.filter(c => Array.isArray(c)).map(c => c[0]), ['stop', 'start']);
});
test('checked-in host adapter is explicitly unimplemented and cannot mutate', async () => {
  const f = fixture(); f.adapter = new UnimplementedHostAdapter();
  assert.deepEqual(await f.adapter.capabilities(), []);
  await assert.rejects(deployPreview(f), { code: 'HOST_CAPABILITY_MISSING' });
});
test('every missing host capability fails before mutation', async t => {
  for (const capability of REQUIRED_CAPABILITIES) await t.test(capability, async () => {
    const f = fixture(); f.adapter.capabilities = async () => REQUIRED_CAPABILITIES.filter(c => c !== capability);
    await rejected(f, 'HOST_CAPABILITY_MISSING');
  });
});
test('unknown candidate compatibility blocks before stopping', async () => { const f = fixture(); f.policy.compatibility.shift(); await rejected(f, 'UPDATE_COMPATIBILITY_UNKNOWN'); });
test('unknown previous-digest compatibility blocks before stopping', async () => { const f = fixture(); f.policy.compatibility.pop(); await rejected(f, 'ROLLBACK_COMPATIBILITY_UNKNOWN'); });
test('intermediate database migration versions must also support rollback', async () => { const f = fixture(); f.policy.compatibility[0].intermediateSchemas.push('partial'); await rejected(f, 'ROLLBACK_COMPATIBILITY_UNKNOWN'); });
test('explicit digest and reset exceptions cannot enter routine deployment', async () => {
  for (const mode of ['explicit-digest', 'reset']) { const f = fixture(); f.mode = mode; await rejected(f, 'HUMAN_APPROVED_EXCEPTION_REQUIRED'); }
});
test('stale desired generation rejected inside lock before mutation', async () => { const f = fixture(); f.desired.generation = 'f'.repeat(64); await rejected(f, 'STALE_SELECTION'); });
test('queued controller re-reads desired selection after acquiring lease', async () => {
  const f = fixture(); let unlock; f.adapter.tail = new Promise(resolve => { unlock = resolve; });
  const running = deployPreview(f);
  await new Promise(resolve => setImmediate(resolve)); f.desired.generation = 'e'.repeat(64); unlock();
  await assert.rejects(running, { code: 'STALE_SELECTION' }); noMutation(f);
});
test('simultaneous duplicate runs serialize and replay cannot start another writer', async () => {
  const f = fixture();
  const result = await Promise.allSettled([deployPreview(f), deployPreview(f)]);
  assert.equal(result[0].value.outcome, 'healthy'); assert.equal(result[1].reason.code, 'REPLAYED_RELEASE');
  assert.equal(f.adapter.maxActive, 1);
  assert.equal(f.adapter.calls.filter(c => Array.isArray(c) && c[0] === 'start').length, 1);
});
test('state freeze blocks subsequent requests', async () => { const f = fixture(); f.adapter.state.frozen = true; await rejected(f, 'PREVIEW_FROZEN'); });
test('an unapproved baseline change cannot overwrite durable approved baseline', async () => { const f = fixture(); f.policy.approvedBaseline.digest = digest('8'); await rejected(f, 'BASELINE_POLICY_MISMATCH'); });
test('fresh installed version, scope, memory/disk, mount ownership and schema evidence required', async t => {
  const mutations = [
    ['INSTALLED_VERSION_UNKNOWN', e => { e.version.value = ''; }],
    ['STALE_EVIDENCE', e => { e.capacity.observedAt = 1; }],
    ['STALE_EVIDENCE', e => { e.capacity.observedAt += 1; }],
    ['UNAPPROVED_CREDENTIAL_SCOPE', e => { e.scope.resources.push('existing-universe-dev'); }],
    ['INSUFFICIENT_HOST_CAPACITY', e => { e.capacity.freeMemoryBytes = 0; }],
    ['INSUFFICIENT_HOST_CAPACITY', e => { e.capacity.freeDiskBytes = 0; }],
    ['INSUFFICIENT_HOST_CAPACITY', e => { e.capacity.reservedCapacityExcluded = false; }],
    ['MOUNT_OWNERSHIP_UNPROVEN', e => { e.mounts.completeHostInventory = false; }],
    ['MOUNT_OWNERSHIP_UNPROVEN', e => { e.mounts.uid = 0; }],
    ['MOUNT_OWNERSHIP_UNPROVEN', e => { e.mounts.localDurableStorage = false; }],
    ['SHARED_VOLUME_WRITER', e => { e.mounts.containers.push({ applicationId: 'other', volumeId: 'isolated-data' }); }],
    ['SHARED_VOLUME_WRITER', e => { e.mounts.unmanagedWriters = 1; }],
    ['DATABASE_STATE_MISMATCH', e => { e.database.schema = 'unknown'; }]
  ];
  for (const [code, mutate] of mutations) await t.test(code, async () => { const f = fixture(); mutate(f.adapter.evidence); await rejected(f, code); });
});
test('queued stop is not proof; failed writer proof freezes without starting any image', async () => {
  const f = fixture(); f.adapter.termination.evidenceKind = 'queued-stop';
  const result = await deployPreview(f);
  assert.equal(result.outcome, 'frozen-recovery-uncertain'); assert.equal(f.adapter.state.frozen, true);
  assert.equal(f.adapter.calls.filter(c => Array.isArray(c) && c[0] === 'start').length, 0);
  assert(f.adapter.calls.filter(c => Array.isArray(c) && c[0] === 'stop').every(c => c[1].docker_cleanup === false));
});
test('a stopped writer with a restart policy still blocks new writers', async () => {
  const f = fixture(); f.adapter.termination.containers[0].restartDisabled = false;
  assert.equal((await deployPreview(f)).outcome, 'frozen-recovery-uncertain');
  assert.equal(f.adapter.calls.filter(c => Array.isArray(c) && c[0] === 'start').length, 0);
});
test('bad candidate health rolls back only after stopping and proving all writers terminated again', async () => {
  const f = fixture(); f.adapter.failures.health = true; const result = await deployPreview(f);
  assert.equal(result.outcome, 'rolled-back'); assert.equal(f.adapter.state.current.digest, digest('1')); assert.equal(f.adapter.state.current.schema, 'v2');
  assert.equal(f.adapter.state.approvedBaseline.digest, digest('0'));
  assert.deepEqual(f.adapter.calls.filter(c => Array.isArray(c)).map(c => c[0]), ['stop', 'start', 'stop', 'start']);
});
test('partial start failure recovers using actually observed resulting DB schema', async () => {
  const f = fixture(); f.adapter.failures.start = true;
  assert.equal((await deployPreview(f)).outcome, 'rolled-back');
});
test('unexpected resulting DB compatibility freezes without unsafe rollback', async () => {
  const f = fixture(); f.adapter.failures.start = true; f.adapter.failures.unexpectedSchema = 'v999';
  const result = await deployPreview(f);
  assert.equal(result.outcome, 'frozen-recovery-uncertain'); assert.equal(result.recoveryError, 'RECOVERY_COMPATIBILITY_UNKNOWN');
  assert.equal(f.adapter.calls.filter(c => Array.isArray(c) && c[0] === 'start').length, 1);
});
test('lost lease prevents mutation and cannot claim recovery or durable receipt', async () => {
  const f = fixture(); const stop = f.adapter.stop.bind(f.adapter);
  f.adapter.stop = async (...args) => { const result = await stop(...args); f.adapter.fenceHeld = false; return result; };
  const result = await deployPreview(f); assert.equal(result.outcome, 'frozen-recovery-uncertain'); assert.equal(result.durableReceipt, 'unconfirmed');
  assert.equal(f.adapter.calls.filter(c => Array.isArray(c) && c[0] === 'start').length, 0);
});
test('selection changed after stop cannot start superseded image; safe prior recovery only', async () => {
  const f = fixture(); const stop = f.adapter.stop.bind(f.adapter);
  f.adapter.stop = async (...args) => { const result = await stop(...args); f.desired.generation = 'e'.repeat(64); return result; };
  const result = await deployPreview(f); assert.equal(result.outcome, 'rolled-back'); assert.equal(result.error, 'STALE_SELECTION');
  assert.deepEqual(f.adapter.calls.filter(c => Array.isArray(c) && c[0] === 'start').map(c => c[1]), [`${f.policy.image}@${digest('1')}`]);
});
test('durable intent is frozen before first mutation and survives an interrupted runner', async () => {
  const f = fixture(); const stop = f.adapter.stop.bind(f.adapter);
  f.adapter.stop = async (...args) => {
    assert.equal(f.adapter.state.frozen, true);
    assert.equal(f.adapter.state.inProgress.requested, f.release.pin);
    return stop(...args);
  };
  assert.equal((await deployPreview(f)).outcome, 'healthy'); assert.equal(f.adapter.state.inProgress, null);
});
test('successful CAS with a lost response is read back and does not trigger unnecessary rollback', async () => {
  const f = fixture(); const commit = f.adapter.commitState.bind(f.adapter); let calls = 0;
  f.adapter.commitState = async (...args) => { await commit(...args); if (++calls === 2) throw Error('Response lost after durable commit'); };
  const result = await deployPreview(f);
  assert.equal(result.outcome, 'healthy'); assert.equal(f.adapter.currentDigest, f.release.digest);
  assert.equal(f.adapter.state.current.digest, f.release.digest); assert.equal(f.adapter.state.frozen, false);
  assert.equal(f.adapter.calls.filter(c => Array.isArray(c) && c[0] === 'start').length, 1);
});
test('uncertain initial intent prevents every host mutation', async () => {
  const f = fixture(); f.adapter.commitState = async () => { throw Error('Write refused'); };
  await rejected(f, 'STATE_WRITE_UNCONFIRMED');
});
test('mutable or inconsistent durable prior pin fails before stopping', async () => {
  for (const pin of [`${fixture().policy.image}:latest`, `ghcr.io/other/image@${digest('1')}`, `${fixture().policy.image}@${digest('3')}`]) {
    const f = fixture(); f.adapter.state.current.pin = pin; await rejected(f, 'PRIOR_PIN_MISMATCH');
  }
});
test('ambiguous final commit plus unavailable readback never mutates the verified candidate again', async () => {
  const f = fixture(); const commit = f.adapter.commitState.bind(f.adapter); const read = f.adapter.readState.bind(f.adapter); let commits = 0;
  f.adapter.commitState = async (...args) => { await commit(...args); if (++commits === 2) throw Error('Lost commit response'); };
  f.adapter.readState = async (...args) => { if (commits === 2) throw Error('State temporarily unreachable'); return read(...args); };
  const result = await deployPreview(f); assert.equal(result.outcome, 'state-reconciliation-required');
  assert.equal(f.adapter.currentDigest, f.release.digest); assert.equal(f.adapter.state.current.digest, f.release.digest);
  assert.equal(f.adapter.calls.filter(c => Array.isArray(c) && c[0] === 'start').length, 1);
});
test('a late queued start blocks recovery even after current writers have terminated', async () => {
  const f = fixture(); f.adapter.failures.start = true;
  const start = f.adapter.startPinned.bind(f.adapter);
  f.adapter.startPinned = async (...args) => { f.adapter.termination.pendingDeploymentCount = 1; return start(...args); };
  const result = await deployPreview(f); assert.equal(result.outcome, 'frozen-recovery-uncertain');
  assert.equal(result.recoveryError, 'WRITER_TERMINATION_UNPROVEN');
  assert.equal(f.adapter.calls.filter(c => Array.isArray(c) && c[0] === 'start').length, 1);
});
test('zero queued jobs without resource-side stale-start fencing is still insufficient', async () => {
  const f = fixture(); f.adapter.termination.staleStartsFenced = false;
  const result = await deployPreview(f); assert.equal(result.outcome, 'frozen-recovery-uncertain');
  assert.equal(f.adapter.calls.filter(c => Array.isArray(c) && c[0] === 'start').length, 0);
});
