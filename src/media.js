// Real, opt-in WebRTC. Room membership and recipients come only from the server.
// No external STUN/TURN service is configured or contacted by this module.
const KINDS = ['microphone', 'camera', 'screen'];
const MEDIA_KINDS = ['audio', 'video', 'video'];
const labelFor = kind => ({ microphone: 'Microphone', camera: 'Camera', screen: 'Screen sharing' }[kind]);
const currentRoomId = state => state?.room?.id || (typeof state?.room === 'string' ? state.room : null);
const stopStream = stream => stream?.getTracks?.().forEach(track => track.stop());
export function mediaCapabilities(env = globalThis) {
  const secure = env.isSecureContext === true;
  const rtc = typeof env.RTCPeerConnection === 'function';
  const devices = secure && typeof env.navigator?.mediaDevices?.getUserMedia === 'function';
  const display = secure && typeof env.navigator?.mediaDevices?.getDisplayMedia === 'function';
  return { secure, rtc, devices, display,
    deviceReason: !secure ? 'Microphone and camera need HTTPS or localhost.' : !devices ? 'This browser does not expose microphone or camera capture.' : !rtc ? 'This browser does not support WebRTC calls.' : '',
    screenReason: !secure ? 'Screen sharing needs HTTPS or localhost.' : !display ? 'Screen sharing is not available in this browser. Try a supported desktop browser.' : !rtc ? 'This browser does not support WebRTC calls.' : '' };
}
export function describeMediaError(error, kind = 'microphone') {
  const label = labelFor(kind);
  if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') return `${label} was not allowed. Nothing is being shared. You can allow it in your browser and try again.`;
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') return `No ${kind === 'camera' ? 'camera' : 'microphone'} was found. Connect a device and try again.`;
  if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') return `${label} could not start. Another application may be using it.`;
  if (error?.name === 'AbortError') return `${label} was cancelled. Nothing is being shared.`;
  return `${label} could not start: ${String(error?.message || 'browser capture failed').slice(0, 180)}`;
}
export function peerDirection(peer) {
  return peer.canSend && peer.canReceive ? 'sendrecv' : peer.canSend ? 'sendonly' : peer.canReceive ? 'recvonly' : 'inactive';
}
export function policyPeers(policy) {
  const unique = new Map();
  for (const peer of policy?.peers || []) if (peer && typeof peer.id === 'string' && peer.id !== policy.selfId && (peer.canSend || peer.canReceive)) unique.set(peer.id, { ...peer, canSend: peer.canSend === true, canReceive: peer.canReceive === true });
  return [...unique.values()];
}

