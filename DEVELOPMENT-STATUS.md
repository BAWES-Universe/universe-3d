# Development status · 2026-10-02 18:49 UTC

## Current increment: ordinary-P2P transport configuration

The app now has an optional operator-configured STUN/TURN path. Session-scoped issuance validates the current room, presence, opt-in and area policy; relay credentials stay out of SSE, snapshots and diagnostics. Browser connections consume that configuration, renew it with bounded requests and restart ICE on the existing peer. Failure or expiry stops devices and requires deliberate retry. Configuration is empty by default. See `P2P-ICE-ADAPTER.md`.

This increment is based on `d6380d27ebf6ae20c058f02e17807c3e1ff38fc0`, preserving its resident Test readiness correction. Creator pause/depth, full-canvas framing, source-aligned Silent behavior, held-policy freshness and all existing feature groups remain. Current app entry, renderer and CSS are unchanged.

Final local checks pass: 572 CPU/API cases, one explicitly skipped historical compatibility fixture, 196-file syntax, build, package startup and container-file simulation. All six media browser suites and seven actual-game creator cases pass on final bundle `e41a7407c5b9e61c8d3f1591ac7c3369f550b7e4a5698db6a6924ff1f3fd054d`; CSS is unchanged. The native ICE suite verifies seven configuration/signaling/restart/teardown scenarios with no device capture or relay allocation. All 39 existing freshness regressions remain passing.

Independent review reproduced stale-request failures across scope changes, room changes and same-scope retries; the final client uses current transport-operation, authority and peer fences, with four counterexample regressions and three current-failure/recovery controls. Before that final client-only correction, the same integration also passed all 29 framing/picking/resident-authoring cases and 13 resident private-test cases. Those are prior-bundle evidence, not a claim that every browser group was rerun on the final bundle. Exact-head remote CI remains pending; the previous `d6380d27` baseline is green in all eight jobs.

## Implemented and locally exercised

- Native 3D character creation and saved appearance, camera-relative movement, Shift2.5×, orbit/pan/zoom/follow, keyboard and touch controls
- Direct snapped building with preview, selection, drag, rotation, undo, persisted scenes and scoped permissions
- Universe/world/room hierarchy, invitations and revocation; local room text/DMs and ephemeral Express
- Functional item/area actions, audio resource lifecycle, HTTPS content panels, protected documents and authored quest slices
- Atomic personal-space claim/transfer/assignment and full old/new object footprint authorization
- Room-scoped PNG definitions and immutable versions, search/reuse, protected image bytes, alpha-aware placement/picking and collision
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
- Matrix/E2EE/federation, SSO, full quest programs, upstream owned-avatar entitlements, image editing/archive/delete, persistent chunks, reusable primitive workshop, terrain and creator games remain partial or missing

The operator review remains pinned to `93ae7de9f529f252ecba13230369b404a663ef04` until separately updated. Source publication does not change the deployed revision or configure a relay.

## Next

1. Publish this scoped increment and verify every exact-head CI job
2. Confirm deployed media revisions, actual group/transition configuration and the operator's isolated ICE issuer/relay plan before real-media acceptance
3. Integrate the independently tested bubble-membership model and implement the authorized hybrid transition contract
4. Continue current-source parity and hands-on interaction improvements in small tested commits

The operator review pin remains `93ae7de9f529f252ecba13230369b404a663ef04` until separately updated. No deployment or running service modification has occurred.
