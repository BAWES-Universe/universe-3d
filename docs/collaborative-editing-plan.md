# Collaborative editing: original implementation plan

The object/terrain and guarded area/settings slices are implemented as described in
[the client behavior](COLLABORATIVE-EDITOR.md) and
[the service contract](../server/SCENE-OPERATIONS.md). V2 area/settings edits
include symmetric spatial and shared-media-group dependencies. Imports,
unknown metadata and explicit item/area reordering retain whole-scene
compare-and-swap and can still conflict. Unsaved drafts are not a shared live
document. The broader plan below remains a design record, not a claim that
every item or source contract is done.

The independent friends-preview audit reproduced this at `f534ad2`. The same
whole-scene API remains in development tree `b349974d`. This plan does not
certify parity with the existing Universe editor's command stream and replay
at source pin `bae18306bdfa63e58cd4124b1a3b5b290b61c286`.

## Outcome

Two authorized editors can add or change independent items and keep both
changes. A conflicting edit is identified without losing either person's
work. Reconnection, retries and reordered responses converge to the committed
server scene without reapplying an operation or restoring revoked authority.

## Protocol and authority

1. Introduce a versioned batch of operations with an account-bound operation
   ID. Each operation names an immutable entity ID or terrain-cell coordinate,
   carries its expected prior canonical value/hash, and describes its intended
   replacement or deletion. An addition expects absence. Ordered item/area
   actions initially remain an atomic part of their parent entity; their
   order is meaningful and must not be silently interleaved.
2. Commit a batch atomically under the SQLite transaction. Compare its touched
   prior values with the current server scene, rather than rejecting solely
   because an unrelated room revision advanced. Never trust a client-supplied
   base to grant authority. Recheck the live actor/session, hierarchy, personal
   area ownership and revisions, old and new object footprints, image version
   rights, terrain occupancy, start regions and action validation against the
   merged current scene. Invalid combined geometry rejects the batch.
3. Treat room bounds, spawn, environment and ordered area changes conservatively
   until each has explicit merge semantics. Concurrent resize/delete versus
   affected object edits must conflict; a metadata edit cannot erase unrelated
   objects. Imported snapshots need an explicit diff/preview, not a disguised
   replacement operation.
4. Save the operation receipt and monotonic room event sequence in the same
   transaction as the scene. A retry with the same actor, ID and payload returns
   its existing result; reuse with a different payload fails. Emit only after
   commit. A lost response does not invite a new operation ID.
5. Provide authorized replay from a committed sequence and a bounded snapshot
   fallback after journal retention. An event belongs to a room and current
   admission. Revocation and room travel invalidate in-flight optimistic work;
   stale success must never revive it. No private scene or journal is returned
   after access loss.

## Client reconciliation

Keep the acknowledged base, a pending operation batch and the editable local
draft separate. Apply committed peer events to the base, then rebase local
independent changes. Same-entity edits, delete-versus-edit, conflicting action
order and incompatible terrain/geometry produce an explicit three-way review
showing base, mine and current server values. Choosing a resolution creates a
new reviewed batch; it does not overwrite the whole room. Cancel preserves the
draft, and export remains available before any deliberate discard.

Undo/redo concerns the user's acknowledged or pending operations. It must not
restore a historical whole-scene snapshot over somebody else's later work.
Transient drag previews, if added, are scoped ephemeral presence and do not
mean the draft is committed. UI copy must distinguish local preview, pending
commit and acknowledged change.

## Delivery gates

- Two real clients save disjoint additions, edits and terrain cells in either
  order and retain both; clean clients see the committed result
- Same-entity and geometry conflicts preserve both versions and allow a
  keyboard/touch resolution, cancellation and exact export
- Retry after a dropped response, duplicate delivery, out-of-order event and
  actual server restart apply each accepted operation once
- Revocation during body streaming, conflict resolution, retry and replay
  denies current authority and keeps draft recovery available
- Personal-area old/new footprints, cross-world IDs, archived image pins,
  start/exit safety and terrain occupancy remain server enforced
- Leave/rejoin and missed-event reconnect reconcile through the current
  admission, with no stale private metadata or ghost placements

First implement and falsify the operation protocol and reconciliation model
with independent HTTP clients. Then integrate the explicit conflict UI and
native two-browser editing flow. A complete shared editor additionally needs
the remaining source command/asset/map contracts; passing this slice alone
will not establish full editor parity.
