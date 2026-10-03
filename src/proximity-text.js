/** Nearby text is live, server-authorized and deliberately held in tab memory only.
 * No history endpoint, durable queue, media-consent gate or optimistic transcript.
 */
const PROTOCOL = 'proximity-text-v1';
const HISTORY_LIMIT = 200;
const authorityKey = value => JSON.stringify([value?.selfId, value?.roomId, value?.connectionEpoch, value?.bubbleId, value?.memberId, value?.membershipRevision]);
const stayKey = value => JSON.stringify([value?.roomId, value?.bubbleId, value?.memberId]);
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(value);
export function validateNearbyText(raw, limits = {}) {
  if (typeof raw !== 'string') return 'Enter a plain-text message.';
  const text = raw.replace(/\r\n?/g, '\n');
  if (!text.trim()) return 'Enter a message first.';
  if ([...text].length > Math.min(limits.maxCodePoints || 2000, 2000)) return 'Use 2,000 characters or fewer.';
  if (new TextEncoder().encode(text).length > Math.min(limits.maxBytes || 8192, 8192)) return 'This message exceeds the 8 KiB text limit.';
  if ((text.isWellFormed && !text.isWellFormed()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return 'Remove unsupported control characters.';
  return '';
}

export function createNearbyText({ api, getState, onChange = () => {}, onMessage = () => {}, requestId = () => crypto.randomUUID(), now = () => Date.now() }) {
  let actor = '', roomId = '', navigating = false, ready = true, available = false, context = null;
  let connection = 'connecting', generation = 0, highestRevision = -1, deferredContext = null;
  let stays = [], activeId = null, selectedId = null, serial = 0, destroyed = false, refreshError = '';
  const notify = () => { if (!destroyed) onChange(); };
  const active = () => stays.find(stay => stay.id === activeId);
  const selected = () => stays.find(stay => stay.id === selectedId);
  function invalidateAttempts() {
    generation++;
    for (const stay of stays) if (stay.operation) {
      stay.operation.status = 'stale';
      stay.error = 'Delivery is unconfirmed. This attempt cannot be retried after the connection or audience changed. Your draft is kept; edit it to start a new message.';
    }
  }
  function endStay() { const stay = active(); if (stay) stay.endedAt = now(); activeId = null; }
  function prune() {
    let count = stays.reduce((sum, stay) => sum + stay.messages.length, 0);
    for (const stay of stays) if (count > HISTORY_LIMIT) { const remove = Math.min(count - HISTORY_LIMIT, stay.messages.length); stay.messages.splice(0, remove); count -= remove; }
    while (stays.length > HISTORY_LIMIT) {
      const index = stays.findIndex(stay => stay.id !== activeId && stay.id !== selectedId);
      if (index < 0) break;
      stays.splice(index, 1);
    }
  }
  function syncState() {
    const state = getState() || {}, nextActor = state.user?.id || '', nextRoom = state.room?.id || '';
    const nextNavigating = !!state.navigating;
    const nextReady = state.ready !== false;
    if (actor !== nextActor) {
      actor = nextActor; roomId = nextRoom; context = null; deferredContext = null; available = false;
      stays = []; activeId = selectedId = null; highestRevision = -1; refreshError = ''; generation++;
      connection = 'connecting'; navigating = nextNavigating; ready = nextReady;
      return;
    }
    if (roomId !== nextRoom) { roomId = nextRoom; invalidateAttempts(); endStay(); context = null; }
    if (navigating !== nextNavigating) { navigating = nextNavigating; if (navigating) invalidateAttempts(); }
    if (ready !== nextReady) { ready = nextReady; if (!ready) invalidateAttempts(); }
    if (!navigating && deferredContext?.roomId === roomId) { const pending = deferredContext; deferredContext = null; acceptContext(pending); }
  }
  function resetConnection(reason = 'connecting') {
    syncState(); invalidateAttempts(); context = null; deferredContext = null; highestRevision = -1;
    connection = reason === 'connecting' ? 'connecting' : 'disconnected'; refreshError = ''; notify();
  }
  function acceptContext(value) {
    syncState();
    if (destroyed || !actor) return false;
    const reject = () => { if (Number.isSafeInteger(value?.contextRevision)) highestRevision = Math.max(highestRevision, value.contextRevision); invalidateAttempts(); context = null; connection = 'unavailable'; notify(); return false; };
    if (value?.protocol !== PROTOCOL || typeof value.canSend !== 'boolean') return reject();
    if (value.available === false && value.canSend === false && value.reason === 'disabled') {
      available = false; invalidateAttempts(); endStay(); context = null; connection = 'disabled'; notify(); return true;
    }
    if (!Number.isSafeInteger(value.contextRevision) || value.contextRevision < 1) return reject();
    if (value.contextRevision < highestRevision) return false;
    if (value.available !== true || value.selfId !== actor || !opaque(value.connectionEpoch) || ![null,'muted','no-active-bubble','authority-unavailable'].includes(value.reason)) return reject();
    if (value.roomId !== roomId && value.reason !== 'authority-unavailable') {
      if (navigating && (!deferredContext || value.contextRevision >= deferredContext.contextRevision)) deferredContext = structuredClone(value);
      highestRevision = value.contextRevision; endStay(); return reject();
    }
    if (value.reason === 'authority-unavailable') {
      if (value.canSend || value.roomId !== null || value.bubbleId !== null || value.memberId !== null || value.membershipRevision !== null || value.recipientCount !== 0 || !Array.isArray(value.conversationRecipients) || value.conversationRecipients.length) return reject();
      highestRevision = value.contextRevision; available = true; invalidateAttempts(); endStay(); context = structuredClone(value); connection = 'connected'; notify(); return true;
    }
    if (!Array.isArray(value.conversationRecipients) || !Number.isSafeInteger(value.recipientCount) || value.recipientCount < 0 || value.recipientCount > 255 || value.recipientCount !== value.conversationRecipients.length || value.conversationRecipients.some(peer => !peer || !opaque(peer.accountId) || !opaque(peer.memberId) || peer.accountId === actor || peer.memberId === value.memberId) || new Set(value.conversationRecipients.map(peer => peer.accountId)).size !== value.recipientCount || new Set(value.conversationRecipients.map(peer => peer.memberId)).size !== value.recipientCount) return reject();
    const admitted = opaque(value.bubbleId) && opaque(value.memberId) && Number.isSafeInteger(value.membershipRevision) && value.membershipRevision >= 1 && value.recipientCount > 0;
    if (value.reason === 'no-active-bubble' ? value.canSend || value.recipientCount !== 0 || value.bubbleId !== null || value.membershipRevision !== null || (value.memberId !== null && !opaque(value.memberId)) : !admitted || value.canSend !== (value.reason === null)) return reject();
    highestRevision = value.contextRevision; available = true; connection = 'connected'; refreshError = '';
    if (context && authorityKey(context) !== authorityKey(value)) invalidateAttempts();
    context = structuredClone(value);
    const hasStay = opaque(value.bubbleId) && opaque(value.memberId) && value.recipientCount > 0;
    if (!hasStay) endStay();
    else if (!active() || active().key !== stayKey(value)) {
      endStay();
      const stay = { id: `nearby-${++serial}`, key: stayKey(value), roomId, roomName: getState().room?.name || 'Room', startedAt: now(), endedAt: null, messages: [], draft: '', unread: 0, operation: null, error: '' };
      stays.push(stay); activeId = stay.id;
      if (!selectedId) selectedId = stay.id;
      prune();
    }
    notify(); return true;
  }
  function messageFits(message, ack = false) {
    if (!context || !ready || navigating || connection !== 'connected' || !active() || message?.roomId !== roomId || message.bubbleId !== context.bubbleId || message.membershipRevision !== context.membershipRevision || !opaque(message.id) || !opaque(message.requestId) || typeof message.text !== 'string' || validateNearbyText(message.text) || !message.author || !opaque(message.author.id) || typeof message.author.name !== 'string' || message.author.name.length > 128 || typeof message.createdAt !== 'number' || !Number.isFinite(message.createdAt) || message.createdAt < 0) return false;
    if (message.recipient?.connectionEpoch !== context.connectionEpoch || message.recipient?.memberId !== context.memberId) return false;
    if (message.author.id === actor) return message.fromMemberId === context.memberId && message.ownAccountCopy === !ack;
    return !ack && message.ownAccountCopy === false && context.conversationRecipients.some(peer => peer.accountId === message.author.id && peer.memberId === message.fromMemberId);
  }
  function addMessage(message, ack = false) {
    if (!messageFits(message, ack)) return false;
    const stay = active();
    if (stays.some(item => item.messages.some(row => row.id === message.id || (row.requestId === message.requestId && row.author.id === message.author.id)))) return false;
    stay.messages.push(structuredClone(message)); prune();
    onMessage({ message, stayId: stay.id, own: message.author.id === actor }); notify(); return true;
  }
  function receive(message) { syncState(); return addMessage(message); }
  function setDraft(value) {
    const stay = selected(); if (!stay || stay.endedAt) return;
    if (stay.operation?.status === 'stale' && value !== stay.draft) { stay.operation = null; stay.error = ''; }
    stay.draft = value; notify();
  }
  function isCurrent(operation, stay) {
    return !destroyed && ready && operation.generation === generation && actor === operation.actor && stay.id === activeId && !navigating && context?.canSend && authorityKey(context) === operation.authority;
  }
  async function send(retry = false) {
    syncState(); const stay = selected();
    if (!ready || !stay || stay.id !== activeId || stay.endedAt || !context?.canSend || navigating || connection !== 'connected') return false;
    let operation = stay.operation;
    if (retry) { if (!operation || operation.status !== 'retry' || !isCurrent(operation, stay)) return false; }
    else {
      if (operation) return false;
      const error = validateNearbyText(stay.draft, context.limits);
      if (error) { stay.error = error; notify(); return false; }
      operation = { generation, actor, authority: authorityKey(context), raw: stay.draft, status: 'sending', body: { requestId: requestId(), text: stay.draft.replace(/\r\n?/g, '\n'), connectionEpoch: context.connectionEpoch, roomId, bubbleId: context.bubbleId, memberId: context.memberId, membershipRevision: context.membershipRevision } };
      stay.operation = operation;
    }
    operation.status = 'sending'; stay.error = ''; notify();
    try {
      const result = await api('/api/proximity-text/messages', { method: 'POST', body: { ...operation.body } });
      syncState();
      if (!isCurrent(operation, stay)) return false;
      const message = result?.message;
      if (!messageFits(message, true) || message.requestId !== operation.body.requestId || message.text !== operation.body.text) throw new Error('The acknowledgement could not be verified.');
      addMessage(message, true);
      if (stay.draft === operation.raw) stay.draft = '';
      stay.operation = null; stay.error = ''; notify(); return true;
    } catch (error) {
      syncState(); if (!isCurrent(operation, stay)) return false;
      const status = Number(error?.status);
      operation.status = [401, 403, 409].includes(status) ? 'stale' : 'retry';
      stay.error = status === 429 ? 'Too many messages at once. Wait a moment, then retry this message.' : status >= 400 && status < 500 ? 'The server rejected this message. Your draft is kept. Refresh Nearby, or edit it before sending again.' : 'Delivery is unconfirmed. Retry this same message to check its receipt without sending it twice. Your draft is kept.';
      notify(); return false;
    }
  }
  async function refresh() {
    syncState(); if (!context?.connectionEpoch || !available) return false;
    const capturedGeneration = generation, epoch = context.connectionEpoch;
    try {
      const result = await api(`/api/proximity-text?connectionEpoch=${encodeURIComponent(epoch)}`);
      syncState(); if (capturedGeneration !== generation) return false;
      return acceptContext(result);
    } catch { if (capturedGeneration === generation) { refreshError = 'Nearby could not refresh. Check your connection and try again.'; notify(); } return false; }
  }
  function snapshot() {
    return { available, context, connection, navigating, ready, stays, activeId, selectedId, selected: selected() || null, refreshError, unread: stays.reduce((sum, stay) => sum + stay.unread, 0) };
  }
  return {
    syncState, resetConnection, acceptContext, receive, setDraft, send, refresh, snapshot,
    select(id) { if (stays.some(stay => stay.id === id)) { selectedId = id; selected().unread = 0; notify(); } },
    markRead(id = selectedId) { const stay = stays.find(item => item.id === id); if (stay?.unread) { stay.unread = 0; notify(); } },
    markUnread(id) { const stay = stays.find(item => item.id === id); if (stay) stay.unread = Math.min(HISTORY_LIMIT, stay.unread + 1); },
    destroy() { destroyed = true; generation++; stays = []; context = null; deferredContext = null; }
  };
}
