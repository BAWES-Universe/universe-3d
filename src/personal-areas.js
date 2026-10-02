import './personal-areas.css';

const enc = encodeURIComponent;
const operationId = () => globalThis.crypto?.randomUUID?.() || `personal-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
const inside = (area, position) => !!position && [position.x, position.z, area.x, area.z, area.width, area.depth].every(Number.isFinite) && Math.abs(position.x - area.x) <= area.width / 2 && Math.abs(position.z - area.z) <= area.depth / 2;
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function closeIcon() { const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); const path = document.createElementNS(icon.namespaceURI, 'path'); path.setAttribute('d', 'm6 6 12 12M18 6 6 18'); icon.append(path); return icon; }

/** Authority-only personal-area controls. onRoom must update permission metadata
 * without discarding an editor draft. beforeOperation may return false/throw to
 * keep a pending save or draft intact, and should report fresh presence for claims.
 * Ambiguous retries reuse their exact payload; successful receipts never grant rights.
 */
export function mountPersonalAreas({ root, getState, api, onRoom = () => {}, onBuild = () => {}, onDesk = () => {}, onRegister = () => {}, onOpenChange = () => {}, beforeOperation = () => true, toast = () => {} }) {
  if (!root || !getState || !api) throw new Error('mountPersonalAreas needs root, getState and api');
  root.classList.add('personal-areas-root');
  const invitation = el('aside', 'personal-area-invitation'); invitation.setAttribute('aria-label', 'Personal area invitation');
  const shade = el('div', 'personal-area-shade'), sheet = el('section', 'personal-area-sheet');
  sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', 'Personal areas'); sheet.tabIndex = -1;
  shade.append(sheet); root.append(invitation, shade);
  let opened = false, suppressed = false, opener = null, lastOutsideFocus = document.activeElement, selectedId = null, identity = '', epoch = 0, busy = false, loading = false, blocked = false;
  let error = '', info = '', infoRevision = null, confirm = null, retry = null, query = '', accounts = [], selectedAccount = null, searching = false, searchError = '', searchEpoch = 0, searchTimer;
  let renderKey = '', quietKey = '', refreshEpoch = 0;
  const dismissed = new Set();
  const state = () => getState() || {};
  const room = () => state().room;
  const areas = () => Array.isArray(room()?.personalAreas) ? room().personalAreas : [];
  const areaById = id => areas().find(a => a.areaId === id);
  const activeArea = () => areaById(selectedId);
  const contextId = () => `${state().user?.id || ''}:${room()?.id || ''}`;
  const active = token => token === epoch && identity === contextId();
  const endpoint = (roomId, areaId, action) => `/api/rooms/${enc(roomId)}/personal-areas${areaId ? `/${enc(areaId)}` : ''}${action ? `/${action}` : ''}`;
  const entryKey = area => `${identity}:${area.areaId}:${area.revision}`;
  const eligible = area => !!state().user?.account && !!area?.canClaim && !area.ownerId && area.mode === 'dynamic' && inside(area, state().position);
  const quiet = () => suppressed || state().ready === false || !state().user || !room() || document.hidden || typing();
  function button(label, key, action, kind = '', disabled = false) {
    const b = el('button', `personal-area-button${kind ? ` personal-area-${kind}` : ''}`, label); b.type = 'button'; b.dataset.personalKey = key;
    b.disabled = disabled || (busy && !['close', 'back'].includes(key)); b.onclick = action; return b;
  }
  const paragraph = text => el('p', 'personal-area-copy', text);
  const actions = (...children) => { const node = el('div', 'personal-area-actions'); node.append(...children); return node; };
  function snapshotFocus() { const a = document.activeElement; return sheet.contains(a) ? { key: a.dataset.personalKey, start: a.selectionStart, end: a.selectionEnd } : null; }
  function focusKey(key) { const target = [...sheet.querySelectorAll('[data-personal-key]')].find(n => n.dataset.personalKey === key); target?.focus({ preventScroll: true }); return target; }
  function restoreFocus(snapshot) { if (!snapshot) return; const node = focusKey(snapshot.key); if (node && snapshot.start != null && node.setSelectionRange) node.setSelectionRange(snapshot.start, snapshot.end); else if (!node && opened) focusKey('close'); }
  function resetSearch() { clearTimeout(searchTimer); searchEpoch++; query = ''; accounts = []; selectedAccount = null; searching = false; searchError = ''; }
  function clear() {
    close(); epoch++; refreshEpoch++; identity = contextId(); selectedId = null; busy = loading = blocked = false; error = info = ''; confirm = retry = null; dismissed.clear(); resetSearch(); renderKey = quietKey = ''; render();
  }
  function syncIdentity() {
    if (identity === contextId()) return;
    clear();
  }
  function applyRoom(projection, token) {
    if (!active(token) || !projection || projection.id !== room()?.id) return false;
    // SSE can arrive before a delayed request. Never roll its authority back.
    if (Number.isFinite(projection.revision) && Number.isFinite(room()?.revision) && projection.revision < room().revision) return false;
    onRoom(projection); return true;
  }
  async function refresh() {
    const token = epoch, request = ++refreshEpoch, roomId = room()?.id; if (!roomId || !state().user) return;
    loading = true; render();
    try { const result = await api(endpoint(roomId)); if (!active(token) || request !== refreshEpoch) return; applyRoom(result.room, token); blocked = false; }
    catch (e) { if (!active(token) || request !== refreshEpoch) return; blocked = [401, 403, 404].includes(e.status); error = e.message || 'The current personal areas could not be loaded. Try again.'; }
    finally { if (active(token) && request === refreshEpoch) { loading = false; update(); render(); } }
  }
  function open(areaId) {
    syncIdentity(); if (!state().user || !room()) { toast('Enter a room to view its personal areas'); return false; }
    if (areaId !== undefined && areaId !== selectedId) { selectedId = areaId || null; confirm = null; resetSearch(); error = info = ''; }
    if (!opened) { opener = document.activeElement; opened = true; onOpenChange(true); }
    if (activeArea()) dismissed.add(entryKey(activeArea()));
    render(); focusKey('close'); refresh(); return true;
  }
  function close() {
    if (!opened) return; opened = false; confirm = null; searchEpoch++; searching = false; clearTimeout(searchTimer); render(); onOpenChange(false);
    const target = opener?.isConnected && !opener.closest('[hidden]') ? opener : lastOutsideFocus;
    if (target?.isConnected && !target.closest('[hidden]')) target.focus({ preventScroll: true });
  }
  function back() {
    if (confirm) { confirm = null; error = ''; render(); focusKey('close'); return; }
    if (selectedId) { selectedId = null; resetSearch(); error = info = ''; render(); focusKey('close'); return; }
    close();
  }
  function select(id) { selectedId = id; confirm = null; resetSearch(); error = info = ''; render(); focusKey('close'); }
  function showStatus(text, isError = false) { if (isError) { error = text; info = ''; } else { info = text; infoRevision = room()?.revision; error = ''; } render(); }
  function allowed(action, area) {
    if (blocked || !area || !state().user) return false;
    if (action === 'claim' || action === 'decline') return eligible(area);
    return !!area.canManage && (action === 'revoke' ? !!area.ownerId : area.mode === 'static' && !area.ownerId);
  }
  function newOperation(action, area, extra = {}) { return { action, areaId: area.areaId, roomId: room().id, token: epoch, body: { revision: area.revision, clientOperationId: operationId(), ...extra } }; }
  async function execute(operation, isRetry = false) {
    if (busy || !active(operation.token)) return;
    const current = areaById(operation.areaId);
    // Exact receipt retries are allowed even when the current grant changed.
    if (!isRetry && (!allowed(operation.action, current) || current.revision !== operation.body.revision)) { showStatus('This area changed. Review its current owner and permissions before trying again.', true); return; }
    busy = true; error = info = ''; render(); let sent = false;
    try {
      const permitted = await beforeOperation({ action: operation.action, roomId: operation.roomId, areaId: operation.areaId, retry: isRetry });
      if (!active(operation.token)) return;
      if (permitted === false) { showStatus('Finish or resolve the pending room save before changing ownership. Your draft is kept.', true); return; }
      const fresh = areaById(operation.areaId);
      if (!isRetry && (!allowed(operation.action, fresh) || fresh.revision !== operation.body.revision || (operation.body.roomRevision !== undefined && room()?.revision !== operation.body.roomRevision))) { confirm = null; showStatus('The room changed while preparing this request. Review it and confirm again.', true); return; }
      sent = true;
      const result = await api(endpoint(operation.roomId, operation.areaId, operation.action), { method: 'POST', body: operation.body });
      if (!active(operation.token)) return;
      retry = null; confirm = null; blocked = false; applyRoom(result.room, operation.token);
      const latest = areaById(operation.areaId);
      if (operation.action === 'decline') { if (latest) dismissed.add(entryKey(latest)); info = 'Invitation dismissed. You can review this area again from Personal areas.'; }
      else if (result.duplicate) info = latest?.isOwner ? 'Request recovered. You currently own this area.' : `Request recovered. ${latest?.ownerId ? `The current owner is ${latest.owner?.name || 'another account'}.` : 'This area is currently unclaimed.'}`;
      else if (operation.action === 'claim') info = latest?.isOwner ? 'This personal area is yours. You can build inside its boundaries.' : 'The room has changed. The current ownership is shown below.';
      else if (operation.action === 'assign') info = latest?.ownerId === operation.body.userId ? 'Owner assigned. Their build access is limited to this area.' : 'The room has changed. The current ownership is shown below.';
      else info = latest?.ownerId ? 'The room has changed. Review the current owner.' : operation.body.objectHandling === 'keep' ? 'Ownership revoked. All objects were kept.' : 'Ownership revoked. Only this ownership grant’s items still inside the area were removed.';
      infoRevision = room()?.revision; if (!opened) toast(info); resetSearch();
    } catch (e) {
      if (!active(operation.token)) return;
      const data = e.data || {}, code = data.code || e.code;
      applyRoom(data.room, operation.token);
      if (sent && code === 'PERSONAL_AREA_TRANSFER_REQUIRED') {
        const target = areaById(operation.areaId);
        retry = null;
        if (allowed('claim', target) && target.revision === operation.body.revision && data.room?.revision === room()?.revision) {
          confirm = { type: 'transfer', areaId: target.areaId, revision: target.revision, roomRevision: room().revision, operation, ownedAreas: areas().filter(a => a.isOwner && a.areaId !== target.areaId) };
          selectedId = target.areaId;
          error = ''; render(); if (opened) focusKey('cancel'); else toast('Claiming this area needs confirmation. Open Personal areas to review the transfer.');
        } else error = 'This room changed before the transfer could be reviewed. Please try claiming again.';
      } else {
        const uncertain = sent && (!e.status || e.status >= 500);
        retry = uncertain ? operation : null; confirm = null;
        error = uncertain ? 'The response was interrupted. The request may have completed. Retry the same request to safely check its result.' : e.message || 'The change could not be saved. Review the current area and try again.';
        if (sent && !data.room) {
          // Refresh permission state after a rejection or lost response, without
          // changing the saved operation body or inferring a historical grant.
          try { const result = await api(endpoint(operation.roomId)); if (active(operation.token)) { applyRoom(result.room, operation.token); blocked = false; } }
          catch (refreshError) { if (active(operation.token) && [401, 403, 404].includes(refreshError.status)) blocked = true; }
        }
      }
    } finally { if (active(operation.token)) { busy = false; update(); render(); if (opened && confirm?.type === 'transfer') focusKey('cancel'); if (!opened && error) toast(error); } }
  }
  function start(action, id, extra) { const area = areaById(id); if (!area || busy || retry) return; execute(newOperation(action, area, extra)); }
  function revoke(area) { confirm = { type: 'revoke', areaId: area.areaId, revision: area.revision, roomRevision: room().revision, ownerId: area.ownerId }; error = info = ''; render(); focusKey('cancel'); }
  async function searchAccounts() {
    const term = query.trim(), token = epoch, request = ++searchEpoch, area = activeArea(), areaId = selectedId;
    accounts = []; selectedAccount = null; searchError = '';
    if (term.length < 2 || term.length > 80 || !allowed('assign', area)) { searching = false; render(); return; }
    searching = true; render();
    try { const result = await api(`${endpoint(room().id)}/accounts?query=${enc(term)}`); if (!active(token) || request !== searchEpoch || areaId !== selectedId || !allowed('assign', activeArea())) return; accounts = result.users || []; }
    catch (e) { if (active(token) && request === searchEpoch) searchError = e.message || 'Account search failed. Try again.'; }
    finally { if (active(token) && request === searchEpoch) { searching = false; render(); } }
  }
  function renderSearch(area) {
    const form = el('form', 'personal-area-search'), label = el('label', 'personal-area-field', 'Find a registered account');
    const input = el('input'); input.type = 'search'; input.maxLength = 80; input.value = query; input.placeholder = 'Name or username'; input.setAttribute('aria-label', 'Name or username'); input.autocomplete = 'off'; input.dataset.personalKey = 'account-query'; input.disabled = busy || !!retry;
    input.oninput = () => { query = input.value; selectedAccount = null; accounts = []; searchError = ''; searchEpoch++; clearTimeout(searchTimer); searching = query.trim().length >= 2; searchTimer = setTimeout(searchAccounts, 220); render(); };
    label.append(input); form.append(label, paragraph('Search includes registered accounts already in this room or world. This local service has no email directory.'));
    form.onsubmit = e => { e.preventDefault(); clearTimeout(searchTimer); searchAccounts(); };
    form.append(button('Search accounts', 'search', () => { clearTimeout(searchTimer); searchAccounts(); }, '', query.trim().length < 2 || searching || !!retry));
    const results = el('div', 'personal-area-account-results'); results.setAttribute('aria-live', 'polite');
    if (searching) results.append(paragraph('Searching accounts…'));
    else if (searchError) { const p = paragraph(searchError); p.setAttribute('role', 'alert'); results.append(p); }
    else if (query.trim().length >= 2 && !accounts.length) results.append(paragraph('No matching accounts. Choose someone already admitted to this room or world.'));
    for (const account of accounts) { const b = button(`${account.name} · @${account.username}`, `account-${account.id}`, () => { selectedAccount = account; render(); }, '', !!retry); b.setAttribute('aria-pressed', String(selectedAccount?.id === account.id)); results.append(b); }
    form.append(results);
    if (selectedAccount) form.append(paragraph(`Assign this area to ${selectedAccount.name} (@${selectedAccount.username})?`), button('Assign owner', 'assign', () => start('assign', area.areaId, { userId: selectedAccount.id }), 'primary', !!retry));
    sheet.append(form);
  }
  function renderConfirmation(area) {
    if (confirm.type === 'transfer') {
      sheet.append(el('h2', '', 'Move your personal space?'), paragraph('Claiming this area releases your other personal areas in this room. All objects in those areas stay. Your areas in other rooms are unchanged.'));
      const list = el('ul', 'personal-area-copy'); for (const a of confirm.ownedAreas) list.append(el('li', '', a.name)); sheet.append(list);
      sheet.append(actions(button('Cancel', 'cancel', () => { confirm = null; render(); focusKey('claim'); }), button('Release these areas and claim', 'confirm-transfer', () => { const c = confirm; execute({ ...c.operation, body: { ...c.operation.body, confirmedTransfer: true, roomRevision: c.roomRevision } }); }, 'primary')));
    } else {
      sheet.append(el('h2', '', 'Revoke this owner?'), paragraph(`${area.owner?.name || 'The current owner'} will lose object-editing rights for this area. Choose what happens to the objects.`), paragraph(`${area.objectCount || 0} objects are inside this area. ${area.ownedObjectCount || 0} belong to the current owner’s active ownership grant. Other creators’ objects, previous owners’ objects, and preexisting furniture stay.`));
      sheet.append(actions(button('Keep all objects', 'revoke-keep', () => start('revoke', area.areaId, { roomRevision: confirm.roomRevision, objectHandling: 'keep' })), button("Remove current owner's items", 'revoke-remove', () => start('revoke', area.areaId, { roomRevision: confirm.roomRevision, objectHandling: 'remove-owned' }), 'danger'), button('Cancel', 'cancel', () => { confirm = null; render(); focusKey('revoke'); })));
    }
  }
  function renderDetail(area) {
    sheet.append(el('h2', 'personal-area-name', area.name), el('span', 'personal-area-badge', area.mode === 'static' ? 'Manager-assigned area' : 'Claimable area'));
    if (area.ownerId) {
      sheet.append(paragraph(area.isOwner ? 'You own this personal area.' : `Owner: ${area.owner?.name || 'Registered account'}${area.owner?.username ? ` (@${area.owner.username})` : ''}`));
      if (area.isOwner && area.canEditObjects) sheet.append(paragraph('You can place and edit objects fully inside your area. Ownership does not grant room settings or membership access.'), actions(button('Build in my area', 'build', () => { if (!activeArea()?.isOwner || !activeArea()?.canEditObjects) return; close(); onBuild(area.areaId); }, 'primary', !!retry), button('Go to my desk', 'desk', () => { close(); onDesk({ roomId: room().id }); })));
      if (area.canManage) sheet.append(button('Revoke owner', 'revoke', () => revoke(area), '', !!retry));
      else if (!area.isOwner) sheet.append(paragraph('Only a room manager can change this owner.'));
    } else if (area.mode === 'static') {
      sheet.append(paragraph('This area is unassigned. A room manager chooses its owner.'));
      if (area.canManage) renderSearch(area);
      else if (!state().user?.account) sheet.append(paragraph('Create an account or sign in before a manager can assign this area to you.'), button('Register or sign in', 'register', () => { close(); onRegister(); }, 'primary'));
    } else if (!state().user?.account) {
      sheet.append(paragraph('Create an account or sign in before claiming a personal area. Signing in does not itself assign this area.'), button('Register or sign in', 'register', () => { close(); onRegister(); }, 'primary'));
    } else if (!area.canClaim) sheet.append(paragraph(area.allowedTags?.length ? 'You do not currently have an allowed tag in this world. A room manager can review your eligibility.' : 'This area is not currently available for you to claim.'));
    else if (!inside(area, state().position)) sheet.append(paragraph('Walk into this area to claim or decline it.'));
    else {
      if (area.declined) sheet.append(paragraph('You previously declined this invitation. You can still claim it here.'));
      sheet.append(paragraph('Make this your personal space? You will be able to build inside its boundaries.'), actions(button('Claim area', 'claim', () => start('claim', area.areaId), 'primary', !!retry), button('Not now', 'decline', () => start('decline', area.areaId), '', !!retry)));
    }
  }
  function render() {
    const focus = snapshotFocus(); shade.hidden = !opened;
    if (opened) {
      sheet.replaceChildren(); const header = el('header', 'personal-area-header'), title = el('div'); title.append(el('span', 'personal-area-eyebrow', 'CURRENT ROOM'), el('h1', '', 'Personal areas'));
      const closeButton = button('', 'close', close); closeButton.classList.add('personal-area-close'); closeButton.setAttribute('aria-label', 'Close personal areas'); closeButton.append(closeIcon()); header.append(title, closeButton); sheet.append(header);
      sheet.append(paragraph(room()?.name || 'Current room'));
      if (selectedId || confirm) sheet.append(button(confirm ? 'Back to area' : 'All personal areas', 'back', back));
      if (error) { const p = el('p', 'personal-area-error', error); p.setAttribute('role', 'alert'); sheet.append(p); }
      if (info) { const p = el('p', 'personal-area-status', info); p.setAttribute('role', 'status'); sheet.append(p); }
      if (busy || loading) { const p = paragraph(busy ? 'Saving change…' : 'Checking current room…'); p.setAttribute('role', 'status'); sheet.append(p); }
      if (retry) sheet.append(paragraph('A previous request still needs its receipt checked. No new ownership change will be sent until it is resolved.'), button('Retry same request', 'retry', () => execute(retry, true), 'primary'));
      if (blocked) sheet.append(paragraph('This room is no longer available with your current access.'), button('Refresh access', 'refresh', refresh));
      else if (selectedId) { const area = activeArea(); if (!area) sheet.append(paragraph('This personal area is no longer available.')); else if (confirm) renderConfirmation(area); else renderDetail(area); }
      else {
        if (!areas().length) sheet.append(paragraph('There are no personal areas in this room yet.'));
        if (areas().some(a => a.isOwner)) sheet.append(button('Go to my desk', 'desk', () => { close(); onDesk({ roomId: room().id }); }));
        const list = el('div', 'personal-area-list');
        for (const area of areas()) { const card = button('', `area-${area.areaId}`, () => select(area.areaId), 'card'); card.append(el('strong', '', area.name), el('span', 'personal-area-copy', area.isOwner ? 'Your personal area' : area.ownerId ? `Owned by ${area.owner?.name || 'another account'}` : area.mode === 'static' ? 'Awaiting manager assignment' : area.canClaim ? 'Available to claim inside the area' : 'Unclaimed personal area')); list.append(card); }
        sheet.append(list);
      }
      restoreFocus(focus);
    }
    renderInvitation();
  }
  function renderInvitation() {
    const candidate = areas().find(a => !a.ownerId && a.mode === 'dynamic' && !a.declined && !dismissed.has(entryKey(a)) && inside(a, state().position) && (eligible(a) || !state().user?.account));
    invitation.hidden = opened || quiet() || busy || !!retry || blocked || !candidate;
    const signature = `${candidate ? entryKey(candidate) : ''}:${!!state().user?.account}:${busy}`; if (quietKey === signature) return; quietKey = signature;
    invitation.replaceChildren(); if (!candidate) return;
    invitation.append(el('strong', '', candidate.name), paragraph(state().user?.account ? 'This is a personal area. Want to make it yours?' : 'Sign in or register to check whether you can claim this personal space.'));
    if (state().user?.account) invitation.append(actions(button('Claim area', 'invite-claim', () => open(candidate.areaId), 'primary'), button('Not now', 'invite-decline', () => { selectedId = candidate.areaId; start('decline', candidate.areaId); })));
    else invitation.append(actions(button('Register or sign in', 'invite-register', () => { dismissed.add(entryKey(candidate)); renderInvitation(); onRegister(); }, 'primary'), button('Not now', 'invite-dismiss', () => { dismissed.add(entryKey(candidate)); renderInvitation(); })));
  }
  function update({ suppressed: nextSuppressed = suppressed } = {}) {
    syncIdentity(); suppressed = nextSuppressed;
    if (info && infoRevision !== room()?.revision) info = '';
    if (confirm) { const a = areaById(confirm.areaId); if (!a || a.revision !== confirm.revision || room()?.revision !== confirm.roomRevision || (confirm.type === 'revoke' ? !allowed('revoke', a) || a.ownerId !== confirm.ownerId : !allowed('claim', a))) { confirm = null; error = 'The room or ownership changed. Review the current information before confirming again.'; } }
    const signature = JSON.stringify([identity, room()?.revision, areas(), areas().map(a => inside(a, state().position)), !!state().user?.account, selectedId, !!confirm, error, blocked]);
    if (signature !== renderKey) { renderKey = signature; render(); } else renderInvitation();
  }
  function keydown(e) {
    if (!opened) return;
    if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopImmediatePropagation(); if (confirm) back(); else close(); return; }
    if (e.key !== 'Tab') return;
    const nodes = [...sheet.querySelectorAll('button:not(:disabled),input:not(:disabled),[tabindex="0"]')].filter(n => !n.closest('[hidden]'));
    const first = nodes[0], last = nodes.at(-1);
    if (!first) { e.preventDefault(); sheet.focus(); return; }
    if (e.shiftKey && (document.activeElement === first || !sheet.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !sheet.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  }
  function containFocus(e) { if (opened && !sheet.contains(e.target)) focusKey('close'); else if (!opened && !root.contains(e.target)) lastOutsideFocus = e.target; }
  document.addEventListener('keydown', keydown, true); document.addEventListener('focusin', containFocus);
  // Surface-local key handling never binds Enter globally or steals a text input.
  shade.addEventListener('click', e => { if (e.target === shade) close(); });
  identity = contextId(); update();
  return { open, restore: () => open(), close, back, isOpen: () => opened, update, clear, refresh,
    destroy() { close(); epoch++; refreshEpoch++; clearTimeout(searchTimer); document.removeEventListener('keydown', keydown, true); document.removeEventListener('focusin', containFocus); root.replaceChildren(); } };
}
