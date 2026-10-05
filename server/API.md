# Universe standalone backend API

Local server only: Node 24+, SQLite, localhost/127.0.0.1, default port 4190. Run `node server.mjs` after the client build. `PORT` and `UNIVERSE_DB` override port/database. Data defaults to `data/universe.sqlite`; WAL and SHM files are normal. Keep the data directory to retain accounts, scenes, messages, roles and invites. Seeds are loaded once, not reset on restart.

This is an independent local application, not a Matrix/LiveKit service, SSO provider, production deployment, or a source-stack implementation. No external ICE/TURN is configured. Browser WebRTC works only when peers can establish a direct connection; localhost guests need two browser profiles to test independently. The first profile created on a fresh database owns seeded worlds. Register a local username/password before clearing that browser cookie if owner recovery matters. There is no password recovery service.

## General

Most `/api/*` mutations with bodies use JSON; room document uploads use raw bytes (see [room document files](FILES.md)). Browser fetch uses same-origin credentials. Session identity is solely a 256-bit random HttpOnly, SameSite=Strict cookie; request body/header identity overrides are ignored. Session tokens are hashed in SQLite. Passwords are scrypt-hashed with random salts. The local HTTP cookie becomes Secure if used over TLS. Cross-origin and non-loopback Host requests are rejected. User strings remain plain text: clients MUST use textContent or correctly escape HTML. Errors: `{error,code,message,...details}`. 409 scene conflicts include the current `{room}` and never overwrite it.

## Identity

- POST `/api/session` `{name,woka}` -> `{user,worlds,rooms,currentRoomId}` (201 new, 200 existing)
- GET `/api/session` -> same; 401 when signed out
- PATCH `/api/session` or `/api/me` `{name?,woka?,status?}` -> `{user}`
- POST `/api/account` `{username,password}` -> `{user}`; upgrades current guest into a recoverable local account; username 3–32 a-z/0-9/underscore, password >=10 chars
- POST `/api/login` `{username,password}` -> session state
- POST `/api/logout` -> `{ok:true}`

User: `{id,name,woka,status,account,username}`. Woka is integer 0–31, short string, or small JSON customization object. Status: online/away/busy/dnd/invisible.

## Universes, worlds, rooms and access

See [v0.3 hierarchical authority](HIERARCHY.md) for the complete model, CRUD/archive/restore, metadata CAS, world-local membership/tags, targeted local-account invitations, stars/discovery, capabilities, live revocation, and additive migration policy.

Public visits now have role `guest` and create no room or world membership. Admission checks the entire Universe→World→Room chain, including on direct URLs and files. Inaccessible private places return nondisclosing 404. First-profile seed ownership includes its universe. World mutation requires universe ownership; world admins create rooms, world editors/admins edit them. DELETE archives recoverably; retained IDs/content are not removed.

Existing gameplay routes remain:
- POST `/api/rooms/:id/join` → `{room,members,presence,messages}`
- GET `/api/rooms/:id` → same authorized snapshot
- POST `/api/rooms/:id/leave` → leave current visit, not WorldMember
- PUT `/api/rooms/:id/scene` `{revision,scene}` → atomic authorized scene CAS
- PUT/DELETE `/api/rooms/:id/members/:userId` → compatibility room-scoped grant; owner/world-admin only, never bypasses private ancestors
- POST `/api/rooms/:id/moderate` `{userId,action:'mute'|'unmute'|'kick'|'ban'|'unban',minutes?}` → owner/admin/moderator, protected managers cannot be moderated
- GET `/api/users` → authorized current-room members and transient visitors

Old bearer invite creation/redeeming returns 410. Use targeted `/api/worlds/:id/invitations` and the recipient's explicit inbox acceptance.

## Chat and direct messages

- GET `/api/rooms/:id/messages?cursor=nextCursor` -> `{messages,hasMore,nextCursor}` latest 100, oldest first; tuple cursor handles equal timestamps without loss. Optional legacy `before=timestamp` excludes that timestamp and should not be used to page equal-time messages
- POST `/api/rooms/:id/messages` `{text,clientOperationId?}` -> `{message}`
- PATCH `/api/messages/:id` `{text}` -> `{message}` (author)
- DELETE `/api/messages/:id` -> `{message}` (author/owner/moderator), tombstone retained
- POST `/api/messages/:id/reactions` `{emoji}` -> `{message}`, toggles own reaction
- GET `/api/conversations` -> `{conversations:[{user,userId,lastMessage}]}`
- GET `/api/dm/:userId/messages` -> `{messages}`
- POST `/api/dm/:userId/messages` `{text,clientOperationId?}` -> `{message}`; participants must share a current authorized room or world membership; existing participants may read their prior history after leaving

