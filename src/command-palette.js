/** A command menu over live, authorized state. The parent supplies real actions. */
const GROUPS = ['all', 'actions', 'people', 'places'];
let sequence = 0;
const normalize = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const personId = person => person.id || person.userId;

export function filterCommands(commands, query = '', group = 'all') {
  const words = normalize(query).trim().split(/\s+/).filter(Boolean);
  return commands.filter(command => (group === 'all' || command.group === group) &&
    words.every(word => normalize([command.label, command.description, command.keywords, command.group].join(' ')).includes(word)));
}

export function collectCommands({ state = {}, actions = [], onPerson, onNavigate, onWalkToPerson, canWalkToPerson }) {
  if (!state.user) return [];
  const commands = actions.filter(action => action && typeof action.run === 'function' && action.hidden !== true &&
    (typeof action.enabled === 'function' ? action.enabled(state) : action.enabled !== false)).map(action => ({ ...action, group: 'actions', icon: action.icon || '✦' }));
  if (state.ready !== false && state.room) for (const person of state.people || []) {
    const id = personId(person);
    if (!id || id === state.user.id || person.roomId && person.roomId !== state.room.id) continue;
    if (onPerson) commands.push({ id: `person:${id}`, label: person.name || person.displayName || 'Room member', description: 'Open direct message', group: 'people', icon: 'person', person, keywords: 'message chat dm', run: () => onPerson(person) });
    if (onWalkToPerson && canWalkToPerson?.(person, state)) commands.push({ id: `walk:${id}`, label: `Walk to ${person.name || person.displayName || 'room member'}`, description: 'Meet them in this room', group: 'people', icon: '↗', keywords: 'go nearby move', run: () => onWalkToPerson(person) });
  }
  if (onNavigate) {
    const seen = new Set();
    const worlds = [...(state.worlds || []), ...(state.universes || []).flatMap(universe => universe.worlds || [])];
    for (const world of worlds) for (const room of world.rooms || []) {
      if (!room.id || seen.has(room.id) || room.id === state.room?.id || room.canEnter === false || room.disabled) continue;
      seen.add(room.id);
      commands.push({ id: `room:${room.id}`, label: room.name || 'Room', description: world.name || 'Accessible room', group: 'places', icon: '◎', keywords: ['travel room', world.name, room.description].join(' '), run: () => onNavigate(room.id) });
    }
  }
  const seen = new Set();
  return commands.filter(command => command.id && command.label && !seen.has(command.id) && seen.add(command.id));
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function mountPalette({ root, getState, getActions = () => [], onPerson, onNavigate, onWalkToPerson, canWalkToPerson, portrait, onOpenChange = () => {}, toast = () => {} }) {
  if (!root || typeof getState !== 'function') throw new Error('mountPalette needs root and getState');
  const prefix = `universe-commands-${++sequence}`;
  let destroyed = false, opened = false, group = 'all', selected = 0, results = [], focusBefore = null, selectionBefore = null, executing = false;
  let portraitOwner = null;
  const portraits = new Map();
  root.classList.add('command-root'); root.hidden = true;
  const panel = node('section', 'command-panel');
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', `${prefix}-title`);
  const title = node('h2', 'command-title', 'Where to next?'); title.id = `${prefix}-title`;
  const eyebrow = node('div', 'command-eyebrow', 'YOUR UNIVERSE, ONE SHORTCUT AWAY');
  const closeButton = node('button', 'command-close', '×'); closeButton.type = 'button'; closeButton.setAttribute('aria-label', 'Close quick menu');
  const searchRow = node('div', 'command-search-row');
  const searchIcon = node('span', 'command-search-icon', '⌕'); searchIcon.setAttribute('aria-hidden', 'true');
  const search = node('input', 'command-search'); search.type = 'text'; search.placeholder = 'Find an action, person or place…'; search.autocomplete = 'off'; search.spellcheck = false;
  search.setAttribute('role', 'combobox'); search.setAttribute('aria-label', 'Search actions, people and places'); search.setAttribute('aria-autocomplete', 'list'); search.setAttribute('aria-expanded', 'true'); search.setAttribute('aria-controls', `${prefix}-results`);
  searchRow.append(searchIcon, search);
  const tabs = node('div', 'command-filters'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'Filter quick menu');
  const filterButtons = new Map();
  for (const value of GROUPS) {
    const button = node('button', 'command-filter', value[0].toUpperCase() + value.slice(1)); button.type = 'button'; button.setAttribute('aria-pressed', String(value === group));
    button.onclick = () => { group = value; selected = 0; refresh(); search.focus(); };
    filterButtons.set(value, button); tabs.append(button);
  }
  const list = node('div', 'command-results'); list.id = `${prefix}-results`; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Quick menu results');
  const status = node('div', 'command-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const footer = node('div', 'command-footer');
  const hint = node('span', '', '↑ ↓ to choose · Enter to go · Esc to close');
  const badge = node('span', 'command-shortcut', '⌘ / Ctrl K'); footer.append(hint, badge);
  const heading = node('header', 'command-header'); heading.append(node('div', '', ''), closeButton); heading.firstChild.append(eyebrow, title);
  panel.append(heading, searchRow, tabs, list, status, footer); root.replaceChildren(panel);

  const source = () => collectCommands({ state: getState() || {}, actions: getActions() || [], onPerson, onNavigate, onWalkToPerson, canWalkToPerson });
  function renderPortrait(holder, command) {
    holder.classList.add('command-person-icon');
    const initials = String(command.label || '?').trim().split(/\s+/).slice(0, 2).map(word => [...word][0]).join('').toUpperCase();
    holder.append(node('span', 'command-person-initials', initials));
    if (typeof portrait !== 'function' || !command.person) return;
    const key = JSON.stringify([personId(command.person), command.person.appearance, command.person.woka]);
    if (!portraits.has(key)) {
      portraits.set(key, Promise.resolve().then(() => portrait(command.person)).catch(() => null));
      while (portraits.size > 96) portraits.delete(portraits.keys().next().value);
    }
    const owner = portraitOwner;
    portraits.get(key).then(url => {
      if (destroyed || owner !== portraitOwner || !holder.isConnected || !opened || typeof url !== 'string' || !/^data:image\/(png|webp|jpeg);base64,/.test(url)) return;
      const image = node('img', 'command-person-portrait'); image.alt = ''; image.setAttribute('aria-hidden', 'true'); image.src = url;
      image.onerror = () => { image.remove(); holder.classList.remove('has-portrait'); };
      image.onload = () => { if (image.isConnected) holder.classList.add('has-portrait'); };
      holder.append(image);
    });
  }
  function refresh() {
    if (destroyed || !opened) return;
    if (portraitOwner !== getState()?.user?.id) { portraitOwner = getState()?.user?.id; portraits.clear(); }
    const previous = results[selected]?.id;
    results = filterCommands(source(), search.value, group);
    const next = results.findIndex(item => item.id === previous);
    selected = Math.max(0, Math.min(results.length - 1, next >= 0 ? next : selected));
    for (const [value, button] of filterButtons) button.setAttribute('aria-pressed', String(value === group));
    list.replaceChildren();
    let previousGroup;
    for (const [index, command] of results.entries()) {
      if (previousGroup !== command.group) { const label = node('div', 'command-group-label', command.group); label.setAttribute('role', 'presentation'); list.append(label); previousGroup = command.group; }
      const option = node('div', 'command-result'); option.id = `${prefix}-option-${index}`; option.dataset.commandId = command.id; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(index === selected));
      const icon = node('span', 'command-result-icon', command.icon === 'person' ? '' : command.icon); icon.setAttribute('aria-hidden', 'true');
      if (command.icon === 'person') renderPortrait(icon, command);
      const text = node('span', 'command-result-text'); text.append(node('strong', '', command.label), node('small', '', command.description || ''));
      const key = node('span', 'command-result-key', command.shortcut || '↵'); key.setAttribute('aria-hidden', 'true');
      option.append(icon, text, key); option.onpointermove = () => activate(index, false); option.onpointerdown = event => event.preventDefault(); option.onclick = () => execute(command.id);
      list.append(option);
    }
    status.textContent = results.length ? `${results.length} ${results.length === 1 ? 'result' : 'results'}` : search.value ? `No matches for “${search.value}”. Try another word.` : 'Nothing available in this category yet.';
    activate(selected, false);
  }
  function activate(index, scroll = true) {
    selected = Math.max(0, Math.min(results.length - 1, index));
    const options = [...list.querySelectorAll('[role="option"]')];
    for (const [i, option] of options.entries()) option.setAttribute('aria-selected', String(i === selected));
    if (options[selected]) { search.setAttribute('aria-activedescendant', options[selected].id); if (scroll) options[selected].scrollIntoView({ block: 'nearest' }); }
    else search.removeAttribute('aria-activedescendant');
  }
  async function execute(id) {
    if (executing) return;
    // Re-resolve from fresh authorized state. A role change must invalidate an open result.
    const command = source().find(item => item.id === id);
    if (!command) { refresh(); toast('That action is no longer available'); return; }
    executing = true; close();
    try { await command.run(); } catch (error) { toast(error?.message || 'That action could not finish. Try again.'); }
    finally { executing = false; }
  }
  function open() {
    if (destroyed || opened || !getState()?.user) return;
    focusBefore = document.activeElement; selectionBefore = null;
    if (typeof focusBefore?.selectionStart === 'number') selectionBefore = [focusBefore.selectionStart, focusBefore.selectionEnd, focusBefore.selectionDirection];
    opened = true; group = 'all'; selected = 0; search.value = ''; root.hidden = false;
    onOpenChange(true); refresh(); search.focus();
  }
  function close({ restoreFocus = true } = {}) {
    if (!opened) return;
    opened = false; root.hidden = true; onOpenChange(false);
    if (restoreFocus && focusBefore?.isConnected && !focusBefore.closest('[hidden]')) {
      focusBefore.focus({ preventScroll: true });
      if (selectionBefore && typeof focusBefore.setSelectionRange === 'function') try { focusBefore.setSelectionRange(...selectionBefore); } catch { /* Some input types reject selection. */ }
    }
    focusBefore = null; selectionBefore = null;
  }
  function handleKey(event) {
    if (destroyed || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return false;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
      if (!getState()?.user) return false;
      event.preventDefault(); event.stopPropagation(); if (!event.repeat) opened ? close() : open(); return true;
    }
    if (!opened) return false;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return true; }
    return false;
  }
  function keydown(event) {
    if (handleKey(event)) return;
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); activate((selected + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % (results.length || 1)); }
    else if (event.key === 'Enter' && event.target === search) { event.preventDefault(); if (results[selected]) execute(results[selected].id); }
    else if (event.key === 'Tab') {
      const focusable = [...panel.querySelectorAll('button,input')].filter(element => !element.disabled);
      const index = focusable.indexOf(document.activeElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); focusable.at(-1).focus(); }
      else if (!event.shiftKey && index === focusable.length - 1) { event.preventDefault(); focusable[0].focus(); }
    }
  }
  search.oninput = () => { selected = 0; results = []; refresh(); };
  closeButton.onclick = () => close();
  root.addEventListener('keydown', keydown); root.addEventListener('keyup', event => event.stopPropagation());
  root.onclick = event => { if (event.target === root) close(); };
  function destroy() { close({ restoreFocus: false }); destroyed = true; portraits.clear(); root.removeEventListener('keydown', keydown); root.replaceChildren(); root.classList.remove('command-root'); }
  return { open, close, toggle: () => opened ? close() : open(), refresh, handleKey, isOpen: () => opened, destroy };
}
