import test from 'node:test';
import assert from 'node:assert/strict';
import {createArrivalState} from '../src/arrival-state.js';

const context = {accountId: 'alice', roomId: 'garden', sourceGeneration: 1};
function arrival(revision, overrides = {}) {
  return {x: revision + .125, z: -revision - .25, admissionId: `placement-${revision}`,
    admissionEpoch: 'process-a', admissionRevision: revision, ...overrides};
}
function setup({confirmed = true, hello = true} = {}) {
  const state = createArrivalState(context);
  if (hello) state.hello({sourceGeneration: 1, arrivalEpoch: 'process-a'});
  const resolve = (ticket, value, roomId = ticket?.roomId) => state.resolveJoin(ticket, {roomId, arrival: value});
  const observe = (value, roomId = 'garden', sourceGeneration = 1) => state.observeSelf({sourceGeneration,
    roomId, presence: {id: 'alice', userId: 'alice', roomId, lastSeen: 1000, ...value}});
  if (confirmed) assert.equal(resolve(state.beginJoin({roomId: 'garden'}), arrival(1)).kind, 'adopt');
  return {state, resolve, observe};
}
function assertAdopt(result, value, roomId = 'garden') {
  assert.equal(result.kind, 'adopt');
  assert.deepEqual(result.pose, {x: value.x, z: value.z});
  assert.deepEqual([result.roomId, result.admissionId, result.admissionEpoch, result.admissionRevision],
    [roomId, value.admissionId, value.admissionEpoch, value.admissionRevision]);
}

test('initial HTTP and first hello can arrive in either order without retiring fresh authority', () => {
  for (const order of ['hello-first', 'http-first']) {
    const {state, resolve} = setup({confirmed: false, hello: false});
    const ticket = state.beginJoin({roomId: 'garden'});
    if (order === 'hello-first') assert.equal(state.hello({sourceGeneration: 1, arrivalEpoch: 'process-a'}).kind, 'ready');
    assertAdopt(resolve(ticket, arrival(1)), arrival(1));
    assert.equal(state.hello({sourceGeneration: 1, arrivalEpoch: 'process-a'}).kind, 'ignore');
    assert.equal(state.snapshot().needsAuthority, false);
  }
});

test('initial self SSE needs a pending authenticated HTTP admission and a known stream epoch', () => {
  const {state, observe, resolve} = setup({confirmed: false, hello: false});
  assert.equal(observe(arrival(2)).kind, 'ignore');
  const ticket = state.beginJoin({roomId: 'garden'});
  assert.equal(observe(arrival(2)).reason, 'awaiting-epoch');
  state.hello({sourceGeneration: 1, arrivalEpoch: 'process-a'});
  assert.equal(observe(arrival(2)).kind, 'buffer');
  assert.equal(state.snapshot().current, null);
  assertAdopt(resolve(ticket, arrival(1)), arrival(2));
});

test('a pre-commit self SSE delivered after join cannot rewind the accepted admission', () => {
  const {state, observe, resolve} = setup();
  assertAdopt(resolve(state.beginJoin({roomId: 'garden'}), arrival(5)), arrival(5));
  for (const old of [1, 4, 3, 2]) assert.equal(observe(arrival(old, {lastSeen: 999999999})).reason, 'older-placement');
  assert.equal(state.snapshot().current.admissionRevision, 5);
});

test('a later sibling travel SSE wins over a delayed original same-room HTTP response', () => {
  const {state, observe, resolve} = setup();
  const ticket = state.beginJoin({roomId: 'garden'});
  assert.equal(observe(arrival(3)).kind, 'buffer');
  assertAdopt(resolve(ticket, arrival(2)), arrival(3));
  assert.equal(state.snapshot().pending, false);
});

test('multiple unknown queued admissions reduce to the strict revision maximum even with tied clocks', () => {
  for (const revisions of [[2, 5, 4, 3], [5, 4, 3, 2], [3, 4, 2, 5], [4, 2, 5, 3]]) {
    const {state, observe, resolve} = setup();
    const ticket = state.beginJoin({roomId: 'garden'});
    for (const revision of revisions) observe(arrival(revision, {lastSeen: 42}));
    assertAdopt(resolve(ticket, arrival(3, {lastSeen: 42})), arrival(5));
    assert.equal(state.snapshot().bufferedDestination, null);
  }
});

