# Shared areas and room fields

The editor negotiates `sceneOperationsV2.version === 2` separately from the
unchanged v1 capability. V2 supports complete areas and the explicit scene
fields `theme`, `bounds` and `spawn`, alongside object and terrain operations.
An area's ordered actions, named arrival configuration and personal-space
configuration remain one atomic value. Ownership, claims, roles and room
visibility remain under their existing authorized APIs.

The existing Environment and arrival-position controls use these supported
fields. This change does not add a room-resize interface. JSON imports,
explicit item/area reordering and unknown scene metadata retain the reviewed
whole-scene save path. An older server can continue using v1 or legacy CAS.

## Independent and interacting changes

Different targets are not always independent. Areas can overlap; a resized
personal area can affect an object; distant meeting areas can share a media
group. V2 compares a bounded dependency view in addition to each target's
previous value. It includes relevant old/new footprints, ordered neighboring
areas, affected objects/cells and shared media-group areas. Bounds and spawn
edits conservatively depend on the remaining room geometry. Theme-only edits
do not acquire that structural dependency.

An independent area edit can therefore retain a peer's unrelated object,
terrain, area or theme edit. An unseen interacting change requires review.
Existing intentional overlaps remain valid. The server preserves existing
area order and appends new areas in accepted commit order; it does not infer
a new priority or silently interleave action arrays.

The client displays full-area and individual room-field conflicts with their
original, local and current values. A dependency conflict is labeled
“Nearby areas and shared space.” Keeping local changes acknowledges the current
dependencies and prepares a new draft. Choosing the whole server version
explicitly discards the local draft. Neither choice bypasses physical placement,
arrival or authorization checks. Cancel and export retain the original draft.

The server recomputes dependencies from current authoritative data and validates
the final merged scene within the commit transaction. A bounds shrink cannot
cut through unchanged objects, areas or current occupants. A newly selected
spawn must have an exit even when an untouched legacy spawn was already
trapped. Named arrival regions must retain safe landings. Changing area policy
refreshes current media/action behavior through the existing committed-scene
lifecycle; this does not certify live calls or external media services.

## Retry, drafts and authority

An unknown request retains its exact version, identity and semantic payload.
Later local edits stay separate. A retry response from a server that no longer
supports that protocol does not prove that the original request was rejected.
An import made while an older save is unresolved retains its whole-scene
intent after that older receipt arrives.

Committed peer images already present in the current authoritative snapshot
can remain in a rebased draft after archival. That does not allow adding a new
placement of an archived image. Image dependency footprints include transparent
and noncolliding pixels, and canonical definitions must remain bound during
cloning and reconciliation.

Permission downgrade, retired admission and room travel continue to fence
pending responses and optimistic work. Personal-area owners keep scoped object
rights; v2 does not grant them area or room-setting authority. Current rights
are rechecked before commit, receipt recovery and history access.

## Verification boundaries

Model and controlled editor tests cover v1/v2 negotiation, dependencies, review,
undo, image bindings, import/retry intent and authority changes. Independent
HTTP tests compute their own wire preimages and cover both commit orders,
structural rollback, streamed revocation, migration, durable receipt recovery
and private-history access. The native `sharedareas` browser group exercises
two real local editors, Silent policy changes beside peer object edits,
conflicts, invalid combined arrivals, dropped responses, missed SSE and a
held request followed by permission downgrade.

These are local synthetic accounts and software WebGL tests. They do not prove
physical-device performance, deployment, live media operation or complete
Universe command-stream parity. A registered test is not itself a passing
result; use the workflow result for the relevant source revision.
