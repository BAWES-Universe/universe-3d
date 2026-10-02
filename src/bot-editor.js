import {createResidentTestPanel} from './resident-test.js';
import {icon as sourceIcon} from './universe-icons.js';
import { AVATAR_OPTIONS, AVATAR_PALETTES, DEFAULT_APPEARANCE, normalizeAppearance, validateAppearance } from './avatar-spec.js';
import './bot-editor.css';

const copy = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const operationId = () => globalThis.crypto?.randomUUID?.() || `resident-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const CONFIG_KEYS = ['name', 'enabled', 'appearance', 'spawn', 'radius', 'responseRadius', 'behavior', 'waypoints', 'speed', 'pauseMs', 'loop', 'respondToPlayers', 'privateInstructions', 'restrictedAreaIds', 'permissions', 'modelPermissions'];
const BEHAVIORS = { idle: 'Stay at home', patrol: 'Follow a route', social: 'Social · public chat off' };
const TOOL_LABELS = { pause: 'Pause movement', resume: 'Resume movement', return: 'Return home & pause' };
const APPEARANCE_FIELDS = [['height', 'Height'], ['build', 'Build'], ['skin', 'Skin tone'], ['hairStyle', 'Hair'], ['hairColor', 'Hair color'], ['eyeColor', 'Eye color'], ['topStyle', 'Top'], ['topColor', 'Top color'], ['bottomStyle', 'Bottoms'], ['bottomColor', 'Bottoms color'], ['shoeStyle', 'Shoes'], ['shoeColor', 'Shoe color'], ['hat', 'Hat'], ['glasses', 'Glasses'], ['bag', 'Bag'], ['headphones', 'Headphones']];
const COLORS = { skin: ['Porcelain peach', 'Warm sand', 'Caramel', 'Chestnut', 'Rich brown', 'Deep cocoa', 'Rose beige', 'Copper rose'], hairColor: ['Midnight', 'Espresso', 'Chestnut', 'Copper', 'Golden blond', 'Silver cream', 'Lavender', 'Dusty rose', 'Ocean teal'], eyeColor: ['Midnight', 'Hazel', 'Forest', 'Blue', 'Violet'], topColor: ['Universe violet', 'Plum', 'Golden yellow', 'Dusty rose', 'Sage teal', 'Denim', 'Cream', 'Ink'], bottomColor: ['Ink', 'Slate', 'Cocoa', 'Lavender', 'Sand', 'Deep teal', 'Burgundy', 'Forest'], shoeColor: ['Cream', 'Ink', 'Violet', 'Gold', 'Rose', 'Teal'] };
let editorSequence = 0;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (['hidden', 'disabled', 'checked', 'required'].includes(key)) node[key] = Boolean(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
const button = (text, onclick, attrs = {}) => el('button', { type: 'button', onclick, ...attrs }, text);
const hint = text => el('p', { class: 'resident-hint', text });
const row = (...children) => el('div', { class: 'resident-row' }, children);
const section = (title, ...children) => el('section', { class: 'resident-section' }, el('h3', { text: title }), children);
const badge = (text, modifier = '') => el('span', { class: `resident-badge ${modifier}`, text });
function svg(tag, attrs, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
  for (const child of children) node.append(child);
  return node;
}
function sourceMark(){const mark=el('span',{class:'resident-welcome-orbit','aria-hidden':'true'});mark.innerHTML=sourceIcon('Orbit');return mark;}
function readPath(object, path) { return path.split('.').reduce((value, key) => value?.[key], object); }
function writePath(object, path, value) { const keys = path.split('.'), last = keys.pop(); keys.reduce((value, key) => value[key], object)[last] = value; }
function roomInfo(room) { return typeof room === 'string' ? { id: room, name: room } : room && { ...room, id: String(room.id || '') }; }
function defaults(room) {
  return { name: 'New resident', enabled: true, appearance: copy(DEFAULT_APPEARANCE), spawn: copy(room?.suggestedBotSpawn || room?.scene?.spawn || { x: 0, z: 0 }), radius: 6, responseRadius: 3, behavior: 'idle', waypoints: [], speed: 1.5, pauseMs: 1000, loop: true, respondToPlayers: true, privateInstructions: '', restrictedAreaIds: [], permissions: { pause: true, resume: true, return: true }, modelPermissions: { pause: false, resume: false, return: false } };
}
function configFrom(record, room) {
  const source = record?.config || record || {}, result = defaults(room);
  for (const key of CONFIG_KEYS) if (source[key] !== undefined) result[key] = copy(source[key]);
  result.appearance = normalizeAppearance(result.appearance);
  return result;
}
async function defaultRequest(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error?.message || data.message || (typeof data.error === 'string' ? data.error : 'The resident request failed.')); error.status = response.status; error.code = data.code; error.data = data; throw error; }
  return data;
}

/** Room-scoped resident authoring. Every field and map handle writes into one
 * canonical draft. CAS saves drain serially; ambiguous retries reuse the exact
 * operation and body. No credential or external-provider controls are exposed.
 * onPreview receives {roomId, botId, bot: config|null}; it never means a durable save.
 */
export function createBotEditor({ getRoom = () => null, getActorId = () => null, request = defaultRequest, onPreview = () => {}, onClose = () => {}, onSaved = () => {}, onFocus = () => {}, host = document.body } = {}) {
  const uid = `resident-editor-${++editorSequence}`;
  // Deliberately memory-only: never store private instructions across reloads or
  // accounts. Navigation preserves a new draft; only explicit Save/Create commits it.
  const newDrafts = new Map();
  let actorId = getActorId();
  let opened = false, destroyed = false, session = null, navigation = 0, closePromise = null, returnFocus = null;
  const root = el('div', { class: 'resident-editor', hidden: true, 'data-testid': 'bot-editor' });
  const panel = el('section', { class: 'resident-panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': `${uid}-title`, tabindex: '-1' });
  const roomLabel = el('p', { class: 'resident-room' });
  const backButton = button('← Residents', back, { class: 'resident-back', 'aria-label': 'Back to residents' });
  const closeButton = button('×', close, { class: 'resident-close', 'aria-label': 'Save and close residents', title: 'Save and close (Escape)' });
  const header = el('header', { class: 'resident-header' }, el('div', {}, el('span', { class: 'resident-eyebrow', text: 'BRING YOUR WORLD TO LIFE' }), el('h2', { id: `${uid}-title`, text: 'Room residents' }), roomLabel), closeButton);
  const list = el('div', { class: 'resident-list', 'aria-label': 'Room residents' });
  const newButton = button('+ Create resident', () => select(null), { class: 'resident-primary', 'data-testid': 'bot-create' });
  const listHeading = el('div', { class: 'resident-list-heading' });
  const sidebar = el('aside', { class: 'resident-sidebar' }, listHeading, list, newButton);
  const detail = el('div', { class: 'resident-detail' });
  const content = el('div', { class: 'resident-content' }, sidebar, detail);
  const errorBox = el('div', { class: 'resident-error', role: 'alert', hidden: true });
  const recovery = el('div', { class: 'resident-recovery', hidden: true });
  const status = el('p', { class: 'resident-save-status', role: 'status', 'aria-live': 'polite' });
  const saveButton = button('Save resident', save, { class: 'resident-primary', 'data-testid': 'bot-save' });
  const resetButton = button('Reset draft', reset, { class: 'resident-secondary', 'data-testid': 'bot-reset' });
  const footer = el('footer', { class: 'resident-footer' }, el('div', { class: 'resident-footer-copy' }, errorBox, recovery, status), el('div', { class: 'resident-footer-buttons' }, resetButton, saveButton));
  panel.append(header, backButton, content, footer); root.append(panel); host.append(root);

  const active = s => !!s && !destroyed && opened && session === s && s.actorId === getActorId();
  const dirty = s => !!s?.draft && (!s.record || !same(s.draft, s.baseline));
  const endpoint = s => `/api/rooms/${encodeURIComponent(s.room.id)}/bots`;
  const busy = s => !!(s?.saving || s?.deleting || s?.commanding);
  function testContext() { const s=session;if(!active(s)||!s.record)return null;const capability=s.catalog?.residentTest||{};return {actorId:s.actorId,roomId:s.room.id,botId:s.record.id,revision:s.record.revision,saved:true,enabled:s.record.enabled,respondToPlayers:s.record.respondToPlayers,dirty:dirty(s)||s.conflict,busy:busy(s),canManage:s.canManage,available:capability.available===true,mode:capability.mode,limits:capability.limits}; }
  const testPanel=createResidentTestPanel({request,getContext:testContext});
  function syncActor() {
    const next = getActorId();
    if (next === actorId) return;
    const previous = session;
    actorId = next; navigation++; newDrafts.clear(); session = null;
    try { if (previous) onPreview({ roomId: previous.room.id, botId: previous.record?.id || null, bot: null }); } catch { /* Clear private data even if preview cleanup fails. */ }
    roomLabel.textContent = ''; renderList(); renderDetail(); renderStatus();
  }
  function keepNewDraft(s) {
    if (active(s) && s.draft && !s.record) newDrafts.set(s.room.id, { draft: copy(s.draft), pendingOperation: s.pendingOperation ? copy(s.pendingOperation) : null, error: s.error || '' });
  }
  function restoreNewDraft(s) {
    const kept = newDrafts.get(s.room.id);
    if (!kept || !active(s) || !s.canManage || !s.catalog.appearances?.length) return false;
    s.record = null; s.baseline = null; s.draft = copy(kept.draft); s.pendingOperation = kept.pendingOperation ? copy(kept.pendingOperation) : null; s.error = kept.error;
    return true;
  }
  async function leaveDraft(s) {
    if (!s?.draft) return true;
    if (s.record) return save();
    // A Create already requested by the user may settle, but leaving never starts
    // or retries a POST. Preserve its exact receipt after an ambiguous failure.
    if (s.saving) {
      const saved = await s.saving;
      if (!active(s)) return false;
      if (s.record) return saved;
    }
    keepNewDraft(s);
    return active(s);
  }
  function preview(s = session) {
    if (!active(s)) return;
    try { onPreview({ roomId: s.room.id, botId: s.record?.id || null, bot: s.draft ? copy(s.draft) : null }); } catch { /* A rendering failure must not discard authored data. */ }
  }
  function setError(s, error, fallback) {
    if (!active(s)) return;
    s.error = error?.message || fallback || 'Something went wrong. Your draft is still here.';
    if (error?.status === 409 && (!error.code && !error.data?.code || (error.code || error.data?.code) === 'BOT_REVISION_CONFLICT')) { s.conflict = true; s.error = `${s.error} Another editor changed this resident. Your draft is kept; reload the saved version to continue.`; }
    renderStatus();
  }
  function renderStatus() {
    testPanel.update();
    const s = session;
    errorBox.hidden = !s?.error; errorBox.textContent = s?.error || '';
    recovery.hidden = !s?.conflict && !(s?.draft && !s.canManage);
    recovery.replaceChildren();
    if (s?.conflict) recovery.append(button('Reload saved version', () => reloadSelected(), { class: 'resident-secondary' }), hint('Reload replaces this draft. You can review and copy your text first.'));
    if(s?.draft&&!s.canManage)recovery.append(button('Download draft',()=>{if(!active(s))return;const url=URL.createObjectURL(new Blob([JSON.stringify({format:'universe-resident-draft',roomId:s.room.id,config:s.draft},null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='resident-draft.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}),button('Discard draft and close',()=>{if(!active(s)||busy(s))return;if(s.pendingOperation){setError(s,new Error('The last save has not been acknowledged. Keep this draft until you can retry the same operation.'));return;}if(!s.record)newDrafts.delete(s.room.id);clearDraft(s);close();}),hint('Your management access changed. Saving is disabled; keep a copy or leave this editor.'));
    const localDraftNotice = 'Draft kept in this tab · Reloading or signing out clears it';
    status.textContent = !s ? 'Choose a room to manage its residents.' : s.loading ? 'Loading this room’s residents…' : s.saving ? 'Saving to the room…' : s.deleting ? 'Deleting resident…' : s.commanding ? 'Sending local command…' : s.error ? `Your draft is still here.${!s.record ? ` ${localDraftNotice}.` : ' Nothing has been silently discarded.'}` : s.draft ? dirty(s) ? (s.record ? 'Changes pending · Back or Close saves them' : `Not created yet · Choose Create resident to save · ${localDraftNotice}`) : s.info || 'All changes saved to this room' : newDrafts.has(s.room.id) ? localDraftNotice : s.info || 'Disabled residents stay here and can be edited.';
    status.classList.toggle('is-dirty', dirty(s));
    saveButton.hidden = !s?.draft; resetButton.hidden = !s?.draft;
    saveButton.disabled = !s?.canManage || busy(s) || s?.conflict || !dirty(s);
    saveButton.textContent = s?.saving ? 'Saving…' : s?.record ? 'Save resident' : 'Create resident';
    resetButton.disabled = busy(s) || !dirty(s);
    resetButton.textContent = s?.record ? 'Reset draft' : 'Discard draft';
    newButton.disabled = !s?.canManage || !!s?.loading || busy(s) || !s?.catalog?.appearances?.length;
    newButton.textContent = s && newDrafts.has(s.room.id) ? 'Resume new resident draft' : '+ Create resident';
    backButton.hidden = !s?.draft;
    closeButton.disabled = !!(s?.deleting || s?.commanding);
    closeButton.setAttribute('aria-label', s?.record ? 'Save and close residents' : 'Close residents');
    closeButton.title = s?.record ? 'Save and close (Escape)' : 'Close; keep draft in this tab (Escape)';
    panel.setAttribute('aria-busy', String(!!s?.loading));
    root.dataset.detail = String(!!s?.draft);
  }
  function renderList() {
    const s = session;
    list.replaceChildren();
    listHeading.replaceChildren(el('strong', { text: 'This room' }), badge(String(s?.bots?.length || 0)));
    if (!s || s.loading) list.append(hint('Loading residents…'));
    else if (s.loadFailed) list.append(hint('Residents could not be loaded.'), button('Try again', () => loadRoom(s.room), { class: 'resident-secondary' }));
    else if (!s.canManage) list.append(hint('Your current room role cannot manage residents.'));
    else if (!s.bots.length) list.append(el('div', { class: 'resident-empty' }, sourceMark(), el('strong', { text: 'A little more life' }), hint('Create a resident to welcome a space or walk a route.')));
    for (const bot of s?.bots || []) {
      const data = configFrom(bot, s.room), selected = s.record?.id === bot.id;
      const avatar = el('span', { class: 'resident-swatch', 'aria-hidden': 'true', text: data.name?.slice(0, 1)?.toUpperCase() || 'R' }); avatar.style.setProperty('--resident-color', data.appearance.topColor);
      const item = button('', () => select(bot.id), { class: `resident-list-item${selected ? ' is-selected' : ''}`, 'aria-pressed': String(selected), 'data-bot-id': bot.id });
      item.append(avatar, el('span', { class: 'resident-list-copy' }, el('strong', { text: data.name }), el('small', { text: `${data.enabled ? 'Enabled' : 'Disabled'} · ${data.behavior === 'patrol' ? 'Patrol' : data.behavior === 'social' ? 'Social, unconnected' : 'Idle'}` })), el('span', { class: `resident-dot ${data.enabled ? 'is-enabled' : ''}`, 'aria-hidden': 'true' }));
      list.append(item);
    }
  }
  function applyChange(s, draft, path, value, { rebuild = false } = {}) {
    if (!active(s) || s.draft !== draft || !s.canManage || s.deleting || s.commanding) return false;
    writePath(draft, path, value);
    s.info = ''; s.deleteConfirm = false;
    if (rebuild) renderDetail(); else { syncFields(); renderPlan(); }
    renderStatus(); preview(s);
    return true;
  }
  function field(s, draft, path, label, type = 'text', options = {}) {
    const id = `${uid}-${path.replaceAll('.', '-')}`;
    const control = type === 'textarea' ? el('textarea', { rows: 4 }) : type === 'select' ? el('select') : el('input', { type });
    control.id = id; control.dataset.botField = path;
    if (type === 'select') for (const option of options.choices || []) control.append(el('option', { value: option.id, text: option.label || option.name || option.id }));
    for (const key of ['min', 'max', 'step', 'maxlength', 'placeholder']) if (options[key] !== undefined) control.setAttribute(key, String(options[key]));
    if (type === 'checkbox') control.checked = Boolean(readPath(draft, path));
    else { const value = readPath(draft, path); control.value = Number.isNaN(value) ? '' : value ?? ''; }
    control.addEventListener(type === 'checkbox' || type === 'select' ? 'change' : 'input', () => {
      const value = type === 'checkbox' ? control.checked : type === 'number' ? (control.value.trim() === '' ? NaN : Number(control.value)) : control.value;
      applyChange(s, draft, path, value, { rebuild: options.rebuild });
    });
    const labelNode = el('label', { class: `resident-field${type === 'checkbox' ? ' resident-check' : ''}`, for: id });
    labelNode.append(...(type === 'checkbox' ? [control, el('span', { text: label })] : [el('span', { text: label }), control]));
    if (options.hint) { const help = el('small', { id: `${id}-help`, text: options.hint }); control.setAttribute('aria-describedby', help.id); labelNode.append(help); }
    return labelNode;
  }
  function syncFields() {
    const draft = session?.draft; if (!draft) return;
    for (const control of detail.querySelectorAll('[data-bot-field]')) {
      const value = readPath(draft, control.dataset.botField);
      if (control.type === 'checkbox') control.checked = !!value;
      else if (document.activeElement !== control) control.value = Number.isNaN(value) ? '' : value ?? '';
    }
    for (const control of detail.querySelectorAll('[data-live-command]')) control.disabled = !session.record || !draft.enabled || !draft.permissions[control.dataset.liveCommand] || busy(session) || session.conflict;
  }
  function renderDetail() {
    testPanel.update();
    const s = session, draft = s?.draft;
    const focusedTestControl=testPanel.element.contains(document.activeElement)?document.activeElement:null;
    const scrollTop = detail.scrollTop, focusPath = detail.contains(document.activeElement) ? document.activeElement.dataset.botField : null, selectionStart = document.activeElement?.selectionStart, selectionEnd = document.activeElement?.selectionEnd;
    const folds = [...detail.querySelectorAll('details[open]')].map(node => node.querySelector('summary')?.textContent);
    detail.replaceChildren();
    if (!draft) {
      detail.append(el('div', { class: 'resident-welcome' }, sourceMark(), el('h3', { text: 'Meet your room’s residents' }), hint('Original 3D characters, with a place to belong and a route of their own.'), el('ul', {}, el('li', { text: 'Give each resident their own look' }), el('li', { text: 'Set a home and an ordered patrol' }), el('li', { text: 'Choose local tools and permissions' })), el('div', { class: 'resident-provider-note' }, badge(s?.catalog?.residentTest?.available?'Local protocol available':'AI unconnected'), hint('Public resident conversation and external tools are not connected. Configured private tests are available only for saved residents.'))));
      return;
    }
    const heading = el('div', { class: 'resident-detail-heading' }, el('h3', { text: s.record ? 'Resident details' : 'A new resident' }), badge(s.record ? `Revision ${s.record.revision}` : 'Not saved', s.record ? '' : 'is-draft'));
    const identity = section('Identity', field(s, draft, 'name', 'Resident name', 'text', { maxlength: 60, placeholder: 'A name for this resident' }), field(s, draft, 'enabled', 'Enabled in this room', 'checkbox', { hint: 'Disabling removes this resident from the world, while keeping the configuration here.' }));
    const presets = el('div', { class: 'resident-presets', 'aria-label': 'Original 3D appearance presets' });
    for (const preset of s.catalog.appearances || []) {
      const choice = button(preset.name || preset.id, () => applyChange(s, draft, 'appearance', normalizeAppearance(preset.appearance), { rebuild: true }), { 'aria-pressed': String(same(draft.appearance, normalizeAppearance(preset.appearance))), 'data-appearance-id': preset.id });
      choice.style.setProperty('--resident-color', normalizeAppearance(preset.appearance).topColor); presets.append(choice);
    }
    const wardrobe = el('details', { class: 'resident-fold' }, el('summary', { text: 'Customize this look' }));
    const appearanceGrid = el('div', { class: 'resident-field-grid' });
    for (const [key, label] of APPEARANCE_FIELDS) {
      const path = ['height', 'build'].includes(key) ? `appearance.body.${key}` : `appearance.${key}`;
      const choices = AVATAR_OPTIONS[key] || AVATAR_PALETTES[key].map((id, index) => ({ id, label: COLORS[key][index] }));
      appearanceGrid.append(field(s, draft, path, label, 'select', { choices }));
    }
    wardrobe.append(appearanceGrid);
    const appearance = section('Original 3D appearance', hint('These looks use the same native 3D wardrobe as players.'), presets, wardrobe);
    const placement = section('Home & movement area', el('div', { class: 'resident-room-lock' }, el('span', { 'aria-hidden': 'true', text: '⌖' }), el('span', { text: s.room.name || s.room.id }), badge('Room locked')), hint('Select another room in the world to manage its residents.'), row(field(s, draft, 'spawn.x', 'Home X', 'number', { step: .1 }), field(s, draft, 'spawn.z', 'Home Z', 'number', { step: .1 })), row(field(s, draft, 'radius', 'Movement radius', 'number', { min: 0, max: 100, step: .5, hint: 'Zero keeps this resident at home.' }), field(s, draft, 'responseRadius', 'Response radius', 'number', { min: 0, max: 20, step: .5, hint: 'No replies until AI is connected.' })));
    placement.append(button('Focus resident on map', () => focus(s), { class: 'resident-secondary', 'data-testid': 'bot-focus' }));
    placement.append(el('div', { class: 'resident-plan-wrap' }, el('div', { class: 'resident-plan-heading' }, el('strong', { text: 'Room plan' }), el('span', { text: 'Drag home, route points or radius' })), el('div', { 'data-plan-host': '', class: 'resident-plan-host' }), hint('Preview only until saved. The room server checks positions and obstructions.')));
    const areas = s.room.scene?.areas || [];
    if (areas.length) {
      const restricted = el('details', { class: 'resident-fold' }, el('summary', { text: 'Keep out of areas' }), hint('Selected areas are off-limits for this resident’s movement.'));
      for (const area of areas) {
        const check = el('input', { type: 'checkbox', checked: draft.restrictedAreaIds.includes(area.id), 'data-restricted-area': area.id });
        check.addEventListener('change', () => applyChange(s, draft, 'restrictedAreaIds', check.checked ? [...new Set([...draft.restrictedAreaIds, area.id])] : draft.restrictedAreaIds.filter(id => id !== area.id)));
        restricted.append(el('label', { class: 'resident-check' }, check, el('span', { text: area.name || area.id })));
      }
      placement.append(restricted);
    }
    const availableBehaviors = (s.catalog.behaviors || Object.keys(BEHAVIORS)).map(value => typeof value === 'string' ? value : value.id).filter(id => BEHAVIORS[id]);
    const behavior = section('Behavior', field(s, draft, 'behavior', 'Behavior', 'select', { choices: availableBehaviors.map(id => ({ id, label: BEHAVIORS[id] })), rebuild: true }), hint(draft.behavior === 'idle' ? 'Stays at its assigned home. A zero movement radius also keeps other behaviors stationary.' : draft.behavior === 'patrol' ? 'Walks the waypoints in the order below. Blocked paths stop safely; the server never teleports through furniture.' : 'Public resident conversation is not connected. A configured private manager test is separate and runs only when you request it.'));
    if (draft.behavior === 'patrol') behavior.append(renderWaypoints(s, draft), row(field(s, draft, 'speed', 'Walk speed', 'number', { min: .2, max: 4, step: .1 }), field(s, draft, 'pauseMs', 'Pause at each point (ms)', 'number', { min: 0, max: 60000, step: 100 })), field(s, draft, 'loop', 'Loop the patrol route', 'checkbox'));
    behavior.append(field(s, draft, 'respondToPlayers', 'Allow responses when AI becomes available', 'checkbox', { hint: 'Stored preference only. No connected AI means no replies or greetings.' }));
    const connected=s.catalog?.residentTest?.available===true;
    const intelligence = section('Instructions & connections', el('div', { class: 'resident-provider-note' }, badge(connected?'Local protocol available':'AI unconnected'), hint(connected?'Private manager tests can use the server-attached local protocol adapter. Public conversation and external MCP tools are not enabled.':'No provider is attached. Instructions are saved for managers and are not executed.')), field(s, draft, 'privateInstructions', 'Private resident instructions', 'textarea', { maxlength: 4000, placeholder: 'Guidance for this resident', hint: 'Private manager configuration. Do not enter passwords or API keys.' }));
    const modelTools=section('Model tool access',hint('Off by default. A test also needs the corresponding local permission and server-supported tool. Accepted commands affect this resident in the room.'));
    for(const [command,label] of Object.entries(TOOL_LABELS))modelTools.append(field(s,draft,`modelPermissions.${command}`,`Allow model: ${label.toLowerCase()}`,'checkbox'));
    const tools = section('Local tools & permissions', hint('Room managers can send these server-authorized commands. Each permission applies only to this resident.'));
    for (const [command, label] of Object.entries(TOOL_LABELS)) {
      const run = button(label, () => commandResident(command), { class: 'resident-secondary', 'data-live-command': command, disabled: !s.record || !draft.permissions[command] });
      tools.append(el('div', { class: 'resident-tool-row' }, field(s, draft, `permissions.${command}`, `Allow ${label.toLowerCase()}`, 'checkbox'), run));
    }
    if (!s.record) tools.append(hint('Save this resident before sending a command.'));
    const danger = el('div', { class: 'resident-danger' });
    if (s.record) danger.append(button('Delete resident', () => { if (!active(s) || s.draft !== draft || busy(s)) return; s.deleteConfirm = true; renderDeleteConfirmation(); }, { class: 'resident-delete', 'data-testid': 'bot-delete' }), el('div', { 'data-delete-confirmation': '' }));
    detail.append(heading, identity, appearance, placement, behavior, intelligence, tools, modelTools, ...(s.record?[testPanel.element]:[]), danger);
    for (const fold of detail.querySelectorAll('details')) fold.open = folds.includes(fold.querySelector('summary')?.textContent);
    detail.scrollTop = scrollTop; renderPlan(); syncFields(); renderDeleteConfirmation();
    if (focusPath) { const next = [...detail.querySelectorAll('[data-bot-field]')].find(node => node.dataset.botField === focusPath); next?.focus({ preventScroll: true }); if (typeof next?.setSelectionRange === 'function' && selectionStart != null) { try { next.setSelectionRange(selectionStart, selectionEnd); } catch { /* Number/select controls have no text selection. */ } } }
    else if(focusedTestControl?.isConnected){if(focusedTestControl.disabled)closeButton.focus({preventScroll:true});else{focusedTestControl.focus({preventScroll:true});if(typeof focusedTestControl.setSelectionRange==='function'&&selectionStart!=null)focusedTestControl.setSelectionRange(selectionStart,selectionEnd);}}
  }
  function renderDeleteConfirmation() {
    const s = session, place = detail.querySelector('[data-delete-confirmation]'); if (!place) return;
    place.replaceChildren();
    if (s.deleteConfirm) place.append(el('div', { class: 'resident-delete-confirmation' }, hint(`Delete “${s.draft.name}” and stop it in this room? This cannot be undone.`), row(button('Keep resident', () => { s.deleteConfirm = false; renderDeleteConfirmation(); }, { class: 'resident-secondary' }), button(s.deleting ? 'Deleting…' : 'Confirm delete', deleteResident, { class: 'resident-delete', disabled: busy(s) }))));
  }
  function renderWaypoints(s, draft) {
    const routes = el('div', { class: 'resident-routes' }, el('div', { class: 'resident-plan-heading' }, el('strong', { text: 'Patrol waypoints' }), badge(String(draft.waypoints.length))));
    if (!draft.waypoints.length) routes.append(hint('Add at least one waypoint to give this patrol a route.'));
    draft.waypoints.forEach((point, index) => {
      const mutate = fn => { const points = copy(draft.waypoints); fn(points); applyChange(s, draft, 'waypoints', points, { rebuild: true }); };
      const buttons = el('div', { class: 'resident-waypoint-tools' }, button('↑', () => mutate(points => [points[index - 1], points[index]] = [points[index], points[index - 1]]), { 'aria-label': `Move waypoint ${index + 1} earlier`, disabled: index === 0 }), button('↓', () => mutate(points => [points[index + 1], points[index]] = [points[index], points[index + 1]]), { 'aria-label': `Move waypoint ${index + 1} later`, disabled: index === draft.waypoints.length - 1 }), button('Insert after', () => mutate(points => { const next = points[index + 1] || draft.spawn; points.splice(index + 1, 0, { x: round((point.x + next.x) / 2), z: round((point.z + next.z) / 2) }); }), { 'aria-label': `Insert after waypoint ${index + 1}` }), button('Remove', () => mutate(points => points.splice(index, 1)), { 'aria-label': `Remove waypoint ${index + 1}` }));
      routes.append(el('div', { class: 'resident-waypoint', 'data-waypoint-index': index }, el('div', { class: 'resident-waypoint-heading' }, el('span', { class: 'resident-waypoint-number', text: index + 1 }), el('strong', { text: `Waypoint ${index + 1}` })), row(field(s, draft, `waypoints.${index}.x`, `Waypoint ${index + 1} X`, 'number', { step: .1 }), field(s, draft, `waypoints.${index}.z`, `Waypoint ${index + 1} Z`, 'number', { step: .1 })), buttons));
    });
    routes.append(button('+ Add waypoint', () => applyChange(s, draft, 'waypoints', [...draft.waypoints, copy(draft.waypoints.at(-1) || draft.spawn)], { rebuild: true }), { class: 'resident-secondary', disabled: draft.waypoints.length >= 64, 'data-testid': 'bot-add-waypoint' }));
    return routes;
  }
  const round = value => Math.round(value * 10) / 10;
  function renderPlan() {
    const s = session, draft = s?.draft, planHost = detail.querySelector('[data-plan-host]'); if (!draft || !planHost) return;
    const width = Number(s.room.scene?.bounds?.width) || 32, depth = Number(s.room.scene?.bounds?.depth) || 26;
    const viewW = 360, viewH = 220, padding = 22, scale = Math.min((viewW - padding * 2) / width, (viewH - padding * 2) / depth);
    const point = value => ({ x: viewW / 2 + (Number.isFinite(value.x) ? value.x : 0) * scale, y: viewH / 2 + (Number.isFinite(value.z) ? value.z : 0) * scale });
    const home = point(draft.spawn), arrowId = `${uid}-arrow`;
    const plan = svg('svg', { viewBox: `0 0 ${viewW} ${viewH}`, role: 'group', 'aria-label': `Room plan for ${draft.name}. Home and ${draft.waypoints.length} ordered waypoints.`, class: 'resident-plan' });
    plan.append(svg('defs', {}, svg('marker', { id: arrowId, markerWidth: 6, markerHeight: 6, refX: 5, refY: 3, orient: 'auto', markerUnits: 'strokeWidth' }, svg('path', { d: 'M0,0 L6,3 L0,6', fill: '#c1a1fc' }))));
    plan.append(svg('rect', { x: viewW / 2 - width * scale / 2, y: viewH / 2 - depth * scale / 2, width: width * scale, height: depth * scale, rx: 8, class: 'resident-plan-room' }));
    for (const object of s.room.scene?.objects || []) {
      const p = point(object), w = Number(object.width) || 1, d = Number(object.depth) || 1;
      plan.append(svg('rect', { x: p.x - w * scale / 2, y: p.y - d * scale / 2, width: w * scale, height: d * scale, rx: 1.5, class: 'resident-plan-object', transform: `rotate(${Number(object.rotation) || 0} ${p.x} ${p.y})` }));
    }
    for (const area of s.room.scene?.areas || []) if (draft.restrictedAreaIds.includes(area.id)) { const p = point(area); plan.append(svg('rect', { x: p.x - area.width * scale / 2, y: p.y - area.depth * scale / 2, width: area.width * scale, height: area.depth * scale, class: 'resident-plan-restricted' })); }
    const radius = Number.isFinite(draft.radius) ? Math.max(0, draft.radius) * scale : 0;
    plan.append(svg('circle', { cx: home.x, cy: home.y, r: radius, class: 'resident-plan-radius' }));
    if (draft.behavior === 'patrol') {
      const route = [draft.spawn, ...draft.waypoints];
      if (draft.loop && draft.waypoints.length > 1) route.push(draft.waypoints[0]);
      for (let i = 1; i < route.length; i++) { const a = point(route[i - 1]), b = point(route[i]); plan.append(svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'resident-plan-route', 'marker-end': `url(#${arrowId})` })); }
      draft.waypoints.forEach((value, index) => { const p = point(value), mark = svg('g', { 'data-plan-handle': 'waypoint', 'data-index': index, tabindex: 0, role: 'button', 'aria-label': `Move waypoint ${index + 1}. Arrow keys move half a unit.` }, svg('circle', { cx: p.x, cy: p.y, r: 10, class: 'resident-plan-waypoint' }), svg('text', { x: p.x, y: p.y + 3.5, 'text-anchor': 'middle', class: 'resident-plan-label' })); mark.lastChild.textContent = index + 1; const title = svg('title'); title.textContent = `Waypoint ${index + 1}: ${value.x}, ${value.z}`; mark.append(title); plan.append(mark); });
    }
    const homeMark = svg('g', { 'data-plan-handle': 'spawn', tabindex: 0, role: 'button', 'aria-label': `Move ${draft.name} home. Arrow keys move half a unit.` }, svg('circle', { cx: home.x, cy: home.y, r: 12, class: 'resident-plan-home' }), svg('path', { d: `M${home.x - 5},${home.y} L${home.x},${home.y - 5} L${home.x + 5},${home.y} V${home.y + 5} H${home.x - 5} Z`, class: 'resident-plan-home-icon' }));
    const radiusMark = svg('circle', { cx: home.x + radius, cy: home.y, r: 6, class: 'resident-plan-radius-handle', 'data-plan-handle': 'radius', tabindex: 0, role: 'button', 'aria-label': 'Resize movement radius. Arrow keys change half a unit.' });
    const homeTitle = svg('title'); homeTitle.textContent = `${draft.name} · home (${draft.spawn.x}, ${draft.spawn.z})`; homeMark.append(homeTitle);
    plan.append(homeMark, radiusMark);
    let drag = null;
    const apply = (kind, index, x, z) => {
      if (!active(s) || s.draft !== draft || busy(s)) return;
      if (kind === 'radius') applyChange(s, draft, 'radius', round(Math.max(0, Math.min(100, Math.hypot(x - draft.spawn.x, z - draft.spawn.z)))));
      else if (kind === 'spawn') applyChange(s, draft, 'spawn', { x: round(x), z: round(z) });
      else { const points = copy(draft.waypoints); if (!points[index]) return; points[index] = { x: round(x), z: round(z) }; applyChange(s, draft, 'waypoints', points); }
    };
    // Capture on the persistent host: the SVG can redraw without losing a drag.
    planHost.onpointerdown = event => {
      const handle = event.target.closest?.('[data-plan-handle]'); if (!handle || busy(s)) return;
      event.preventDefault(); event.stopPropagation(); drag = { kind: handle.dataset.planHandle, index: Number(handle.dataset.index), pointerId: event.pointerId }; planHost.setPointerCapture?.(event.pointerId);
    };
    planHost.onpointermove = event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const rect = planHost.querySelector('svg').getBoundingClientRect(), fit = Math.min(rect.width / viewW, rect.height / viewH), offsetX = (rect.width - viewW * fit) / 2, offsetY = (rect.height - viewH * fit) / 2;
      const x = ((event.clientX - rect.left - offsetX) / fit - viewW / 2) / scale, z = ((event.clientY - rect.top - offsetY) / fit - viewH / 2) / scale;
      // Retain this handler across redraws until pointerup.
      const move = planHost.onpointermove, up = planHost.onpointerup, cancel = planHost.onpointercancel;
      apply(drag.kind, drag.index, x, z); planHost.onpointermove = move; planHost.onpointerup = up; planHost.onpointercancel = cancel;
    };
    planHost.onpointerup = planHost.onpointercancel = event => { if (drag?.pointerId === event.pointerId) { drag = null; if (planHost.hasPointerCapture?.(event.pointerId)) planHost.releasePointerCapture(event.pointerId); } };
    plan.addEventListener('keydown', event => {
      const handle = event.target.closest?.('[data-plan-handle]'), direction = { ArrowLeft: [-.5, 0], ArrowRight: [.5, 0], ArrowUp: [0, -.5], ArrowDown: [0, .5] }[event.key]; if (!handle || !direction || busy(s)) return;
      event.preventDefault(); event.stopPropagation(); const kind = handle.dataset.planHandle, index = Number(handle.dataset.index);
      if (kind === 'radius') applyChange(s, draft, 'radius', Math.max(0, round(draft.radius + (direction[0] || -direction[1]))));
      else { const p = kind === 'spawn' ? draft.spawn : draft.waypoints[index]; apply(kind, index, p.x + direction[0], p.z + direction[1]); }
      planHost.querySelector(`[data-plan-handle="${kind}"]${kind === 'waypoint' ? `[data-index="${index}"]` : ''}`)?.focus();
    });
    planHost.replaceChildren(plan);
  }
  function validate(s, value) {
    if (!value.name?.trim()) throw new Error('Give this resident a name before saving.');
    if (value.name.trim().length > 60) throw new Error('Resident names must be 60 characters or fewer.');
    validateAppearance(value.appearance);
    if (!s.catalog.appearances?.length) throw new Error('This room’s original appearance catalog is unavailable. Reload the room before saving.');
    if (!Object.keys(BEHAVIORS).includes(value.behavior)) throw new Error('Choose a supported behavior.');
    for (const [key, min, max] of [['radius', 0, 100], ['responseRadius', 0, 20], ['speed', .2, 4], ['pauseMs', 0, 60000]]) {
      if (!Number.isFinite(value[key]) || value[key] < min || value[key] > max) throw new Error(`${({ radius: 'Movement radius', responseRadius: 'Response radius', speed: 'Walk speed', pauseMs: 'Pause time' })[key]} must be between ${min} and ${max}.`);
    }
    if (!Number.isInteger(value.pauseMs)) throw new Error('Pause time must be a whole number of milliseconds.');
    const positions = [['Home', value.spawn], ...value.waypoints.map((point, index) => [`Waypoint ${index + 1}`, point])];
    for (const [label, point] of positions) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) throw new Error(`${label} needs valid X and Z coordinates.`);
      const bounds = s.room.scene?.bounds;
      if (bounds && (Math.abs(point.x) > bounds.width / 2 || Math.abs(point.z) > bounds.depth / 2)) throw new Error(`${label} must stay inside this room’s bounds.`);
    }
    if (value.waypoints.length > 64) throw new Error('A route can contain up to 64 waypoints.');
    if (value.behavior === 'patrol' && value.enabled && !value.waypoints.length) throw new Error('Add a waypoint before enabling a patrol, or choose Stay at home.');
    if (value.privateInstructions.length > 4000) throw new Error('Private instructions must be 4,000 characters or fewer.');
    return value;
  }
  function save() {
    syncActor();
    const s = session;
    if (!active(s) || !s.draft) return Promise.resolve(true);
    if (s.saving) return s.saving;
    if(!s.canManage&&!dirty(s)&&!s.pendingOperation)return Promise.resolve(true);
    if (!s.canManage || s.loading || s.conflict || s.deleting || s.commanding) return Promise.resolve(false);
    if (!dirty(s) && !s.pendingOperation) return Promise.resolve(true);
    // Begin in a microtask, so even an immediately resolved request is serialized.
    s.saving = Promise.resolve().then(async () => {
      try {
        while (active(s) && s.canManage && (dirty(s) || s.pendingOperation)) {
          let operation = s.pendingOperation;
          if (!operation) {
            const snapshot = validate(s, copy(s.draft));
            const patch = Object.fromEntries(CONFIG_KEYS.filter(key => !same(snapshot[key], s.baseline?.[key])).map(key => [key, copy(snapshot[key])]));
            operation = { id: operationId(), recordId: s.record?.id || null, revision: s.record?.revision, snapshot, patch };
            s.pendingOperation = operation;
          }
          const data = await request(`${endpoint(s)}${operation.recordId ? `/${encodeURIComponent(operation.recordId)}` : ''}`, { method: operation.recordId ? 'PATCH' : 'POST', body: operation.recordId ? { clientOperationId: operation.id, revision: operation.revision, patch: copy(operation.patch) } : { clientOperationId: operation.id, config: copy(operation.snapshot) } });
          if (!active(s)) return false;
          if (!data?.bot?.id || !Number.isInteger(data.bot.revision)) throw new Error('The server did not acknowledge this resident. Retry to verify the same operation.');
          if (data.bot.roomId && data.bot.roomId !== s.room.id) throw new Error('The server returned a different room. Your draft has been kept.');
          const accepted = configFrom(data.bot, s.room), current = s.draft;
          // Preserve edits made while the snapshot was in flight; merge only fields
          // that still match that snapshot, then drain a second CAS if needed.
          for (const key of CONFIG_KEYS) if (same(current[key], operation.snapshot[key])) current[key] = copy(accepted[key]);
          s.record = copy(data.bot); s.baseline = copy(accepted); s.pendingOperation = null;
          if (!operation.recordId) newDrafts.delete(s.room.id);
          const index = s.bots.findIndex(bot => bot.id === data.bot.id);
          if (index < 0) s.bots.push(copy(data.bot)); else s.bots[index] = copy(data.bot);
          s.error = ''; s.conflict = false; s.info = 'Resident saved';
          try { Promise.resolve(onSaved(copy(data.bot), { roomId: s.room.id, action: operation.recordId ? 'update' : 'create' })).catch(() => {}); } catch { /* Persistence has already succeeded. */ }
          renderList(); syncFields(); renderStatus(); preview(s);
        }
        return !dirty(s) && !s.pendingOperation;
      } catch (error) {
        // A definitive application rejection did not persist the operation. A
        // network/5xx ambiguity keeps its exact id, revision and payload for retry.
        if (error?.status >= 400 && error.status < 500) s.pendingOperation = null;
        setError(s, error, 'Could not save this resident. Retry when the room server is available.');
        return false;
      } finally {
        s.saving = null;
        if (active(s)) { renderDetail(); renderStatus(); syncFields(); }
      }
    });
    renderStatus(); syncFields(); return s.saving;
  }
  function focus(s) { if (active(s) && s.draft) { try { onFocus(copy(s.draft.spawn)); } catch { /* Camera focus cannot discard the draft. */ } } }
  async function select(id) {
    syncActor();
    const s = session, token = ++navigation;
    if (!active(s) || s.loading || !s.canManage || s.deleting || s.commanding) return false;
    if (id && s.record?.id === id) return true;
    if (!id && s.draft && !s.record) return true;
    if (s.draft && !await leaveDraft(s)) return false;
    if (!active(s) || token !== navigation) return false;
    const record = id ? s.bots.find(bot => bot.id === id) : null;
    if (id && !record) { setError(s, new Error('That resident is no longer in this room. Reload the room list.')); return false; }
    if (!id && !s.catalog.appearances?.length) { setError(s, new Error('This room has no available resident appearances.')); return false; }
    s.record = record ? copy(record) : null; s.draft = configFrom(record, s.room); s.baseline = record ? copy(s.draft) : null;
    if (!record) s.draft.appearance = normalizeAppearance(s.catalog.appearances[0].appearance);
    s.error = ''; s.conflict = false; s.pendingOperation = null; s.deleteOperation = null; s.pendingCommand = null; s.deleteConfirm = false;
    if (!record) restoreNewDraft(s);
    renderList(); renderDetail(); detail.scrollTop = 0; renderStatus(); preview(s); focus(s);
    detail.querySelector('[data-bot-field="name"]')?.focus({ preventScroll: true }); return true;
  }
  async function back() {
    syncActor();
    const s = session, token = ++navigation;
    if (!active(s) || s.deleting || s.commanding) return false;
    if (!await leaveDraft(s) || !active(s) || token !== navigation) return false;
    clearDraft(s); newButton.focus(); return true;
  }
  function clearDraft(s) {
    s.record = null; s.draft = null; s.baseline = null; s.pendingOperation = null; s.deleteOperation = null; s.pendingCommand = null; s.deleteConfirm = false;
    s.error = ''; s.conflict = false; renderList(); renderDetail(); renderStatus(); preview(s);
  }
  function reset() {
    const s = session; if (!active(s) || !s.draft || busy(s)) return false;
    // An unknown network result must first be reconciled; resetting and issuing a
    // different create could otherwise duplicate an already committed resident.
    if (s.pendingOperation) { setError(s, new Error('The last save has not been acknowledged. Retry Save before resetting this draft.')); return false; }
    if (!s.record) { newDrafts.delete(s.room.id); clearDraft(s); return true; }
    s.draft = copy(s.baseline); s.deleteConfirm = false;
    if (!s.conflict) s.error = '';
    renderDetail(); renderStatus(); preview(s); return true;
  }
  async function reloadSelected() {
    const s = session;
    if (!active(s) || busy(s)) return false;
    if (!s.reloadConfirm) {
      s.reloadConfirm = true;
      recovery.replaceChildren(hint('Replace your unsaved draft with the current saved version?'), row(button('Keep draft', () => { s.reloadConfirm = false; renderStatus(); }, { class: 'resident-secondary' }), button('Replace draft', () => { s.reloadConfirm = false; fetchLatest(); }, { class: 'resident-primary' })));
      return false;
    }
    return false;
    async function fetchLatest() {
      const selectedId = s.record?.id, targetDraft = s.draft;
      try {
        const data = await request(endpoint(s));
        if (!active(s) || s.draft !== targetDraft) return false;
        if (!data?.capabilities?.canManage) throw new Error('Your current room role can no longer manage residents. Your draft is kept.');
        s.bots = copy(data.bots || []); s.catalog = copy(data.catalog || { appearances: [] });
        const latest = s.bots.find(bot => bot.id === selectedId);
        if (!latest) { clearDraft(s); s.info = 'This resident was deleted by another manager.'; renderStatus(); return true; }
        s.record = copy(latest); s.draft = configFrom(latest, s.room); s.baseline = copy(s.draft); s.error = ''; s.conflict = false; s.pendingOperation = null;
        renderList(); renderDetail(); renderStatus(); preview(s); return true;
      } catch (error) { setError(s, error); return false; }
    }
  }
  async function deleteResident() {
    const s = session;
    if (!active(s) || !s.record || !s.canManage || busy(s) || !s.deleteConfirm) return false;
    if (s.pendingOperation) { setError(s, new Error('Retry the unacknowledged Save before deleting this resident.')); return false; }
    const operation = s.deleteOperation ||= { clientOperationId: operationId(), revision: s.record.revision };
    const id = s.record.id; s.deleting = true; renderStatus(); renderDeleteConfirmation(); syncFields();
    try {
      const data = await request(`${endpoint(s)}/${encodeURIComponent(id)}`, { method: 'DELETE', body: copy(operation) });
      if (!active(s)) return false;
      if (!data?.deleted) throw new Error('The server did not confirm deletion. Retry the same delete operation.');
      s.bots = s.bots.filter(bot => bot.id !== id); s.deleteOperation = null;
      try { Promise.resolve(onSaved(null, { roomId: s.room.id, id, action: 'delete' })).catch(() => {}); } catch { /* A UI callback cannot undo server acknowledgement. */ }
      clearDraft(s); s.info = 'Resident deleted'; renderStatus(); return true;
    } catch (error) { if (error?.status >= 400 && error.status < 500) s.deleteOperation = null; setError(s, error); return false; }
    finally { s.deleting = false; if (active(s)) { renderStatus(); renderDeleteConfirmation(); syncFields(); } }
  }
  async function commandResident(command) {
    const s = session;
    if (!active(s) || !s.record || busy(s) || !s.draft.permissions[command]) return false;
    if (!await save() || !active(s)) return false;
    s.commanding = true; renderStatus(); syncFields();
    const operation = s.pendingCommand?.command === command && s.pendingCommandTarget === s.record.id ? s.pendingCommand : { clientOperationId: operationId(), command };
    s.pendingCommand = operation; s.pendingCommandTarget = s.record.id;
    try {
      const result = await request(`${endpoint(s)}/${encodeURIComponent(s.record.id)}/commands`, { method: 'POST', body: copy(operation) });
      if (!result?.accepted) throw new Error('The room server did not acknowledge this command. Retry to verify the same operation.');
      if (!active(s)) return false;
      s.pendingCommand = null; s.error = ''; s.info = `${TOOL_LABELS[command]} command accepted by the room server.`;
      try { Promise.resolve(onSaved(copy(s.record), { roomId: s.room.id, action: 'command', command })).catch(() => {}); } catch { /* Acknowledged. */ }
      return true;
    } catch (error) { if (error?.status >= 400 && error.status < 500) s.pendingCommand = null; setError(s, error); return false; }
    finally { s.commanding = false; if (active(s)) { renderStatus(); syncFields(); } }
  }
  async function loadRoom(room) {
    if (destroyed || !opened) return false;
    syncActor();
    const info = roomInfo(room), s = { actorId, room: info || { id: '', name: 'No room selected' }, bots: [], catalog: { appearances: [], behaviors: [], tools: [] }, canManage: false, draft: null, record: null, baseline: null, error: '', info: '', loading: true, loadFailed: false };
    if (session && session.room.id !== s.room.id) { try { onPreview({ roomId: session.room.id, botId: session.record?.id || null, bot: null }); } catch { /* Clear the old room preview before loading another catalog. */ } }
    session = s; roomLabel.textContent = s.room.name || s.room.id; renderList(); renderDetail(); renderStatus(); preview(s);
    if (!s.room.id) { s.loading = false; s.loadFailed = true; setError(s, new Error('Enter a room to manage its residents.')); renderList(); return false; }
    try {
      const data = await request(endpoint(s));
      if (!active(s)) return false;
      s.canManage = data?.capabilities?.canManage === true;
      if (s.canManage) { s.bots = copy(data.bots || []); s.catalog = copy(data.catalog || { appearances: [], behaviors: [], tools: [] }); }
      else s.error = 'Your current room role cannot manage residents. Ask a universe owner or world admin/editor.';
      if (s.canManage && !s.catalog.appearances?.length) s.error = 'No resident appearances are available for this room. Creation is unavailable until its catalog loads.';
      if (restoreNewDraft(s)) preview(s);
      return s.canManage;
    } catch (error) { if (active(s)) { s.loadFailed = true; setError(s, error, 'This room’s residents could not be loaded.'); } return false; }
    finally { s.loading = false; if (active(s)) { renderList(); renderDetail(); renderStatus(); } }
  }
  async function setRoom(room) {
    syncActor();
    const info = roomInfo(room), token = ++navigation, s = session;
    if (destroyed) return false;
    if (!opened) { session = null; testPanel.update(); return true; }
    if (s?.room.id === info?.id && !s.loadFailed) { s.room = { ...s.room, ...info }; roomLabel.textContent = s.room.name || s.room.id; if (s.draft) renderPlan(); return true; }
    if (s?.draft && !await leaveDraft(s)) return false;
    if (token !== navigation || destroyed || !opened) return false;
    return loadRoom(info);
  }
  async function open(room = getRoom()) {
    if (destroyed) return false;
    if (opened) return setRoom(room);
    returnFocus = document.activeElement; opened = true; root.hidden = false; closeButton.focus({ preventScroll: true });
    return setRoom(room);
  }
  function close() {
    syncActor();
    if (closePromise) return closePromise;
    if (!opened || destroyed) return Promise.resolve(true);
    const s = session, token = ++navigation;
    closePromise = Promise.resolve().then(async () => {
      if (s && (s.deleting || s.commanding)) return false;
      if (!await leaveDraft(s) || destroyed || token !== navigation || session !== s) return false;
      opened = false; root.hidden = true; session = null; testPanel.update();
      try { if (s) onPreview({ roomId: s.room.id, botId: s.record?.id || null, bot: null }); } catch { /* Cleanup remains available. */ }
      try { Promise.resolve(onClose()).catch(() => {}); } catch { /* The surface is already closed. */ } finally { if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); }
      return true;
    }).finally(() => { closePromise = null; });
    return closePromise;
  }
  function updateMap(changes = {}) {
    syncActor();
    const s = session, draft = s?.draft;
    if (!active(s) || !draft || !s.canManage || s.deleting || s.commanding) return false;
    if (changes.roomId !== undefined && changes.roomId !== s.room.id) return false;
    if (changes.botId !== undefined && changes.botId !== (s.record?.id || null)) return false;
    for (const key of ['spawn', 'radius', 'waypoints']) if (changes[key] !== undefined) draft[key] = copy(changes[key]);
    renderDetail(); renderStatus(); preview(s); return true;
  }
  function onKey(event) {
    if (!opened) return;
    // Keyboard input in this panel must never reach world movement shortcuts.
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); if (session?.deleteConfirm) { session.deleteConfirm = false; renderDeleteConfirmation(); } else close(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
  }
  function beforeUnload(event) { syncActor(); if (newDrafts.size || (opened && (dirty(session) || session?.pendingOperation))) { event.preventDefault(); event.returnValue = ''; } }
  root.addEventListener('keydown', onKey); root.addEventListener('keyup', event => event.stopPropagation()); root.addEventListener('pointerdown', event => event.stopPropagation());
  window.addEventListener('beforeunload', beforeUnload);
  return {
    open, close, setRoom, select, save, updateMap, isOpen: () => { syncActor(); return opened; }, isDirty: () => { syncActor(); return dirty(session); }, isSaving: () => !!session?.saving,
    updateAuthority(canManage){syncActor();if(!session)return;session.canManage=!!canManage;if(!canManage){session.error='Your resident-management permission changed. Your draft is kept.';onPreview({roomId:session.room.id,botId:session.record?.id||null,bot:null});}renderDetail();renderStatus();},
    getDraft: () => active(session) && session.draft ? copy(session.draft) : null,
    getIdentity: () => ({ roomId: active(session) ? session.room.id : undefined, botId: active(session) ? session.record?.id || null : null }),
    destroy() {
      if (destroyed) return; destroyed = true; navigation++; opened = false;
      if (session) { try { onPreview({ roomId: session.room.id, botId: session.record?.id || null, bot: null }); } catch { /* Dispose even if renderer is gone. */ } }
      window.removeEventListener('beforeunload', beforeUnload); testPanel.destroy(); root.remove(); session = null; newDrafts.clear();
    },
  };
}
