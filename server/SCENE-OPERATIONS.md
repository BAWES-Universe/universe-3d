# Independent scene commits, protocol v1

Current room projections advertise `sceneOperations: {version: 1}` outside the
persisted scene. Legacy clients keep using `PUT /api/rooms/:id/scene` with the
whole-scene revision comparison. That route retains its existing unjoined
built-in-object behavior. Metadata, ordered areas, imports and explicit object
reordering continue to use legacy CAS.

## Request and identity

`POST /api/rooms/:roomId/scene/operations` accepts:

```json
{
  "version": 1,
  "operationId": "actor-generated-stable-id",
  "baseRevision": 7,
  "contextHash": "64-lowercase-hex-SHA256-characters",
  "operations": [
    {"kind":"object","id":"chair-a","before":null,"after":{"id":"chair-a","type":"chair","x":8,"z":8}},
    {"kind":"terrain","x":5,"z":5,"before":null,"after":[5,5,"wood",false]}
  ],
  "personalAreaRevisions": {"desk": 2},
  "admission": {"admissionId":"current-id","admissionEpoch":"current-epoch","admissionRevision":1}
}
```

The admission fields are copied from the current joined arrival. Object `before`
is the SHA-256 of the complete canonical object, or null for absence. `after`
is the full replacement object (with the same ID), or null for deletion. Terrain
values are exact `[x,z,material,blocked]` tuples or null. Duplicate targets,
unknown envelope/operation fields, identity substitution, malformed values,
empty batches and no-op targets are rejected. Limits are 2,000 object targets,
4,096 terrain targets and 6,096 total; the existing 600,000-byte HTTP cap and
512,000-byte resulting-scene cap also apply. There is no implicit chunking.

Canonical JSON recursively sorts record keys and preserves array order. Hashes
use UTF-8 JSON and lowercase hexadecimal SHA-256. `contextHash` hashes every
scene top-level property except `objects` and `terrain`, including ordered areas,
bounds, spawn and unknown retained metadata. Canonical-value preconditions permit
ABA changes that return an entity to the identical value; this protocol does not
claim history-sensitive entity revisions.

The shared browser-safe module `src/scene-operations.js` exports
`canonicalStringify`, `sceneOperationContext`, async `hashSceneObject` and
`hashSceneContext`, `validateSceneOperationBatch`, `sceneOperationTargets`,
`sceneOperationRequestIdentity` and hash-neutral `applySceneOperations`.
`hashSceneObject(null)` resolves null. Applying operations preserves surviving
object order and appends new IDs in operation-array order. Changed terrain is
sorted by z then x.

A request's semantic hash covers exactly
`{roomId,version,baseRevision,contextHash,operations,personalAreaRevisions}` with
absent personal revisions normalized to null. The operation ID and authenticated
actor form the durable key. The admission envelope is excluded so a committed
operation can recover its receipt after an authorized fresh rejoin or restart.

## Atomic authority and geometry

After body streaming, under `BEGIN IMMEDIATE`, the server rechecks the current
session, room/hierarchy ACL, build capability, live joined admission and the
pre-stream arrival fence. These checks precede receipt lookup. A withdrawn
permission cannot be restored by an old receipt, and an uncommitted request from
an obsolete admission cannot execute after travel away/back.

Preconditions are compared with the current persisted scene. A stale unrelated
room revision can succeed; a future revision, changed context or changed target
returns 409 `SCENE_OPERATION_CONFLICT` with a freshly authorized current `room`
and `conflicts`, an array of `{kind:"object",id}`, `{kind:"terrain",x,z}` or
`{kind:"context"}` descriptors. Combined placement conflicts use the same shape.
Existing validators retain their established error codes and statuses.

The merged candidate uses the entire legacy scene validation chain: image
references and archived pins; scene/action schemas; personal-area old/new
footprints and live claim revisions; source image/terrain occupancy and route
checks; arrival geometry; area synchronization; provenance; and build quests.
New batch-only geometry checks compare changed collision geometry against all
final solid objects and blocked cells, compare newly blocked cells against final
solid objects, and require changed full footprints inside bounds. Changed solid
objects protect occupants and previously open arrival routes. Existing overlaps
are grandfathered when neither collider changed, including text/color renames.
Simultaneous moves are checked against the final merged scene.

Scene, receipt, journal, provenance and transactional quest writes commit together.
Room events, quest notifications and presence/media reconciliations occur only
after commit, once per newly accepted operation.

## Response and durable retry

New commits and identical retries both return HTTP 200:

```json
{
  "room": "fresh current authorized room projection",
  "receipt": {
    "version":1,"operationId":"stable-id","actorId":"authenticated-user",
    "roomId":"room","appliedRevision":8,"requestHash":"canonical-request-hash"
  },
  "duplicate": false
}
```

A duplicate returns the identical immutable receipt plus the latest current room,
without repeating validation, provenance, quests or broadcasts. Same actor/ID
with different semantic content returns 409 `OPERATION_REUSED`. Preserve an
ambiguous request's exact semantic payload and operation ID; changing its base
or operations creates a different request, even when its intended outcome looks
similar. Current admission still has to be supplied on retry.

Receipt rows are durable identity tombstones, independent of journal retention.
They are not silently evicted: pruning them would allow old additions to replay
after later deletion. They contain no historical role, capability or image
projection. Room archive does not erase them.

## Replay and migration

`GET /api/rooms/:roomId/scene/operations?after=N` requires current read authority
and returns `{room,after,cursor,mode,snapshots}`. Historical replay additionally
requires current full-room edit capability (`canEditScene`). Ordinary readers and
scoped personal-area owners receive current `snapshot` mode, preventing newly
admitted public readers from recovering content removed while a room was private.
`cursor` equals the current room
revision. In `replay` mode, snapshots are ordered contiguous entries strictly
after N, each containing only `{revision,scene}`. N equal to the head returns an
empty replay. A pruned/missing range, cursor ahead of head, or replay exceeding 1 MiB of
serialized scene bytes returns explicit
`snapshot` mode with only the latest scene snapshot. The byte budget is checked in SQLite before historical scenes are materialized
in JavaScript. The separately projected current room supplies live role/capabilities, personal ownership and currently
pinned image definitions; historical snapshots never restore those projections.

The transactional migration establishes each existing room's current revision
as its baseline without rewriting scene data. SQLite triggers record every
subsequent accepted room revision, including legacy PUT and personal-area
claim/assign/revoke/removal writers. Each room retains at most 64 snapshots.
The scene event's `cursor` is derived from the freshly personalized delivered
room revision, so asynchronous notifications cannot pair a newer scene with an
older captured cursor.
