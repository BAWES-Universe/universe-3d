# Independent scene commits, protocols v1 and v2

Current room projections advertise `sceneOperations: {version: 1}` outside the
persisted scene. Legacy clients keep using `PUT /api/rooms/:id/scene` with the
whole-scene revision comparison. That route retains its existing unjoined
built-in-object behavior. V1 metadata, areas, imports and explicit object
reordering continue to use legacy CAS. V2 adds individually preconditioned areas
and a small allowlist of scene fields, as specified below. Explicit object/area
reordering and imports remain whole-scene CAS in both versions.

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


## V2 capability and wire contract

The original `sceneOperations: {version: 1}` projection remains exact. A separate
`sceneOperationsV2: {version: 2, sceneFields: ["theme", "bounds", "spawn"]}`
advertises the extension. Neither projection is stored in scene data. Clients
opt in only when that complete supported contract is advertised and freeze the
chosen version for each pending request. Removing an advertised capability does
not authorize rewriting or downgrading an unknown-outcome request. Its original
identity must be recovered, rejected, or explicitly reviewed first.

V2 uses the same endpoint and admission envelope. Its additional required
`dependenciesHash` is a lowercase canonical SHA-256 digest. It accepts the
original object and terrain operations plus:

```json
[
  {"kind":"area","id":"studio","before":"full-area-sha256-or-null","after":"full-area-record-or-null"},
  {"kind":"scene","field":"theme","before":"field-value-sha256-or-null","after":"studio"},
  {"kind":"scene","field":"bounds","before":"field-value-sha256","after":{"width":40,"depth":30}},
  {"kind":"scene","field":"spawn","before":"field-value-sha256","after":{"x":0,"z":10}}
]
```

The placeholder strings above represent complete JSON records/hashes; absence
and deletion are JSON null. An area replacement retains its immutable ID. The
complete area, including its ordered `actions`, arrival settings and personal
area configuration, is one atomic preconditioned value. Existing areas keep
their order; additions append in operation-array order, then server commit
order. Concurrent changes to distinct areas may therefore serialize in different
orders; the protocol does not promise order-independent area behavior. An
explicit reorder must use whole-scene CAS.

Scene fields are exactly `theme`, `bounds` and `spawn`; each is a complete atomic
value. Optional `theme` may be removed with `after:null`; required bounds/spawn
cannot be removed. `before:null` means absent, and a present field is hashed as
its full JSON value. Room name, description, privacy, hierarchy membership,
roles, image definitions and other projected metadata are not scene operation
targets and stay behind their existing APIs. Unknown scene metadata and scene
`version` remain in the context fence.

V2 limits are 2,000 object, 4,096 terrain, 100 area and three distinct scene-field
targets, at most 6,199 total. Duplicate targets and unknown fields are rejected.
The original byte, structure, resulting-scene and action bounds still apply.
V1 validation rejects extension fields/targets and retains its 6,096 limit.

Shared helpers add `SCENE_OPERATION_VERSION_V2`, `SCENE_OPERATION_FIELDS`,
`MAX_SCENE_OPERATION_TARGETS_V2`, `hashSceneArea`, `hashSceneField(scene,field)`,
`sceneOperationDependencyView` and `hashSceneOperationDependencies`.
`sceneOperationContext(scene,version=1)` and `hashSceneContext(scene,version=1)`
keep v1 as their exact default. Passing 2 excludes `areas`, `theme`, `bounds` and
`spawn` in addition to objects/terrain; everything else remains context.

Only the v2 request identity adds `dependenciesHash` to the existing semantic
identity object. V1 canonical identity and request hashes are unchanged. The
receipt migration adds `protocol_version INTEGER NOT NULL DEFAULT 1` without
rewriting old identity fields or scene/journal rows. New receipts store the
request version, including on duplicate recovery after restart. The same actor
and operation ID cannot switch protocols or change its dependency digest.

## V2 dependency digest

Entity preconditions alone cannot protect an unseen overlapping area policy,
new object inside a personal area being edited, or a distant media area sharing
the same meeting group. V2 therefore requires a conservative bounded read set.
This prevents silent spatial-policy composition while allowing changes to
unrelated areas, objects, cells and theme to merge.

