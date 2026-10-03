# Opt-in proximity membership authority

Status: bounded server and scoped-client integration, **disabled by default**. Based on standalone commit `bd2947c027f90ce0f168f13c12ac91792d4f84a1`. This does not establish deployed parity, working WebRTC media delivery, or SFU transport. The scoped client has local HTTP/SSE and native SDP/ICE-lifecycle evidence only.

## Activation and boundaries

Activation is explicit `createGameServer({proximityMembershipConfig})`, or the validated process-entry `UNIVERSE_PROXIMITY_CONFIG` described in `PROXIMITY-RUNTIME-CONFIG.md`. The optional environment object requires every policy value; absent/off retains the previous path. There is no automatic activation, public config endpoint, or SFU switch. Omit the option to retain the prior four-participant media graph and existing API. The composed `src/media.js` recognizes `proximity-v1` and sends its scoped envelopes. Earlier clients do not, and must not be used with this option. No factory/configuration default was changed by the client integration.

`validateProximityMembershipConfig` requires all fields:

- `enabled: true`
- `membershipCeiling`, separately `p2pThreshold`
- `minimumDistanceSource`, `groupRadiusSource`, `sourceUnitsPerWorldUnit`, `coordinateLimitWorld`
- `downgradeDelayMs`, `memberTtlMs` (positive, no more than the existing 60-second presence lease)
- `maxRooms` (1–64), `maxMembersPerRoom` (1–256), `maxAccounts` (1–4096), `maxMemberships` (1–8192), `maxSessionsPerMember` (1–16)

Config is validated before the app opens its Store, copied/frozen, and rejects unknown fields. Limits are implementation safety bounds, not upstream settings. `tests/fixtures/proximity-config.mjs` uses synthetic ceiling 8 / threshold 5 / 16 source units per world unit. Those are not selected operator defaults. Pinned source defaults are cap 4 / threshold 4; neither represents observed deployed environment values. The actual values and source-to-world scale remain operator decisions.

Only proximity membership/grouping is replaced. Meeting/stage/audience media topology is retained. The inspected source route is clarified in MEETING-TRANSPORT-AUDIT.md; deployed behavior and configuration remain unverified. Opt-in mode additionally enforces per-session consent on these existing paths and preserves another tab's consent when one tab opts out. The default-off path is unchanged. Resident execution, account provisioning, non-media UI, avatar data, chat/emote routing, and persistent text history are untouched.

## Authority API and integration

`createProximityMembershipAuthority({config,store,presence,now,onInvalidate})` is server-only:

- `assertAdmission(acceptedSession, roomId)`: validates configured admission bounds before room-join mutation. An excess join returns 429 without corrupting established membership
- `policy(acceptedSession)`: rereads current SQLite session, room ACL, user status, and fresh canonical presence; never accepts room/account/context overrides from a request body
- `setConsent(acceptedSession, boolean)`: binds a media grant to that specific current session and aggregate admission generation
- `authorizeP2PSignal(acceptedSession, envelope)`: rechecks current authority, both identities, room/bubble, transport intent, AV scope, and actor's own consent
- `authorizeDelivery(acceptedSession, envelope)`: ensures each actual SSE recipient session is currently consenting and has the current authorized edge
- `refresh(roomId)`, `sweep()`, `forgetRoom(roomId)`, `close()`: lifecycle hooks
- `captureRoom(roomId)`: one synchronous authoritative refresh plus detached account/session policy projectors. Only use inside the host's same synchronous refresh. The capture is invalid after another authority transaction. This avoids re-querying every room member for every SSE recipient
- `policyForAccount(accountId, roomId)`: host-only aggregate reporting. It cannot authorize any session's signal, delivery, or ICE issuance

`server/media.mjs` consumes the authority only when configured. It derives `peers` exclusively from executable `p2pRecipients`; the server scene and account status still determine context. Account IDs/display names in peers have the existing meanings. Consent is not used to create, split, or destroy logical conversation membership.

