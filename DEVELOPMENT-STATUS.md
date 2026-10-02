# Development status · 2026-10-02 19:56 UTC

## Current increment: image library lifecycle

Full room editors can now edit library names, descriptions and searchable tags, confirm reversible archive, inspect archived thumbnails and restore assets. Existing saved instances keep their exact pinned image bytes, alpha picking, collision and per-instance name. Archived assets cannot be newly placed or duplicated; moving/editing a saved instance remains permission-checked. Metadata uses revisioned compare-and-swap, with explicit conflict recovery. No permanent erase is included. See `IMAGE-ASSET-LIFECYCLE.md`.

Final integrated CPU/API checks: 599 passed and the same one documented historical-fixture skip; 199-file syntax, build, package startup and container-file simulation pass. All 46 image browser checks passed on byte-identical runtime bundle `ff8c38512e11ea61d64848fd3b6bcbb6efb093bc050fb5ebb25912e643007672`, CSS `a726de7058af0a6613cf0a24a96340ade22792e7b542321c2a0ed7b537a0218e`. These include actual chooser, search/edit/archive/restore, saved-instance byte/pixel/picking/collision preservation, 320px touch placement and negative authority/race checks.

This composition preserves the durable parity docs and the image-capture harness correction at `bb371a420dc8d034fe2e91f1c43a2f916eaabd02`; that test-only correction passed the unchanged baseline's full 18 and mobile 6 image checks. That baseline now passes all eight remote CI jobs. Runtime source matches the separately verified image-lifecycle candidate. Other browser groups have not yet been rerun on this asset bundle locally; exact-head remote CI and publication remain pending.

The prior P2P runtime at `be6d136961010f986fde7c1ddaf13b66e164621a` passed all eight remote CI jobs. Its optional ICE configuration remains unconfigured by default; configuration/SDP tests do not prove live media or a relay. Current HUD-availability and embedded-history corrections are separate candidates and are not included here. The source parity map is deliberately incomplete and certifies no whole feature contract.

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

1. Publish this scoped increment and verify every exact-head CI job
2. Complete the independently tested HUD availability and coexisting-content history corrections
3. Confirm deployed media revisions, actual group/transition configuration and the operator's isolated ICE issuer/relay plan before real-media acceptance
4. Integrate the independently tested bubble-membership model and implement the authorized hybrid transition contract
5. Continue current-source parity and hands-on interaction improvements in small tested commits

The operator review pin remains `93ae7de9f529f252ecba13230369b404a663ef04` until separately updated. No deployment or running service modification has occurred.
