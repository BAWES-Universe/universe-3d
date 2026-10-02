# Development status · 2026-10-02 22:28 UTC

## Current increment: opt-in all-member proximity and scoped client lifecycle

The explicit server factory option now separates conversation membership from microphone consent. Every eligible nearby member counts, while a session must have its own consent for signaling and ICE. Bubble/member/AV/transport scopes fence stale operations and target delivery. Room/admission preconditions prevent a delayed consent body from enabling media in a different room. The legacy default remains unchanged; no deployed settings are assumed. See `PROXIMITY-MEMBERSHIP-CONTRACT.md`.

The matching client preserves safe local capture separately from peer/ICE ownership. One mic/camera click completes authorized joining before prompting; solo capture can stay ready without a peer or ICE and later attach only after current authorization. Other participants' consent changes do not discard the user's local stream. Own denial, consent loss, admission change, Silent, room/account change and invalid policy still stop it. Pending joins can be cancelled, concurrent device intents share joining, and queued consent writes converge in order. Screen sharing requires Join first before opening the browser picker, preserving genuine user activation.

No SFU is configured. Over-threshold proximity keeps membership but pauses executable P2P/ICE with an explicit SFU-unavailable message. This is selection policy and local lifecycle evidence, not working media packets or a completed transport handoff. Simultaneous AV from two tabs of the same account remains unverified because peer identity is account/aggregate-member based.

Final integrated CPU/API checks pass 828 tests with one pre-existing historical-fixture skip. Syntax (221 files), build, package startup/static files and Dockerfile-copy reconstruction pass. The isolated compatible client also passed nine native RTC/signaling/ICE/DOM checks with zero capture attempts before a final strict-grant-boolean correction; that correction passed 249 focused tests. All seven final integrated media browser suites now pass, including the new nine-case native RTC/signaling/ICE/DOM probe, legacy policies, Silent, freshness and native ICE behavior. The new native probe prohibited device capture and recorded zero capture attempts. This remains local signaling/configuration/teardown proof, not working packets, real relay allocation or AV delivery.

Final main bundle: `11e74552455ae5f876d6fce046f50c9066c6cfe021abd258749ac8069bd53d17`; CSS remains `cb873a608bbba94329b0b077d707a49dd49ad372bff91e1c2fc7c6c28d3daf52`. Exact-head CI and publication are pending for this increment.

The durable baseline `7b3a4baf83afeae176d3bff69c6d58061cef455b` passed all nine remote CI jobs, including HUD/history, framing and images. Its full UI, image lifecycle, normalized parity documents and both browser readiness corrections remain preserved. The parity inventory is deliberately incomplete and certifies no whole feature contract.

The source audit in `MEETING-TRANSPORT-AUDIT.md` resolves the inspected meeting entry path: its LiveKit-named property is not an unconditional SFU selector. Named meetings, stage/audience and cross-room broadcast remain distinct identities/filters on the generic threshold manager; this does not establish deployed values or change current topology.

## Implemented and locally exercised

- Native 3D character creation and saved appearance, camera-relative movement, Shift2.5×, orbit/pan/zoom/follow, keyboard and touch controls
- Direct snapped building with preview, selection, drag, rotation, undo, persisted scenes and scoped permissions
- Universe/world/room hierarchy, invitations and revocation; local room text/DMs and ephemeral Express
- Functional item/area actions, audio resource lifecycle, HTTPS content panels, protected documents and authored quest slices
- Atomic personal-space claim/transfer/assignment and full old/new object footprint authorization
- Room-scoped PNG definitions and immutable versions, searchable metadata, reversible archive/restore, protected image bytes, alpha-aware placement/picking and collision
- Local resident authoring, ordered patrol, collision-aware movement and permission-checked pause/resume/return
- Private resident tests with durable operation identity, explicit saved permissions, cancellation and uncertain-result handling; synthetic literal-loopback protocol only
- Exact Host/Origin/TLS-cookie policy, login-only public preview mode, offline account provisioning and Node24 persistent-volume files

Tests exercise explicit boundaries and failure cases. Counts overlap and do not represent a feature-completion percentage. No whole Universe source contract is certified by this status file.

## Current limitations

- No real relay or AI/MCP provider is configured. Native ICE configuration and SDP restarts do not prove relay allocation, a connected media path or AV packets
- Default activation still uses the previous cap-four, opted-in graph. The explicit factory opt-in now has all-member proximity membership and a compatible scoped client. No default cap/threshold/scale is chosen; meeting/stage topology and SFU handoff remain unfinished
- Issued TURN credentials are bearer credentials until relay expiry. Local revocation stops issuance/client use; it does not invalidate previously issued credentials at the relay
- One active media tab per account is supported. The existing recipient/signaling graph is account-based even though new credential issuance is session-bound
- Real device capture, physical-phone performance, network handover, operator-run Docker/proxy/TLS, backups and production capacity remain unverified
- Matrix/E2EE/federation, SSO, full quest programs, upstream owned-avatar entitlements, image pixel/geometry version editing, permanent definition deletion and collection import, persistent chunks, reusable primitive workshop, terrain and creator games remain partial or missing

The operator review remains pinned to `93ae7de9f529f252ecba13230369b404a663ef04` until separately updated. Source publication does not change the deployed revision or configure a relay.

## Next

1. Publish this scoped increment and verify every exact-head CI job
2. Obtain intended cap/threshold/scale and deployed runtime facts before activating the optional proximity policy
3. Complete operator-authorized real device/relay acceptance and safe hybrid SFU handoff
4. Continue current-source parity and hands-on improvements in small tested increments

Operator review remains pinned to `93ae7de9f529f252ecba13230369b404a663ef04` until separately updated. No deployment or running service modification occurred.