`server/app.mjs` passes the accepted session to policy/state/signal calls, validates joins before mutation, and personalizes each SSE policy. New signals are delivered only to separately authorized target sessions. The existing heartbeat invokes cleanup; shutdown closes the service. A failed authority read or regressed clock clears cached authority and sends an empty, disabled teardown policy (`proximityAuthorityUnavailable: true`), including to existing subscribers. This is not proof that a hostile client destroyed an already established direct connection.

`server/media-ice.mjs` retains its existing independent session grants. Its issue path now passes the current session into policy lookup. In the opt-in protocol, a missing bubble or blocked transport gets no ICE scope. The ICE scope key includes member, bubble, and AV scope, so old challenges cannot survive membership/consent transitions. No TURN secret/configuration is added.

## HTTP policy and signal contract

The configured proximity response adds `proximityMembership`:

```json
{
  "protocol": "proximity-v1",
  "memberId": "opaque process/admission-scoped identity",
  "bubbleId": "opaque current bubble identity, or null",
  "membershipRevision": 1,
  "mediaScope": "opaque current AV authorization scope, or null",
  "conversationRecipients": [{"accountId": "eligible account", "memberId": "current identity"}],
  "transport": {"selectionIntent": "p2p", "requiredTransport": "p2p", "intentGeneration": 0, "memberCount": 2, "p2pAllowed": true, "blockedReason": null, "connectedTransport": null, "handoffComplete": false}
}
```

The object above is illustrative; the transport also includes evaluation/membership/debounce fields. A lone/out-of-scope member has no bubble/transport. New-client consent writes send `roomId` and, for a scoped proximity policy, the current own `memberId`. When configured, `/api/media/state` requires the current room and applicable admission precondition before either ICE opt-in or media-state mutation. A delayed old-room or old-admission HTTP body is rejected with 403, never rebound to the live session’s new room. Default-off legacy clients may still omit those fields; a supplied mismatched room is rejected. Meeting/stage/audience writes retain their unscoped topology and need only the room precondition.

Every opted-in proximity signal must include existing `to`, `connectionId`, and exactly one ordinary signal payload, plus current `roomId`, `bubbleId`, `fromMemberId`, `toMemberId`, `intentGeneration`, and `mediaScope`. Get the target member ID from the current peer. The server derives `from`; a client-supplied account identity cannot authorize it. Missing/retired scopes are denied. Existing size, rate and SDP direction checks remain.

SSE signals carry the same authoritative scope fields. A client integration must fence every async offer/answer/candidate/restart/capture result and close stale peers on any scope change, consent withdrawal, Silent/context transition, admission change, or access revocation. A media scope change must not rejoin text, replace player identity, or duplicate history.

`conversationRecipients` is eligibility metadata, not a new send endpoint or permission to widen existing chat/emote audiences. Text and emotes remain on their existing room-authorized paths. Source emotes can have viewport scope; do not substitute bubble scope for that audience.

## Membership, consent, identity, and no-SFU behavior

- Membership requires a stored user, at least one unexpired accepted room session, current ACL and fresh canonical presence. Display-only residents, sessionless presence, inaccessible users and expired users are excluded
- One account counts once per room, matching this standalone app's presence aggregate. This is an explicit adaptation: upstream Space counts membership entries and does not deduplicate accounts
- A live aggregate retains its member ID through ordinary movement, consent changes and partial tab departure. Last leave/rejoin, disjoint session admission, TTL expiry or authority reset gets a new member ID. The host must refresh after the last leave and before rejoin; the factory does so
- Every member of the particular logical bubble counts, including members with media disabled, mute/capture off, or no subscribing client. Merely being elsewhere in the same room does not count
- A specific session may send/receive/obtain ICE only with its own live consent. Other tabs can contribute to aggregate peer availability but cannot grant that session permission. Expiring the last consenting tab removes AV edges without removing a still-admitted nonconsenting account
- AV `mediaScope` rotates when member identity, consenting sessions or executable P2P eligibility changes. Text/bubble identity remains stable across mere media changes
- Silent has priority over overlapping meeting/stage/audience context and removes proximity participation. Existing standalone busy/dnd/invisible exclusions remain; busy is deliberately **not** claimed to equal upstream BUSY
- No SFU adapter/configuration is present. The authority always supplies `sfuAvailable:false`. At more than the explicitly configured P2P threshold, membership survives, P2P recipients and ICE eligibility become empty, `requiredTransport:sfu`, and `blockedReason:sfu-unavailable`
- The retained pure reducer tests exercise upgrade/downgrade **intent only**. `connectedTransport` is always null; `handoffComplete` is always false. A configured availability fact, timer, or member count would not establish a connected SFU route

