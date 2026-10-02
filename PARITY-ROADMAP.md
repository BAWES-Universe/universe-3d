# Universe source parity roadmap

## Audit boundary

This is an incremental inventory of source obligations, not a completed feature census. The durable machine-readable map is [PARITY-INVENTORY.json](PARITY-INVENTORY.json), schema 1.0.0, revision 1. Stable new IDs are retained as the map grows. Historical labels appear only where surviving repository documentation explicitly supplies them; missing old inventory rows and totals are not reconstructed from memory.

Candidate: [universe-3d `be6d136961010f986fde7c1ddaf13b66e164621a`](https://github.com/BAWES-Universe/universe-3d/tree/be6d136961010f986fde7c1ddaf13b66e164621a). Its [exact-head CI run](https://github.com/BAWES-Universe/universe-3d/actions/runs/37050686201) is completed successfully. The existing status document's CI-pending statement is superseded only for that revision. No app runtime tests were run for this documentation change. CI groups, document counts and test totals do not measure feature completion.

Source baseline: [game `bae18306bdfa63e58cd4124b1a3b5b290b61c286`](https://github.com/BAWES-Universe/workadventure-universe/tree/bae18306bdfa63e58cd4124b1a3b5b290b61c286) and [admin `c2053a56fa0cd89001cdb1b83c469281a672a9ef`](https://github.com/BAWES-Universe/workadventure-universe-admin/tree/c2053a56fa0cd89001cdb1b83c469281a672a9ef). The admin repository name is grounded in ASSETS.md and a successful exact-pin tree read. Media `0e1ff05014d4b871ffd94eea744e40c1d1c7df79` is a separate runtime variant, not silently treated as this default. PRs 598/599 and open 606/608 must remain separate historical/proposed variants until reviewed. Marketing claims are also a separate evidence class.

Current mapping: 46 requirement groups, 21 of 81 captured game Markdown files reviewed for cited clauses; **zero whole-contract certifications**. Status counts (blocked: 3, missing: 10, needs-review: 16, partial: 17) describe this incomplete map only.

## Already grounded, with remaining gaps

- Editor, objects and assets: placement/actions and protected PNG definitions have local evidence. Source metadata editing and remove-definition-plus-placed-instances remain absent at this baseline. Separate editing/archive work is not counted delivered. Archive-preserves-pins is not source deletion parity.
- Areas and personal spaces: scoped claims/assignment and old/new object footprint checks have narrow local assertions. Local remove-owned differs from source geometric removal. General restricted-area read/edit tags, away-owner visit cards and named starts need more work.
- Chat: source proximity text is ephemeral and current-bubble-only. Matrix rooms are persistent/federated, with independent invitation/history/E2EE/area-membership rules. Existing local DMs, room chat and Express cannot be certified as these contracts.
- Media and streaming: Silent policy and optional ICE transport setup have scoped tests. The cap-four opted-in graph remains. Neither SDP nor camera controls prove AV, relay allocation, SFU transitions, podium streams or cross-room megaphone.
- Bots/tools/MCP: resident configuration and navigation are local features. Private tests use a synthetic loopback protocol. Real provider conversation, MCP discovery/session/auth/tool contracts and memory are unfinished or need source review.
- Worlds, access, quests, navigation, profile, admin, localization, mobile, accessibility and map scripting/import all have explicit coverage placeholders so an unreviewed domain cannot disappear from the backlog.

## Bounded next increments

1. **Admin contracts:** capture and inspect the exact-pin guide, membership, workflows, avatar and bot/provider/memory docs; reconcile with their routes/models. Extract acceptance clauses and keep plans distinct from runtime.
2. **Game runtime and missing docs:** enumerate source outside docs/, then inspect worlds/access, profile/avatars, quests, bot lifecycle/tools and all advertised navigation. Replace placeholders with immutable file/line links.
3. **Media model:** reconcile the independent runtime pin with default and proposal pins. Recover all-member membership, thresholds, same-name meetings, Silent overlap, P2P/SFU transitions, screen/broadcast and teardown. Integrate only after appropriate code and runtime evidence.
4. **Source doc expansion:** read remaining captured files covering collections, Tiled, scripting APIs, localization, OIDC and self-hosting. Read coverage is not implementation coverage.
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
