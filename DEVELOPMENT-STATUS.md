# Development status · 2026-10-02 11:54 UTC

This is a work-in-progress source checkpoint. It is not deployed and is not a full-parity replacement. The latest fixes are published in small reviewable work-branch commits; each commit's CI is authoritative for that revision.

## Built and locally exercised

| Workstream | Boundary | Current evidence |
|---|---|---|
| Play/character quality | Renderer, input, native appearance and direct builder | Core fallback/camera/build/avatar/layout flows passed; Express passed its corrected targeted rerun |
| Functional authoring | Shared action schema, scene validation, canonical action resolver, audio/panel lifecycle | 205 aggregate unit/API tests include these paths; 9 actual-world action checks passed |
| Personal spaces | Server-owned claims/revisions and scoped scene commits; client controls and desk routing | Authority/module tests passed; 9 actual-world checks passed |
| Local residents | Dedicated resident store/runtime, separate SSE list, editor/3D handles | Server/module tests passed; 8 final actual-world checks and 21 editor DOM checks passed, including explicit Create only |
| Source visual port | Shared tokens/SVG/font roles with stable accessible markup | Focused visual/DOM checks and the final 48px creator layout regression passed |
| Deployment configuration | Exact Host/Origin/TLS policy, offline accounts, Node24 files/volume contract | Unit/HTTP and staged file-boundary/startup checks passed; Docker/proxy/live deployment unrun |

The current tested bundle is `bdcd43aa59fbc3ec84020e1019fdd6ebacd126c33a916a41067f993c8e5be9e0`. Earlier combined action/personal checks used bundle `973a5845d612e611cdb127ab4ac6cd14738acd55612cd476bae86ba7d1214e26`; the later changes affect new-resident draft dismissal/identity and the creator touch-target CSS. Both have now passed their final actual-browser regressions. The final aggregate still passes 205 unit/API tests. `CHECKPOINT-STATUS.md` preserves the earlier pending state at publication freeze. Express initially hit a fixed-100ms software-render timing assumption; its focused test correction waits for observed camera yaw and the same real bubble displacement after a native click. All five Express checks then passed. The complete authoring group now passes against the final bundle: four suites and 29 focused checks, with no page exceptions. Remote CI remains pending. No previous green CI is being reused as proof of a newer revision.

## Integration checks

Changes to shared app entry points, action schemas, permissions, or room/session lifecycle need regression coverage across affected features. Run full software-WebGL suites serially to avoid graphics resource contention. Tests should verify actual operations rather than treating a visible panel as a working feature.

## Next and blocked

1. Verify remote CI for the published revision; publish any corrections as focused follow-up commits
2. Hand the exact reviewed revision and operator checklist to the existing dev operator for an isolated preview; actual container/TLS/network/credential actions require the appropriate operator approval
3. In progress as an isolated code lane: implement and locally protocol-test the existing LiveKit/TURN adapter boundary: scoped admission, publish/subscribe roles, removal and lifecycle cleanup. Real credentials, provider isolation and cross-network packets remain gates
4. In progress as an isolated code lane: extend resident provider/tool adapters with real local protocol tests, explicit permissions and safe failure behavior. No connected AI/MCP response is claimed today
5. Source review is specifying the missing EDIT-06/09 custom image/object library slice, with one shared asset/footprint contract across rendering, picking, placement, movement and scoped permissions. This is not yet implemented; source terrain authoring is a separate unfinished target

Source parity gaps include Matrix/E2EE/federation, SSO, provider/bot conversation and tool contracts, full quest programs, upstream owned-avatar entitlements, persistent chunks and creator asset/game-logic workflows. Physical-phone performance, real AV, operator backup/restore and production capacity are not yet certified.
