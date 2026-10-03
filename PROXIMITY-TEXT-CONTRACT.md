# Nearby text: standalone opt-in server contract

This bounded increment maps to `U3D-PAR-CHAT-PROXIMITY` without certifying that whole contract. Immutable source citations are preserved in `PROXIMITY-TEXT-SOURCE.md`. It is the plain-text adaptation of the source audit at `bae18306bdfa63e58cd4124b1a3b5b290b61c286`. Source proximity text is server-relayed, independent of microphone consent, with only already-received browser-tab history and no missed-message replay. This server slice is not Matrix, E2EE, persistent room chat/DM, avatar Express, named meeting chat, a media transport, or source clone parity.

## Activation and scope

The factory accepts `proximityTextConfig: {enabled: true}` only with a valid explicitly configured `proximityMembershipConfig`. No environment variable or process default enables it. Existing media/ICE routes retain their consent and session protections. `media.proximityTextPolicy(acceptedSession)` delegates to the existing all-member authority; there is no room-wide or legacy-media fallback.

Audience comes solely from authoritative `conversationRecipients`, plus sender-account sibling sessions as an explicit standalone own-account-copy adaptation. Account membership counts once; all captured live recipient sessions/streams are checked separately. The initiating SSE stream receives its HTTP acknowledgement, with no SSE echo to that exact stream. Sibling tabs sharing the same cookie/session and other authenticated sessions of the same account receive `ownAccountCopy: true`. Multiple streams on a recipient session each receive at most one event, carrying the same message ID but their own epoch. Clients deduplicate their rows by message ID.

Silent, named meeting, stage/audience and excluded account statuses cannot send/receive ordinary bubble text. A room chat mute also blocks sending in this standalone adaptation; it does not block receiving or change membership. No microphone/device permission, P2P grant, enabled-media flag, media scope or SFU availability is a text eligibility gate.

## HTTP and SSE

All routes require the accepted HTTP-only cookie session and existing origin/security checks. Connection epochs are public freshness evidence, not bearer credentials.

- `GET /api/proximity-text?connectionEpoch=<epoch>` returns a fresh context belonging to that session's live SSE stream and also publishes it on that stream. Open `/api/events` first and use its latest `proximity-text-context` epoch. When the feature is off, discovery returns `{protocol:"proximity-text-v1",available:false,canSend:false,reason:"disabled"}` without requiring an epoch.
- `POST /api/proximity-text/messages` accepts exactly `{requestId,text,connectionEpoch,roomId,bubbleId,memberId,membershipRevision}`. IDs/revision must come from the current context. Request ID is a 1–80-character ASCII alphanumeric/underscore/hyphen string. Unknown fields, recipient overrides, author overrides, attachments and non-string text fail validation.
- First acceptance returns HTTP 201 `{message,duplicate:false}`; an identical valid same-session retry returns HTTP 200 `{message,duplicate:true}` without emitting again. A conflicting request ID returns 409. Acceptance records local server acceptance, not proof that another browser displayed it. A zero-recipient/disconnected audience has no mailbox or replay.
- `proximity-text-context` SSE carries the context directly. `proximity-text-message` SSE carries the message directly, not a `{message}` wrapper. There is no event ID/replay cursor, transcript GET, edit/delete/reaction/typing endpoint or server catch-up queue.

Context shape:

```json
{"protocol":"proximity-text-v1","contextRevision":42,"available":true,"canSend":true,"reason":null,"selfId":"account-id","roomId":"room-id","connectionEpoch":"uuid","bubbleId":"authority:bubble:1","memberId":"authority:member:2","membershipRevision":3,"conversationRecipients":[{"accountId":"other-account","memberId":"authority:member:4"}],"recipientCount":1,"limits":{"maxCodePoints":2000,"maxBytes":8192,"burst":5,"refillPerSecond":1,"history":200}}
```

`contextRevision` increases monotonically for all contexts in one server lifetime. Within the current EventSource generation, a client must ignore older GET/SSE revisions; reset the comparator when establishing a new EventSource. The server sends the latest receiver context immediately before its message on the same stream. No-bubble contexts retain trusted self ID/current room/epoch; an admitted solo player can still have a member ID while bubble/revision are null. Reasons are `null`, `no-active-bubble`, `muted`, or `authority-unavailable`. Failure contexts preserve self ID and a fresh epoch but clear room/member/bubble/revision/audience. Disabled discovery is the separate `disabled` reason above.

Message shape (ack and receive use the same fields):

```json
{"id":"server-uuid","requestId":"client-id","createdAt":1800000000000,"roomId":"room-id","bubbleId":"authority:bubble:1","membershipRevision":3,"fromMemberId":"authority:member:2","author":{"id":"account-id","name":"Current server name","appearance":{"version":1,"catalog":"universe-original-v1","body":{"height":"average","build":"balanced"},"skin":"#e6b68b","hairStyle":"sweep","hairColor":"#252237","eyeColor":"#252237","topStyle":"jacket","topColor":"#8570c9","bottomStyle":"pants","bottomColor":"#303449","shoeStyle":"sneakers","shoeColor":"#f2e9d9","hat":"none","glasses":"none","bag":"none","headphones":"none"}},"text":"Plain text only","recipient":{"connectionEpoch":"recipient-stream-epoch","memberId":"authority:member:4"},"ownAccountCopy":false}
```

