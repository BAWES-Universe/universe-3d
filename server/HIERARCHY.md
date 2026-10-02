# v0.3 local place authority

This is the authoritative standalone **Universe → World → Room** model. All hierarchy, membership, invitation, account, scene, chat, quest, and document records use the same SQLite database and user IDs. It does not impersonate a production admin service, email delivery, SSO/OIDC, Matrix, or external map provisioning.

## Authority and admission

- A local signed-in profile, including a guest profile, may create a self-owned universe. Owner/featured/parent fields cannot be forged or changed through ordinary metadata APIs.
- The first profile on a new database owns the seeded universe and worlds. World creators receive a durable `admin` WorldMember. Register that profile to retain recoverable owner login.
- Only the universe owner changes world metadata or archives/restores a world. World admin membership does not falsely advertise this capability.
- Universe owner or world admin creates rooms. Universe owner, world admin, or world editor edits room metadata/scenes and archives/restores rooms. Explicit compatibility room-editor grants can edit only their room, only while ancestors permit admission.
- A WorldMember admits its user to that world's rooms, including private rooms. Membership in a sibling world does not grant access to another private world. An authorized member may see the universe containing its world, not unrelated hidden descendants.
- Without WorldMember, all ancestors must be public. A private room additionally needs an explicit room grant. A public child never bypasses a private ancestor. Room creator `ownerId` is provenance, not a permission bypass after losing world membership.
- Public visitors have effective role `guest`, empty tags, and **no member insertion on joining**. Their room admission follows current policy; sessions/presence are transient. Moderation records are separate from admission (`granted=0`). A room ban overrides membership.
- `role` is an explicit `member`, `editor`, or `admin` field in WorldMember. `tags` are up to 30 custom world-local text tags, sorted/deduplicated. Reserved role names are rejected as custom tags. Client profile fields, unrecognized identity headers, and OIDC-like claims do not confer roles.
- The universe owner's admin membership is protected. Removing/demoting the last admin is rejected. Explicit removal/leave also disables that user's old room grants in that world and immediately disconnects their active room sessions there; they may revisit a fully-public place as a guest.
- Private/inaccessible place detail, admission, document metadata/bytes, and stars return nondisclosing `404 PLACE_NOT_FOUND`. Known visible places with insufficient mutation rights return 403.

## JSON contract

Every place has `{id,name,slug,description,thumbnail,ownerId,public,archivedAt,metadataRevision,capabilities}`. World adds `{universeId,role,tags,rooms}`. Room adds `{universeId,worldId,revision,role,tags}` and `scene` only in detail/snapshot. Universe lists nest worlds, worlds nest room metadata; catalog endpoints never include scene assets.

Slugs are lowercase letters/numbers separated by single hyphens, max 64 characters. Universe slugs are globally unique; world slugs are unique per universe; room slugs per world. Archived places retain their slugs. IDs and ID-based room URLs survive slug changes. Slug redirect aliases are not implemented.

Names allow 120 characters, descriptions 3000. Thumbnail may be empty, a built-in `/assets/` path, or HTTPS URL; no embedded credentials. Metadata PATCH sends `metadataRevision`; stale CAS returns 409 `METADATA_CONFLICT` with `{current}` and no write. Existing callers may omit this field, but the Places UI always sends it. Scene revision is independent.

Creates accept optional stable `clientOperationId`. Retrying the exact normalized payload returns the same identity and `duplicate:true` with 200; changing payload under that ID returns `OPERATION_REUSED`. New creation returns 201. The creation and retry record commit together. IDs are never reused.

Room capabilities: `{canEdit,canEditScene,canEditMetadata,canArchive,canRestore,canModerate,canManageMembers,canInvite}`. World: `{canEdit,canArchive,canRestore,canCreateRoom,canManageMembers,canInvite}`. Universe: `{canEdit,canArchive,canRestore,canCreateWorld}`. Clients use the explicit flags, not guesses from role names. Archived/blocked ancestor state disables active editing.

## Routes

All require the same HttpOnly local session and origin checks.

| Method | Path | Outcome |
| --- | --- | --- |
| GET/POST | `/api/universes` | `{universes}` / create `{universe}` |
| GET/PATCH/DELETE | `/api/universes/:id` | detail/edit/archive `{universe}` |
| POST | `/api/universes/:id/restore` | recover retained universe |
| GET/POST | `/api/worlds` | `{worlds}` / create with `universeId` |
| GET/PATCH/DELETE | `/api/worlds/:id` | detail/edit/archive `{world}` |
| POST | `/api/worlds/:id/restore` | recover retained world |
| POST | `/api/rooms` | create with `worldId`, optional local `scene` |
| GET/PATCH/DELETE | `/api/rooms/:id` | existing room snapshot/edit/archive |
| POST | `/api/rooms/:id/restore` | recover retained room |
| GET | `/api/worlds/:id/members` | manager-only `{members}` |
| PUT/DELETE | `/api/worlds/:id/members/:userId` | explicit add/update `{role,tags}` or remove |
| GET | `/api/memberships` | own `{memberships}` with `canLeave` |
| POST | `/api/worlds/:id/leave` | leave self only, rejects a supplied `userId` |
| GET | `/api/accounts?worldId=…&query=…` | manager-only local-account picker, query min 2, max 50 results |
| GET/POST | `/api/worlds/:id/invitations` | manager list / targeted creation `{userId,role,tags,expiresInDays?,clientOperationId?}` |
| GET | `/api/invitations` | own inbox, includes terminal outcomes |
| POST | `/api/invitations/:id/accept\|reject\|cancel` | atomic transition; accept/reject only recipient, cancel manager |
| GET | `/api/worlds/:id/legacy-grants` | manager-only access-tightening review queue |
| GET | `/api/discover?universeId=…&q=…&offset=…&limit=…` | filtered `{universes,worlds,rooms,hasMore}`, max 100 per type |
| GET | `/api/stars` | own visible `{rooms}` |
| PUT/DELETE | `/api/rooms/:id/star` | set/unset (idempotent, never a retry-unsafe toggle) |

