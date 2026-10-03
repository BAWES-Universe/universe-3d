# Independent shared edits

When the server advertises scene operations, Build saves changed objects and
terrain cells independently. The v2 capability extends this to atomic areas
and the supported environment, bounds and spawn fields, with conservative
dependency checks. Two people editing independent targets can retain both
changes. A peer's committed snapshot is reconciled with the local draft; it
does not silently replace that draft. See [shared area behavior](COLLABORATIVE-AREAS.md)
for the additional conflict boundaries.

The editor retains an acknowledged base, the editable draft and any exact
pending request separately. If a response is lost, Retry sends the same
operation identity and semantic payload. Edits made after that request remain
in the draft after its receipt arrives. An unresolved request remains dirty
even if Undo returns the visible draft to its former base.

Same-target, room-context and combined-placement conflicts open an explicit
review. It shows the original, local and current values, preserves independent
changes, and offers cancellation and exact export. Applying choices prepares a
draft; Save still rechecks authority and geometry on the server. Browser Back
dismisses review to Build, and Forward restores a still-current review. A stale
review cannot restore lost permission.

Local undo/redo snapshots are rebased over independent peer changes. If a prior
step cannot safely retain shared work, its history is cleared with a notice.
This is not an unrestricted room-history undo feature.

Same-room reconnection can replace an admission, including after a server
restart. The shell retains the draft and reconciles it with the newly authorized
snapshot. Retired requests are not resubmitted automatically. Post-request Undo
intent is retained; ambiguous target outcomes require review. A rejected draft
recovery pauses the room and offers export rather than silently discarding it.

## Compatibility and limits

Imports, explicit item/area reordering and unknown scene metadata still use
whole-scene compare-and-swap and can require whole-room review. Areas and room
settings also retain that behavior when only v1 is available. Existing servers
without either operation capability continue using the legacy save route.

Value-based preconditions permit an intervening change that returns an item to
the identical value. The protocol does not implement history-sensitive entity
versions. Batches retain the existing HTTP and scene-size limits and are not
silently split into smaller commits. See [the service contract](../server/SCENE-OPERATIONS.md)
for exact payload, authorization, receipt and replay behavior.

These slices cover committed objects, terrain and guarded area/settings edits.
They do not establish complete Universe editor parity, shared unsaved drag
previews, streamed room chunks or arbitrary concurrent area/settings merging.

## Verification

The standard unit run includes the pure reconciliation tests and independent
HTTP/SQLite tests. The authoring browser group includes:

- `editor-collaboration.browser.mjs`: controlled editor draft, review, retry,
  authority, image and new-admission cases
- `editor-collaboration.full.mjs`: native two-client saves in both orders,
  terrain, undo/redo, conflict export/review/history and a lost successful response
- `editor-collaboration-restart.full.mjs`: native drafts survive local server
  replacement against the same SQLite database, including committed and
  uncommitted unknown responses followed by Undo

The separate `sharedareas` group runs `editor-area-collaboration.full.mjs` for
native area/field merges, interacting-policy review, arrival safety, retry,
missed-event recovery and permission downgrade.

These tests use local synthetic accounts and software WebGL. They do not prove
physical-device performance, a hosted deployment or full feature parity. A
registered test must pass on the relevant source revision before being cited as
verification.