Author ID/name, message ID and millisecond timestamp are server-derived. The additive `author.appearance` field is the current normalized public wardrobe snapshot from the stored profile at acceptance. Only `{id,name,appearance}` is projected; username, account flags and raw legacy wardrobe fields are not sent. Receipt retries retain the originally accepted appearance even if the sender later changes wardrobe. For an acknowledgement `recipient` identifies the sending stream/member; for an SSE message it identifies the actual receiver's captured stream/member. A client must reject incoming text whose room/bubble/revision/recipient epoch/member no longer matches its current context. Sender identity must still match its conversation recipients, or itself for an explicit sibling copy. Render `text` literally, never as HTML/Markdown.

## Freshness and bounded memory

Before waiting for request bytes, the server captures the current sender room/bubble/member/revision, its available stream epochs, and each actual recipient session/stream/epoch. Supplying replacement envelope fields after a sender leaves/rejoins cannot rebind the held request to a new epoch, even when a sibling keeps its account member alive. After reading, it revalidates the live sender session, room, admission, membership, ACL, presence and mute. Any body-time change to the captured audience revision rejects sending. A sibling stream/session arriving during the body wait is excluded even when account-level membership stays unchanged.

Each captured target is revalidated immediately before its actual synchronous body emission. Revoked/expired/left/rejoined sessions and replaced streams are dropped. Late joins are never added to a captured batch. A changed sender membership revision stops delivery to later targets; there is no new-audience fallback. Authority read failures before emission send no body; failures during fanout stop subsequent delivery. Previously emitted bytes cannot be recalled. No asynchronous emission callback, body queue or retry pump is stored.

Connection epochs rotate on SSE reconnect, room leave/rejoin, own member/bubble/context changes, and after two minutes or 128 accepted receipts. Routine bounded-cache rotation alone does not end the visible conversation stay or discard local received history/draft; it only replaces send/delivery freshness. Microphone toggles do not rotate a text epoch. Old submissions never get rebound to a new epoch. A retry after epoch expiry fails; the UI retains an unsent draft and requires a new explicit send rather than automatically rewriting its authority fields.

The in-memory receipt cache stores only request-body hashes and acknowledgement metadata, never text. It is capped at 8,192 global entries; entries expire with their bounded connection epoch. Full capacity fails closed rather than evicting valid receipts and allowing duplicate emission. Account token buckets are bounded to 4,096, burst five and refill one token per second, shared by sibling sessions; retries do not consume tokens or emit again. Server restart discards all receipts/rates and cannot recover text.

Policy limits are local product choices, not source-parity claims: 1–2,000 Unicode code points, at most 8 KiB UTF-8 after CRLF/CR normalization to LF, reject blank/unpaired-surrogate/control-character bodies; 32 KiB maximum JSON request and eight-second body deadline. Whitespace within a nonblank message is preserved. Maximum UTF-8 size is also checked even though 2,000 valid Unicode scalar values cannot exceed 8,000 bytes. The proposed client history limit is the latest 200 acknowledged/received rows in memory only. The server neither stores nor enforces a client transcript.

## Browser-tab behavior

Nearby appears inside Chat only after an enabled authoritative context arrives. Room/Direct modes remain separate. Incoming messages update unread state without switching away from a focused conversation or form. The label lists the current authorized recipient count. Historical rows retain the sender's accepted name/3D appearance snapshot.

The latest200 acknowledged/received messages across stays, unsent drafts and unread counts live only in module memory. Leave keeps the prior stay read-only; a visible control selects the current live stay. The source's15-minute/5-minute continuation-grouping heuristics are not implemented in this slice. Room/bubble/member identity creates separate stays. Connection-epoch rotation alone keeps the same stay, rows and draft. Reconnection loads no missed text. A full reload or account change erases Nearby history.

Unknown/malformed protocol fields, retired membership, a switched account, an unexpected room, disconnected transport and explicit not-ready state deny current sending. Every EventSource callback is bound to the current stream and account; an old stream cannot reopen the UI's authority. Navigation drops received bodies while buffering only the latest context for validation after the committed destination arrives.

Only a verified HTTP acknowledgement adds the sender's row. Ambiguous failure exposes an explicit same-request retry; there is no automatic retry or audience rebinding. Changed connection/audience retires an unresolved attempt and keeps the draft. A new deliberate edit/send is required. Acceptance does not establish that another browser displayed the message.

Enter sends once, Shift+Enter inserts a newline, and IME composition Enter does not send. Incoming updates preserve editing focus/selection. Escape closes the panel and returns to its dock control. Short-height Nearby views scroll with a retained Close header; switching modes resets that outer scroll. Text is rendered literally, with no Markdown/HTML, external link preview or embedded media behavior.

## Verification boundary

`node --test tests/proximity-text-http.test.mjs` uses real local SQLite, loopback HTTP and SSE. It covers all-member/microphone-off and above-mesh routing, schema/Unicode/rates, same-session receipts, late joins/no replay, delayed-body room/status/expiry/ban/presence/mute changes, excluded areas, sibling admissions/reconnects, receiver expiration/revocation at actual emission, epoch ownership/order, authority failure and no DB transcript across restart. Existing proximity/ICE/media suites remain separate regression checks.

`tests/proximity-text-client.test.mjs` covers the tab-memory controller. `tests/proximity-text-client.browser.mjs` covers native controls in a module fixture; `tests/proximity-text.full.mjs` exercises the actual bundle and live local HTTP/SSE service with two authenticated browser contexts. `DEVELOPMENT-STATUS.md` records which final checks passed. These tests do not establish physical-device acceptance. Attachments, Markdown, bots, typing, edits/deletes/reactions, named meetings and Matrix/E2EE remain explicit later gaps. No production deployment, external provider, credential, network-security change or GPU was used.
