# Consented follow motion

`src/follow-motion.js` adapts the pinned source's direct follower steering to the
existing 3D collision integrator. It has no DOM, camera, focus, network, provider,
or persistent state access. `src/proximity-controls.js` owns consent, invitation,
HTTP/stream revision, and retired-lease fences; the motion controller only consumes
that module's locally consented `snapshot.motion` grant.

## Integration contract

Create one `createFollowMotionController()` per local avatar. Its default local
clock is `Date.now()`, the same clock used for the controls grant's `receivedAt`.
Pass `{roomId, connectionId, memberId}` from the current authenticated stream and
authority as `context`. Do not construct a motion grant from an invitation,
rendered remote avatar, old room state, or an account-wide membership view.

The normalized grant contains:

- `roomId`, `connectionId`, the follower's `memberId`
- `leaderId`, `leaderMemberId`, `leaseId`, `controlling`, `controllerConnected`
- `leaderPresence: {x, z, lastSeen}`, `serverTime`, local `receivedAt`
- `sourceUnitsPerWorldUnit`, `memberTtlMs`, and optional `leaderPresenceMaxAgeMs`

The server embeds the leader's presence from the accepted relation in the current
room. The client authority verifies explicit local acceptance before exposing the
grant. `controlling` and `controllerConnected` must both be true. The connection,
room, follower admission, leader admission, and lease form one motion identity.
Supplying another live lease never silently replaces the armed identity.

For initial acceptance, or after closing a modal/editor/text entry or restoring
window focus:

```js
const ticket = followMotion.beginResume();
const confirmed = await controls.refresh(); // Must start a new current-authority GET.
if (!confirmed) {
  followMotion.rejectResume(ticket); // Retire this ticket so a later bounded retry can run.
  return;
}
const snapshot = controls.snapshot();
followMotion.resume(ticket, snapshot.motion, {
  roomId: state.room.id,
  connectionId: snapshot.context?.connectionId,
  memberId: snapshot.context?.memberId,
});
```

`controls.refresh()` must not reuse an older in-flight GET. It already fences
superseded HTTP replies, retired consent, and connection/room changes. A newer
resume attempt, `pause`, or `clear` invalidates the ticket. `resume` also rejects a
grant received before the attempt. A current null grant completes the transition
to ordinary manual play. `beginResume` permits fresh manual input while waiting;
it cannot start following. `snapshot().pending` prevents unnecessary concurrent
resume attempts.

Every playable animation tick passes the **latest** controls snapshot:

```js
const result = followMotion.advance(motion, scene, {
  grant: snapshot.motion,
  context: {roomId, connectionId, memberId},
  input, angle, fast, path, pathSpeed,
  followSpeedLimited: snapshot.followSpeedLimited,
  cancelPath: nonShiftActionCancelsPath,
}, elapsed);
```

`advance` cannot arm a grant. Fresh SSE snapshots only update movement for the
same already armed identity. Stale/missing authority or leader presence, grant
revocation, and identity changes zero existing follow velocity immediately,
disarm, and emit a one-shot `result.stopFollow: {leaseId, reason}`. If the caller
sends a best-effort Stop in response, first verify the current room and lease still
match that event; an obsolete event must not stop a newly accepted relation.
The local disarm is immediate even if a Stop request fails. The UI's existing
Stop action must retire consent and call `clear(motion, {path})` immediately.

Whenever movement is blocked by foreground state, call
`pause(motion, {path})`. It clears velocity and that path. Also clear held keys,
joystick input and pending path producers using the shell's existing stop logic.
Repeated blocked ticks are safe. While paused, even fresh authority and manual
input cannot move the avatar. On room/account/stream changes, clear local motion
and let the controls authority retire its old grant; do not carry a resume ticket
or an asynchronously calculated path into the new context.

The parent must continue attaching `connectionId` and `followLeaseId` to presence
sent under the accepted lease. This module grants no server authority and does
not replace the server's single-controller or stale-presence rejection.

## Source behavior and deliberate adaptations

The source is `bae18306bdfa63e58cd4124b1a3b5b290b61c286`. Audited local files were
checked against the retained manifest:

- [Player.ts, follow and path order](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Phaser/Player/Player.ts#L57-L106), SHA-256 `ac67a7819e4be9c4d9cdee79d7d65ee017900c889ff9d583f481ffebe3030042`
- [Player.ts, speed and movement](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Phaser/Player/Player.ts#L149-L224)
- [FollowStore.ts](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Stores/FollowStore.ts#L1), SHA-256 `b2fe5c71db685e7c335a0af277832e2c54a8590a267169b54386fdb3c13398b0`

Preserved behavior:

- Add the unit direction toward the leader to manual steering; manual input does
  not cancel the relation
- Separate click/script paths take precedence. Manual movement or an explicit
  non-Shift action cancels the path. Shift alone neither cancels nor speeds up an
  ordinary click path; explicit scripted `pathSpeed` keeps its existing override
- Stop direct following when squared source distance is below 2000. Derive the
  world radius as `sqrt(2000) / sourceUnitsPerWorldUnit`, using the current
  authority's explicit scale with no default. Missing/invalid scale fails closed
- No Shift boost during accepted following, active leadership, or self-initiated
  waiting leadership. The controls module supplies `followSpeedLimited` for
  leadership and accepted states that have no local controlling motion grant

Narrow consent/UX adaptation: source pending recipient invitations also suppress
Shift and show their popup. An **unaccepted incoming invitation here never moves
or slows its recipient and never changes camera or focus**. It is absent from the
motion grant and must not set `followSpeedLimited`. The shell's F/Shift+F handling
and non-stealing invitation presentation are separate integration responsibilities.

3D safety adaptations: normalize combined diagonal speed through `advanceMotion`,
use its collision handling, calculate heading from actual world displacement,
hard-stop on foreground interruptions/revocation, and evaluate the source stop
radius at the same 120 Hz collision substep. No teleport, path search, prediction,
or provider state is added. A wall may leave a follower stuck or sliding along it;
following does not guarantee reaching the leader. Manual steering and Stop remain
the escape routes.

Freshness policy is explicit and distinct from the source: authority receipt and
leader presence are each capped at 5000 ms, and never outlive `memberTtlMs`. A
supplied tighter `leaderPresenceMaxAgeMs` also applies. Leader age is
`serverTime - lastSeen + (now - receivedAt)`, so clock offset does not extend a
stale sample. Negative elapsed time, future server samples, missing coordinates,
or mismatched included room/admission/account fields fail closed. Authority must
refresh while following; refreshing an old leader sample does not renew it.

## Verification

`node --test tests/follow-motion.test.mjs tests/motion.test.mjs` covers consent,
connection/admission/lease identity, source scale, freshness, manual addition,
normalization, Shift, paths, stop radius, collision, heading, interrupted resume,
revocation, and ordinary movement regression. Browser wiring and server
authorization are verified by their respective integration suites; these focused
tests alone do not establish full-game behavior.
