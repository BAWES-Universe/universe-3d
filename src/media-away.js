// Source contract: native PR610, merge 06899704db7892b3d5015e855c0de07ecfb539ef.
// Browser-local keys are intentionally independent: an old desktop default is
// not evidence that someone opted in on a phone or tablet.
export const AWAY_MIC_KEYS = Object.freeze({mobile:'phoneMicrophonePrivacySettings',desktop:'microphonePrivacySettings'});
export function isMobileMediaDevice(env = globalThis) {
  const navigator = env.navigator || {}, platform = navigator.platform || '', ua = navigator.userAgent || '';
  return /^(iPad|iPhone|iPod)( Simulator)?$/.test(platform) || /Android/.test(ua) || (/Mac/.test(ua) && 'ontouchend' in env);
}
export function createAwayMicrophonePreference(env = globalThis) {
  const mobile = isMobileMediaDevice(env), key = AWAY_MIC_KEYS[mobile ? 'mobile' : 'desktop'];
  let storage, value = !mobile, persisted = false;
  try { storage = env.localStorage; const saved = storage?.getItem(key); if (saved !== null && saved !== undefined) { value = saved === 'true'; persisted = true; } else if (storage) { storage.setItem(key,String(value)); persisted = true; } } catch { /* Session-only choice when browser storage is blocked. */ }
  return {
    snapshot: () => ({keepMicrophone:value,mobile,key,persisted}),
    set(next) { value = next === true; persisted = false; try { if (storage) { storage.setItem(key,String(value)); persisted = true; } } catch {} return this.snapshot(); }
  };
}
// This projection is separate from opted-in media peers and transport. Missing
// authority is unknown, never proof that an empty peer list means being alone.
export function readAwayConversation(policy) {
  const p = policy?.awayPrivacy;
  const known = p?.protocol === 'media-away-v1' && ['proximity-membership','legacy-media-graph','unavailable'].includes(p.source) && typeof p.conversationActive === 'boolean' && typeof p.liveSessionActive === 'boolean' && typeof p.liveSessionSupported === 'boolean' && (!p.liveSessionActive || p.liveSessionSupported);
  return known ? {known:p.source !== 'unavailable',source:p.source,conversationActive:p.conversationActive,liveSessionActive:p.liveSessionActive,liveSessionSupported:p.liveSessionSupported} : {known:false,source:'unavailable',conversationActive:false,liveSessionActive:false,liveSessionSupported:false};
}
export function createAwayLatch(initialVisibility = 'visible') {
  let visible = initialVisibility === 'visible', away = false;
  return {
    update(visibility, conversation) {
      visible = visibility === 'visible';
      if (visible) away = false;
      // Unknown authority is a privacy-safe shutdown, not a claim of solitude.
      else if (!away && (!conversation?.known || (!conversation.conversationActive && !conversation.liveSessionActive))) away = true;
      return {visible,away};
    },
    snapshot: () => ({visible,away})
  };
}
