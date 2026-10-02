import { barycenter, boolean, distance, id, integer, invariant, lexical, proximityEligible, STATUSES, toSourcePosition, validateConfig } from './policy.mjs';
import { selectTransport } from './transport.mjs';

const sorted = values => [...values].sort(lexical);
const memberKey = member => JSON.stringify([member.accountId, member.admissionId]);
const membershipSignature = (bubble, members) => JSON.stringify(sorted(bubble.members).map(accountId => members.get(accountId).memberId));

function normalize(record, config, nowMs) {
  invariant(record && typeof record === 'object', 'INVALID_MEMBER');
  const accountId = id(record.accountId, 'accountId');
  const admissionId = id(record.admissionId, 'admissionId');
  integer(record.lastSeenMs, 'lastSeenMs'); invariant(record.lastSeenMs <= nowMs, 'FUTURE_PRESENCE');
  const status = record.status ?? 'ONLINE'; invariant(STATUSES.includes(status), 'INVALID_status');
  const moving = boolean(record.moving, 'moving');
  const context = record.context; invariant(context && ['proximity', 'meeting', 'silent'].includes(context.kind), 'INVALID_context');
  // A stale area snapshot must never override explicit Silent intent.
  const normalizedContext = status === 'SILENT' ? { kind: 'silent' } : context.kind === 'meeting' ? { kind: 'meeting', meetingId: id(context.meetingId, 'meetingId') } : { kind: context.kind };
  const mediaConsent = boolean(record.mediaConsent ?? false, 'mediaConsent');
  const canPublish = boolean(record.canPublish ?? true, 'canPublish');
  return {
    accountId, admissionId, lastSeenMs: record.lastSeenMs, status, moving,
    context: normalizedContext, position: toSourcePosition(record, config),
    mediaConsent, canPublish,
    followLeaderId: record.followLeaderId == null ? null : id(record.followLeaderId, 'followLeaderId'),
  };
}

/**
 * Isolated, synchronous, deterministic model of TRUSTED admitted-room snapshots.
 * This module is not an authentication boundary. Use service.mjs at a server seam.
 * All state is private, bounded, and pruned. Returned snapshots are detached copies.
 */
