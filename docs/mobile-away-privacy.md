# Mobile away privacy

Source contract: native [PR610](https://github.com/BAWES-Universe/workadventure-universe/pull/610), merged commit [`06899704db7892b3d5015e855c0de07ecfb539ef`](https://github.com/BAWES-Universe/workadventure-universe/commit/06899704db7892b3d5015e855c0de07ecfb539ef). This standalone adaptation preserves native visibility latching and independent mobile preference storage. It does not assert native live-session or device parity.

## Preferences and visibility

- iPhone, iPad, iPod and simulator platform strings, Mac-user-agent devices with `ontouchend`, and Android user agents use `phoneMicrophonePrivacySettings`, default OFF. Mobile intentionally ignores the old shared/desktop value because it cannot distinguish an explicit setting from the historically written default.
- Other devices use `microphonePrivacySettings`, default ON. Explicit values persist separately; only the string `true` enables the setting. Storage failure falls back to a session-local choice, disclosed in the UI.
- Detection does not use viewport size, coarse pointers or focus. Only document visibility enters away privacy. Blur, keyboard activity, an embedded content frame, an expanded panel, and manual profile Away status do not enter it.
- Hidden without a current recognized conversation or supported live session enters away. Last conversation/live-session departure while hidden also enters it. Once entered, away stays latched until the document becomes visible; new background participants do not restart capture.
- Missing/malformed conversation authority is explicitly unknown and conservatively enters away while hidden. It is never inferred from zero WebRTC connections or zero media peers.

## Authoritative conversation adaptation

Every server media policy now includes `awayPrivacy`:

```js
{
  protocol: 'media-away-v1',
  source: 'proximity-membership', // or 'legacy-media-graph', 'unavailable'
  conversationActive: true,
  liveSessionActive: false,
  liveSessionSupported: false
}
```

In optional all-member proximity mode, conversation state uses the authoritative bubble plus its conversation recipients. It survives another member's microphone opt-out, absence of media peers, and an unavailable SFU above the P2P threshold. This preserves the distinction between belonging to a conversation and establishing media transport.

Legacy proximity and meeting/stage areas use their existing server-authorized media graph. This deliberately has narrower semantics: AV-opted-out room occupants do not by themselves establish a legacy conversation. A stage/meeting label, publishing permission, or joining audio alone is never treated as an actual live session.

The standalone server has no live-session authority. Both live fields therefore remain false. The pure latch supports an explicit supported live-session signal for a future authority, with fixture coverage, but no current live-session support, SFU connection, handoff, relay reachability, or delivered media is claimed.

## Capture and return ownership

Away stops and removes owned microphone tracks unless the device's keep-mic preference retains an already-live microphone. It always stops camera and screen sharing. Pending capture requests are retired even when keep-mic is on, so delayed permission/consent/ICE completion cannot start a hidden device. Remote/listening eligibility and transport authorization remain separate.

Only mic/camera intent suspended by this exact away lifecycle is eligible to return. Visible return starts a fresh media-policy GET, checks the same room/account/admission/publishing authority, and inspects current browser permission. Automatic capture requires permission state `granted`; denied, prompt, rejected, or unavailable permission inspection requires an explicit new device click. That fallback avoids opening a permission prompt automatically after revocation and is a deliberate stricter boundary than native constraint re-evaluation. A still-pending permission request that never joined audio is not retained as resumable intent.

Manual off, Leave, Silent/Busy or publishing denial, lost room readiness, account/room/admission replacement, policy/ICE failure, revoked membership/consent, and disposal cancel resumable intent. Normal recovery never revives it. Other members' media consent or transport changes do not independently erase still-valid local ownership. Screen sharing never resumes or opens a picker automatically. Each stale continuation stops only its own stream and cannot replace newer device state.

`createMediaSession` owns and disposes its document visibility listener. There is no main-window blur or panel hook. It exposes `checkVisibility`, `setKeepMicrophoneAway`, and read-only `snapshot().awayPrivacy` (visibility/latch, preference, conversation authority, suspended kinds). The mounted native checkbox in connection details supports keyboard Space and touch through its label. It describes browser-local persistence and return behavior.

## Integration seam

The main room lifecycle should expose `getState().admissionId` from the server's accepted `arrival.admissionId`/actor `presence.admissionId`. Stable resume retains that token; explicit travel rotates it, including same-room travel. Media includes it in capture ownership, serialized consent ownership, and its context-change teardown. Its absence preserves legacy callers. This module does not create or validate admission IDs or modify arrival resolution.

No `main.js`, arrival, action-authority, editor, or app route change is part of this slice. Existing HTTP endpoints, permission prompts on explicit clicks, and ICE configuration remain unchanged. Browser fixture import lists now include `media-away.js`; the media browser group includes `media-away.browser.mjs`.

## Verification and limits

Deterministic pure/client/API tests cover independent mobile migration, iPad/Android detection, latch transitions, zero-RTC conversations, last-peer/live end, stale promises, rapid returns, fresh policy and permission authority, independent cancellation, Silent/revocation/admission changes, no blur behavior, no implicit screen picker, and honest all-member/legacy/SFU projection.

`media-away.browser.mjs` uses denied physical capture plus injected media, permissions and visibility. It exercises actual DOM, keyboard Space, touch label activation, iframe focus, reload persistence and CSS at phone/desktop sizes. It cannot establish physical-device background behavior.

Real iPhone/iPad/Android acceptance remains required on an identified deployed build: OS microphone indicators, Camera photo/video use, phone-call interruptions, ongoing background conversations, last participant leaving while hidden, permission revocation, and return behavior. No physical phone, real capture, live call, STUN/TURN relay, or SFU test was performed in these fixtures.

### Verified source checkpoint (2026-10-03)

Isolated implementation source commit: `a363496dbbb9ab37b97af648ddde7cf13f159696` (a pre-export test identity, not a published branch-head claim).

- Privacy pure/client/API coverage: 50 passing cases. Combined privacy plus existing lifecycle/freshness checks: 116 passing cases.
- Exact-checkpoint full unit suite: 1,269 passed, zero failures, one retained historical-adapter skip (1,270 total). All 273 JavaScript sources passed syntax checks.
- Exact-checkpoint production build and packaged-server health/static-file checks passed.
- Chromium 153.0.8010.0: `media-away.browser.mjs`, `media-silent.browser.mjs`, and `media-browser.mjs` passed serially. The new fixture verified native checkbox keyboard/touch interaction, iframe focus, reload persistence, injected visibility and track teardown/return. Existing checks retained Silent policy/viewport coverage and real-API-shaped/native denial-only SDP/teardown coverage. No page errors were reported.
- Phone (390×844) and desktop (1100×760) privacy screenshots were inspected: the setting, help, return explanation, and existing controls remain visible and usable. The touch label is 48 pixels high. These are emulated/injected browser fixtures, not physical-device evidence.
- The other media browser suites and full-game arrival integration were not run as part of this bounded increment. Physical-device, real capture/call, relay and SFU checks remain unperformed.

### Combined integration verification

The privacy source was integrated after the final participant-control correction. The combined tree passed 1,269 CPU/API tests with the existing one historical skip, all 273 source syntax checks, build, packaged-server checks and Dockerfile-copy reconstruction. All eight media browser suites passed: privacy, Silent, native denial/SDP, server-browser lifecycle, ICE, actual-game Silent, actual-game freshness, and native scoped proximity transport/signaling. The latter checks retain their no-device/no-relay boundaries; successful configuration and SDP do not prove delivered media.

The resulting main bundle is `6536741f76ff85831c149bb92a0206a52805e369da7aa56732ea39e4e83be9f0`; CSS is `0161fac62f8d2def9477dca4755d9b0062df661dcb4ba11a7e821969e690a93d`. Named-arrival shell integration and physical-device acceptance remain separate.
