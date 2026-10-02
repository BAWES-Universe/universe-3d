# Personal areas and current-room desks

This is the independently implemented local-server equivalent of EDIT-21. Source evidence is pinned to `BAWES-Universe/workadventure-universe` commit `bae18306bdfa63e58cd4124b1a3b5b290b61c286`: `docs/map-building/inline-editor/area-editor/personal-area.md`, `GameMapAreas.ts`, `AreasPropertiesListener.ts`, `ClaimPersonalAreaDialog.svelte`, `MapEditorModeManager.ts`, and `play/src/i18n/en-US/area.ts`.

## Data and capabilities

Full room editors author an optional scene-area field:

```json
{"personalArea":{"mode":"dynamic","allowedTags":["artist"]}}
```

`mode` is `dynamic` or `static`. Tags match exact custom tags in this room's world. In dynamic mode any matching tag permits claiming; an empty allowed-tag list permits any registered local account. Neither allowed tags alone nor anonymous guest sessions grant personal-area ownership. Local accounts use name/username; this implementation has no email directory, verification, invitation delivery or upstream identity adapter.

Ownership, monotonic area revisions, declines, operation receipts and object attribution live in SQLite, outside client-editable scene JSON. `room.personalAreas` returns each active personal area in scene order:

- `areaId`, `name`, `x`, `z`, `width`, `depth`, `mode`, `allowedTags`, `revision`, `updatedAt`
- `ownerId`, `owner:{id,name,username}|null`, `isOwner`, `canClaim`, `declined`, `canManage`, `canEditObjects`
- `objectCount` (fully contained current objects), `ownedObjectCount` (current owner's attributable objects from this ownership grant)

`declined` is specific to this account and the current area revision. A later ownership/configuration change makes a previous decline obsolete. `canClaim` remains true after declining so manual retry is possible.

Room capabilities now include `canBuild`, `canEditObjects`, `canManagePersonalAreas`, and `editableAreaIds`. Existing `canEditScene`, `canEditMetadata`, room/world roles and membership-management flags are unchanged; an area owner never becomes a full room editor. Ordinary file-upload and build-quest privileges are still full-editor privileges.

## HTTP operations

- `GET /api/rooms/:roomId/personal-areas` returns `{room,personalAreas}`
- `GET /api/rooms/:roomId/personal-areas/accounts?query=Al` requires full room-edit authority, searches registered accounts already admitted to this world, granted this room, currently visiting it, or the universe owner. Two characters minimum. Returns `{users,scope}`
- `POST /api/rooms/:roomId/personal-areas/:areaId/claim`
- `POST /api/rooms/:roomId/personal-areas/:areaId/decline`
- `POST /api/rooms/:roomId/personal-areas/:areaId/assign`
- `POST /api/rooms/:roomId/personal-areas/:areaId/revoke`

Every POST requires `revision` (area revision) and unique `clientOperationId`. Caller identity is taken only from the authenticated cookie. Unknown fields, including caller/owner/role fields, are rejected.

Claim/decline require a registered account, dynamic eligibility, and a current joined session with a recent reported position inside the area. Positions retain the server's existing validated-client-report model; this is not authoritative movement anti-cheat.

If claim would release this actor's other personal areas in the current room, it returns `409 PERSONAL_AREA_TRANSFER_REQUIRED`, `{ownedAreas,area,room}`. After explicit confirmation repeat with `confirmedTransfer:true` and current `roomRevision`. One SQLite transaction releases previous current-room ownership, keeps all previous objects, claims the target, and renames it to `"{name}'s personal space"`. Released names become the source English claim-description string. No other room is changed.

Assign requires full-edit authority, a static unclaimed area, and `userId` chosen from the scoped account picker. Static assignment may give an account more than one desk, matching the source distinction. An existing owner must first be explicitly revoked.

Revoke requires full-edit authority, current `roomRevision`, and explicit `objectHandling`:

- `keep`: retain every object and clear the active ownership grant
- `remove-owned`: remove only current-owner-created objects attributed to this ownership grant and still fully inside the area; retain manager-created, previous-owner and preexisting furniture
- Cancel sends no request

`remove-owned` is deliberately narrower than the source's geometric “Remove entities” helper, which can remove every contained entity. The label must say “Remove owner's items,” and the UI must explain that other objects stay. It does not implement blanket region deletion. Revoke reopens dynamic claims; static areas stay unassigned until another manager assignment. Ownership changes reset the name to the claim-description string.

POSTs return `{room,area,duplicate,operation}`. `operation` contains historical `action`, `appliedRevision`, `objectHandling`, `transferredAreaIds`, `removedObjectIds`. A repeated matching operation returns the current authoritative room/area plus the original receipt, never reapplies old ownership. Reuse of an ID with different payload is `409 OPERATION_REUSED`. A retry after revoke may therefore be `duplicate:true` and `area.ownerId:null`. The client must trust the current projection rather than the historical receipt.

## Scoped object commits

Legacy full editors keep `PUT /api/rooms/:id/scene` with `{revision,scene}`. Personal-area-only owners also send `personalAreaRevisions:{"area-id":1}` for each edited object's source/destination area.

The transaction checks fresh session and room/ancestor authorization, room compare-and-swap, exact scene-metadata/area equality for limited owners, actual per-object before/after deltas, full rotated object footprints (at least catalogue size, since some procedural parts ignore custom size; inert scale/rotationY cannot shrink bounds), foreign-owner overlap, current area revisions, and server-owned field exclusion. An object cannot be stolen by moving it into the caller's area; both its old and new footprints must be authorized. Body streaming completes before the commit-time checks, so revocation, logout or ancestor privacy changes during upload invalidate the pending save. Functional actions may be edited on authorized objects, subject to the shared action schema and execution-time action authority.

Every ownership mutation increments the room revision as well as the area revision. Simultaneous placement/revoke serializes under `BEGIN IMMEDIATE`. If placement wins, the stale manager `roomRevision` fails before any deletion. If revoke wins, the stale object save loses access/revision checks. No silent last-writer-wins ownership or object deletion.

Claimed area geometry/mode changes or deleting a claimed area require explicit prior revoke. Allowed-tag-only changes are permitted, invalidate stale area revisions, and retain current ownership and attribution. Removing a user's world-local eligibility tag does not revoke their separately granted ownership. Revoking room/ancestor admission still blocks every read/write/desk route.

Area records retain monotonic tombstone revisions if removed and later recreated with the same ID. Object attribution is historical, never a grant. Kept old objects do not give a previous owner any authority.

## Current-room desk

`GET /api/desk` uses the current session room; optional `?roomId=...` resolves only that authorized room. It returns `{roomId,target,desks}`. `target` is the first owned personal area in scene order, at its exact center; `desks` contains the same room's owned areas only. No owner selection or caller override is accepted as authority, no global user desk lookup and no implicit cross-world travel. A room/owner/access change is reflected immediately.

Scene SSE events are personalized per recipient and include updated room capabilities/areas; role events carry immediate build-right changes. Clients must preserve unsaved drafts on conflicts/revocation and never trust old local area metadata for commit rights.

## Verification

`node --test tests/personal-areas.test.mjs` covers registered/tag eligibility, scoped account lookup, A/B race, decline/retry, source transfer, first current-room desk, footprints, overlap, foreign-object movement/deletion, forged fields, allowed-tag changes, keep/remove-owned, stale warning/scene revisions, streaming revoke/privacy/logout races, and SQLite restart.
