# Development status · 2026-10-02 15:31 UTC

This is the v0.6 custom-image work-in-progress source checkpoint. It is not deployed and is not a full-parity replacement. Publication and CI status must be checked against the exact work-branch commit; no prior green CI is reused for this newer source.

## Built and locally checked

| Workstream | Implemented boundary | Evidence at this freeze |
|---|---|---|
| Custom image assets | Complete PNG validation, immutable room definitions/versions, authenticated bytes, operation receipts, quotas | Shared/schema/storage/HTTP checks included in 324 passing unit/API tests |
| Image building/rendering | Shared geometry, canonical full-footprint edit rights, painted human/bot collision cells, transparent picking, native texture lifecycle, direct manipulation | Actual desktop flow passed upload/search/place/drag/rotate/duplicate/save/reload, byte identity, alpha/depth, uncertainty/retry and painted-cell movement |
| Mobile image flow | Original brand ratio, bounded header, native scrollable dock, 48px library/grid controls, native touch placement | Final320px flow and Build heading/status separation passed |
| Existing quality/authoring | Native3D characters, camera, direct builder, Express, hierarchy, personal spaces, local residents and functional actions | All13 image/core/authoring suites passed on frozen v0.6 source401ae7c4; a subsequent DPR2 correction additionally passes6 actual mouse/touch cases |
| Deployment configuration | Exact Host/Origin/TLS policy, offline accounts, Node24 files and persistent-volume contract | Syntax/build/package startup and container-file-boundary simulation pass; actual Docker/proxy/deployment unrun |

The latest focused DPR2 main bundle is `8c0d91282d59b7f17079ec227762b178213369cb2a380b728b0cd69a1b5fb3a5`; final CSS is `9ffd241303c102e9c65202b4fe31f5aa1893ee57c13256ad71a478a132b18c79`. All13 suites passed against immutable v0.6 source401ae7c4…056e7 with exact261-file comparison. A later actual DPR2 test reproduced a native chair click missing its visible target. The focused picker correction applies Babylon hardware scaling exactly once; six native mouse/touch scenarios now pass at measured DPR2, including camera orbit, image alpha and ghost coordinates. The new DPR regression is included in the core command. No physical-device claim is made. These counts overlap and are not feature completion totals.

## Integration boundary

The custom-image checkpoint and focused DPR correction are exported together. Runtime source matches the tested snapshots; public documentation retains the existing generic operator examples and source-distribution exclusions.

Live media and external resident providers remain acceptance gates. They require deployed-version compatibility, scoped authorization and revocation checks, explicit model/tool permissions and real packet/provider tests. This checkpoint includes no configured external credentials or live-service verification.

CI runs each existing browser group (core, authoring and images) serially on its own runner after the shared verification job. This keeps software-WebGL suites from contending on one GPU and gives each group a bounded timeout.

## Publication and next checks

This update is prepared for `work/native-3d-avatars`; remote CI for its exact commit is pending. The prior authoring checkpoint `957c5286646cd107f38340a35a11e2c013aafb07` passed remote CI. The operator handoff remains pinned to that reviewed revision until a separate review selects a newer one; this source update does not change that deployment choice.

1. Verify remote CI for this image-plus-DPR source revision
2. Complete operator-run Docker/TLS/proxy/storage checks for any separately selected preview revision
3. Add asset lifecycle editing/archive/delete with atomic reference handling; current creation and placement do not include those controls
4. Review further camera framing, media semantics and resident-provider changes separately; they are not included here

Remaining broader parity includes real AV and AI/MCP/provider integration, Matrix/E2EE/federation, SSO, full quest programs, upstream owned-avatar entitlements, persistent chunks, composite asset workshop, terrain and creator game logic. Physical-phone performance, backup/restore and production capacity remain unverified.