test('same-admission buffered motion does not override HTTP without a movement sequence', () => {
  const {state, observe, resolve} = setup();
  const ticket = state.beginJoin({roomId: 'garden'});
  observe(arrival(2, {x: 30, z: 40, lastSeen: 90000}));
  assert.equal(observe(arrival(2, {x: 60, z: 70, lastSeen: 90001})).reason, 'same-admission');
  assertAdopt(resolve(ticket, arrival(2)), arrival(2));
});

test('same current admission preserves local motion on SSE and an HTTP resume', () => {
  const {state, observe, resolve} = setup();
  assert.equal(observe(arrival(1, {x: 10, z: 20})).reason, 'same-admission');
  const ticket = state.beginJoin({roomId: 'garden'});
  const result = resolve(ticket, arrival(1, {x: 30, z: 40}));
  assert.equal(result.kind, 'retain');
  assert.equal(Object.hasOwn(result, 'pose'), false);
  assert.equal(result.admissionId, 'placement-1');
});

test('a strictly newer live self placement atomically returns pose with every identity field', () => {
  const {state, observe} = setup();
  assertAdopt(observe(arrival(9)), arrival(9));
  assert.equal(state.snapshot().current.admissionRevision, 9);
});

test('same revision with a different ID and same ID with a different revision fail closed', () => {
  for (const invalid of [arrival(1, {admissionId: 'different-id'}), arrival(2, {admissionId: 'placement-1'})]) {
    const {state, observe} = setup();
    assert.equal(observe(invalid).reason, 'conflicting-placement');
    assert.equal(state.snapshot().needsAuthority, true);
    assert.equal(state.snapshot().current, null);
  }
  const {state, observe, resolve} = setup();
  const ticket = state.beginJoin({roomId: 'garden'});
  observe(arrival(3));
  assert.equal(resolve(ticket, arrival(3, {admissionId: 'conflicting-http'})).kind, 'refresh-required');
  assert.equal(state.snapshot().pending, false);
});

test('conflicting queued candidates retire the request instead of selecting an arbitrary ID', () => {
  const {state, observe, resolve} = setup();
  const ticket = state.beginJoin({roomId: 'garden'});
  observe(arrival(4));
  assert.equal(observe(arrival(4, {admissionId: 'conflict'})).kind, 'refresh-required');
  assert.equal(resolve(ticket, arrival(5)).reason, 'stale-ticket');
});

test('new hello epoch retires current ordering, buffered candidates, and pending HTTP', () => {
  const {state, observe, resolve} = setup();
  const ticket = state.beginJoin({roomId: 'garden'});
  observe(arrival(100));
  assert.equal(state.hello({sourceGeneration: 1, arrivalEpoch: 'process-b'}).reason, 'epoch-changed');
  assert.equal(state.snapshot().needsAuthority, true);
  assert.equal(state.snapshot().pending, false);
  assert.equal(resolve(ticket, arrival(101)).reason, 'stale-ticket');
  const fresh = state.beginJoin({roomId: 'garden'});
  assert.equal(observe(arrival(999)).reason, 'epoch-mismatch');
  const restarted = arrival(1, {admissionEpoch: 'process-b', admissionId: 'new-process-id'});
  assertAdopt(resolve(fresh, restarted), restarted);
  assert.equal(observe(arrival(999)).reason, 'epoch-mismatch');
  assert.equal(state.snapshot().current.admissionEpoch, 'process-b');
});

test('an HTTP-observed epoch change demands another request begun after the boundary', () => {
  const {state, resolve} = setup();
  const restarted = arrival(1, {admissionEpoch: 'process-b', admissionId: 'new-process-id'});
  const ticket = state.beginJoin({roomId: 'garden'});
  assert.equal(resolve(ticket, restarted).reason, 'epoch-changed');
  assert.equal(resolve(ticket, restarted).reason, 'stale-ticket');
  assertAdopt(resolve(state.beginJoin({roomId: 'garden'}), restarted), restarted);
});

