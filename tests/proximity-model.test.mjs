// Retained pure model regression tests. SFU states below are synthetic intent only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBubbleModel } from '../server/proximity/membership.mjs';
import { selectTransport } from '../server/proximity/transport.mjs';
import {proximityFixture} from './fixtures/proximity-config.mjs';
const {enabled,maxSessionsPerMember,...modelFixture}=proximityFixture;
const fixture={...modelFixture,meetingPolicy:'force-sfu-target'};
import { PROXIMITY_EXCLUDED_STATUSES, barycenter, toSourcePosition, validateConfig } from '../server/proximity/policy.mjs';

const config = overrides => ({ ...fixture, ...overrides });
const model = overrides => createBubbleModel({ config: config(overrides), epoch: 'test-epoch' });
const member = (accountId, overrides = {}) => ({ accountId, admissionId: `admission-${accountId}`, x: 0, z: 0, moving: false, status: 'ONLINE', context: { kind: 'proximity' }, mediaConsent: false, lastSeenMs: 0, ...overrides });
const sync = (m, members, nowMs = 0, overrides = {}) => m.syncRoom({ roomId: 'room', members, nowMs, sfuAvailable: true, ...overrides });
const view = (m, accountId = 'a', time = 0) => m.view('room', accountId, `admission-${accountId}`, time);
const ids = (count, overrides = {}) => Array.from({ length: count }, (_, i) => member(String.fromCharCode(97 + i), overrides));
const eventFree = snapshot => { const { events, ...rest } = snapshot; return rest; };
function permutations(values) {
  return values.length ? values.flatMap((value, i) => permutations(values.filter((_, j) => i !== j)).map(rest => [value, ...rest])) : [[]];
}

