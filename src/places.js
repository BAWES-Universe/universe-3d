import { newPlaceDraft, readPlaceDraft, savePlaceDraft, runPlaceCreation } from './place-creation-flow.js';
/** Local Universe → World → Room management. Server capabilities are authoritative. */
const enc = encodeURIComponent;
const TABS = ['explore', 'memberships', 'invitations'];
const ROLES = ['member', 'editor', 'admin'];
const ROLE_HELP = 'Member: visit private rooms. Editor: edit room details and content. Admin: also create rooms and manage this world’s members and invitations. These roles apply only to this world.';
const kindLabel = kind => ({ universe: 'Universe', world: 'World', room: 'Room' }[kind] || 'Place');
const plural = kind => `${kind}s`;
const entityPath = (kind, id) => `/api/${plural(kind)}/${enc(id)}`;
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'text') node.textContent = String(value);
    else if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (['hidden', 'disabled', 'checked', 'required'].includes(key)) node[key] = Boolean(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
const btn = (text, onclick, attrs = {}) => el('button', { type: 'button', class: 'places-btn', onclick, ...attrs }, text);
let fieldSequence = 0;
const field = (label, control, hint) => { control.setAttribute('aria-label', label); const hintId = `places-field-hint-${++fieldSequence}`; if (hint) control.setAttribute('aria-describedby', hintId); return el('label', { class: 'places-field' }, el('span', { text: label }), control, hint && el('small', { id: hintId, text: hint })); };
const input = attrs => el('input', { class: 'places-input', ...attrs });
const muted = text => el('p', { class: 'places-muted', text });
const empty = text => el('p', { class: 'places-empty', text });
const actions = (...nodes) => el('div', { class: 'places-actions' }, ...nodes);
const notice = (text, type = '', attrs = {}) => el('div', { class: `places-notice${type ? ` places-notice-${type}` : ''}`, role: type === 'error' ? 'alert' : 'status', ...attrs }, text);
const badge = (text, type = '') => el('span', { class: `places-badge${type ? ` places-badge-${type}` : ''}`, text });
const formatDate = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'unknown date' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); };
const tagsFrom = text => [...new Set(text.split(',').map(x => x.trim()).filter(Boolean))];
const operationId = () => globalThis.crypto?.randomUUID?.() || `place-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const formValues = item => ({ name: item?.name || '', slug: item?.slug || '', description: item?.description || '', public: item?.public ?? true, thumbnail: item?.thumbnail || '' });
const sameValues = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function mountPlaces({ root, api, getState, onNavigate = () => {}, onChanged = () => {}, toast = () => {}, onClose = () => {}, onOpenChange = () => {} }) {
  if (!root || typeof api !== 'function' || typeof getState !== 'function') throw new Error('mountPlaces needs root, api and getState');
  let destroyed = false, activeTab = 'explore', selected = null, currentUser = '', request = 0, loading = false;
  let catalog = [], memberships = [], invitations = [], stars = new Set(), filter = '', showArchived = false, scope = 'all';
  let dialog = null, opener = null, detailMode = '', selectedAccount = null, accountResults = [], accountQuery = '', accountRequest = 0;
  let memberDraft = null, inviteDraft = { role: 'member', tags: '' }, createDraft = null, refreshTimer = null, errorText = '', infoText = '';
  let guide = null, guideVisible = false, guideBusy = false, guideError = '';
  const drafts = new Map(), creationDrafts = new Map(), busy = new Set(), tabs = new Map();
  const state = () => getState() || {};
  const user = () => state().user || {};
  const index = new Map();
  const keyOf = (kind, id) => `${kind}:${id}`;
  const selectedItem = () => selected && index.get(keyOf(selected.kind, selected.id));
  const archived = item => Boolean(item?.archivedAt || item?._ancestorArchived);
  function notify(text, type = 'info') { if (!destroyed) toast(text, type); }
  function showError(error) { errorText = error?.message || 'Something went wrong. Your draft is still here. Please retry.'; infoText = ''; renderStatus(); }
  function setInfo(text) { errorText = ''; infoText = text; renderStatus(); }
  function renderStatus() {
    status.replaceChildren();
    if (errorText) status.append(notice(errorText, 'error'));
    else if (infoText) status.append(notice(infoText));
    else if (loading && !catalog.length) status.append(notice('Loading your places…'));
  }
  function cap(item, key) { return Boolean(item?.capabilities?.[key]); }
  function rebuildIndex() {
    index.clear();
    for (const u of catalog) {
      index.set(keyOf('universe', u.id), { ...u, kind: 'universe' });
      for (const w of u.worlds || []) {
        index.set(keyOf('world', w.id), { ...w, kind: 'world', _universe: u, _ancestorArchived: Boolean(u.archivedAt) });
        for (const r of w.rooms || []) index.set(keyOf('room', r.id), { ...r, kind: 'room', _world: w, _universe: u, _ancestorArchived: Boolean(u.archivedAt || w.archivedAt) });
      }
    }
  }
  function checkIdentity() {
    const id = user().id || '';
    if (currentUser === id) return;
    currentUser = id; guide = null; guideVisible = false; guideBusy = false; guideError = ''; request++; drafts.clear(); creationDrafts.clear(); catalog = []; memberships = []; invitations = []; stars.clear(); index.clear(); selected = null; detailMode = ''; createDraft = null; memberDraft = null; selectedAccount = null; accountResults = []; memberCache.clear(); errorText = ''; infoText = ''; dismissConfirm(false);
  }
  const visible = node => Boolean(node?.isConnected && !node.disabled && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
  const focusable = 'button,input,select,textarea,a[href],[tabindex]';
  function ownsForeground() {
    if (root.hidden || destroyed) return false;
    // A visible modal painted above Places owns focus even when its input has
    // blurred. Use the rendered surface, not the current activeElement, so
    // refreshes and resize cannot pull focus behind Quick actions or Avatar.
    for (const modal of document.querySelectorAll('[aria-modal="true"]')) {
      if (modal === root || root.contains(modal) || modal.contains(root) || !visible(modal)) continue;
      const box = modal.getBoundingClientRect();
      const left = Math.max(0, box.left), right = Math.min(innerWidth, box.right);
      const top = Math.max(0, box.top), bottom = Math.min(innerHeight, box.bottom);
      if (right <= left || bottom <= top) continue;
      const painted = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      if (modal.contains(painted)) return false;
    }
    return true;
  }
  function focusSnapshot() {
    const active = document.activeElement;
    if (!ownsForeground() || !root.contains(active)) return null;
    return { node: active, key: active.dataset.placeField, id: active.id,
      label: active.getAttribute('aria-label') || active.textContent, tag: active.tagName,
      context: active.closest('[data-invitation-id]')?.dataset.invitationId || '',
      start: active.selectionStart, end: active.selectionEnd };
  }
  function focusDetail() {
    if (!ownsForeground()) return;
    const heading = detail.querySelector('.places-detail-title');
    if (heading) heading.tabIndex = -1;
    const target = dialog ? [...dialog.node.querySelectorAll(focusable)].find(visible) : visible(heading) ? heading : closeButton;
    (target || closeButton).focus({ preventScroll: true });
  }
  function restoreFocus(snapshot) {
    if (!ownsForeground() || !snapshot) return;
    const surface = dialog?.node || root;
    const candidates = [...surface.querySelectorAll(focusable)].filter(visible);
    const node = visible(snapshot.node) && surface.contains(snapshot.node) ? snapshot.node : candidates.find(n =>
      snapshot.key ? n.dataset.placeField === snapshot.key : snapshot.id ? n.id === snapshot.id :
      n.tagName === snapshot.tag && (n.getAttribute('aria-label') || n.textContent) === snapshot.label &&
      (n.closest('[data-invitation-id]')?.dataset.invitationId || '') === snapshot.context);
    if (node) {
      node.focus({ preventScroll: true });
      if (snapshot.start != null && node.setSelectionRange) try { node.setSelectionRange(snapshot.start, snapshot.end); } catch {}
    } else if (activeTab === 'explore' || dialog) focusDetail();
    else tabs.get(activeTab).focus({ preventScroll: true });
  }
  async function refresh({ silent = false } = {}) {
    if (destroyed) return;
    checkIdentity(); if (!currentUser) { render(); return; }
    const version = ++request, userId = currentUser;
    loading = true; if (!silent) renderStatus();
    try {
      const [places, own, inbox, favorites] = await Promise.all([api(`/api/universes?includeArchived=${showArchived ? '1' : '0'}`), api('/api/memberships'), api('/api/invitations'), api('/api/stars')]);
      if (destroyed || version !== request || userId !== user().id) return;
      const focus = focusSnapshot();
      catalog = places.universes || []; memberships = own.memberships || []; invitations = inbox.invitations || []; stars = new Set((favorites.rooms || []).map(r => r.id)); rebuildIndex(); loading = false;
      if (selected && !selectedItem() && !createDraft) { detailMode = ''; memberDraft = null; selectedAccount = null; accountResults = []; if (activeTab === 'explore' && !infoText) errorText = 'This place is no longer available to you. Choose another place.'; }
      render(); restoreFocus(focus);
      if (detailMode === 'members' && selectedItem() && cap(selectedItem(), 'canManageMembers')) await loadMembers(selectedItem(), { silent: true });
    } catch (error) { if (version === request && !destroyed) { loading = false; showError(error); } }
  }
  async function changed(message) {
    if (message) { setInfo(message); notify(message); }
    await refresh({ silent: true });
    try { await onChanged(); } catch (error) { showError(error); }
  }
  async function perform(key, button, task) {
    if (destroyed || busy.has(key)) return;
    busy.add(key); if (button) button.disabled = true;
    try { return await task(); } catch (error) { showError(error); return null; }
    finally { busy.delete(key); if (button?.isConnected) button.disabled = false; }
  }
  function dismissConfirm(restore = true) {
    if (!dialog) return;
    const previous = dialog.anchor; dialog.node.remove(); dialog = null;
    if (restore && ownsForeground()) { if (visible(previous)) previous.focus({ preventScroll: true }); else focusDetail(); }
  }
  function confirmAction({ title, text, label, action, anchor, danger = true }) {
    dismissConfirm(false);
    const localStatus = el('div', { class: 'places-status' });
    const cancel = btn('Cancel', () => dismissConfirm(), { class: 'places-btn places-btn-quiet' });
    const confirm = btn(label, async () => {
      confirm.disabled = cancel.disabled = true;
      try { await action(); dismissConfirm(); }
      catch (error) { if ([403, 404, 409].includes(error.status)) await refresh({ silent: true }); localStatus.replaceChildren(notice(error.message || 'Could not complete this action. Please retry.', 'error')); confirm.disabled = cancel.disabled = false; }
    }, { class: `places-btn ${danger ? 'places-btn-danger' : 'places-btn-primary'}` });
    const node = el('div', { class: 'places-confirm-backdrop' }, el('section', { class: 'places-confirm', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'places-confirm-title', 'aria-describedby': 'places-confirm-message' }, el('h3', { id: 'places-confirm-title', text: title }), el('p', { id: 'places-confirm-message', text }), localStatus, actions(cancel, confirm)));
    dialog = { node, anchor: anchor || document.activeElement }; root.append(node); cancel.focus();
  }
  function close() {
    if (destroyed || root.hidden) return;
    const restore = ownsForeground();
    dismissConfirm(false); root.hidden = true; onOpenChange(false); onClose();
    const returnTo = visible(opener) ? opener : [...document.querySelectorAll('[aria-controls]')].find(n => n.getAttribute('aria-controls') === root.id && visible(n)) || document.getElementById(opener?.id);
    if (restore && visible(returnTo)) returnTo.focus({ preventScroll: true });
  }
  function open(tab = activeTab) {
    if (destroyed) return;
    checkIdentity();
    const wasClosed = root.hidden;
    if (wasClosed) opener = document.activeElement;
    root.hidden = false;
    activeTab = TABS.includes(tab) ? tab : 'explore';
    if (tab === 'manage' && state().room?.id) selected = { kind: 'room', id: state().room.id };
    else if (!selected && !createDraft && state().room?.worldId) selected = { kind: 'world', id: state().room.worldId };
    render(); if (wasClosed) onOpenChange(true); closeButton.focus(); refresh();
  }
  function select(kind, id) {
    guideVisible = false; selected = { kind, id }; detailMode = drafts.has(keyOf(kind, id)) ? 'edit' : ''; createDraft = null; memberDraft = null; selectedAccount = null; accountQuery = ''; accountResults = []; errorText = ''; infoText = ''; render();
    focusDetail();
  }
  function setTab(tab) { activeTab = tab; dismissConfirm(); render(); }
  const closeButton = btn('×', close, { class: 'places-btn places-btn-quiet places-close', 'aria-label': 'Close places', title: 'Close places (Escape)' });
  const header = el('header', { class: 'places-header' }, el('div', { class: 'places-grow' }, el('p', { class: 'places-eyebrow', text: 'Your Universe' }), el('h2', { class: 'places-title', id: 'places-title', text: 'A place for everyone' }), el('p', { class: 'places-subtitle', text: 'Explore your spaces. Shape the ones you call yours.' })), closeButton);
  const tabBar = el('nav', { class: 'places-tabs', role: 'tablist', 'aria-label': 'Places' });
  for (const tab of TABS) {
    const node = btn({ explore: 'Places', memberships: 'Memberships', invitations: 'Invitations' }[tab], () => setTab(tab), { class: 'places-tab', role: 'tab', id: `places-tab-${tab}`, 'aria-controls': 'places-panel' });
    node.addEventListener('keydown', event => { let i = TABS.indexOf(activeTab); if (event.key === 'ArrowRight') i = (i + 1) % TABS.length; else if (event.key === 'ArrowLeft') i = (i + TABS.length - 1) % TABS.length; else if (event.key === 'Home') i = 0; else if (event.key === 'End') i = TABS.length - 1; else return; event.preventDefault(); setTab(TABS[i]); tabs.get(TABS[i]).focus(); });
    tabs.set(tab, node); tabBar.append(node);
  }
  const status = el('div', { class: 'places-status', 'aria-live': 'polite' });
  const body = el('div', { class: 'places-body', id: 'places-panel', role: 'tabpanel' });
  const catalogPane = el('aside', { class: 'places-catalog', 'aria-label': 'Place hierarchy' });
  const detail = el('section', { class: 'places-detail', 'aria-label': 'Place details' });
  const foot = el('footer', { class: 'places-local-note', text: 'Standalone local community · Invitations go to existing local accounts in this app. No email is sent.' });
  root.classList.add('places-shell'); root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'places-title'); root.hidden = true; root.replaceChildren(header, tabBar, status, body, foot);
  const stopKeys = event => {
    if (!ownsForeground()) return;
    event.stopPropagation();
    if (event.type !== 'keydown') return;
    if (event.key === 'Escape') { if (event.isComposing || event.keyCode === 229) return; event.preventDefault(); if (dialog) dismissConfirm(); else close(); return; }
    if (event.key === 'Tab') {
      const surface = dialog?.node || root;
      const nodes = [...surface.querySelectorAll('button:not(:disabled):not([tabindex="-1"]),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter(n => n.getClientRects().length);
      if (!nodes.length) return;
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && (document.activeElement === first || !nodes.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !nodes.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
  };
  root.addEventListener('keydown', stopKeys); root.addEventListener('keyup', stopKeys);
  const recoverKeys = event => {
    if (!ownsForeground() || root.contains(event.target)) return;
    stopKeys(event);
    if (!root.hidden) focusDetail();
  };
  document.addEventListener('keydown', recoverKeys, true);
  document.addEventListener('keyup', recoverKeys, true);
  const retainFocus = () => {
    if (ownsForeground() && (!root.contains(document.activeElement) || !visible(document.activeElement))) focusDetail();
  };
  const focusObserver = new MutationObserver(retainFocus);
  focusObserver.observe(root, { childList: true, subtree: true });
  window.addEventListener('resize', retainFocus);

  function render() {
    if (destroyed) return;
    const focus = focusSnapshot();
    const pending = invitations.filter(i => i.status === 'pending').length;
    for (const [tab, node] of tabs) { node.setAttribute('aria-selected', String(tab === activeTab)); node.tabIndex = tab === activeTab ? 0 : -1; if (tab === 'invitations') { node.replaceChildren('Invitations'); if (pending) node.append(el('span', { class: 'places-count', 'aria-label': `${pending} pending`, text: pending })); } }
    body.setAttribute('aria-labelledby', `places-tab-${activeTab}`); root.dataset.detail = String(Boolean(selected || createDraft || guideVisible)); renderStatus();
    if (!user().id) { body.replaceChildren(empty('Enter Universe or sign in to your local account to view your places.')); return; }
    if (activeTab === 'explore') { body.replaceChildren(catalogPane, detail); renderCatalog(); renderDetail(); }
    else if (activeTab === 'memberships') renderMemberships();
    else renderInvitations();
    restoreFocus(focus);
  }
  function renderCatalog() {
    const search = input({ type: 'search', placeholder: 'Find a place…', 'aria-label': 'Find a place', value: filter, 'data-place-field': 'catalog-search', oninput: event => { filter = event.target.value; renderTree(tree); } });
    const archiveBox = input({ type: 'checkbox', checked: showArchived, onchange: event => { showArchived = event.target.checked; refresh(); } });
    const scopeSelect = el('select', { class: 'places-input', 'aria-label': 'Places view', onchange: event => { scope = event.target.value; renderTree(tree); } }, el('option', { value: 'all', text: 'All visible places' }), el('option', { value: 'owned', text: 'My universes' }), el('option', { value: 'starred', text: 'My starred rooms' })); scopeSelect.value = scope;
    const tree = el('div', { class: 'places-tree' });
    catalogPane.replaceChildren(el('div', { class: 'places-search' }, search), el('div', { class: 'places-search' }, scopeSelect), actions(btn('Make a place', startGuide, { class: 'places-btn places-btn-primary', 'data-place-field': 'make-place' })), actions(btn('+ New universe', () => startCreate('universe'), { class: 'places-btn places-btn-quiet', title: 'Advanced: create only a universe' }), btn('Refresh', () => refresh(), { class: 'places-btn places-btn-quiet', 'aria-label': 'Refresh places' })), el('label', { class: 'places-checkbox places-muted' }, archiveBox, 'Show managed archives'), tree);
    renderTree(tree);
  }
  function renderTree(tree) {
    tree.replaceChildren(); const q = filter.trim().toLowerCase();
    const matches = item => !q || `${item.name} ${item.slug} ${item.description}`.toLowerCase().includes(q);
    let count = 0;
    const row = (kind, item) => {
      count++; const current = kind === 'room' && item.id === state().room?.id;
      return btn('', () => select(kind, item.id), { class: `places-tree-item places-tree-${kind}`, 'aria-current': String(selected?.kind === kind && selected.id === item.id), 'aria-label': `View ${kind} ${item.name}` });
    };
    const appendRow = (kind, item) => {
      const node = row(kind, item); node.append(el('span', { class: 'places-tree-icon', 'aria-hidden': 'true', text: { universe: '✦', world: '◇', room: '▧' }[kind] }), el('span', { class: 'places-tree-text' }, el('span', { class: 'places-tree-kind', text: kindLabel(kind) }), item.name));
      if (item.archivedAt) node.append(badge('Archived', 'archived'));
      else if (kind === 'room' && state().room?.id === item.id) node.append(el('span', { class: 'places-tree-current', text: 'Here' }));
      tree.append(node);
    };
    for (const u of catalog) {
      if (scope === 'owned' && u.ownerId !== user().id) continue;
      if (scope === 'starred' && !(u.worlds || []).some(w => (w.rooms || []).some(r => stars.has(r.id) && matches(r)))) continue;
      const worlds = (u.worlds || []).filter(w => matches(u) || matches(w) || (w.rooms || []).some(matches));
      if (!matches(u) && !worlds.length) continue;
      appendRow('universe', u);
      for (const w of worlds) { if (scope === 'starred' && !(w.rooms || []).some(r => stars.has(r.id) && matches(r))) continue; appendRow('world', w); for (const r of w.rooms || []) if ((scope !== 'starred' || stars.has(r.id)) && (matches(u) || matches(w) || matches(r))) appendRow('room', r); }
    }
    if (!count) tree.append(empty(loading ? 'Loading places…' : q ? 'No visible places match your search.' : 'No places are available. Create your first universe.'));
  }
  function breadcrumbs(item) {
    return el('nav', { class: 'places-breadcrumb', 'aria-label': 'Place ancestry' }, item._universe && btn(item._universe.name, () => select('universe', item._universe.id), { class: 'places-btn places-btn-quiet','data-kind':'universe' }), item._world && ['›', btn(item._world.name, () => select('world', item._world.id), { class: 'places-btn places-btn-quiet','data-kind':'world' })], item._universe && '›', kindLabel(item.kind));
  }
  function renderDetail() {
    const snapshot = focusSnapshot();
    renderDetailContents();
    restoreFocus(snapshot);
  }
  function renderDetailContents() {
    detail.replaceChildren(btn('← All places', () => { selected = null; createDraft = null; guideVisible = false; detailMode = ''; render(); catalogPane.querySelector('[data-place-field=\"make-place\"]')?.focus(); }, { class: 'places-btn places-btn-quiet places-back-mobile' }));
    if (guideVisible) { renderGuide(); return; }
    if (createDraft) { renderMetadataForm(null, createDraft); return; }
    const item = selectedItem();
    if (!item) {
      detail.append(el('div', { class: 'places-eyebrow', text: 'Room to belong' }), el('h3', { class: 'places-detail-title', text: 'Small worlds. Endless possibilities.' }), muted('Choose a universe, world or room to explore its details. Membership and editing rights are specific to each world.'), el('div', { class: 'places-section' }, el('h3', { text: 'Three levels, one community' }), muted('A universe contains worlds. Each world has its own members and rooms. Visiting a public room does not add you as a world member.'), muted('Universe owners manage their hierarchy. World admins manage members and create rooms. World editors can edit existing rooms.'))); return;
    }
    detail.append(breadcrumbs(item), el('h3', { class: 'places-detail-title', tabindex: '-1', text: item.name }), el('div', { class: 'places-tags' }, el('span',{class:'places-badge','data-kind':item.kind,text:kindLabel(item.kind)}), badge(item.public ? 'Public' : 'Private', item.public ? 'public' : ''), archived(item) && badge(item.archivedAt ? 'Archived' : 'Parent archived', 'archived'), item.role && badge(`${item.kind === 'room' ? 'Room' : 'World'} role: ${item.role}`)));
    if (detailMode === 'edit' && drafts.has(keyOf(item.kind, item.id))) { renderMetadataForm(item, drafts.get(keyOf(item.kind, item.id))); return; }
    if (item.thumbnail && (/^https:\/\//.test(item.thumbnail) || /^\/assets\//.test(item.thumbnail))) detail.append(el('img', { class: 'places-thumbnail', src: item.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }));
    if (item.description) detail.append(muted(item.description));
    detail.append(muted(`Slug: ${item.slug || item.id}`));
    if (archived(item)) detail.append(notice('This place is archived. Its records and saved room content remain stored. It cannot be entered until its parent chain and this place are restored.', 'warning'));
    const control = actions();
    if (item.kind === 'room' && !archived(item)) {
      const enter = btn(`Enter ${item.name}`, () => perform(`enter:${item.id}`, enter, async () => { await onNavigate(item.id); close(); }), { class: 'places-btn places-btn-primary', 'aria-label': `Enter ${item.name}` }); control.append(enter);
      const star = btn(stars.has(item.id) ? '★ Starred' : '☆ Star room', () => perform(`star:${item.id}`, star, async () => { await api(`${entityPath('room', item.id)}/star`, { method: stars.has(item.id) ? 'DELETE' : 'PUT', body: {} }); await changed(stars.has(item.id) ? 'Room unstarred.' : 'Room starred.'); }), { 'aria-pressed': String(stars.has(item.id)), 'aria-label': `${stars.has(item.id) ? 'Unstar' : 'Star'} ${item.name}` }); control.append(star);
    }
    if (cap(item, 'canEdit') && !archived(item)) control.append(btn(drafts.has(keyOf(item.kind, item.id)) ? 'Resume draft' : 'Edit details', () => { const key = keyOf(item.kind, item.id); if (!drafts.has(key)) drafts.set(key, { values: formValues(item), base: formValues(item), revision: item.metadataRevision }); detailMode = 'edit'; renderDetail(); detail.querySelector('input')?.focus(); }));
    if (cap(item, 'canCreateWorld') && !archived(item)) control.append(btn('+ New world', () => startCreate('world', item)));
    if (cap(item, 'canCreateRoom') && !archived(item)) control.append(btn('+ New room', () => startCreate('room', item)));
    if (cap(item, 'canManageMembers') && item.kind === 'world' && !archived(item)) control.append(btn(detailMode === 'members' ? 'Hide members' : 'Members & invitations', async () => { detailMode = detailMode === 'members' ? '' : 'members'; renderDetail(); if (detailMode === 'members') await loadMembers(item); }));
    if (control.childElementCount) detail.append(control);
    if (item.kind === 'world') detail.append(muted(`World role: ${item.role || 'guest'}${item.tags?.length ? ` · Tags: ${item.tags.join(', ')}` : ''}. Public visits alone do not create a membership.`));
    if (item.kind === 'universe' && cap(item, 'canEdit')) detail.append(muted('You own this universe. Ownership and featured status cannot be changed here.'));
    if (detailMode === 'members' && item.kind === 'world' && cap(item, 'canManageMembers')) renderMembers(item);
    else if (item.kind !== 'room') renderChildren(item);
    const lifecycle = actions();
    if (cap(item, 'canRestore') && item.archivedAt) lifecycle.append(btn(`Restore ${item.kind}`, event => lifecycleAction(item, true, event.currentTarget), { disabled: item._ancestorArchived, title: item._ancestorArchived ? 'Restore the parent place first' : 'Restore this archived place' }));
    if (cap(item, 'canArchive') && !archived(item)) lifecycle.append(btn(`Archive ${item.kind}`, event => lifecycleAction(item, false, event.currentTarget), { class: 'places-btn places-btn-danger' }));
    if (lifecycle.childElementCount) detail.append(el('section', { class: 'places-section' }, el('h3', { text: 'Lifecycle' }), muted('Archive is reversible. There is no permanent-delete action in this local app.'), lifecycle));
  }
  function renderChildren(item) {
    const list = item.kind === 'universe' ? item.worlds || [] : item.rooms || [], childKind = item.kind === 'universe' ? 'world' : 'room';
    const section = el('section', { class: 'places-section' }, el('h3', { text: childKind === 'world' ? 'Worlds you can see' : 'Rooms you can see' }));
    for (const child of list) {
      const card = el('article', { class: 'places-card', 'data-kind': child.kind|| (item.kind==='universe'?'world':'room') }, el('h4', { class: 'places-card-title', text: child.name }), child.description && muted(child.description), el('div', { class: 'places-tags' }, badge(child.public ? 'Public' : 'Private'), child.archivedAt && badge('Archived', 'archived')));
      const controls = actions(btn('View details', () => select(childKind, child.id), { 'aria-label': `View ${childKind} details ${child.name}` }));
      if (childKind === 'room' && !archived(item) && !child.archivedAt) { const enter = btn(`Enter ${child.name}`, () => perform(`enter:${child.id}`, enter, async () => { await onNavigate(child.id); close(); }), { class: 'places-btn places-btn-primary', 'aria-label': `Enter ${child.name}` }); controls.append(enter); }
      card.append(controls); section.append(card);
    }
    if (!list.length) section.append(empty(`No visible ${plural(childKind)} here yet.`));
    detail.append(section);
  }
  function startGuide() {
    guideVisible = true; createDraft = null; detailMode = ''; activeTab = 'explore';
    if (!guide) {
      try { guide = readPlaceDraft(sessionStorage, currentUser); guideError = ''; }
      catch (error) { guideError = error.message; }
    }
    render(); focusDetail();
  }
  function persistGuide(draft) { savePlaceDraft(sessionStorage, draft); }
  function renderGuide() {
    detail.append(el('h3', { class: 'places-detail-title', tabindex: '-1', text: 'Make a place' }));
    if (!guide) { detail.append(notice(guideError || 'Creation progress is unavailable.', 'error')); return; }
    const draft = guide, complete = Boolean(draft.steps[2]?.id);
    detail.append(muted('A new universe, its world and your first room. All yours.'));
    const form = el('form', { class: 'places-form', 'aria-label': 'Make a place' });
    const name = input({ value: draft.name, dir: 'auto', required: true, maxlength: 120, autocomplete: 'off', disabled: draft.started || guideBusy, 'data-place-field': 'creation-name' });
    const privacy = el('select', { class: 'places-input', disabled: draft.started || guideBusy, 'data-place-field': 'creation-privacy' }, el('option', { value: 'private', text: 'Private · only you and authorized members' }), el('option', { value: 'public', text: 'Public · anyone on this server can visit' }));
    privacy.value = draft.public ? 'public' : 'private';
    const preview = el('section', { class: 'places-creation-preview', 'aria-label': 'Creation plan' });
    const updatePreview = () => {
      const label = draft.name.trim() || 'Your place';
      preview.replaceChildren(el('h4', { class: 'places-card-title', text: draft.started ? 'Your creation progress' : 'This will create exactly' }), ...['universe', 'world', 'room'].map((kind, i) => {
        const step = draft.steps[i];
        return el('div', { class: 'places-creation-step', 'data-kind': kind }, badge(kindLabel(kind)), el('span', { dir: 'auto', text: label }), el('small', { text: step?.id ? 'Created' : draft.started ? 'Not confirmed yet' : 'New' }));
      }), muted(`All three: ${draft.public ? 'public' : 'private'}. You own the universe and administer its world. Rename each level later in advanced management.`));
    };
    const rememberInputs = () => {
      draft.name = name.value; draft.public = privacy.value === 'public';
      try { persistGuide(draft); guideError = ''; } catch (error) { guideError = error.message; }
      updatePreview();
    };
    name.addEventListener('input', rememberInputs); privacy.addEventListener('change', rememberInputs); updatePreview();
    form.append(field('Place name', name, 'Any language. We generate the link slugs.'), field('Privacy', privacy, 'Invitations are separate. Public visitors cannot edit.'), preview,
      muted('Garden starter · 32 × 26 m, with fixed paths, deck and planting. Add editable objects and areas with Build.'),
      muted('Keep this tab to resume after an interruption or reload.'));
    if (draft.started && !complete) form.append(notice('Creation happens in three steps. Confirmed records remain saved if a later step fails. Retry continues this same plan; it will not start another universe.', 'warning'));
    if (guideError) form.append(notice(guideError, 'error'));
    const submit = btn(guideBusy ? 'Working…' : complete ? 'Enter your room' : draft.started ? 'Retry creation' : 'Create & enter', null, { type: 'submit', class: 'places-btn places-btn-primary', disabled: guideBusy, 'data-place-field': 'creation-submit' });
    const creationActions = actions(btn('Back to places', () => { guideVisible = false; selected = null; render(); catalogPane.querySelector('[data-place-field="make-place"]')?.focus(); }, { class: 'places-btn places-btn-quiet' }), submit);
    creationActions.classList.add('places-creation-actions'); form.append(creationActions);
    if (complete) form.append(btn('Make another place', () => {
      if (guideBusy) return;
      const next = newPlaceDraft(currentUser);
      try { persistGuide(next); guide = next; guideError = ''; render(); focusDetail(); } catch (error) { guideError = error.message; render(); }
    }, { disabled: guideBusy, class: 'places-btn places-btn-quiet' }));
    form.onsubmit = async event => {
      event.preventDefault();
      if (guideBusy || !form.reportValidity()) return;
      guideBusy = true; guideError = ''; render();
      const actor = currentUser;
      const isCurrent = () => !destroyed && user().id === actor && currentUser === actor && guide === draft;
      try {
        const roomId = await runPlaceCreation(draft, { api, persist: persistGuide, isCurrent, onProgress: () => { if (isCurrent()) render(); } });
        if (!isCurrent()) return;
        await changed('Your universe, world and room are created.');
        if (isCurrent() && !root.hidden && guideVisible && activeTab === 'explore') {
          await onNavigate(roomId);
          if (isCurrent() && state().room?.id !== roomId) throw new Error('Arrival did not complete.');
          if (isCurrent() && !root.hidden && guideVisible) { guideVisible = false; selected = { kind: 'room', id: roomId }; close(); }
        }
      } catch (error) {
        if (isCurrent()) guideError = `${error.message || 'The request was interrupted.'} ${draft.steps[2]?.id ? 'Your room is saved. Try entering it again.' : 'Your progress is kept. Retry here to confirm and continue.'}`;
      } finally {
        if (isCurrent()) { guideBusy = false; render(); }
      }
    };
    detail.append(form);
  }
  function startCreate(kind, parent) {
    guideVisible = false;
    const draftKey = `${kind}:${parent?.id || 'new'}`;
    if (!creationDrafts.has(draftKey)) creationDrafts.set(draftKey, { kind, parent, values: formValues(null), base: formValues(null), operationId: operationId(), draftKey });
    createDraft = creationDrafts.get(draftKey);
    selected = null; detailMode = ''; errorText = ''; infoText = ''; render(); detail.querySelector('input')?.focus();
  }
  function renderMetadataForm(item, draft) {
    const kind = item?.kind || draft.kind, creating = !item;
    if (creating) detail.append(el('p', { class: 'places-eyebrow', text: draft.parent ? `Inside ${draft.parent.name}` : 'Start something new' }), el('h3', { class: 'places-detail-title', text: `New ${kind}` }), muted(kind === 'room' ? 'Creates a garden starter with fixed paths, deck and planting decoration. No authored objects or areas yet; add them with Build.' : `Create a ${kind} owned within your local community.`));
    const form = el('form', { class: 'places-form places-section', 'aria-label': `${creating ? 'Create' : 'Edit'} ${kind}` });
    const values = draft.values;
    const assign = (key, node) => { node.dataset.placeField = `metadata-${key}`; node.addEventListener(key === 'public' ? 'change' : 'input', () => { values[key] = key === 'public' ? node.checked : node.value; }); return node; };
    form.append(field(`${kindLabel(kind)} name`, assign('name', input({ value: values.name, required: true, maxlength: 120, autocomplete: 'off' }))), field('Slug', assign('slug', input({ value: values.slug, required: true, maxlength: 64, pattern: '[a-z0-9]+(?:-[a-z0-9]+)*', autocomplete: 'off' })), 'Lowercase letters, numbers and single hyphens. Stable IDs keep existing room links working when the slug changes.'), field('Description', assign('description', el('textarea', { class: 'places-input', maxlength: 3000, text: values.description }))), field('Thumbnail URL', assign('thumbnail', input({ value: values.thumbnail, maxlength: 2000, autocomplete: 'off' })), 'Optional https image URL or local /assets/ path.'), el('label', { class: 'places-checkbox' }, assign('public', input({ type: 'checkbox', checked: values.public })), `Public ${kind}`), muted('Public access requires every parent to be public. Members keep their authorized access to private places.'));
    const conflict = !creating && draft.revision !== item.metadataRevision;
    const allowed = creating || cap(item, 'canEdit');
    if (conflict) {
      const warning = notice('This place changed elsewhere. Your unsaved draft is preserved. Review the latest details before saving.', 'warning');
      warning.append(muted(`Latest name: ${item.name} · Slug: ${item.slug} · ${item.public ? 'Public' : 'Private'}`), actions(btn('Use latest details', () => { drafts.set(keyOf(kind, item.id), { values: formValues(item), base: formValues(item), revision: item.metadataRevision }); renderDetail(); }), btn('Keep my draft on latest', event => confirmAction({ title: 'Save over the latest details?', text: 'Keep your typed values for the next save. They will replace the latest name, slug, description, thumbnail and visibility shown here. Nothing changes until you press Save details.', label: 'Keep my draft', danger: false, anchor: event.currentTarget, action: async () => { draft.revision = item.metadataRevision; draft.base = formValues(item); renderDetail(); } })))); form.append(warning);
    }
    if (!allowed || archived(item)) form.append(notice('Your editing access changed. Your draft remains here, but cannot be saved with your current permissions.', 'warning'));
    const submit = btn(creating ? `Create ${kind}` : 'Save details', null, { type: 'submit', class: 'places-btn places-btn-primary', disabled: conflict || !allowed || (!creating && archived(item)) });
    const cancel = btn('Cancel', event => {
      const discard = () => { if (creating) { creationDrafts.delete(draft.draftKey); createDraft = null; } else drafts.delete(keyOf(kind, item.id)); detailMode = ''; render(); };
      if (!sameValues(values, draft.base)) confirmAction({ title: 'Discard these changes?', text: 'The unsaved details in this form will be discarded. Saved details will not change.', label: 'Discard changes', anchor: event.currentTarget, action: discard }); else discard();
    }, { class: 'places-btn places-btn-quiet' });
    form.append(actions(cancel, !creating && btn('View details, keep draft', () => { detailMode = ''; renderDetail(); }, { class: 'places-btn places-btn-quiet' }), submit));
    form.onsubmit = event => {
      event.preventDefault(); if (!form.reportValidity() || conflict || !allowed || (!creating && archived(item))) return;
      const save = async () => {
        const body = { ...values };
        if (creating) { body.clientOperationId = draft.operationId; if (draft.parent) body[kind === 'world' ? 'universeId' : 'worldId'] = draft.parent.id; }
        else body.metadataRevision = draft.revision;
        const result = await api(creating ? `/api/${plural(kind)}` : entityPath(kind, item.id), { method: creating ? 'POST' : 'PATCH', body });
        const saved = result[kind] || result;
        if (!creating) drafts.delete(keyOf(kind, item.id)); else creationDrafts.delete(draft.draftKey); createDraft = null; detailMode = ''; selected = { kind, id: saved.id || item?.id }; await changed(`${kindLabel(kind)} ${creating ? 'created' : 'saved'}.`);
      };
      if (!creating && draft.base.public && !values.public) confirmAction({ title: `Make this ${kind} private?`, text: 'Visitors without access will lose visibility and may be disconnected from affected rooms immediately. Existing authorized world memberships remain. Your other detail changes will be saved too.', label: 'Make private & save', anchor: submit, action: save });
      else perform(`save:${kind}:${item?.id || draft.operationId}`, submit, async () => { try { await save(); } catch (error) { if (error?.data?.error === 'METADATA_CONFLICT' || error?.status === 409) await refresh({ silent: true }); throw error; } });
    };
    detail.append(form);
  }
  function lifecycleAction(item, restore, anchor) {
    confirmAction({ title: `${restore ? 'Restore' : 'Archive'} ${item.name}?`, text: restore ? 'This restores the saved place and its stable ID. Its parent must be active. Children archived separately remain archived; previous memberships and saved content are retained.' : `This prevents entry to this ${item.kind}${item.kind === 'room' ? '' : ' and all rooms below it'} and disconnects current occupants. Saved content, memberships and IDs are retained for restoration.${item.kind === 'room' ? '' : ' Pending invitations in the archived scope are cancelled.'} No permanent deletion occurs.`, label: `${restore ? 'Restore' : 'Archive'} ${item.kind}`, danger: !restore, anchor, action: async () => {
      await api(`${entityPath(item.kind, item.id)}${restore ? '/restore' : ''}`, { method: restore ? 'POST' : 'DELETE', body: { metadataRevision: item.metadataRevision } });
      if (!restore) showArchived = true;
      await changed(`${kindLabel(item.kind)} ${restore ? 'restored' : 'archived'}.`);
    } });
  }
  const memberCache = new Map();
  async function loadMembers(item, { silent = false } = {}) {
    const worldId = item.id, userId = currentUser;
    try {
      const [membersResult, inviteResult, legacyResult] = await Promise.all([api(`/api/worlds/${enc(worldId)}/members`), api(`/api/worlds/${enc(worldId)}/invitations`), api(`/api/worlds/${enc(worldId)}/legacy-grants`)]);
      if (destroyed || currentUser !== userId) return;
      memberCache.set(worldId, { members: membersResult.members || [], invitations: inviteResult.invitations || [], legacyGrants: legacyResult.grants || [] });
      if (selected?.kind === 'world' && selected.id === worldId && detailMode === 'members') { const focus = focusSnapshot(); renderDetail(); restoreFocus(focus); }
    } catch (error) { if (selected?.id === worldId && !destroyed) showError(error); }
  }
  function roleFields(draft, prefix) {
    const role = el('select', { class: 'places-input', 'data-place-field': `${prefix}-role`, 'aria-label': 'World role' }, ROLES.map(r => el('option', { value: r, text: r[0].toUpperCase() + r.slice(1) })));
    role.value = draft.role; role.onchange = () => { draft.role = role.value; };
    const tags = input({ value: draft.tags, placeholder: 'design, hosts', maxlength: 1230, 'data-place-field': `${prefix}-tags`, oninput: event => { draft.tags = event.target.value; } });
    return [el('div', { class: 'places-form-row' }, field('World role', role), field('World-local tags', tags, 'Up to 30 comma-separated labels, 40 characters each. Use the role field for admin or editor permissions.')), el('p', { class: 'places-role-explainer', text: ROLE_HELP })];
  }
  function renderMembers(item) {
    const data = memberCache.get(item.id);
    const section = el('section', { class: 'places-section' }, el('h3', { text: `Members of ${item.name}` }), muted('Changes here affect only this world. Room moderation remains a separate control.'));
    if (!data) section.append(empty('Loading members and invitations…'));
    if (data?.legacyGrants?.length) {
      const review = el('section', { class: 'places-card' }, el('h4', { class: 'places-card-title', text: 'Previous room grants need review' }), notice('These older room-only grants are inactive under the private parent. No one has been automatically added to this world. World membership would allow access to all private rooms in this world. Previous room-specific roles are retained.', 'warning'));
      for (const grant of data.legacyGrants) {
        const row = el('div', { class: 'places-member' }, el('div', { class: 'places-grow' }, el('p', { class: 'places-member-name', text: grant.name || grant.username || 'Local profile' }), muted(`${grant.roomName} · Previous room role: ${grant.role}${grant.username ? ` · @${grant.username}` : ''}`)));
        if (grant.username) row.append(btn('Review access', () => { selectedAccount = { id: grant.userId, name: grant.name, username: grant.username }; inviteDraft = { role: 'member', tags: '' }; renderDetail(); detail.querySelector('[aria-label="Invite ' + grant.username + '"]')?.scrollIntoView({ block: 'nearest' }); }, { 'aria-label': `Review previous access for ${grant.name} in ${grant.roomName}` }));
        else row.append(muted('This profile needs a registered local account before it can be selected in the account chooser.'));
        review.append(row);
      }
      section.append(review);
    }

    for (const member of data?.members || []) {
      const memberId = member.userId || member.id, isProtected = member.protected || memberId === item._universe?.ownerId;
      const card = el('article', { class: 'places-member' }, el('span', { class: 'places-avatar', 'aria-hidden': 'true', text: (member.name || '?').slice(0, 1).toUpperCase() }), el('div', { class: 'places-member-main' }, el('p', { class: 'places-member-name', text: member.name || member.username || memberId }), member.username && el('span', { class: 'places-muted', text: `@${member.username}` }), el('div', { class: 'places-tags' }, badge(`World: ${member.role}`), isProtected && badge('Protected owner'), (member.tags || []).map(tag => badge(tag)))));
      if (!isProtected) {
        card.append(actions(btn('Edit member', () => { memberDraft = { worldId: item.id, userId: memberId, role: member.role, tags: (member.tags || []).join(', '), name: member.name }; renderDetail(); }, { 'aria-label': `Edit world membership for ${member.name}` }), btn('Remove', event => confirmAction({ title: `Remove ${member.name} from ${item.name}?`, text: 'This removes their membership, role and tags in this world. Their editing permissions end immediately. If they lose access to a private room, they will be disconnected. Public places may still be visited as a guest. Other worlds are unchanged.', label: 'Remove membership', anchor: event.currentTarget, action: async () => { await api(`/api/worlds/${enc(item.id)}/members/${enc(memberId)}`, { method: 'DELETE', body: {} }); memberDraft = null; await loadMembers(item); await changed('World membership removed.'); } }), { class: 'places-btn places-btn-danger', 'aria-label': `Remove world membership for ${member.name}` })));
      }
      if (memberDraft?.worldId === item.id && memberDraft.userId === memberId) {
        const draft = memberDraft;
        const form = el('form', { class: 'places-member-editor places-form', 'aria-label': `Edit membership for ${member.name}` }, ...roleFields(draft, `member-${memberId}`));
        const save = btn('Save membership', null, { type: 'submit', class: 'places-btn places-btn-primary' });
        form.append(actions(btn('Cancel', () => { memberDraft = null; renderDetail(); }, { class: 'places-btn places-btn-quiet' }), save));
        form.onsubmit = event => { event.preventDefault(); confirmAction({ title: `Change ${member.name}’s world membership?`, text: `Set their role to ${draft.role} and tags to ${tagsFrom(draft.tags).join(', ') || 'none'} in ${item.name}. Permissions change immediately in this world, including active room editing. Other worlds are unchanged.`, label: 'Save membership', danger: false, anchor: save, action: async () => { await api(`/api/worlds/${enc(item.id)}/members/${enc(memberId)}`, { method: 'PUT', body: { role: draft.role, tags: tagsFrom(draft.tags) } }); memberDraft = null; await loadMembers(item); await changed('World membership saved.'); } }); };
        card.append(form);
      }
      section.append(card);
    }
    if (data && !data.members.length) section.append(empty('There are no explicit members in this world.'));
    detail.append(section);
    const add = el('section', { class: 'places-section' }, el('h3', { text: 'Add or invite a local account' }), muted('Choose an existing registered account on this server. An invitation asks them to accept; adding a member grants access immediately.'));
    const searchForm = el('form', { class: 'places-form', 'aria-label': 'Find local account' });
    const query = input({ type: 'search', value: accountQuery, required: true, minlength: 2, maxlength: 80, placeholder: 'Name or username', 'data-place-field': 'account-search', oninput: event => { accountQuery = event.target.value; } });
    const searchButton = btn('Find account', null, { type: 'submit' });
    searchForm.append(field('Local account', query, 'Search by at least two characters, then select the exact account.'), actions(searchButton));
    searchForm.onsubmit = event => { event.preventDefault(); if (!searchForm.reportValidity()) return; const searchVersion = ++accountRequest; perform(`accounts:${searchVersion}`, searchButton, async () => { const result = await api(`/api/accounts?worldId=${enc(item.id)}&query=${enc(accountQuery.trim())}`); if (searchVersion !== accountRequest || selected?.id !== item.id) return; accountResults = (result.users || []).filter(account => account.id !== user().id); selectedAccount = null; renderDetail(); }); };
    add.append(searchForm);
    if (accountResults.length) for (const account of accountResults) add.append(btn(`${account.name} · @${account.username}`, () => { selectedAccount = account; inviteDraft = { role: 'member', tags: '' }; renderDetail(); }, { class: 'places-btn places-account-result', 'aria-pressed': String(selectedAccount?.id === account.id), 'aria-label': `Select account ${account.username}` }));
    if (accountQuery && accountRequest && !accountResults.length) add.append(muted('No account results loaded. Search again or ask them to register a local account first.'));
    if (selectedAccount) {
      const target = selectedAccount, draft = inviteDraft;
      const form = el('form', { class: 'places-form places-section', 'aria-label': `Invite ${target.username}` }, el('h4', { class: 'places-card-title', text: `Selected: ${target.name} (@${target.username})` }), ...roleFields(draft, `invite-${item.id}`), muted(`Destination: ${item.name}. Invitations expire after the server’s stated period and appear in this account’s in-app inbox. No email is sent.`));
      const invite = btn('Send invitation', null, { type: 'submit', class: 'places-btn places-btn-primary' });
      const addButton = btn('Add member now', event => confirmAction({ title: `Add ${target.name} to ${item.name}?`, text: `This grants ${target.username} immediate ${draft.role} membership with tags ${tagsFrom(draft.tags).join(', ') || 'none'} in this world, including access to all its private rooms. Existing room-specific roles still apply. They do not need to accept an invitation. Existing membership would be updated to these values.`, label: 'Add member', danger: false, anchor: event.currentTarget, action: async () => { await api(`/api/worlds/${enc(item.id)}/members/${enc(target.id)}`, { method: 'PUT', body: { role: draft.role, tags: tagsFrom(draft.tags) } }); selectedAccount = null; accountResults = []; accountQuery = ''; await loadMembers(item); await changed('World member added.'); } }));
      form.append(actions(addButton, cap(item, 'canInvite') && invite));
      let inviteOperation = operationId();
      form.onsubmit = event => { event.preventDefault(); if (!cap(item, 'canInvite')) return; perform(`invite:${item.id}:${target.id}`, invite, async () => { await api(`/api/worlds/${enc(item.id)}/invitations`, { method: 'POST', body: { userId: target.id, role: draft.role, tags: tagsFrom(draft.tags), clientOperationId: inviteOperation } }); selectedAccount = null; accountResults = []; accountQuery = ''; await loadMembers(item); await changed('Invitation sent to their local account inbox.'); }); };
      add.append(form);
    }
    detail.append(add);
    const pending = el('section', { class: 'places-section' }, el('h3', { text: 'World invitations' }));
    for (const invitation of data?.invitations || []) pending.append(invitationCard(invitation, true));
    if (data && !data.invitations.length) pending.append(empty('No invitations for this world.'));
    detail.append(pending);
  }
  function invitationCard(invitation, outgoing = false) {
    const recipient = invitation.recipient || {};
    const title = outgoing ? `${recipient.name || recipient.username || 'Local account'}${recipient.username ? ` (@${recipient.username})` : ''}` : invitation.worldName || 'World invitation';
    const card = el('article', { class: 'places-card', 'data-invitation-id': invitation.id }, el('h3', { class: 'places-card-title', text: title }), el('div', { class: 'places-tags' }, badge(invitation.status), badge(`World role: ${invitation.role}`), (invitation.tags || []).map(t => badge(t))), muted(outgoing ? `Expires: ${formatDate(invitation.expiresAt)}` : `From ${invitation.inviter?.name || invitation.inviter?.username || 'a world manager'}${invitation.inviter?.username ? ` (@${invitation.inviter.username})` : ''}. Expires: ${formatDate(invitation.expiresAt)}`));
    if (invitation.status === 'pending') {
      if (outgoing) card.append(actions(btn('Cancel invitation', event => confirmAction({ title: 'Cancel this invitation?', text: 'This prevents the recipient from accepting this pending invitation. It does not remove an existing membership. If they already accepted elsewhere, the server will report that outcome.', label: 'Cancel invitation', anchor: event.currentTarget, action: async () => { await api(`/api/invitations/${enc(invitation.id)}/cancel`, { method: 'POST', body: {} }); if (selectedItem()) await loadMembers(selectedItem()); await changed('Invitation cancelled.'); } }), { class: 'places-btn places-btn-danger' })));
      else {
        card.append(muted('Accepting grants membership and access to this world’s private rooms. Existing room-specific roles still apply. If you are already a member, your existing role and tags are kept.'));
        const accept = btn('Accept invitation', () => perform(`accept:${invitation.id}`, accept, async () => { try { await api(`/api/invitations/${enc(invitation.id)}/accept`, { method: 'POST', body: {} }); await changed('Invitation accepted. Your membership is ready.'); } catch (error) { await refresh({ silent: true }); throw error; } }), { class: 'places-btn places-btn-primary' });
        const reject = btn('Decline invitation', () => perform(`reject:${invitation.id}`, reject, async () => { try { await api(`/api/invitations/${enc(invitation.id)}/reject`, { method: 'POST', body: {} }); await changed('Invitation declined. No membership was added.'); } catch (error) { await refresh({ silent: true }); throw error; } }), { class: 'places-btn places-btn-quiet' });
        card.append(actions(reject, accept));
      }
    }
    return card;
  }
  function renderInvitations() {
    const pane = el('section', { class: 'places-list-view' }, el('div', { class: 'places-list-header' }, el('div', {}, el('h3', { class: 'places-subheading', text: 'Your invitation inbox' }), muted('Addressed to your local account. Membership starts only when you accept.')), btn('Refresh inbox', () => refresh(), { class: 'places-btn places-btn-quiet' })));
    if (!user().account) pane.append(notice('Register a local account from Profile to receive targeted invitations. Your current guest profile can still explore public places.'));
    if (!invitations.length) pane.append(empty('No invitations yet.'));
    const sorted = [...invitations].sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || Number(b.createdAt) - Number(a.createdAt));
    for (const invitation of sorted) pane.append(invitationCard(invitation));
    body.replaceChildren(pane);
  }
  function renderMemberships() {
    const pane = el('section', { class: 'places-list-view' }, el('div', { class: 'places-list-header' }, el('div', {}, el('h3', { class: 'places-subheading', text: 'Your world memberships' }), muted('These are explicit world memberships. Visiting a public room does not create one.')), btn('Refresh memberships', () => refresh(), { class: 'places-btn places-btn-quiet' })));
    if (!memberships.length) pane.append(empty('You have no explicit world memberships yet. Explore a public world or accept a local invitation.'));
    for (const member of memberships) {
      const world = index.get(keyOf('world', member.worldId));
      const card = el('article', { class: 'places-card' }, el('h3', { class: 'places-card-title', text: member.worldName || world?.name || 'World' }), el('div', { class: 'places-tags' }, badge(`World role: ${member.role}`), (member.tags || []).map(t => badge(t))));
      const controls = actions();
      if (world) controls.append(btn('View world', () => { activeTab = 'explore'; select('world', member.worldId); }, { 'aria-label': `View membership world ${member.worldName || world.name}` }));
      if (member.canLeave !== false) controls.append(btn('Leave world', event => confirmAction({ title: `Leave ${member.worldName || 'this world'}?`, text: 'Your world membership, role and tags will be removed. Editing permissions end immediately. You will be disconnected from any private room you can no longer access; public places may still be visited as a guest. You may need a new invitation to return.', label: 'Leave world', anchor: event.currentTarget, action: async () => { await api(`/api/worlds/${enc(member.worldId)}/leave`, { method: 'POST', body: {} }); await changed('You left the world membership.'); } }), { class: 'places-btn places-btn-danger' }));
      else card.append(muted('The protected owner or last administrator cannot leave this world.'));
      card.append(controls); pane.append(card);
    }
    body.replaceChildren(pane);
  }
  function onEvent({ type, data } = {}) {
    if (destroyed) return;
    if (!['catalog', 'membership', 'invitation', 'role', 'access-revoked', 'room', 'members'].includes(type)) return;
    if (type === 'access-revoked') { errorText = 'Your access changed. Choose an available place to continue.'; renderStatus(); }
    if (root.hidden) return;
    clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh({ silent: true }), 120);
  }
  function destroy() {
    destroyed = true; focusObserver.disconnect(); window.removeEventListener('resize', retainFocus); document.removeEventListener('keydown', recoverKeys, true); document.removeEventListener('keyup', recoverKeys, true); request++; clearTimeout(refreshTimer); dismissConfirm(false); root.removeEventListener('keydown', stopKeys); root.removeEventListener('keyup', stopKeys); root.replaceChildren(); drafts.clear(); creationDrafts.clear(); memberCache.clear();
  }
  return { open, close, isOpen: () => !root.hidden, onEvent, refresh, destroy };
}