test('source replacement fences old events and HTTP even when account, room and epoch match', () => {
  const {state, observe, resolve} = setup();
  const ticket = state.beginJoin({roomId: 'garden'});
  state.reset({...context, sourceGeneration: 2});
  assert.equal(resolve(ticket, arrival(2)).reason, 'stale-ticket');
  assert.equal(state.hello({sourceGeneration: 1, arrivalEpoch: 'process-a'}).reason, 'stale-source');
  assert.equal(observe(arrival(2)).reason, 'stale-source');
  assert.equal(state.snapshot().needsAuthority, true);
  state.hello({sourceGeneration: 2, arrivalEpoch: 'process-a'});
  assert.equal(observe(arrival(2), 'garden', 2).kind, 'ignore');
  assertAdopt(resolve(state.beginJoin({roomId: 'garden'}), arrival(3)), arrival(3));
});

test('account and explicit room resets retire requests even if a source key is reused', () => {
  for (const next of [{...context, accountId: 'bob'}, {...context, roomId: 'studio'},
    {accountId: null, roomId: null, sourceGeneration: 1}]) {
    const {state, observe, resolve} = setup();
    const ticket = state.beginJoin({roomId: 'garden'});
    state.reset(next);
    assert.equal(resolve(ticket, arrival(2)).reason, 'stale-ticket');
    assert.equal(observe(arrival(2)).kind, 'ignore');
    assert.equal(state.snapshot().current, null);
  }
});

test('new navigation and ticket identity fence old successes, failures, and forged ticket copies', () => {
  const {state, resolve} = setup();
  const old = state.beginJoin({roomId: 'garden'});
  const fresh = state.beginJoin({roomId: 'studio'});
  assert.equal(resolve(old, arrival(2)).reason, 'stale-ticket');
  assert.equal(state.cancelJoin(old).reason, 'stale-ticket');
  assert.equal(state.failJoin({...fresh}).reason, 'stale-ticket');
  assert.equal(resolve({...fresh}, arrival(3)).reason, 'stale-ticket');
  assertAdopt(resolve(fresh, arrival(3)), arrival(3), 'studio');
  assert.equal(resolve(fresh, arrival(4)).reason, 'stale-ticket');
});

test('other-room events cannot take over a pending destination or raise its revision floor', () => {
  const {state, observe, resolve} = setup();
  const ticket = state.beginJoin({roomId: 'studio'});
  assert.equal(observe(arrival(999), 'unrelated').reason, 'other-room');
  assert.equal(observe(arrival(100), 'garden').reason, 'pending-source');
  assert.equal(observe(arrival(3), 'studio').reason, 'pending-destination');
  assertAdopt(resolve(ticket, arrival(2)), arrival(3), 'studio');
  assert.equal(observe(arrival(101), 'garden').reason, 'other-room');
});

test('failed cross-room travel discards destination and preserves a confirmed source', () => {
  const {state, observe} = setup();
  const ticket = state.beginJoin({roomId: 'studio'});
  observe(arrival(5), 'studio');
  const result = state.cancelJoin(ticket);
  assert.equal(result.kind, 'retain');
  assert.equal(result.roomId, 'garden');
  assert.equal(result.admissionId, 'placement-1');
  assert.equal(state.snapshot().pending, false);
});

test('failed travel may adopt only an independently newer placement in its confirmed source room', () => {
  for (const destination of ['garden', 'studio']) {
    const {state, observe} = setup();
    const ticket = state.beginJoin({roomId: destination});
    observe(arrival(3), 'garden');
    if (destination === 'studio') observe(arrival(99), 'studio');
    assertAdopt(state.failJoin(ticket), arrival(3));
    assert.equal(state.snapshot().roomId, 'garden');
  }
});

test('failed initial join cannot manufacture current room authority from buffered SSE', () => {
  const {state, observe} = setup({confirmed: false});
  const ticket = state.beginJoin({roomId: 'garden'});
  observe(arrival(5));
  assert.equal(state.cancelJoin(ticket).reason, 'unconfirmed-source');
  assert.equal(state.snapshot().current, null);
  assert.equal(state.snapshot().pending, false);
});

