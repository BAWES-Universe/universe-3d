/** Ephemeral avatar expression, deliberately separate from persistent room chat. */
export const SAY_MAX_LENGTH = 100;
export const SAY_DURATION = 5000;
export const DEFAULT_EMOTES = ['👍', '❤️', '😂', '👏', '😍', '🙏'];
export const DEFAULT_PHRASES = ['Hi!', 'Be right back', 'Thanks!', 'Okay!'];
const enc = encodeURIComponent;
const identity = person => person?.id || person?.userId;
const typing = element => /^(INPUT|TEXTAREA|SELECT)$/.test(element?.tagName) || element?.isContentEditable;
const inside = (area, position) => position && Math.abs(position.x - area.x) <= area.width / 2 && Math.abs(position.z - area.z) <= area.depth / 2;

export function expressionMode(state, chosen = 'say') {
  const status = String(state.user?.status || 'online').toLowerCase();
  const silent = (state.scene?.areas || []).some(area => area.action === 'silent' && inside(area, state.position));
  const forced = silent || ['away', 'busy', 'dnd', 'invisible', 'do-not-disturb', 'back-in-moment', 'back-in-a-moment', 'silent'].includes(status);
  return { kind: forced ? 'think' : chosen, forced, reason: silent ? 'Quiet area' : forced ? 'Your availability' : '' };
}

export function createBubbleStore({ now = () => Date.now(), maxBubbles = 48 } = {}) {
  const items = new Map(), seen = new Map();
  function removeUser(userId, kind) { for (const [id, bubble] of items) if (bubble.userId === userId && (!kind || bubble.kind === kind)) items.delete(id); }
  function add(expression, roomId) {
    const userId = expression?.userId || identity(expression?.author);
    if (!expression?.id || !userId || !roomId || expression.roomId !== roomId || !['say', 'think', 'emote'].includes(expression.kind) || typeof expression.text !== 'string' || !expression.text.trim() || seen.has(expression.id)) return false;
    const time = now();
    seen.set(expression.id, time);
    while (seen.size > 500) seen.delete(seen.keys().next().value);
    if (expression.kind === 'say') removeUser(userId, 'think');
    if (expression.kind === 'think' || expression.kind === 'emote') removeUser(userId, expression.kind);
    items.set(expression.id, { ...expression, userId, text: expression.text.slice(0, expression.kind === 'emote' ? 32 : SAY_MAX_LENGTH), drawnAt: time, expiresAt: expression.kind === 'think' ? Infinity : time + (expression.kind === 'emote' ? 3200 : SAY_DURATION) });
    if (expression.kind === 'say') {
      const lines = [...items.values()].filter(item => item.userId === userId && item.kind === 'say');
      while (lines.length > 3) items.delete(lines.shift().id);
    }
    while (items.size > maxBubbles) items.delete(items.keys().next().value);
    return true;
  }
  function reconcile(people, roomId) {
    const present = new Map(people.map(person => [identity(person), person]));
    for (const [id, bubble] of items) {
      const person = present.get(bubble.userId);
      if (bubble.roomId !== roomId || !person || bubble.expiresAt <= now() || bubble.kind === 'think' && (person.moving || bubble.origin && Math.hypot(person.x - bubble.origin.x, person.z - bubble.origin.z) > .05)) items.delete(id);
    }
  }
  return { add, removeUser, reconcile, values: () => [...items.values()], clear() { items.clear(); seen.clear(); } };
}

function el(tag, className, text) { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; }
function button(label, className, action) { const element = el('button', className, label); element.type = 'button'; element.onclick = action; return element; }
function randomId() { return globalThis.crypto?.randomUUID?.() || `expression-${Date.now()}-${Math.random().toString(36).slice(2)}`; }