test('all admitted members count while no one consents or captures media', () => {
  const m = model(); const result = sync(m, ids(6));
  assert.equal(result.bubbles.length, 1); assert.equal(result.bubbles[0].transport.memberCount, 6);
  assert.equal(result.bubbles[0].transport.selectionIntent, 'sfu');
  assert.equal(view(m).conversationRecipients.length, 5); assert.deepEqual(view(m).mediaRecipients, []);
  assert.equal(result.bubbles[0].transport.connectedTransport, null); assert.equal(result.bubbles[0].transport.handoffComplete, false);
});
test('consent and publication changes leave member, bubble and conversation identities unchanged', () => {
  const m = model(); sync(m, ids(3)); const before = view(m);
  const result = sync(m, ids(3, { mediaConsent: true })); const after = view(m);
  assert.equal(before.bubbleId, after.bubbleId); assert.equal(before.memberId, after.memberId);
  assert.deepEqual(after.conversationRecipients, before.conversationRecipients); assert.deepEqual(result.events, []);
  assert.equal(after.mediaRecipients.length, 2); assert.equal(after.p2pRecipients.length, 2);
  sync(m, [member('a', { mediaConsent: true, canPublish: false }), member('b', { mediaConsent: true }), member('c')]);
  assert.deepEqual(view(m).p2pRecipients.map(p => [p.accountId, p.canSend, p.canReceive]), [['b', false, true]]);
});
test('geometry explicitly maps source pixels to world x,z and barycenter', () => {
  assert.deepEqual(toSourcePosition({ x: 4, z: -2 }, validateConfig(fixture)), { x: 64, z: -32 });
  assert.deepEqual(barycenter([{ accountId: 'a', position: { x: 0, z: 0 } }, { accountId: 'b', position: { x: 64, z: 32 } }]), { x: 32, z: 16 });
});
for (const [distanceWorld, expected] of [[3.999, 1], [4, 1], [4.001, 0]]) test(`source minimum-distance boundary ${distanceWorld}`, () => {
  const m = model(); assert.equal(sync(m, [member('a'), member('b', { x: distanceWorld })]).bubbles.length, expected);
});
test('barycenter radius admits an existing group, not edge-connected components', () => {
  const m = model(); sync(m, [member('a', { x: -1 }), member('b', { x: 1 })]);
  // c is within minimum pair distance of b, but outside the group's radius 3.
  let result = sync(m, [member('a', { x: -1 }), member('b', { x: 1 }), member('c', { x: 3.01 })]);
  assert.equal(result.bubbles[0].accountIds.length, 2);
  result = sync(m, [member('a', { x: -1 }), member('b', { x: 1 }), member('c', { x: 3 })]);
  assert.equal(result.bubbles[0].accountIds.length, 3);
});
for (const [x, size] of [[6, 2], [6.001, 0]]) test(`two-head separation at ${x} uses radius to barycenter, not pair-edge leave distance`, () => {
  const m = model(); sync(m, [member('a'), member('b')]);
  const result = sync(m, [member('a'), member('b', { x, moving: true })]);
  assert.equal(result.bubbles[0]?.accountIds.length ?? 0, size);
});
test('both participants must stop for a new conversation; existing members may move', () => {
  const m = model(); assert.equal(sync(m, [member('a'), member('b', { moving: true })]).bubbles.length, 0);
  const joined = sync(m, [member('a'), member('b')]).bubbles[0];
  const moving = sync(m, [member('a', { moving: true }), member('b', { moving: true })]).bubbles[0];
  assert.equal(moving.bubbleId, joined.bubbleId);
});
test('membership ceiling and P2P threshold are independent', () => {
  const m = model({ membershipCeiling: 6 }); const result = sync(m, ids(8));
  assert.deepEqual(result.bubbles.map(b => b.accountIds.length).sort((a,b) => a-b), [2, 6]);
  assert.equal(result.bubbles.find(b => b.accountIds.length === 6).transport.selectionIntent, 'sfu');
  const sourceLike = model({ membershipCeiling: 4, p2pThreshold: 4 });
  assert.ok(sync(sourceLike, ids(8)).bubbles.every(b => b.transport.selectionIntent === 'p2p'));
});
for (const status of PROXIMITY_EXCLUDED_STATUSES) test(`status ${status} leaves proximity even if media is opted in`, () => {
  const m = model(); sync(m, ids(3, { mediaConsent: true }));
  const result = sync(m, [member('a', { status, mediaConsent: true }), member('b'), member('c')]);
  assert.equal(result.members.find(m => m.accountId === 'a').bubbleId, null);
  assert.equal(result.bubbles[0].accountIds.length, 2); assert.equal(view(m).mediaRecipients.length, 0);
});
test('Silent overrides stale meeting context; silent area overrides online status', () => {
  const m = model(); const result = sync(m, [member('a', { status: 'SILENT', context: { kind: 'meeting', meetingId: 'one' } }), member('b', { context: { kind: 'silent' } }), member('c')]);
  assert.equal(result.bubbles.length, 0);
});
test('meetings are separate spaces even when every participant is physically co-located', () => {
  const m = model(); const result = sync(m, [...ids(2), member('c', { context: { kind: 'meeting', meetingId: 'one' } }), member('d', { context: { kind: 'meeting', meetingId: 'two' } })]);
  assert.equal(result.bubbles.length, 3); assert.equal(view(m).conversationRecipients.length, 1);
  const meeting = view(m, 'c'); assert.equal(meeting.conversationRecipients.length, 0);
  assert.equal(meeting.transport.selectionIntent, 'sfu'); assert.equal(meeting.transport.blockedReason, 'sfu-adapter-not-implemented');
});
test('source-threshold meeting fixture remains P2P below threshold; this is explicit policy', () => {
  const m = model({ meetingPolicy: 'source-threshold' });
  const result = sync(m, [member('a', { context: { kind: 'meeting', meetingId: 'one' } })]);
  assert.equal(result.bubbles[0].transport.selectionIntent, 'p2p');
});
test('meeting entry and exit do not reuse a destroyed proximity bubble', () => {
  const m = model(); const old = sync(m, ids(2)).bubbles[0].bubbleId;
  sync(m, [member('a', { context: { kind: 'meeting', meetingId: 'm' } }), member('b')]);
  const result = sync(m, ids(2)); assert.notEqual(result.bubbles[0].bubbleId, old);
});
test('all simultaneous-join permutations yield identical opaque IDs and groups', () => {
  let expected;
  for (const input of permutations(ids(5))) {
    const snapshot = eventFree(sync(model({ membershipCeiling: 3 }), input));
    if (!expected) expected = snapshot; else assert.deepEqual(snapshot, expected);
  }
});
test('locked bubble admits nobody via direct join or nearby sweep', () => {
  const m = model(); const original = sync(m, ids(2)).bubbles[0]; m.setLocked('room', original.bubbleId, true);
  const result = sync(m, ids(3)); assert.deepEqual(result.bubbles[0].accountIds, ['a', 'b']);
  m.setLocked('room', original.bubbleId, false); assert.equal(sync(m, ids(3)).bubbles[0].accountIds.length, 3);
});
test('followers do not drag barycenter; distant follower retains membership and marks out-of-bounds', () => {
  const m = model(); sync(m, [member('a'), member('b', { followLeaderId: 'a' })]);
  const result = sync(m, [member('a'), member('b', { followLeaderId: 'a', x: 100, moving: true })]);
  assert.equal(result.bubbles[0].accountIds.length, 2); assert.deepEqual(result.bubbles[0].centerSource, { x: 0, z: 0 }); assert.equal(result.bubbles[0].outOfBounds, true);
});
test('three-person leader/follower split removes unrelated head while preserving group identity', () => {
  const m = model(); const old = sync(m, [member('a'), member('b', { followLeaderId: 'a' }), member('c')]).bubbles[0].bubbleId;
  const result = sync(m, [member('a', { x: 10, moving: true }), member('b', { followLeaderId: 'a', x: 10, moving: true }), member('c')]);
  assert.deepEqual(result.bubbles[0].accountIds, ['a', 'b']); assert.equal(result.bubbles[0].bubbleId, old);
});
test('larger leader/follower split recreates carried follow group and keeps unrelated group', () => {
  const m = model(); const old = sync(m, [member('a'), member('b', { followLeaderId: 'a' }), member('c'), member('d')]).bubbles[0].bubbleId;
  const result = sync(m, [member('a', { x: 12, moving: true }), member('b', { followLeaderId: 'a', x: 12, moving: true }), member('c'), member('d')]);
  assert.deepEqual(result.bubbles.map(b => b.accountIds).sort((a,b) => a[0].localeCompare(b[0])), [['a','b'], ['c','d']]);
  assert.equal(result.bubbles.find(b => b.accountIds.includes('c')).bubbleId, old);
});
test('leader Silent does not keep distant followers attached to a departed identity', () => {
  const m = model(); sync(m, [member('a'), member('b', { followLeaderId: 'a' }), member('c', { followLeaderId: 'a' })]);
  const result = sync(m, [member('a', { status: 'SILENT' }), member('b', { followLeaderId: 'a' }), member('c', { followLeaderId: 'a', x: 100, moving: true })]);
  assert.equal(result.bubbles.length, 0);
});
test('full room and account bounds are transactional, rooms never retain empty tombstones', () => {
  const m = model({ maxRooms: 1, maxAccounts: 2, maxMemberships: 2 }); sync(m, ids(2)); const before = m.snapshot('room');
  assert.throws(() => sync(m, ids(3)), /ACCOUNT_LIMIT/); assert.deepEqual(m.snapshot('room'), before);
  assert.throws(() => sync(m, [member('c')], 0, { roomId: 'other' }), /ROOM_LIMIT/);
  sync(m, []); assert.deepEqual(m.stats(), { rooms: 0, accounts: 0, memberships: 0, bubbles: 0 });
});
test('TTL is exclusive at its boundary, is not extended by policy reads, and clears consent', () => {
  const m = model(); sync(m, ids(2, { mediaConsent: true })); assert.equal(view(m, 'a', 59999).mediaRecipients.length, 1);
  assert.throws(() => view(m, 'a', 60000), /MEMBERSHIP_REQUIRED/); assert.equal(m.stats().memberships, 0);
  sync(m, ids(2, { lastSeenMs: 60000 }), 60000); assert.equal(view(m, 'a', 60000).mediaRecipients.length, 0);
});
test('stale snapshot cannot revive an expired member or admission', () => {
  const m = model(); sync(m, ids(2)); const oldId = view(m).memberId; m.tick(60000);
  assert.equal(sync(m, ids(2), 60000).members.length, 0);
  sync(m, ids(2, { lastSeenMs: 60000 }), 60000); assert.notEqual(view(m, 'a', 60000).memberId, oldId);
});
test('new admission gets a new member identity; old sender and old target identity are unusable', () => {
  const m = model(); sync(m, ids(3)); const before = view(m);
  sync(m, [member('a', { admissionId: 'new' }), member('b'), member('c')]);
  assert.throws(() => view(m), /MEMBERSHIP_REQUIRED/); assert.notEqual(m.view('room', 'a', 'new', 0).memberId, before.memberId);
});
test('clear and forgetAccount remove all bounded account/room state', () => {
  const m = model(); sync(m, ids(2)); sync(m, ids(2), 0, { roomId: 'other' });
  m.forgetAccount('a', 0); assert.equal(m.stats().accounts, 1); assert.equal(m.stats().bubbles, 0);
  m.clear(); assert.deepEqual(m.stats(), { rooms: 0, accounts: 0, memberships: 0, bubbles: 0 });
});
test('same account and meeting names in two rooms have different scoped identities', () => {
  const m = model(); const records = ids(2, { context: { kind: 'meeting', meetingId: 'same' } });
  const one = sync(m, records), two = sync(m, records, 0, { roomId: 'other' });
  assert.notEqual(one.bubbles[0].bubbleId, two.bubbles[0].bubbleId);
  assert.notEqual(one.members[0].memberId, two.members[0].memberId);
  assert.equal(m.stats().accounts, 2); assert.equal(m.stats().memberships, 4);
});
test('member bound and total membership bound are enforced separately from account count', () => {
  const m = model({ maxMembersPerRoom: 8, maxMemberships: 3 }); sync(m, ids(2));
  assert.throws(() => sync(m, ids(2), 0, { roomId: 'other' }), /MEMBERSHIP_LIMIT/);
  assert.throws(() => sync(m, ids(9)), /ROOM_MEMBER_LIMIT/);
  assert.equal(m.stats().rooms, 1); assert.equal(m.stats().memberships, 2);
});
test('account IDs containing punctuation or special property names do not collide', () => {
  const m = model(); const result = sync(m, [member('__proto__'), member('a:b'), member('b:a')]);
  assert.equal(result.bubbles[0].accountIds.length, 3); assert.equal(new Set(result.members.map(m => m.memberId)).size, 3);
});
for (const [field, value] of [['x', NaN], ['x', Infinity], ['z', -Infinity], ['lastSeenMs', NaN], ['moving', 1], ['mediaConsent', 'yes'], ['status', 'unknown'], ['x', 100001]]) test(`invalid member ${field}=${value} is rejected atomically`, () => {
  const m = model(); sync(m, ids(2)); const before = m.snapshot('room');
  assert.throws(() => sync(m, [member('a', { [field]: value }), member('b')])); assert.deepEqual(m.snapshot('room'), before);
});
test('duplicate identities, future timestamps, follow cycles, and clock regression fail closed', () => {
  const m = model();
  assert.throws(() => sync(m, [member('a'), member('a')]), /DUPLICATE_ACCOUNT/);
  assert.throws(() => sync(m, [member('a', { lastSeenMs: 1 })]), /FUTURE_PRESENCE/);
  assert.throws(() => sync(m, [member('a', { followLeaderId: 'b' }), member('b', { followLeaderId: 'a' })]), /FOLLOW_CYCLE_OR_CHAIN/);
  assert.throws(() => sync(m, [member('a', { followLeaderId: 'a' })]), /SELF_FOLLOW/);
  sync(m, ids(2), 1); assert.throws(() => sync(m, ids(2), 0), /CLOCK_REGRESSED/);
});
test('returned snapshots are detached from private authority state', () => {
  const m = model(); const snapshot = sync(m, ids(2)); snapshot.bubbles[0].accountIds.push('evil'); snapshot.members[0].context.kind = 'meeting';
  assert.equal(m.snapshot('room').bubbles[0].accountIds.length, 2); assert.equal(view(m).conversationRecipients.length, 1);
});

