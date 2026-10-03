# Editor save receipts

A successful save response can arrive after a newer committed room event or a
role change. The editor now records those observations while saving, then
reconciles them before applying the response.

- Scene revision orders committed geometry. The highest observed revision wins
- Role, capabilities and personal-area permissions are tracked separately;
  they can change without a scene revision advancing
- Image definitions retain the newest asset metadata revision, including an
  archive received while the save response was delayed
- Account, room, admission and editor lifecycle identify the pending save.
  A response from a retired context cannot update the current room or restore
  editing authority
- A failed save retains the local draft and the newest observed server snapshot
  for explicit recovery. Export preserves the draft before loading that snapshot
- A receipt with a missing, malformed or non-advancing revision fails without
  marking the local draft as saved

This repairs receipt ordering. Saving still uses whole-scene compare-and-swap;
disjoint edits can conflict, and this change does not merge drafts. When a newer
committed scene supersedes the receipt, obsolete local undo history is cleared
so it cannot restore an older complete room.

## Verification

Run `npm run build` before the full game test. The authoring browser group
registers these complementary suites:

- `node tests/editor-save-reconciliation.browser.mjs`: controlled editor
  promises/events covering success, failure, recovery, authority, image archive
  ordering and account/room/admission retirement
- `node tests/editor-save-ack-ordering.browser.mjs`: real SQLite, HTTP and native
  SSE with a deliberately delayed successful response, including the original
  newer-scene and role-downgrade regressions
- `node tests/editor-save-receipt.full.mjs`: native editing and saving in the
  bundled game, followed by a newer commit, downgrade or room retirement; the
  retirement case downloads and compares the exact retained draft

The isolated editor tests do not establish renderer or complete user-journey
coverage. The game tests use software WebGL and an isolated local service, so
they do not establish hosted-service, physical-device or full-parity results.
Registration is not a passing result; check the corresponding workflow outcome.
