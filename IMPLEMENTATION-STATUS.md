# Standalone implementation status · 2026-10-02

This active tranche adds functional authoring, personal spaces, locally configured residents, deployment configuration and a source-audited chrome port to the earlier play-quality checkpoint. Full Universe source parity remains unfinished. Passing focused tests does not certify a whole source contract or replace user play review.

## Integrated now

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

The current source passes205 unit/API tests, syntax checks, build and package startup. Focused module checks cover action authoring, personal authority/UI, resident authority/UI, source token/icon roles and lifecycle behavior. Separate actual full-world runs pass resident creation/save/reload, nine action scenarios, nine personal-space scenarios and five native resident-handle scenarios, with no page exceptions. The latter verifies actual home/waypoint drags, release-only commits, Escape cancellation and saved ordered-route reload on browser bundle SHA-256 `973a5845d612e611cdb127ab4ac6cd14738acd55612cd476bae86ba7d1214e26`. These counts overlap and are not feature-completion totals. Final bundle `bdcd43aa59fbc3ec84020e1019fdd6ebacd126c33a916a41067f993c8e5be9e0` now passes all four actual-authoring suites (29 focused checks). Core fallback/camera/build/avatar/layout pass; Express passes all five checks after replacing its fixed 100ms test delay with observed camera/bubble state. Raw failed timing attempts are retained. New-draft editor lifecycle additionally passes 21 DOM/protocol checks. Remote CI remains pending for this revision.

Native audio503 failure recovery was initially broken in the full-world test. The corrected Retry reloads the failed native source, reauthorizes the action and now passes the same actual-browser scenario. Scoped object-footprint checks were corrected to match rendered geometry rather than trusting an inert scale field.

Reproduce core quality checks with `npm run test:browser`, current actual authoring flows with `npm run test:browser:authoring`, and isolated fixture/media checks with `npm run test:browser:modules`. `npm run verify:container-files` tests Dockerfile source-file boundaries and dependency-free runtime startup; it does not run Docker.

Browser tests use Chromium software WebGL and touch emulation. Physical iPhone/Android GPUs, cross-network real media, production load and a live reverse proxy remain unverified. The latest published quality-only commit60fcfc6705b0cc7760dc9f130f904a3ba76c81a3 has green remote CI; that result does not automatically cover this newer tranche until publication and its own CI finish.

## Prior immutable quality checkpoint

The earlier quality checkpoint and v0.3 hierarchy evidence remain unchanged. Their walkthrough/independent review certify only their recorded source snapshots. This tranche preserves the later second-client readiness and stable command-palette DOM fixes from the published green quality branch.

## Remaining acceptance gates

- External AI provider, tool/MCP/OAuth permissions, memory and source bot conversational/lifecycle contracts beyond the local resident slice
- Successful real AV packets, existing LiveKit/TURN/broadcast adapter, physical devices and network handover
- Operator-run Docker/TLS/proxy, resource and disk quotas, consistent backup/restore and isolated deployment
- Matrix/E2EE/federation, SSO, external integrations, upstream owned-avatar catalogs and full quest programs
- Expandable persistent room chunks, reusable composite asset workshop/textures, terrain tools and creator-made social game logic
- Positions remain bounded client reports, not authoritative physics or hardened anti-cheat
- Local original wardrobe and room-scoped file access do not imply upstream entitlement or all area-tag file semantics

See `ACTION-AUTHORING.md`, `server/PERSONAL-AREAS.md`, `server/BOTS.md`, `BRAND-PORT.md` and `DEV-PREVIEW-OPERATOR.md` for implemented contracts and limitations. No deployment has occurred.
