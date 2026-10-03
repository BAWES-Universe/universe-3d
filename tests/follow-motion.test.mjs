import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyScene} from '../src/worlds.js';
import {advanceMotion, createMotion, WALK_SPEED, FAST_WALK_MULTIPLIER, screenDirection} from '../src/motion.js';
import {createFollowMotionController, followStopDistanceWorld, followSteering, validateFollowMotionGrant} from '../src/follow-motion.js';

const room = () => ({...emptyScene(), bounds: {width: 200, depth: 200}});
const context = {roomId: 'room-a', connectionId: 'connection-a', memberId: 'follower-admission'};
function grant(overrides = {}) {
  return {roomId: context.roomId, connectionId: context.connectionId, memberId: context.memberId,
    leaderId: 'leader-account', leaderMemberId: 'leader-admission', leaseId: 'lease-a',
    controlling: true, controllerConnected: true, sourceUnitsPerWorldUnit: 32,
    memberTtlMs: 60000, serverTime: 1000000, receivedAt: 10000,
    leaderPresence: {x: 0, z: 20, lastSeen: 1000000, moving: true}, ...overrides};
}
function harness(overrides) {
  let time = 10000;
  const controller = createFollowMotionController({now: () => time});
  const current = grant(overrides), motion = createMotion({x: 0, z: 0}), scene = room();
  assert.equal(controller.resume(controller.beginResume(), current, context), true);
  return {controller, current, motion, scene, setTime: value => {time = value;},
    step: (options = {}, dt = 1 / 60) => controller.advance(motion, scene, {grant: current, context, ...options}, dt)};
}
const distance = motion => Math.hypot(motion.position.x, motion.position.z);

test('FOLLOW-CONSENT: an invitation has no motion/speed effect; a current grant cannot move until armed', () => {
  const controller = createFollowMotionController({now: () => 10000});
  const motion = createMotion({x: 0, z: 0}), reference = createMotion({x: 0, z: 0});
  for (let i = 0; i < 60; i++) {
    controller.advance(motion, room(), {context, invitations: [{leaderId: 'leader-account'}], input: {x: 1, z: 0}, fast: true}, 1 / 60);
    advanceMotion(reference, room(), {input: {x: 1, z: 0}, fast: true}, 1 / 60);
  }
  assert.deepEqual(motion, reference);
  const stationary = createMotion({x: 0, z: 0});
  controller.advance(stationary, room(), {context, grant: grant()}, .25);
  assert.equal(distance(stationary), 0);
  assert.equal(controller.snapshot().armed, false);
});

test('FOLLOW-SCOPE: a live accepted grant and exact local connection/member/room are mandatory', () => {
  for (const changes of [{controlling: false}, {controllerConnected: false}, {leaseId: null},
    {roomId: 'other-room'}, {connectionId: 'other-tab'}, {memberId: 'old-admission'},
    {leaderMemberId: context.memberId}, {leaderId: ''}]) {
    const candidate = grant(changes), controller = createFollowMotionController({now: () => 10000});
    assert.equal(controller.resume(controller.beginResume(), candidate, context), false, JSON.stringify(changes));
    const motion = createMotion({x: 0, z: 0});
    controller.advance(motion, room(), {context, grant: candidate}, .25);
    assert.equal(distance(motion), 0);
  }
});

test('FOLLOW-SCALE: derive the exact source threshold from supplied authority scale, without fallback', () => {
  assert.equal(followStopDistanceWorld(32), Math.sqrt(2000) / 32);
  assert.equal(followStopDistanceWorld(16), Math.sqrt(2000) / 16);
  for (const scale of [undefined, null, 0, -1, NaN, Infinity, Number.MIN_VALUE, '32']) {
    assert.equal(followStopDistanceWorld(scale), null);
    assert.equal(validateFollowMotionGrant(grant({sourceUnitsPerWorldUnit: scale}), context, 10000).valid, false);
  }
  const threshold = followStopDistanceWorld(16);
  assert.equal(followSteering({x: 0, z: 0}, {x: 0, z: threshold - .000001}, threshold).following, false);
  assert.equal(followSteering({x: 0, z: 0}, {x: 0, z: threshold}, threshold).following, true);
  const a = harness({sourceUnitsPerWorldUnit: 32, leaderPresence: {x: 0, z: 2, lastSeen: 1000000}});
  const b = harness({sourceUnitsPerWorldUnit: 16, leaderPresence: {x: 0, z: 2, lastSeen: 1000000}});
  a.step(); b.step();
  assert(a.motion.position.z > 0); assert.equal(b.motion.position.z, 0);
});

