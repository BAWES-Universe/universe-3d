# Room-scoped custom furniture v1

Custom furniture is a strict Asset Workshop composition definition plus separate,
pinned scene instances. It is not a legacy furniture type or an image asset.
The existing room and personal-area permissions remain authoritative.

## HTTP API

Clients declare `composition-furniture-v1` in
`X-Universe-Client-Capabilities` (alongside other capabilities). EventSource uses
the existing `capabilities` query parameter. This declaration is only reader
compatibility; it grants no authorization.

- `GET /api/rooms/:roomId/furniture` returns `{assets, limits}`. Assets are the
  latest revision of every active or archived room asset, ordered by creation
  time and ID. Room visibility and a live authenticated session are required.
- `POST /api/rooms/:roomId/furniture` accepts exactly
  `{definition, operationId}` and returns `{asset, duplicate:false}` with HTTP
  201. The server allocates a UUID and revision 1; local draft identity and
  revision are never ownership, scope, or CAS evidence.
- `PUT /api/rooms/:roomId/furniture/:assetId` accepts exactly
  `{definition, revision, operationId}`. `revision` is the expected current
  authoritative revision. Success appends an immutable revision and returns
  `{asset, duplicate:false}` with HTTP 200. Source editing never repoints saved
  instances. A stale revision returns 409 `FURNITURE_REVISION_CONFLICT` and the
  currently authorized asset envelope.
- `POST /api/rooms/:roomId/furniture/:assetId/archive` accepts exactly
  `{revision, operationId}`. Success returns `{asset, duplicate:false}` with
  HTTP 200. Archive changes status, not the immutable revision. There is no
  hard-delete or unarchive API; publishing a copy makes a new asset.

An asset envelope is
`{assetId,roomId,authorId,revision,status,definition,createdAt,updatedAt}`.
`authorId` is the original authenticated publisher. All full room editors
(`owner`, `admin`, `editor`) may create revisions or archive room assets.
Every library mutation requires a fresh joined admission in the same room.
The server captures the admission/session before body streaming and checks it,
current visibility, role, and policy generation again inside the SQLite write
transaction. No client author, room, resolved envelope, or permission claims are
accepted. A role revoke/regrant, travel away/back, same-room relocation, expiry,
or logout cannot revive an in-flight mutation.

Operation IDs use the normal API ID syntax. Receipts are scoped to actor and
operation ID and durable across restarts. An exact authorized retry returns the
original committed asset envelope with `duplicate:true` (HTTP 200); changed
semantic data or another room returns 409 `OPERATION_REUSED`. Current authority
and admission are checked before receipt lookup. After restart, rejoin before
retrying. Failed validation/CAS/authority checks allocate no revisions or
receipts. Receipts are naturally bounded by the library revision/cardinality
limits and one archive per asset. An old successful receipt can describe an
asset that has since been archived; refresh the catalog for current status.

## Definitions and scene projection

Definitions use `modules/asset-workshop/model.js` strict v1 validation and fixed
primitive topology. Publication requires at least one component. All fields
round-trip, including inert texture-slot references. This integration never
fetches those references: the renderer uses material base color. No authenticated
texture loading, external URLs, arbitrary meshes, scripts, or shaders are added.

Scene objects have exactly:

```json
{"id":"placed-1","type":"composition","name":"Custom furniture","x":6,"z":0,"rotation":90,"assetRef":{"assetId":"server-generated-uuid","revision":1}}
```

No source definition, dimensions, scale, elevation, collider overrides, actions,
or author metadata can be embedded in the instance. A room response separately
projects `room.compositionDefinitions`, keyed by `assetId:revision`, whose values
are strict definition documents (not API asset envelopes). This map comes only
from room-scoped immutable SQLite records and is never persisted inside scene
JSON. Client-supplied projection fields are rejected. Bind the trusted projection
before any rendering, placement, personal-area checks, collision, arrival, bot
navigation, or scene-operation dependency computation.

Both whole-scene PUT and operation commits resolve references under the same
scene write transaction and require a current joined admission for composition
scenes. Built-in-only legacy PUT retains its prior unjoined behavior. Ordinary
personal-area builders can place/edit/remove furniture only within both the old
and new full footprints and current personal-area revisions; they cannot publish
source definitions. Decorative `collision:'none'` parts still count for room
bounds and personal-area authorization. Source re-publication never shrinks the
permission footprint of an already saved pinned revision.

An archived definition continues to resolve for existing saved instance IDs
pinned to that exact revision. Those instances may move or be renamed. Archive
forbids new IDs, copying/duplication, changing another instance to that archived
reference, and re-adding a previously removed pin. Historical definitions stay
available after restart, and archived/history records still consume quotas.

## Geometry and budgets

Source positions and quaternion rotations retain their authored 3D transforms.
Room instances use quarter-turn legacy yaw (`-degrees`) with no instance scale.
The ground anchor shifts Y by minus the full conservative source minimum Y,
including decorative parts. All render and permission extents use the shared
composition transform. Collision boxes use conservative transformed X/Z
projections of authored component boxes. Elevated colliders still block ground
walking; v1 has no vertical pass-under/terrain support physics.

New/changed compositions must stay inside room bounds and avoid blocked terrain,
other solid objects, arrival clearance, live players, and residents. They cannot
close a previously usable walking route. Conversely, introduced solid legacy
objects, moved images, newly blocked ground, and a moved arrival point cannot
overlap existing composition colliders. Unchanged unrelated legacy overlaps
remain editable. Geometry used by server arrival/bot
navigation and the game renderer comes from the same pinned definition.

Hard custom furniture limits (in addition to existing scene/body limits):

- 64 assets per room, including archives
- 32 immutable revisions per asset, 512 revisions across the room
- 262,144 UTF-8 bytes per published definition
- 8 MiB total stored definition bytes and 2,097,152 historical triangles per room
- 128 placed composition instances, 2,048 component meshes, 262,144 rendered
  triangles, and 4 MiB distinct resolved definition bytes in one room scene

Budget checks and insertion/CAS/receipts share one transaction; no partial
library or scene commits occur. All past versions and archived assets count.

## Older clients and durability

The first accepted composition placement atomically establishes a permanent
per-room `composition-furniture-v1` reader floor in SQLite. It is not removed
when instances are deleted. Old connected readers in that room receive the
existing `CLIENT_RELOAD_REQUIRED` retirement event before scene broadcasts.
Incompatible requests to that room, including saves/replay, return HTTP 426;
unrelated legacy rooms continue to work. A first composition write must already
declare compatibility, so it cannot silently enable a format for itself.
Startup detects composition-bearing stored scenes and repairs missing floors.
Unknown stored floor capabilities fail server startup rather than being ignored.
`/api/client-protocol` also reports
`compositionFurniture:{capability:'composition-furniture-v1',required:boolean}`.

The deployment reader descriptor must advertise this capability before deploying
against a database with a furniture floor; rolling back to an older reader is
unsafe. API declarations do not make an old server binary format-compatible.

Focused verification: `node --test tests/workshop-server.test.mjs`.
