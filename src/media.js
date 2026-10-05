import {createIceCache} from './media-ice.js';
import {createAwayMicrophonePreference,createAwayLatch,readAwayConversation} from './media-away.js';
import {SILENT_MEDIA_MESSAGE,SILENT_MEDIA_EXIT_MESSAGE} from './media-policy-copy.js';
// Real, opt-in WebRTC. Room membership and recipients come only from the server.
// Server-authorized ICE only; an unconfigured server provides honest host-only transport.
const KINDS = ['microphone', 'camera', 'screen'];
const MEDIA_KINDS = ['audio', 'video', 'video'];
const POLICY_TIMEOUT_MS = 8000;
const POLICY_TIMEOUT_MESSAGE = 'Current media policy request timed out. Devices and connections have been stopped; retry when connected.';
const POLICY_CONFIRM_MESSAGE = 'Media is paused until the server confirms your current location. Devices stay off until you turn them on again.';
// Same inclusive axis-aligned test as world areas, kept local so media stays standalone.
const containsCommittedArea = (area, x, z) => Math.abs(x-area.x) <= area.width/2 && Math.abs(z-area.z) <= area.depth/2;
const labelFor = kind => ({ microphone: 'Microphone', camera: 'Camera', screen: 'Screen sharing' }[kind]);
const currentRoomId = state => state?.room?.id || (typeof state?.room === 'string' ? state.room : null);
const currentActorId = state => state?.user?.id || null;
const currentAdmissionId = state => state?.admissionId || null;
const hasProximityScope = policy => policy?.proximityMembership !== undefined;
const opaqueId = value => typeof value === 'string' && value.length > 0;
const counter = value => Number.isSafeInteger(value) && value >= 0;
// Validate policy shape independently of eligibility: a lone member legitimately
// has no bubble/transport. Unknown or malformed opt-in data never downgrades.
const proximityPolicyError = policy => {
  if (!hasProximityScope(policy)) return '';
  const scope = policy.proximityMembership, transport = scope?.transport;
  const invalid = 'Invalid or unsupported proximity media policy. Devices and connections are paused.';
  if (scope?.protocol !== 'proximity-v1' || policy.context?.kind !== 'proximity' || typeof policy.enabled !== 'boolean' || typeof policy.context.canPublish !== 'boolean' || !opaqueId(scope.memberId) || !Array.isArray(policy.peers) || policy.peers.some(peer => !opaqueId(peer?.id) || !opaqueId(peer.memberId) || typeof peer.canSend !== 'boolean' || typeof peer.canReceive !== 'boolean')) return invalid;
  if (scope.bubbleId === null) return scope.membershipRevision === null && scope.mediaScope === null && transport === null && policy.peers.length === 0 ? '' : invalid;
  return opaqueId(scope.bubbleId) && counter(scope.membershipRevision) && opaqueId(scope.mediaScope) &&
    counter(transport?.intentGeneration) && counter(transport?.memberCount) && typeof transport?.p2pAllowed === 'boolean' &&
    ['p2p','sfu'].includes(transport?.requiredTransport) && ['p2p','sfu'].includes(transport?.selectionIntent) ? '' : invalid;
};
const proximityP2PAllowed = policy => {
  if (!hasProximityScope(policy)) return true;
  const transport = policy.proximityMembership?.transport;
  return !proximityPolicyError(policy) && transport?.p2pAllowed === true && transport.requiredTransport === 'p2p' && transport.selectionIntent === 'p2p' && !transport.blockedReason;
};
const proximityAuthority = policy => {
  if (!hasProximityScope(policy)) return null;
  const scope = policy.proximityMembership, transport = scope?.transport;
  return [scope?.protocol,scope?.memberId,scope?.bubbleId,scope?.mediaScope,
    transport?.intentGeneration,transport?.selectionIntent,transport?.p2pAllowed,transport?.requiredTransport,transport?.blockedReason,policy.enabled,
    (Array.isArray(policy.peers) ? policy.peers : []).map(peer => [peer?.id,peer?.memberId,peer?.canSend === true,peer?.canReceive === true]).sort((a,b) => String(a[0]).localeCompare(String(b[0])))];
};
export function proximityMediaNotice(policy) {
  const invalid = proximityPolicyError(policy); if (invalid) return invalid;
  const scope = policy?.proximityMembership;
  if (scope?.protocol === 'proximity-v1' && scope.transport?.blockedReason === 'sfu-unavailable') {
    const count = scope.transport.memberCount;
    return `SFU unavailable. ${Number.isSafeInteger(count) ? `This conversation has ${count} members; ` : ''}audio, camera and screen-sharing transport is paused.`;
  }
  return '';
}
const publishingDenied = policy => policy?.context?.canPublish === false || policy?.context?.kind === 'silent';
const denialReason = context => context?.kind === 'silent' ? SILENT_MEDIA_MESSAGE : context?.reason || (context?.kind === 'audience' ? 'Audience members can listen. Move to the stage to publish.' : 'Publishing is not allowed in this area.');
const stopStream = (stream, remove = false) => { for (const track of [...(stream?.getTracks?.() || [])]) { track.stop(); if (remove) stream.removeTrack?.(track); } };
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
  if (error?.name === 'OverconstrainedError') return `The selected ${kind === 'camera' ? 'camera' : 'microphone'} is unavailable. Choose another device in Settings and try again.`;
  if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') return `${label} could not start. Another application may be using it.`;
  if (error?.name === 'AbortError') return `${label} was cancelled. Nothing is being shared.`;
  return `${label} could not start: ${String(error?.message || 'browser capture failed').slice(0, 180)}`;
}
export function peerDirection(peer) {
  return peer.canSend && peer.canReceive ? 'sendrecv' : peer.canSend ? 'sendonly' : peer.canReceive ? 'recvonly' : 'inactive';
}
export function policyPeers(policy) {
  const unique = new Map();
  if (!proximityP2PAllowed(policy)) return [];
  for (const peer of policy?.peers || []) if (peer && typeof peer.id === 'string' && (!hasProximityScope(policy) || opaqueId(peer.memberId)) && peer.id !== policy.selfId && (peer.canSend || peer.canReceive)) unique.set(peer.id, { ...peer, canSend: peer.canSend === true, canReceive: peer.canReceive === true });
  return [...unique.values()];
}

