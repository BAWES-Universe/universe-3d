# Development status · 2026-10-02 21:18 UTC

## Current increment: usable side-content controls and preserved foreground history

Embedded room content now leaves an available-width control lane. Dock, builder tools, header actions and camera controls have explicit responsive/scrolling layouts. Native Chat/Places Close buttons remain reachable, the original complete logo keeps its aspect ratio, and decorative room titles cannot intercept clicks. The canvas and camera projection remain full-size. See `HUD-AVAILABILITY.md` and `FRAMING.md`.

Coexisting content stays alive while opening or dismissing Chat, Places, Help, Express and quick actions. The exact iframe and unsubmitted form survive foreground navigation. Explicit content dismissal stays closed when a later foreground panel closes; intentional browser-history reopening requires fresh room-action authorization. Opaque tab-local keys, known surface names and room IDs are the only content history metadata. See `CONTENT-HISTORY.md`.

Final source: 636 CPU/API tests passed with the same one documented historical-fixture skip. Syntax (209 files), build, package startup and Dockerfile-copy reconstruction passed. All 11 actual-game history scenarios passed, including native two-frame retention after a server scene-revocation fixture removes the latest action. Final main bundle: `939415b2cf240af7cffbf5d2df3e5a5784f60ae47891e4a46a1ce919507bb88e`; CSS: `cb873a608bbba94329b0b077d707a49dd49ad372bff91e1c2fc7c6c28d3daf52`.

Immediately before the final one-line live-frame key-lifetime correction, all 100 scoped browser checks passed: 25 HUD/header/history, 29 framing/picking/resident and 46 image checks. That run used main `bc07636f51442f013a0b37efc6de4ea64fc3707abef6f8527bc16d06a30f720d` with the exact final CSS. The changed history path was then rebuilt and retested as above. Those earlier full-group results are not claimed as byte-identical final-source runs. The new HUD/header/history suites also use bounded 60-second action/capture waits, preserving native input and every assertion. Exact-head remote CI and publication are pending for this increment.

The durable baseline is `bd2947c027f90ce0f168f13c12ac91792d4f84a1`, whose eight remote CI jobs passed. It includes the image lifecycle runtime from `c5e9656a0877683c78769a211e82a35cfbfa3471`, both narrowly corrected browser readiness harnesses, and schema2/revision4 of the source parity inventory. The inventory's evidence is deliberately pinned to its inspected `be6d1369` snapshot; it is incomplete and certifies no whole feature contract.

The isolated next proximity-membership work is excluded from this increment. Optional ICE configuration remains unconfigured by default; configuration and SDP tests do not prove live media or a relay.

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
- The existing media graph still has cap-four, opted-in proximity membership. The intended hybrid model, all-member counting and SFU transition/handoff are unfinished
- Issued TURN credentials are bearer credentials until relay expiry. Local revocation stops issuance/client use; it does not invalidate previously issued credentials at the relay
- One active media tab per account is supported. The existing recipient/signaling graph is account-based even though new credential issuance is session-bound
- Real device capture, physical-phone performance, network handover, operator-run Docker/proxy/TLS, backups and production capacity remain unverified
- Matrix/E2EE/federation, SSO, full quest programs, upstream owned-avatar entitlements, image pixel/geometry version editing, permanent definition deletion and collection import, persistent chunks, reusable primitive workshop, terrain and creator games remain partial or missing

The operator review remains pinned to `93ae7de9f529f252ecba13230369b404a663ef04` until separately updated. Source publication does not change the deployed revision or configure a relay.

## Next

1. Publish this scoped controls/history increment and verify every exact-head CI job
2. Integrate source-grounded proximity membership independently of microphone consent, preserving current recipient authorization and teardown
3. Confirm deployed media revisions, actual group/transition configuration and the operator's isolated ICE issuer/relay plan before real-media acceptance
4. Implement the authorized hybrid transport transition contract; real SFU handoff and provider-backed resident interaction remain unverified
5. Continue source parity and hands-on interaction improvements in small tested commits

The operator review pin remains `93ae7de9f529f252ecba13230369b404a663ef04` until separately updated. No deployment or running service modification has occurred.
