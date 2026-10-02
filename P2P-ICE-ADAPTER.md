# Ordinary-P2P ICE adapter

This increment adds an ICE credential/configuration adapter to the standalone app. It does **not** configure, deploy, or verify a TURN service. The intended hybrid model remains ordinary proximity P2P and SFU for meetings/large bubbles. This slice does not introduce an SFU or change the existing opted-in graph/cap-four proximity semantics. The separate bubble membership model is not integrated here.

## Explicit operator configuration

Only normal `server.mjs` calls `readIceRelayConfig(process.env)`. `createGameServer` defaults to `readIceRelayConfig({})` and never inherits deployment environment. Explicit factory injection accepts a config returned by this reader. No endpoint defaults exist.

- `MEDIA_STUN_URLS`: optional comma-separated `stun:` / `stuns:` URLs
- `MEDIA_TURN_URLS`: optional comma-separated `turn:` / `turns:` URLs
- `MEDIA_TURN_SHARED_SECRET`: server-only 32–512 character secret, required with TURN URLs; no static username/password fallback
- `MEDIA_ICE_TTL_SECONDS`: default 14400 (4h), integer 60–14400
- `MEDIA_ICE_RENEWAL_SECONDS`: default 75% of TTL (3h for default TTL), integer at least 30 and at least 15 seconds before expiry

Rejects malformed protocols, userinfo, paths, fragments, whitespace, invalid hosts/ports, STUN queries, unsupported TURN query parameters, insecure UDP under `turns:`, oversized/empty URL lists, unmatched secret/URLs, and static `MEDIA_TURN_USERNAME` / `MEDIA_TURN_PASSWORD` inputs. Supported URL hosts are ASCII DNS, IPv4, or bracketed IPv6. Up to eight URLs per class. The adapter intentionally validates more strictly than the pinned source.

The shared secret is kept in a private module WeakMap and is absent from config serialization. Never log config inputs or credential responses. No real secret or operator endpoint was used in verification.

## Issuance and authorization

`POST /api/media/ice` accepts exactly `{scope, requestId}`. A current policy's `iceScope` is an opaque random challenge personalized to the actual HttpOnly-cookie session. Current server policy declares `iceRequired: true`; a withheld scope never falls back to host-only transport. Each SSE stream is decorated per accepted token, matching that session's GET policy; another session's challenge cannot mint credentials even for the same user. No actor, session, room, URL, TTL, or credential is accepted from the caller.

The route requires a real unexpired session, current admitted room, presence younger than 60 seconds, that session's explicit opt-in, and an allowed current context. Silent and denied proximity reject issuance; allowed meeting, stage, and receive-only audience contexts can acquire transport. Authorization and scope are rechecked after the entire request body arrives. Context changes retire scope even without an SSE subscriber; returning to a previous context does not revive its old scope. Leave, logout, revoke and expiry retire session scope; short-lived rate counters remain until window expiry so toggling opt-in cannot reset limits.

Body limit: 1024 bytes. Deadline: 8 seconds. Issuance attempts are bounded to eight per session and twenty per user per minute; maps are capped at 2048 session entries and 4096 rate entries and pruned. Only a successful authenticated `Cache-Control: no-store`, `Pragma: no-cache` response carries `iceServers`. TURN credentials are never emitted in ordinary policy or SSE. Authorized SDP still necessarily carries the native peer connection’s ICE negotiation fields.

TURN username is `expiryUnixSeconds:userId`; credential is Base64 HMAC-SHA1(shared secret, username), matching the pinned source. Credential expiry is capped by session expiry and rounded down to seconds. Renewal is shortened for a session nearing expiry. The unconfigured response contains an empty ICE server list and `transport: host-only`; STUN-only is distinct from relay-configured.

Important security boundary: issued TURN credentials are bearer credentials. Local scope/session revocation blocks new issuance and tears down this client; it does not revoke an already issued relay credential. Such a credential can remain usable until its relay expiry. The username contains a user ID but has no room/session namespace enforcement or cryptographic room isolation. Operator-side issuer/revocation behavior remains unverified.

## Client lifecycle

`src/media-ice.js` keeps private cache, in-flight request and expiry state separately. Challenges are bound to request ID, room, self identity, scope and lifecycle generation. Requests have an 8s elapsed deadline plus AbortSignal; ignored aborts and late results cannot revive a retired context. Lifetimes use monotonic elapsed time, independent of client wall-clock rollback, subtracting request time conservatively.

Actual `RTCPeerConnection` construction consumes the authorized configuration only after opt-in. Renewal fetches a new response, calls native `setConfiguration`, and performs ICE restart on the same peer: elected offerer creates `createOffer({iceRestart:true})`; answerer requests restart through authorized signaling and answers the elected offerer's offer. Failure or expiry stops connections and devices and leaves an explicit error requiring a deliberate retry. No device is automatically captured or restarted. Existing synchronous Silent checks, pending-capture teardown, current actor hooks and committed-room guards remain intact.

Policy/snapshot/diagnostics do not include relay credentials. Diagnostics expose only a derived host-only, STUN-configured, or TURN-configured classification, never endpoint or credential values. A configured URL or successful native SDP exchange never means relay allocation, candidate selection, transport connection or media delivery succeeded. The UI continues to derive connected state from the actual browser peer connection state.

## Source provenance and limits

The upstream source was inspected at exact pin `0e1ff05014d4b871ffd94eea744e40c1d1c7df79`:

- [Credential generation](https://github.com/BAWES-Universe/workadventure-universe/blob/0e1ff05014d4b871ffd94eea744e40c1d1c7df79/play/src/pusher/services/WebRTCCredentialsService.ts)
- [ICE configuration](https://github.com/BAWES-Universe/workadventure-universe/blob/0e1ff05014d4b871ffd94eea744e40c1d1c7df79/play/src/pusher/services/IceServersService.ts)
- [Client renewal](https://github.com/BAWES-Universe/workadventure-universe/blob/0e1ff05014d4b871ffd94eea744e40c1d1c7df79/play/src/front/WebRtc/IceServersManager.ts)
- [Environment defaults](https://github.com/BAWES-Universe/workadventure-universe/blob/0e1ff05014d4b871ffd94eea744e40c1d1c7df79/play/src/pusher/enums/EnvironmentVariableValidator.ts)

The source hardcodes 4h HMAC credentials and defaults renewal to 3h. Static analysis shows its resolved cached promise prevents the scheduled callback from fetching fresh configuration; this implementation separates cached and in-flight state. This is a source observation, not a claim about deployed behavior.

The source pin does not establish deployed revisions, real TURN/STUN settings, issuer behavior, clock synchronization, relay ACLs, allocation lifetime, policy enforcement on previously issued credentials, device behavior, multi-network reachability, or packet privacy.

Tests use only fresh process-local synthetic secrets and loopback discard URLs. No real credentials, external providers/services, device capture, production endpoints, deployment, network or security settings were used or changed. Native tests prohibit capture and intentionally make no relay/media-packet claim.

## Reproduce local checks

Run `npm test`, `npm run check`, `npm run build`, `npm run verify`, `npm run verify:container-files`, and `npm run test:browser:media`. The media group includes native ICE configuration/restart plus actual-world Silent and held-policy freshness cases. The native test shortens only the first renewal timer; network calls, native RTC, clocks, request deadlines and expiry stay active. It uses loopback discard-port URLs and prohibits device capture.

The adapter is unconfigured by default. The app does not enable a real relay by passing these tests. Use one active media tab per account; existing recipient and signal graphs are account-based, while credential issuance is session-bound.
