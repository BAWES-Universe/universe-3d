# Work-branch checkpoint · 2026-10-02 11:36 UTC

This snapshot is being published for visible review while its final browser reruns are still in progress. It is not marked deployed, ready for public release, or full Universe parity.

Implemented scope: ordered functional actions/audio/embed lifecycle, personal spaces/scoped building, native3D resident authoring and local patrol, source-audited ink/SVG chrome, public-preview hosting configuration and offline account provisioning. Version0.5.0. See `IMPLEMENTATION-STATUS.md` and `DEV-PREVIEW-OPERATOR.md`.

## Evidence available at publication freeze

- 205 unit/API tests passed, syntax/build/package startup passed
- Dockerfile COPY-stage build and dependency-free runtime startup passed; no actual Docker run
- Actual full-world actions9/9 and personal spaces9/9 passed on bundle `973a5845d612e611cdb127ab4ac6cd14738acd55612cd476bae86ba7d1214e26`
- Native resident drag/release/cancel/persistence5/5 passed on that same earlier bundle
- New-draft dismissal correction passes21 DOM/protocol checks: no implicit Create, same-room recovery, actor separation, fresh permission check and exact-receipt deliberate retry
- Core fallback, camera, direct building and avatar persistence passed the preceding run; Express separately passed5/5

## Final reruns pending at this freeze

Current bundle is `bdcd43aa59fbc3ec84020e1019fdd6ebacd126c33a916a41067f993c8e5be9e0`. It adds the explicit-new-resident Create lifecycle/actor hook and fixes a48px touch-preset specificity regression discovered by the core layout test. The native-world close/reopen/Create regression and final full core run are still pending at this timestamp. Final CI for this source is also pending. The previous quality-only commit's green CI does not cover this snapshot.

The earlier direct-building test had an obsolete Text locator after the field became Message text; its exact behavior/assertions passed after updating the selector. The real native Audio Retry bug was repaired and its full-world test passed. No known failing product behavior is being concealed as a passing check; the outstanding runs above remain unverified until their results are recorded.

No existing Universe dev service, credentials, routes or infrastructure were changed. External AI/MCP connections and the existing LiveKit/TURN adapter remain unfinished. Physical devices, live TLS/proxy, real media packets and production capacity are separate gates.
