# Development checkpoint v0.3 · 2026-10-02

This is the status of the earlier integrated local checkpoint, before public-source asset filtering. It is not a polished release. The public source omits restricted legacy sprite images; source publication checks are separately listed in REPOSITORY-CHECKS.md. Camera-relative sprite facing and overall movement, editor and visual quality still need improvement. Native 3D avatars and their persistent builder are under development and are not included here.

## Previously verified in the integrated local app

- Browser onboarding, independently authenticated participants and source-native animated Wokas
- Keyboard movement, solid collisions, full click-to-walk paths, touch joystick, camera zoom/rotation and room portals
- Live room presence, persistent room chat, message edits/deletion/reactions, local DMs, profile/status and moderation/role checks
- In-game object placement/properties/search; move/rotate/duplicate/delete; undo/redo; versioned server saves, reload recovery and explicit conflict handling
- Room/world creation and navigation; private-room invite admission
- Functional messages, URLs, protected uploaded documents; several area actions at once; opt-in local audio and exit cleanup
- Owner guest upgraded to a local account, explicit logout, and sign-in recovery
- Optional authored quests with explicit acceptance; actual named-area entry, committed authorized building, reciprocal proximity waves; private persistent stamps
- Forced-negative WebGL fallback is browser-tested: chat works, unavailable building is disabled, and no invisible avatar movement occurs

## v0.3 ownership and creation additions

Stable Universe → World → Room hierarchy; private ancestor checks; explicit world memberships/tags; targeted registered-account invitations and accept/decline/cancel/expiry; reversible archive/restore; visibility-filtered stars; live revocation with draft export; conservative legacy-grant review. See V03-NOTES.md and server/HIERARCHY.md.

## Earlier integrated-checkpoint automated evidence

- `npm test`: **76/76** pure, authenticated HTTP, persistence and lifecycle tests pass
- `tests/browser.mjs`: **14/14** integrated desktop/mobile-emulation checks pass
- `tests/advanced.browser.mjs`: **7/7** multiple-action, audio, account, conflict and full path/portal checks pass
- `tests/social.browser.mjs`: **16/16** focused DOM/async behavior checks pass
- `tests/social.live.mjs`: **7/7** real local-backend social checks pass
- `tests/quests.browser.mjs`: **12/12** actual quest browser checks pass
- Native-media negative-capture probe and authenticated two-client SDP/cleanup probe pass their stated checks, while both report **zero ICE candidates**
- `tests/places.live.mjs`: **15/15** real-backend Places UI groups pass
- `tests/renderer.browser.mjs`: **4/4** batched-geometry picking/count checks pass
- `tests/fallback.browser.mjs`: **3/3** forced-unavailable-WebGL checks pass

These suites overlap. Their counts are test counts, not feature counts or parity percentages. Mock-media unit tests do not prove real media packets.

## Important limits

- **No full source-parity certification.** The separate inventory covers 289 overlapping contract groups; most remain partial or missing
- No Matrix/E2EE/federation/history migration, production SSO, LiveKit/SFU/TURN, third-party integrations, live AI providers/MCP bots, full avatar entitlement catalog, generated-world streaming, or complete admin/operations stack
- No physical iOS/Android performance, successful end-to-end media packet flow, external-network transport, multi-instance scaling or production security audit
- Direct WebRTC exposes genuine capture/signaling/cleanup/failure states. It does not show fake connected calls
- File rights are room-scoped; no area-tag protected documents or inline viewer. Attachment downloads refuse active formats
- Quest Meet uses opted-in proximity waves and is a standalone partial equivalent; owner authoring/partner receipts/full guest merging are not implemented
- Presence coordinates are client-reported within bounds. Collision is client gameplay, not server anti-cheat physics
- First visitor owns fresh seed world. Local guest ownership needs account upgrade before clearing cookies. No password recovery

## Later implementation tranche

After the current visual, interaction and native-avatar work: resident/bot creation, private configuration, route authoring and real server-owned movement/lifecycle: BOT-01..07, BOT-09/11/13. Bots without an authorized AI provider stay silent; no canned answers or fake tool results will substitute for integration. Hosting adaptation and external AI/media providers remain separate live-integration gates.
