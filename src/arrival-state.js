const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const sourceKey = value => identifier(value) || Number.isSafeInteger(value) && value >= 0;
const decision = (kind, reason) => ({kind, reason});

function placement(roomId, value) {
  if (!identifier(roomId) || !value || !Number.isFinite(value.x) || !Number.isFinite(value.z) ||
      !identifier(value.admissionId) || !identifier(value.admissionEpoch) ||
      !Number.isSafeInteger(value.admissionRevision) || value.admissionRevision < 1 ||
      value.roomId !== undefined && value.roomId !== roomId) return null;
  return {roomId, x: value.x, z: value.z, admissionId: value.admissionId,
    admissionEpoch: value.admissionEpoch, admissionRevision: value.admissionRevision};
}

function identity(value) {
  return value ? {roomId: value.roomId, admissionId: value.admissionId,
    admissionEpoch: value.admissionEpoch, admissionRevision: value.admissionRevision} : null;
}

// Only compare placements in one room and process. A revision does not order
// movement within an admission. Returning "same" intentionally ignores x/z.
function compare(candidate, previous) {
  if (!previous) return 'newer';
  if (candidate.roomId !== previous.roomId || candidate.admissionEpoch !== previous.admissionEpoch) return 'invalid';
  if (candidate.admissionId === previous.admissionId) {
    return candidate.admissionRevision === previous.admissionRevision ? 'same' : 'invalid';
  }
  if (candidate.admissionRevision === previous.admissionRevision) return 'invalid';
  return candidate.admissionRevision > previous.admissionRevision ? 'newer' : 'older';
}

/** Pure ordering for authenticated arrival HTTP and source-fenced self SSE.
 * This is not an authorization layer: callers must supply actual responses,
 * never URL data. Apply every adopt's pose AND admission fields synchronously
 * before enabling movement. Only the shell owns/renderers apply live motion.
 */
