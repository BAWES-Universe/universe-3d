# Participant locks and consented following

This is the implementation contract for an in-progress standalone increment. It expands the existing `U3D-PAR-MEDIA-GROUP` and `U3D-PAR-MEDIA-FOLLOW` inventory entries. It is not a declaration of shipped behavior, successful live media, or whole-source parity. Verification and publication status belong in `DEVELOPMENT-STATUS.md`.

## Source and accepted scope

The behavioral reference is game commit `bae18306bdfa63e58cd4124b1a3b5b290b61c286`. The compared runtime pin is `0e1ff05014d4b871ffd94eea744e40c1d1c7df79`; this does not establish deployment. PR609 merge `9a68beea975560480c2c4dd3f23aeb50ef6f330b` changes Follow/Lock presentation while retaining the relevant input and backend behavior.

- Any current bubble participant, including an admitted guest, can lock/unlock that bubble and invite its current other participants to follow. Room ownership does not grant control over a bubble the actor has not joined. Lock is independent of capacity: “Locked” and “Full” remain distinct.
- Ordinary Follow me requires each recipient to accept. Decline, Ignore invitations and Stop remain available. Accepting a different leader stops the previous leader's followers; it never silently assigns them to the new leader.
- Scripted `forceFollow` is a separate source capability and is not exposed by these ordinary controls. Rendered resident objects are not authenticated participant identities.
- F is the source social-follow binding. It never means Accept and leaves a merely pending incoming invitation untouched; explicit invitation controls remain available. The standalone camera-follow shortcut moves to Shift+F; its labeled control and Quick actions remain available. Typing, IME and modal input retain ownership. Follow is triggered on one keydown edge rather than repeated transitions while F is held.
- Source following adds manual direction to leader steering. A separate scripted/click path keeps precedence until a real manual/non-Shift action cancels it. Shift does not boost accepted following or the actor's own acknowledged waiting leadership. A received, unaccepted invitation cannot move or slow its recipient, steal focus or change the camera; this is an explicit consent/UX adaptation from the source pending-state speed behavior.
- The source stop distance is `sqrt(2000)` source pixels. Convert using the explicitly configured scale; do not infer a deployed scale, capacity, threshold or speed. Existing 3D normalization and collision handling remain in force. Following does not teleport through obstacles.
- Room/session/access revocation retires consent. Source status/Silent group ejection is not by itself a room-consent revocation. Media/text eligibility and following must retain their separate scopes. Following cannot turn a microphone, camera or screen share on.

There is no established source user-facing Leave/Rejoin button or cooldown in the audited paths. This increment does not add one. Existing Leave audio keeps its audio-only meaning. Optional all-member membership remains off unless configured through the existing validated process configuration; this work changes no live configuration.

## Authority and lifecycle

The pure bubble model is not an authentication boundary. The server derives the actor from the accepted session and rechecks current room access after awaited request-body work. Commands are bound to the current room, member/admission, bubble, connection and operation revisions. Client-supplied account IDs, roles, positions or a generic room-owner role cannot authorize another participant's action.

Invitations are bounded, ephemeral records with an opaque ID, current leader/recipient admissions, expiry and terminal disposition. Only the intended current recipient may accept. Validate both ends again; reject stale, expired, cross-room, self-follow, cycles/chains and resident identities. Duplicate operation receipts must not recreate invitations, reapply a retired relation or undo a later Stop.

There is one controlling accepted connection for automatic follower movement. Sibling tabs receive truthful state and may stop their account's own follow, but cannot drive the same lease. Reconnect, connection loss and stale responses cannot install an old lease. A local Stop halts immediately, retires that local lease and reports pending/failed server confirmation honestly.

Lock/control revisions are separate from membership and transport revisions. A lock-only toggle must not recreate the bubble, restart media, end a Nearby stay, clear typing or lose drafts. Actual membership changes retain the existing media/text freshness gates.

