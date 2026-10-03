/** Admission-bound participant controls. No media capture, camera action or force-follow. */
const PROTOCOL = 'proximity-controls-v1';
const REFRESH_ERROR = 'Nearby controls could not refresh. Try again.';
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const person = value => value && opaque(value.accountId) && opaque(value.memberId) && typeof value.name === 'string' && value.name.length <= 128;
const admissionKey = value => JSON.stringify([value?.accountId, value?.roomId, value?.memberId, value?.connectionId]);
const relationKey = value => JSON.stringify([value?.following, value?.followers, value?.invitations?.map(i => i.invitationId), value?.outgoingInvitations?.map(i => i.invitationId)]);
function validContext(value) {
  if (value?.protocol !== PROTOCOL || typeof value.available !== 'boolean') return false;
  if (!value.available) return ['disabled', 'outside-room', 'authority-unavailable', 'room-transition', 'unavailable'].includes(value.reason);
  if (!opaque(value.accountId) || (value.connectionId !== null && !opaque(value.connectionId)) || !opaque(value.roomId) || !revision(value.snapshotRevision) || !finite(value.serverTime)) return false;
  if (value.memberId !== null && (!opaque(value.memberId) || !revision(value.stateRevision))) return false;
  if (value.memberId === null && value.stateRevision !== null) return false;
  if (!['locked', 'full', 'canLock', 'canInvite', 'ignoreRequests'].every(key => typeof value[key] === 'boolean')) return false;
  if (!Array.isArray(value.participants) || value.participants.length > 256 || !value.participants.every(person) || new Set(value.participants.map(p => p.accountId)).size !== value.participants.length || new Set(value.participants.map(p => p.memberId)).size !== value.participants.length) return false;
  if (value.bubbleId === null) { if (value.membershipRevision !== null || value.controlRevision !== null || value.participants.length || value.canLock || value.canInvite || value.locked || value.full) return false; }
  else if (!opaque(value.bubbleId) || !revision(value.membershipRevision) || !revision(value.controlRevision) || !value.participants.some(p => p.accountId === value.accountId && p.memberId === value.memberId)) return false;
  for (const [key, prefix] of [['invitations', 'leader'], ['outgoingInvitations', 'recipient']]) {
    const rows = value[key];
    if (!Array.isArray(rows) || rows.length > 256 || new Set(rows.map(p => p.invitationId)).size !== rows.length || rows.some(p => !opaque(p.invitationId) || !opaque(p[prefix+'Id']) || !opaque(p[prefix+'MemberId']) || typeof p[prefix+'Name'] !== 'string' || p[prefix+'Name'].length > 128 || !finite(p.expiresAt))) return false;
  }
  if (!Array.isArray(value.followers) || value.followers.length > 256 || !value.followers.every(person)) return false;
  const f = value.following;
  if (f !== null && (!f || !opaque(f.leaderId) || f.leaderId === value.accountId || !opaque(f.leaderMemberId) || typeof f.leaderName !== 'string' || f.leaderName.length > 128 || typeof f.controlling !== 'boolean' || typeof f.controllerConnected !== 'boolean' || (f.controlling ? !opaque(f.leaseId) : f.leaseId !== null) || (f.leaderPresence !== null && (!f.leaderPresence || !['x','z','lastSeen'].every(k => finite(f.leaderPresence[k])) || typeof f.leaderPresence.moving !== 'boolean')))) return false;
  return !!value.limits && finite(value.limits.sourceUnitsPerWorldUnit) && value.limits.sourceUnitsPerWorldUnit > 0 && finite(value.limits.memberTtlMs) && value.limits.memberTtlMs > 0;
}