// Dependency injection here supports isolated unit tests without device permission prompts.
export function createMediaSession({ api, getState, onChange = () => {}, env = globalThis, now = () => Date.now() }) {
  const capabilities = mediaCapabilities(env);
  const streams = { microphone: null, camera: null, screen: null };
  const devices = Object.fromEntries(KINDS.map(k => [k, { status: 'off', error: '' }]));
  const peers = new Map();
  const earlyCandidates = new Map();
  let policy = null, joined = false, joining = false, disposed = false, generation = 0;
  let roomId = currentRoomId(getState()), policyError = '', notice = '', refreshPromise = null;
  let lastRefresh = 0, lastStats = 0, captureSequence = { microphone: 0, camera: 0, screen: 0 };
  let idSequence = 0;
  const nextId = () => env.crypto?.randomUUID?.() || `${now().toString(36)}-${++idSequence}`;
  const emit = () => { if (!disposed) onChange(snapshot()); };
  function snapshot() {
    return { capabilities, roomId, joined, joining, policy, policyError, notice,
      devices: Object.fromEntries(KINDS.map(k => [k, { ...devices[k], stream: streams[k] }])),
      peers: [...peers.values()].map(p => ({ id: p.id, name: p.info.displayName || p.info.name || 'Participant', canSend: p.info.canSend, canReceive: p.info.canReceive,
        status: p.status, error: p.error, candidateCount: p.candidateCount, gathering: p.pc.iceGatheringState,
        streams: { ...p.remote }, receivedBytes: p.receivedBytes, sentBytes: p.sentBytes })) };
  }
  function dropPeer(id) {
    const p = peers.get(id); if (!p) return;
    peers.delete(id); p.closed = true;
    if (p.timeout) env.clearTimeout(p.timeout);
    p.pc.onicecandidate = p.pc.onconnectionstatechange = p.pc.oniceconnectionstatechange = p.pc.onicegatheringstatechange = p.pc.ontrack = null;
    try { p.pc.close(); } catch {}
    for (const stream of Object.values(p.remote)) stopStream(stream);
    p.remote = {};
  }
  function closePeers() { for (const id of [...peers.keys()]) dropPeer(id); earlyCandidates.clear(); }
  function stopDevice(kind, reason = '') {
    captureSequence[kind]++;
    const stream = streams[kind]; streams[kind] = null;
    devices[kind] = { status: 'off', error: reason };
    stopStream(stream);
    for (const p of peers.values()) void applyTracks(p);
  }
  async function applyTracks(p) {
    if (p.closed || !joined) return;
    const transceivers = p.pc.getTransceivers();
    for (let i = 0; i < transceivers.length && i < KINDS.length; i++) {
      const transceiver = transceivers[i];
      const track = p.info.canSend ? streams[KINDS[i]]?.getTracks().find(t => t.kind === MEDIA_KINDS[i] && t.readyState !== 'ended') || null : null;
      try { if (transceiver.sender.track !== track) await transceiver.sender.replaceTrack(track); }
      catch (error) { if (!p.closed) { p.error = `Track could not be sent: ${error.message}`; emit(); } }
    }
  }
  const signal = (p, data) => api('/api/media/signal', { method: 'POST', body: { to: p.id, roomId, connectionId: p.connectionId, ...data } });
  function failure(p, error) {
    if (p.closed) return;
    p.status = 'failed'; p.error = String(error?.message || error || 'Connection failed').slice(0, 200); emit();
  }
  function makePeer(info, connectionId = null) {
    const pc = new env.RTCPeerConnection({ iceServers: [] });
    const p = { id: info.id, info, pc, connectionId: connectionId || nextId(), closed: false, status: 'connecting', error: '', remote: {}, candidateCount: 0, receivedBytes: 0, sentBytes: 0, queue: Promise.resolve(), timeout: null };
    peers.set(p.id, p);
    pc.onicecandidate = event => {
      if (p.closed || !event.candidate) return;
      p.candidateCount++;
      void signal(p, { candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate }).catch(error => failure(p, error)); emit();
    };
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete' && p.candidateCount === 0 && pc.connectionState !== 'connected') {
        p.error = 'No local ICE candidates. This browser or network cannot establish a call here.';
      }
      emit();
    };
    const updateConnection = () => {
      if (p.closed) return;
      const state = pc.connectionState || pc.iceConnectionState;
      if (state === 'connected' || state === 'completed') { p.status = 'connected'; p.error = ''; if (p.timeout) env.clearTimeout(p.timeout); }
      else if (state === 'failed') { p.status = 'failed'; p.error = 'WebRTC transport failed. No TURN relay is configured; this network may need one.'; }
      else if (state === 'disconnected') { p.status = 'disconnected'; p.error = 'Connection interrupted. Retry when your network is ready.'; }
      else if (state === 'closed') p.status = 'closed';
      emit();
    };
    pc.onconnectionstatechange = pc.oniceconnectionstatechange = updateConnection;
    pc.ontrack = event => {
      // Receive permissions are checked again, independently of remote SDP.
      if (p.closed || !p.info.canReceive || !joined) { event.track.stop(); return; }
      const index = pc.getTransceivers().indexOf(event.transceiver);
      const kind = KINDS[index] || (event.track.kind === 'audio' ? 'microphone' : 'camera');
      const stream = new env.MediaStream([event.track]); p.remote[kind] = stream;
      event.track.onmute = event.track.onunmute = () => emit();
      event.track.onended = () => { if (p.remote[kind] === stream) delete p.remote[kind]; emit(); };
      emit();
    };
    p.timeout = env.setTimeout(() => {
      if (!p.closed && p.status !== 'connected') failure(p, p.candidateCount ? 'Connection timed out. This peer or network is unreachable; no TURN relay is configured.' : 'No usable ICE candidates were gathered. Calls cannot connect in this browser or network.');
    }, 15000);
    return p;
  }
  async function offer(p) {
    if (p.closed) return;
    try {
      if (!p.pc.getTransceivers().length) for (const kind of MEDIA_KINDS) p.pc.addTransceiver(kind, { direction: peerDirection(p.info) });
      await applyTracks(p); if (p.closed) return;
      await p.pc.setLocalDescription(await p.pc.createOffer()); if (p.closed) return;
      await signal(p, { description: { type: p.pc.localDescription.type, sdp: p.pc.localDescription.sdp } });
    } catch (error) { failure(p, error); }
  }
  function reconcile() {
    if (!joined || !capabilities.rtc || !policy || policy.roomId !== roomId) { closePeers(); return; }
    const allowed = new Map(policyPeers(policy).map(p => [p.id, p]));
    for (const [id, p] of peers) {
      const next = allowed.get(id);
      if (!next || peerDirection(next) !== peerDirection(p.info)) dropPeer(id);
      else p.info = next;
    }
    for (const info of allowed.values()) if (!peers.has(info.id) && policy.selfId < info.id) {
      const p = makePeer(info); void offer(p);
    }
  }
  function acceptPolicy(next) {
    if (disposed || !next || next.roomId !== roomId || currentRoomId(getState()) !== roomId) return;
    policy = next; policyError = '';
    if (joined && next.enabled === false) { joined = false; for (const kind of KINDS) stopDevice(kind); closePeers(); notice = 'The server ended this media session. Join again to reconnect.'; }
    // Entering a listening-only or quiet area stops capture, rather than hiding a live microphone.
    if (next.context?.canPublish === false || next.context?.kind === 'silent') for (const kind of KINDS) if (streams[kind]) stopDevice(kind, next.context?.kind === 'silent' ? 'Stopped in this quiet area.' : 'This area is listen-only.');
    reconcile(); emit();
  }
  async function refreshPolicy(force = false) {
    if (disposed || !currentRoomId(getState())) return null;
    if (refreshPromise) return refreshPromise;
    if (!force && now() - lastRefresh < 900) return policy;
    const expectedRoom = roomId, epoch = generation; lastRefresh = now();
    refreshPromise = (async () => {
      try {
        const next = await api('/api/media');
        if (disposed || epoch !== generation || expectedRoom !== roomId) return null;
        if (next.roomId !== roomId) { policyError = 'Room changed. Media is paused until the server confirms your room.'; closePeers(); return null; }
        acceptPolicy(next); return next;
      } catch (error) {
        if (epoch === generation && !disposed) { policyError = `Media policy unavailable: ${String(error?.message || 'server unreachable').slice(0, 150)}`; closePeers(); emit(); }
        return null;
      } finally { refreshPromise = null; }
    })();
    return refreshPromise;
  }
  async function setJoined(value) {
    if (disposed || (value && (joining || joined)) || (!value && !joined && !joining)) return joined;
    if (value && !capabilities.rtc) { notice = 'This browser does not support WebRTC calls.'; emit(); return false; }
    if (!value) {
      joined = false; generation++; joining = false;
      for (const kind of KINDS) stopDevice(kind); closePeers(); emit();
      try { await api('/api/media/state', { method: 'POST', body: { enabled: false } }); } catch (error) { notice = `Devices stopped. Server leave could not be confirmed: ${error.message}`; }
      emit(); return false;
    }
    const epoch = generation; joining = true; notice = ''; emit();
    try {
      await api('/api/media/state', { method: 'POST', body: { enabled: true } });
      if (disposed || epoch !== generation) return false;
      joined = true; await refreshPolicy(true); return true;
    } catch (error) { notice = `Could not join audio: ${String(error?.message || 'server unreachable').slice(0, 150)}`; return false; }
    finally { if (epoch === generation) joining = false; emit(); }
  }
  async function toggleDevice(kind) {
    if (!KINDS.includes(kind) || disposed) return false;
    if (streams[kind] || devices[kind].status === 'requesting') { stopDevice(kind); emit(); return false; }
    const reason = kind === 'screen' ? capabilities.screenReason : capabilities.deviceReason;
    if (reason) { devices[kind] = { status: 'unavailable', error: reason }; emit(); return false; }
    if (policy?.context?.canPublish === false || policy?.context?.kind === 'silent') { devices[kind] = { status: 'off', error: policy?.context?.kind === 'silent' ? 'Quiet areas pause all media.' : 'Audience members can listen. Move to the stage to publish.' }; emit(); return false; }
    const epoch = generation, sequence = ++captureSequence[kind];
    devices[kind] = { status: 'requesting', error: '' }; notice = ''; emit();
    let stream;
    try {
      // Invoke immediately from the user's click so getDisplayMedia retains activation.
      const capture = kind === 'screen'
        ? env.navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
        : env.navigator.mediaDevices.getUserMedia(kind === 'camera' ? { video: { width: { ideal: 640 }, height: { ideal: 360 } }, audio: false } : { video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      stream = await capture;
      if (disposed || epoch !== generation || sequence !== captureSequence[kind]) { stopStream(stream); return false; }
      if (!stream.getTracks().length) throw new Error('No media track was returned');
      if (!joined && !await setJoined(true)) { stopStream(stream); devices[kind] = { status: 'off', error: 'Capture stopped because the call could not be joined.' }; emit(); return false; }
      await refreshPolicy(true);
      if (disposed || epoch !== generation || sequence !== captureSequence[kind] || !joined || !policy || policyError || policy.context?.canPublish === false || policy.context?.kind === 'silent') { stopStream(stream); devices[kind] = { status: 'off', error: 'Capture stopped because this area does not currently allow publishing.' }; emit(); return false; }
      streams[kind] = stream; devices[kind] = { status: 'on', error: '' };
      for (const track of stream.getTracks()) track.onended = () => { if (streams[kind] === stream) { stopDevice(kind, 'Sharing stopped by your browser or device.'); emit(); } };
      for (const p of peers.values()) await applyTracks(p);
      emit(); return true;
    } catch (error) {
      stopStream(stream);
      if (!disposed && epoch === generation && sequence === captureSequence[kind]) { devices[kind] = { status: 'error', error: describeMediaError(error, kind) }; emit(); }
      return false;
    }
  }
  async function onSignal(event) {
    if (disposed || !joined || !event || event.roomId !== roomId || !event.from || !event.connectionId) return;
    await refreshPolicy(true);
    if (disposed || !joined || event.roomId !== roomId || policyError) return;
    const info = policyPeers(policy).find(p => p.id === event.from); if (!info) return;
    let p = peers.get(info.id);
    if (event.request === 'offer') {
      if (policy.selfId < info.id) { dropPeer(info.id); p = makePeer(info); await offer(p); }
      return;
    }
    if (event.description?.type === 'offer') {
      // Only the lexicographically first server-issued identity originates an offer.
      if (event.from >= policy.selfId) return;
      if (!p || p.connectionId !== event.connectionId) { dropPeer(info.id); p = makePeer(info, event.connectionId); }
      const peer = p;
      p.queue = p.queue.then(async () => {
        if (peer.closed) return;
        await peer.pc.setRemoteDescription(event.description);
        const transceivers = peer.pc.getTransceivers();
        if (transceivers.length !== 3) throw new Error('Unsupported media offer; expected audio, camera and screen slots.');
        for (const t of transceivers) t.direction = peerDirection(info);
        await applyTracks(peer); if (peer.closed) return;
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        if (peer.closed) return;
        await signal(peer, { description: { type: peer.pc.localDescription.type, sdp: peer.pc.localDescription.sdp } });
        for (const candidate of earlyCandidates.get(peer.connectionId) || []) await peer.pc.addIceCandidate(candidate);
        earlyCandidates.delete(peer.connectionId);
      }).catch(error => failure(peer, error));
      await p.queue; return;
    }
    if (!p || p.connectionId !== event.connectionId) {
      if (event.candidate) { const queue = earlyCandidates.get(event.connectionId) || []; if (queue.length < 64 && earlyCandidates.size < 20) { queue.push(event.candidate); earlyCandidates.set(event.connectionId, queue); } }
      return;
    }
    const peer = p;
    peer.queue = peer.queue.then(async () => {
      if (peer.closed) return;
      if (event.description?.type === 'answer') {
        await peer.pc.setRemoteDescription(event.description);
        for (const candidate of earlyCandidates.get(peer.connectionId) || []) await peer.pc.addIceCandidate(candidate);
        earlyCandidates.delete(peer.connectionId);
      } else if (event.candidate) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(event.candidate);
        else { const queue = earlyCandidates.get(peer.connectionId) || []; if (queue.length < 64) queue.push(event.candidate); earlyCandidates.set(peer.connectionId, queue); }
      }
    }).catch(error => failure(peer, error));
    await peer.queue;
  }
  async function retry() {
    if (!joined || disposed) return;
    closePeers(); notice = ''; await refreshPolicy(true);
    for (const info of policyPeers(policy)) if (info.id < policy.selfId) {
      const request = { id: info.id, connectionId: nextId() };
      try { await signal(request, { request: 'offer' }); } catch (error) { notice = `Retry failed: ${error.message}`; }
    }
    emit();
  }
  async function update() {
    if (disposed) return;
    const nextRoom = currentRoomId(getState());
    if (nextRoom !== roomId) {
      generation++; roomId = nextRoom; joined = false; joining = false; policy = null; policyError = ''; lastRefresh = 0;
      for (const kind of KINDS) stopDevice(kind); closePeers();
      notice = nextRoom ? 'You changed rooms. Join audio again when you are ready.' : ''; emit();
      // The room-change endpoint also resets server media opt-in; never send a leave for the old room into a newer room.
    }
    await refreshPolicy();
    if (now() - lastStats > 3000) {
      lastStats = now();
      for (const p of peers.values()) if (!p.closed && p.status === 'connected') {
        try {
          const reports = await p.pc.getStats(); let received = 0, sent = 0;
          reports.forEach(report => { if (report.type === 'inbound-rtp') received += report.bytesReceived || 0; if (report.type === 'outbound-rtp') sent += report.bytesSent || 0; });
          p.receivedBytes = received; p.sentBytes = sent;
        } catch {} // Diagnostics must never terminate a call.
      }
      emit();
    }
  }
  function destroy() {
    if (disposed) return;
    disposed = true; generation++; joined = false;
    for (const kind of KINDS) stopDevice(kind); closePeers();
    // Best-effort opt-out; server also expires disconnected presence.
    void api('/api/media/state', { method: 'POST', body: { enabled: false } }).catch(() => {});
  }
  return { snapshot, update, refreshPolicy, acceptPolicy, setJoined, toggleDevice, retry, onSignal, destroy };
}