test('replacing navigation preserves the highest source evidence but retires old destination evidence', () => {
  const {state, observe, resolve} = setup();
  state.beginJoin({roomId: 'garden'});
  observe(arrival(4));
  state.beginJoin({roomId: 'studio'});
  observe(arrival(5), 'garden');
  observe(arrival(99), 'studio');
  const finalTicket = state.beginJoin({roomId: 'garden'});
  assert.equal(observe(arrival(3)).reason, 'older-placement');
  assertAdopt(resolve(finalTicket, arrival(2)), arrival(5));
});

test('caller mutation cannot change stored candidates, decisions, or diagnostic snapshots', () => {
  const {state, observe, resolve} = setup();
  const candidate = arrival(3);
  const ticket = state.beginJoin({roomId: 'garden'});
  observe(candidate);
  candidate.x = 1000; candidate.admissionRevision = 1000;
  const diagnostics = state.snapshot();
  diagnostics.bufferedDestination.admissionRevision = 9000;
  const result = resolve(ticket, arrival(2));
  assertAdopt(result, arrival(3));
  result.pose.x = 8000; result.admissionId = 'mutated';
  assert.equal(state.snapshot().current.admissionId, 'placement-3');
  assert.equal(observe(arrival(2)).reason, 'older-placement');
});

test('unknown account, malformed self identity, or mismatched room payload cannot supply a pose', () => {
  const {state, observe} = setup();
  for (const fields of [{id: 'bob'}, {userId: 'bob'}, {id: undefined, userId: undefined}]) {
    assert.equal(observe(arrival(2, fields)).reason, 'not-self');
  }
  assert.equal(observe(arrival(2, {roomId: 'studio'})).kind, 'refresh-required');
  assert.equal(state.snapshot().current, null);
});

test('missing or invalid arrival fields fail closed without local coordinate fallback', () => {
  for (const fields of [{x: NaN}, {z: Infinity}, {x: '2'}, {admissionId: ''}, {admissionEpoch: ''},
    {admissionRevision: 0}, {admissionRevision: -1}, {admissionRevision: 1.5},
    {admissionRevision: Number.MAX_SAFE_INTEGER + 1}, {admissionRevision: '2'}]) {
    const {state, resolve} = setup();
    const result = resolve(state.beginJoin({roomId: 'garden'}), arrival(2, fields));
    assert.equal(result.kind, 'refresh-required', JSON.stringify(fields));
    assert.equal(Object.hasOwn(result, 'pose'), false);
    assert.equal(state.snapshot().current, null);
  }
});

test('wrong HTTP destination and malformed hello retire the exact pending authority', () => {
  const {state, resolve} = setup();
  const ticket = state.beginJoin({roomId: 'studio'});
  assert.equal(resolve(ticket, arrival(2), 'garden').reason, 'destination-mismatch');
  const newer = state.beginJoin({roomId: 'garden'});
  assert.equal(state.hello({sourceGeneration: 1, arrivalEpoch: null}).reason, 'invalid-epoch');
  assert.equal(resolve(newer, arrival(2)).reason, 'stale-ticket');
});

test('bounded state keeps only source/destination maxima across thousands of queued IDs', () => {
  const {state, observe, resolve} = setup();
  const ticket = state.beginJoin({roomId: 'studio'});
  for (let revision = 2; revision < 5000; revision++) {
    observe(arrival(revision), revision % 2 ? 'studio' : 'garden');
  }
  const before = state.snapshot();
  assert.equal(before.bufferedDestination.admissionRevision, 4999);
  assert.equal(before.bufferedSource.admissionRevision, 4998);
  assert(JSON.stringify(before).length < 1000);
  assertAdopt(resolve(ticket, arrival(2)), arrival(4999), 'studio');
});

test('uninitialized context cannot issue a usable ticket', () => {
  const state = createArrivalState();
  assert.equal(state.beginJoin({roomId: 'garden'}), null);
  assert.equal(state.resolveJoin(null, {roomId: 'garden', arrival: arrival(1)}).reason, 'stale-ticket');
  assert.equal(state.hello({arrivalEpoch: 'process-a'}).reason, 'stale-source');
});
