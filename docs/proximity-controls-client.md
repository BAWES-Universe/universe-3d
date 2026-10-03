# Participant controls client

This is the bounded standalone port of participant Lock/Unlock and individually consented Follow. The server protocol and motion controller are separate components. No leave/rejoin latch, cooldown, scripted force-follow, bots, media capture or provider integration is added here.

## Source

The source audit is pinned to `bae18306bdfa63e58cd4124b1a3b5b290b61c286`, with wide contextual labels compared at `9a68beea975560480c2c4dd3f23aeb50ef6f330b` (#609). Ordinary Follow sends an invitation; named recipients individually accept or decline; participant Lock changes the explicit lock independently of fullness. Ignore follow requests is stored locally in source.

The UI preserves the current app's audited ink/round/pill tokens, and exact native 24×24, 1.5px, round-cap/round-join icon geometry. New module-local glyphs were fetched at the default pin:

- [FollowIcon.svelte](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Components/Icons/FollowIcon.svelte), blob `48afbb69efdd866015d5e69ce961a7d7ea755b30`
- [LockIcon.svelte](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Components/Icons/LockIcon.svelte), blob `210ec8c731de5f8b6f80c3a72625e80106aacc94`
- [LockOpenIcon.svelte](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Components/Icons/LockOpenIcon.svelte), blob `ac3be705a8174ed99b57b7805ac4b0f4437123bf`

Only Svelte properties and hover-fill bindings are removed. SVGs inherit `currentColor`, are decorative, and cannot receive keyboard focus. Every action has a native button, a separate white 2px focus outline and a minimum 48px target, including medium widths where other HUD controls become 40px.

## Mount and stream ownership

```js
import {createProximityControls} from './proximity-controls.js';
import {mountProximityControls} from './proximity-controls-ui.js';
import './proximity-controls.css';
const controls = createProximityControls({api, getState, onChange});
const view = mountProximityControls({root, controller:controls, onReturnFocus});
```

`getState()` supplies `user.id`, `room.id`, `ready`, and `navigating`. The controller never owns global keyboard, presence, movement or camera listeners. The host maps one fresh F edge to `followAction()` only in valid gameplay focus; Shift+F remains camera follow. F never accepts or cancels a merely pending incoming invitation; the named Decline and explicit cancellation buttons remain available. The UI consumes keys only within its own surface. Enter/Space use native button activation; Escape on a named invitation declines it, and Escape elsewhere in the surface stops active follow or returns gameplay focus. Incoming invitations never focus anything. Existing invitation/action DOM nodes survive repeated events and timer updates; unrelated composers, drafts and selection are untouched.

- `syncState()` retires motion/requests on account, room, readiness or navigation transition
- `resetConnection(reason='connecting')` retires the old connection ID, pending commands/GETs and motion lease before reconnect
- `onEvent({type:'proximity-controls',data})` accepts the current EventSource's unwrapped authority context; a changed live connection ID explicitly retires the previous one
- `acceptContext(context,{readOnly:false})` applies already-fetched state. The host must fence its EventSource generation and buffer events while navigating, then apply after room commit
- `refresh()` always starts a new GET with the current connection ID. A newer GET, navigation, admission or connection invalidates its result. If only a strictly newer same-admission authority snapshot overtakes a successful valid GET after it began, refresh returns true while retaining that newer snapshot. This requires the reply to match the starting account/room/member/connection and have revision at least the starting revision, with current state strictly newer than both. Failed, invalid and pre-request stale replies remain false and never certify resume freshness
- `refresh({readOnly:true})` bootstraps via GET without a connection ID. It exposes existing server relations but cannot authorize commands/motion or replace an installed live connection
- If startup fetches before committing the room, hold that result and call `acceptContext(result,{readOnly:true})` after commit, while retaining the latest live event
- `lock(bool)`, `invite()`, `accept(invitationId)`, `decline(invitationId)`, `setIgnoreRequests(bool)`, `stop()` and `followAction()` resolve to booleans
- `subscribe(fn)` returns an unsubscribe function; `destroy()` retires work. Destroy the mounted view separately

All actions send only the settled server command fields. A 409 refreshes the state and asks the user to review/retry, never repeats a changed-context command automatically. Names use `textContent` exclusively.

## Snapshot and safety boundaries

`snapshot()` returns a cloned validated `context`, `connection`, `available`, `canAct`, operation/action, error/notice, local stop state, expired-marked invitations and confirmed/pending preference state.

`motion` is null unless a local explicit accept intent matches the current leader/member/connection, the server confirms that relation and its controlling lease, the stream is connected and the app is ready. A newer SSE acknowledgement can confirm a still-pending explicit accept. An unsolicited following context can never establish local motion consent.

`stop()` synchronously clears the accept intent and local grant, retires the lease and invalidates older command results before its request starts. Failed/lost stop acknowledgement keeps a directly visible Stop action and says server state is unconfirmed unless newer authoritative state has already established that the relation ended. A newer stopped context settles the pending operation, clears prior transport uncertainty, and prevents its later HTTP success or failure from overwriting that result or a subsequent relation. A refresh or late accepted state cannot reactivate the retired lease. The current server relation and lease remain in `context` for truthful state and stopped-coordinate presence credentials; they are never a motion grant.

`followingReadOnly` is true if a server relation exists without the current controlling stream, including read-only bootstrap. The host must suppress ordinary movement and all presence for secondary tabs. `serverLeading` and `serverWaiting` describe the current authoritative outgoing invitations/followers independently of local Stop intent. The UI uses them for current relation labels and puts live relation state ahead of old completion notices; a disconnected controlling stream is described as paused. `leading` and `waiting` additionally respect local Stop intent for motion/speed integration. `followSpeedLimited` covers confirmed following/leading and is false for incoming unaccepted invitations and locally stopped intent. The host may use the normalized `motion` fields with the separate collision-safe motion module; receipt `receivedAt` uses Date.now, while invitation expiration independently uses serverTime plus performance.now elapsed time.

The per-account Ignore choice is stored at `universe:follow-ignore:v1:<account>`. The server enforces it for each admission. The client immediately suppresses invitation display/acceptance for a remembered ignored choice, then re-applies the preference to a fresh live admission. Pending enforcement is identified honestly. Storage failure only loses cross-reload persistence, not the current tab choice. No server restart persistence is claimed.

## Placement and fixture results

Default placement is a compact contextual group above the existing dock, following `--hud-left`/`--hud-width`. Its count/status line distinguishes Open/Locked and Full. Named invitations expose both actions directly. Active follow exposes Stop in the same strip. It is hidden when no enabled verified authority/admission exists. It adds no permanent dock button.

The CSS supplies responsive standalone placement and `data-placement="inline"` for a host-reserved lane. Media rules set `--proximity-base-bottom` (112px desktop, 340px narrow portrait, 88px short landscape) and `--proximity-base-max-height` (the matching available-height expression). The host can read the responsive base and supply `--proximity-bottom` plus `--proximity-max-height` to lift the widget above a visible interaction prompt and fit the remaining height. Remove both overrides when the prompt disappears so responsive defaults take over; do not replace them with a fixed desktop fallback. Narrow portrait screens put it above the joystick/camera region; short landscape leaves the left movement area clear and allows scrolling inside this surface. At the smallest tested size, the contextual surface scrolls while every 48px action remains reachable. Do not place it over an open social/foreground panel: the host should reserve a lane, set an appropriate offset, or mark the covered surface inert while preserving Stop in its visible controls. Full shell coexistence is an integration check, not established by this module fixture.

Checks:

- `node --test tests/proximity-controls-client.test.mjs`: 50 controlled protocol unit cases
- `node tests/proximity-controls-client.browser.mjs`: native browser module fixture with actual current HUD styles
- Ten browser cases cover equivalent-event focus retention, native Enter/Space/Escape, Ignore state, immediate failed-ACK Stop, authoritative Stop followed by a lost HTTP receipt, current relation/status changes without replacing the focused button, disconnected-controller pause, pending-only shortcut hints, unrelated draft/selection retention, expiry, and control/document hit geometry
- Touch viewport geometry: 1280×800, 390×844, 320×568, 844×390 and 568×320. Existing dock/camera/joystick centers remain reachable. Accept/Stop also execute through native taps
- Generated screenshots/results live in ignored `evidence/proximity-controls/`

These are explicitly local controlled protocol fixtures. They do not certify the integrated 3D runtime, server authorization, real participant deployment or media providers.