export function mountExpress({ root, api, getState, project = () => null, beforeSend = async () => {}, onOpenChange = () => {}, onReturnFocus, onEmote = () => {}, toast = () => {}, canOpen = () => true, now = () => Date.now() }) {
  if (!root || typeof api !== 'function' || typeof getState !== 'function') throw new Error('mountExpress needs root, api and getState');
  let opened = false, destroyed = false, mode = 'say', closedAt = -Infinity, scope = '', userId = '', epoch = 0, pending = false, editing = false, focusBefore = null, operation = null, preferenceOwner = null;
  let emotes = [...DEFAULT_EMOTES], phrases = [...DEFAULT_PHRASES], snapshotRequest = 0, liveVersion = 0;
  const actorVersions = new Map();
  const drafts = new Map(), bubbles = createBubbleStore({ now }), rendered = new Map(), lastEmotes = new Map();
  root.classList.add('express-root'); root.hidden = false;
  const layer = el('div', 'express-bubbles'); layer.setAttribute('aria-hidden', 'true');
  const live = el('div', 'express-sr-only'); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); live.setAttribute('aria-atomic', 'true');
  const tray = el('section', 'express-tray'); tray.hidden = true; tray.setAttribute('role', 'dialog'); tray.setAttribute('aria-label', 'Express yourself');
  const header = el('header', 'express-header');
  const title = el('div', 'express-heading'); title.append(el('span', 'express-eyebrow', 'A LITTLE EXPRESSION GOES A LONG WAY'), el('strong', '', 'Make yourself heard'));
  const closeButton = button('×', 'express-close', () => close()); closeButton.setAttribute('aria-label', 'Close Express'); header.append(title, closeButton);
  const modeRow = el('div', 'express-mode-row'); const modes = el('div', 'express-modes'); modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', 'Expression type');
  const sayButton = button('Say', 'express-mode', () => choose('say')); const thinkButton = button('Think', 'express-mode', () => choose('think')); modes.append(sayButton, thinkButton);
  const intent = el('span', 'express-intent'); modeRow.append(modes, intent);
  const form = el('form', 'express-form'); const input = el('input', 'express-input'); input.type = 'text'; input.maxLength = SAY_MAX_LENGTH; input.autocomplete = 'off'; input.setAttribute('enterkeyhint', 'send'); input.setAttribute('aria-label', 'Your expression');
  const sendButton = button('↑', 'express-send', () => send()); sendButton.setAttribute('aria-label', 'Send expression'); sendButton.title = 'Send expression (Enter)'; form.append(input, sendButton);
  const helper = el('div', 'express-helper'); const scopeHint = el('span', 'express-scope'); const remaining = el('span', 'express-remaining'); helper.append(scopeHint, remaining);
  const errorNode = el('div', 'express-error'); errorNode.setAttribute('role', 'alert'); errorNode.hidden = true;
  const emojiRow = el('div', 'express-emotes'); emojiRow.setAttribute('aria-label', 'Favorite expressions');
  const phraseRow = el('div', 'express-phrases'); phraseRow.setAttribute('aria-label', 'Quick phrases');
  const footer = el('div', 'express-footer'); const keyboardHint = el('span', '', 'Enter to say · Ctrl Enter to think');
  const editButton = button('Make it yours', 'express-customize', () => editPreferences()); footer.append(button('👋 Wave', 'express-customize', () => sendEmote('👋')), keyboardHint, editButton);
  const editor = el('form', 'express-preferences'); editor.hidden = true;
  tray.append(header, modeRow, form, helper, errorNode, emojiRow, phraseRow, editor, footer); root.replaceChildren(layer, tray, live);

  function state() { return getState() || {}; }
  function people() {
    const current = state();
    const others = (current.people || []).filter(person => identity(person) !== current.user?.id && (!person.roomId || person.roomId === current.room?.id));
    return current.user ? [...others, { ...current.user, ...current.position, moving: current.moving, id: current.user.id }] : others;
  }
  function loadPreferences() {
    if (preferenceOwner === state().user?.id) return;
    preferenceOwner = state().user?.id; emotes = [...DEFAULT_EMOTES]; phrases = [...DEFAULT_PHRASES];
    try {
      const saved = JSON.parse(localStorage.getItem(`universe:express:v1:${preferenceOwner}`));
      if (saved && Array.isArray(saved.emotes) && saved.emotes.length === 6) emotes = saved.emotes.map((emoji, index) => typeof emoji === 'string' && emoji.trim() && emoji.length <= 32 ? emoji : DEFAULT_EMOTES[index]);
      if (saved && Array.isArray(saved.phrases) && saved.phrases.length === 4) phrases = saved.phrases.map((text, index) => typeof text === 'string' && text.trim() && text.length <= 24 ? text : DEFAULT_PHRASES[index]);
    } catch { /* Preference storage is optional. */ }
    renderSlots();
  }
  function renderSlots() {
    emojiRow.replaceChildren(); phraseRow.replaceChildren();
    emotes.forEach((emoji, index) => {
      const control = button('', 'express-emote', () => playSlot(index)); control.setAttribute('aria-label', `Express ${emoji}`); control.title = `Express ${emoji} · ${index + 1}`;
      control.append(el('span', '', emoji), el('kbd', '', String(index + 1))); control.oncontextmenu = event => { event.preventDefault(); editPreferences(index); };
      let hold; control.onpointerdown = event => { if (event.pointerType === 'touch') hold = setTimeout(() => { hold = null; editPreferences(index); }, 550); };
      const cancelHold = () => { clearTimeout(hold); hold = null; }; control.onpointerup = cancelHold; control.onpointercancel = cancelHold; control.onpointerleave = cancelHold;
      emojiRow.append(control);
    });
    phrases.forEach((phrase, index) => { const control = button(phrase, 'express-phrase', () => send(phrase, 'say')); control.title = phrase; control.oncontextmenu = event => { event.preventDefault(); editPreferences(6 + index); }; phraseRow.append(control); });
  }
  function syncScope() {
    const current = state(), nextUser = current.user?.id || '', nextScope = current.ready !== false && current.room?.id && nextUser ? `${nextUser}:${current.room.id}` : '';
    const changedUser = nextUser !== userId;
    if (changedUser) { drafts.clear(); preferenceOwner = null; userId = nextUser; }
    if (scope !== nextScope) {
      if (!changedUser && scope && input.value) drafts.set(scope, input.value);
      close({ restoreFocus: false, saveDraft: false });
      scope = nextScope; epoch++; pending = false; operation = null; actorVersions.clear(); clearBubbles(); input.value = drafts.get(scope) || ''; editing = false; editor.hidden = true;
      if (scope) refreshThoughts();
    }
    loadPreferences();
    return !!scope;
  }
  function syncComposer() {
    const effective = expressionMode(state(), mode);
    sayButton.setAttribute('aria-pressed', String(effective.kind === 'say')); thinkButton.setAttribute('aria-pressed', String(effective.kind === 'think'));
    sayButton.disabled = effective.forced; sayButton.title = effective.forced ? `${effective.reason} uses visible thought bubbles` : 'A speech bubble for five seconds';
    input.placeholder = effective.kind === 'think' ? 'What’s on your mind?' : 'Say a little something…';
    intent.textContent = effective.forced ? `${effective.reason} · Think only` : effective.kind === 'think' ? 'Visible until you move' : 'In the moment';
    scopeHint.textContent = effective.kind === 'think' ? 'Others can see your thought · not private' : 'Visible in this room · not saved in chat';
    remaining.textContent = `${input.value.length}/${SAY_MAX_LENGTH}`;
    sendButton.disabled = pending || !input.value.trim() || !scope;
    sendButton.classList.toggle('ready', !!input.value.trim()); sendButton.textContent = pending ? '…' : effective.kind === 'think' ? '○' : '↑';
    tray.dataset.mode = effective.kind;
    for (const button of [...emojiRow.children, ...phraseRow.children]) button.disabled = pending;
  }
  function choose(value) { mode = value; syncComposer(); if (matchMedia('(pointer: fine)').matches) input.focus(); }
  function open(value = 'say', { focusInput = false } = {}) {
    if (destroyed || !syncScope() || !canOpen()) return false;
    mode = value === 'think' ? 'think' : 'say';
    if (!opened) { focusBefore = document.activeElement; opened = true; tray.hidden = false; editing = false; editor.hidden = true; onOpenChange(true); }
    syncComposer();
    if (focusInput || matchMedia('(pointer: fine)').matches) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    else closeButton.focus({ preventScroll: true });
    return true;
  }
  function close({ restoreFocus = true, saveDraft = true } = {}) {
    if (!opened) return;
    if (scope && saveDraft) drafts.set(scope, input.value);
    opened = false; tray.hidden = true; closedAt = now(); editing = false; editor.hidden = true; onOpenChange(false);
    if (restoreFocus) { if (onReturnFocus) onReturnFocus(); else if (focusBefore?.isConnected && !focusBefore.closest('[hidden]')) focusBefore.focus({ preventScroll: true }); }
    focusBefore = null;
  }
  function feedback() { try { navigator.vibrate?.(8); } catch { /* No synthetic sound or unsupported media. */ } }
  async function send(text = input.value, requestedMode = mode) {
    if (destroyed || pending || !syncScope()) return false;
    text = text.trim().slice(0, SAY_MAX_LENGTH); if (!text) return false;
    const current = state(), roomId = current.room.id, actorId = current.user.id, capturedScope = scope, capturedEpoch = epoch, sentInput = input.value, kind = expressionMode(current, requestedMode).kind;
    const fingerprint = `${scope}:${kind}:${text}`;
    if (operation?.fingerprint !== fingerprint) operation = { fingerprint, id: randomId() };
    const clientOperationId = operation.id;
    pending = true; errorNode.hidden = true; syncComposer();
    try {
      await beforeSend({ roomId, kind });
      if (destroyed || capturedEpoch !== epoch || capturedScope !== scope || state().user?.id !== actorId || state().room?.id !== roomId || state().ready === false) return false;
      const result = await api(`/api/rooms/${enc(roomId)}/expression`, { method: 'POST', body: { kind, text, clientOperationId } });
      if (destroyed || capturedEpoch !== epoch || capturedScope !== scope || state().user?.id !== actorId || state().room?.id !== roomId || state().ready === false) return true;
      if (result.expression) receive(result.expression);
      if (input.value === sentInput) { input.value = ''; drafts.delete(scope); }
      operation = null; feedback(); close(); return true;
    } catch (error) {
      if (!destroyed && capturedEpoch === epoch && capturedScope === scope) { errorNode.textContent = error?.message || 'Your expression could not send. Try again.'; errorNode.hidden = false; input.focus(); }
      return false;
    } finally { if (capturedEpoch === epoch) { pending = false; syncComposer(); } }
  }
  function playSlot(index) {
    if(index < 0 || index >= emotes.length)return false;return sendEmote(emotes[index]);
  }
  async function sendEmote(emoji) {
    if (destroyed || pending || !syncScope() || editing) return false;
    const current = state(), roomId = current.room.id, actorId = current.user.id, capturedEpoch = epoch;
    pending = true; errorNode.hidden = true; syncComposer();
    try {
      await api(`/api/rooms/${enc(roomId)}/emote`, { method: 'POST', body: { emoji } });
      if (capturedEpoch !== epoch || destroyed || state().user?.id !== actorId || state().room?.id !== roomId || state().ready === false) return true;
      const recent = lastEmotes.get(current.user.id);
      if (!recent || recent.emoji !== emoji || now() - recent.drawnAt > 700) {
        receive({ id: randomId(), roomId, author: current.user, userId: current.user.id, kind: 'emote', text: emoji });
        lastEmotes.set(current.user.id, { emoji, drawnAt: now(), at: recent?.at });
      }
      onEmote(emoji); feedback(); close(); return true;
    } catch (error) { if (capturedEpoch === epoch && !destroyed) { errorNode.textContent = error?.message || 'That expression could not send'; errorNode.hidden = false; toast(errorNode.textContent); } return false; }
    finally { if (capturedEpoch === epoch) { pending = false; syncComposer(); } }
  }
  function receive(expression, { snapshot = false } = {}) {
    if (!syncScope() || expression?.roomId !== state().room?.id) return;
    const authorId = expression.userId || identity(expression.author), author = people().find(person => identity(person) === authorId);
    if (!snapshot) actorVersions.set(authorId, ++liveVersion);
    if (expression.kind === 'think' && author && (author.moving || expression.origin && Math.hypot(author.x - expression.origin.x, author.z - expression.origin.z) > .05)) return;
    if (!author || !bubbles.add({ ...expression, author: { ...expression.author, name: author.name || author.displayName || expression.author?.name }, origin: expression.origin || { x: author.x, z: author.z } }, state().room.id)) return;
    live.textContent = `${author.name || author.displayName || 'Room member'} ${expression.kind === 'think' ? 'thinks' : expression.kind === 'emote' ? 'expresses' : 'says'}: ${expression.text}`;
    draw();
  }
  function clearBubbles() { bubbles.clear(); lastEmotes.clear(); rendered.clear(); layer.replaceChildren(); live.textContent = ''; }
  function clear() { epoch++; snapshotRequest++; pending = false; operation = null; clearBubbles(); if (scope) drafts.delete(scope); input.value = ''; close({ restoreFocus: false }); }
  async function refreshThoughts() {
    if (!scope || destroyed) return;
    const capturedEpoch = epoch, request = ++snapshotRequest, version = liveVersion, roomId = state().room?.id;
    try {
      const result = await api(`/api/rooms/${enc(roomId)}/expressions`);
      if (destroyed || epoch !== capturedEpoch || request !== snapshotRequest || state().room?.id !== roomId || state().ready === false) return;
      // A reconnect snapshot cannot overwrite a newer live thought or movement clear.
      const authoritative = new Set((result.thoughts || []).map(thought => thought.id));
      for (const bubble of bubbles.values()) if (bubble.kind === 'think' && !authoritative.has(bubble.id) && (actorVersions.get(bubble.userId) || 0) <= version) bubbles.removeUser(bubble.userId, 'think');
      for (const thought of result.thoughts || []) if ((actorVersions.get(thought.userId || identity(thought.author)) || 0) <= version) receive(thought, { snapshot: true });
      draw();
    } catch (error) { if (capturedEpoch === epoch && [401, 403].includes(error?.status)) clear(); }
  }
  function onEvent(event) {
    if (destroyed || !event) return;
    let data = event.data ?? {}; if (typeof data === 'string') try { data = JSON.parse(data); } catch { return; }
    syncScope();
    if (event.type === 'expression') { if (data.roomId === state().room?.id) { const expression = data.expression || data; actorVersions.set(expression.userId || identity(expression.author), ++liveVersion); receive(expression); } }
    else if (event.type === 'expression-clear' && data.roomId === state().room?.id) { actorVersions.set(data.userId, ++liveVersion); bubbles.removeUser(data.userId, data.kind || 'think'); draw(); }
    else if (event.type === 'hello') refreshThoughts();
    else if (event.type === 'access-revoked' && (!data.roomId || data.roomId === state().room?.id) || event.type === 'moderation' && data.roomId === state().room?.id && (data.userId === state().user?.id || data.action === 'deleted') && ['kick', 'ban', 'deleted'].includes(data.action)) clear();
    else if (event.type === 'presence' && data.roomId === state().room?.id) {
      for (const person of data.presence || []) {
        const id = identity(person), previous = lastEmotes.get(id);
        if (!id) continue;
        if (person.emote && (!previous || person.emoteAt && person.emoteAt !== previous.at || person.emote !== previous.emoji) && (!person.emoteAt || now() - person.emoteAt < 5000)) {
          if (!(previous?.emoji === person.emote && now() - previous.drawnAt < 700)) receive({ id: `emote:${id}:${person.emoteAt || now()}`, roomId: data.roomId, author: person, kind: 'emote', text: person.emote });
          lastEmotes.set(id, { emoji: person.emote, at: person.emoteAt, drawnAt: now() });
        } else if (!person.emote) lastEmotes.set(id, { emoji: null, at: person.emoteAt, drawnAt: previous?.drawnAt || 0 });
      }
      update();
    }
  }
  function draw() {
    const list = bubbles.values(), ids = new Set(list.map(item => item.id));
    for (const [id, node] of rendered) if (!ids.has(id)) { node.remove(); rendered.delete(id); }
    const actualPeople = new Map(people().map(person => [identity(person), person]));
    const offsets = new Map();
    for (const bubble of [...list].reverse()) {
      let node = rendered.get(bubble.id);
      if (!node) {
        node = el('div', `express-bubble express-bubble-${bubble.kind}`); node.dataset.expressionId = bubble.id; node.dataset.userId = bubble.userId;
        const content = el('div', 'express-bubble-card');
        if (bubble.kind !== 'emote') content.append(el('span', 'express-bubble-name', `${bubble.author?.name || 'Room member'}${bubble.kind === 'think' ? ' · thinking' : ''}`));
        content.append(el('span', 'express-bubble-text', bubble.text)); node.append(content);
        if (bubble.kind === 'think') node.append(el('span', 'express-thought-tail'));
        node.classList.toggle('express-self', bubble.userId === state().user?.id); rendered.set(bubble.id, node); layer.append(node);
      }
      const person = actualPeople.get(bubble.userId), point = person && project({ ...person, y: 2.6 }, bubble);
      const visible = point && point.visible !== false && Number.isFinite(point.x) && Number.isFinite(point.y);
      node.hidden = !visible; if (!visible) continue;
      const offset = offsets.get(bubble.userId) || 0;
      // Coordinates stay attached to the real avatar during orbit, pan and follow.
      const width = root.clientWidth || window.innerWidth, half = Math.min(node.offsetWidth / 2, width / 2 - 12);
      const x = Math.max(half + 8, Math.min(width - half - 8, point.x));
      node.style.left = `${x}px`; node.style.top = `${point.y - offset}px`; node.style.setProperty('--tail-x', `${Math.max(12, Math.min(node.offsetWidth - 12, node.offsetWidth / 2 + point.x - x))}px`);
      node.classList.toggle('express-expiring', bubble.expiresAt - now() < 650);
      offsets.set(bubble.userId, offset + node.offsetHeight + 9);
    }
  }
  function update() { if (destroyed) return; syncScope(); bubbles.reconcile(people(), state().room?.id); draw(); if (opened) syncComposer(); }
  function editPreferences(focusIndex = 0) {
    if (pending || editing) return;
    editing = true; editor.hidden = false; editor.replaceChildren();
    const heading = el('strong', '', 'Your six reactions & four quick phrases');
    const grid = el('div', 'express-edit-emotes');
    const emojiInputs = emotes.map((emoji, index) => { const field = el('input'); field.value = emoji; field.maxLength = 32; field.setAttribute('aria-label', `Favorite emote ${index + 1}`); grid.append(field); return field; });
    const phraseInputs = phrases.map((phrase, index) => { const field = el('input'); field.value = phrase; field.maxLength = 24; field.placeholder = DEFAULT_PHRASES[index]; field.setAttribute('aria-label', `Quick phrase ${index + 1}`); return field; });
    const note = el('small', '', 'Saved on this browser. Leave a slot empty to reset it.');
    const actions = el('div', 'express-edit-actions'); const cancel = button('Cancel', '', () => finishEditing()); const save = button('Save favorites', 'express-save-preferences', () => savePreferences()); actions.append(cancel, save);
    editor.append(heading, grid, ...phraseInputs, note, actions);
    function savePreferences() {
      emotes = emojiInputs.map((field, index) => field.value.trim().slice(0, 32) || DEFAULT_EMOTES[index]);
      phrases = phraseInputs.map((field, index) => field.value.trim().slice(0, 24) || DEFAULT_PHRASES[index]);
      try { localStorage.setItem(`universe:express:v1:${state().user.id}`, JSON.stringify({ emotes, phrases })); } catch { toast('Favorites will last for this visit; browser storage is unavailable'); }
      renderSlots(); finishEditing();
    }
    editor.onsubmit = event => { event.preventDefault(); savePreferences(); };
    [...emojiInputs, ...phraseInputs][focusIndex]?.focus();
  }
  function finishEditing() { editing = false; editor.hidden = true; editButton.focus(); }
  function handleKey(event) {
    if (destroyed || event.defaultPrevented || event.isComposing || event.keyCode === 229) return false;
    if (opened && event.type !== 'keyup') {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); editing ? finishEditing() : close(); return true; }
      // Tab-focused controls own their native Enter/Space activation. Only typing
      // away from a control is redirected into the composer.
      if (['Enter', ' '].includes(event.key) && event.target?.closest?.('button,a[href],[role="button"],summary')) return false;
      if (!editing && event.key === 'Enter' && (event.target === input || !typing(event.target))) { event.preventDefault(); event.stopPropagation(); if (input.value.trim()) send(); else close(); return true; }
      if (!editing && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && !typing(document.activeElement)) {
        event.preventDefault(); event.stopPropagation(); input.value = (input.value + event.key).slice(0, SAY_MAX_LENGTH); input.focus(); syncComposer(); return true;
      }
    }
    if (!opened && event.type === 'keyup' && event.key === 'Enter' && !event.metaKey && !event.altKey && !typing(event.target) && now() - closedAt >= 500 && canOpen()) {
      if (!open(event.ctrlKey ? 'think' : 'say', { focusInput: true })) return false;
      event.preventDefault(); event.stopPropagation(); return true;
    }
    return false;
  }
  input.oninput = () => { if (scope) drafts.set(scope, input.value); syncComposer(); };
  form.onsubmit = event => { event.preventDefault(); send(); };
  const stopKeys = event => { handleKey(event); event.stopPropagation(); };
  tray.addEventListener('keydown', stopKeys); tray.addEventListener('keyup', stopKeys); tray.addEventListener('pointerdown', event => event.stopPropagation());
  let swipe;
  tray.addEventListener('touchstart', event => { if (!event.target.closest('input')) swipe = { x: event.touches[0].clientX, y: event.touches[0].clientY }; }, { passive: true });
  tray.addEventListener('touchend', event => { if (!swipe) return; const touch = event.changedTouches[0]; if (touch.clientY - swipe.y > 56 && Math.abs(touch.clientX - swipe.x) < touch.clientY - swipe.y) close(); swipe = null; }, { passive: true });
  function destroy() { close({ restoreFocus: false }); destroyed = true; clearBubbles(); root.replaceChildren(); root.classList.remove('express-root'); }
  syncScope(); syncComposer();
  return { open, close, toggle: options => opened ? close() : open('say', options), isOpen: () => opened, handleKey, playSlot, send, onEvent, update, clear, refresh: refreshThoughts, destroy };
}