export function createProximityControls({api, getState, onChange = () => {}, now = () => Date.now(), monotonicNow = () => performance.now(), operationId = () => crypto.randomUUID(), storage = typeof localStorage === 'undefined' ? null : localStorage}) {
  if (typeof api !== 'function' || typeof getState !== 'function') throw new TypeError('Controls need api and getState');
  let actor = '', room = '', ready = false, navigating = false, context = null, connection = 'connecting', destroyed = false;
  let generation = 0, serial = 0, refreshSerial = 0, receivedAt = 0, receivedMonotonic = 0, highestSnapshot = -1, operation = null, error = '', notice = '';
  let acceptIntent = null, acceptedLease = null, localStopped = false, stopUnconfirmed = false, stopRevision = -1;
  let preferredIgnore = null, preferenceAttempt = null;
  const retiredConnections = new Set(), retiredLeases = new Set(), listeners = new Set();
  const emit = () => { if (!destroyed) { onChange(); for (const listener of listeners) listener(); } };
  function retireMotion() { if (context?.following?.leaseId) retiredLeases.add(context.following.leaseId); acceptedLease = null; acceptIntent = null; }
  function invalidate({retireConnection = false} = {}) {
    generation++; refreshSerial++; operation = null; retireMotion();
    if (retireConnection && context?.connectionId) retiredConnections.add(context.connectionId);
  }
  function syncState() {
    const s = getState() || {}, nextActor = s.user?.id || '', nextRoom = s.room?.id || '', nextReady = s.ready !== false, nextNavigating = !!s.navigating;
    if (actor !== nextActor || room !== nextRoom) {
      invalidate({retireConnection: true}); context = null; highestSnapshot = -1; connection = 'connecting'; error = notice = ''; localStopped = stopUnconfirmed = false;
      if (actor !== nextActor) { retiredLeases.clear(); preferredIgnore = null; try { const stored = storage?.getItem('universe:follow-ignore:v1:'+nextActor); preferredIgnore = stored === 'true' ? true : stored === 'false' ? false : null; } catch { /* Private browsers keep this tab choice. */ } }
      preferenceAttempt = null;
      actor = nextActor; room = nextRoom;
    }
    if ((ready && !nextReady) || (!navigating && nextNavigating)) invalidate();
    ready = nextReady; navigating = nextNavigating;
  }
  function resetConnection(reason = 'connecting') {
    syncState(); invalidate({retireConnection: true}); context = null; highestSnapshot = -1; connection = reason === 'connecting' ? 'connecting' : 'disconnected';
    error = ''; emit();
  }
  function acceptContext(value, {readOnly = false} = {}) {
    syncState(); if (destroyed || !actor || readOnly && context?.connectionId) return false;
    if (value?.connectionId && retiredConnections.has(value.connectionId)) return false;
    if (value?.available && value.accountId !== actor) return false;
    if (value?.available && (value.roomId !== room || navigating)) return false;
    if (context?.connectionId && value?.connectionId && context.connectionId !== value.connectionId) return false; // Explicit stream reset is required.
    if (revision(value?.snapshotRevision) && value.snapshotRevision < highestSnapshot) return false;
    if (!validContext(value) || value.available && !readOnly && !opaque(value.connectionId)) { invalidate(); context = null; connection = 'unavailable'; error = 'Nearby controls could not be verified.'; emit(); return false; }
    if (!value.available) { invalidate(); context = null; connection = value.reason; emit(); return true; }
    if (context && admissionKey(context) !== admissionKey(value)) { invalidate(); localStopped = stopUnconfirmed = false; }
    if (context && relationKey(context) !== relationKey(value)) notice = '';
    highestSnapshot = value.snapshotRevision; context = structuredClone(value); receivedAt = now(); receivedMonotonic = monotonicNow(); connection = readOnly ? 'read-only' : 'connected';
    if (acceptIntent && acceptIntent.generation === generation && acceptIntent.connectionId === context.connectionId && acceptIntent.memberId === context.memberId && context.following?.controlling && context.following.leaderId === acceptIntent.leaderId && context.following.leaderMemberId === acceptIntent.leaderMemberId && !retiredLeases.has(context.following.leaseId)) acceptedLease = context.following.leaseId;
    if (acceptedLease && (!context.following || context.following.leaseId !== acceptedLease)) retireMotion();
    if (stopUnconfirmed && context.snapshotRevision > stopRevision && !context.following && !context.followers.length && !context.outgoingInvitations.length && !context.invitations.length) {
      stopUnconfirmed = false; notice = 'Stopped.'; error = '';
      // The current authority establishes the outcome even if the HTTP receipt is lost.
      // Retire the operation so that receipt cannot overwrite this or a later relation.
      if (operation?.action === 'stop') { operation.confirmed = true; operation = null; }
    }
    emit();
    const preferenceKey = admissionKey(context)+':'+preferredIgnore;
    if (preferredIgnore !== null && preferredIgnore !== context.ignoreRequests && context.memberId && !readOnly && preferenceAttempt !== preferenceKey) {
      preferenceAttempt = preferenceKey; queueMicrotask(() => { if (!destroyed && context && admissionKey(context)+':'+preferredIgnore === preferenceKey) { if (!operation) void act('preferences', {ignoreRequests:preferredIgnore}); else preferenceAttempt = null; } });
    }
    return true;
  }
  const serverNow = () => (context?.serverTime || now()) + Math.max(0, monotonicNow() - receivedMonotonic);
  function snapshot() {
    syncState(); const c = context, fresh = connection === 'connected' && ready && !navigating;
    const following = !!c?.following, leading = !!c && (c.followers.length > 0 || c.outgoingInvitations.some(i => i.expiresAt > serverNow()));
    const canAct = fresh && !!c?.memberId;
    const motion = fresh && !localStopped && c?.following?.controlling && c.following.controllerConnected && c.following.leaseId === acceptedLease && !retiredLeases.has(acceptedLease) ? {...structuredClone(c.following), connectionId:c.connectionId, roomId:c.roomId, memberId:c.memberId, sourceUnitsPerWorldUnit:c.limits.sourceUnitsPerWorldUnit, memberTtlMs:c.limits.memberTtlMs, leaderPresenceMaxAgeMs:c.limits.leaderPresenceMaxAgeMs, serverTime:c.serverTime, receivedAt} : null;
    return {serverLeading:leading, serverWaiting:leading && !c.followers.length, followingReadOnly:following && (!c.following.controlling || connection !== 'connected'), available: !!c, context:c ? structuredClone(c) : null, connection, ready, navigating, canAct, operation: operation ? {action:operation.action} : null, error, notice, localStopped, stopUnconfirmed, motion, leading:!localStopped && leading, waiting:!localStopped && leading && !c.followers.length, followSpeedLimited:fresh && !localStopped && (following || leading), canStop:!!c && (following || leading || c.invitations.length > 0 || stopUnconfirmed || operation?.action === 'accept' || operation?.action === 'invite'), ignoreRequests:preferredIgnore ?? c?.ignoreRequests ?? false, preferencePending:preferredIgnore !== null && !!c && preferredIgnore !== c.ignoreRequests, invitations:c && !(preferredIgnore ?? c.ignoreRequests) ? c.invitations.map(i => ({...i, expired:i.expiresAt <= serverNow()})) : []};
  }
  async function refresh({readOnly = false} = {}) {
    syncState(); if ((!context?.connectionId && !readOnly) || destroyed || !actor || !room || navigating) return false;
    const sequence = ++refreshSerial, capturedGeneration = generation, connectionId = context?.connectionId ?? null;
    const capturedAdmission = admissionKey(context), startingRevision = context?.snapshotRevision;
    const refreshed = success => { if (success && error === REFRESH_ERROR) { error = ''; emit(); } return success; };
    try {
      const value = await api('/api/proximity-controls'+(readOnly ? '' : '?connectionId='+encodeURIComponent(connectionId))); syncState();
      if (sequence !== refreshSerial || generation !== capturedGeneration || (context?.connectionId ?? null) !== connectionId || destroyed) return false;
      if (value?.available && value.connectionId !== (readOnly ? null : connectionId)) throw Error('Unverified connection');
      // A live update can overtake a successful GET while it is in flight. The
      // refresh established fresh authority; keep the newer current snapshot.
      // An old pre-request snapshot, changed admission, invalid reply, or failed
      // request cannot satisfy this fence and must not unblock a resume ticket.
      if (!readOnly && value?.available && validContext(value) &&
          admissionKey(value) === capturedAdmission && admissionKey(context) === capturedAdmission &&
          value.snapshotRevision >= startingRevision && context.snapshotRevision > startingRevision &&
          context.snapshotRevision > value.snapshotRevision) return refreshed(true);
      return refreshed(acceptContext(value, {readOnly}));
    } catch { if (sequence === refreshSerial && generation === capturedGeneration && !destroyed) { if (!error || error === REFRESH_ERROR) error = REFRESH_ERROR; emit(); } return false; }
  }
  async function act(action, fields = {}) {
    syncState(); const s = snapshot();
    if (!s.canAct || (operation && action !== 'stop')) return false;
    if (action === 'lock' && !context.canLock || action === 'invite' && !context.canInvite) return false;
    const invitation = action === 'accept' || action === 'decline' ? s.invitations.find(i => i.invitationId === fields.invitationId) : null;
    if ((action === 'accept' || action === 'decline') && (!invitation || invitation.expired)) { notice = 'That invitation has expired.'; emit(); return false; }
    if (action === 'accept' && (preferredIgnore === true || context.ignoreRequests || localStopped && stopUnconfirmed)) return false;
    const captured = context;
    const op = {id:++serial, generation, action, admission:admissionKey(captured)};
    operation = op; error = ''; notice = '';
    if (action === 'accept') { localStopped = false; acceptIntent = {generation, connectionId:captured.connectionId, memberId:captured.memberId, leaderId:invitation.leaderId, leaderMemberId:invitation.leaderMemberId}; }
    const body = {action, operationId:operationId(), connectionId:captured.connectionId, roomId:captured.roomId, memberId:captured.memberId, bubbleId:captured.bubbleId, membershipRevision:captured.membershipRevision, controlRevision:captured.controlRevision, stateRevision:captured.stateRevision, ...fields};
    const sameAdmission = () => !destroyed && generation === op.generation && admissionKey(context) === op.admission;
    const current = () => sameAdmission() && operation?.id === op.id;
    const confirmed = () => op.confirmed === true && sameAdmission();
    emit();
    try {
      const result = await api('/api/proximity-controls/action', {method:'POST', body}); syncState(); if (!current()) return confirmed();
      if (result?.ok !== true || result.state?.connectionId !== captured.connectionId || !validContext(result.state)) throw Error('Unverified acknowledgement');
      acceptContext(result.state);
      if (!current()) return confirmed();
      operation = null;
      if (action === 'stop') { stopUnconfirmed = false; notice = 'Stopped.'; }
      else if (action === 'invite') { localStopped = false; notice = context.outgoingInvitations.length || context.followers.length ? '' : 'No invitations sent. Others may be ignoring invitations.'; }
      else if (action === 'decline') notice = 'Invitation declined.';
      else if (action === 'preferences') notice = context.ignoreRequests ? 'Follow invitations are ignored.' : 'Follow invitations are allowed.';
      emit(); return true;
    } catch (failure) {
      syncState(); if (!current()) return confirmed();
      operation = null;
      if (action === 'accept' && !acceptedLease) acceptIntent = null;
      const conflict = Number(failure?.status) === 409;
      error = action === 'stop' ? 'Stopped on this screen. Server stop is unconfirmed. Retry Stop.' : conflict ? 'Nearby changed before that action completed. Review the updated state and try again.' : 'That action could not be confirmed. Refresh before trying again.';
      emit(); if (conflict) await refresh(); return false;
    }
  }
  function stop() {
    syncState(); localStopped = true; stopUnconfirmed = true; stopRevision = context?.snapshotRevision ?? -1; invalidate(); error = ''; notice = 'Stopping…'; emit();
    if (!snapshot().canAct) { error = 'Stopped on this screen. Server stop is unconfirmed until reconnected.'; emit(); return Promise.resolve(false); }
    return act('stop');
  }
  function followAction() { const s = snapshot(); return s.canStop ? stop() : act('invite'); }
  return {
    syncState, resetConnection, acceptContext, snapshot, refresh, stop, followAction,
    lock(locked) { return typeof locked === 'boolean' ? act('lock', {locked}) : Promise.resolve(false); },
    invite() { return act('invite'); }, accept(invitationId) { return act('accept', {invitationId}); }, decline(invitationId) { return act('decline', {invitationId}); },
    setIgnoreRequests(ignoreRequests) { if (typeof ignoreRequests !== 'boolean') return Promise.resolve(false); syncState(); preferredIgnore = ignoreRequests; try { storage?.setItem('universe:follow-ignore:v1:'+actor, String(ignoreRequests)); } catch { /* Nonfatal storage restriction. */ } emit(); return act('preferences', {ignoreRequests}); },
    onEvent(event) { if (event?.type === 'proximity-controls') { if (context?.connectionId && event.data?.connectionId && event.data.connectionId !== context.connectionId && !retiredConnections.has(event.data.connectionId)) resetConnection(); return acceptContext(event.data); } return false; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    destroy() { destroyed = true; invalidate(); context = null; listeners.clear(); }
  };
}