export function createBubbleModel({ config: rawConfig, epoch }) {
  const config = validateConfig(rawConfig);
  id(epoch, 'epoch');
  let rooms = new Map(), sequence = 0, lastNowMs = 0;
  const newId = kind => { integer(sequence + 1, 'sequence', 1); return `${epoch}:${kind}:${++sequence}`; };
  const checkClock = nowMs => { integer(nowMs, 'nowMs', 0, Number.MAX_SAFE_INTEGER - config.downgradeDelayMs); invariant(nowMs >= lastNowMs, 'CLOCK_REGRESSED'); };

  function pruneMembers(room, nowMs) {
    for (const [accountId, member] of room.members) if (nowMs - member.lastSeenMs >= config.memberTtlMs) room.members.delete(accountId);
    for (const member of room.members.values()) if (member.followLeaderId && !room.members.has(member.followLeaderId)) member.followLeaderId = null;
    for (const bubble of room.bubbles.values()) {
      for (const accountId of bubble.members) if (!room.members.has(accountId)) bubble.members.delete(accountId);
    }
    dissolveSmall(room);
  }
  function dissolveSmall(room) {
    for (const [bubbleId, bubble] of room.bubbles) if (bubble.members.size < (bubble.kind === 'meeting' ? 1 : 2)) room.bubbles.delete(bubbleId);
  }
  function bubbleOf(room, accountId) { return [...room.bubbles.values()].find(b => b.members.has(accountId)); }
  function removeMember(room, accountId) {
    const bubble = bubbleOf(room, accountId);
    if (bubble) { bubble.members.delete(accountId); dissolveSmall(room); }
  }
  function groupMembers(room, bubble) { return sorted(bubble.members).map(accountId => room.members.get(accountId)); }
  function position(room, bubble) { return barycenter(groupMembers(room, bubble)); }
  function createGroup(room, memberIds, kind = 'proximity', meetingId = null) {
    const bubble = { bubbleId: newId('bubble'), kind, meetingId, members: new Set(memberIds), locked: false, outOfBounds: false, membershipRevision: 0, signature: '', transport: null };
    room.bubbles.set(bubble.bubbleId, bubble); return bubble;
  }
  function updateFollowingBounds(room, bubble) {
    if (bubble.kind !== 'proximity') return;
    const members = groupMembers(room, bubble);
    const heads = members.filter(m => !m.followLeaderId || !bubble.members.has(m.followLeaderId));
    const center = position(room, bubble);
    // Source keeps a coherent leader/follower group even when a follower is stuck.
    bubble.outOfBounds = heads.length === 1 && members.some(m => m.followLeaderId === heads[0].accountId && distance(m.position, center) > config.groupRadiusSource);
  }
  function processMovement(room, member) {
    const bubble = bubbleOf(room, member.accountId);
    if (!bubble || bubble.kind !== 'proximity') return;
    const members = groupMembers(room, bubble), center = position(room, bubble);
    const heads = members.filter(m => !m.followLeaderId || !bubble.members.has(m.followLeaderId));
    const headOutside = heads.some(m => distance(m.position, center) > config.groupRadiusSource);
    const ownOutside = distance(member.position, center) > config.groupRadiusSource;
    if (!headOutside || !ownOutside) { updateFollowingBounds(room, bubble); return; }
    const followers = members.filter(m => m.followLeaderId === member.accountId);
    if (followers.length && members.length === 3 && followers.length === 1) {
      // Preserve the source's three-person special case: eject the unrelated head.
      const outsider = members.find(m => m.accountId !== member.accountId && m.accountId !== followers[0].accountId);
      removeMember(room, outsider.accountId);
    } else if (followers.length) {
      const carried = [member.accountId, ...followers.map(m => m.accountId)];
      for (const accountId of carried) removeMember(room, accountId);
      createGroup(room, carried);
    } else removeMember(room, member.accountId);
    const next = bubbleOf(room, member.accountId); if (next) updateFollowingBounds(room, next);
  }
  function nearbySweep(room, bubble) {
    if (bubble.locked) return;
    for (const accountId of sorted(room.members.keys())) {
      if (bubble.members.size >= config.membershipCeiling) break;
      const candidate = room.members.get(accountId);
      // Deliberate safety/determinism fixes: skip rather than source early return;
      // do not pull moving players into a new conversation; honor locks here too.
      if (!proximityEligible(candidate) || candidate.moving || bubbleOf(room, accountId)) continue;
      if (distance(candidate.position, position(room, bubble)) < config.groupRadiusSource) bubble.members.add(accountId);
    }
    updateFollowingBounds(room, bubble);
  }
  function joinNearest(room, member) {
    if (!proximityEligible(member) || member.moving || bubbleOf(room, member.accountId)) return;
    const candidates = [];
    for (const candidate of room.members.values()) {
      if (candidate.accountId === member.accountId || candidate.moving || !proximityEligible(candidate) || bubbleOf(room, candidate.accountId)) continue;
      const d = distance(member.position, candidate.position);
      if (d <= config.minimumDistanceSource) candidates.push({ d, sortKey: `u:${candidate.accountId}`, member: candidate });
    }
    for (const bubble of room.bubbles.values()) {
      if (bubble.kind !== 'proximity' || bubble.locked || bubble.members.size >= config.membershipCeiling) continue;
      const d = distance(member.position, position(room, bubble));
      if (d <= config.groupRadiusSource) candidates.push({ d, sortKey: `g:${bubble.bubbleId}`, bubble });
    }
    candidates.sort((a, b) => a.d - b.d || lexical(a.sortKey, b.sortKey));
    const target = candidates[0]; if (!target) return;
    const bubble = target.bubble ?? createGroup(room, [member.accountId, target.member.accountId]);
    if (target.bubble) bubble.members.add(member.accountId);
    nearbySweep(room, bubble);
  }
  function reconcileMembership(room, oldMembers) {
    for (const bubble of room.bubbles.values()) for (const accountId of bubble.members) {
      const member = room.members.get(accountId), old = oldMembers.get(accountId);
      if (!member || !old || memberKey(member) !== memberKey(old) ||
          (bubble.kind === 'proximity' ? !proximityEligible(member) : member.context.kind !== 'meeting' || member.context.meetingId !== bubble.meetingId)) bubble.members.delete(accountId);
    }
    dissolveSmall(room);
    // A single authoritative snapshot is evaluated in code-point order. It does
    // not inherit nondeterminism from network arrival or Map insertion order.
    for (const accountId of sorted(room.members.keys())) {
      const member = room.members.get(accountId), old = oldMembers.get(accountId);
      const moved = !old || old.position.x !== member.position.x || old.position.z !== member.position.z || old.followLeaderId !== member.followLeaderId;
      if (moved) processMovement(room, member);
    }
    for (const accountId of sorted(room.members.keys())) {
      const member = room.members.get(accountId);
      if (member.context.kind === 'meeting') {
        let bubble = [...room.bubbles.values()].find(b => b.kind === 'meeting' && b.meetingId === member.context.meetingId);
        if (!bubble) bubble = createGroup(room, [], 'meeting', member.context.meetingId);
        bubble.members.add(accountId);
      } else joinNearest(room, member);
    }
    for (const bubble of room.bubbles.values()) updateFollowingBounds(room, bubble);
  }
  function validateFollowRelations(members) {
    for (const member of members.values()) {
      if (!member.followLeaderId) continue;
      invariant(member.followLeaderId !== member.accountId, 'SELF_FOLLOW');
      const leader = members.get(member.followLeaderId);
      // A stale/offline leader cannot preserve an otherwise inadmissible group.
      if (!leader || !proximityEligible(leader) || !proximityEligible(member)) { member.followLeaderId = null; continue; }
      invariant(!leader.followLeaderId, 'FOLLOW_CYCLE_OR_CHAIN');
    }
  }
  function evaluate(room, nowMs) {
    for (const bubble of room.bubbles.values()) {
      const signature = membershipSignature(bubble, room.members);
      if (signature !== bubble.signature) { integer(bubble.membershipRevision + 1, 'membershipRevision', 1); bubble.membershipRevision++; bubble.signature = signature; }
      bubble.transport = selectTransport(bubble.transport, { count: bubble.members.size, membershipRevision: bubble.membershipRevision, nowMs, kind: bubble.kind, sfuAvailable: room.sfuAvailable }, config);
    }
  }
  function enforceBounds(nextRooms) {
    invariant(nextRooms.size <= config.maxRooms, 'ROOM_LIMIT');
    const accounts = new Set(); let memberships = 0;
    for (const room of nextRooms.values()) {
      invariant(room.members.size <= config.maxMembersPerRoom, 'ROOM_MEMBER_LIMIT');
      memberships += room.members.size;
      for (const accountId of room.members.keys()) accounts.add(accountId);
    }
    invariant(accounts.size <= config.maxAccounts, 'ACCOUNT_LIMIT');
    invariant(memberships <= config.maxMemberships, 'MEMBERSHIP_LIMIT');
  }
  function snapshotRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room) return { roomId, members: [], bubbles: [] };
    return {
      roomId,
      members: sorted(room.members.keys()).map(accountId => {
        const m = room.members.get(accountId); return { accountId, memberId: m.memberId, bubbleId: bubbleOf(room, accountId)?.bubbleId ?? null, context: { ...m.context }, status: m.status, mediaConsent: m.mediaConsent };
      }),
      bubbles: sorted(room.bubbles.keys()).map(bubbleId => {
        const b = room.bubbles.get(bubbleId), members = groupMembers(room, b);
        return { bubbleId, kind: b.kind, meetingId: b.meetingId, accountIds: sorted(b.members), memberIds: members.map(m => m.memberId), centerSource: position(room, b), outOfBounds: b.outOfBounds, locked: b.locked, membershipRevision: b.membershipRevision, transport: { ...b.transport } };
      }),
    };
  }
  function diff(before, after) {
    const oldByMember = new Map(before.members.map(m => [m.memberId, m]));
    const newByMember = new Map(after.members.map(m => [m.memberId, m]));
    const events = [];
    for (const member of before.members) if (member.bubbleId && newByMember.get(member.memberId)?.bubbleId !== member.bubbleId) events.push({ type: 'leave', bubbleId: member.bubbleId, accountId: member.accountId, memberId: member.memberId });
    for (const member of after.members) if (member.bubbleId && oldByMember.get(member.memberId)?.bubbleId !== member.bubbleId) events.push({ type: 'join', bubbleId: member.bubbleId, accountId: member.accountId, memberId: member.memberId });
    return events;
  }
  function syncRoom({ roomId, members: records, sfuAvailable, nowMs }) {
    id(roomId, 'roomId'); checkClock(nowMs); boolean(sfuAvailable, 'sfuAvailable');
    invariant(Array.isArray(records) && records.length <= config.maxMembersPerRoom, 'ROOM_MEMBER_LIMIT');
    const normalized = records.map(record => normalize(record, config, nowMs));
    const seen = new Set();
    for (const member of normalized) { invariant(!seen.has(member.accountId), 'DUPLICATE_ACCOUNT'); seen.add(member.accountId); }
    const before = snapshotRoom(roomId);
    const nextRooms = structuredClone(rooms);
    for (const [key, room] of nextRooms) {
      pruneMembers(room, nowMs);
      // At a deadline, apply this room's NEW authoritative membership before
      // evaluating the timer. Otherwise a simultaneous sixth arrival causes a
      // spurious P2P intent then SFU intent within this one transaction.
      if (key !== roomId) evaluate(room, nowMs);
      if (!room.members.size) nextRooms.delete(key);
    }
    const room = nextRooms.get(roomId) ?? { members: new Map(), bubbles: new Map(), sfuAvailable };
    const oldMembers = room.members;
    room.members = new Map(); room.sfuAvailable = sfuAvailable;
    for (const member of normalized.sort((a, b) => lexical(a.accountId, b.accountId))) {
      if (nowMs - member.lastSeenMs >= config.memberTtlMs) continue;
      const old = oldMembers.get(member.accountId);
      member.memberId = old && memberKey(member) === memberKey(old) ? old.memberId : newId('member');
      room.members.set(member.accountId, member);
    }
    validateFollowRelations(room.members);
    reconcileMembership(room, oldMembers);
    evaluate(room, nowMs);
    if (room.members.size) nextRooms.set(roomId, room); else nextRooms.delete(roomId);
    enforceBounds(nextRooms);
    rooms = nextRooms; lastNowMs = nowMs;
    const snapshot = snapshotRoom(roomId);
    return { ...snapshot, events: diff(before, snapshot) };
  }
  function tick(nowMs) {
    checkClock(nowMs);
    const results = [];
    for (const [roomId, room] of rooms) {
      const before = snapshotRoom(roomId);
      pruneMembers(room, nowMs); evaluate(room, nowMs);
      if (!room.members.size) rooms.delete(roomId);
      const snapshot = snapshotRoom(roomId); results.push({ ...snapshot, events: diff(before, snapshot) });
    }
    lastNowMs = nowMs; return results;
  }
  function view(roomId, accountId, admissionId, nowMs) {
    tick(nowMs);
    const room = rooms.get(roomId), member = room?.members.get(accountId);
    invariant(member && member.admissionId === admissionId, 'MEMBERSHIP_REQUIRED');
    const bubble = bubbleOf(room, accountId);
    const peers = bubble ? groupMembers(room, bubble).filter(m => m.accountId !== accountId) : [];
    const consentingPeers = member.mediaConsent ? peers.filter(m => m.mediaConsent) : [];
    return {
      roomId, accountId, memberId: member.memberId, bubbleId: bubble?.bubbleId ?? null,
      membershipRevision: bubble?.membershipRevision ?? null,
      conversationRecipients: peers.map(m => ({ accountId: m.accountId, memberId: m.memberId })),
      mediaRecipients: consentingPeers.map(m => ({ accountId: m.accountId, memberId: m.memberId, canSend: member.canPublish, canReceive: m.canPublish })),
      p2pRecipients: bubble?.transport.p2pAllowed ? consentingPeers.map(m => ({ accountId: m.accountId, memberId: m.memberId, canSend: member.canPublish, canReceive: m.canPublish })).filter(p => p.canSend || p.canReceive) : [],
      transport: bubble ? { ...bubble.transport } : null,
    };
  }
  function forgetRoom(roomId) { const existed = rooms.delete(roomId); return existed; }
  function clear() { rooms.clear(); }
  function forgetAccount(accountId, nowMs) {
    checkClock(nowMs);
    for (const [roomId, room] of rooms) {
      room.members.delete(accountId); pruneMembers(room, nowMs); evaluate(room, nowMs);
      if (!room.members.size) rooms.delete(roomId);
    }
    lastNowMs = nowMs;
  }
  function setLocked(roomId, bubbleId, locked) {
    boolean(locked, 'locked'); const bubble = rooms.get(roomId)?.bubbles.get(bubbleId);
    invariant(bubble?.kind === 'proximity', 'BUBBLE_REQUIRED'); bubble.locked = locked;
  }
  function stats() {
    const accounts = new Set(); let memberships = 0, bubbles = 0;
    for (const room of rooms.values()) { memberships += room.members.size; bubbles += room.bubbles.size; for (const accountId of room.members.keys()) accounts.add(accountId); }
    return { rooms: rooms.size, accounts: accounts.size, memberships, bubbles };
  }
  return Object.freeze({ syncRoom, tick, view, forgetRoom, forgetAccount, setLocked, stats, snapshot: snapshotRoom, clear });
}