An optional stable clientOperationId makes send retries idempotent per author. Retry the same ID/text/target to recover the original message; a changed target/text returns 409. Generate a new ID for a new message.

Room message: `{id,roomId,userId,author,text,createdAt,editedAt,deleted,reactions:{emoji:[userIds]}}`. Direct message: `{id,userId,senderId,recipientId,author,text,createdAt}`. Reactions: 👍 ❤️ 😂 🎉 👋 ✨ 🔥 💯 👏 🤔 🙌 😮 😊 💜 ✅ 🎸 💃 🕺 🏳️.

## Presence and events

- POST `/api/presence` `{roomId,x?,z?,moving?,direction?:0|1|2|3,rotation?,status?,emote?}` -> `{ok:true,presence}`; joined room only
- POST `/api/rooms/:id/emote` `{emoji}` -> `{ok:true}`
- GET `/api/events` SSE, max 4 streams per session

Presence entries merge user fields with `{userId,roomId,x,z,moving,direction?,emote,lastSeen}`. Presence expires after 60 seconds without updates. Client should refresh at least every 20 seconds. Room switch immediately removes the previous session's presence and excludes it from old-room SSE.

Named SSE events:
- `hello`: `{user,currentRoomId,serverTime}`
- `presence`: `{roomId,presence:[...]}`
- `scene`: `{roomId,room,actorId}`
- `message`: `{roomId,message}`
- `dm`: `{message}` (participants only)
- `members`: `{roomId,members}`
- `role`: `{roomId,role,room,capabilities,recoverDraft}` (personalized to affected user)
- `access-revoked`: `{roomId,reason,recoverDraft:true}`; preserve dirty local draft and leave room
- `catalog`, `membership`, `invitation`: filtered-refresh invalidations described in HIERARCHY.md
- `room`: `{roomId,room}`
- `moderation`: `{roomId,action,userId?,actorId?}`; deleted/kick/ban means leave room
- `media-policy` and `media-signal`: below

## Direct peer media

- GET `/api/media` -> `{selfId,roomId,enabled,context:{kind,label,canPublish,reason,group?},peers:[{id,displayName,name,canSend,canReceive}],iceServers:[],limits}`
- POST `/api/media/state` `{enabled:boolean}` -> policy
- POST `/api/media/signal` `{to,connectionId,description?:{type:'offer'|'answer',sdp},candidate?:object|null,request?:'offer'}` -> `{ok:true}`
- SSE `media-policy`: policy
- SSE `media-signal`: `{from,roomId,connectionId,description?,candidate?,request?}`

Media is opt-in. Stationary proximity joins within 4 units, existing pairs separate after 6 units, each connected proximity group has max 4 participants. Busy/dnd/invisible status suppresses proximity joins. Silent areas block media. Named meeting areas group their members. Stage publishers require owner/admin/editor/moderator; audiences receive only. Every signal is authorized from current server presence/area/role policy; SDP directions are validated. Signals deliver only to target-user sessions currently in the eligible room. A peer-to-peer browser is still an untrusted endpoint; this is not a hardened SFU enforcing encrypted packet-level media permissions.

## Current local identity constraint

Use one active room/media tab per account. Tabs sharing a cookie share session room state; media graph identity is a user ID, not a distinct per-tab participant ID. Test different players in separate browser profiles or contexts. Local account recovery uses username/password, with no email/SSO/recovery service.

## Scene actions

Areas can include legacy primary `action` plus up to 20 simultaneous `actions`, each with a unique id and type message/link/audio/teleport. Text and labels are bounded; URLs must be HTTP(S) or root-relative local assets; volume is 0–1. Primary action remains the authoritative media context.

## Independent local quests (partial source parity)