The client separates network/admission fencing from motion pause fencing. Modal/editor/typing/blur interruptions stop local movement. Resuming requires a fresh current-authority check; a stale async response cannot rearm a paused or stopped controller. Incoming invitations are passive and never take keyboard focus. Accept/Decline and Stop are directly reachable by native keyboard and touch.

## Planned protocol boundary

The server and client modules share a versioned `proximity-controls-v1` context. The implementation must keep its exact validator and tests authoritative if this contract is refined.

- `GET /api/proximity-controls?connectionId=...` reads current state. Omitting a connection produces read-only state, not a movement grant.
- Authenticated SSE event `proximity-controls` supplies the current stream's opaque connection ID and current context. Old connection/revision events are fenced before state or motion changes.
- `POST /api/proximity-controls/action` accepts strict common fields: `action`, `operationId`, `connectionId`, `roomId`, `memberId`, `bubbleId`, `membershipRevision`, `controlRevision`, and `stateRevision`.
- `lock` adds `locked`; `invite` adds no target list; `accept`/`decline` add `invitationId`; `stop` adds no actor; `preferences` adds `ignoreRequests`. No ordinary action accepts `forceFollow`.
- A successful response returns `{ok, duplicate, state}`. Stale-state conflicts require fresh state rather than optimistic acceptance.
- Current context distinguishes capability/availability, participants, explicit lock/full, pending invitations, outgoing invitations, accepted following, followers, connection ownership, server time and bounded policy limits. Disabled configuration exposes no functioning controls.
- Automatic follower presence includes the accepted follow lease and connection identity. Only its live controlling connection can use that grant.

## Acceptance gates

The new checks must demonstrate the following through authority/unit tests and real authenticated HTTP/SSE flows, then native two-or-more-browser interactions:

1. Current admitted guest/owner powers; rejection of outsiders, stale admissions and cross-room commands
2. Locked admission rejection on every recruitment path, without expelling existing participants or changing media/text scopes
3. Explicit invitation/acceptance; expiry, ignore, decline, forged IDs and duplicate/replayed operations
4. Atomic one-leader replacement with explicit stop notifications and no inherited consent
5. Immediate local Stop, server stop races, connection loss and one controlling tab
6. Fresh leader presence, correct camera-relative steering/facing, collision, scripted-path precedence and source speed behavior
7. F/Shift+F discovery, text/IME/native-button ownership, long-key activation and modal/blur pauses
8. Room exit, kick/ban/logout/TTL and access revocation cleanup without revived motion or stale invitations
9. Correct separation from Silent/meeting/media eligibility and no automatic device capture
10. Default-off behavior and rejection of rendered resident identities, with no provider dependency

No test result is implied by this list. Physical-device coverage, live AV/relay/SFU validation, source scripting/force-follow, upstream bot actors, full locale/accessibility coverage and deployment remain separate acceptance work.

## Primary source links

- [Participant lock UI](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Components/ActionBar/MenuIcons/LockDiscussionMenuItem.svelte#L8-L34)
- [Follow UI and Stop](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Components/ActionBar/MenuIcons/FollowMenuItem.svelte#L10-L39)
- [Named consent popup](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Components/PopUp/PopUpFollow.svelte#L119-L165)
- [Follow and lock server operations](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/back/src/Services/SocketManager.ts#L1164-L1206)
- [Group admission](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/back/src/Model/GameRoom.ts#L505-L539)
- [Leader/follower group geometry](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/back/src/Model/Group.ts#L76-L115)
- [F, path precedence and steering](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Phaser/Player/Player.ts#L57-L224)
- [Ignore requests and separate scripted force behavior](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Phaser/Game/FollowManager.ts#L14-L98)
- [Scripted follow documentation](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/docs/developer/map-scripting/references/api-player.md#L683-L713)
- [Room-leave relation cleanup](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/back/src/Model/GameRoom.ts#L283-L307)