`sceneOperationDependencyView(scene,operations,definitions=imageDefinitions(scene))`
returns exactly:

```json
{"version":1,"bounds":null,"spawn":null,"areas":[],"objects":[],"terrain":[]}
```

`hashSceneOperationDependencies` asynchronously hashes that view. The values
are selected from the request's base scene as follows:

- A theme-only batch has the empty view above
- Any area, object, terrain, bounds or spawn operation includes current complete
  bounds and spawn values
- For each touched area/object, collect both its existing and proposed full
  footprint; terrain uses its full one-metre cell even if it is walkable or
  being erased. Area dependencies include current full areas touching any of
  those rectangles, excluding areas targeted by the same atomic batch
- A touched meeting/stage/audience area also depends on all current areas with
  one of its old/new effective media group keys (`meetingName || id`), regardless
  of distance. Targeted areas are still excluded
- An area edit also depends on current full objects and exact terrain tuples
  touching the old or proposed area rectangle. Objects/cells directly targeted
  by the same batch are excluded
- A bounds or spawn operation conservatively depends on every remaining
  current area, object and terrain cell, excluding directly targeted entities

Area and object dependency arrays preserve scene order. Terrain tuples are
sorted by z then x. Rectangles intersect inclusively, with a `1e-8` tolerance;
shared boundaries count. Built-in objects use their full authoritative rotated
footprint, including catalogue minimums. Images use the full pinned image edit
footprint, including transparent and noncolliding pixels. Missing or invalid
required footprints fail closed with `SCENE_DEPENDENCY_GEOMETRY`.

Browser callers preserve bound image definitions when cloning scenes or pass
resolved definitions explicitly. The server resolves both current and proposed
image references using live authority, then recomputes the same dependency view
from the current persisted scene inside the transaction. Client-provided image
metadata is never authoritative. This hash is a conflict guard, not an access
grant. Dependency values may be identical after an ABA sequence, just like the
existing canonical entity preconditions.

An unseen relevant neighbor, removed/moved neighbor, changed media group,
neighbor reorder or changed bounds/spawn returns 409
`SCENE_OPERATION_CONFLICT` with `{kind:"dependencies"}`. Explicit target conflicts
use `{kind:"area",id}` and `{kind:"scene",field}`. All include only the freshly
authorized current room, never historical projections. An acknowledged review
builds a new request against current entity and dependency values. It must not
modify an unresolved pending request's identity.

## V2 final validation and compatibility

V2 still runs the complete final merged-scene validation under the existing
write lock. Full room edit rights are required for area/scene field changes;
personal owners retain only current scoped object rights, both old/new footprint
checks and current claim revisions. A claimed personal area cannot be deleted,
moved, resized or switch mode before revocation. Tag eligibility updates retain
existing ownership and advance its revision and attribution atomically.

Changed bounds recheck all object/area footprints, even unchanged ones, and
protect current authorized occupants and resident positions. Changed spawn
rechecks unchanged solid object collisions and walking routes; the scene
validator always checks blocked terrain. All named arrival regions must retain
valid unique keys and a safe landing in the final scene. Ordered actions retain
the existing schema checks. Existing unchanged overlapping furniture remains
editable, while new solid overlaps are rejected.

All scene, personal registration, provenance, receipt and journal changes roll
back together on any failure. Legacy PUT and personal claim/assign/revoke writers
continue to participate in the same journal. Receipt retention and historical
read privacy are unchanged. Current read access does not disclose historical
snapshots to a newly admitted public visitor or a scoped personal-area owner.

Verification is covered by the original v1 model/HTTP/independent suites plus
`scene-operation-v2-model.test.mjs`, `scene-operation-v2-durability.test.mjs` and
the independent v2 HTTP consumer suite. Migration tests remove only the v2
receipt column from a temporary database, reopen it, and verify exact v1
receipt recovery, then commit/recover v2. SQLite-trigger fault tests prove
mixed area/object/cell/field failures leave every durable effect unchanged.
