# Development status · 2026-10-02 17:38 UTC

This increment adds a durable manager-only resident test protocol and deliberate private Test controls on framing commit `3ea185d805bcd706cbd732dbeb55bcc712b09bdb`. The normal app still has no model provider configured. Explicit local-loopback fixtures verify the real protocol, authority and saved command path; no external AI, MCP, credentials or deployment is claimed. See `server/RESIDENT-TURNS.md`.

Current tested main bundle: `717eb58ed91f884240d235098a935ccd42e0f3be73b2483ed7af25c7ab014d6c`; CSS: `245cfec2a2f26beb7973dce3351a87f346e9fce93deb2046fba5e92bf35c6c9e`.

Fresh integrated checks: 488 CPU/API tests pass; one historical compatibility fixture is explicitly skipped because its old adapter is absent. Seven GPU-free UI cases and six actual-game cases pass, covering deliberate creation, saved model permission, private reply/command, exact lost-response replay, focus preservation, reload and native touch at 320px/200% root text. Nine existing resident authoring checks also pass with the new UI. Build, syntax and package startup pass. Existing core/image/media checks remain tied to their recorded revisions until exact-head CI runs for this increment. Counts overlap; none is a whole-feature parity certification.

Tests become available only for a saved, enabled, clean resident with Respond to players on, a trusted server adapter and current management rights. Model permissions default off independently of manual tools. Read-only receipt polling is bounded; POST is never retried automatically. Restarted or unknown work is never regenerated. Cancellation cannot undo an already accepted command. Public resident conversation remains unconnected.

No running service is changed. The operator review pin remains `93ae7de9f529f252ecba13230369b404a663ef04` until separately updated. Publication/CI status must be checked against the exact new commit; prior green CI does not certify this work tree.

## Earlier feature verification

| Workstream | Implemented boundary | Evidence at this freeze |
|---|---|---|
| Custom image assets | Complete PNG validation, immutable room definitions/versions, authenticated bytes, operation receipts, quotas | Shared/schema/storage/HTTP checks included in 324 passing unit/API tests |
| Image building/rendering | Shared geometry, canonical full-footprint edit rights, painted human/bot collision cells, transparent picking, native texture lifecycle, direct manipulation | Actual desktop flow passed upload/search/place/drag/rotate/duplicate/save/reload, byte identity, alpha/depth, uncertainty/retry and painted-cell movement |
| Mobile image flow | Original brand ratio, bounded header, native scrollable dock, 48px library/grid controls, native touch placement | Final320px flow and Build heading/status separation passed |
| Silent media lifecycle | Immediate committed-geometry denial, bounded policy freshness, pending capture invalidation and call-only controls | 396 aggregate unit/API checks, including 39 freshness regressions; 5 media suites pass, including actual-world walk-in/exit and native authenticated SDP teardown. No real media packet claim |
| Existing quality/authoring | Native3D characters, camera, direct builder, Express, hierarchy, personal spaces, local residents and functional actions | All13 image/core/authoring suites passed on frozen v0.6 source401ae7c4; a subsequent DPR2 correction additionally passes6 actual mouse/touch cases |
| Deployment configuration | Exact Host/Origin/TLS policy, offline accounts, Node24 files and persistent-volume contract | Syntax/build/package startup and container-file-boundary simulation pass; actual Docker/proxy/deployment unrun |

The earlier Silent follow-up main bundle was `9e43d3e98d837a6eebacbe649d00888d2fc85660a7fc741c78b2376fdc1c0fdb`; final CSS is `9ffd241303c102e9c65202b4fe31f5aa1893ee57c13256ad71a478a132b18c79`. All13 suites passed against immutable v0.6 source401ae7c4…056e7 with exact261-file comparison. A later actual DPR2 test reproduced a native chair click missing its visible target. The focused picker correction applies Babylon hardware scaling exactly once; six native mouse/touch scenarios now pass at measured DPR2, including camera orbit, image alpha and ghost coordinates. The new DPR regression is included in the core command. The DPR scenarios also passed after initial Silent integration on e642b5d4; the final call-only copy adjustment passed the full media group. No physical-device claim is made. These counts overlap and are not feature completion totals.

The focused freshness correction passes 396 CPU/API tests, all five media browser suites, 166-file syntax, build, 91-file static/package and container-file checks. The 39 focused regressions were also run against the earlier control: 37 failed and two passed, demonstrating coverage of the corrected behavior. Actual-world held-policy checks use controlled fake tracks and verify immediate device stop and fresh-policy exit; they do not prove successful external media packets.

Received committed Silent geometry immediately stops active and acquired-pending devices and retires transport; editor drafts do not supply that guard. Policy GETs use an 8-second monotonic deadline and AbortSignal; overdue results fail closed after event-loop resumption. Exit requires a new authoritative GET and never automatically resumes capture. Current actor/room/peer checks guard delayed SDP/track work. Received geometry and existing context fields do not establish a new server-boot or cross-SSE/session policy revision protocol.

## Publication and verification boundary

The prior Silent lifecycle follow-up was based on the green image/DPR checkpoint `93ae7de9f529f252ecba13230369b404a663ef04`. That Silent source passed remote CI at `40bf07b51b3e9c7441b796dfa673139fa8c9fe4d`; its results are scoped to that revision.

CI runs core, authoring, images, media, framing and residents as separate serial groups on independent runners. No checks are removed. Live audio/video packet behavior, cross-stream/session authoritative policy ordering and physical devices remain unverified.

## Next checks

1. Verify the exact work-branch commit and all CI jobs
2. Complete separately authorized container/TLS/proxy/storage and real-media acceptance before deployment or live-provider claims
3. Verify the new resident increment remotely; external provider compatibility remains a separate rollout
4. Add asset editing/archive/delete with atomic reference handling; current image creation and placement do not include those controls

Remaining broader parity includes real AV and AI/MCP/provider integration, Matrix/E2EE/federation, SSO, full quest programs, upstream owned-avatar entitlements, persistent chunks, composite asset workshop, terrain and creator game logic. Physical-phone performance, backup/restore and production capacity remain unverified.
