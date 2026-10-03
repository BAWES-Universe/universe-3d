/** Compact contextual bubble controls. DOM is retained so updates never replace a focused button. */
// Exact source icon geometry at bae18306bdfa63e58cd4124b1a3b5b290b61c286:
// FollowIcon 48afbb69; LockIcon 210ec8c7; LockOpenIcon ac3be705. Only Svelte/hover bindings removed.
const paths = {
  follow:['M7 5a2 2 0 1 1 -4 0a2 2 0 0 1 4 0z','M5 7v9.5a3.5 3.5 0 0 0 7 0v-9a3.5 3.5 0 0 1 7 0v13.5','M16 18l3 3l3 -3'],
  lock:['M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6z','M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0','M8 11v-4a4 4 0 1 1 8 0v4'],
  unlock:['M5 11m0 2a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2z','M12 16m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0','M8 11v-5a4 4 0 0 1 8 0']
};
function icon(name) {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  for (const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.5','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false'})) svg.setAttribute(key,value);
  for (const d of paths[name]) { const path = document.createElementNS(ns, 'path'); path.setAttribute('d',d); svg.append(path); }
  return svg;
}
function element(tag, className, text) { const n = document.createElement(tag); n.className = className; if (text) n.textContent = text; return n; }
function button(text, action, glyph) {
  const n = element('button', 'proximity-control'); n.type = 'button';
  if (glyph) n.append(icon(glyph));
  const label = element('span', 'proximity-control-label', text); n.append(label);
  n.addEventListener('click', () => { if (n.getAttribute('aria-disabled') !== 'true') void action(); });
  return {node:n,label};
}
const attr = (node,key,value) => { const text = String(value); if (node.getAttribute(key) !== text) node.setAttribute(key,text); };
const setText = (node,text) => { if (node.textContent !== text) node.textContent = text; };
const unavailable = (node, yes) => attr(node,'aria-disabled', String(!!yes));
export function mountProximityControls({root, controller, onReturnFocus = () => {}, interval = 500}) {
  if (!root || !controller) throw new TypeError('Controls need root and controller');
  root.classList.add('proximity-controls'); root.setAttribute('role','region'); root.setAttribute('aria-label','Nearby conversation controls'); root.hidden = true;
  const summary = element('p', 'proximity-summary'); summary.tabIndex = -1;
  const detail = element('span','proximity-summary-detail');
  const count = element('strong','proximity-count'); summary.append(count,detail);
  const invitations = element('div','proximity-invitations');
  const strip = element('div','proximity-control-strip');
  const lock = button('Lock', () => controller.lock(!controller.snapshot().context?.locked), 'unlock');
  lock.node.dataset.control = 'lock';
  const follow = button('Follow me', () => controller.followAction(), 'follow'); follow.node.dataset.control = 'follow';
  const ignore = button('Invites on', () => controller.setIgnoreRequests(!controller.snapshot().ignoreRequests)); ignore.node.dataset.control = 'ignore';
  attr(ignore.node,'aria-label','Ignore follow invitations'); ignore.node.title = 'Ignore follow invitations';
  strip.append(lock.node, follow.node, ignore.node);
  const status = element('p','proximity-status'); status.setAttribute('role','status'); status.setAttribute('aria-live','polite'); status.setAttribute('aria-atomic','true');
  const feedback = element('div','proximity-feedback');
  const refresh = button('Refresh', () => controller.refresh()); refresh.node.dataset.control = 'refresh';
  feedback.append(status,refresh.node);
  root.append(summary,invitations,strip,feedback);
  const rows = new Map(); let destroyed = false;
  function focusFallback() { if (!root.hidden) summary.focus({preventScroll:true}); else onReturnFocus(); }
  function hide(node, value) { if (value && !node.hidden && node.contains(document.activeElement)) { node.hidden = true; focusFallback(); } else node.hidden = value; }
  function render() {
    if (destroyed) return;
    const s = controller.snapshot(), c = s.context;
    const visible = s.available && (!!c?.memberId || s.stopUnconfirmed);
    const hadFocus = root.contains(document.activeElement); root.hidden = !visible;
    if (!visible) { if (hadFocus) onReturnFocus(); return; }
    setText(count,c.bubbleId ? `${c.participants.length} nearby` : 'Nearby');
    count.title = c.participants.map(p => p.name).join(', ');
    setText(detail,c.bubbleId ? [c.locked ? 'Locked' : 'Open', c.full ? 'Full' : ''].filter(Boolean).join(' · ') : 'Outside a conversation');
    const lockName = c.locked ? 'Unlock' : 'Lock'; setText(lock.label,lockName);
    attr(lock.node,'aria-label',`${lockName} nearby conversation`); attr(lock.node,'aria-pressed',String(c.locked));
    const glyph = c.locked ? 'lock' : 'unlock'; if (lock.node.dataset.glyph !== glyph) { lock.node.querySelector('svg').replaceWith(icon(glyph)); lock.node.dataset.glyph = glyph; }
    hide(lock.node,!c.bubbleId); unavailable(lock.node,!s.canAct || !c.canLock || !!s.operation);
    const following = !!c.following;
    setText(follow.label,s.canStop ? following ? 'Stop following' : 'Stop leading' : 'Follow me');
    if (s.canStop && !following && !s.serverLeading) setText(follow.label,'Stop');
    attr(follow.node,'aria-label',follow.label.textContent); attr(follow.node,'aria-pressed',String(s.canStop));
    const shortcutStop = following || s.serverLeading || s.stopUnconfirmed || ['accept','invite'].includes(s.operation?.action);
    follow.node.title = s.canStop ? shortcutStop ? 'Stop locally immediately; also request server stop (F)' : 'Cancel pending follow invitations' : 'Invite nearby participants to follow you (F)';
    follow.node.dataset.stop = String(s.canStop);
    unavailable(follow.node, s.canStop ? s.operation?.action === 'stop' : !s.canAct || !c.canInvite || !!s.operation);
    hide(follow.node,!s.canStop && !c.bubbleId);
    attr(ignore.node,'aria-pressed',String(s.ignoreRequests)); setText(ignore.label,s.ignoreRequests ? 'Invites off' : 'Invites on');
    ignore.node.title = s.preferencePending ? 'Ignore preference is awaiting server confirmation' : s.ignoreRequests ? 'Allow follow invitations' : 'Ignore follow invitations';
    unavailable(ignore.node,!s.canAct || !!s.operation);
    const wanted = new Set();
    for (const invitation of s.invitations) {
      const id = invitation.invitationId; wanted.add(id); let row = rows.get(id);
      if (!row) {
        const node = element('div','proximity-invitation'), title = element('p','proximity-invitation-title');
        node.dataset.invitationId = id;
        const actions = element('div','proximity-invitation-actions');
        const accept = button('Accept', () => controller.accept(id)); accept.node.classList.add('proximity-primary');
        const decline = button('Decline', () => controller.decline(id));
        actions.append(decline.node,accept.node); node.append(title,actions); invitations.append(node);
        row = {node,title,actions,accept,decline}; rows.set(id,row);
      }
      setText(row.title,invitation.expired ? `${invitation.leaderName}’s invitation expired` : `${invitation.leaderName} invites you to follow`);
      attr(row.accept.node,'aria-label',`Accept ${invitation.leaderName}’s follow invitation`);
      attr(row.decline.node,'aria-label',`Decline ${invitation.leaderName}’s follow invitation`);
      unavailable(row.accept.node,!s.canAct || !!s.operation || invitation.expired || s.stopUnconfirmed);
      unavailable(row.decline.node,!s.canAct || !!s.operation || invitation.expired);
      row.node.dataset.expired = String(invitation.expired);
    }
    for (const [id,row] of rows) if (!wanted.has(id)) { const focused = row.node.contains(document.activeElement); row.node.remove(); rows.delete(id); if (focused) focusFallback(); }
    const secondary = following && !c.following.controlling;
    const stateText = s.localStopped && s.stopUnconfirmed ? 'Stopped here. Server confirmation pending.' : following ? !c.following.controllerConnected ? `Following ${c.following.leaderName} is paused. The controlling tab is disconnected.` : secondary ? `Following ${c.following.leaderName} in another tab. No automatic movement here.` : s.motion ? `Following ${c.following.leaderName}` : `Following ${c.following.leaderName} is paused here.` : s.serverLeading ? c.followers.length ? `${c.followers.map(p => p.name).join(', ')} ${c.followers.length === 1 ? 'is' : 'are'} following you` : 'Waiting for others to accept' : '';
    setText(status,s.error || stateText || (s.operation ? ({lock:'Updating lock…',invite:'Sending invitations…',accept:'Accepting invitation…',decline:'Declining invitation…',stop:'Stopping…',preferences:'Saving invitation preference…'}[s.operation.action]) : s.notice || (s.preferencePending ? 'Invitation preference is not confirmed yet.' : '')));
    status.dataset.error = String(!!s.error);
    hide(feedback,!status.textContent); hide(refresh.node,!s.error && !s.stopUnconfirmed); unavailable(refresh.node,!!s.operation || !s.canAct);
    root.dataset.followState = s.motion ? 'following' : s.serverLeading ? 'leading' : s.invitations.length ? 'invited' : 'idle';
  }
  function keydown(event) {
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape' && !event.repeat) {
      event.preventDefault(); const row = event.target.closest('[data-invitation-id]');
      if (row) { void controller.decline(row.dataset.invitationId); return; }
      if (controller.snapshot().canStop) void controller.stop(); else onReturnFocus();
    }
  }
  const stopKeys = event => event.stopPropagation();
  root.addEventListener('keydown',keydown); root.addEventListener('keyup',stopKeys);
  const unsubscribe = controller.subscribe(render), timer = setInterval(render,interval); render();
  return {render, destroy() { destroyed = true; clearInterval(timer); unsubscribe(); root.removeEventListener('keydown',keydown); root.removeEventListener('keyup',stopKeys); root.replaceChildren(); root.hidden = true; }};
}