// Dependency injection here supports isolated unit tests without device permission prompts.
export function createMediaSession({ api, getState, onChange = () => {}, env = globalThis, now = () => Date.now() }) {
  const capabilities = mediaCapabilities(env);
  const streams = { microphone: null, camera: null, screen: null };
  // Captured tracks awaiting policy/join are still live devices and must be stoppable.
  const pendingStreams = { microphone: null, camera: null, screen: null };
  const devices = Object.fromEntries(KINDS.map(k => [k, { status: 'off', error: '' }]));
  // Tab-local choices are preferences, never permission or restored capture intent.
  const settings = {microphone:'',camera:'',noiseSuppression:true,echoCancellation:true,cameraQuality:'normal',mirror:true};
  let deviceList = [], deviceListError = '', listingDevices = false, listEpoch = 0, devicesRequested = false;
  async function refreshDevices() {
    if (disposed) return;
    devicesRequested = true;
    const ticket = ++listEpoch; listingDevices = true; deviceListError = ''; emit();
    try {
      if (typeof env.navigator?.mediaDevices?.enumerateDevices !== 'function') throw Error('Device selection is unavailable in this browser. The system default is still used.');
      const list = await env.navigator.mediaDevices.enumerateDevices();
      if (disposed || ticket !== listEpoch) return;
      deviceList = list.filter(device => ['audioinput','videoinput','audiooutput'].includes(device.kind)).map(device => ({deviceId:device.deviceId,kind:device.kind,label:device.label}));
    } catch (error) { if (!disposed && ticket === listEpoch) deviceListError = error.message || 'Devices could not be listed. Try again.'; }
    finally { if (!disposed && ticket === listEpoch) { listingDevices = false; emit(); } }
  }
  async function setCaptureSetting(name, value) {
    if (disposed || !Object.hasOwn(settings,name)) return false;
    if (['camera','microphone'].includes(name) && (typeof value !== 'string' || (value && !deviceList.some(d => d.deviceId === value && d.kind === (name === 'camera' ? 'videoinput' : 'audioinput'))))) return false;
    if (['noiseSuppression','echoCancellation','mirror'].includes(name) && typeof value !== 'boolean') return false;
    if (name === 'cameraQuality' && !['low','normal','high'].includes(value)) return false;
    if (settings[name] === value) return true;
    settings[name] = value;
    const kind = name === 'mirror' ? null : ['camera','cameraQuality'].includes(name) ? 'camera' : 'microphone';
    const restart = kind && devices[kind].status === 'on';
    // A settings change cancels pending capture. Only an already-on device can
    // restart from this fresh gesture, through the existing authority fences.
    if (kind && (restart || devices[kind].status === 'requesting' || awayIntent[kind])) stopDevice(kind);
    emit();
    return restart ? toggleDevice(kind) : true;
  }
  const deviceChange = () => { if (devicesRequested) void refreshDevices(); };
  env.navigator?.mediaDevices?.addEventListener?.('devicechange', deviceChange);
  const peers = new Map();
  const earlyCandidates = new Map();
  const deviceJoins = {microphone:null,camera:null,screen:null};
  const awayPreference = createAwayMicrophonePreference(env);
  const awayLatch = createAwayLatch(env.document?.visibilityState || 'visible');
  const awayIntent = {microphone:null,camera:null,screen:null};
  let awayTransition = 0, confirmedPolicySequence = 0;
  let consentTail = null, activeJoin = null, proximityProtocolSeen = false;
  // Serialize writes so Leave cannot overtake a still-pending enable at the server.
  function writeConsent(enabled) {
    const owner = {roomId,actorId,admissionId,generation,memberId:policy?.proximityMembership?.memberId};
    const run = () => {
      const sameOwner = currentRoomId(getState()) === owner.roomId && currentActorId(getState()) === owner.actorId && currentAdmissionId(getState()) === owner.admissionId;
      if (!sameOwner || (enabled && (disposed || owner.generation !== generation || owner.memberId !== policy?.proximityMembership?.memberId || localSilent || getState()?.ready === false))) return Promise.resolve(null);
      return api('/api/media/state', {method:'POST',body:{enabled,roomId:owner.roomId,...(owner.memberId?{memberId:owner.memberId}:{})}});
    };
    const request = consentTail ? consentTail.catch(() => {}).then(run) : run();
    consentTail = request;
    void request.finally(() => { if (consentTail === request) consentTail = null; }).catch(() => {});
    return request;
  }
  const scopedPolicyError = value => proximityProtocolSeen && value?.context?.kind === 'proximity' && !hasProximityScope(value) ? 'Missing proximity media scope. Devices and connections are paused.' : proximityPolicyError(value);
  // Local device ownership is independent of peers/ICE: solo capture and a
  // safe active stream may survive another member's consent or bubble change.
  const captureAuthority = value => JSON.stringify([value?.selfId,value?.roomId,value?.context?.kind,value?.context?.group,value?.context?.canPublish,value?.proximityMembership?.memberId,hasProximityScope(value)?value.enabled:null]);
  const deviceJoinAuthority = value => JSON.stringify([value?.selfId,value?.roomId,value?.context?.kind,value?.context?.group,value?.context?.canPublish,value?.proximityMembership?.memberId]);
  let iceEpoch = 0, iceError = '', policy = null, joined = false, joining = false, disposed = false, generation = 0;
  let roomId = currentRoomId(getState()), actorId = currentActorId(getState()), admissionId = currentAdmissionId(getState()), policyError = '', notice = '', refreshRequest = null;
  // Orders overlapping HTTP fetches against accepted pushes within this client lifecycle.
  // The server has no monotonic revision; this is not an ordering claim across SSE reconnects.
  let policyEpoch = 0, localSilent = false, awaitingPolicy = false, roomUnavailable = false, committedAreas = null;
  const transportAllowed = () => !disposed && joined && sameContext() && getState()?.ready !== false && !localSilent && !awaitingPolicy && !policyError && !iceError && (policy?.iceRequired!==true||!!policy?.iceScope) && policy?.enabled !== false && !scopedPolicyError(policy) && proximityP2PAllowed(policy) && policy?.roomId === roomId && policy?.context?.kind !== 'silent' && !(policy?.context?.kind === 'proximity' && policy.context.canPublish === false);
  // Denial geometry and personalized server scope stay independent of transport cache.
  const authorityKey = value => JSON.stringify([value?.selfId,value?.roomId,value?.context?.kind,value?.context?.group,value?.context?.canPublish,proximityAuthority(value)]);
  function peerCurrent(p) { return transportAllowed() && !p.closed && peers.get(p.id) === p && p.authority === authorityKey(policy) && policyPeers(policy).some(info => info.id === p.id && info.memberId === p.info.memberId && peerDirection(info) === peerDirection(p.info)); }
  const sameContext = () => currentRoomId(getState()) === roomId && currentActorId(getState()) === actorId && currentAdmissionId(getState()) === admissionId;
  const elapsedNow = () => env.performance?.now?.() ?? now();
  let lastRefresh = null, lastStats = 0, captureSequence = { microphone: 0, camera: 0, screen: 0 };
  let idSequence = 0;
  const nextId = () => env.crypto?.randomUUID?.() || `ice-${now().toString(36)}-${String(++idSequence).padStart(16,'0')}`;
  const iceContext = () => ({roomId,selfId:policy?.selfId,scope:policy?.iceScope,generation,epoch:iceEpoch,authority:authorityKey(policy)});
  const iceCurrent = context => transportAllowed()&&context.epoch===iceEpoch&&context.generation===generation&&context.roomId===roomId&&context.selfId===policy?.selfId&&context.scope===policy?.iceScope&&context.authority===authorityKey(policy);
  const ice = createIceCache({api,env,now,nextId,isCurrent:iceCurrent,onFailure:iceFailed,onRenew:renewIce});
  // Retiring a retry also retires its continuations, even within the same scope.
  function retireIce() { iceEpoch++; ice.retire(); }
  function iceFailed(message) { iceError=message; pauseMedia(); emit(); }
  function renewIce(config) {
    if(!transportAllowed())return;
    const context=iceContext();
    for(const p of peers.values()) {
      if(!peerCurrent(p))continue;
      try { if(!iceCurrent(context)||!peerCurrent(p))continue;p.pc.setConfiguration(config);
        if(!iceCurrent(context)||!peerCurrent(p))continue;
        if(policy.selfId<p.id)restart(p);
        else void signal(p,{request:'restart'}).catch(()=>{if(iceCurrent(context)&&peerCurrent(p))iceFailed('ICE restart signaling failed. Devices and connections were stopped; retry explicitly.');});
      } catch { if(!iceCurrent(context)||!peerCurrent(p))continue;iceFailed('ICE configuration could not be renewed. Devices and connections were stopped; retry explicitly.');break; }
    }
  }
  function restart(p) {
    if(!peerCurrent(p))return;
    if(p.pc.signalingState&&p.pc.signalingState!=='stable'){p.restartPending=true;return;}
    p.restartPending=false;p.queue=p.queue.then(()=>offer(p,true));
  }
  const emit = () => { if (!disposed) onChange(snapshot()); };
  function snapshot() {
    return { capabilities, settings:{...settings}, availableDevices:deviceList.map(d=>({...d})), listingDevices, deviceListError, roomId, joined, joining, policy, policyError, iceError, transportNotice:scopedPolicyError(policy)||proximityMediaNotice(policy), iceTransport:ice.transport(iceContext())||(policy&&!hasProximityScope(policy)&&!policy.iceRequired&&!policy.iceScope?'host-only':null), notice, localSilent, awaitingPolicy,
      awayPrivacy: {...awayLatch.snapshot(),...awayPreference.snapshot(),conversation:readAwayConversation(policy),suspended:KINDS.filter(kind=>!!awayIntent[kind])},
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
  function stopDevice(kind, reason = '', forAway = false) {
    if (!forAway) awayIntent[kind] = null;
    deviceJoins[kind] = null;
    captureSequence[kind]++;
    const stream = streams[kind]; streams[kind] = null;
    devices[kind] = { status: 'off', error: reason };
    stopStream(stream, forAway); stopStream(pendingStreams[kind], forAway); pendingStreams[kind] = null;
    for (const p of peers.values()) void applyTracks(p);
  }
  const awayOwner = () => ({generation,roomId,actorId,admissionId,authority:captureAuthority(policy)});
  const awayOwnerCurrent = owner => owner && owner.generation === generation && owner.roomId === roomId && owner.actorId === actorId && owner.admissionId === admissionId && owner.authority === captureAuthority(policy) && sameContext();
  function suspendForAway() {
    for (const kind of KINDS) {
      // Keeping an already live microphone is explicit. A still-pending browser
      // request is fenced even with that preference; it cannot start in hiding.
      if (kind === 'microphone' && awayPreference.snapshot().keepMicrophone && devices[kind].status === 'on') continue;
      const requested = streams[kind] || pendingStreams[kind] || devices[kind].status === 'requesting';
      if (!requested) continue;
      if (kind !== 'screen' && joined && policy && !policyError && !iceError && !localSilent && !awaitingPolicy && !publishingDenied(policy)) awayIntent[kind] = awayOwner();
      stopDevice(kind, '', true);
    }
  }
  async function resumeFromAway(transition) {
    if (!KINDS.some(kind=>awayIntent[kind])) return;
    // A GET that began while hidden is not fresh return authority. This request
    // may be confirmed against a newer push only when its authority still agrees.
    retirePolicyRequest();
    const confirmation = confirmedPolicySequence;
    await refreshPolicy(true, true);
    if (disposed || transition !== awayTransition || awayLatch.snapshot().away || !awayLatch.snapshot().visible) return;
    if (confirmedPolicySequence <= confirmation) {
      for (const kind of KINDS) if (awayIntent[kind]) stopDevice(kind, 'Return authorization could not be confirmed. Turn the device on again when ready.');
      emit(); return;
    }
    for (const kind of ['microphone','camera']) {
      const owner = awayIntent[kind];
      if (!owner) continue;
      if (!awayOwnerCurrent(owner) || !joined || policy?.enabled === false || !policy || policyError || iceError || localSilent || awaitingPolicy || publishingDenied(policy) || getState()?.ready === false) { awayIntent[kind] = null; continue; }
      let permission;
      try { permission = await env.navigator?.permissions?.query({name:kind}); } catch { /* Unsupported inspection requires a fresh user click. */ }
      if (disposed || transition !== awayTransition || awayLatch.snapshot().away || !awayLatch.snapshot().visible) return;
      if (awayIntent[kind] !== owner) continue;
      if (!awayOwnerCurrent(owner) || policyError || iceError || localSilent || awaitingPolicy || !joined || publishingDenied(policy) || getState()?.ready === false) { stopDevice(kind); continue; }
      if (permission?.state !== 'granted') { stopDevice(kind, `${labelFor(kind)} needs your confirmation to return. Turn it on again to check browser access.`); continue; }
      awayIntent[kind] = null;
      // Only this lifecycle's suspended intent reaches this path. Ordinary
      // policy/room recovery never calls it, and screen pickers never resume.
      void toggleDevice(kind);
    }
    emit();
  }
  function checkVisibility() {
    if (disposed) return;
    checkLocalPolicy();
    const before = awayLatch.snapshot();
    const after = awayLatch.update(env.document?.visibilityState || 'visible',readAwayConversation(policy));
    if (before.away !== after.away || before.visible !== after.visible) {
      const transition = ++awayTransition;
      if (after.away) suspendForAway();
      else if (after.visible && before.away) void resumeFromAway(transition);
      emit();
    }
    return after.away;
  }
  function setKeepMicrophoneAway(value) {
    awayPreference.set(value);
    if (awayLatch.snapshot().away) suspendForAway();
    emit();
  }
  function retirePolicyRequest() {
    const request = refreshRequest; refreshRequest = null; if (request) { request.retired = true; request.cancel?.(); }
  }
  function pauseMedia(reason = '') {
    retireIce(); closePeers();
    for (const kind of KINDS) stopDevice(kind, reason);
  }
  function rememberCommittedAreas(room) {
    if (room?.id !== roomId || !Number.isSafeInteger(room.revision) || room.revision < 0 || !Array.isArray(room.scene?.areas) || (committedAreas && room.revision <= committedAreas.revision)) return false;
    // Copy only denial geometry; never retain the DTO, editor base or draft by reference.
    committedAreas = {revision:room.revision,areas:room.scene.areas.filter(area => area.action === 'silent').map(({id,action,x,z,width,depth}) => ({id,action,x,z,width,depth}))};
    return true;
  }
  function acceptCommittedRoom(room, sourceActorId) {
    checkLocalPolicy();
    if (disposed || getState()?.ready === false || !sourceActorId || sourceActorId !== actorId || !sameContext() || room?.id !== roomId) return false;
    if (!rememberCommittedAreas(room)) return false;
    checkLocalPolicy(); return true;
  }
  // Synchronous and deny-only. The editor's state.scene is a draft, so only the
  // current room's committed area projection (or saved-scene fallback) can deny. Exiting
  // never grants recipients or capture: a new post-exit GET must confirm policy.
  function checkLocalPolicy() {
    if (disposed) return true;
    const state = getState(), nextRoom = currentRoomId(state), nextActor = currentActorId(state), nextAdmission = currentAdmissionId(state);
    if (nextRoom !== roomId || nextActor !== actorId || nextAdmission !== admissionId) {
      generation++; policyEpoch++; retirePolicyRequest(); pauseMedia();
      roomId = nextRoom; actorId = nextActor; admissionId = nextAdmission; joined = false; joining = false;
      policy = null; proximityProtocolSeen = false; policyError = ''; iceError = ''; lastRefresh = null; localSilent = false; awaitingPolicy = false; committedAreas = null;
      notice = nextRoom ? 'Your room, account or admission changed. Join audio again when you are ready.' : ''; emit();
    }
    if (state?.ready === false) {
      if (!roomUnavailable) {
        roomUnavailable = true; committedAreas = null; generation++; policyEpoch++; retirePolicyRequest();
        joined = false; joining = false; policy = null; awaitingPolicy = true;
        policyError = 'Media is paused because your room session is unavailable. Join audio again when ready.';
        pauseMedia(); emit();
      }
      return true;
    }
    if (roomUnavailable) { roomUnavailable = false; lastRefresh = null; }
    rememberCommittedAreas(state?.room);
    const areas = committedAreas?.areas || state?.room?.scene?.areas;
    const silent = !!areas?.some(area => area.action === 'silent' && containsCommittedArea(area, state.position?.x, state.position?.z));
    if (silent !== localSilent) {
      localSilent = silent; awaitingPolicy = true; generation++; policyEpoch++; joining = false;
      retirePolicyRequest(); lastRefresh = null; pauseMedia(silent ? SILENT_MEDIA_MESSAGE : '');
      policyError = silent ? '' : POLICY_CONFIRM_MESSAGE;
      notice = silent ? SILENT_MEDIA_MESSAGE : ''; emit();
    }
    return localSilent || awaitingPolicy;
  }
  async function applyTracks(p) {
    if (!peerCurrent(p)) return;
    const transceivers = p.pc.getTransceivers();
    for (let i = 0; i < transceivers.length && i < KINDS.length; i++) {
      if (!peerCurrent(p)) return;
      const transceiver = transceivers[i];
      const track = p.info.canSend ? streams[KINDS[i]]?.getTracks().find(t => t.kind === MEDIA_KINDS[i] && t.readyState !== 'ended') || null : null;
      try { if (transceiver.sender.track !== track) await transceiver.sender.replaceTrack(track); }
      catch (error) { if (peerCurrent(p)) { p.error = `Track could not be sent: ${error.message}`; emit(); } }
    }
  }
  function signal(p, data) {
    const info = policyPeers(policy).find(info => info.id === p.id);
    if (!transportAllowed() || !info || p.authority !== authorityKey(policy) || (p.pc && !peerCurrent(p))) return Promise.resolve();
    const scope = policy.proximityMembership;
    const scoped = hasProximityScope(policy) ? {bubbleId:scope.bubbleId,fromMemberId:scope.memberId,toMemberId:info.memberId,intentGeneration:scope.transport.intentGeneration,mediaScope:scope.mediaScope} : {};
    return api('/api/media/signal', {method:'POST',body:{to:p.id,roomId,connectionId:p.connectionId,...scoped,...data}});
  }
  function signalCurrent(event) {
    const info = policyPeers(policy).find(info => info.id === event.from);
    if (!info) return false;
    if (!hasProximityScope(policy)) return ['bubbleId','fromMemberId','toMemberId','intentGeneration','mediaScope'].every(key => event[key] === undefined);
    const scope = policy.proximityMembership;
    return proximityP2PAllowed(policy) && event.bubbleId === scope.bubbleId && event.fromMemberId === info.memberId && event.toMemberId === scope.memberId && event.intentGeneration === scope.transport.intentGeneration && event.mediaScope === scope.mediaScope;
  }
  // An early candidate belongs to a peer identity and authority, not merely a remote-chosen ID.
  const candidateKey = (id, connectionId) => JSON.stringify([authorityKey(policy),id,policyPeers(policy).find(info => info.id === id)?.memberId,connectionId]);
  function failure(p, error) {
    if (!peerCurrent(p)) return;
    p.status = 'failed'; p.error = String(error?.message || error || 'Connection failed').slice(0, 200); emit();
  }
  function makePeer(info, connectionId = null) {
    if (!transportAllowed()) return null;
    const config=policy?.iceScope?ice.configuration(iceContext()):{iceServers:[]};
    if(!config)return null;
    const pc = new env.RTCPeerConnection(config);
    const p = { id: info.id, info, authority:authorityKey(policy), pc, connectionId: connectionId || nextId(), closed: false, status: 'connecting', error: '', remote: {}, candidateCount: 0, receivedBytes: 0, sentBytes: 0, queue: Promise.resolve(), timeout: null };
    p.candidateKey = candidateKey(p.id,p.connectionId);
    peers.set(p.id, p);
    pc.onicecandidate = event => {
      if (!peerCurrent(p) || !event.candidate) return;
      p.candidateCount++;
      void signal(p, { candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate }).catch(error => failure(p, error)); emit();
    };
    pc.onicegatheringstatechange = () => {
      if (!peerCurrent(p)) return;
      if (pc.iceGatheringState === 'complete' && p.candidateCount === 0 && pc.connectionState !== 'connected') {
        p.error = 'No local ICE candidates. This browser or network cannot establish a call here.';
      }
      emit();
    };
    const updateConnection = () => {
      if (!peerCurrent(p)) return;
      const state = pc.connectionState || pc.iceConnectionState;
      if (state === 'connected' || state === 'completed') { p.status = 'connected'; p.error = ''; if (p.timeout) env.clearTimeout(p.timeout); }
      else if (state === 'failed') { p.status = 'failed'; p.error = 'WebRTC transport failed. ICE configuration does not prove relay reachability or a working media path.'; }
      else if (state === 'disconnected') { p.status = 'disconnected'; p.error = 'Connection interrupted. Retry when your network is ready.'; }
      else if (state === 'closed') p.status = 'closed';
      emit();
    };
    pc.onconnectionstatechange = pc.oniceconnectionstatechange = updateConnection;
    pc.ontrack = event => {
      // Receive permissions are checked again, independently of remote SDP.
      if (!peerCurrent(p) || !p.info.canReceive) { event.track.stop(); return; }
      const index = pc.getTransceivers().indexOf(event.transceiver);
      const kind = KINDS[index] || (event.track.kind === 'audio' ? 'microphone' : 'camera');
      const stream = new env.MediaStream([event.track]); p.remote[kind] = stream;
      event.track.onmute = event.track.onunmute = () => emit();
      event.track.onended = () => { if (p.remote[kind] === stream) delete p.remote[kind]; emit(); };
      emit();
    };
    p.timeout = env.setTimeout(() => {
      if (!p.closed && p.status !== 'connected') failure(p, p.candidateCount ? 'Connection timed out. This peer or network is unreachable; relay reachability has not been verified.' : 'No usable ICE candidates were gathered. Calls cannot connect in this browser or network.');
    }, 15000);
    return p;
  }
  async function offer(p,iceRestart=false) {
    if (!p || !peerCurrent(p)) return;
    try {
      if (!p.pc.getTransceivers().length) for (const kind of MEDIA_KINDS) p.pc.addTransceiver(kind, { direction: peerDirection(p.info) });
      await applyTracks(p); if (!peerCurrent(p)) return;
      const description = await p.pc.createOffer(iceRestart?{iceRestart:true}:undefined); if (!peerCurrent(p)) return;
      await p.pc.setLocalDescription(description); if (!peerCurrent(p)) return;
      await signal(p, { description: { type: p.pc.localDescription.type, sdp: p.pc.localDescription.sdp } });
    } catch (error) { failure(p, error); }
  }
  function reconcile() {
    if (!transportAllowed() || !capabilities.rtc) { retireIce();closePeers(); return; }
    if(policy?.iceScope&&!ice.configuration(iceContext())){
      const context=iceContext();void ice.ensure(context).then(()=>{if(iceCurrent(context))reconcile();}).catch(()=>{if(iceCurrent(context))iceFailed('ICE configuration unavailable. Devices and connections were stopped; retry explicitly.');});return;
    }
    const allowed = new Map(policyPeers(policy).map(p => [p.id, p]));
    for (const [id, p] of peers) {
      const next = allowed.get(id);
      if (!next || next.memberId !== p.info.memberId || p.authority !== authorityKey(policy) || peerDirection(next) !== peerDirection(p.info)) dropPeer(id);
      else p.info = next;
    }
    for (const info of allowed.values()) if (!peers.has(info.id) && policy.selfId < info.id) {
      const p = makePeer(info); void offer(p);
    }
  }
  function acceptPolicy(next, source = 'push') {
    checkLocalPolicy();
    if (getState()?.ready === false) return false;
    // A personalized terminal revocation has no current room. Fail closed immediately,
    // even before the world UI processes its own access-revoked event.
    if (!disposed && next?.roomId === null && next.enabled === false && next.selfId === (actorId || policy?.selfId) && sameContext()) {
      generation++; policyEpoch++; joined = false; joining = false; committedAreas = null; retirePolicyRequest(); policy = next;
      retireIce();for (const kind of KINDS) stopDevice(kind); closePeers(); notice = 'Room access ended. Join an authorized room again to reconnect.'; checkVisibility(); emit(); return true;
    }
    if (disposed || !next || next.roomId !== roomId || !sameContext() || (actorId && next.selfId !== actorId)) return false;
    if (hasProximityScope(next)) proximityProtocolSeen = true;
    const previousDenial = publishingDenied(policy) ? denialReason(policy.context) : null;
    const authorityChanged = authorityKey(next) !== authorityKey(policy);
    if (policy && captureAuthority(next) !== captureAuthority(policy)) for (const kind of KINDS) awayIntent[kind] = null;
    if(authorityChanged||next.iceScope!==policy?.iceScope){retireIce();closePeers();}
    // Capture has its own ownership boundary: admission, own consent and
    // publishing context. Peer/AV/intent changes retire transport, not devices.
    if (policy && captureAuthority(next) !== captureAuthority(policy) && (hasProximityScope(policy) || hasProximityScope(next))) for (const kind of KINDS) {
      // Only an owned, device-free join gesture may cross its own consent grant.
      // Any local capture-authority change cancels it before capture begins.
      const pendingJoin = deviceJoins[kind];
      if (pendingJoin && joining && !policy.enabled && next.enabled === true && pendingJoin.generation === generation && pendingJoin.authority === deviceJoinAuthority(next)) continue;
      const capturing = streams[kind] || pendingStreams[kind] || devices[kind].status === 'requesting';
      stopDevice(kind, capturing ? 'Media authorization changed. Devices stopped; turn them on again when ready.' : '');
    }
    policyEpoch++; policy = next;
    if(scopedPolicyError(next)||(next.iceRequired===true&&!next.iceScope&&!hasProximityScope(next)))pauseMedia();
    if (source === 'fetch' && !localSilent) awaitingPolicy = false;
    policyError = scopedPolicyError(next) || (awaitingPolicy && !localSilent ? policyError || POLICY_CONFIRM_MESSAGE : '');
    // Retire area-specific warnings on exit; device errors remain until another user action.
    if (previousDenial) for (const kind of KINDS) {
      if (devices[kind].status === 'off' && devices[kind].error === previousDenial) devices[kind].error = publishingDenied(next) ? denialReason(next.context) : '';
    }
    if (notice === SILENT_MEDIA_MESSAGE && !localSilent && next.context?.kind !== 'silent') notice = '';
    // Presence pushes must not starve the post-exit confirmation GET. It may
    // clear the latch only for the same authority scope; pushed recipients win.
    if (source === 'push' && !refreshRequest?.confirmation) retirePolicyRequest();
    if (joined && next.enabled === false) { generation++; joined = false; joining = false; retirePolicyRequest(); retireIce(); for (const kind of KINDS) stopDevice(kind); closePeers(); notice = 'The server ended this media session. Join again to reconnect.'; }
    // Revoke pending capture as well as live streams. Leaving the area must never revive
    // a permission prompt started before denial; a deliberate later click gets a new token.
    if (publishingDenied(next)) for (const kind of KINDS) {
      if (streams[kind] || devices[kind].status === 'requesting' || awayIntent[kind]) stopDevice(kind, denialReason(next.context));
    }
    checkVisibility(); reconcile(); emit(); return true;
  }
  async function refreshPolicy(force = false, requireFresh = false) {
    checkLocalPolicy();
    if (disposed || !roomId || !sameContext() || getState()?.ready === false) return null;
    if (refreshRequest) return refreshRequest.promise;
    const elapsed = elapsedNow(), since = elapsed - lastRefresh;
    if (!force && lastRefresh !== null && since >= 0 && since < 900) return policy;
    const request = { roomId, actorId, generation, policyEpoch, startedAt:elapsed, confirmation:(awaitingPolicy && !localSilent) || requireFresh, promise: null }; lastRefresh = elapsed;
    refreshRequest = request;
    const owned = () => !disposed && request.generation === generation && request.roomId === roomId && request.actorId === actorId && sameContext();
    const current = () => !request.retired && owned();
    request.promise = (async () => {
      let timeout;
      const Controller = env.AbortController || globalThis.AbortController;
      const controller = Controller ? new Controller() : null;
      try {
        // The timeout measures elapsed time, independent of wall-clock changes.
        // Racing as well as aborting also bounds adapters that ignore AbortSignal.
        const deadline = new Promise((_, reject) => {
          request.cancel = () => { reject(Error('Media policy request retired')); controller?.abort(); };
          timeout = env.setTimeout(() => { reject(Error(POLICY_TIMEOUT_MESSAGE)); controller?.abort(); }, POLICY_TIMEOUT_MS);
        });
        const next = await Promise.race([api('/api/media', {signal:controller?.signal}), deadline]);
        checkLocalPolicy();
        if (!current()) return null;
        // A newer push owns policy/recipients. A post-exit GET can only confirm
        // its matching scope, without replacing newer recipients or denials.
        const confirming = request.confirmation && !localSilent;
        if (request.policyEpoch !== policyEpoch && !confirming) return policy;
        if (elapsedNow() - request.startedAt >= POLICY_TIMEOUT_MS) throw Error(POLICY_TIMEOUT_MESSAGE);
        if (!next || next.roomId !== roomId || (actorId && next.selfId !== actorId)) { policyError = 'Room or account changed. Media is paused until the server confirms your session.'; pauseMedia(); emit(); return null; }
        if (request.policyEpoch !== policyEpoch) {
          if (next.enabled === policy?.enabled && authorityKey(next) === authorityKey(policy)) { confirmedPolicySequence++; awaitingPolicy = false; policyError = scopedPolicyError(policy); reconcile(); emit(); }
          return policy;
        }
        if (acceptPolicy(next, 'fetch')) confirmedPolicySequence++; return policy;
      } catch (error) {
        if (current() && (request.policyEpoch === policyEpoch || (request.confirmation && (awaitingPolicy || requireFresh)))) { policyError = `Media policy unavailable: ${String(error?.message || 'server unreachable').slice(0, 150)}`; pauseMedia(); emit(); }
        return owned() && request.policyEpoch !== policyEpoch ? policy : null;
      } finally { if (timeout !== undefined) env.clearTimeout(timeout); if (refreshRequest === request) refreshRequest = null; }
    })();
    return request.promise;
  }
  function setJoined(value) {
    checkLocalPolicy();
    if (value && joining && activeJoin) return activeJoin;
    const operation = changeJoined(value);
    if (value) {
      activeJoin = operation;
      void operation.finally(() => { if (activeJoin === operation) activeJoin = null; }).catch(() => {});
    }
    return operation;
  }
  async function changeJoined(value) {
    const locallyDenied = checkLocalPolicy();
    if (value && locallyDenied) { emit(); return false; }
    if (disposed || (value && (joining || joined)) || (!value && !joined && !joining)) return joined;
    if (value && !sameContext()) return false;
    if (value && policy?.context?.kind === 'silent') { notice = SILENT_MEDIA_MESSAGE; emit(); return false; }
    if (value && !capabilities.rtc) { notice = 'This browser does not support WebRTC calls.'; emit(); return false; }
    if (!value) {
      joined = false; generation++; joining = false; retirePolicyRequest();retireIce();iceError='';
      for (const kind of KINDS) stopDevice(kind); closePeers(); emit();
      try { await writeConsent(false); } catch (error) { notice = `Devices stopped. Server leave could not be confirmed: ${error.message}`; }
      emit(); return false;
    }
    // An earlier GET may still contain enabled:false from before this opt-in.
    policyEpoch++; retirePolicyRequest();
    const epoch = generation; joining = true; notice = '';iceError=''; emit();
    try {
      if (!policy) await refreshPolicy(true);
      if (disposed || epoch !== generation || !sameContext() || !policy || policyError || localSilent || awaitingPolicy || policy.context?.kind === 'silent') return false;
      const consent = await writeConsent(true);
      if (!consent || disposed || epoch !== generation || !sameContext()) return false;
      joined = true; await refreshPolicy(true); if (epoch !== generation || !sameContext()) return false;
      if (transportAllowed() && policy?.iceScope) {
        const context = iceContext();
        try { await ice.ensure(context); }
        catch { if (iceCurrent(context)) iceFailed('ICE configuration unavailable. Devices and connections were stopped; retry explicitly.'); return false; }
        if (!iceCurrent(context)) return false;
      }
      reconcile(); const idleProximity=policy?.context?.kind==='proximity'&&(policy.context.canPublish===false||hasProximityScope(policy));return joined&&!iceError&&!policyError&&!localSilent&&!awaitingPolicy&&(idleProximity||!policy?.iceRequired||!!policy?.iceScope);
    } catch (error) { if (!disposed && epoch === generation && sameContext()) notice = `Could not join audio: ${String(error?.message || 'server unreachable').slice(0, 150)}`; return false; }
    finally { if (epoch === generation) joining = false; emit(); }
  }
  async function toggleDevice(kind) {
    if (!KINDS.includes(kind) || disposed) return false;
    checkVisibility();
    const locallyDenied = checkLocalPolicy();
    if (awayIntent[kind]) { stopDevice(kind); emit(); return false; }
    if (!sameContext() || locallyDenied || policyError || iceError) { emit(); return false; }
    if (streams[kind] || devices[kind].status === 'requesting') { stopDevice(kind); emit(); return false; }
    if (awayLatch.snapshot().away) { notice = 'Devices stay paused while this page is hidden. Return to the page before turning one on.'; emit(); return false; }
    if (!policy) {
      if (kind === 'screen') { notice = 'Join audio before sharing your screen, then choose Share again.'; emit(); return false; }
      const epoch = generation, sequence = ++captureSequence[kind];
      devices[kind] = {status:'requesting',error:''}; emit();
      await refreshPolicy(true);
      if (disposed || epoch !== generation || sequence !== captureSequence[kind] || !sameContext()) return false;
      devices[kind] = {status:'off',error:''};
      if (!policy || policyError || localSilent || awaitingPolicy) { emit(); return false; }
      return toggleDevice(kind);
    }
    const reason = kind === 'screen' ? capabilities.screenReason : capabilities.deviceReason;
    if (reason) { devices[kind] = { status: 'unavailable', error: reason }; emit(); return false; }
    if (publishingDenied(policy)) { devices[kind] = { status: 'off', error: denialReason(policy.context) }; emit(); return false; }
    if (hasProximityScope(policy) && !joined) {
      // Display capture needs transient activation. Do not open a picker only to
      // discard it at the consent boundary; explain the required join first.
      if (kind === 'screen') { notice = 'Join audio before sharing your screen, then choose Share again.'; emit(); return false; }
      const request = {generation,authority:deviceJoinAuthority(policy)}; deviceJoins[kind] = request;
      devices[kind] = {status:'requesting',error:''}; emit();
      const didJoin = await setJoined(true);
      if (deviceJoins[kind] !== request || request.generation !== generation || request.authority !== deviceJoinAuthority(policy) || !sameContext()) return false;
      deviceJoins[kind] = null; devices[kind] = {status:'off',error:''};
      // A retired peer/ICE await does not retire this still-owned local gesture.
      const localReady = joined && policy?.enabled === true && !policyError && !iceError && !localSilent && !awaitingPolicy && !publishingDenied(policy) && !scopedPolicyError(policy);
      if (!didJoin && !localReady) { emit(); return false; }
      // Freshly owned capture, still caused by this one deliberate mic/camera
      // click. No stream existed before consent; no recapture is automatic.
      return toggleDevice(kind);
    }
    const epoch = generation, sequence = ++captureSequence[kind];
    const ownsCapture = () => !disposed && epoch === generation && sequence === captureSequence[kind] && sameContext() && getState()?.ready !== false && !localSilent && !awaitingPolicy && (!awayLatch.snapshot().away || (kind === 'microphone' && awayPreference.snapshot().keepMicrophone && streams[kind] === stream && devices[kind].status === 'on'));
    devices[kind] = { status: 'requesting', error: '' }; notice = ''; emit();
    let stream;
    try {
      // Invoke immediately from the user's click so getDisplayMedia retains activation.
      const capture = kind === 'screen'
        ? env.navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
        : env.navigator.mediaDevices.getUserMedia(kind === 'camera' ? { video: { width: { ideal: {low:320,normal:640,high:1280}[settings.cameraQuality] }, height: { ideal: {low:180,normal:360,high:720}[settings.cameraQuality] }, ...(settings.camera ? {deviceId:{exact:settings.camera}} : {}) }, audio: false } : { video: false, audio: { echoCancellation: settings.echoCancellation, noiseSuppression: settings.noiseSuppression, autoGainControl: true, ...(settings.microphone ? {deviceId:{exact:settings.microphone}} : {}) } });
      stream = await capture; checkVisibility();
      if (!ownsCapture()) { stopStream(stream, awayLatch.snapshot().away); return false; }
      pendingStreams[kind] = stream;
      if (!stream.getTracks().length) throw new Error('No media track was returned');
      if (!joined) {
        const didJoin = await setJoined(true);
        if (!ownsCapture()) { stopStream(stream, awayLatch.snapshot().away); return false; }
        if (!didJoin) { stopStream(stream); devices[kind] = { status: 'off', error: 'Capture stopped because the call could not be joined.' }; emit(); return false; }
      }
      await refreshPolicy(true);
      // A stale operation disposes only its own stream. Never clobber the next request's UI.
      if (!ownsCapture()) { stopStream(stream, awayLatch.snapshot().away); return false; }
      if (!joined || !policy || policyError || iceError || (policy.iceRequired===true&&!policy.iceScope&&!hasProximityScope(policy)) || (hasProximityScope(policy)&&policy.enabled!==true) || publishingDenied(policy)) { stopStream(stream); devices[kind] = { status: 'off', error: 'Capture stopped because this area does not currently allow publishing.' }; emit(); return false; }
      pendingStreams[kind] = null; streams[kind] = stream; devices[kind] = { status: 'on', error: '' };
      for (const track of stream.getTracks()) track.onended = () => { if (streams[kind] === stream) { stopDevice(kind, 'Sharing stopped by your browser or device.'); emit(); } };
      for (const p of peers.values()) await applyTracks(p);
      if (!ownsCapture()) { stopStream(stream, awayLatch.snapshot().away); return false; }
      emit(); if (devicesRequested) void refreshDevices(); return true;
    } catch (error) {
      stopStream(stream);
      if (ownsCapture()) { devices[kind] = { status: 'error', error: describeMediaError(error, kind) }; emit(); }
      return false;
    } finally { if (pendingStreams[kind] === stream) pendingStreams[kind] = null; }
  }
  async function onSignal(event) {
    if (!transportAllowed() || !event || event.roomId !== roomId || !event.from || !event.connectionId || !signalCurrent(event)) return;
    const eventGeneration = generation, eventActor = actorId, eventAuthority = authorityKey(policy);
    const eventCurrent = () => eventGeneration === generation && eventActor === actorId && eventAuthority === authorityKey(policy) && transportAllowed() && event.roomId === roomId && signalCurrent(event);
    await refreshPolicy(true);
    if (!eventCurrent()) return;
    if(policy?.iceScope){const context=iceContext();try{await ice.ensure(context);}catch{if(iceCurrent(context))iceFailed('ICE configuration unavailable. Devices and connections were stopped; retry explicitly.');return;}if(!iceCurrent(context)||!eventCurrent())return;}
    const info = policyPeers(policy).find(p => p.id === event.from); if (!info) return;
    let p = peers.get(info.id);
    if(event.request==='restart'){if(p&&p.connectionId===event.connectionId&&policy.selfId<info.id)restart(p);return;}
    if (event.request === 'offer') {
      if (policy.selfId < info.id) { dropPeer(info.id); p = makePeer(info); await offer(p); }
      return;
    }
    if (event.description?.type === 'offer') {
      // Only the lexicographically first server-issued identity originates an offer.
      if (event.from >= policy.selfId) return;
      if (!p || p.connectionId !== event.connectionId) { dropPeer(info.id); p = makePeer(info, event.connectionId); }
      if(!p)return;const peer = p;
      p.queue = p.queue.then(async () => {
        if (!peerCurrent(peer)) return;
        await peer.pc.setRemoteDescription(event.description);
        if (!peerCurrent(peer)) return;
        const transceivers = peer.pc.getTransceivers();
        if (transceivers.length !== 3) throw new Error('Unsupported media offer; expected audio, camera and screen slots.');
        for (const t of transceivers) t.direction = peerDirection(info);
        await applyTracks(peer); if (!peerCurrent(peer)) return;
        const answer = await peer.pc.createAnswer(); if (!peerCurrent(peer)) return;
        await peer.pc.setLocalDescription(answer);
        if (!peerCurrent(peer)) return;
        await signal(peer, { description: { type: peer.pc.localDescription.type, sdp: peer.pc.localDescription.sdp } });
        for (const candidate of earlyCandidates.get(peer.candidateKey) || []) { if (!peerCurrent(peer)) return; await peer.pc.addIceCandidate(candidate); }
        if (peerCurrent(peer)) earlyCandidates.delete(peer.candidateKey);
      }).catch(error => failure(peer, error));
      await p.queue; return;
    }
    if (!p || p.connectionId !== event.connectionId) {
      if (event.candidate) { const queue = earlyCandidates.get(candidateKey(event.from,event.connectionId)) || []; if (queue.length < 64 && earlyCandidates.size < 20) { queue.push(event.candidate); earlyCandidates.set(candidateKey(event.from,event.connectionId), queue); } }
      return;
    }
    const peer = p;
    peer.queue = peer.queue.then(async () => {
      if (!peerCurrent(peer)) return;
      if (event.description?.type === 'answer') {
        await peer.pc.setRemoteDescription(event.description);
        if (!peerCurrent(peer)) return;
        for (const candidate of earlyCandidates.get(peer.candidateKey) || []) { if (!peerCurrent(peer)) return; await peer.pc.addIceCandidate(candidate); }
        if (peerCurrent(peer)) earlyCandidates.delete(peer.candidateKey);
      } else if (event.candidate) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(event.candidate);
        else { const queue = earlyCandidates.get(peer.candidateKey) || []; if (queue.length < 64) queue.push(event.candidate); earlyCandidates.set(peer.candidateKey, queue); }
      }
    }).catch(error => failure(peer, error));
    await peer.queue;if(peer.restartPending)restart(peer);
  }
  async function retry() {
    checkLocalPolicy();
    if (disposed || !joined || !sameContext() || localSilent || getState()?.ready === false) return;
    const retryGeneration = generation;retireIce();const retryEpoch=iceEpoch;iceError=''; closePeers(); notice = ''; await refreshPolicy(true);
    if (retryGeneration !== generation || retryEpoch !== iceEpoch || !transportAllowed()) return;
    const context=iceContext();
    if(policy?.iceScope){try{await ice.ensure(context);}catch{if(iceCurrent(context))iceFailed('ICE configuration unavailable. Devices and connections were stopped; retry explicitly.');return;}if(!iceCurrent(context))return;}reconcile();
    for (const info of policyPeers(policy)) if (info.id < policy.selfId) {
      if(!iceCurrent(context))return;
      const request = { id: info.id, authority:authorityKey(policy), connectionId: nextId() };
      try { await signal(request, { request: 'offer' }); } catch (error) { if(iceCurrent(context))notice = `Retry failed: ${error.message}`; }
    }
    emit();
  }
  async function update() {
    if (disposed) return;
    checkVisibility();
    await refreshPolicy();
    if (now() - lastStats > 3000) {
      lastStats = now();
      for (const p of peers.values()) if (!p.closed && p.status === 'connected') {
        try {
          const reports = await p.pc.getStats(); if (!peerCurrent(p)) continue; let received = 0, sent = 0;
          reports.forEach(report => { if (report.type === 'inbound-rtp') received += report.bytesReceived || 0; if (report.type === 'outbound-rtp') sent += report.bytesSent || 0; });
          p.receivedBytes = received; p.sentBytes = sent;
        } catch {} // Diagnostics must never terminate a call.
      }
      emit();
    }
  }
  function destroy() {
    listEpoch++; env.navigator?.mediaDevices?.removeEventListener?.('devicechange', deviceChange);
    if (disposed) return;
    env.document?.removeEventListener?.('visibilitychange', checkVisibility);
    retireIce();disposed = true; generation++; policyEpoch++; joined = false; joining = false; retirePolicyRequest();
    for (const kind of KINDS) stopDevice(kind); closePeers();
    // Best-effort opt-out; server also expires disconnected presence.
    void writeConsent(false).catch(() => {});
  }
  env.document?.addEventListener?.('visibilitychange', checkVisibility);
  checkVisibility();
  return { snapshot, update, refreshDevices, setCaptureSetting, checkVisibility, setKeepMicrophoneAway, checkLocalPolicy, acceptCommittedRoom, refreshPolicy, acceptPolicy, setJoined, toggleDevice, retry, onSignal, destroy };
}

const ICONS = {
  microphone: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-7 8v1a7 7 0 0 0 14 0v-1M12 19v3m-4 0h8"/>',
  camera: '<rect x="3" y="6" width="12" height="12" rx="3"/><path d="m15 10 6-3v10l-6-3"/>',
  screen: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4m0-8V7m-3 3 3-3 3 3"/>',
  sound: '<path d="m11 5-6 4H2v6h3l6 4V5Zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.sound}</svg>`;
let mediaMountSequence = 0;
export function mountMedia({ root, api, getState, toast = () => {} }) {
  if (!root) throw new Error('A media container is required');
  const awayHelpId = `media-away-help-${++mediaMountSequence}`;
  root.classList.add('universe-media');
  root.innerHTML = `<div class="media-peers" aria-label="Call participants"></div><section class="media-dock" aria-label="Live media controls"><div class="media-context"><span class="media-dot"></span><div><strong class="media-context-label">Spatial audio</strong><span class="media-context-detail">Mic and camera stay off until you choose</span></div></div><div class="media-actions"><button class="media-join" type="button">Join audio</button><span class="media-divider"></span>${KINDS.map(k => `<button type="button" class="media-device" data-media="${k}" aria-label="${labelFor(k)} off" aria-pressed="false" title="Turn on ${k}">${icon(k)}<span>${k === 'microphone' ? 'Mic' : k === 'camera' ? 'Camera' : 'Share'}</span></button>`).join('')}<button class="media-details-toggle" type="button" aria-expanded="false" aria-label="Media connection details" title="Microphone, camera and connection settings">Settings</button></div></section><div class="media-warning" role="status" hidden></div><section class="media-details" aria-label="Media connection details" hidden><div class="media-details-heading"><strong>Sound and video</strong><button type="button" class="media-settings-close" aria-label="Close media settings">×</button></div><div class="media-self-preview"><video autoplay muted playsinline aria-label="Your camera preview"></video><span class="media-preview-empty">Your camera is off</span><span class="media-preview-label">You · camera preview</span></div><p class="media-preview-help">Turning on your camera also shares it with your authorized conversation.</p><div class="media-setting-row"><label for="${awayHelpId}-camera">Camera</label><select id="${awayHelpId}-camera" data-media-setting="camera"><option value="">System default</option></select><button type="button" class="media-settings-camera">Turn camera on</button></div><p class="media-capture-error" data-capture-error="camera" role="status" hidden></p><label class="media-setting-row">Camera quality<select data-media-setting="cameraQuality"><option value="low">Save data · 180p</option><option value="normal">Normal · 360p</option><option value="high">High · 720p</option></select></label><label class="media-setting-choice"><input type="checkbox" data-media-setting="mirror" checked>Mirror my preview</label><div class="media-setting-row"><label for="${awayHelpId}-microphone">Microphone</label><select id="${awayHelpId}-microphone" data-media-setting="microphone"><option value="">System default</option></select><button type="button" class="media-settings-microphone">Turn microphone on</button></div><p class="media-capture-error" data-capture-error="microphone" role="status" hidden></p><label class="media-setting-choice"><input type="checkbox" data-media-setting="noiseSuppression" checked>Reduce background noise</label><label class="media-setting-choice"><input type="checkbox" data-media-setting="echoCancellation" checked>Reduce echo</label><label class="media-setting-row">Speakers<select class="media-speaker"><option value="">System default</option></select></label><p class="media-speaker-help"></p><div class="media-device-list-actions"><button type="button" class="media-refresh-devices">Refresh devices</button><span class="media-device-list-status" role="status"></span></div><p class="media-device-help">Device names appear after you allow access. Choosing a device while it is off keeps it off. Switching an active device restarts it.</p><details class="media-connection-details"><summary>Connection details</summary><button type="button" class="media-retry">Retry connections</button><p class="media-policy-detail"></p><div class="media-transport"></div><p class="media-network-note"></p></details><fieldset class="media-away-settings"><legend>When this page is hidden</legend><label class="media-away-choice"><input type="checkbox" class="media-keep-microphone" aria-describedby="${awayHelpId}"><span>Keep my microphone on while away</span></label><p id="${awayHelpId}" class="media-away-help"></p><p class="media-away-status" role="status"></p></fieldset></section>`;
  const $ = selector => root.querySelector(selector);
  let destroyed = false, expanded = false, lastWarning = '', lastRoom = currentRoomId(getState());
  const elements = new Map();
  let selectedSpeaker = '', speakerError = '', speakerEpoch = 0;
  const canSelectSpeaker = typeof HTMLMediaElement.prototype.setSinkId === 'function';
  function renderOptions(select, list, selected, kind) {
    const options = [{deviceId:'',label:'System default'},...list.filter(d=>d.kind===kind&&d.deviceId).map((d,i)=>({...d,label:d.label||`${kind==='videoinput'?'Camera':kind==='audioinput'?'Microphone':'Speaker'} ${i+1}`}))];
    if(selected&&!options.some(d=>d.deviceId===selected))options.push({deviceId:selected,label:'Selected device (disconnected)'});
    const signature=JSON.stringify(options);
    if(select.dataset.options!==signature){select.replaceChildren(...options.map(d=>new Option(d.label,d.deviceId)));select.dataset.options=signature;}
    select.value=selected;
  }
  function setExpanded(value) {
    expanded = !!value; $('.media-details').hidden = !expanded;
    $('.media-details-toggle').setAttribute('aria-expanded', String(expanded));
    if (expanded) { void session.refreshDevices(); $('.media-settings-close').focus(); }
    else { $('.media-details-toggle').focus(); }
  }
  async function applySpeaker(media) {
    if(!canSelectSpeaker)return;
    const requestedSpeaker=selectedSpeaker;
    try { await media.setSinkId(requestedSpeaker);if(!destroyed&&requestedSpeaker!==selectedSpeaker)await applySpeaker(media); }
    catch(error) { if(!destroyed&&requestedSpeaker===selectedSpeaker){speakerError='Speaker could not change. Use your browser or system sound settings.';$('.media-speaker-help').textContent=speakerError;} }
  }
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
    tile.el.classList.toggle('media-self-camera', local && kind === 'camera'); tile.el.dataset.mirrored=String(local && kind === 'camera' && session.snapshot().settings.mirror); tile.el.classList.toggle('media-audio-tile', kind === 'microphone'); tile.el.classList.toggle('media-track-muted', !live);
    tile.fallback.textContent = kind === 'microphone' ? (live ? 'Audio track live' : 'No audio arriving') : 'Waiting for video';
    if (tile.media.srcObject !== stream) {
      tile.media.srcObject = stream; if(!local)void applySpeaker(tile.media);
      const playback = tile.media.play();
      playback?.catch(() => { if (!destroyed && elements.has(key) && !local) tile.play.hidden = false; });
    }
    return tile;
  }
  function render(s) {
    if (destroyed) return;
    for(const kind of ['camera','microphone']) {
      const select=$(`[data-media-setting="${kind}"]`);
      renderOptions(select,s.availableDevices,s.settings[kind],kind==='camera'?'videoinput':'audioinput');
      select.disabled=s.listingDevices||!s.capabilities.devices;
      const button=$(`.media-settings-${kind}`),status=s.devices[kind].status;
      const error=$(`[data-capture-error="${kind}"]`);error.textContent=s.devices[kind].error;error.hidden=!s.devices[kind].error;
      button.textContent=status==='requesting'?'Cancel request':status==='on'?`Turn ${kind} off`:`Turn ${kind} on`;
    }
    for(const name of ['noiseSuppression','echoCancellation','mirror'])$(`[data-media-setting="${name}"]`).checked=s.settings[name];
    $('[data-media-setting="cameraQuality"]').value=s.settings.cameraQuality;
    renderOptions($('.media-speaker'),s.availableDevices,selectedSpeaker,'audiooutput');$('.media-speaker').disabled=!canSelectSpeaker;
    $('.media-speaker-help').textContent=speakerError||(!canSelectSpeaker?'Choose speakers in your browser or system sound settings.':'Applies to conversation audio.');
    $('.media-device-list-status').textContent=s.deviceListError||(s.listingDevices?'Looking for devices…':'');
    $('.media-refresh-devices').disabled=s.listingDevices;
    const preview=$('.media-self-preview video'),camera=s.devices.camera.stream;
    if(preview.srcObject!==camera){preview.srcObject=camera;if(camera)preview.play()?.catch(()=>{});else preview.pause();}
    preview.hidden=!camera;preview.style.transform=s.settings.mirror?'scaleX(-1)':'none';
    $('.media-preview-empty').hidden=!!camera;
    $('.media-self-preview').dataset.live=String(!!camera);
    const context = s.policy?.context, silent = s.localSilent || context?.kind === 'silent';
    const label = s.localSilent ? 'No calls' : context?.label || context?.name || 'Spatial audio';
    $('.media-context-label').textContent = label;
    let detail = s.localSilent ? SILENT_MEDIA_MESSAGE : s.iceError || s.policyError || s.transportNotice || (silent ? SILENT_MEDIA_MESSAGE : s.joining ? 'Joining…' : !s.joined ? 'Mic and camera stay off until you choose' : context?.canPublish === false ? context?.kind === 'audience' ? 'Audience · listening only' : context?.reason || 'Publishing is paused in this area' : s.peers.length ? `${s.peers.length} ${s.peers.length === 1 ? 'participant' : 'participants'} · ${s.peers.filter(p => p.status === 'connected').length} transport connected` : context?.reason || context?.description || 'Ready · stop near someone to connect');
    $('.media-context-detail').textContent = detail;
    $('.media-dot').dataset.state = silent || s.policyError || s.iceError || s.transportNotice ? 'off' : s.peers.some(p => p.status === 'connected') ? 'connected' : s.joined ? 'ready' : 'off';
    const join = $('.media-join'); join.textContent = s.joining ? 'Cancel joining' : s.joined ? 'Leave audio' : 'Join audio'; join.disabled = !s.capabilities.rtc || !s.roomId || ((silent || s.awaitingPolicy) && !s.joined && !s.joining); join.title = s.joining ? 'Cancel joining and leave audio' : silent && !s.joined ? SILENT_MEDIA_MESSAGE : s.joined ? 'Leave audio' : 'Join audio'; join.classList.toggle('is-joined', s.joined);
    for (const kind of KINDS) {
      const button = $(`[data-media="${kind}"]`), device = s.devices[kind];
      const unsupported = kind === 'screen' ? s.capabilities.screenReason : s.capabilities.deviceReason;
      const denied = silent || s.awaitingPolicy || !!s.policyError || !!s.iceError || publishingDenied(s.policy);
      button.disabled = !!unsupported || denied || !s.roomId || !s.policy;
      const settingsButton=$(`.media-settings-${kind}`);if(settingsButton)settingsButton.disabled=button.disabled;
      const suspended = s.awayPrivacy.suspended.includes(kind);
      button.setAttribute('aria-pressed', device.status === 'on' || suspended ? 'true' : 'false');
      button.setAttribute('aria-label', `${labelFor(kind)} ${suspended ? 'paused while away; turn off to cancel return' : device.status}`);
      button.title = unsupported || (denied ? (s.localSilent ? SILENT_MEDIA_MESSAGE : s.iceError || s.policyError || s.transportNotice || denialReason(context)) : device.error || (suspended ? 'Turn off to cancel automatic return' : device.status === 'on' ? `Stop ${labelFor(kind).toLowerCase()}` : `Turn on ${labelFor(kind).toLowerCase()}`));
      button.classList.toggle('is-requesting', device.status === 'requesting');
      button.classList.toggle('has-error', device.status === 'error');
    }
    const warning = s.iceError || s.policyError || s.transportNotice || KINDS.map(k => s.devices[k].error).find(Boolean) || s.notice || (s.peers.some(p => p.status === 'failed') ? 'A call could not connect. Open connection details to retry.' : '');
    $('.media-warning').hidden = !warning; $('.media-warning').textContent = warning;
    if (warning && warning !== lastWarning) { lastWarning = warning; }
    $('.media-policy-detail').textContent = silent ? `${SILENT_MEDIA_MESSAGE} ${SILENT_MEDIA_EXIT_MESSAGE}` : `Server-authorized ${context?.kind || 'room'} recipients. ${context?.reason || context?.description || 'Location and room permissions are evaluated by the server.'}`;
    $('.media-keep-microphone').checked = s.awayPrivacy.keepMicrophone;
    $('.media-away-help').textContent = `Applies when no server-recognized conversation is active. Camera and screen sharing stop while away. An existing conversation can continue while hidden, subject to browser behavior. ${s.awayPrivacy.persisted ? 'Saved in this browser on this device.' : 'Browser storage is unavailable; this choice lasts for this session.'}`;
    $('.media-away-status').textContent = s.awayPrivacy.away ? (s.awayPrivacy.keepMicrophone ? 'Away: an already-on microphone may stay on. Paused camera can return when this page is visible.' : 'Away: microphone and camera are paused. Still-requested devices can return after fresh authorization when this page is visible.') : 'Returning restores only devices paused by away privacy. Screen sharing always needs a new Share click.';
    const networkNote=s.transportNotice|| (s.iceTransport==='relay-configured'?'P2P · TURN configured; relay reachability and media delivery are unverified.':s.iceTransport==='stun-configured'?'P2P · STUN configured; no TURN relay configured. Restricted networks may fail.':s.iceTransport==='host-only'?'Host-only P2P · No STUN or TURN configured. Restricted networks may fail.':'P2P · No active ICE configuration. Configuration is requested after authorized opt-in.');
    $('.media-network-note').textContent=networkNote+' Use one active tab per account. Devices start from your choice; away-paused mic and camera may resume on return.';
    const transport = $('.media-transport'); transport.replaceChildren();
    const connectionRows = s.peers.length ? s.peers.map(p => `${p.name}: ${p.status === 'connected' ? 'transport connected' : p.status} · ${p.candidateCount} local ICE candidates · ${p.receivedBytes} bytes received${p.error ? ` — ${p.error}` : ''}`) : [s.transportNotice || (s.joined ? 'No eligible opted-in participants yet.' : 'Not in a call. No peer connection is active.')];
    for (const row of connectionRows) { const p = document.createElement('p'); p.textContent = row; transport.append(p); }
    if (!s.capabilities.secure || !s.capabilities.devices || !s.capabilities.display || !s.capabilities.rtc) { const p = document.createElement('p'); p.textContent = [s.capabilities.deviceReason, s.capabilities.screenReason].filter(Boolean).join(' '); transport.append(p); }
    $('.media-retry').disabled = !s.joined || silent;
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
  $('.media-join').addEventListener('click', () => handle(session.setJoined(!(session.snapshot().joined || session.snapshot().joining))));
  for (const kind of KINDS) $(`[data-media="${kind}"]`).addEventListener('click', () => handle(session.toggleDevice(kind)));
  $('.media-keep-microphone').addEventListener('change', event => session.setKeepMicrophoneAway(event.target.checked));
  $('.media-retry').addEventListener('click', () => handle(session.retry()));
  $('.media-details-toggle').addEventListener('click', () => setExpanded(!expanded));
  $('.media-settings-close').addEventListener('click',()=>setExpanded(false));
  $('.media-refresh-devices').addEventListener('click',()=>void session.refreshDevices());
  for(const kind of ['camera','microphone'])$(`.media-settings-${kind}`).addEventListener('click',()=>handle(session.toggleDevice(kind)));
  for(const input of root.querySelectorAll('[data-media-setting]'))input.addEventListener('change',()=>handle(session.setCaptureSetting(input.dataset.mediaSetting,input.type==='checkbox'?input.checked:input.value)));
  $('.media-speaker').addEventListener('change',async event=>{
    const value=event.target.value;if(value&&!session.snapshot().availableDevices.some(d=>d.kind==='audiooutput'&&d.deviceId===value))return;
    selectedSpeaker=value;speakerError='';const ticket=++speakerEpoch;
    await Promise.all([...elements.values()].filter(tile=>!tile.media.muted).map(tile=>applySpeaker(tile.media)));
    if(!destroyed&&ticket===speakerEpoch)render(session.snapshot());
  });
  root.addEventListener('keydown',event=>{if(event.isComposing)return;if(event.key==='Escape'&&expanded){event.preventDefault();event.stopPropagation();setExpanded(false);}else if(event.target.closest('input,select,button,summary'))event.stopPropagation();});
  render(session.snapshot()); void session.update();
  const interval = setInterval(() => void session.update(), 1100);
  return {
    onEvent(event) {
      const type = event?.type || event?.event;
      if (type === 'media-signal') void session.onSignal(event.data ? { ...event.data, type } : event);
      if (type === 'media-policy') session.acceptPolicy(event.data || event);
      if (['presence', 'scene', 'room', 'role', 'moderation'].includes(type)) void session.update();
    },
    checkLocalPolicy: () => session.checkLocalPolicy(),
    acceptCommittedRoom: (room, actorId) => session.acceptCommittedRoom(room, actorId),
    update() { const room = currentRoomId(getState()); if (room !== lastRoom) { lastRoom = room; expanded = false; $('.media-details').hidden = true; $('.media-details-toggle').setAttribute('aria-expanded', 'false'); } void session.update(); },
    destroy() { destroyed = true; speakerEpoch++; const preview=$('.media-self-preview video');preview.pause();preview.srcObject=null; clearInterval(interval); session.destroy(); for (const tile of elements.values()) { tile.media.pause(); tile.media.srcObject = null; } elements.clear(); root.replaceChildren(); },
    // Read-only diagnostics for automated checks; no fixture identities or synthetic success.
    getStatus: () => session.snapshot()
  };
}
