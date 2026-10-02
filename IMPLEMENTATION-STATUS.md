# Current quality checkpoint · 2026-10-02

This branch addresses firsthand play feedback on movement, building, camera, expression and character quality. Full source parity remains a larger unfinished goal; passing tests are not a substitute for a satisfying experience or a whole-contract certification.

## Integrated changes

- Camera-relative accelerated movement, normalized diagonals and source-equivalent manual Shift2.5×; fixed-step collision avoids frame-rate-dependent slowdown
- Freely orbitable/tiltable/zoomable/pannable follow camera with keyboard, pointer and separated multitouch gestures
- Direct snapped placement ghost, valid/blocked footprint, pointer select/drag, visible rotate, erase/duplicate, undo/redo and keyboard manipulation
- Original procedural textured environment, shadows, coherent stone/wood/fabric/foliage and HUD-aware world labels
- Actual native3D body/clothing/accessory creator, articulated idle/walk/fast-walk, world-facing orientation, durable validated appearance and native portrait updates
- Source Enter/Ctrl+Enter Say/Think behavior, ephemeral world bubbles/reactions, direct section shortcuts and searchable Cmd/CtrlK actions/people/places
- Exact unmodified full BAWES Universe logo, preserved2:1 aspect and separate tagline

## Current verification

On the frozen application source, syntax, build, package startup and127 unit/API/persistence tests pass. The serial core browser run passes its five full-shell suites (fallback, camera, direct building, native appearance and Express), followed by the final320px creator/onboarding regression. An independent source-hashed review passes ten focused actual-input scenarios. The45.52-second walkthrough records actual keyboard/pointer controls with no injected scene changes and no page exceptions. The final layout-only creator trim is separately covered by the320px touch Save test. These suites overlap; their counts are not feature totals or full-parity percentages.

Browser coverage uses Chromium with software WebGL. No physical iPhone/Android GPU, real multi-network media or high-concurrency production capacity has been certified. Narrow fixture tests, native browser tests and actual authenticated full-shell tests are different evidence and are labeled accordingly.

Core checks are reproducible with `npm run test:browser`; separate module/media lifecycle probes use `npm run test:browser:modules`. CI configuration runs the same local checks but its remote status is unknown until the exact commit executes. No current claim is made that old historical scripts automatically pass the redesigned UI.

## Prior checkpoint

The immutable v0.3 checkpoint and `V03-STATUS.md` retain the earlier hierarchy/backend evidence. Its original visual-quality claims do not certify this redesigned client. The real service behavior, room/world ownership and restrictive migration policies remain part of the implementation and need regression coverage alongside UI changes.

## Open acceptance gates

- Complete source parity remains unfinished: Matrix, SSO, external providers, bots/AI/MCP, owned-avatar entitlement catalogs, full quest programs and parts of source admin/workflows
- Successful real AV packets, SFU/TURN/broadcast adapters and physical-device/network tests
- Hosting threat review, TLS/origin/cookie configuration, operational quotas/backups/restore and operator-approved isolated deployment
- Expandable persistent chunks, composite asset workshop/textures, terrain authoring and optional creator-made social game logic remain planned directions, not delivered controls
- Character appearance is server-validated; player physics remains client-reported with bounds checking, not hardened server anti-cheat
- The current free original wardrobe does not migrate upstream paid/custom asset ownership

The next implementation decision should follow the user's play review of this quality checkpoint and the remaining source-backed parity priorities. No new breadth tranche is being represented as complete because a panel exists.