const transportInput = (count, membershipRevision, nowMs, extras = {}) => ({ count, membershipRevision, nowMs, kind: 'proximity', sfuAvailable: true, ...extras });
test('transport upgrade is immediate at >5, then downgrade is delayed precisely 20 seconds', () => {
  let state = selectTransport(null, transportInput(5, 1, 0), fixture); assert.equal(state.selectionIntent, 'p2p');
  state = selectTransport(state, transportInput(6, 2, 1), fixture); assert.equal(state.selectionIntent, 'sfu');
  state = selectTransport(state, transportInput(5, 3, 2), fixture); assert.equal(state.downgradeAtMs, 20002);
  state = selectTransport(state, transportInput(5, 3, 20001), fixture); assert.equal(state.selectionIntent, 'sfu');
  state = selectTransport(state, transportInput(5, 3, 20002), fixture); assert.equal(state.selectionIntent, 'p2p'); assert.equal(state.intentGeneration, 2);
});
test('membership activity restarts downgrade debounce, ordinary polling does not', () => {
  let state = selectTransport(null, transportInput(6, 1, 0), fixture);
  state = selectTransport(state, transportInput(5, 2, 1), fixture);
  state = selectTransport(state, transportInput(5, 2, 100), fixture); assert.equal(state.downgradeAtMs, 20001);
  state = selectTransport(state, transportInput(5, 3, 100), fixture); assert.equal(state.downgradeAtMs, 20100);
});
test('sixth member cancels pending downgrade, including a join exactly at the deadline', () => {
  let state = selectTransport(null, transportInput(6, 1, 0), fixture);
  state = selectTransport(state, transportInput(5, 2, 1), fixture);
  state = selectTransport(state, transportInput(6, 3, 20001), fixture); assert.equal(state.selectionIntent, 'sfu'); assert.equal(state.downgradeAtMs, null);
});
test('server model applies a sixth arrival before a same-tick downgrade deadline with no phantom intent switches', () => {
  const m = model(); sync(m, ids(6)); sync(m, ids(5), 1);
  const generation = view(m, 'a', 1).transport.intentGeneration;
  const result = sync(m, ids(6, { lastSeenMs: 20001 }), 20001);
  assert.equal(result.bubbles[0].transport.selectionIntent, 'sfu');
  assert.equal(result.bubbles[0].transport.intentGeneration, generation);
  assert.equal(result.bubbles[0].transport.downgradeAtMs, null);
});
test('unavailable SFU does not silently authorize an oversized P2P mesh', () => {
  const state = selectTransport(null, transportInput(6, 1, 0, { sfuAvailable: false }), fixture);
  assert.equal(state.selectionIntent, 'p2p'); assert.equal(state.requiredTransport, 'sfu'); assert.equal(state.p2pAllowed, false); assert.equal(state.blockedReason, 'sfu-unavailable');
});
test('zero delay explicitly returns P2P immediately, and empty intent authorizes no media', () => {
  const c = config({ downgradeDelayMs: 0 });
  let state = selectTransport(null, transportInput(6, 1, 0), c);
  state = selectTransport(state, transportInput(5, 2, 1), c); assert.equal(state.selectionIntent, 'p2p');
  const empty = selectTransport(null, transportInput(0, 0, 0), c); assert.equal(empty.p2pAllowed, false); assert.equal(empty.blockedReason, 'empty');
});
test('forced meeting target without availability cannot authorize even a two-person P2P fallback', () => {
  const state = selectTransport(null, transportInput(2, 1, 0, { kind: 'meeting', sfuAvailable: false }), fixture);
  assert.equal(state.selectionIntent, 'p2p'); assert.equal(state.requiredTransport, 'sfu'); assert.equal(state.p2pAllowed, false);
});
for (const field of Object.keys(fixture).filter(key => typeof fixture[key] === 'number')) test(`configuration requires finite valid ${field}`, () => {
  assert.throws(() => validateConfig({ ...fixture, [field]: NaN }));
  const missing = { ...fixture }; delete missing[field]; assert.throws(() => validateConfig(missing));
});
test('invalid meeting mode, invalid scale arithmetic, and unsafe clocks are rejected', () => {
  assert.throws(() => validateConfig({ ...fixture, meetingPolicy: 'guess' }), /INVALID_meetingPolicy/);
  assert.throws(() => validateConfig({ ...fixture, sourceUnitsPerWorldUnit: Number.MAX_SAFE_INTEGER }), /UNSAFE_COORDINATE_SCALE/);
  assert.throws(() => model({ membershipCeiling: 101 }), /CEILING_EXCEEDS_ROOM_BOUND/);
  assert.throws(() => sync(model(), ids(2), Number.MAX_SAFE_INTEGER), /INVALID_nowMs/);
  assert.throws(() => selectTransport(null, transportInput(NaN, 1, 0), fixture), /INVALID_count/);
});
test('bubble/text/member identity stays stable through upgrade and delayed return', () => {
  const m = model(); sync(m, ids(5)); const before = view(m); sync(m, ids(6));
  assert.equal(view(m).bubbleId, before.bubbleId); assert.equal(view(m).memberId, before.memberId);
  sync(m, ids(5), 1); m.tick(20001); const after = view(m, 'a', 20001);
  assert.equal(after.bubbleId, before.bubbleId); assert.deepEqual(after.conversationRecipients, before.conversationRecipients);
  assert.equal(after.transport.selectionIntent, 'p2p');
});

test('seeded movement/lifecycle sequence maintains capacity, uniqueness, identity and finite geometry', () => {
  const m = model({ membershipCeiling: 6 }); let seed = 7;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let step = 0; step < 250; step++) {
    const records = ids(20).filter(() => random() > 0.15).map(record => ({ ...record, x: Math.floor(random() * 14), z: Math.floor(random() * 14), moving: random() > 0.7, mediaConsent: random() > 0.5, lastSeenMs: step * 1000 }));
    const result = sync(m, records, step * 1000);
    const used = new Set();
    for (const bubble of result.bubbles) {
      assert.ok(bubble.accountIds.length >= 2 && bubble.accountIds.length <= 6);
      assert.ok(Number.isFinite(bubble.centerSource.x) && Number.isFinite(bubble.centerSource.z));
      assert.equal(bubble.accountIds.length, bubble.transport.memberCount);
      for (const accountId of bubble.accountIds) { assert.ok(!used.has(accountId)); used.add(accountId); }
    }
    assert.equal(result.members.length, records.length); assert.ok(m.stats().memberships <= 20);
  }
});