const ICONS = {
  microphone: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-7 8v1a7 7 0 0 0 14 0v-1M12 19v3m-4 0h8"/>',
  camera: '<rect x="3" y="6" width="12" height="12" rx="3"/><path d="m15 10 6-3v10l-6-3"/>',
  screen: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4m0-8V7m-3 3 3-3 3 3"/>',
  sound: '<path d="m11 5-6 4H2v6h3l6 4V5Zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.sound}</svg>`;
export function mountMedia({ root, api, getState, toast = () => {} }) {
  if (!root) throw new Error('A media container is required');
  root.classList.add('universe-media');
  root.innerHTML = `<div class="media-peers" aria-label="Call participants"></div><section class="media-dock" aria-label="Live media controls"><div class="media-context"><span class="media-dot"></span><div><strong class="media-context-label">Spatial audio</strong><span class="media-context-detail">Mic and camera stay off until you choose</span></div></div><div class="media-actions"><button class="media-join" type="button">Join audio</button><span class="media-divider"></span>${KINDS.map(k => `<button type="button" class="media-device" data-media="${k}" aria-label="${labelFor(k)} off" aria-pressed="false" title="Turn on ${k}">${icon(k)}<span>${k === 'microphone' ? 'Mic' : k === 'camera' ? 'Camera' : 'Share'}</span></button>`).join('')}<button class="media-details-toggle" type="button" aria-expanded="false" aria-label="Media connection details">···</button></div></section><div class="media-warning" role="status" hidden></div><section class="media-details" aria-label="Media connection details" hidden><div class="media-details-heading"><strong>Connection details</strong><button type="button" class="media-retry">Retry connections</button></div><p class="media-policy-detail"></p><div class="media-transport"></div><p class="media-network-note">Peer-to-peer transport · No relay configured. Calls may fail on restricted networks. Use one active tab per account. Devices are requested only when you turn them on.</p></section>`;
  const $ = selector => root.querySelector(selector);
  let destroyed = false, expanded = false, lastWarning = '', lastRoom = currentRoomId(getState());
  const elements = new Map();
  function mediaTile(key, name, kind, stream, local = false) {
    let tile = elements.get(key);
    if (!tile) {
      const el = document.createElement('div'); el.className = 'media-tile';
      const media = document.createElement(kind === 'microphone' ? 'audio' : 'video'); media.autoplay = true; media.playsInline = true; media.muted = local;
      const title = document.createElement('span'); title.className = 'media-tile-title';
      const fallback = document.createElement('span'); fallback.className = 'media-tile-fallback';
      const play = document.createElement('button'); play.type = 'button'; play.className = 'media-play'; play.textContent = 'Play media'; play.hidden = true;
      play.addEventListener('click', () => { media.play().then(() => { play.hidden = true; }).catch(() => { play.textContent = 'Playback blocked'; }); });
      media.addEventListener('playing', () => { play.hidden = true; });
      el.append(media, fallback, title, play); $('.media-peers').append(el); tile = { el, media, title, fallback, play }; elements.set(key, tile);
    }
    tile.title.textContent = `${name}${kind === 'screen' ? ' · screen' : kind === 'microphone' ? ' · audio' : ''}`;
    const live = stream?.getTracks().some(t => t.readyState === 'live' && !t.muted);
    tile.el.classList.toggle('media-audio-tile', kind === 'microphone'); tile.el.classList.toggle('media-track-muted', !live);
    tile.fallback.textContent = kind === 'microphone' ? (live ? 'Audio track live' : 'No audio arriving') : 'Waiting for video';
    if (tile.media.srcObject !== stream) {
      tile.media.srcObject = stream;
      const playback = tile.media.play();
      playback?.catch(() => { if (!destroyed && elements.has(key) && !local) tile.play.hidden = false; });
    }
    return tile;
  }
  function render(s) {
    if (destroyed) return;
    const context = s.policy?.context;
    const label = context?.label || context?.name || 'Spatial audio';
    $('.media-context-label').textContent = label;
    let detail = s.joining ? 'Joining…' : !s.joined ? 'Mic and camera stay off until you choose' : context?.kind === 'silent' ? 'Quiet area · proximity calls paused' : context?.canPublish === false ? 'Audience · listening only' : s.peers.length ? `${s.peers.length} ${s.peers.length === 1 ? 'participant' : 'participants'} · ${s.peers.filter(p => p.status === 'connected').length} transport connected` : context?.reason || context?.description || 'Ready · stop near someone to connect';
    $('.media-context-detail').textContent = detail;
    $('.media-dot').dataset.state = s.peers.some(p => p.status === 'connected') ? 'connected' : s.joined ? 'ready' : 'off';
    const join = $('.media-join'); join.textContent = s.joining ? 'Joining…' : s.joined ? 'Leave audio' : 'Join audio'; join.disabled = s.joining || !s.capabilities.rtc || !s.roomId; join.classList.toggle('is-joined', s.joined);
    for (const kind of KINDS) {
      const button = $(`[data-media="${kind}"]`), device = s.devices[kind];
      const unsupported = kind === 'screen' ? s.capabilities.screenReason : s.capabilities.deviceReason;
      const denied = context?.canPublish === false || context?.kind === 'silent';
      button.disabled = !!unsupported || denied || !s.roomId;
      button.setAttribute('aria-pressed', device.status === 'on' ? 'true' : 'false');
      button.setAttribute('aria-label', `${labelFor(kind)} ${device.status}`);
      button.title = unsupported || (denied ? context?.kind === 'silent' ? 'Media is paused in quiet areas' : 'Audience members are listen-only' : device.error || (device.status === 'on' ? `Stop ${labelFor(kind).toLowerCase()}` : `Turn on ${labelFor(kind).toLowerCase()}`));
      button.classList.toggle('is-requesting', device.status === 'requesting');
      button.classList.toggle('has-error', device.status === 'error');
    }
    const warning = s.policyError || KINDS.map(k => s.devices[k].error).find(Boolean) || s.notice || (s.peers.some(p => p.status === 'failed') ? 'A call could not connect. Open connection details to retry.' : '');
    $('.media-warning').hidden = !warning; $('.media-warning').textContent = warning;
    if (warning && warning !== lastWarning) { lastWarning = warning; }
    $('.media-policy-detail').textContent = `Server-authorized ${context?.kind || 'room'} recipients. ${context?.reason || context?.description || 'Location and room permissions are evaluated by the server.'}`;
    const transport = $('.media-transport'); transport.replaceChildren();
    const connectionRows = s.peers.length ? s.peers.map(p => `${p.name}: ${p.status === 'connected' ? 'transport connected' : p.status} · ${p.candidateCount} local ICE candidates · ${p.receivedBytes} bytes received${p.error ? ` — ${p.error}` : ''}`) : [s.joined ? 'No eligible opted-in participants yet.' : 'Not in a call. No peer connection is active.'];
    for (const row of connectionRows) { const p = document.createElement('p'); p.textContent = row; transport.append(p); }
    if (!s.capabilities.secure || !s.capabilities.devices || !s.capabilities.display || !s.capabilities.rtc) { const p = document.createElement('p'); p.textContent = [s.capabilities.deviceReason, s.capabilities.screenReason].filter(Boolean).join(' '); transport.append(p); }
    $('.media-retry').disabled = !s.joined;
    const used = new Set();
    for (const kind of ['camera', 'screen']) if (s.devices[kind].stream) { const key = 'self-' + kind; used.add(key); mediaTile(key, 'You', kind, s.devices[kind].stream, true); }
    for (const p of s.peers) for (const [kind, stream] of Object.entries(p.streams)) {
      // SDP may announce inactive video slots. Do not show empty tiles as a live feed.
      if (!stream.getTracks().some(track => track.readyState === 'live' && !track.muted)) continue;
      const key = p.id + '-' + kind; used.add(key); mediaTile(key, p.name, kind, stream);
    }
    for (const [key, tile] of elements) if (!used.has(key)) { tile.media.pause(); tile.media.srcObject = null; tile.el.remove(); elements.delete(key); }
  }
  const session = createMediaSession({ api, getState, onChange: render });
  const handle = promise => promise.catch(error => toast(error?.message || 'Media operation failed'));
  $('.media-join').addEventListener('click', () => handle(session.setJoined(!session.snapshot().joined)));
  for (const kind of KINDS) $(`[data-media="${kind}"]`).addEventListener('click', () => handle(session.toggleDevice(kind)));
  $('.media-retry').addEventListener('click', () => handle(session.retry()));
  $('.media-details-toggle').addEventListener('click', () => { expanded = !expanded; $('.media-details').hidden = !expanded; $('.media-details-toggle').setAttribute('aria-expanded', String(expanded)); });
  render(session.snapshot()); void session.update();
  const interval = setInterval(() => void session.update(), 1100);
  return {
    onEvent(event) {
      const type = event?.type || event?.event;
      if (type === 'media-signal') void session.onSignal(event.data ? { ...event.data, type } : event);
      if (type === 'media-policy') session.acceptPolicy(event.data || event);
      if (['presence', 'scene', 'room', 'role', 'moderation'].includes(type)) void session.update();
    },
    update() { const room = currentRoomId(getState()); if (room !== lastRoom) { lastRoom = room; expanded = false; $('.media-details').hidden = true; $('.media-details-toggle').setAttribute('aria-expanded', 'false'); } void session.update(); },
    destroy() { destroyed = true; clearInterval(interval); session.destroy(); for (const tile of elements.values()) { tile.media.pause(); tile.media.srcObject = null; } elements.clear(); root.replaceChildren(); },
    // Read-only diagnostics for automated checks; no fixture identities or synthetic success.
    getStatus: () => session.snapshot()
  };
}
