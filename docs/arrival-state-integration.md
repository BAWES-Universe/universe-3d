# Client arrival ordering

`src/arrival-state.js` exports `createArrivalState(context?)`. It has no DOM,
network, timers, clock, random source, global state or renderer dependency. The
shell supplies authenticated server data and owns authorization, navigation,
stream fencing, room snapshots and live movement. Never pass URL coordinates or
invent missing arrival fields. See [the wire contract](NAMED-ARRIVALS.md).

## API

- `reset({accountId, roomId, sourceGeneration})`: retire every ticket and clear
  arrival authority. Call on account changes, explicit room-context resets and
  each new EventSource generation; allocate the generation before navigation.
  The source key is a nonempty string or nonnegative safe integer. Reusing the
  same arguments still resets. `roomId` may be null before initial admission.
- `hello({sourceGeneration, arrivalEpoch})`: process only the authenticated,
  source-fenced SSE hello. The first valid epoch establishes ordering and may
  follow `beginJoin`; a different epoch retires all authority and tickets.
- `beginJoin({roomId})`: immediately before the authenticated join/resume/GET,
  obtain an opaque one-use ticket. A newer call retires the old ticket. Returns
  null without an account, source key or destination. Only one HTTP request is
  current; unrelated background room GETs should not call this method.
- `observeSelf({sourceGeneration, roomId, presence})`: pass the self person from
  a trusted SSE presence event. Its `id` or `userId` must match the account; if
  both exist, both must match. Supply event `roomId`, not a URL room. During
  pending HTTP, buffer only the latest placements for its destination and the
  already confirmed source room. Otherwise adopt only a strictly newer current
  room placement. No confirmed room means SSE alone cannot activate movement.
- `resolveJoin(ticket, {roomId, arrival})`: resolve the same authenticated
  request, with `roomId` from its returned room and `arrival` from its snapshot.
  Compare buffered destination self placement with HTTP only within one epoch.
- `cancelJoin(ticket)` / `failJoin(ticket)`: settle failure or cancellation.
  Ignore an obsolete failure. Discard destination evidence and preserve the
  source, possibly adopting independently newer source-room evidence. An
  unsuccessful first admission still needs fresh authority.
- `snapshot()`: cloned diagnostic identities, `needsAuthority`, `pending`, and
  `pendingRoomId`. It intentionally does not pretend to track live coordinates.

## Applying decisions

An adoption is an indivisible assignment:

```js
{
  kind: 'adopt', reason: 'newer-self-placement', roomId: 'garden',
  admissionId: 'opaque-id', admissionEpoch: 'process-id', admissionRevision: 7,
  pose: {x: -8.2, z: -2.4}
}
```

On `adopt`, stop old motion/path/follow state and synchronously assign the pose
and all three admission fields before any movement POST or frame can run. Do
not apply `nearestWalkable`, another spawn sampler, or an earlier local pose.
The helper has already committed its ordering state, so apply the decision in
the same synchronous turn. A resolved join still needs its returned room scene
and permitted room metadata before rendering its destination.

`retain` means the same admission is already applied. It returns the identity
fields with **no pose**: keep the live local position while accepting relevant
room metadata. `buffer`, `ignore`, and first-hello `ready` do not relocate the
avatar. `refresh-required` means stop sending movement with old authority and
start a fresh, ticketed authenticated current-room snapshot/resume after
reconciling the shell's current navigation. Do not apply that failed result's
room snapshot as a successful join. An `ignore` from an old HTTP ticket must
likewise not apply its room/scene/history or clear newer navigation state.

On `refresh-required`, pending tickets have been retired (or settled for an
initial failed join). A mismatched HTTP process epoch is learned but that HTTP
cannot itself reactivate the avatar: another request must begin after the
boundary. A stale mismatched-epoch SSE is ignored and cannot change the epoch.
Source-generation changes always require `reset`; merely passing a new key to
`observeSelf` or `hello` does not switch sources.

## Ordering limits

Only positive safe-integer `admissionRevision` orders placements. Ignore
timestamps, arrival ID lexicographic order and receipt order. A same-revision,
different-ID conflict, a same-ID revision change, or malformed relevant server
placement fails closed. Revision numbers are never compared across processes
or rooms. State is bounded to one applied identity/pose and at most one latest
candidate per source/destination room; discarded older admissions need no set.

Placement revision is **not** a server motion revision. Equal-admission SSE
poses cannot supersede the HTTP pose during initial admission. After an
admission is applied, equal-admission SSE and HTTP do not reset local motion;
the shell's existing movement/follow behavior remains responsible for normal
movement. A higher buffered admission selects its complete received pose; the
helper makes no stronger freshness claim about subsequent movement in it.

Focused verification: `node --test tests/arrival-state.test.mjs` covers actual
ordering permutations, sibling travel, tied timestamps, old success/failure,
account/room/source/epoch changes, failure recovery, malformed authority,
unsequenced motion, cloned outputs and thousands of bounded queued placements.
