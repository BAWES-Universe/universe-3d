import { boolean, integer, invariant } from './policy.mjs';

/**
 * A selection-intent reducer, NEVER a connection/handoff implementation.
 * Use a membership revision, not count alone, to model source downgrade debounce.
 */
export function selectTransport(previous, input, config) {
  const { count, membershipRevision, nowMs, kind, sfuAvailable } = input;
  integer(count, 'count'); integer(membershipRevision, 'membershipRevision');
  integer(nowMs, 'nowMs'); boolean(sfuAvailable, 'sfuAvailable');
  integer(config.p2pThreshold, 'p2pThreshold', 1); integer(config.downgradeDelayMs, 'downgradeDelayMs');
  invariant(['proximity', 'meeting'].includes(kind), 'INVALID_transport_kind');
  invariant(['source-threshold', 'force-sfu-target'].includes(config.meetingPolicy), 'INVALID_meetingPolicy');
  invariant(!previous || nowMs >= previous.evaluatedAtMs, 'CLOCK_REGRESSED');
  invariant(!previous || ['p2p', 'sfu'].includes(previous.selectionIntent), 'INVALID_previous_intent');
  invariant(!previous || membershipRevision >= previous.membershipRevision, 'REVISION_REGRESSED');
  const forceSfu = kind === 'meeting' && config.meetingPolicy === 'force-sfu-target';
  const needsSfu = forceSfu || count > config.p2pThreshold;
  let selectionIntent = previous?.selectionIntent ?? 'p2p';
  let intentGeneration = previous?.intentGeneration ?? 0;
  let downgradeAtMs = previous?.downgradeAtMs ?? null;
  const membershipChanged = !previous || previous.membershipRevision !== membershipRevision;
  if (needsSfu) {
    downgradeAtMs = null;
    if (sfuAvailable && selectionIntent !== 'sfu') { selectionIntent = 'sfu'; integer(++intentGeneration, 'intentGeneration'); }
  } else if (selectionIntent === 'sfu') {
    if (downgradeAtMs === null || membershipChanged) {
      downgradeAtMs = nowMs + config.downgradeDelayMs;
      integer(downgradeAtMs, 'downgradeAtMs');
    }
    if (nowMs >= downgradeAtMs) { selectionIntent = 'p2p'; downgradeAtMs = null; integer(++intentGeneration, 'intentGeneration'); }
  } else downgradeAtMs = null;
  // Source leaves oversized P2P active if LiveKit is unavailable. Deliberate safety
  // improvement: selection can remain P2P, but do not authorize an oversized mesh.
  const p2pAllowed = count > 0 && !needsSfu && selectionIntent === 'p2p';
  const blockedReason = count === 0 ? 'empty' : needsSfu && !sfuAvailable ? 'sfu-unavailable' : selectionIntent === 'sfu' ? 'sfu-adapter-not-implemented' : null;
  return Object.freeze({
    selectionIntent, requiredTransport: needsSfu ? 'sfu' : 'p2p', intentGeneration,
    downgradeAtMs, membershipRevision, evaluatedAtMs: nowMs, memberCount: count,
    p2pAllowed, blockedReason, connectedTransport: null, handoffComplete: false,
  });
}