## Source grounding and intentional disagreements

All references use `BAWES-Universe/workadventure-universe` pin `0e1ff05014d4b871ffd94eea744e40c1d1c7df79`. This is an independently inspected source snapshot; it does not establish the deployed back, pusher, frontend or media revision.

- [Group.ts](https://github.com/BAWES-Universe/workadventure-universe/blob/0e1ff05014d4b871ffd94eea744e40c1d1c7df79/back/src/Model/Group.ts), lines 76–190: head barycenter, radius, whole-member cap, joins/leaves
- [GameRoom.ts](https://github.com/BAWES-Universe/workadventure-universe/blob/0e1ff05014d4b871ffd94eea744e40c1d1c7df79/back/src/Model/GameRoom.ts), lines 325–542: movement, nearest group, membership teardown
- [CommunicationManager.ts](https://github.com/BAWES-Universe/workadventure-universe/blob/0e1ff05014d4b871ffd94eea744e40c1d1c7df79/back/src/Model/CommunicationManager.ts), lines 158–170,217–271: transition counts use `getAllUsers()`; [TransitionPolicy.ts](https://github.com/BAWES-Universe/workadventure-universe/blob/0e1ff05014d4b871ffd94eea744e40c1d1c7df79/back/src/Model/Policies/TransitionPolicy.ts), lines 29–40: independent threshold/availability
- [Space.ts](https://github.com/BAWES-Universe/workadventure-universe/blob/0e1ff05014d4b871ffd94eea744e40c1d1c7df79/back/src/Model/Space.ts), lines 279–285,622–647: ALL members differs from notifying/publishing subsets
- [User.ts](https://github.com/BAWES-Universe/workadventure-universe/blob/0e1ff05014d4b871ffd94eea744e40c1d1c7df79/back/src/Model/User.ts), lines 182–193: proximity-excluded statuses. AWAY and BUSY are not excluded
- [BotClient.ts](https://github.com/BAWES-Universe/workadventure-universe/blob/0e1ff05014d4b871ffd94eea744e40c1d1c7df79/bots/client/BotClient.ts), lines 155–195,2342–2363,2796–2837: ordinary room/Space admission, media-off bots. A bot must actually join the specific proximity Space, not merely world Space. No bot-tag exclusion exists in ALL membership

The three pure modules in `server/proximity/` are ported unchanged from the separately tested recovered reference. They deliberately sort snapshots deterministically, require both new participants to stop, skip rather than reproduce source sweep's early-return defect, honor locks, use a bounded full-room scan, validate follow links, and block oversized P2P without SFU. These are documented adaptations, not exact source runtime parity. The adapter currently supplies no follow relationships because the standalone server has no trusted follow-membership authority. Meeting/follow/SFU-only branches remain tested pure reference logic, not new executable services.

## Verification and remaining release work

`node --test tests/proximity*.test.mjs` covers the ported deterministic model, real SQLite authority, and loopback HTTP/SSE integration. Fixtures contain synthetic sessions/config only. It verifies member/privacy/scope separation, per-session consent, Silent, expiry/ACL, partial/last leave, bounds, failed-read teardown, threshold blocking, and legacy default behavior. A synthetic local in-memory CPU check after batching and removing full room serialization measured three refresh runs at 6 members (3.5–10.1 ms), 20 (11.6–13.8 ms), and 100 (69.9–96.2 ms), all media-off without SSE subscribers. Store.all query counts were 6/20/100 and full room serializations zero. Per-account ACL/session checks remain current. These are local measurements, not deployed capacity. A regression test bounds per-refresh Store reads and rejects full room serialization. No test establishes browser capture, actual P2P connectivity, TURN reachability, deployed capacity, SFU handoff, or full upstream parity.

Before activation: obtain the intended cap/threshold/scale; compose this client and server into the intended release; verify working ordinary P2P media/ICE paths across real clients and networks; decide the actual meeting route. A future SFU adapter separately needs server grants, participant revocation, stale-invite cancellation, rollback, readiness, duplicate-track prevention and one-audible-route tests. No credentials, deployment, operator service, network/security setting or public config default changed here.


## Scoped browser client composition

The standalone `src/media.js` client recognizes the opt-in protocol only when `proximityMembership` is present. A missing field preserves genuinely legacy proximity sessions and the existing meeting/stage/audience paths. Once this room/account lifecycle has observed a scoped proximity policy, a later proximity-context policy missing the object fails closed instead of silently downgrading; room/account changes reset that observation. A present unsupported or malformed policy fails closed with a visible policy error; invalid member/target identity, malformed peer list, missing scope, non-integer/negative/non-finite intent generation and revision are rejected. A valid lone member with null bubble/revision/scope/transport remains an admitted conversation member and may opt in and deliberately enable local capture with current publishing permission. It requests no ICE, creates no peer and claims no connection until an eligible bubble exists.

Offers, answers, candidates and offer/restart requests send current `roomId`, `bubbleId`, `fromMemberId`, `toMemberId`, `intentGeneration` and `mediaScope`. The existing server protocol treats `membershipRevision` as policy metadata, not a signal authorization field. Peer identities, direction, member/bubble/AV/intent and consent are bound to each asynchronous peer continuation and ICE-cache authority. Capture has a separate ownership boundary described below. `membershipRevision`, evaluation timestamps and display-name-only changes do not churn healthy peers when those authorization facts are unchanged. This is not an ordering claim for opaque IDs or SSE reconnects.

Every incoming signal is checked against the current scoped sender and target before and after policy/ICE awaits. Scoped envelopes cannot fall through to unscoped meeting/legacy handling. Pending candidate queues are keyed by authority, sender member/account and connection ID; a different sender cannot reuse a remote-chosen connection ID to acquire another sender's candidates. Pending SDP, track replacement, candidate application, diagnostics and restart continuations cannot mutate a replacement peer after retirement. Renewal checks current ownership before native `setConfiguration` and restart, and late renewal failures cannot stop a replacement scope.

The existing policy request epoch still orders overlapping GET versus accepted SSE within the current client lifecycle. A late GET cannot rewind newer SSE authority; the consent POST body is not directly accepted as a fresh policy. Scope identity itself is not used as a monotonic freshness revision. Existing local Silent, room/account availability and committed-denial geometry fences remain in force.

A peer/ICE authorization change closes old peers immediately without changing conversation metadata. Local capture authority is separately bound to actor, room, own admission identity, explicit own session consent and fresh publishing context. Safe local streams and pending user capture can survive solo-to-bubble transitions and another participant's consent, target, AV scope or transport-intent changes. They attach to replacement peers only after current peer and ICE authority succeeds. Own consent loss, admission change, room/account change, context/Silent denial, invalid policy, policy timeout and current ICE failure stop capture. Devices never automatically recapture after being stopped.

For scoped mic/camera, one deliberate click completes the authorized join first, then starts a newly owned capture operation under the fresh policy. Its device-free pending gesture may cross its own expected consent grant; room/account/admission/context denial or a second device click cancels it before any prompt opens. Screen sharing explicitly asks the user to join first without opening a picker, then uses a fresh Share gesture to preserve genuine activation. The dock exposes an enabled `Cancel joining` action while a join is pending. Simultaneous mic/camera gestures share the pending join while retaining separate cancellable capture intents. Before the first policy arrives, device controls are gated; direct mic/camera operations wait for that policy and screen gives Join-first guidance without a picker. The consent state writes are serialized and execution-fenced by actor/room/admission ownership: explicit Leave stops the client synchronously and queues server opt-out after a pending enable acknowledgement, so the old enable cannot arrive after the user's final disable. Held actual HTTP acknowledgement tests verify eventual disabled server consent. Queued obsolete enables are skipped before transmission; already-transmitted split-body stale room/admission writes are rejected by the server precondition. Physical capture/pickers were not exercised.

Per-session grants do not establish simultaneous AV support for two tabs of one account. Peer/signaling identity remains account/aggregate-member based, and an authorized offer to an account may be delivered to multiple consenting sessions. Partial-tab grant/leave tests are authorization evidence only. Use one active AV tab per account; this increment does not redesign transport identity.

Above the configured threshold, the media dock says `SFU unavailable` with the server's all-member count. It stops P2P/ICE transport and does not claim a connected SFU, handoff or audio delivery. Safe explicitly enabled local devices remain under local capture authority; the notice explicitly says transport is paused. Returning to authorized small-bubble P2P creates replacement peers, attaching any still-authorized local stream only after current authorization succeeds. No SFU adapter dependency, public operator configuration, automatic provider selection or chat/emote audience change is introduced.

### Local verification boundary

- `node --test tests/proximity-client.test.mjs`: focused synthetic peer/track/permission/deferred-async tests for scoped envelopes, wrong/absent fields, all authority transitions, stable metadata-only revisions, pending SDP/candidate/track/ICE work, early-candidate isolation, malformed policies, lone membership, one-click mic/camera join-before-capture, screen Join-first, interrupted/cancelled joins and preserved safe local streams
- `node --test tests/proximity-client-http.test.mjs`: actual loopback HTTP/SSE, SQLite membership/consent and production `createMediaSession`, with synthetic browser APIs. Covers small P2P negotiation, all-member threshold including media-off members, consent and admission retirement, Silent/meeting transitions, solo-to-pair capture readiness, cancellation and serialized Leave, held actual GET, consent and ICE responses versus newer SSE, and split-body stale room/admission writes rejected before consent/ICE mutation
- `node tests/proximity-client-native.browser.mjs`: two isolated native Chromium cookie sessions; actual `RTCPeerConnection`, authorized configuration, scoped SDP/SSE negotiation, `setConfiguration`, elected offerer/answerer ICE restart with changed SDP ufrags, room/context/Silent teardown, retired ICE rejection, and a real DOM Cancel-joining check with synthetic delayed consent. The probe serves only the standalone media modules, prohibits capture APIs and asserts zero attempts. It uses fresh synthetic loopback discard-port STUN/TURN fixture material, never a real relay/provider

Native signaling evidence is not evidence of TURN allocation, connected transport, media packets, audible/visible A/V, physical capture or multi-network traversal. The native probe stores only aggregate/configuration-match results and no issued credentials. Server defaults remain off and intended deployed cap/threshold/scale remain undecided.

## Named meeting route source clarification

[MEETING-TRANSPORT-AUDIT.md](MEETING-TRANSPORT-AUDIT.md) traces the pinned frontend property through the backend manager. The native property name `livekitRoomProperty` is not a forced-SFU selector: the inspected route remains threshold-driven, with room-URL-prefixed meeting identity. Stage/audience and cross-room megaphone are separate Space filters/identities, still using the generic manager. This does not establish deployed configuration or authorize changing current meeting topology.
