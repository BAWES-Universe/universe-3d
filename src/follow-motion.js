import {advanceMotion, screenDirection, stopMotion} from './motion.js';

// Player.ts at bae18306bdfa63e58cd4124b1a3b5b290b61c286:208–224.
// Scale is supplied by the current authority, never a presumed deployment value.
export const FOLLOW_STOP_DISTANCE_SOURCE_SQUARED = 2000;
// Client safety bounds, not upstream constants. A live server may set a tighter
// leaderPresenceMaxAgeMs; the membership lease is always an upper bound.
export const FOLLOW_AUTHORITY_MAX_AGE_MS = 5000;
export const FOLLOW_LEADER_MAX_AGE_MS = 5000;
const STEP = 1 / 120;
const id = value => typeof value === 'string' && value.length > 0;
const positive = value => Number.isFinite(value) && value > 0;
const point = value => value && Number.isFinite(value.x) && Number.isFinite(value.z);
const identity = grant => JSON.stringify([grant.roomId, grant.connectionId, grant.memberId, grant.leaderId, grant.leaderMemberId, grant.leaseId]);
const inputVector = input => ({x: Number.isFinite(input?.x) ? input.x : 0, z: Number.isFinite(input?.z) ? input.z : 0});

export function followStopDistanceWorld(sourceUnitsPerWorldUnit) {
  const distance = positive(sourceUnitsPerWorldUnit) ? Math.sqrt(FOLLOW_STOP_DISTANCE_SOURCE_SQUARED) / sourceUnitsPerWorldUnit : null;
  return positive(distance) ? distance : null;
}

/** Validate the locally consented motion grant from proximity-controls.js.
 * receivedAt and now use the same local clock. serverTime/lastSeen use the
 * server clock: elapsed local time ages the sample without assuming clock sync.
 * The leader sample is embedded by the room authority, not a rendered avatar.
 */
export function validateFollowMotionGrant(grant, context, now, {
  authorityMaxAgeMs = FOLLOW_AUTHORITY_MAX_AGE_MS,
  leaderMaxAgeMs = FOLLOW_LEADER_MAX_AGE_MS,
} = {}) {
  if (!grant) return {valid: false, reason: 'no-follow'};
  if (!context || !id(context.roomId) || !id(context.connectionId) ||
      grant.roomId !== context.roomId || grant.connectionId !== context.connectionId ||
      (context.memberId != null && grant.memberId !== context.memberId)) return {valid: false, reason: 'context-changed'};
  if (!id(grant.memberId) || !id(grant.leaderId) || !id(grant.leaderMemberId) || !id(grant.leaseId) ||
      grant.leaderMemberId === grant.memberId || grant.controlling !== true || grant.controllerConnected !== true) return {valid: false, reason: 'not-controlling'};
  const stopDistance = followStopDistanceWorld(grant.sourceUnitsPerWorldUnit);
  if (stopDistance === null || !positive(grant.memberTtlMs) || !positive(authorityMaxAgeMs) || !positive(leaderMaxAgeMs)) return {valid: false, reason: 'invalid-limits'};
  const elapsed = now - grant.receivedAt;
  if (!Number.isFinite(now) || !Number.isFinite(grant.receivedAt) || elapsed < 0 || elapsed >= Math.min(authorityMaxAgeMs, grant.memberTtlMs)) return {valid: false, reason: 'authority-stale'};
  const leader = grant.leaderPresence;
  if (!point(leader)) return {valid: false, reason: 'leader-missing'};
  // Current wire samples omit these redundant fields. Check them if a future
  // adapter includes them; never silently blend a different admission/room.
  if ((leader.roomId != null && leader.roomId !== grant.roomId) ||
      (leader.memberId != null && leader.memberId !== grant.leaderMemberId) ||
      (leader.accountId != null && leader.accountId !== grant.leaderId)) return {valid: false, reason: 'leader-changed'};
  const sampleAge = grant.serverTime - leader.lastSeen;
  const maxAge = Math.min(leaderMaxAgeMs, grant.memberTtlMs,
    positive(grant.leaderPresenceMaxAgeMs) ? grant.leaderPresenceMaxAgeMs : Infinity);
  if (!Number.isFinite(grant.serverTime) || !Number.isFinite(leader.lastSeen) || sampleAge < 0 || sampleAge + elapsed >= maxAge) return {valid: false, reason: 'leader-stale'};
  return {valid: true, reason: null, stopDistance, leader, key: identity(grant)};
}

/** Source follow direction is added to manual input. The existing integrator
 * normalizes the sum, resolves collisions, and derives heading from actual
 * displacement. This module never assigns a destination position or camera.
 */
export function followSteering(position, leader, stopDistance, input = {x: 0, z: 0}, angle = Math.PI / 4) {
  const manual = inputVector(input);
  if (!point(position) || !point(leader) || !positive(stopDistance)) return {input: manual, following: false};
  const dx = leader.x - position.x, dz = leader.z - position.z;
  const distance = Math.hypot(dx, dz);
  if (distance < stopDistance || distance === 0) return {input: manual, following: false};
  // screenDirection's orthogonal matrix is its own inverse.
  const screen = screenDirection({x: dx / distance, z: dz / distance}, angle);
  return {input: {x: manual.x + screen.x, z: manual.z + screen.z}, following: true};
}

function stoppedResult(reason, elapsed = 0) {
  return {manual: false, moving: false, running: false, travelled: 0, elapsed,
    following: false, followPaused: true, reason, stopFollow: null};
}