This standalone implementation follows the opt-in welcome/Explore/Build/Meet behaviors documented in the unmerged Universe quest program (#508/#511/#540). It is not the original Orbit quest engine or a claim that the whole source feature set is implemented. `createGameServer({questsEnabled:false})` hides offers without deleting stored progress; map/chat/editor/media continue to work. The local product intentionally enables the optional invitation by default. No external credentials or paid services are used.

- GET `/api/quests` -> private `{enabled,scope,preferences,available,attempts,tracked,stampCount,pendingNotices}` for the authenticated cookie identity and currently joined room
- PATCH `/api/quests/preferences` `{declined?:true,invitationSeen?:true,trackedAttemptId?:id|null,signInDismissed?:boolean}` -> private snapshot; decline is durable and cannot be reset by the API
- POST `/api/quests/accept` `{roomId,definitionId,version}` -> snapshot plus `{attemptId,duplicate}`; server rechecks current room, role, real peer and target eligibility, returns 409 for stale cards
- POST `/api/quests/archive` `{attemptId}` -> snapshot; archives an owned accepted attempt and clears its tracking
- POST `/api/quests/notices/claim` `{}` -> `{notices:[{id,attemptId,title,kind}]}`; atomic claim returns each private completion notice at most once across tabs
- SSE `quest`: `{changed:true}` to that user's sessions only; fetch `/api/quests` to reconcile

Each accepted definition/version has one immutable attempt, one private stamp at most, and a unique observation application. One attempt is tracked; other accepted attempts continue progressing. There is no client completion endpoint. Explore requires a post-acceptance outside-to-inside transition into the named reachable area, from accepted presence writes; joining/rejoining inside, standing still, changing area geometry, and pre-acceptance travel do not complete it. The active scene must match the accepted target geometry and the destination must be collision-free. Build requires newly introduced object IDs in a successful authorized scene compare-and-swap. Placement observation and stamp commit in the same SQLite transaction as the scene; moves, another editor's save, unauthorized writes, failed saves, and CAS retries do not award.

Meet here uses reciprocal 👋 emotes as a deliberate local alternative; the original development contract’s reciprocal proximity-chat-message detector is not implemented. Meet is offered only with a real, opt-in, server-policy proximity peer. Both players must issue a `👋` emote after that actor's acceptance in the same uninterrupted proximity link. Nearby connection policy, not microphone activity, is evidence. Silence/stage/meeting areas are not proximity bubbles. Movement apart, leaving, media opt-out, presence expiry and SSE reconnect reset pending reciprocal greetings; no fake user or bot supplies a greeting. Accepted presence is still client-reported within server bounds; this is not an anti-cheat authoritative movement simulation or proof that encrypted peer audio was connected.

Quest history/decline/stamps are saved under the same local user identity as rooms and chat. Registering the guest as a local account preserves them; signing into that account on another browser restores them. Signing into a different existing account does not merge guest progress. There is no offline observation outbox or guest merge workflow. Data persists until the local database is intentionally removed; regulated retention/deletion and operator progress views are not implemented. Private quest titles, stamps and locations are never added to public presence or room chat. Notice claims favor no duplicate payoff; if a response is lost after claim, the stamp still remains visible in the log.

The frontend accepts `mountQuests({root,api,getContext,onGuide,onWalk,onCancelWalk,onOpenEditor,onRegister,onOpenChange})`. Context supplies `{user,room,ready,busy}`. It exports `refresh/open/close/isOpen/handleEvent/setSuppressed/cancelWalk/destroy`. Parent controls movement and markers; Show the way must not move/zoom the camera, and Walk there must use collision-aware cancellable movement. Dialog open must clear held movement. It never synthesizes completion. Invitation/tracker/payoff are suppressed during typing, DND, hidden tab, or parent-marked chat/editor/media/modal occupancy; the log remains deliberately accessible. Deep links with meeting/interview/appointment identifiers skip arrival invitation. Owner authoring/publish workflows, configurable hosts, partner receipts, featured public badges and original-source device/localization acceptance remain outside this local slice.

## Custom furniture compositions

See [FURNITURE.md](FURNITURE.md) for the room-scoped `/api/rooms/:roomId/furniture`
library, immutable source revisions, CAS/idempotency, archive semantics,
composition scene instances, trusted definition projection, aggregate budgets,
and the `composition-furniture-v1` reader floor. The existing scene PUT and
scene-operation endpoints place exact pinned references under room/personal-area
permissions; clients cannot submit source definitions as scene geometry.
