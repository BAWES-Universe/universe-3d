# Development status · 2026-10-02 16:25 UTC

This is the v0.6.1 image/media-lifecycle work-in-progress source checkpoint. It is not deployed and is not a full-parity replacement. Publication and CI status must be checked against the exact work-branch commit; no prior green CI is reused for this newer source.

## Built and locally checked

| Workstream | Implemented boundary | Evidence at this freeze |
|---|---|---|
| Custom image assets | Complete PNG validation, immutable room definitions/versions, authenticated bytes, operation receipts, quotas | Shared/schema/storage/HTTP checks included in 324 passing unit/API tests |
| Image building/rendering | Shared geometry, canonical full-footprint edit rights, painted human/bot collision cells, transparent picking, native texture lifecycle, direct manipulation | Actual desktop flow passed upload/search/place/drag/rotate/duplicate/save/reload, byte identity, alpha/depth, uncertainty/retry and painted-cell movement |
| Mobile image flow | Original brand ratio, bounded header, native scrollable dock, 48px library/grid controls, native touch placement | Final320px flow and Build heading/status separation passed |
| Silent media lifecycle | Immediate committed-geometry denial, bounded policy freshness, pending capture invalidation and call-only controls | 396 aggregate unit/API checks, including 39 freshness regressions; 5 media suites pass, including actual-world walk-in/exit and native authenticated SDP teardown. No real media packet claim |
| Existing quality/authoring | Native3D characters, camera, direct builder, Express, hierarchy, personal spaces, local residents and functional actions | All13 image/core/authoring suites passed on frozen v0.6 source401ae7c4; a subsequent DPR2 correction additionally passes6 actual mouse/touch cases |
| Deployment configuration | Exact Host/Origin/TLS policy, offline accounts, Node24 files and persistent-volume contract | Syntax/build/package startup and container-file-boundary simulation pass; actual Docker/proxy/deployment unrun |

The current Silent follow-up main bundle is `9e43d3e98d837a6eebacbe649d00888d2fc85660a7fc741c78b2376fdc1c0fdb`; final CSS is `9ffd241303c102e9c65202b4fe31f5aa1893ee57c13256ad71a478a132b18c79`. All13 suites passed against immutable v0.6 source401ae7c4…056e7 with exact261-file comparison. A later actual DPR2 test reproduced a native chair click missing its visible target. The focused picker correction applies Babylon hardware scaling exactly once; six native mouse/touch scenarios now pass at measured DPR2, including camera orbit, image alpha and ghost coordinates. The new DPR regression is included in the core command. The DPR scenarios also passed after initial Silent integration on e642b5d4; the final call-only copy adjustment passed the full media group. No physical-device claim is made. These counts overlap and are not feature completion totals.

The focused freshness correction passes 396 CPU/API tests, all five media browser suites, 166-file syntax, build, 91-file static/package and container-file checks. The 39 focused regressions were also run against the earlier control: 37 failed and two passed, demonstrating coverage of the corrected behavior. Actual-world held-policy checks use controlled fake tracks and verify immediate device stop and fresh-policy exit; they do not prove successful external media packets.

Received committed Silent geometry immediately stops active and acquired-pending devices and retires transport; editor drafts do not supply that guard. Policy GETs use an 8-second monotonic deadline and AbortSignal; overdue results fail closed after event-loop resumption. Exit requires a new authoritative GET and never automatically resumes capture. Current actor/room/peer checks guard delayed SDP/track work. Received geometry and existing context fields do not establish a new server-boot or cross-SSE/session policy revision protocol.

## Publication and verification boundary

This is the focused Silent lifecycle follow-up to the green image/DPR checkpoint `93ae7de9f529f252ecba13230369b404a663ef04`. It adds no later camera-framing or resident-provider changes. Remote CI for this exact newer source remains pending; the prior green run does not certify it.

CI retains separate serial core, authoring and image groups and adds the five media suites on an independent runner. No checks are removed. Live audio/video packet behavior, cross-stream/session authoritative policy ordering and physical devices remain unverified.

Deployment revision selection remains separate from source publication. The requested operator review remains pinned to `93ae7de9f529f252ecba13230369b404a663ef04` until a separate review chooses a newer revision. This update does not change a running service or configure provider credentials.

## Next checks

1. Verify the exact work-branch commit and all CI jobs
2. Complete separately authorized container/TLS/proxy/storage and real-media acceptance before deployment or live-provider claims
3. Review the queued camera-framing and resident-provider changes as independent increments
4. Add asset editing/archive/delete with atomic reference handling; current image creation and placement do not include those controls

Remaining broader parity includes real AV and AI/MCP/provider integration, Matrix/E2EE/federation, SSO, full quest programs, upstream owned-avatar entitlements, persistent chunks, composite asset workshop, terrain and creator game logic. Physical-phone performance, backup/restore and production capacity remain unverified.