List universes/worlds support `includeArchived=1` for places the actor may recover; universe list supports `scope=owned`. Legacy world creation without `universeId` chooses the caller's first active owned universe, never another user's universe.

`DELETE` means reversible **archive**, not SQL deletion. Descendant IDs/scenes/messages/files/memberships/quests remain intact and become inaccessible through the archived parent. Pending descendant invitations become cancelled. Restoring a parent does not restore individually archived children. Lifecycle requests accept optional `metadataRevision`; the UI sends it to prevent a stale retry from re-archiving a freshly restored entity. No irreversible deletion API is exposed.

External `mapUrl` and `templateId` room provisioning are explicitly unsupported: `400 UNSUPPORTED_PROVISIONING`. Rooms use a validated local 3D scene. No fictitious successful external import is reported.

## Targeted invitations

Only an existing registered local account may be invited. This is an in-app inbox, with **no emailed invitation or bearer link**. Old bearer endpoints return `410 TARGETED_INVITATION_REQUIRED`.

An invitation records recipient, inviter, world, exact intended role/tags, created/expiry/update times in epoch milliseconds, and `pending|accepted|rejected|cancelled|expired`. Pending status grants no admission. There is one pending invite per recipient/world. Identical duplicate creation returns the existing invite; changed intended access requires cancellation first. Lifetime is 1–30 days, default 7.

Accept/reject/cancel are single SQLite transactions. Competing transitions yield exactly one successful final outcome and 409 `INVITATION_NOT_PENDING` for the loser. Expired invitations cannot be accepted. Acceptance inserts membership only if absent; an existing role/tags record is never overwritten. An inviter who lost world-management authority cannot grant access through a stale pending invite. Cancellation/rejection never removes an existing membership. Archive cancels pending invites rather than silently reactivating them on recovery.

## Live revocation

All room reads/writes, file requests, media policy/signals, and room SSE delivery consult current authority. Uploads recheck session and editor permission after receiving bytes and before committing. Downloads recheck immediately before response headers. Metadata and scene writes recheck authority after asynchronous body reads.

Hierarchy/member changes reconcile all active sessions. Lost read access, explicit membership removal, or leave sends `access-revoked {roomId,reason,recoverDraft:true}`, clears joined sessions and presence, disables media, and excludes the old SSE connection from future room traffic. Account/inbox events may still use that authenticated stream. Role downgrade sends personalized `role {roomId,role,capabilities,room,recoverDraft}` and recalculates media. Every room-bearing SSE payload is reconstructed for its recipient; broadcaster capabilities are never copied to another user.

`catalog {reason}`, `membership {worldId,userId,reason}`, and `invitation {invitationId,worldId,status}` cause filtered client refresh. They are invalidations, not authority or data copies.

Actual direct-message participants retain read access to their existing local history after leaving a public room. New DM sends require a currently shared authorized room or world membership. Being able to read one's old history never grants new room membership or recipient discovery.

## v0.2 additive migration and intentional access tightening

The database is not reset. Migration adds hierarchy/metadata columns and tables and preserves old users, account hashes, sessions, world/room IDs, scene revisions, chat, documents, and quest tables. Worlds are grouped under one universe per existing owner, preserving the owner authority boundary. Fresh seeds share a single initially-unclaimed universe. Existing owners receive admin WorldMember records.

v0.2 automatically inserted `member` on public visits and did not record whether that row came from a deliberate grant. Such ambiguous rows in originally-public rooms/worlds migrate to `granted=0`; they retain moderation metadata but never become private admission or WorldMember. Known room editor/moderator grants remain room-scoped.

A v0.2 grant into only one room of a private world is **not upgraded to all rooms**. Its record/role is preserved with `needs_review=1`, but the private ancestor denies it until a manager explicitly approves world membership. `/legacy-grants` and the Places member panel show this queue, including user and original room/role. The UI explains that adding WorldMember grants all rooms of that world. Explicit add/accept clears the review flag. This safe tightening can interrupt old private-room access, deliberately preferring no privilege expansion over silent broadening.

## Verification and remaining scope

`tests/hierarchy*.test.mjs` cover hierarchy identity/CAS/dedup/slug scopes, forged fields, public transience, private ancestors, scoped roles/tags, protected managers, targeted invitation races/outcomes, discovery/stars/archive/recovery, old-SSE/media/files revocation, DM history, real v0.2-format migration, and restart. Existing backend/file suites were updated only where their v0.2 member/bearer-invite/public-read assumptions intentionally changed; private-ancestry and targeted acceptance coverage replaces those expectations.

The shipped v0.2 checkpoint and archive are not edited. No production data or external accounts are touched. This tranche does not certify whole-source parity: source super-admin delegation, external map/template provisioning, SSO/OIDC, email delivery, owner transfer, and multi-service production transactions are outside this local implementation.