/** One controller per local avatar, no DOM, network, timers or global state.
 *
 * pause(motion,{path}) is a hard stop and invalidates every resume ticket.
 * After the foreground becomes usable, call beginResume(), then start a fresh
 * authority GET, then resume(ticket, snapshot.motion, context). An old request
 * must never be used as that GET. resume(null grant) also permits manual play.
 * Repeated SSE updates are only inputs to advance: they cannot arm following.
 * clear() retires local motion immediately for Stop/disconnect/room changes.
 */
export function createFollowMotionController({now = Date.now, authorityMaxAgeMs = FOLLOW_AUTHORITY_MAX_AGE_MS, leaderMaxAgeMs = FOLLOW_LEADER_MAX_AGE_MS} = {}) {
  const policy = {authorityMaxAgeMs, leaderMaxAgeMs};
  let generation = 0, paused = false, active = null, pending = null, haltOnAdvance = false, lastReason = 'not-armed';
  const clearPath = options => { if (Array.isArray(options?.path)) options.path.length = 0; };
  function invalidate(motion, options, foregroundPaused) {
    generation++; paused = foregroundPaused; active = null; pending = null; haltOnAdvance = false;
    stopMotion(motion); clearPath(options);
  }
  function pause(motion, options) {
    if (!paused || active || pending) invalidate(motion, options, true);
    else { stopMotion(motion); clearPath(options); }
    lastReason = 'foreground-paused';
  }
  function clear(motion, options) {
    invalidate(motion, options, paused);
    lastReason = 'not-armed';
  }
  function beginResume() {
    // Allows fresh manual input while waiting for authority, but never follows.
    haltOnAdvance ||= !!active;
    paused = false; active = null;
    pending = Object.freeze({generation: ++generation, startedAt: now()});
    lastReason = 'awaiting-authority';
    return pending;
  }
  function rejectResume(ticket) {
    // A failed request must release only its own ticket. A late failure cannot
    // cancel a newer resume, a foreground pause or a newly accepted lease.
    if (!ticket || ticket !== pending || ticket.generation !== generation) return false;
    pending = null; lastReason = 'authority-unconfirmed'; return true;
  }
  function resume(ticket, grant, context) {
    if (!ticket || ticket !== pending || ticket.generation !== generation || paused) return false;
    pending = null;
    if (grant === null) { lastReason = 'no-follow'; return true; }
    const validation = validateFollowMotionGrant(grant, context, now(), policy);
    if (!validation.valid || grant.receivedAt < ticket.startedAt) {
      lastReason = validation.valid ? 'pre-resume-authority' : validation.reason;
      return false;
    }
    active = {key: validation.key, leaseId: grant.leaseId}; lastReason = null;
    return true;
  }
  function advance(motion, scene, options = {}, elapsed = 0) {
    const {grant = null, context, path = [], pathSpeed = 1, fast = false, followSpeedLimited = false, cancelPath = false} = options;
    const input = inputVector(options.input), angle = Number.isFinite(options.angle) ? options.angle : Math.PI / 4;
    const manual = Math.hypot(input.x, input.z) > .065;
    const dt = Math.max(0, Math.min(.25, Number.isFinite(elapsed) ? elapsed : 0));
    if (paused) { stopMotion(motion); path.length = 0; return stoppedResult(lastReason, dt); }
    if (haltOnAdvance) { stopMotion(motion); haltOnAdvance = false; }
    const validation = validateFollowMotionGrant(grant, context, now(), policy);
    let stopFollow = null;
    if (active && (!validation.valid || active.key !== validation.key)) {
      const reason = validation.valid ? 'lease-changed' : validation.reason;
      stopFollow = {leaseId: active.leaseId, reason}; active = null; pending = null;
      generation++; lastReason = reason; stopMotion(motion);
    }
    const armed = !!active && validation.valid;
    // Invitations are absent from the motion grant. Only locally initiated
    // leadership / actual accepted relations should set followSpeedLimited.
    const limited = followSpeedLimited || validation.valid;
    if (manual || cancelPath) path.length = 0;
    if (!armed || path.length) {
      const result = advanceMotion(motion, scene, {input, angle, fast: fast && !limited, path, pathSpeed}, dt);
      return {...result, following: false, followPaused: !!grant && !armed, reason: lastReason, stopFollow};
    }
    // Re-evaluate the stop radius at the integrator's fixed substep. A suspended
    // frame cannot overshoot the leader while braking, or gain diagonal speed.
    const count = Math.max(1, Math.ceil(dt / STEP)), h = dt / count;
    let travelled = 0, following = false;
    for (let i = 0; i < count; i++) {
      const steering = followSteering(motion.position, validation.leader, validation.stopDistance, input, angle);
      following ||= steering.following;
      if (Math.hypot(steering.input.x, steering.input.z) <= .065) stopMotion(motion);
      const result = advanceMotion(motion, scene, {input: steering.input, angle, fast: false, path: [], pathSpeed: 1}, h);
      travelled += result.travelled;
    }
    motion.moving = travelled > .0001; motion.running = false;
    return {manual, moving: motion.moving, running: false, travelled, elapsed: dt,
      following, followPaused: false, reason: null, stopFollow};
  }
  return Object.freeze({pause, clear, beginResume, rejectResume, resume, advance,
    snapshot: () => ({paused, armed: !!active, leaseId: active?.leaseId ?? null, pending: !!pending, reason: lastReason})});
}
