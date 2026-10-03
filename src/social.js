import {roomAllows} from './permissions.js';
import {createNearbyText, validateNearbyText} from './proximity-text.js';
/**
 * Universe's standalone social client. Identity, message ownership, room access,
 * reactions and moderation are validated by the server; UI gates are only affordances.
 * Keep the game renderer outside this module. Text is always rendered as textContent.
 */
const TABS = ['chat', 'people', 'explore', 'settings'];
const REACTIONS = ['👍', '❤️', '🎉', '🔥'];
const EMOTES = ['👋', '❤️', '🎉', '👍', '💡', '☕'];
const STATUS_LABELS = { online: 'Available', away: 'Away', busy: 'Busy', offline: 'Offline' };
const enc = encodeURIComponent;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'disabled' || key === 'hidden') node[key] = Boolean(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
function button(label, fn, attrs = {}) { return el('button', { type: 'button', class: 'button social-btn', ...attrs, onclick: fn }, label); }
function messageError(error) { return error?.message || 'Something went wrong. Please try again.'; }
function makeAvatar(user, large=false,portrait=null){
 const node=el('span',{class:`social-avatar${large?' social-avatar-large':''}`,'aria-hidden':'true'}),initials=el('span',{class:'social-avatar-initials',text:(user?.name||'U').slice(0,2)});node.append(initials);
 if(portrait)Promise.resolve(portrait(user)).then(url=>{const img=el('img',{class:'social-avatar-portrait',src:url,alt:''});node.replaceChildren(img);}).catch(()=>{});
 return node;
}
function statusDot(status = 'online') { return el('span', { class: 'social-status-dot', 'data-status': status, title: STATUS_LABELS[status] || status }); }
function field(label, input, hint) { return el('label', { class: 'social-field' }, el('span', { text: label }), input, hint && el('small', { text: hint })); }
function input(attrs = {}) { return el('input', { class: 'input social-input', ...attrs }); }
function notice(text, error = false) { return el('div', { class: `social-notice${error ? ' social-notice-error' : ''}`, role: error ? 'alert' : 'status', text }); }
function empty(text) { return el('p', { class: 'social-empty', text }); }
function timeLabel(date) {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function normalizeList(result, key) { return Array.isArray(result?.[key]) ? result[key] : Array.isArray(result) ? result : []; }
function focusEnd(node) { node?.focus(); if (node && typeof node.setSelectionRange === 'function') node.setSelectionRange(node.value.length, node.value.length); }

export function mountSocial({ root, api, getState, onNavigate = () => {}, onExplore = null, onManage = null, onAvatar = null, portrait = null, toast = () => {}, onNearbyUnread = () => {} }) {
  if (!root || typeof api !== 'function' || typeof getState !== 'function') throw new Error('mountSocial needs root, api and getState');
  const avatar=(person,large=false)=>makeAvatar(person,large,portrait);
  let destroyed = false;
  let activeTab = 'chat';
  let mountedKey = '';
  let lastUser = '';
  let selectedPeer = null;
  let chatMode = 'room';
  let peopleFilter = '';
  let exploreFilter = '';
  let createMode = '';
  let profileSelection = 0;
  let edit = null;
  let localWorlds = null;
  let conversations = [];
  let conversationsLoaded = false;
  let conversationsLoading = false;
  let worldLoading = false;
  let worldError = '';
  let noticeNode = null;
  let timeline = null;
  let composer = null;
  let sendButton = null;
  let editLabel = null;
  let peopleList = null;
  let explorerList = null;
  let profileForm = null;
  let profileAvatar = null;
  let pendingConfirm = null;
  let returnFocus = null;
  const cache = new Map();
  const drafts = new Map();
  const busy = new Set();
  const sendOperations = new Map();
  const unread = new Map();
  const tabs = new Map();
  let renderInbox = null;
  let nearbyElements = null;
  let nearbyUnread = 0;
  const currentState = () => getState() || {};
  const user = () => currentState().user || {};
  const room = () => currentState().room || {};
  const channelKey = () => chatMode === 'nearby' ? 'nearby' : chatMode === 'dm' && selectedPeer ? `dm:${selectedPeer.id}` : `room:${room().id || ''}`;
  const nearby = createNearbyText({ api, getState, onChange: nearbyChanged, onMessage: ({stayId, own}) => {
    if (!own && (root.hidden || activeTab !== 'chat' || chatMode !== 'nearby' || nearby.snapshot().selectedId !== stayId)) nearby.markUnread(stayId);
  }});
  const channelPath = (key) => key.startsWith('dm:') ? `/api/dm/${enc(key.slice(3))}/messages` : `/api/rooms/${enc(key.slice(5))}/messages`;
  const getChannel = (key) => {
    if (!cache.has(key)) cache.set(key, { messages: [], loaded: false, loading: false, error: '', request: 0, liveDuringLoad: new Set(), hasOlder: false, nextCursor: null, loadingOlder: false });
    return cache.get(key);
  };
  const storageKey = (key) => `universe:draft:v1:${user().id}:${key}`;
  function readDraft(key) {
    if (drafts.has(key)) return drafts.get(key);
    let value = '';
    try { value = localStorage.getItem(storageKey(key)) || ''; } catch { /* Storage-disabled browsers still keep drafts in memory. */ }
    drafts.set(key, value);
    return value;
  }
  function saveDraft(key, value) {
    drafts.set(key, value);
    try { if (value) localStorage.setItem(storageKey(key), value); else localStorage.removeItem(storageKey(key)); } catch { /* Non-fatal quota/privacy restriction. */ }
  }
  function report(text, type = 'info') { if (!destroyed) toast(text, type); }
  function showError(error) {
    if (!destroyed && noticeNode) noticeNode.replaceChildren(notice(messageError(error), true));
    report(messageError(error), 'error');
  }
  function clearNotice() { noticeNode?.replaceChildren(); }
  async function run(key, task) {
    if (destroyed || busy.has(key)) return;
    busy.add(key);
    try { return await task(); } catch (error) { showError(error); } finally { busy.delete(key); }
  }
  function resetView() { mountedKey = ''; render(); }
  function dismissConfirm() { pendingConfirm?.remove(); pendingConfirm = null; returnFocus?.focus(); returnFocus = null; }
  function confirmAction(text, label, action, anchor) {
    dismissConfirm();
    returnFocus = anchor || document.activeElement;
    const confirm = button(label, async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      try { await action(); dismissConfirm(); } catch (error) { confirm.disabled = false; cancel.disabled = false; confirmationError.replaceChildren(notice(messageError(error), true)); }
    }, { class: 'button social-btn social-btn-danger social-btn-small' });
    const cancel = button('Cancel', dismissConfirm, { class: 'button social-btn social-btn-quiet social-btn-small' });
    const confirmationError = el('div');
    pendingConfirm = el('div', { class: 'social-confirm', role: 'alertdialog', 'aria-label': text }, el('div', { text }), confirmationError, el('div', { class: 'social-confirm-actions' }, cancel, confirm));
    (anchor?.closest('.social-message-body, .social-person') || noticeNode || panel).append(pendingConfirm);
    cancel.focus();
  }

  root.classList.add('social-shell');
  const title = el('h2', { class: 'social-title' });
  const subtitle = el('p', { class: 'social-subtitle' });
  const close = button('×', () => {
    dismissConfirm();
    root.hidden = true;
    root.dispatchEvent(new CustomEvent('social-close', { bubbles: true }));
  }, { class: 'button social-btn social-btn-quiet social-close', 'aria-label': 'Close social panel', title: 'Close panel (Escape)' });
  const header = el('header', { class: 'social-header' }, el('div', { class: 'social-grow' }, el('div', { class: 'social-eyebrow', text: 'Your Universe' }), title, subtitle), close);
  const tabBar = el('nav', { class: 'social-tabs', role: 'tablist', 'aria-label': 'Social panel' });
  const panel = el('section', { class: 'social-panel', role: 'tabpanel', id: 'universe-social-panel' });
  for (const tab of TABS) {
    const node = button({ chat: 'Chat', people: 'People', explore: 'Explore', settings: 'Profile' }[tab], () => setTab(tab), { class: 'social-tab', role: 'tab', id: `social-tab-${tab}`, 'aria-controls': 'universe-social-panel', 'data-tab': tab });
    node.addEventListener('keydown', (event) => {
      let index = TABS.indexOf(activeTab);
      if (event.key === 'ArrowRight') index = (index + 1) % TABS.length;
      else if (event.key === 'ArrowLeft') index = (index + TABS.length - 1) % TABS.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = TABS.length - 1;
      else return;
      event.preventDefault(); setTab(TABS[index]); tabs.get(TABS[index]).focus();
    });
    tabs.set(tab, node); tabBar.append(node);
  }
  const stopGameKeys = (event) => {
    event.stopPropagation();
    if (event.key === 'Escape' && event.type === 'keydown') {
      event.preventDefault();
      if (pendingConfirm) dismissConfirm();
      else if (edit) cancelEdit();
      else if (createMode) { createMode = ''; resetView(); }
      else close.click();
    }
  };
  root.addEventListener('keydown', stopGameKeys);
  root.addEventListener('keyup', stopGameKeys);
  root.replaceChildren(header, tabBar, panel);

  function syncHeader() {
    const peerName = selectedPeer?.name || 'Direct message';
    title.textContent = { chat: chatMode === 'nearby' ? 'Nearby text' : chatMode === 'inbox' ? 'Direct messages' : chatMode === 'dm' ? peerName : 'Room chat', people: 'People', explore: 'Find your space', settings: 'Make it yours' }[activeTab];
    subtitle.textContent = { chat: chatMode === 'nearby' ? 'Only your current conversation bubble' : chatMode === 'inbox' ? 'Your conversations, all in one place' : chatMode === 'dm' ? 'A conversation between the two of you' : room().name || 'Choose a room to join the conversation', people: `${(currentState().people || []).length} in ${room().name || 'this room'}`, explore: 'Small worlds. Room for everyone.', settings: 'Your name, Woka and availability' }[activeTab];
    for (const [tab, node] of tabs) {
      node.setAttribute('aria-selected', String(tab === activeTab));
      node.tabIndex = tab === activeTab ? 0 : -1;
      if (tab === 'chat') {
        const total = [...unread.values()].reduce((sum, count) => sum + count, 0) + nearby.snapshot().unread;
        node.replaceChildren('Chat');
        if (total) node.append(el('span', { class: 'social-unread', 'aria-label': `${total} unread messages`, text: total > 99 ? '99+' : total }));
      }
    }
    root.dataset.tab = activeTab;
    root.dataset.chatMode = chatMode;
    panel.setAttribute('aria-labelledby', `social-tab-${activeTab}`);
  }
  function setTab(tab) {
    if(tab==='explore'&&onExplore){root.hidden=true;onExplore();return;}
    if (!TABS.includes(tab) || destroyed) return;
    root.hidden = false;
    dismissConfirm();
    activeTab = tab;
    if (tab === 'chat' && chatMode !== 'inbox') unread.delete(channelKey());
    if (tab === 'chat' && chatMode === 'nearby') nearby.markRead();
    render();
  }
  function render() {
    if (destroyed) return;
    nearby.syncState();
    const id = user().id || '';
    if (lastUser !== id) {
      lastUser = id; cache.clear(); unread.clear(); drafts.clear(); sendOperations.clear(); selectedPeer = null; chatMode = 'room'; edit = null;
      localWorlds = null; conversations = []; conversationsLoaded = false; mountedKey = '';
    }
    publishNearbyUnread();
    syncHeader();
    if (!id) {
      if (mountedKey !== 'signed-out') { panel.replaceChildren(empty('Enter a room to start exploring together.')); mountedKey = 'signed-out'; }
      return;
    }
    const viewKey = `${activeTab}:${activeTab === 'chat' ? chatMode === 'inbox' ? 'inbox' : channelKey() : activeTab === 'explore' ? createMode : id}`;
    if (mountedKey !== viewKey) {
      dismissConfirm();
      mountedKey = viewKey;
      root.scrollTop = 0;
      panel.replaceChildren(); timeline = composer = sendButton = editLabel = peopleList = explorerList = profileForm = profileAvatar = noticeNode = nearbyElements = null;
      panel.dataset.chatMode = activeTab === 'chat' ? chatMode : '';
      if (activeTab === 'chat') buildChat();
      else if (activeTab === 'people') buildPeople();
      else if (activeTab === 'explore') buildExplorer();
      else buildSettings();
    } else if (activeTab === 'chat' && chatMode !== 'inbox') renderTimeline();
    else if (activeTab === 'people') renderPeople();
    else if (activeTab === 'explore' && !createMode) renderWorlds();
    else if(activeTab==='settings'&&profileAvatar){const key=JSON.stringify(user().appearance??user().woka);if(profileAvatar.dataset.appearance!==key){profileAvatar.dataset.appearance=key;profileAvatar.firstChild.replaceWith(avatar(user(),true));profileAvatar.children[1].firstChild.textContent=user().name;}}
  }

  function upsertMessage(key, message) {
    if (!message?.id) return;
    const bucket = getChannel(key);
    if (bucket.loading) bucket.liveDuringLoad.add(message.id);
    const index = bucket.messages.findIndex((item) => item.id === message.id);
    if (index < 0) bucket.messages.push(message); else bucket.messages[index] = message;
    bucket.messages.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || String(a.id).localeCompare(String(b.id)));
    if (activeTab === 'chat' && chatMode !== 'inbox' && channelKey() === key) renderTimeline();
  }
  async function loadMessages(key, force = false) {
    const bucket = getChannel(key);
    if (bucket.loading || (bucket.loaded && !force) || key === 'room:') return;
    bucket.loading = true; bucket.error = ''; bucket.liveDuringLoad.clear();
    const request = ++bucket.request;
    renderTimeline();
    try {
      const result = await api(channelPath(key));
      if (destroyed || request !== bucket.request) return;
      const newer = bucket.messages;
      bucket.messages = normalizeList(result, 'messages');
      bucket.hasOlder = key.startsWith('room:') && (result.hasMore ?? bucket.messages.length >= 100);
      bucket.nextCursor = result.nextCursor || null;
      for (const message of newer) {
        const index = bucket.messages.findIndex((item) => item.id === message.id);
        if (index < 0) bucket.messages.push(message);
        else if (bucket.liveDuringLoad.has(message.id)) bucket.messages[index] = message;
      }
      bucket.messages.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      bucket.loaded = true; bucket.liveDuringLoad.clear();
    } catch (error) { bucket.error = messageError(error); }
    finally { bucket.loading = false; if (!destroyed && activeTab === 'chat' && chatMode !== 'inbox' && key === channelKey()) renderTimeline(); }
  }
  async function loadEarlier(key) {
    const bucket = getChannel(key);
    if (bucket.loadingOlder || !bucket.messages.length || !key.startsWith('room:')) return;
    bucket.loadingOlder = true; bucket.error = ''; renderTimeline();
    const before = Math.min(...bucket.messages.map((message) => Number(new Date(message.createdAt))));
    const oldHeight = timeline?.scrollHeight || 0;
    const oldTop = timeline?.scrollTop || 0;
    try {
      const result = await api(`${channelPath(key)}?${bucket.nextCursor ? `cursor=${enc(bucket.nextCursor)}` : `before=${before}`}`);
      const earlier = normalizeList(result, 'messages');
      const ids = new Set(bucket.messages.map((message) => message.id));
      bucket.messages = [...earlier.filter((message) => !ids.has(message.id)), ...bucket.messages];
      bucket.hasOlder = result.hasMore ?? earlier.length >= 100;
      bucket.nextCursor = result.nextCursor || null;
    } catch (error) { bucket.error = messageError(error); }
    finally {
      bucket.loadingOlder = false;
      if (!destroyed && channelKey() === key) {
        renderTimeline();
        if (timeline) timeline.scrollTop = oldTop + timeline.scrollHeight - oldHeight;
      }
    }
  }
  function buildChat() {
    panel.dataset.chatMode = chatMode;
    if (chatMode === 'nearby') { buildNearby(); return; }
    if (chatMode === 'inbox') { buildInbox(); return; }
    const key = channelKey();
    const roomName = chatMode === 'dm' ? selectedPeer.name : room().name || 'Room';
    const toolbar = el('div', { class: 'social-toolbar' }, el('div', { class: 'social-channel', text: roomName }));
    if (chatMode === 'dm') toolbar.append(button('← Room', () => { chatMode = 'room'; resetView(); }, { class: 'button social-btn social-btn-small social-btn-quiet' }));
    toolbar.append(button('Direct', () => { chatMode = 'inbox'; resetView(); }, { class: 'button social-btn social-btn-small', 'aria-label': 'Open direct messages' }));
    appendNearbyMode(toolbar);
    timeline = el('div', { class: 'social-timeline social-scroll', role: 'log', 'aria-label': chatMode === 'dm' ? `Messages with ${selectedPeer.name}` : 'Room messages', 'aria-live': 'polite', 'aria-relevant': 'additions text', tabindex: '0' });
    noticeNode = el('div');
    editLabel = el('div');
    composer = el('textarea', { class: 'input social-input', rows: '2', maxlength: '2000', placeholder: chatMode === 'dm' ? `Message ${selectedPeer.name}…` : 'Say something nice…', 'aria-label': chatMode === 'dm' ? `Message ${selectedPeer.name}` : 'Message the room' });
    composer.value = edit?.key === key ? edit.text : readDraft(key);
    composer.addEventListener('input', () => {
      if (edit?.key === key) edit.text = composer.value; else saveDraft(key, composer.value);
      syncComposer();
    });
    composer.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); }
    });
    sendButton = button('Send ↗', sendMessage, { class: 'button social-btn social-btn-primary', 'aria-label': 'Send message' });
    const form = el('form', { class: 'social-composer', onsubmit: (event) => { event.preventDefault(); sendMessage(); } }, noticeNode, editLabel, composer,
      el('div', { class: 'social-composer-actions' }, el('span', { class: 'social-composer-hint', text: 'Enter to send · Shift + Enter for a new line\nMessages are saved on this server' }), sendButton));
    panel.append(toolbar, timeline, form);
    if (chatMode === 'room') panel.append(buildEmotes());
    syncComposer(); renderTimeline(); loadMessages(key);
  }
  function syncComposer() {
    if (chatMode === 'nearby') { renderNearby(); return; }
    if (!composer || !sendButton) return;
    const key = channelKey();
    const sending = busy.has(`send:${key}`);
    sendButton.disabled = !composer.value.trim() || sending || key === 'room:';
    sendButton.textContent = sending ? 'Sending…' : edit?.key === key ? 'Save edit' : 'Send ↗';
    sendButton.setAttribute('aria-label', edit?.key === key ? 'Save edited message' : 'Send message');
    editLabel.replaceChildren();
    if (edit?.key === key) editLabel.append(el('div', { class: 'social-edit-label' }, 'Editing your message', button('Cancel', cancelEdit, { class: 'button social-btn social-btn-small social-btn-quiet' })));
  }
  async function sendMessage() {
    if (chatMode === 'nearby') { await nearby.send(); return; }
    const key = channelKey();
    if (!composer || busy.has(`send:${key}`)) return;
    const text = composer.value.trim();
    if (!text || key === 'room:') return;
    const editing = edit?.key === key ? { ...edit } : null;
    const raw = composer.value;
    let operation = sendOperations.get(key);
    if (!operation || operation.text !== text) { operation = { text, id: crypto.randomUUID() }; sendOperations.set(key, operation); }
    busy.add(`send:${key}`); clearNotice(); syncComposer();
    try {
      const result = editing ? await api(`/api/messages/${enc(editing.id)}`, { method: 'PATCH', body: { text } }) : await api(channelPath(key), { method: 'POST', body: { text, clientOperationId: operation.id } });
      if (destroyed) return;
      if (result.message) upsertMessage(key, result.message);
      sendOperations.delete(key);
      if (editing) {
        if (edit?.id === editing.id && edit.text === raw) { edit = null; if (key === channelKey() && composer) composer.value = readDraft(key); }
      } else if (readDraft(key) === raw) {
        saveDraft(key, '');
        if (key === channelKey() && composer) composer.value = '';
      }
      if (key.startsWith('dm:')) conversationsLoaded = false;
      if (key === channelKey() && timeline) timeline.scrollTop = timeline.scrollHeight;
    } catch (error) { if (key === channelKey()) showError(error); else report(`Message was not sent: ${messageError(error)}`, 'error'); }
    finally { busy.delete(`send:${key}`); if (!destroyed && key === channelKey()) syncComposer(); }
  }
  function beginEdit(message) {
    if (message.userId !== user().id) return;
    edit = { key: channelKey(), id: message.id, text: message.text || '' };
    composer.value = edit.text; syncComposer(); focusEnd(composer);
  }
  function cancelEdit() {
    edit = null;
    if (composer) { composer.value = readDraft(channelKey()); syncComposer(); composer.focus(); }
  }
  function renderTimeline() {
    if (chatMode === 'nearby') { renderNearby(); return; }
    if (!timeline || activeTab !== 'chat' || chatMode === 'inbox') return;
    const key = channelKey();
    const bucket = getChannel(key);
    const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 65;
    const oldTop = timeline.scrollTop;
    const signature = JSON.stringify([bucket.loading, bucket.loadingOlder, bucket.hasOlder, bucket.error, bucket.messages, user().id, room().role]);
    if (timeline.dataset.signature === signature) return;
    timeline.dataset.signature = signature;
    const nodes = [];
    if (bucket.hasOlder) nodes.push(button(bucket.loadingOlder ? 'Loading…' : 'Load earlier messages', () => loadEarlier(key), { class: 'button social-btn social-btn-small social-btn-quiet', disabled: bucket.loadingOlder }));
    if (bucket.loading && !bucket.loaded) nodes.push(el('div', { class: 'social-empty', role: 'status' }, el('span', { class: 'social-loading', 'aria-hidden': 'true' }), 'Loading the conversation…'));
    if (bucket.error) nodes.push(el('div', {}, notice(bucket.error, true), button('Try again', () => loadMessages(key, true), { class: 'button social-btn social-btn-small' })));
    if (!bucket.loading && !bucket.error && !bucket.messages.length) nodes.push(empty(chatMode === 'dm' ? 'The start of a good conversation. Send a hello.' : 'A little hello goes a long way. Be the first to say something.'));
    for (const message of bucket.messages) nodes.push(renderMessage(message, key));
    timeline.replaceChildren(...nodes);
    if (nearBottom) timeline.scrollTop = timeline.scrollHeight; else timeline.scrollTop = oldTop;
  }
  function renderMessage(message, key) {
    const own = message.userId === user().id;
    const author = message.author || { name: message.name || 'Explorer', woka: 0 };
    const body = el('div', { class: 'social-message-body' },
      el('div', { class: 'social-message-meta' }, el('span', { class: 'social-message-author', text: own ? `${author.name || 'You'} · you` : author.name || 'Explorer' }), el('time', { class: 'social-message-time', datetime: message.createdAt, title: new Date(message.createdAt).toLocaleString(), text: `${timeLabel(message.createdAt)}${message.editedAt && !message.deleted ? ' · edited' : ''}` })),
      el('p', { class: `social-message-text${message.deleted ? ' social-message-deleted' : ''}`, text: message.deleted ? 'Message deleted' : message.text || '' }));
    if (!message.deleted && key.startsWith('room:')) {
      const actions = el('div', { class: 'social-message-actions' });
      for (const emoji of [...new Set([...REACTIONS, ...Object.keys(message.reactions || {})])]) {
        const ids = Array.isArray(message.reactions?.[emoji]) ? message.reactions[emoji] : [];
        const reacted = ids.includes(user().id);
        const reaction = button(`${emoji}${ids.length ? ` ${ids.length}` : ''}`, () => run(`reaction:${message.id}:${emoji}`, async () => {
          reaction.disabled = true;
          try { const result = await api(`/api/messages/${enc(message.id)}/reactions`, { method: 'POST', body: { emoji } }); if (result.message) upsertMessage(key, result.message); }
          finally { reaction.disabled = false; }
        }), { class: 'button social-btn social-btn-small social-reaction', 'aria-label': `${reacted ? 'Remove' : 'Add'} ${emoji} reaction${ids.length ? ` (${ids.length})` : ''}`, 'aria-pressed': String(reacted) });
        actions.append(reaction);
      }
      if (own) actions.append(button('Edit', () => beginEdit(message), { class: 'button social-btn social-btn-small social-btn-quiet', 'aria-label': 'Edit your message' }));
      if (own || (key.startsWith('room:') && roomAllows(room(),'canModerate'))) {
        const remove = button('Delete', () => confirmAction('Delete this message from the conversation?', 'Delete', async () => {
          const result = await api(`/api/messages/${enc(message.id)}`, { method: 'DELETE' });
          if (result.message) upsertMessage(key, result.message);
          if (edit?.id === message.id) cancelEdit();
        }, remove), { class: 'button social-btn social-btn-small social-btn-quiet', 'aria-label': own ? 'Delete your message' : `Moderate message by ${author.name || 'Explorer'}` });
        actions.append(remove);
      }
      body.append(actions);
    }
    return el('article', { class: `social-message${own ? ' social-message-own' : ''}`, 'data-message-id': message.id }, avatar(author), body);
  }
  function buildEmotes() {
    const row = el('div', { class: 'social-emotes', 'aria-label': 'Avatar emotes' }, el('span', { class: 'social-emotes-label', text: 'Say it with an emote' }));
    for (const emoji of EMOTES) row.append(button(emoji, () => run(`emote:${emoji}`, async () => {
      await api(`/api/rooms/${enc(room().id)}/emote`, { method: 'POST', body: { emoji } });
      window.dispatchEvent(new CustomEvent('avatar-emote', { detail: { emoji } }));
    }), { class: 'button social-btn social-btn-quiet', 'aria-label': `Show ${emoji} emote` }));
    return row;
  }
  function openDm(peer) {
    if (!peer?.id || peer.id === user().id) return;
    selectedPeer = { ...peer }; chatMode = 'dm'; activeTab = 'chat'; unread.delete(channelKey()); root.hidden = false; resetView();
    composer?.focus();
  }
  function buildInbox() {
    const toolbar = el('div', { class: 'social-toolbar' }, button('← Room chat', () => { chatMode = 'room'; resetView(); }, { class: 'button social-btn social-btn-small social-btn-quiet' }), button('Find someone', () => setTab('people'), { class: 'button social-btn social-btn-small' }));
    appendNearbyMode(toolbar);
    panel.append(toolbar);
    const list = el('div', { class: 'social-scroll social-stack' });
    noticeNode = el('div'); list.append(noticeNode); panel.append(list);
    const renderList = () => {
      if (destroyed || activeTab !== 'chat' || chatMode !== 'inbox') return;
      list.replaceChildren(noticeNode);
      if (conversationsLoading && !conversationsLoaded) list.append(empty('Loading direct messages…'));
      else if (!conversations.length) list.append(empty('Your direct conversations will appear here. Open People to say hello to someone in this room.'));
      for (const conversation of conversations) {
        const peer = conversation.user || conversation.peer || conversation.otherUser;
        if (!peer?.id) continue;
        const last = conversation.lastMessage || {};
        const count = unread.get(`dm:${peer.id}`) || 0;
        list.append(button('', () => openDm(peer), { class: 'social-conversation', 'aria-label': `Open messages with ${peer.name}` }));
        list.lastChild.append(avatar(peer), el('span', { class: 'social-grow' }, el('span', { class: 'social-person-name', text: peer.name }), el('div', { class: 'social-conversation-preview', text: last.deleted ? 'Message deleted' : last.text || 'Start a conversation' })));
        if (count) list.lastChild.append(el('span', { class: 'social-unread', text: count }));
      }
    };
    renderInbox = renderList;
    renderList();
    if (!conversationsLoading) {
      conversationsLoading = true; renderList();
      api('/api/conversations').then((result) => { conversations = normalizeList(result, 'conversations'); conversationsLoaded = true; }).catch(showError).finally(() => { conversationsLoading = false; renderList(); });
    }
  }

  function publishNearbyUnread() {
    const count = nearby.snapshot().unread;
    if (count !== nearbyUnread) { nearbyUnread = count; onNearbyUnread(count); }
  }
  function appendNearbyMode(toolbar) {
    if (!nearby.snapshot().available) return;
    toolbar.append(button('Nearby', () => {
      edit = null; chatMode = 'nearby'; nearby.markRead(); resetView();
    }, { class: 'button social-btn social-btn-small social-nearby-mode', 'aria-label': 'Nearby', 'aria-pressed': String(chatMode === 'nearby') }));
  }
  function nearbyChanged() {
    if (destroyed) return;
    const state = nearby.snapshot();
    publishNearbyUnread();
    if (!state.available && chatMode === 'nearby') { chatMode = 'room'; resetView(); return; }
    if (activeTab === 'chat') {
      const toolbar = panel.querySelector('.social-toolbar');
      const mode = toolbar?.querySelector('.social-nearby-mode');
      if (state.available && toolbar && !mode) appendNearbyMode(toolbar);
      else if (!state.available) mode?.remove();
      if (mode) { mode.textContent = state.unread ? `Nearby · ${state.unread}` : 'Nearby'; mode.setAttribute('aria-label', 'Nearby'); }
    }
    syncHeader();
    if (activeTab === 'chat' && chatMode === 'nearby') renderNearby();
  }
  function buildNearby() {
    const toolbar = el('div', { class: 'social-toolbar social-nearby-toolbar' },
      button('Room', () => { chatMode = 'room'; resetView(); }, { class: 'button social-btn social-btn-small', 'aria-label': 'Open room chat' }),
      button('Direct', () => { chatMode = 'inbox'; resetView(); }, { class: 'button social-btn social-btn-small', 'aria-label': 'Open direct messages' }));
    appendNearbyMode(toolbar);
    const status = el('p', { class: 'social-nearby-status', role: 'status', 'aria-live': 'polite' });
    const recipients = el('p', { class: 'social-nearby-recipients' });
    const stays = el('select', { class: 'input social-input', 'aria-label': 'Nearby stays' });
    stays.addEventListener('change', () => nearby.select(stays.value));
    const live = button('Open current nearby stay', () => nearby.select(nearby.snapshot().activeId), { class: 'button social-btn social-btn-small' });
    const summary = el('div', { class: 'social-nearby-summary' }, status, recipients, stays, live,
      el('details', { class: 'social-nearby-about' }, el('summary', { text: 'Live only · No missed-message replay' }), el('p', { text: 'The server relays readable plain text to this bubble. Up to 200 received or acknowledged messages and drafts stay in this tab; reload or account change clears them. Leaving keeps received stays read-only. Other signed-in sessions of your account may receive a labeled copy. Room chat and Direct keep their separate saved history.' })));
    timeline = el('div', { class: 'social-timeline social-scroll', role: 'log', 'aria-label': 'Nearby messages', 'aria-live': 'polite', 'aria-relevant': 'additions', tabindex: '0' });
    const error = el('div', { class: 'social-nearby-error', role: 'alert' });
    const retry = button('Retry same message', () => nearby.send(true), { class: 'button social-btn social-btn-small', 'aria-label': 'Retry nearby message' });
    const refresh = button('Refresh Nearby', () => nearby.refresh(), { class: 'button social-btn social-btn-small' });
    const controls = el('div', { class: 'social-nearby-recovery' }, retry, refresh);
    composer = el('textarea', { class: 'input social-input', rows: '2', placeholder: 'Say hello to people in this bubble…', 'aria-label': 'Message nearby people', 'aria-describedby': 'nearby-composer-hint' });
    let composing = false;
    composer.addEventListener('compositionstart', () => { composing = true; });
    composer.addEventListener('compositionend', () => { composing = false; });
    composer.addEventListener('input', () => nearby.setDraft(composer.value));
    composer.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) { event.preventDefault(); nearby.send(); }
    });
    sendButton = button('Send ↗', () => nearby.send(), { class: 'button social-btn social-btn-primary', 'aria-label': 'Send nearby message' });
    const hint = el('span', { class: 'social-composer-hint', id: 'nearby-composer-hint', text: 'Enter to send · Shift + Enter for a new line\n2,000 characters · Plain text' });
    const form = el('form', { class: 'social-composer social-nearby-composer', onsubmit: event => { event.preventDefault(); if (!composing) nearby.send(); } }, error, controls, composer, el('div', { class: 'social-composer-actions' }, hint, sendButton));
    nearbyElements = { status, recipients, stays, live, error, retry, refresh, controls };
    panel.append(toolbar, summary, timeline, form); renderNearby();
  }
  function renderNearby() {
    if (!nearbyElements || activeTab !== 'chat' || chatMode !== 'nearby') return;
    const state = nearby.snapshot(), stay = state.selected, c = state.context, nodes = nearbyElements;
    const ended = !!stay?.endedAt, isLive = !!stay && stay.id === state.activeId;
    let status = state.navigating ? 'Changing rooms · sending paused' : !state.ready ? 'Room unavailable · sending paused' : state.connection === 'unavailable' ? 'Nearby unavailable · membership could not be verified' : state.connection !== 'connected' ? state.connection === 'connecting' ? 'Connecting Nearby · sending paused' : 'Connection lost · sending paused' : c?.reason === 'authority-unavailable' ? 'Nearby unavailable · membership could not be verified' : c?.reason === 'muted' ? 'Muted · you can read Nearby, but cannot send' : c?.recipientCount ? `${c.recipientCount} nearby recipient${c.recipientCount === 1 ? '' : 's'} · live now` : 'Alone · move near someone to start a bubble';
    if (ended) status = `Ended stay · read-only. ${status}`;
    nodes.status.textContent = status;
    nodes.status.dataset.canSend = String(isLive && !ended && !!c?.canSend && state.ready && !state.navigating && state.connection === 'connected');
    nodes.recipients.textContent = c?.conversationRecipients?.length ? `Current recipients: ${c.conversationRecipients.map(peer => (currentState().people || []).find(person => person.id === peer.accountId)?.name || peer.accountId).join(', ')}` : 'No current nearby recipients';
    nodes.live.hidden = !state.activeId || isLive;
    const optionsSignature = JSON.stringify(state.stays.map(item => [item.id, item.endedAt, item.unread, item.id === state.activeId]));
    if (nodes.stays.dataset.signature !== optionsSignature) {
      nodes.stays.dataset.signature = optionsSignature;
      nodes.stays.replaceChildren(...state.stays.map((item, index) => el('option', { value: item.id, text: `${item.id === state.activeId ? 'Live' : item.endedAt ? 'Ended' : 'Disconnected'} · ${item.roomName} · stay ${index + 1}${item.unread ? ` (${item.unread} unread)` : ''}` })));
    }
    nodes.stays.hidden = state.stays.length < 2;
    nodes.stays.value = state.selectedId || '';
    const messageSignature = JSON.stringify([stay?.id, stay?.endedAt, stay?.messages]);
    if (timeline.dataset.signature !== messageSignature) {
      const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 65, top = timeline.scrollTop;
      timeline.dataset.signature = messageSignature;
      const rows = (stay?.messages || []).map(message => {
        const row = renderMessage({ ...message, userId: message.author.id }, 'nearby');
        if (message.ownAccountCopy) row.querySelector('.social-message-meta').append(el('span', { class: 'social-message-time', text: 'Your other session' }));
        return row;
      });
      timeline.replaceChildren(...(rows.length ? rows : [empty(ended ? 'No messages were received during this stay.' : 'Only messages received while you are here appear. No earlier or missed messages are loaded.')]));
      if (nearBottom) timeline.scrollTop = timeline.scrollHeight; else timeline.scrollTop = top;
    }
    if (composer.value !== (stay?.draft || '')) composer.value = stay?.draft || '';
    composer.readOnly = !stay || ended;
    composer.placeholder = ended ? 'This stay has ended. Its draft is kept here.' : !stay ? 'Join a nearby conversation to write a message…' : 'Say hello to people in this bubble…';
    const validation = stay?.draft ? validateNearbyText(stay.draft, c?.limits) : '';
    nodes.error.textContent = state.refreshError || stay?.error || validation;
    nodes.error.hidden = !nodes.error.textContent;
    nodes.retry.hidden = stay?.operation?.status !== 'retry';
    nodes.retry.disabled = !isLive || !state.ready || !c?.canSend || state.connection !== 'connected' || state.navigating;
    nodes.refresh.hidden = !c?.connectionEpoch || !(state.refreshError || stay?.error || c?.reason === 'authority-unavailable');
    nodes.controls.hidden = nodes.retry.hidden && nodes.refresh.hidden;
    sendButton.disabled = !isLive || ended || !state.ready || !c?.canSend || state.navigating || state.connection !== 'connected' || !!stay?.operation || !stay?.draft.trim() || !!validation;
    sendButton.textContent = stay?.operation?.status === 'sending' ? 'Sending…' : 'Send ↗';
  }

  function buildPeople() {
    const search = input({ type: 'search', placeholder: 'Find someone here…', 'aria-label': 'Search people' });
    search.value = peopleFilter;
    search.addEventListener('input', () => { peopleFilter = search.value; renderPeople(); });
    peopleList = el('div');
    noticeNode = el('div');
    const ownStatus = el('select', { class: 'input social-input', 'aria-label': 'Your availability' });
    for (const [value, label] of Object.entries(STATUS_LABELS).filter(([value]) => value !== 'offline')) ownStatus.append(el('option', { value, text: label }));
    ownStatus.value = user().status || 'online';
    ownStatus.addEventListener('change', () => run('availability', async () => {
      ownStatus.disabled = true;
      try { await saveProfile({ status: ownStatus.value }); report(`You’re ${STATUS_LABELS[user().status]?.toLowerCase() || user().status}`); }
      catch (error) { ownStatus.value = user().status || 'online'; throw error; }
      finally { ownStatus.disabled = false; }
    }));
    panel.append(el('div', { class: 'social-scroll social-stack' }, field('Your availability', ownStatus), search, noticeNode, peopleList));
    renderPeople();
  }
  function renderPeople() {
    if (!peopleList || (pendingConfirm && peopleList.contains(pendingConfirm))) return;
    const needle = peopleFilter.trim().toLocaleLowerCase();
    const seen = new Set();
    const people = (currentState().people || []).filter((person) => person?.id && !seen.has(person.id) && seen.add(person.id)).filter((person) => !needle || (person.name || '').toLocaleLowerCase().includes(needle));
    const isModerator = roomAllows(room(),'canModerate');
    const nodes = [];
    for (const person of people) {
      const own = person.id === user().id;
      const detail = el('div', { class: 'social-grow' }, el('div', { class: 'social-person-name', text: `${person.name || 'Explorer'}${own ? ' · you' : ''}` }), el('div', { class: 'social-person-detail' }, statusDot(person.status), el('span', { text: `${STATUS_LABELS[person.status] || 'Available'}${person.role ? ` · ${person.role}` : ''}` })));
      const actions = el('div', { class: 'social-person-controls' });
      if (!own) actions.append(button('Message', () => openDm(person), { class: 'button social-btn social-btn-small', 'aria-label': `Message ${person.name}` }));
      if (!own && isModerator && person.id !== room().ownerId && person.role !== 'owner' && (['owner','admin'].includes(room().role) || !['admin','moderator'].includes(person.role))) {
        const moderate = button('Manage', () => renderModeration(person, row, moderate), { class: 'button social-btn social-btn-small social-btn-quiet', 'aria-label': `Manage ${person.name}` });
        actions.append(moderate);
      }
      const row = el('div', { class: 'social-person', 'data-user-id': person.id }, avatar(person), detail, actions);
      nodes.push(row);
    }
    const signature = JSON.stringify([people.map(({id,name,woka,status,role}) => ({id,name,woka,status,role})),room().role,room().ownerId]);
    if (peopleList.dataset.signature === signature) return;
    peopleList.dataset.signature = signature;
    peopleList.replaceChildren(...(nodes.length ? nodes : [empty(needle ? 'No one here matches that name.' : 'You have the room to yourself. Invite a friend to join you.')]));
  }
  function renderModeration(person, row, trigger) {
    dismissConfirm();
    const box = el('div', { class: 'social-confirm', role: 'group', 'aria-label': `Manage ${person.name}` });
    box.style.flexBasis = '100%'; row.style.flexWrap = 'wrap';
    const actions = [['mute', 'Mute for 10 min'], ['unmute', 'Unmute'], ['kick', 'Remove from room'], ['ban', 'Ban from room']];
    box.append(el('span', { text: `Room controls for ${person.name}` }));
    for (const [action, label] of actions) box.append(button(label, () => {
      box.remove();
      confirmAction(`${label} ${action === 'mute' ? 'for ' : ''}${person.name}?`, label, async () => {
        await api(`/api/rooms/${enc(room().id)}/moderate`, { method: 'POST', body: { userId: person.id, action, minutes: 10 } });
        report(`${label}: ${person.name}`); renderPeople();
      }, trigger);
    }, { class: `button social-btn social-btn-small${['kick', 'ban'].includes(action) ? ' social-btn-danger' : ''}` }));
    if (roomAllows(room(),'canManageMembers')) {
      const roleSelect = el('select', { class: 'input social-input', 'aria-label': `Room role for ${person.name}` });
      for (const role of ['member', 'editor', 'moderator']) roleSelect.append(el('option', { value: role, text: role.charAt(0).toUpperCase() + role.slice(1) }));
      roleSelect.value = person.role || 'member';
      box.append(field('Room role', roleSelect), button('Save role', () => run(`role:${person.id}`, async () => {
        await api(`/api/rooms/${enc(room().id)}/members/${enc(person.id)}`, { method: 'PUT', body: { role: roleSelect.value } });
        person.role = roleSelect.value; report(`${person.name} is now a room ${roleSelect.value}`); dismissConfirm(); renderPeople();
      }), { class: 'button social-btn social-btn-small' }));
    }
    box.append(button('Close', dismissConfirm, { class: 'button social-btn social-btn-small social-btn-quiet' }));
    pendingConfirm = box; returnFocus = trigger; row.append(box); box.querySelector('button')?.focus();
  }

  function buildExplorer() {
    noticeNode = el('div');
    if (createMode) { buildCreateForm(); return; }
    const search = input({ type: 'search', placeholder: 'Search worlds and rooms…', 'aria-label': 'Search worlds and rooms' });
    search.value = exploreFilter;
    search.addEventListener('input', () => { exploreFilter = search.value; renderWorlds(); });
    explorerList = el('div', { class: 'social-world' });
    const controls = el('div', { class: 'social-row' }, button('+ World', () => { createMode = 'world'; resetView(); }, { class: 'button social-btn social-btn-small' }), button('+ Room', () => { createMode = 'room'; resetView(); }, { class: 'button social-btn social-btn-small social-btn-primary' }));
    if (roomAllows(room(),'canInvite')) controls.append(button('Invite', createInvite, { class: 'button social-btn social-btn-small', 'aria-label': 'Create an invite to this room' }));
    panel.append(el('div', { class: 'social-scroll social-stack' }, search, controls, noticeNode, explorerList));
    renderWorlds(); loadWorlds();
  }
  async function createInvite() {
    const target = { ...room() };
    await run(`invite:${target.id}`, async () => {
      const result = await api(`/api/rooms/${enc(target.id)}/invites`, { method: 'POST', body: {} });
      const url = new URL(result.url, window.location.origin);
      if (url.origin !== window.location.origin) throw new Error('The invite did not return a local room link.');
      if (!noticeNode) return;
      const link = input({ value: url.href, readonly: 'readonly', 'aria-label': `Invite link for ${target.name}` });
      const copied = el('span', { class: 'social-muted social-small', role: 'status' });
      const copy = button('Copy link', async () => {
        try { await navigator.clipboard.writeText(url.href); copied.textContent = 'Copied'; }
        catch { link.focus(); link.select(); copied.textContent = 'Select and copy this link'; }
      }, { class: 'button social-btn social-btn-small social-btn-primary' });
      noticeNode.replaceChildren(el('div', { class: 'social-section-card social-world' }, el('h3', { class: 'social-section-title', text: `Invite to ${target.name}` }),
        el('p', { class: 'social-muted', text: 'Anyone with this link can join this room for the next 7 days. Share it only with people you want to invite.' }), link, el('div', { class: 'social-row' }, copy, copied)));
    });
  }
  async function loadWorlds(force = false) {
    if (worldLoading || (localWorlds && !force)) return;
    worldLoading = true; worldError = ''; renderWorlds();
    try { const result = await api('/api/worlds'); localWorlds = normalizeList(result, 'worlds'); }
    catch (error) { worldError = messageError(error); }
    finally { worldLoading = false; if (!destroyed) renderWorlds(); }
  }
  function renderWorlds() {
    if (!explorerList) return;
    const worlds = localWorlds || currentState().worlds || [];
    const needle = exploreFilter.trim().toLocaleLowerCase();
    const nodes = [];
    if (worldError) nodes.push(el('div', {}, notice(worldError, true), button('Try again', () => loadWorlds(true), { class: 'button social-btn social-btn-small' })));
    if (worldLoading && !worlds.length) nodes.push(empty('Loading your worlds…'));
    for (const world of worlds) {
      const matchesWorld = (world.name || '').toLocaleLowerCase().includes(needle);
      const rooms = (world.rooms || []).filter((entry) => !needle || matchesWorld || (entry.name || '').toLocaleLowerCase().includes(needle));
      if (needle && !matchesWorld && !rooms.length) continue;
      const card = el('section', { class: 'social-world social-section-card' }, el('div', { class: 'social-world-header' }, el('span', { class: 'social-world-icon', 'aria-hidden': 'true', text: '✦' }), el('div', { class: 'social-grow' }, el('h3', { class: 'social-section-title', text: world.name }), el('div', { class: 'social-muted social-small', text: `${rooms.length} ${rooms.length === 1 ? 'room' : 'rooms'} · ${world.public === false ? 'Private world' : 'Public world'}` }))));
      if (!rooms.length) card.append(el('p', { class: 'social-muted', text: 'A fresh world, ready for its first room.' }));
      for (const entry of rooms) {
        const current = entry.id === room().id;
        const jump = button('', () => run(`navigate:${entry.id}`, async () => {
          jump.disabled = true;
          try { await onNavigate(entry.id); } finally { if (!destroyed) jump.disabled = current; }
        }), { class: 'social-room-card', 'data-current': String(current), disabled: current, 'aria-label': current ? `${entry.name}, current room` : `Enter ${entry.name}` });
        jump.append(el('span', { class: 'social-grow' }, el('span', { class: 'social-room-name', text: entry.name }), el('span', { class: 'social-room-meta', text: `${entry.public === false ? 'Private' : 'Public'}${entry.role ? ` · ${entry.role}` : ''}${entry.online != null ? ` · ${entry.online} online` : ''}` })), el('span', { class: 'social-room-badge', text: current ? 'You’re here' : 'Enter ↗' }));
        card.append(jump);
      }
      nodes.push(card);
    }
    if (!nodes.length) nodes.push(empty(needle ? 'No worlds or rooms match your search.' : 'Create a world and make yourself at home.'));
    explorerList.replaceChildren(...nodes);
  }
  function buildCreateForm() {
    const creating = createMode;
    const name = input({ required: 'required', maxlength: '80', placeholder: creating === 'world' ? 'A name for your world' : 'A name for your room', 'aria-label': `${creating === 'world' ? 'World' : 'Room'} name` });
    const worldSelect = el('select', { class: 'input social-input', required: 'required', 'aria-label': 'Choose world' });
    for (const world of (localWorlds || currentState().worlds || []).filter((entry) => entry.ownerId === user().id)) worldSelect.append(el('option', { value: world.id, text: world.name }));
    worldSelect.value = room().worldId || worldSelect.value;
    const visibility = el('select', { class: 'input social-input', 'aria-label': 'Visibility' }, el('option', { value: 'public', text: 'Public' }), el('option', { value: 'private', text: 'Private' }));
    const submit = button(`Create ${creating}`, async () => {
      if (!form.reportValidity() || busy.has(`create:${creating}`)) return;
      const text = name.value.trim();
      if (!text) { name.focus(); return; }
      await run(`create:${creating}`, async () => {
        submit.disabled = true; back.disabled = true; clearNotice();
        try {
          const body = { name: text, public: visibility.value === 'public' };
          if (creating === 'room') body.worldId = worldSelect.value;
          const result = await api(creating === 'world' ? '/api/worlds' : '/api/rooms', { method: 'POST', body });
          localWorlds = null; createMode = ''; await loadWorlds(true); resetView();
          report(`${creating === 'world' ? 'World' : 'Room'} created`);
          if (creating === 'room' && result.room?.id) await onNavigate(result.room.id);
        } finally { submit.disabled = false; back.disabled = false; }
      });
    }, { class: 'button social-btn social-btn-primary' });
    const back = button('← Back to explore', () => { createMode = ''; resetView(); }, { class: 'button social-btn social-btn-small social-btn-quiet' });
    const form = el('form', { class: 'social-scroll social-stack', onsubmit: (event) => { event.preventDefault(); submit.click(); } }, back, el('h3', { class: 'social-section-title', text: `Create a ${creating}` }), noticeNode,
      field('Name', name), creating === 'room' ? field('World', worldSelect) : null, field('Visibility', visibility, 'Private spaces only admit their owner and added members.'), submit);
    if (creating === 'room' && !worldSelect.options.length) { submit.disabled = true; form.append(notice('Create a world first, then add a room to it.')); }
    panel.append(form); name.focus();
  }

  async function saveProfile(values) {
    const result = await api('/api/me', { method: 'PATCH', body: values });
    if (destroyed) return result.user || values;
    const updated = result.user || result.session?.user || values;
    Object.assign(user(), updated);
    const self = (currentState().people || []).find((person) => person.id === user().id);
    if (self) Object.assign(self, updated);
    window.dispatchEvent(new CustomEvent('profile-updated', { detail: { user: { ...user() } } }));
    syncHeader();
    return updated;
  }
  function buildSettings() {
    const self = user(); profileSelection = Math.max(0, Math.min(5, Number(self.woka) || 0));
    const name = input({ required: 'required', maxlength: '32', 'aria-label': 'Display name' }); name.value = self.name || '';
    const availability = el('select', { class: 'input social-input', 'aria-label': 'Availability' });
    for (const value of ['online', 'away', 'busy']) availability.append(el('option', { value, text: STATUS_LABELS[value] }));
    availability.value = self.status || 'online';
    profileAvatar = el('div', { class: 'social-row' }, avatar(self, true), el('div', {}, el('h3', { class: 'social-section-title', text: self.name || 'Explorer' }), el('div', { class: 'social-muted', text: self.account ? 'Local account' : 'Guest explorer' })));
    const grid = el('div', { class: 'social-woka-grid', role: 'group', 'aria-label': 'Choose your Woka' });
    const wokaButtons = [];
    for (let index = 0; index < 6; index++) {
      const choice = button('', () => {
        profileSelection = index;
        for (const [value, node] of wokaButtons.entries()) node.setAttribute('aria-pressed', String(value === index));
        profileAvatar.firstChild.replaceWith(avatar({ ...self, woka: index }, true));
      }, { class: 'social-woka', 'aria-label': `Choose Woka ${index + 1}`, 'aria-pressed': String(profileSelection === index) });
      choice.append(avatar({ woka: index })); wokaButtons.push(choice); grid.append(choice);
    }
    noticeNode = el('div');
    const save = button('Save profile', async () => {
      if (!profileForm.reportValidity() || busy.has('profile')) return;
      const value = name.value.trim(); if (!value) { name.focus(); return; }
      await run('profile', async () => {
        save.disabled = true; clearNotice();
        try {
          await saveProfile({ name: value, ...(onAvatar?{}:{woka:profileSelection}), status: availability.value });
          profileAvatar.children[1].firstChild.textContent = user().name;
          noticeNode.replaceChildren(notice('Profile saved. Everyone in the room sees your updated character.'));
          report('Profile saved');
        } finally { save.disabled = false; }
      });
    }, { class: 'button social-btn social-btn-primary' });
    profileForm = el('form', { class: 'social-scroll social-stack', onsubmit: (event) => { event.preventDefault(); save.click(); } }, profileAvatar, noticeNode, field('Display name', name), field('Availability', availability), el('h3', { class: 'social-section-title', text: 'Your 3D character' }), onAvatar?button('Edit your 3D character',()=>onAvatar(),{class:'button social-btn social-btn-primary'}):grid, save,
      el('div', { class: 'social-notice' }, 'Use WASD or arrow keys to move. Use the camera controls to zoom and rotate. Your room conversations and profile are saved on this server.'));
    if (!self.account) {
      const username = input({ minlength: '3', maxlength: '32', autocomplete: 'username', 'aria-label': 'Account username', placeholder: 'Choose a username' });
      const password = input({ type: 'password', minlength: '10', autocomplete: 'new-password', 'aria-label': 'Account password', placeholder: 'At least 10 characters' });
      const accountNotice = el('div');
      const register = button('Keep this profile', async () => {
        if (!username.value.trim() || password.value.length < 10) { accountNotice.replaceChildren(notice('Choose a username and a password of at least 10 characters.', true)); return; }
        register.disabled = true;
        try { const result = await api('/api/account', { method: 'POST', body: { username: username.value.trim(), password: password.value } }); password.value = ''; Object.assign(user(), result.user);profileAvatar.children[1].lastChild.textContent='Local account'; accountBox.replaceChildren(notice('Your local account is ready. Sign in with this username on this same server to keep your worlds and progress.')); }
        catch (error) { accountNotice.replaceChildren(notice(error.message, true)); } finally { register.disabled = false; }
      }, { class: 'button social-btn social-btn-primary' });
      const accountBox = el('section', { class: 'social-stack' }, el('h3', { class: 'social-section-title', text: 'Keep your place' }), el('p', { class: 'social-muted', text: 'Save a local account before clearing this browser. This standalone server has no email or password-recovery service.' }), field('Username', username), field('Password', password), accountNotice, register);
      profileForm.append(accountBox);
    } else profileForm.append(notice(`Signed in locally as ${self.username}. Your account belongs to this server.`));
    const signOut = button('Sign out', () => confirmAction('Sign out and discard any unsaved room edits?', 'Sign out', async () => { await api('/api/logout', { method: 'POST', body: {} }); window.dispatchEvent(new CustomEvent('session-ended')); }, signOut), { class: 'button social-btn social-btn-quiet' });
    profileForm.append(signOut); panel.append(profileForm);
  }

  function onEvent(event) {
    if (destroyed || !event) return;
    const type = event.type || event.event;
    let data = event.data ?? event.payload ?? event;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return; } }
    if (type === 'proximity-text-context') return nearby.acceptContext(data);
    if (type === 'proximity-text-message') return nearby.receive(data);
    if (type === 'message' || type === 'dm') {
      const message = data.message || data;
      let key;
      if (type === 'dm' || message.recipientId || message.toUserId) {
        const peerId = message.userId === user().id ? message.recipientId || message.toUserId || data.peerId : message.userId;
        if (!peerId) return;
        key = `dm:${peerId}`; conversationsLoaded = false;
        const existing = conversations.find((item) => (item.user?.id || item.userId) === peerId);
        const peer = existing?.user || (message.userId !== user().id ? message.author : selectedPeer?.id === peerId ? selectedPeer : (currentState().people || []).find((person) => person.id === peerId));
        if (peer) conversations = [{ user: peer, userId: peerId, lastMessage: message }, ...conversations.filter((item) => (item.user?.id || item.userId) !== peerId)];
      } else key = `room:${message.roomId || data.roomId || room().id}`;
      const alreadyKnown = getChannel(key).messages.some((item) => item.id === message.id);
      upsertMessage(key, message);
      if (!alreadyKnown && message.userId !== user().id && (root.hidden || activeTab !== 'chat' || chatMode === 'inbox' || key !== channelKey())) unread.set(key, (unread.get(key) || 0) + 1);
      syncHeader();
      if (activeTab === 'chat' && chatMode === 'inbox') renderInbox?.();
    } else if (['presence', 'members', 'room', 'role', 'hello'].includes(type)) {
      if (type === 'hello') { for (const bucket of cache.values()) bucket.loaded = false; conversationsLoaded = false; if (activeTab === 'chat' && !['inbox','nearby'].includes(chatMode)) loadMessages(channelKey(), true); }
      if (type === 'room') { localWorlds = null; if (activeTab === 'explore') loadWorlds(true); }
      render();
    } else if (type === 'moderation') {
      if ((data.userId || data.targetId) === user().id) {
        const messages = { mute: 'A moderator muted your room chat.', unmute: 'Your room chat is unmuted.', kick: 'A moderator removed you from the room.', ban: 'You can no longer enter this room.', unban: 'Your room ban has been lifted.' };
        report(messages[data.action] || 'Your room permissions changed.', 'info');
      }
      render();
    }
  }
  function destroy() {
    destroyed = true; nearby.destroy(); dismissConfirm();
    root.removeEventListener('keydown', stopGameKeys); root.removeEventListener('keyup', stopGameKeys);
    root.replaceChildren(); root.classList.remove('social-shell');
  }
  render();
  return { render, onEvent, destroy, setTab, openDm, resetNearbyConnection: reason => nearby.resetConnection(reason), getNearbyStatus: () => nearby.snapshot() };
}