export function createArrivalState(initialContext = {}) {
  let accountId = null, roomId = null, sourceGeneration = null, arrivalEpoch = null;
  let current = null, pending = null, generation = 0;

  function refresh(reason) {
    generation++; current = null; pending = null;
    return decision('refresh-required', reason);
  }

  function reset(context = {}) {
    accountId = identifier(context.accountId) ? context.accountId : null;
    roomId = identifier(context.roomId) ? context.roomId : null;
    sourceGeneration = sourceKey(context.sourceGeneration) ? context.sourceGeneration : null;
    arrivalEpoch = null;
    return refresh('context-reset');
  }

  function matchesSource(value) {
    return accountId !== null && sourceGeneration !== null && value === sourceGeneration;
  }

  function hello({sourceGeneration: source, arrivalEpoch: epoch} = {}) {
    if (!matchesSource(source)) return decision('ignore', 'stale-source');
    if (!identifier(epoch)) { arrivalEpoch = null; return refresh('invalid-epoch'); }
    if (arrivalEpoch === epoch) return decision('ignore', 'same-epoch');
    const changed = arrivalEpoch !== null;
    arrivalEpoch = epoch;
    // The first hello may arrive while initial HTTP is already pending. It
    // establishes that ticket's scope; only a process CHANGE retires it.
    return changed ? refresh('epoch-changed') : decision('ready', 'epoch-established');
  }

  function beginJoin({roomId: destination} = {}) {
    if (!accountId || sourceGeneration === null || !identifier(destination)) return null;
    const ticket = Object.freeze({generation: ++generation, accountId,
      roomId: destination, sourceGeneration});
    // Starting a new request fences both the prior success and prior failure.
    // Preserve the newest source-room evidence if it belongs to the same
    // applied admission scope; never carry old destination evidence forward.
    let source = pending?.source ?? null;
    if (pending?.roomId === roomId && pending.destination &&
        compare(pending.destination, source) === 'newer') source = pending.destination;
    pending = {ticket, roomId: destination, destination: null, source};
    return ticket;
  }

  function matchesTicket(ticket) {
    return !!ticket && ticket === pending?.ticket && ticket.generation === generation &&
      ticket.accountId === accountId && ticket.sourceGeneration === sourceGeneration;
  }

  function adopt(value, reason) {
    current = {...value}; roomId = value.roomId;
    return {kind: 'adopt', reason, ...identity(value), pose: {x: value.x, z: value.z}};
  }

  function retain(reason) {
    return {kind: 'retain', reason, ...identity(current)};
  }

  function observeSelf({sourceGeneration: source, roomId: observedRoom, presence} = {}) {
    if (!matchesSource(source)) return decision('ignore', 'stale-source');
    if (!presence || (presence.id ?? presence.userId) !== accountId ||
        presence.id !== undefined && presence.id !== accountId ||
        presence.userId !== undefined && presence.userId !== accountId) return decision('ignore', 'not-self');
    const destination = pending?.roomId === observedRoom;
    const sourceRoom = current && roomId === observedRoom;
    if (!destination && !sourceRoom) return decision('ignore', 'other-room');
    const candidate = placement(observedRoom, presence);
    if (!candidate) return refresh('invalid-placement');
    // A presence event cannot establish or change the stream's process epoch.
    if (arrivalEpoch === null) return decision('ignore', 'awaiting-epoch');
    if (candidate.admissionEpoch !== arrivalEpoch) return decision('ignore', 'epoch-mismatch');
    if (sourceRoom) {
      const order = compare(candidate, current);
      if (order === 'invalid') return refresh('conflicting-placement');
      if (order === 'older' || order === 'same') return decision('ignore', order === 'older' ? 'older-placement' : 'same-admission');
    }
    if (!pending) return adopt(candidate, 'newer-self-placement');
    const key = destination ? 'destination' : 'source';
    for (const known of [pending.destination, pending.source]) {
      if (!known || known.roomId !== observedRoom) continue;
      const order = compare(candidate, known);
      if (order === 'invalid') return refresh('conflicting-placement');
      if (order === 'older' || order === 'same') return decision('ignore', order === 'older' ? 'older-placement' : 'same-admission');
    }
    pending[key] = candidate;
    return decision('buffer', destination ? 'pending-destination' : 'pending-source');
  }

  function resolveJoin(ticket, {roomId: destination, arrival} = {}) {
    if (!matchesTicket(ticket)) return decision('ignore', 'stale-ticket');
    if (destination !== pending.roomId) return refresh('destination-mismatch');
    const candidate = placement(destination, arrival);
    if (!candidate) return refresh('invalid-placement');
    if (arrivalEpoch !== null && candidate.admissionEpoch !== arrivalEpoch) {
      // Learn the reported process, but demand HTTP begun AFTER the boundary.
      // Neither the old HTTP nor old SSE can reactivate a retired placement.
      arrivalEpoch = candidate.admissionEpoch;
      return refresh('epoch-changed');
    }
    arrivalEpoch ??= candidate.admissionEpoch;
    let accepted = candidate, reason = 'join-response';
    for (const known of [pending.destination, destination === roomId ? pending.source : null,
      destination === roomId ? current : null]) {
      if (!known) continue;
      const order = compare(known, accepted);
      if (order === 'invalid') return refresh('conflicting-placement');
      if (order === 'newer') { accepted = known; reason = 'newer-self-placement'; }
      // Equal identity does not prove that buffered movement beats HTTP.
    }
    pending = null;
    if (current && compare(accepted, current) === 'same') return retain('same-admission');
    return adopt(accepted, reason);
  }

  function cancelJoin(ticket) {
    if (!matchesTicket(ticket)) return decision('ignore', 'stale-ticket');
    // Failure does not authorize the pending destination. Only an already
    // confirmed source room can accept its independently observed placement.
    const candidate = pending.roomId === roomId ? pending.destination ?? pending.source : pending.source;
    pending = null;
    if (!current) return decision('refresh-required', 'unconfirmed-source');
    if (candidate) {
      const order = compare(candidate, current);
      if (order === 'invalid') return refresh('conflicting-placement');
      if (order === 'newer') return adopt(candidate, 'newer-source-placement');
    }
    return retain('join-cancelled');
  }

  function snapshot() {
    return {accountId, roomId, sourceGeneration, arrivalEpoch, needsAuthority: current === null,
      current: identity(current), pending: pending !== null, pendingRoomId: pending?.roomId ?? null,
      bufferedDestination: identity(pending?.destination), bufferedSource: identity(pending?.source)};
  }

  reset(initialContext);
  return Object.freeze({reset, hello, beginJoin, observeSelf, resolveJoin, cancelJoin,
    failJoin: cancelJoin, snapshot});
}
