# Standalone implementation status · 2026-10-02

This active v0.6.1 tranche adds the integrated custom-image library to the recorded functional-authoring, personal-space, local-resident and deployment-configuration checkpoint. Full Universe source parity remains unfinished. Passing focused tests does not certify a whole source contract or replace user play review.

## Current framing increment

Perspective side-panel framing preserves full-canvas picking and sticky manual camera ownership. Measured side-panel/HUD rectangles select usable view space; only explicit resident focus takes camera control. This increment passes 410 CPU/API tests and 29 scoped browser checks locally. `FRAMING.md` records fixture and UI-overlap limits. Remote CI is pending for this exact revision.

## Integrated now

- Room-authorized PNG upload/search/reuse, immutable pinned versions, native floor/upright panels, alpha-aware picking, shared painted collision/full edit footprints and explicit resource/error lifecycle

- Original native3D character creator, durable appearance, correct world-facing animation and live portraits
- Camera-relative movement, normalized diagonals, manual Shift2.5×, orbit/tilt/zoom/pan/follow, pointer and separated multitouch gestures
- Direct snapped valid/blocked building ghost, select/drag/rotate/erase/duplicate, keyboard manipulation, undo/redo, conflict and draft recovery
- Ordered item and area actions: messages, links/downloads, external panels, volume/loop audio, explicit room travel; canonical committed actions reauthorized at execution
- Native audio pause/resume/mute/user volume/retry, and resource cleanup on deletion, area exit and room changes
- Sandboxed HTTPS panels with explicit Return to world and persistent new-tab fallback; iframe load alone is never provider-success evidence
- Atomic personal-space claims/transfers, static assignment/revoke, world-local tag eligibility, current-room desk route and server-enforced full old/new object footprints without granting room-wide editor rights
- Real resident configuration, native3D preview/handles, ordered patrols, occupancy-owned lifecycle, collision-aware navigation and permission-checked local pause/resume/return controls; residents remain separate from human social/media/quest graphs
- Local authenticated hierarchy, scoped membership/invitations, durable room chat/DMs, ephemeral Express, documents and authored quest slices retained
- Source game598/Orbit236 ink tokens, rounded source SVGs, semantic place colors and role-specific fonts; exact full logo and independent keyboard focus ring preserved
- Public-mode exact Host/Origin/TLS-cookie configuration, login-only admission, offline owner/reviewer provisioning and isolated Node24 container files

New resident drafts never create entities on dismissal; explicit Create commits them. Drafts stay in the current tab/actor/room until created, discarded, reloaded or signed out. Existing-record edits retain save-on-close behavior.

Resident social/private-instruction settings are stored but inactive without a real provider. No AI conversation, external MCP call or external tool result is fabricated.

## Current verification boundary

The frozen v0.6 source401ae7c4…056e7 passed324 unit/API tests, syntax/build/package/container-file checks and all13 serial browser suites (3 image,6 core,4 authoring), with an exact261-file source comparison. The image suite includes final320px native-touch behavior and nonoverlapping Build heading/status.

A subsequent actual DPR2 regression exposed a pre-existing ray-input double-scaling bug despite those DPR1 checks. The focused renderer fix now passes6 actual native mouse/touch scenarios: exact chair selection before/after camera orbit, projected image ghost coordinates, opaque selection and transparent pass-through. Measured framebuffer ratios match the real DPR2 hardware scale, including raster rounding. Tested bundle `8c0d91282d59b7f17079ec227762b178213369cb2a380b728b0cd69a1b5fb3a5`; CSS remains `9ffd241303c102e9c65202b4fe31f5aa1893ee57c13256ad71a478a132b18c79`. Test-harness attempts that encountered deliberately unobscured-point guards remain recorded; they are not hidden product exceptions. The core command now includes this DPR regression. Counts overlap and do not certify whole source parity.

The subsequent Silent correction passes396 aggregate unit/API checks and four media suites: controlled DOM, native permission-denial/lifecycle, authenticated native SDP/teardown, and actual-world walk-in/exit through overlapping Silent/meeting areas. It invalidates pending devices on denial and rejects stale HTTP responses after a newer pushed policy. Incoming calls are blocked; room text chat and ambient item audio remain separate. Final bundle `d43d098708afdcc272e4743a8603b751143161066b868495aa4f25e875e284a9` passes final copy/layout/world behavior and package/container-file checks. No successful AV packets, provider or physical-device claim follows from SDP negotiation. Full cross-SSE/session policy revision ordering is still a documented protocol limitation, not silently declared solved.

Reproduce with `npm run test:browser`, `npm run test:browser:authoring` and `npm run test:browser:images` and `npm run test:browser:media`; isolated module checks use `npm run test:browser:modules`. `npm run verify:container-files` simulates declared Dockerfile source boundaries and dependency-free startup, not actual Docker. Browser tests use Chromium software WebGL and touch emulation; physical phones, real cross-network media, live reverse proxy and production load remain unverified. Publication/CI of newer source must be verified by exact commit.

## Prior immutable quality checkpoint

The earlier quality checkpoint and v0.3 hierarchy evidence remain unchanged. Their walkthrough/independent review certify only their recorded source snapshots. This tranche preserves the later second-client readiness and stable command-palette DOM fixes from the published green quality branch.

## Remaining acceptance gates

- External AI provider, tool/MCP/OAuth permissions, memory and source bot conversational/lifecycle contracts beyond the local resident slice
- Successful real AV packets, existing LiveKit/TURN/broadcast adapter, physical devices and network handover
- Operator-run Docker/TLS/proxy, resource and disk quotas, consistent backup/restore and isolated deployment
- Matrix/E2EE/federation, SSO, external integrations, upstream owned-avatar catalogs and full quest programs
- Image definition editing/replacement/archive/delete, collection import, expandable persistent room chunks, reusable composite asset workshop, terrain tools and creator-made social game logic
- Positions remain bounded client reports, not authoritative physics or hardened anti-cheat
- Local original wardrobe and room-scoped file access do not imply upstream entitlement or all area-tag file semantics

See `CUSTOM-IMAGES.md`, `IMAGE-LIBRARY-CONTRACT.md`, `ACTION-AUTHORING.md`, `server/PERSONAL-AREAS.md`, `server/BOTS.md`, `BRAND-PORT.md` and `DEV-PREVIEW-OPERATOR.md` for implemented contracts and limitations. No deployment has occurred.

The focused Silent freshness correction adds 39 controlled regressions (396 aggregate tests), immediate deny-only committed geometry, bounded 8-second policy GETs and current-ownership checks around delayed transport work. Five media browser suites and build/startup/container checks pass locally. Full exact-revision remote CI remains pending; external packets and physical devices remain unverified.