test('FOLLOW-FRESHNESS: age server presence with local elapsed time rather than clock synchronization', () => {
  const candidate = grant({serverTime: 950000000, leaderPresence: {x: 0, z: 20, lastSeen: 949997000}});
  assert.equal(validateFollowMotionGrant(candidate, context, 11999).valid, true);
  assert.equal(validateFollowMotionGrant(candidate, context, 12000).reason, 'leader-stale');
  assert.equal(validateFollowMotionGrant(grant(), context, 15000).reason, 'authority-stale');
  assert.equal(validateFollowMotionGrant(grant(), context, 9999).reason, 'authority-stale');
  assert.equal(validateFollowMotionGrant(grant({leaderPresence: {x: 0, z: 2, lastSeen: 1000001}}), context, 10000).reason, 'leader-stale');
  assert.equal(validateFollowMotionGrant(grant({memberTtlMs: 1000}), context, 11000).valid, false);
  assert.equal(validateFollowMotionGrant(grant({leaderPresenceMaxAgeMs: 1000}), context, 11000).reason, 'leader-stale');
  const refreshedOldSample = grant({receivedAt: 12000, serverTime: 1006000});
  assert.equal(validateFollowMotionGrant(refreshedOldSample, context, 12000).reason, 'leader-stale');
});

test('FOLLOW-LEADER: missing, invalid, other-room or other-admission presence fails closed', () => {
  for (const leaderPresence of [null, {x: NaN, z: 2, lastSeen: 1000000},
    {x: 0, z: 20, lastSeen: 1000000, roomId: 'other-room'},
    {x: 0, z: 20, lastSeen: 1000000, memberId: 'leader-new-admission'},
    {x: 0, z: 20, lastSeen: 1000000, accountId: 'resident-object'}]) {
    assert.equal(validateFollowMotionGrant(grant({leaderPresence}), context, 10000).valid, false);
  }
});

test('FOLLOW-MOTION: direct follow uses the collision integrator and keeps frame-rate-independent walk speed', () => {
  const distances = [10, 20, 30, 60, 120].map(fps => {
    const h = harness();
    for (let i = 0; i < fps; i++) h.step({}, 1 / fps);
    assert.equal(h.motion.running, false);
    assert(Math.abs(h.motion.heading) < 1e-8);
    assert(h.motion.position.z < WALK_SPEED);
    return distance(h.motion);
  });
  assert(Math.max(...distances) - Math.min(...distances) < 1e-8);
  assert(distances[0] > WALK_SPEED * .95);
});

test('FOLLOW-MANUAL: steering adds to follow, respects camera basis, cancels in opposition, and normalizes the sum', () => {
  const h = harness();
  for (let i = 0; i < 60; i++) h.step({input: {x: -1, z: 0}, angle: Math.PI / 2, fast: true});
  assert(h.motion.position.x > 0 && h.motion.position.z > 0);
  assert(distance(h.motion) <= WALK_SPEED);
  assert.equal(h.controller.snapshot().armed, true);
  assert.equal(h.motion.running, false);
  const opposite = harness();
  for (let i = 0; i < 60; i++) opposite.step({input: {x: 0, z: -1}, angle: Math.PI / 2});
  assert(distance(opposite.motion) < 1e-9);
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
    const steering = followSteering({x: 0, z: 0}, {x: 10, z: 0}, 1, {x: 0, z: 0}, angle);
    const world = screenDirection(steering.input, angle);
    assert(Math.abs(world.x - 1) < 1e-8 && Math.abs(world.z) < 1e-8);
  }
});

