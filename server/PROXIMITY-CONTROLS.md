# Authenticated participant controls

The existing explicit all-member proximity membership configuration enables this
capability. Omitted membership configuration remains off; Nearby text and media
capture are independent. No provider, SFU, ICE, device permission, persistent
schema, environment setting, or scripted/force-follow API is enabled here.

## Source boundary

The ordinary invitation, participant lock, individual acceptance, leader
replacement, and stop behavior is grounded in the pinned Universe3D source at
`bae18306bdfa63e58cd4124b1a3b5b290b61c286`:

- [Participant lock and ordinary follow handlers](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/back/src/Services/SocketManager.ts#L1164-L1206)
- [Follow relations](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/back/src/Model/User.ts#L134-L178)
- [Actual room departure](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/back/src/Model/GameRoom.ts#L283-L307)
- [Status ejection and movement](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/back/src/Model/GameRoom.ts#L330-L461)
- [Stored Ignore requests preference](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Connection/LocalUserStore.ts#L243-L248)

Guests and owners have equal powers in their own current bubble. Owning a room
while outside the bubble grants none. A rendered resident object is not a human
admission. No Leave/Rejoin Nearby latch or cooldown is implemented. Audio-only
leave withdraws media consent and does not stop ordinary following.

Source group departure, including Silent/status ejection, is distinct from room
consent revocation. Accepted relations remain in the authority until explicit
Stop or actual leader/follower controlling-session, room, admission, presence-TTL,
or access revocation. The existing membership model may ignore a relation for
current group geometry when a participant becomes ineligible; it does not erase
the accepted room consent. Existing standalone busy/invisible eligibility
mapping is preserved; it is not exact source BUSY parity.

## Endpoints and SSE

GET `/api/proximity-controls?connectionId=<current-stream-id>` returns an
unwrapped state. Omit `connectionId` for read-only inspection; the state then
contains no usable motion lease. Every live `/api/events` SSE stream receives
`event: proximity-controls` with the same unwrapped shape. Each stream, including
same-cookie tabs, gets a different opaque connection ID.

A state contains:

```js
{
  protocol: 'proximity-controls-v1', available: true,
  connectionId, roomId, accountId, memberId, bubbleId,
  membershipRevision, controlRevision, stateRevision, snapshotRevision,
  locked, full, canLock, canInvite, ignoreRequests,
  participants: [{accountId, memberId, name}],
  invitations: [{invitationId, leaderId, leaderMemberId, leaderName, expiresAt}],
  outgoingInvitations: [{invitationId, recipientId, recipientMemberId, recipientName, expiresAt}],
  following: { // null when not following
    leaderId, leaderMemberId, leaderName,
    leaderPresence: {x, z, lastSeen, moving},
    leaseId, controlling, controllerConnected
  },
  followers: [{accountId, memberId, name}],
  serverTime,
  limits: {invitationTtlMs: 30000, sourceUnitsPerWorldUnit, memberTtlMs}
}
```

`memberId` is the logical admission identity, not the account ID. `following` and
`followers` describe individually accepted consent. Invitations never authorize
motion. Names and leader presence come from current stored identities and
server-admitted presence. There is no client leader/actor/role override.

`membershipRevision` remains reserved for actual member-set changes.
`controlRevision` belongs to the current bubble and tracks lock/follow control
changes; `stateRevision` tracks this admission's own control changes. Expiry and
revocation may advance these revisions. `snapshotRevision` monotonically
advances with authority syncs, allowing clients to discard delayed responses.
None of the control revisions replaces media scope or transport intent fencing.
A lock-only change leaves member IDs, bubble ID, media scope, transport intent,
Nearby connection epochs, stays and typing intact.

An admitted account outside a bubble has `bubbleId`, `membershipRevision`, and
`controlRevision` set to null; participants/invitations are empty and
`canLock`/`canInvite` are false. Its `memberId`, `stateRevision`, preference and
accepted relations remain available, so Stop and preferences still work. Missing
presence also sets `memberId` and `stateRevision` null and exposes no actions.

When disabled, GET returns
`{protocol:'proximity-controls-v1',available:false,reason:'disabled'}` and no
controls SSE is emitted. Unjoined SSE clients receive `available:false`,
`reason:'outside-room'`, and their connection ID. Authority failures produce
`reason:'unavailable'`; clients must pause motion. A session room transition or
revocation rotates all its SSE connection IDs and emits `reason:'room-transition'`
before the next admitted context. Clients must accept a replacement ID only from
their current live EventSource, never from an old HTTP response.

## Commands

POST `/api/proximity-controls/action` requires JSON and exactly these common
fields copied from the current state:

```js
{action, operationId, connectionId, roomId, memberId, bubbleId,
 membershipRevision, controlRevision, stateRevision}
```

`operationId` is a new opaque client ID for a new gesture. Supported actions and
additional exact fields:

- `lock`: `locked` boolean; only the requesting current bubble is affected
- `invite`: no additional fields; sends an ordinary invitation to current other
  members, excluding Ignore requests and duplicate pending pairs
- `accept`: `invitationId`; only this invitation's current recipient can accept
- `decline`: `invitationId`; only this invitation's recipient can decline
- `stop`: no additional fields; stops the account's following and leadership,
  and cancels its incoming/outgoing invitations, including outside a bubble
- `preferences`: `ignoreRequests` boolean; enabling it atomically consumes
  pending incoming invitations without revoking already accepted following

Success is `{ok:true,duplicate:false,state:<current-state>}`. An exact repeated
successful operation has `duplicate:true` and returns fresh state without
repeating the mutation. Reusing an operation ID for different content or another
session fails. Receipts are bounded and ephemeral, not a durable delivery log.

The route captures admission/revision and live-stream fences before its body,
then re-resolves accepted session and room access after its awaited body,
and the authority rechecks them again synchronously against SQLite. Every
operation compares the admission and revision context; no request can grant
consent to another account. Acceptance rechecks both endpoints and the originating
bubble. Self-follow, cycles/chains, stale invitations, foreign identities and
unknown/force fields are rejected. Choosing a different leader atomically stops
the prior leader's followers; only the current accepter joins the new leader.
Both sides observe the new state over SSE.

Important errors: 400 `INVALID_CONTROL_COMMAND`; 401 `AUTH_REQUIRED`; 403
`MEMBERSHIP_REQUIRED`, `BUBBLE_REQUIRED`, `FOLLOW_INVITATION_REQUIRED`; 409
`STALE_CONTROL_CONNECTION`, `STALE_CONTROL_ADMISSION`, `STALE_CONTROL_CONTEXT`,
`CONTROL_OPERATION_REUSED`, `FOLLOW_CYCLE_OR_CHAIN`; 429 `CONTROL_RATE_LIMIT`,
`CONTROL_INVITATION_LIMIT`, `CONTROL_PRESENCE_LIMIT`. On stale context, refetch and let a new explicit
gesture use a new operation ID. Never optimistically show accepted following.

## Motion lease and lifecycle

An accepted follower receives one lease bound to its accepted session and exact
SSE stream. Other same-account streams receive truthful relation state with
`controlling:false` and `leaseId:null`. They may Stop using their own fresh
context but cannot drive the shared avatar.

While following, every POST `/api/presence` must include the controlling
`connectionId` and `followLeaseId` (the state's `following.leaseId`). Secondary
static/manual presence fails with `FOLLOW_CONTROLLED_ELSEWHERE`. Clients should
suppress secondary local movement/presence and display their own authoritative
position. Old lease-bearing presence after Stop fails with `STALE_FOLLOW_LEASE`.
Request-start admission/motion-generation and in-flight session-retirement
fences also reject a movement body that began before acceptance, Stop, or a
leave/rejoin cycle with `STALE_CONTROL_MOVEMENT`. This includes ordinary unleased
leader movement when a sibling session preserves the logical admission.

SSE disconnect pauses the lease without revoking room consent. Reconnection
creates a new connection ID and never silently takes over an old lease: Stop and
a new invitation/individual acceptance establish new motion. A separate-session secondary same-room
join preserves the existing shared position and another session's active lease.
Rejoining on the controlling session first revokes its relation and rotates its
connection identity, then applies normal room admission. Same-cookie tabs share
that accepted session: joining from either retires all of its stream IDs, and a
last-session rejoin applies the ordinary spawn only after consent is revoked. Actual last room/session
leave, expiry, ban, kick, access loss and presence TTL retire the relevant consent.

Ignore requests is enforced in ephemeral admission state. The client may retain
the source-style per-account preference locally and explicitly reapply it on a
new admission; it must suppress invitations locally until that preference is
confirmed. No automatic acceptance exists during that interval.

## Bounds and verification

New safety policy, not legacy source thresholds: invitations expire at 30 seconds;
maximum 256 pending invitations and 256 operation receipts per room; receipts last
at most 120 seconds; in-flight presence fences are capped at 8 per session and
1,024 globally, released in a finally block when each request completes; each
admitted account may issue 120 non-Stop operations per
minute; Stop bypasses that rate cap. JSON command bodies are at most 4096 bytes
with a two-second body deadline. Room/member/session bounds and presence TTL come
from the existing explicit membership configuration. Ephemeral records are pruned
on authority reads, mutations and the existing heartbeat; expired requests cannot
be accepted even before the next heartbeat. No policy read renews presence TTL.

The source stop-distance constant remains 2000 source pixels squared; clients
must use the advertised scale. Source movement geometry is unchanged and receives
only server-validated followLeaderId values. Client collision integration, focus
pauses, source F/Shift behavior and browser workflows require separate client
verification. This server change makes no live media/provider/deployment claim.

`tests/proximity-controls-http.test.mjs` uses loopback HTTP, SQLite, actual SSE,
partial request bodies and concurrent same-cookie/separate-session tabs. It covers
fresh-session authorization, identity forgery, participant equality, lock scope
stability, consent/replacement, expiry/bounds, source group splits, Silent/status
versus room revocation, movement races and read-only secondary behavior.
