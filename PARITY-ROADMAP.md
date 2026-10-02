# Universe source parity roadmap

## Audit boundary

This is an incremental inventory of source obligations, not a completed feature census. The durable machine-readable map is [PARITY-INVENTORY.json](PARITY-INVENTORY.json), schema 2.0.0, revision 4. Stable new IDs are retained as the map grows. Historical labels appear only where surviving repository documentation explicitly supplies them; missing old inventory rows and totals are not reconstructed from memory.

Candidate: [universe-3d `be6d136961010f986fde7c1ddaf13b66e164621a`](https://github.com/BAWES-Universe/universe-3d/tree/be6d136961010f986fde7c1ddaf13b66e164621a). Its [exact-head CI run](https://github.com/BAWES-Universe/universe-3d/actions/runs/37050686201) is completed successfully. The existing status document's CI-pending statement is superseded only for that revision. No app runtime tests were run for this documentation change. CI groups, document counts and test totals do not measure feature completion.

Source baseline: [game `bae18306bdfa63e58cd4124b1a3b5b290b61c286`](https://github.com/BAWES-Universe/workadventure-universe/tree/bae18306bdfa63e58cd4124b1a3b5b290b61c286) and [admin `c2053a56fa0cd89001cdb1b83c469281a672a9ef`](https://github.com/BAWES-Universe/workadventure-universe-admin/tree/c2053a56fa0cd89001cdb1b83c469281a672a9ef). The admin repository name is grounded in ASSETS.md and a successful exact-pin tree read. Media `0e1ff05014d4b871ffd94eea744e40c1d1c7df79` is a separate runtime variant, not silently treated as this default. PRs 598/599/606/608 are independently verified merged into a separate batch; their exact base/head/merge pins are recorded without assuming default inclusion or deployment. Marketing claims are also a separate evidence class.

Current mapping: 145 stable requirement groups; all81 captured game docs/ files have a scope review (80 cited for contract clauses, one developer diagram guide classified scope-only). **Zero whole-contract certifications.** Status counts (blocked: 11, missing: 68, needs-review: 23, partial: 43) describe this incomplete map only. A scoped document read is not a full example/signature/runtime audit.

## Already grounded, with remaining gaps

- Editor, objects and assets: placement/actions and protected PNG definitions have local evidence. Source metadata editing and remove-definition-plus-placed-instances remain absent at this baseline. Separate editing/archive work is not counted delivered. Archive-preserves-pins is not source deletion parity.
- Areas and personal spaces: scoped claims/assignment and old/new object footprint checks have narrow local assertions. Local remove-owned differs from source geometric removal. General restricted-area read/edit tags, away-owner visit cards and named starts need more work.
- Chat: source proximity text is ephemeral and current-bubble-only. Matrix rooms are persistent/federated, with independent invitation/history/E2EE/area-membership rules. Existing local DMs, room chat and Express cannot be certified as these contracts.
- Media and streaming: Silent policy and optional ICE transport setup have scoped tests. The cap-four opted-in graph remains. Neither SDP nor camera controls prove AV, relay allocation, SFU transitions, podium streams or cross-room megaphone.
- Bots/tools/MCP: resident configuration and navigation are local features. Private tests use a synthetic loopback protocol. Real provider conversation, MCP discovery/session/auth/tool contracts and memory are unfinished or need source review.
- Worlds, access, quest proposals, navigation, profile, admin, localization, mobile, accessibility and map scripting/import now have source-linked groups where inspected; remaining runtime and candidate proof gaps are explicit.

## Bounded next increments

1. **Runtime reconciliation:** finish admin/game route, model and UI review behind the already captured contracts, prioritizing identity, permissions, bots, provider lifecycle and media handoff. Keep plans distinct from runtime.
2. **Unreviewed source:** the captured docs/ scope census is now closed; prioritize high-signal runtime/extra docs and resolve contradictions before implementation. Quest feature-branch code remains distinct from open proposal snapshots.
3. **Media acceptance:** reconcile per-file identity across independent/default pins, then complete same-name meetings, Silent overlap, P2P/SFU handoff, screen/broadcast and teardown. Source defaults and model tests do not establish deployment or successful AV.
4. **Contract depth:** refine the reviewed collection/Tiled/scripting/localization/OIDC summaries into per-method signatures and edge cases as implementation work needs them. Cited prose review is not full API conformance.
5. **Evidence tightening:** identify exact tests/assertions and boundary counterexamples for each clause. Add browser/provider/device/operator acceptance only where it actually occurred. Do not promote a whole group because a nearby test passes.
6. **Interaction acceptance:** after source mapping, separately inspect physical/mobile input, keyboard/focus/assistive access, provider-backed behavior and deployment. Existing emulation is explicitly limited.

## Update rules

Every new row needs a stable ID, source class and immutable references, acceptance clauses, current candidate code/test evidence, remaining gaps and one of partial/missing/blocked/needs-review. A placeholder must say that the source is unreviewed rather than invent acceptance details. Keep source captures outside this repository; only sanitized summaries, contracts, hashes and links belong here. No credentials, operator addresses or deployment-specific configuration are part of this map. The map must not block independent app improvements.

## Unresolved decisions and contradictions

- **C-ASSET-DELETE**: Source removal deletes placed instances; proposed archive preserves pinned placements. Separate features, not parity.
- **C-PERSONAL-REVOKE**: Local remove-owned is narrower than source geometric remove-entities behavior.
- **C-MEDIA-GRAPH**: Current cap-four opt-in graph differs from intended hybrid/all-member model; independent runtime needs exact variant reconciliation.
- **C-MCP-VERSION**: Pinned docs link a newer transport spec but initialize with older protocolVersion; runtime must resolve.
- **C-SAAS**: Personal away-card documentation excludes self-hosted edition; decide intended product edition before declaring a requirement absent.
- **C-STATUS-CI**: Development status says exact-head CI pending, but run 37050686201 now confirms success for candidate. This does not update deployment or test scope.

## Revision 2: admin and runtime reconciliation

The admin workflow, membership, avatar and provider/operations contracts now have source-linked groups. Room-create authorization is resolved from the exact pinned route: owner or world admin. The source workflow table's editor-create claim is stale; the app's narrower rule matches inspected runtime. Other admin endpoints remain partially reviewed.

The default game's Group source confirms all-member capacity and distinct following/center/lock state; configured limits and actual media transitions remain open. The MCP runtime supersedes its short doc on timeout (ninety seconds), fixed-from-initialization session TTL and OAuth support. Its network-failure retry assumption needs independent side-effect safety review. No external provider was connected.

Bot behavior docs now identify patrol, active-player engagement, social approach/status/cooldown, summon, home-region and user-list obligations. Old README/status claims are not treated as proof that provider work is absent upstream: actual provider files exist at the same pin. Native mobile wrapper/push requirements are separate from browser touch checks.

Source discovery found 94 Markdown files outside game docs/ and 46 admin Markdown files. Only the captured/reviewed subsets listed in the JSON are mapped; most runtime/UI, full quest programs, remaining game docs, independent media variants, localization/accessibility and website/proposal claims still need review. These totals measure source coverage only.
- **C-ROOM-CREATE-DOC**: Pinned admin workflow doc allows world editor creation; actual room POST requires universe owner or world admin. Current app matches the inspected runtime branch.
- **C-ADMIN-LOGIN**: Older guide describes pasted OIDC token and seven-day cookie; workflow doc describes opaque v2 in-game handshake. Session helper alone does not resolve the complete login lifecycle.
- **C-MCP-TIMEOUT**: Developer doc says ten-second requests; exact pinned MCP runtime uses ninety seconds.
- **C-MCP-TTL**: Developer doc says one hour inactivity; runtime compares initialization time plus one hour.
- **C-MCP-RETRY**: Runtime comments assume HTTP/network failure proves non-delivery before retrying. That assumption can duplicate non-idempotent side effects; requires separate safety review, not blind parity copying.
- **C-BOT-STATUS**: Bot README/STATUS still call AI integration planned despite provider/MCP implementation files at the same pin. Treat status prose as historical claims and inspect runtime.
- **C-AVATAR-STATUS**: Avatar guide describes management UI but later calls it scaffolded; commercial entitlement subjects and bot archival safety are explicitly unimplemented there. Runtime resolution pending.
- **C-TEMPLATE-STATUS**: Template status marks features complete while migrations/test steps and real seed URLs remain outstanding. It is not deployment proof.

## Schema 2.0 migration

Requirement IDs, clauses, statuses and certification flags are unchanged by normalization. Each source ID identifies repository + exact pin + path; each candidate evidence ID identifies repository + exact candidate revision + path. `source_refs` and candidate links resolve through the `sources` and `candidate_evidence` registries. File line ranges and assertion scopes stay on the referencing requirement. Future source or app revisions create new identities, never silently retarget older proof. Run `node scripts/validate-parity.mjs` and `node --test tests/parity-inventory.test.mjs` for dependency-free referential/schema checks.

## Revision 3: compatibility, proposals and runtime boundaries

- Added scripting, imported-map/collection, OIDC, localization, apps and external Matrix-client obligations. Similar native controls do not implement the WA scripting API. Default Calendar/To-do stores are unpopulated and disabled, so they are conditional integration scope.
- Quest epic508 and its8 scoped engine/outbox/welcome/authoring/partner issues are timestamped proposal snapshots with body hashes. They are not pinned-default runtime. Current local Meet uses reciprocal waves; the proposal requires reciprocal conversation messages. General no-code programs, guest merge-once, public-cap badges, host/giver inheritance and partners remain open. The epic explicitly drops WA quest-script compatibility and the room-token adapter; it defers several gaming features and requires retention review before engine release.
- Exact separate media source confirms all-member count, distinct capacity/transport thresholds and delayed LiveKit fallback. It also exposes a cached-promise renewal defect; the native adapter deliberately uses its own corrected lifecycle rather than copying that behavior. No deployed media revision or working AV is established.
- PR606/608 were already merged when checked, alongside598/599. Their captured accessibility/live-state slices remain separate from the default baseline. The schema keeps every variant and candidate evidence revision immutable.
- Older admin login guidance is resolved against opaque-v2-only runtime. Matrix re-entry history/world-space design and old Tiled object-layer guidance remain contradictions requiring runtime review.

The next audit should prioritize remaining runtime/implementation decisions rather than counting more documents: full bot/tool authorization and media handoff, actual candidate assertion mapping, quest branch implementation state, localized/accessible play, and source website claims.
- **C-QUEST-WAVE**: Standalone Meet awards reciprocal-wave evidence; proposed Welcome requires reciprocal messages in the same conversation. Different acceptance, not certification.
- **C-QUEST-EXCLUSIONS**: Open epic explicitly drops WA quest-script compatibility and room-token adapter, and defers XP/streak/ranked/cooperative/cosmetic features. Do not infer these from generic all-features wording.
- **C-QUEST-RETENTION**: Upstream engine proposal requires legal retention review before shipping; still open in reviewed source.
- **C-MATRIX-REENTRY**: User guide emphasizes messages while present; developer design explicitly retains previous in-area intervals on re-entry. Runtime must resolve before implementing history semantics.
- **C-MATRIX-WORLDSPACE**: Developer document labels world-to-Matrix-space mapping work-in-progress; do not certify it from architecture diagrams.
- **C-MAP-OBJECTLAYERS**: Older map rules say object layers are ignored, but later area/text/embedded-site APIs depend on them; inspect current loader semantics.
- **C-ICE-CACHE**: Independent source renewal timer reuses retained resolved configuration promise; intended renewal differs from inspected behavior. Standalone separates cache and in-flight state.
- **C-PR-STATE**: Fresh API read confirms606 and608 already merged into batch. Earlier open labels were stale; merged batch still does not prove default or deployment.
- **C-APPS-DISABLED**: Default Apps docs explicitly keep Calendar/To-do disabled and ship no population integration; generic advertised apps do not establish functional calendars/tasks.

## Revision 4: stable checkpoint and authority correction

This freeze closes the remaining13 captured-doc scope reviews without pretending the full source universe is audited. It adds narrow bot/tool runtime clauses and corrects the most important authorization distinction: ordinary bot configuration allows universe owner/world admin/editor, while inspected per-bot MCP list/test is creator/super-admin scoped. Trusted service credential reads are separate. Do not copy broad room-editor permission into external-tool or credential administration.

Admin connection testing has ten-second request bounds; bot execution uses ninety seconds. OAuth status/refresh/rotation, reserved credential headers, bounded redacted diagnostics and outbound destination checks now have their own requirements. Source helper inspection is not a full security certification.

The actual source AI tool catalog includes people/position/area lookup, conversational navigation and image/file/audio/video results as well as MCP. Local resident manager controls and synthetic private tests remain narrower. Bot avatar grants retain scope; unsupported commercial policy subjects are confirmed in runtime. World-level map configuration in an old guide is contradicted by the current room-only schema.

Remaining work is explicit: most runtime/UI routes, downstream tool delivery and complete authorization, provider/AV/device acceptance, quest branch implementation, full locale/accessibility coverage and marketing claims. This bounded checkpoint is ready for publication independently of ongoing app changes.
- **C-MCP-ROLES**: General bot management is universe owner/world admin/editor; inspected per-bot MCP list/test uses creator or super-admin. Broad bot-manager wording is not credential/tool authorization.
- **C-MCP-TIMEOUT-SCOPE**: Admin Test Connection uses ten-second requests; bot MCP execution uses ninety seconds. Keep both contexts rather than replacing all timeouts globally.
- **C-AVATAR-GRANT-SCOPE**: Bot direct grants explicitly respect scope. Human picker direct-grant path checks active lifecycle and grant expiry but differs from ordinary scope/window filtering; complete endpoint semantics need review.
- **C-WORLD-MAP-FIELDS**: Older admin guide lists world map/WAM fields and inheritance; pinned Prisma schema and map requirements place map configuration on Room only.
- **C-UPLOAD-REPLACEMENT**: Hosted upload docs warn directory replacement, while detailed map-storage contract preserves existing WAM edits in specified paths. Actual upload controller must govern before enabling destructive replacement.
