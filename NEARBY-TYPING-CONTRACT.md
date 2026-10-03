# Nearby typing contract

This is an ephemeral ordinary-bubble extension to the explicitly configured Nearby text service. It does not enable AV, add bot generation or scripted typing, or implement a personal blacklist. Room moderation, admission, session, status, area and access authority remain server-owned. Room mute stops outgoing typing but preserves eligibility to receive typing and Nearby text. Source adaptation is bounded to human typing, with the source's 10-second sender idle and 12-second receiver expiry; the 2-second throttle, strict schema, server lease, stream sequencing and caps are standalone hardening.

Pinned source: [human receiver and lease](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Connection/Proximity/ProximityChatRoom.ts#L877-L949), [composer](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Components/Room/MessageInputBar.svelte#L144-L188), [wire](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/messages/protos/messages.proto#L964-L982), [Space identity](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/back/src/Model/EventProcessorInit.ts#L33-L53).

## Wire

Enabled text contexts include exactly this extension:

```json
{"typing":{"protocol":"proximity-typing-v1","enabled":true,"refreshMs":2000,"idleMs":10000,"expiryMs":12000}}
```

An unconfigured text service has no extension or typing events and returns 404 for the typing route. The typing body has exactly seven fields:

```json
{"connectionEpoch":"opaque","roomId":"room","bubbleId":"opaque","memberId":"opaque","membershipRevision":1,"sequence":1,"isTyping":true}
```

POST `/api/proximity-text/typing` accepts JSON no larger than 2 KiB and waits at most 2 seconds. `sequence` is a positive safe integer shared by starts and stops within the source epoch. A 200 response contains only `{accepted:boolean}`; it is not a text receipt. Rejected authority, schema, capacity and rate requests use the normal structured HTTP error response. The request cannot specify draft text, author, recipients, stream identity or expiry.

`proximity-typing` SSE contains:

```json
{"protocol":"proximity-typing-v1","roomId":"room","bubbleId":"opaque","membershipRevision":1,"recipient":{"connectionEpoch":"opaque","memberId":"opaque"},"author":{"id":"account","name":"Current saved name"},"fromMemberId":"opaque","sourceId":"server UUID","revision":1,"isTyping":true,"serverTime":1800000000000,"expiresAt":1800000012000}
```

Each accepted start expires 12 seconds after acceptance. Stops carry `expiresAt=serverTime`. Event revision is a separate server counter, also advanced for lifecycle stops, never the client sequence. Same-cookie tabs and separate sessions each have their own opaque source identity. The server suppresses delivery to every stream belonging to the source account; receivers aggregate remote contributions by account. A display name can change on a newer event without changing source identity.

## Ordering and lifecycle

- Capture source epochs and concrete target SSE objects before awaiting the request body; new or replacement streams cannot inherit pending activity
- Revalidate source and recipient authority immediately before every activity write, including after the recipient context event; actual activity never uses the metadata refresh batch
- Retain source sequence high-water marks after stop, expiry and audience revision changes until the epoch retires; duplicate/lower sequences and early refreshes neither fan out nor renew the lease
- Throttle accepted refreshes to 2 seconds per active source; the first start after a stop is immediate, subject to the shared account quota
- A host request-order fence ensures text acceptance clears only older activity on that exact source, preserves activity begun after the text request, and rejects typing requests begun before the accepted text but completed afterward
- Expiry, source disconnect, epoch retirement, authority failures, mute, admission/context changes and server close cancel lease timers immediately; one source's cleanup does not erase sibling sources
- A lease timer checks at most one second between authority validations and wakes at its exact deadline (or source session expiry if earlier), independent of the 15-second host heartbeat. Explicit host lifecycle operations retire state synchronously. Timer callbacks retain lease identity, so an old canceled callback cannot clear renewed activity
- Context observation invalidates state without invoking new authority transactions. Stop metadata is deduplicated and flushed synchronously after the outermost metadata refresh, with fresh checks against only the exact old recipient epoch/member/bubble/revision. This is synchronous cleanup bookkeeping, not a retry or replay queue
- A metadata stop may remove an already delivered contribution after the source leaves, when the recipient's original audience remains valid through sibling account membership. It cannot enter a new audience. Receivers also clear on their own current-context changes

## Bounds and privacy

Separate typing quota: burst 8 starts, refill 2 per second per account. Stop/expiry/disconnect cleanup bypasses this quota. Rates survive source epoch retirement; their map is bounded and fully refilled idle buckets are pruned. Watermarks and active leases share a ceiling of 64 sources per account and 8,192 globally; retaining stopped-source watermarks can reject a new source before the lease ceiling. Accepted valid newer stops for existing sources allocate neither source nor recipient capacity. Delivered recipient contributions are capped at 65,536 globally. All state is in process memory.

Typing performs no SQLite writes and does not change history, unread counts, text message receipts, the 128-message text epoch budget, text rate limits, mic consent, media membership or ICE state. No body is logged or persisted. Failed requests are dropped; restart, reconnect, restored drafts and text retry do not create activity. Client real-input/IME, visibility, focus and idle behavior is covered by the separately integrated client implementation.

## Client behavior

The focused, visible Nearby composer starts only on real input or IME activity. Focus, restored drafts, arrow/modifier keys and panel reopening do not start typing. Refreshes occur only after fresh activity and at most once every two seconds; no periodic timer invents activity. Empty input, send attempts, Close/Escape, channel or stay changes, document hiding, authority loss and destruction stop the current source. Focus-out uses a generation-guarded 150ms debounce. Incoming updates change a separate reserved status line without rebuilding the composer or transcript, moving focus, adding unread counts or scrolling.

Receiver deadlines use the current SSE hello server-time anchor plus monotonic elapsed time, rather than the device wall clock. A delayed activity envelope cannot rebase its own expired lease. Missing/invalid anchors fail closed for starts; transport/account changes reset the anchor. Room travel retains only the same transport clock, never old typing contributions. The native controller tests cover opposite device clock offsets, wall-clock jumps, IME, focus/visibility and repeated mounting.

The optional text configuration enables this compatible extension. An older or malformed context without the exact extension simply leaves typing off. The feature does not require microphone consent and does not activate capture or media. The pinned source and intentional adaptation differences are recorded in [NEARBY-TYPING-SOURCE.md](NEARBY-TYPING-SOURCE.md).

## Verification

`node --test tests/proximity-typing-authority.test.mjs tests/proximity-typing-http.test.mjs` covers 41 focused cases, including real sessions/SSE/SQLite, same-cookie and separate-session sources, delayed bodies and text/typing ordering, target-context callback revocation, nested refresh cleanup, exact deterministic 12-second expiry, real runtime lost-stop expiry, strict body schema/timeout, quota exhaustion, muted-recipient start/renew/stop and sender-mute cleanup, moderation and excluded contexts, hard state/recipient caps, and no durable or text-budget effects. Hard ceilings use an isolated authority fixture without reducing production limits; HTTP authority tests use real SQLite and actual SSE streams.

Existing Nearby text, metadata-refresh, proximity and media suites remain required regression checks. This contract does not certify personal-block parity, bots, streaming answers, production deployment, or a live source installation.
