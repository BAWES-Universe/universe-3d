/** Live-only Nearby typing metadata. Drafts, text receipts and durable storage never enter this controller. */
const PROTOCOL = 'proximity-typing-v1';
const REFRESH_MS = 2000, IDLE_MS = 10000, EXPIRY_MS = 12000, BLUR_MS = 150;
const MAX_SOURCES = 8192;
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const extensionFits = value => value?.protocol === PROTOCOL && value.enabled === true && value.refreshMs === REFRESH_MS && value.idleMs === IDLE_MS && value.expiryMs === EXPIRY_MS;
const authorityKey = value => JSON.stringify([value.selfId, value.roomId, value.connectionEpoch, value.bubbleId, value.memberId, value.membershipRevision, value.conversationRecipients.map(peer => [peer.accountId, peer.memberId]).sort()]);

/** getNearby returns the validated Nearby text snapshot. getPresence describes only the currently mounted composer. */
export function createNearbyTyping({ api, getNearby, getPresence = () => ({visible: false, focused: false}), onChange = () => {}, monotonicNow = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let context = null, authority = '', epoch = '', sequence = 0, destroyed = false, clockAnchor = null;
  let active = false, lastSent = -Infinity, generation = 0, activityVersion = 0, blurVersion = 0, expiryVersion = 0, idleTimer = null, blurTimer = null, expiryTimer = null;
  // Stopped/expired source revisions remain tombstones until authority changes. Never evict one to admit a stale stream.
  const sources = new Map();
  const cancel = timer => { if (timer !== null) clearTimer(timer); };
  const presence = () => { try { return getPresence() || {}; } catch { return {}; } };
  const notify = () => { if (!destroyed) onChange(); };
  // Only this transport's hello seeds the clock. Typing events must never rebase it:
  // a buffered old event cannot make its own expired lease look fresh.
  function seedClock({serverTime, accountId} = {}) {
    if (destroyed || !timestamp(serverTime) || !opaque(accountId) || context && context.selfId !== accountId || clockAnchor?.accountId === accountId) return false;
    clockAnchor = {serverTime, accountId, localTime: monotonicNow()};
    return true;
  }
  function transmit(isTyping, captured = context) {
    if (!captured || sequence >= Number.MAX_SAFE_INTEGER) return false;
    const body = { connectionEpoch: captured.connectionEpoch, roomId: captured.roomId, bubbleId: captured.bubbleId, memberId: captured.memberId, membershipRevision: captured.membershipRevision, sequence: ++sequence, isTyping };
    try { Promise.resolve(api('/api/proximity-text/typing', {method: 'POST', body})).catch(() => {}); } catch { /* Best effort only: no queue, retry or text receipt. */ }
    return true;
  }
  function stop() {
    activityVersion++; blurVersion++; cancel(idleTimer); cancel(blurTimer); idleTimer = blurTimer = null;
    if (active) { active = false; transmit(false); }
    lastSent = -Infinity;
  }
  function clearRemote() { expiryVersion++; cancel(expiryTimer); expiryTimer = null; sources.clear(); notify(); }
  function sync() {
    if (destroyed) return false;
    let state;
    try { state = getNearby() || {}; } catch { state = {}; }
    const c = state.context;
    if (c?.selfId && clockAnchor && clockAnchor.accountId !== c.selfId) clockAnchor = null;
    const usable = state.available && state.ready !== false && !state.navigating && state.connection === 'connected' && state.activeId && extensionFits(c?.typing) && c?.available === true && opaque(c.selfId) && opaque(c.roomId) && opaque(c.connectionEpoch) && opaque(c.bubbleId) && opaque(c.memberId) && positive(c.membershipRevision) && Array.isArray(c.conversationRecipients) && c.conversationRecipients.length > 0;
    const key = usable ? authorityKey(c) : '';
    if (key !== authority) {
      stop(); generation++; context = null; authority = key; clearRemote();
    }
    context = usable ? c : null;
    if (context && epoch !== context.connectionEpoch) { epoch = context.connectionEpoch; sequence = 0; }
    if (!context?.canSend || state.selectedId !== state.activeId || state.selected?.endedAt || !presence().visible) stop();
    return !!context;
  }
  function canStart() {
    let state;
    try { state = getNearby() || {}; } catch { return false; }
    const view = presence();
    return !!context?.canSend && state.selectedId === state.activeId && !state.selected?.endedAt && view.visible === true && view.focused === true;
  }
  function activity({hasText = false, composing = false} = {}) {
    sync();
    if (!canStart() || (!hasText && !composing)) { stop(); return false; }
    blurVersion++; cancel(blurTimer); blurTimer = null; cancel(idleTimer);
    const version = ++activityVersion, capturedGeneration = generation;
    idleTimer = setTimer(() => { if (version === activityVersion && capturedGeneration === generation) stop(); }, IDLE_MS);
    if (!active || monotonicNow() - lastSent >= REFRESH_MS) {
      if (!transmit(true)) { stop(); return false; }
      active = true; lastSent = monotonicNow();
    }
    return true;
  }
  function focusIn() { blurVersion++; cancel(blurTimer); blurTimer = null; }
  function focusOut() {
    if (destroyed) return;
    cancel(blurTimer);
    const version = ++blurVersion, capturedGeneration = generation;
    blurTimer = setTimer(() => {
      if (version !== blurVersion || capturedGeneration !== generation) return;
      blurTimer = null;
      if (!presence().focused) stop();
    }, BLUR_MS);
  }
  function scheduleExpiry() {
    const version = ++expiryVersion;
    cancel(expiryTimer); expiryTimer = null;
    const deadline = Math.min(...[...sources.values()].filter(source => source.deadline > 0).map(source => source.deadline));
    if (!Number.isFinite(deadline)) return;
    const capturedGeneration = generation;
    expiryTimer = setTimer(() => {
      if (destroyed || capturedGeneration !== generation || version !== expiryVersion) return;
      expiryTimer = null;
      for (const source of sources.values()) if (source.deadline > 0 && source.deadline <= monotonicNow()) source.deadline = 0;
      scheduleExpiry(); notify();
    }, Math.max(0, deadline - monotonicNow()));
  }
  function receive(event) {
    if (!sync()) return false;
    const c = context;
    if (event?.protocol !== PROTOCOL || event.roomId !== c.roomId || event.bubbleId !== c.bubbleId || event.membershipRevision !== c.membershipRevision || event.recipient?.connectionEpoch !== c.connectionEpoch || event.recipient?.memberId !== c.memberId || !opaque(event.sourceId) || !positive(event.revision) || typeof event.isTyping !== 'boolean' || !timestamp(event.serverTime) || !timestamp(event.expiresAt) || !opaque(event.author?.id) || typeof event.author.name !== 'string' || event.author.name.length > 128 || event.author.id === c.selfId || !c.conversationRecipients.some(peer => peer.accountId === event.author.id && peer.memberId === event.fromMemberId)) return false;
    const prior = sources.get(event.sourceId);
    if (prior && (event.revision <= prior.revision || event.author.id !== prior.author.id || event.fromMemberId !== prior.memberId)) return false;
    if (!prior && sources.size >= MAX_SOURCES) return false;
    if (event.isTyping && (event.expiresAt <= event.serverTime || event.expiresAt - event.serverTime > EXPIRY_MS)) return false;
    if (event.isTyping && !clockAnchor) return false;
    const at = monotonicNow();
    const serverNow = clockAnchor ? clockAnchor.serverTime + Math.max(0, at - clockAnchor.localTime) : 0;
    const remaining = event.expiresAt - serverNow;
    const expired = event.isTyping && remaining <= 0;
    const deadline = event.isTyping && !expired ? at + Math.min(remaining, EXPIRY_MS) : 0;
    sources.set(event.sourceId, {revision: event.revision, author: {id: event.author.id, name: event.author.name}, memberId: event.fromMemberId, deadline});
    scheduleExpiry(); notify(); return !expired;
  }
  function snapshot() {
    const authors = new Map();
    for (const source of sources.values()) if (source.deadline > monotonicNow()) authors.set(source.author.id, source.author);
    return {enabled: !!context, active, authors: [...authors.values()]};
  }
  return {
    sync, activity, stop, focusIn, focusOut, receive, snapshot, seedClock,
    reset({preserveClock = false} = {}) { stop(); generation++; context = null; authority = ''; if (!preserveClock) clockAnchor = null; clearRemote(); },
    destroy() { stop(); generation++; destroyed = true; context = null; authority = ''; clockAnchor = null; cancel(expiryTimer); expiryTimer = null; sources.clear(); }
  };
}