test('FOLLOW-SHIFT: accepted follow and own waiting leadership suppress boost; explicit scripted speed remains independent', () => {
  const slow = createMotion({x: 0, z: 0}), normal = createMotion({x: 0, z: 0});
  const controller = createFollowMotionController();
  for (let i = 0; i < 60; i++) {
    controller.advance(slow, room(), {input: {x: 1, z: 0}, fast: true, followSpeedLimited: true}, 1 / 60);
    advanceMotion(normal, room(), {input: {x: 1, z: 0}}, 1 / 60);
  }
  assert.deepEqual(slow, normal);
  const a = harness(), b = harness(), pa = [{x: 30, z: 0}], pb = [{x: 30, z: 0}];
  for (let i = 0; i < 60; i++) {
    a.step({path: pa, fast: true});
    b.step({path: pb, pathSpeed: FAST_WALK_MULTIPLIER});
  }
  assert.equal(a.motion.position.z, 0); assert.equal(a.motion.running, false);
  assert.equal(b.motion.position.z, 0); assert.equal(b.motion.running, true);
  assert(Math.abs(b.motion.position.x / a.motion.position.x - FAST_WALK_MULTIPLIER) < 1e-8);
});

test('FOLLOW-PATH: click/script path precedes follow; manual or explicit non-Shift action cancels only the path', () => {
  const h = harness(), path = [{x: 20, z: 0}];
  h.step({path, fast: true}, .1);
  assert(h.motion.position.x > 0); assert.equal(h.motion.position.z, 0); assert.equal(path.length, 1);
  const result = h.step({path, input: {x: 1, z: 0}, angle: 0}, .1);
  assert.equal(path.length, 0); assert.equal(result.manual, true); assert.equal(h.controller.snapshot().armed, true);
  const other = harness(), otherPath = [{x: 20, z: 0}];
  other.step({path: otherPath, cancelPath: true}, .1);
  assert.equal(otherPath.length, 0); assert(other.motion.position.z > 0);
});

test('FOLLOW-STOP: crossing the radius stops immediately without residual drift or overshooting the leader', () => {
  const h = harness({leaderPresence: {x: 0, z: 3, lastSeen: 1000000}});
  for (let i = 0; i < 12; i++) h.step({}, .25);
  const gap = 3 - h.motion.position.z;
  assert(gap > followStopDistanceWorld(32) - WALK_SPEED / 120);
  assert(gap < followStopDistanceWorld(32));
  assert.equal(h.motion.moving, false); assert.deepEqual(h.motion.velocity, {x: 0, z: 0});
  const position = {...h.motion.position}; h.step({}, .25); assert.deepEqual(h.motion.position, position);
});

test('FOLLOW-OBSTACLES: direct steering cannot cross a wall or teleport at low frame rate', () => {
  const h = harness();
  h.scene.objects = [{id: 'wall', type: 'wall', x: 0, z: 3, width: 20, depth: .3, rotation: 0}];
  for (let i = 0; i < 20; i++) h.step({fast: true}, .25);
  assert(h.motion.position.z < 2.56);
  assert.equal(h.motion.running, false);
  const suspended = harness(); suspended.step({}, 60);
  assert(distance(suspended.motion) < WALK_SPEED * .25);
});

test('FOLLOW-HEADING: sliding follows actual world displacement, not the unachievable leader direction', () => {
  const h = harness({leaderPresence: {x: 10, z: 20, lastSeen: 1000000}});
  h.scene.objects = [{id: 'wall', type: 'wall', x: 0, z: 3, width: 50, depth: .3, rotation: 0}];
  for (let i = 0; i < 120; i++) h.step();
  assert(h.motion.position.x > 1); assert(h.motion.position.z < 2.56);
  assert(Math.abs(h.motion.heading - Math.PI / 2) < 1e-8);
});

test('FOLLOW-REVOKE: missing leader, expired authority or lease transition hard-stops once and cannot rearm from an update', () => {
  for (const changes of [null, {leaderPresence: null}, {leaseId: 'lease-b'}, {controlling: false}, {receivedAt: 0}, {leaderMemberId: 'new-admission'}]) {
    const h = harness(); h.step({}, .1);
    const before = {...h.motion.position};
    const next = changes === null ? null : {...h.current, ...changes};
    const result = h.step({grant: next}, .1);
    assert(result.stopFollow); assert.equal(result.stopFollow.leaseId, 'lease-a');
    assert.deepEqual(h.motion.position, before); assert.deepEqual(h.motion.velocity, {x: 0, z: 0});
    assert.equal(h.controller.snapshot().armed, false);
    assert.equal(h.step({grant: h.current}, .1).stopFollow, null);
    assert.deepEqual(h.motion.position, before);
  }
});

test('FOLLOW-PAUSE: modal, typing, editor and blur hard-stop all movement and reject stale async resumes', () => {
  for (const surface of ['modal', 'typing', 'editor', 'blur']) {
    const h = harness(); h.step({}, .1);
    const oldTicket = h.controller.beginResume();
    const path = [{x: 15, z: 0}];
    h.controller.pause(h.motion, {path});
    assert.equal(path.length, 0, surface);
    const before = {...h.motion.position};
    assert.equal(h.controller.resume(oldTicket, h.current, context), false);
    h.step({input: {x: 1, z: 0}, fast: true}, .25);
    assert.deepEqual(h.motion.position, before); assert.equal(h.controller.snapshot().paused, true);
    h.setTime(10020);
    const ticket = h.controller.beginResume();
    assert.equal(h.controller.resume(ticket, h.current, context), false);
    const fresh = {...h.current, receivedAt: 10020};
    const freshTicket = h.controller.beginResume();
    assert.equal(h.controller.resume(freshTicket, fresh, context), true);
    h.step({grant: fresh}, .1); assert(h.motion.position.z > before.z);
  }
});

test('FOLLOW-ASYNC: newer resume, local stop, or context transition invalidates pending work', () => {
  const h = harness();
  const old = h.controller.beginResume(), next = h.controller.beginResume();
  assert.equal(h.controller.resume(old, h.current, context), false);
  assert.equal(h.controller.resume(next, h.current, context), true);
  const stopped = h.controller.beginResume(); h.controller.clear(h.motion);
  assert.equal(h.controller.resume(stopped, h.current, context), false);
  const changed = h.controller.beginResume();
  assert.equal(h.controller.resume(changed, h.current, {...context, connectionId: 'replacement-stream'}), false);
  const manualOnly = h.controller.beginResume();
  assert.equal(h.controller.resume(manualOnly, null, context), true);
  h.step({grant: null, input: {x: 1, z: 0}}, .1); assert(distance(h.motion) > 0);
});

test('FOLLOW-REVALIDATE: requesting fresh authority drops old follow inertia and preserves accepted Shift limits', () => {
  const h = harness(); h.step({}, .1);
  const position = {...h.motion.position};
  h.controller.beginResume(); h.step({}, .1);
  assert.deepEqual(h.motion.position, position); assert.deepEqual(h.motion.velocity, {x: 0, z: 0});
  const ordinary = createMotion(position);
  for (let i = 0; i < 60; i++) {
    h.step({input: {x: 1, z: 0}, fast: true});
    advanceMotion(ordinary, h.scene, {input: {x: 1, z: 0}}, 1 / 60);
  }
  assert.deepEqual(h.motion, ordinary);
});


test('FOLLOW-RESUME-FAILURE: failed authority releases its ticket without arming and permits a later fresh retry', () => {
  let time = 10000;
  const controller = createFollowMotionController({now: () => time});
  const motion = createMotion({x: 0, z: 0}), scene = room();
  const failed = controller.beginResume();
  assert.equal(controller.rejectResume(failed), true);
  assert.equal(controller.snapshot().pending, false);
  assert.equal(controller.snapshot().armed, false);
  controller.advance(motion, scene, {context, grant: grant()}, .25);
  assert.equal(distance(motion), 0);
  time = 11000;
  const retry = controller.beginResume(), current = grant({receivedAt: time});
  assert.equal(controller.rejectResume(failed), false);
  assert.equal(controller.snapshot().pending, true);
  assert.equal(controller.resume(retry, current, context), true);
  assert.equal(controller.rejectResume(failed), false);
  controller.advance(motion, scene, {context, grant: current}, .25);
  assert(distance(motion) > 0);
});

test('FOLLOW-RESUME-FAILURE: late rejection cannot clear a newer ticket, foreground pause, or stopped lease', () => {
  const controller = createFollowMotionController({now: () => 10000});
  const motion = createMotion({x: 0, z: 0});
  const first = controller.beginResume(), second = controller.beginResume();
  assert.equal(controller.rejectResume(first), false);
  assert.equal(controller.snapshot().pending, true);
  controller.pause(motion);
  assert.equal(controller.rejectResume(second), false);
  assert.equal(controller.snapshot().paused, true);
  const third = controller.beginResume();
  controller.clear(motion);
  assert.equal(controller.rejectResume(third), false);
  assert.equal(controller.resume(third, grant(), context), false);
  assert.equal(controller.snapshot().armed, false);
});
