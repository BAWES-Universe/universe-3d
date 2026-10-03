# Proximity text: bounded source contract and standalone slice

Scope: source inspection only, 2 October 2026. Primary source is BAWES-Universe/workadventure-universe at `bae18306bdfa63e58cd4124b1a3b5b290b61c286`; comparison is `0e1ff05014d4b871ffd94eea744e40c1d1c7df79`. All 40 cited/captured files passed Git blob verification; 39 runtime files have identical blobs at both pins. The user-guide file was verified only at the primary pin. This is not deployment, live transport, security certification, or successful browser-test evidence. No application code or frozen publication files were changed.

## Source findings

### Transport, recipients and identity

- Ordinary bubble membership produces server join/leave requests with the group's space name. The frontend's ProximitySpaceManager joins/leaves ProximityChatRoom accordingly. Its default filter is ALL_USERS; camera/microphone consent is not consulted by the message sender. [Group notifications][groups], [frontend membership][membership], [join][join]
- Sending adds a local message immediately, then emits a public `spaceMessage`. Space delegates to RoomConnection, which protobuf-encodes and sends over the room WebSocket. This is not a WebRTC data channel, LiveKit data publication, or Matrix event. [send][send], [Space emission][space-send], [WebSocket][websocket]
- The pusher prefixes the socket's world onto the space name, waits for any pending join, checks the socket belongs to that Space, and sets senderUserId from socket data. The back rejects a text/typing event whose sender is absent from its users and substitutes the current sender's name and character textures. Client-supplied display identity is therefore not the authority for ordinary text. [world scope][world], [membership gate][gate], [sender envelope][sender], [identity replacement][identity]
- The back forwards to the pushers serving that Space. The receiving pusher sends to every locally connected member of that Space except the exact sending spaceUserId, regardless of whether they are watching its user list. Other tabs of the same account are distinct source participants. Frontend registry lookup dispatches only to the matching active Space; ProximityChatRoom checks blacklist, ignores exact self, appends the received message and marks it unread. [back forwarding][back-forward], [recipient fanout][fanout], [registry][registry], [receive][receive]
- Spatial authorization is narrower than “proven tamper-proof bubble membership.” The ordinary flow gets a group name from the server, but the generic joinSpaceQuery accepts a client-provided local name, prefixes the world and calls handleJoinSpace; that handler checks/creates the Space and registers the socket, with no geometric/group-membership validation in the inspected path. The later send gate establishes joined-Space membership, not independently verified distance. Do not copy this as the standalone authorization boundary. [join query][join-query], [join handler][join-handler]

### Payload, limits and capabilities

- SpaceMessage carries text plus optional URL, media/MIME type, filenames and gallery URLs. The wire event has no text-message ID, server timestamp, acknowledgement, edit target, deletion target, reaction or replay cursor. Sender and receivers independently allocate UUIDs and local Dates. [schema][schema], [send][send], [receive construction][received-content]
- No dedicated text character limit or text send-rate limiter was found in the inspected composer → protobuf → pusher → back pipeline. The WebSocket has a 16 MiB maxPayloadLength; this is a transport ceiling, not a reasonable chat limit or proof of the effective limit through every deployment proxy/gRPC hop. Empty ordinary composer text is suppressed, but the transport model itself is a string. [composer][composer], [payload ceiling][payload-ceiling]
- Normal text is rendered through Markdown and an HTML sanitizer; code highlighting and links exist. This is richer than a minimal plain-text adaptation. [renderer][renderer], [sanitizer][sanitizer]
- Proximity remove/edit/addReaction methods are no-ops and canDelete is false; the text message menu is hidden for type proximity. Do not present these as supported. Media-type rows may enter generic menus, which does not implement the missing model methods. [message model][model], [menu gating][menu]
- Files are implemented by the composer despite ProximityChatRoom.sendFiles being a no-op: when room uploads and CDN configuration permit, it uploads through UPLOADER_URL, then broadcasts returned file URLs. It allows up to ten selected files, applies a configured file-size limit, and checks the captured space generation after asynchronous upload. Uploaded-object retention/access/deletion was not audited; “ephemeral text” does not establish ephemeral attachments. [upload path][upload], [file gate][file-gate], [file limits][file-limits]
- Typing is a separate Space event. Composer keydown emits start; idle stop is 10 seconds, and receiver entries expire at 12 seconds even if stop is lost. Received messages and leaving clear typing. Bot streaming responses use a separate event and stop locally on leave. Neither is necessary for the initial human text slice. [typing sender][composer], [typing receiver][typing], [leave][leave]

### History, late joins, leave/rejoin and disconnection

- The guide says only people in the same bubble can see messages, newcomers cannot see earlier messages, messages are “not stored,” and refresh empties chat. The inspected runtime implements live forwarding without a history query, but retains already-received messages in browser-tab memory. Interpret “not stored” as no durable proximity transcript in this path, not zero local history. [guide][guide], [history][history]
- A first-time late join gets current users, not a transcript. Messages received during previous stays remain locally readable after walking away. The UI records start/end markers, per-session unread counts and unsent drafts; ended stays are read-only. Rejoining does not retrieve messages missed while absent. [leave][leave], [thread][thread]
- Local presentation can merge visits into a continuing conversation: shared participant ID or same meeting label within 15 minutes; fallback shared display name within 5 minutes. This is a UI grouping heuristic, not routing authority or recovery of absent-period messages. Drafts may return to the composer for such a continuation and still require a send action. [continuation constants][continuation], [continuation matching][continuation-match], [draft restoration][draft]
- Scene teardown deliberately carries messages, unread counts and unsent drafts into the next scene, including map changes/reconnects. The stash is a module variable, cleared when consumed; full reload clears it. Proximity drafts use memory; persistent Matrix/DM drafts take a separate IndexedDB service path. [carry][carry], [stash][stash], [draft storage][draft]
- No offline mailbox, missed-message catch-up, durable resend queue, server-assigned ordering or delivery acknowledgement was found for this Space event. A closed WebSocket logs and returns, while the message has already been appended locally; that optimistic row is not proof anyone received it. No replay occurs for a new socket merely because old local rows survived. [WebSocket][websocket], [send][send]

### UI and keyboard

- Incoming text opens the chat panel but only selects the proximity thread if no room is selected. It does not explicitly focus the composer. Reading an ended stay is preserved when a new stay appears; a notice offers the live stay. Joining has separate automatic selection/visibility rules, partly conditioned on AV state and breakpoint. [incoming behavior][receive], [selection][selection], [join display][join-display], [thread][thread]
- Composer uses a contenteditable textbox; paste inserts plain text and can stage pasted files. Enter sends, Shift+Enter inserts a newline. Focus sets chatInputFocusStore; the derived input-enabled store disables world controls until focus leaves. No IME composition guard or Escape handler was found in the inspected composer, so those behaviors are acceptance gaps, not established guarantees. [textbox][textbox], [composer][composer], [focus][focus], [movement guard][movement]
- The source captures room plus spaceGeneration at submit time, suppressing asynchronous sends after that destination changes or while joining. Leave increments generation and keeps the old draft with the ended stay. This protects delayed uploads from reaching a later group. It is not a server-verified recipient snapshot. [destination][destination], [leave][leave]

## Separate contracts

- Express Say/Think is avatar state via SetPlayerDetails/SayMessage; emotes and player details are distributed through position-zone listeners. A new zone observer can receive the avatar's current Say state. This is viewport/zone-scoped presence, not the above Space transcript. Never reuse room/viewport Express delivery as proof of bubble text. [Say state][say], [zone fanout][zone], [initial avatar state][say-initial]
- Named meeting text reuses ProximityChatRoom with a meeting flag and named Space; meeting users can be in separated matching areas. Stream/audience chat can use LIVE_STREAMING_USERS. Reusing the class does not make these recipients ordinary spatial-bubble members. Keep this initial slice bubble-only. [named meeting][meeting]
- MatrixChatRoom uses the Matrix client sendMessage API, a paginated timeline and Matrix room encryption state; its invitations, persistent rooms/DMs, offline history, federation and key lifecycle are independent work. ProximityChatRoom explicitly sets isEncrypted=false. Server-relayed text must not be advertised as Matrix or end-to-end encrypted. This audit did not certify Matrix E2EE or resolve every Matrix area-history policy. [Matrix send][matrix-send], [Matrix history][matrix-history], [Matrix encryption state][matrix-encryption], [proximity model][model]

## Proposed smallest coherent standalone slice

This section is a proposal, not observed source behavior or an implemented feature.

Add a separate, default-off proximity-text-v1 route and UI backed by the existing all-member proximity authority. Use conversationRecipients and the authoritative room/bubble/member admission; do not use mediaRecipients, p2pRecipients, mediaScope or enabled as the text eligibility gate. In that authority, enabled means microphone/media consent, so treating it as text permission would wrongly exclude non-consenting participants.

One human plain-text event is sufficient. Suggested policy for a reviewable first version: 1–2,000 Unicode code points and at most 8 KiB UTF-8 after newline normalization, reject whitespace-only bodies, burst 5 with refill 1/second per authenticated account, bounded client transcript of the latest 200 received/acknowledged messages. These numbers are explicit product limits, not source parity facts. No files, Markdown/HTML, typing, bots, edits, deletes, reactions, Matrix rooms, DMs or meeting text in this slice.

Server requirements:
1. Derive identity and display name from the accepted session/current user record. Reject client-selected recipients or forged author fields
2. Revalidate source membership before send, including room authorization, admission, presence lease, bubble and captured membership revision. Snapshot recipients as member/admission identities
3. Revalidate each recipient's live session and membership immediately before emission; a departed/rejoined member or new socket cannot inherit an old delivery. Fail closed on authority errors
4. Return one accepted message ID/time and reconcile sender acknowledgement once. Use bounded in-memory request deduplication for same-session retries; an expired/different epoch must never resend into a new audience
5. Do not persist message bodies in SQLite, localStorage, IndexedDB or ordinary application logs. No replay endpoint or catch-up buffer. A server restart discards transient delivery/dedup state; full browser reload discards the local transcript
6. Multiple live sessions need an explicit adaptation: the current standalone authority groups by account, while source participants are per-tab avatars. Recommended v1: fan out to all currently admitted recipient-account sessions, including a sender-account sibling session only as an explicitly documented own-account copy; independently validate each session. Do not claim source clone parity

Client requirements: separate “Nearby text” label with visible current recipient count; disable sending with no active bubble, during reconnect or expired authority; keep previously received local rows read-only after leave; never auto-send a carried draft or queued submission. Preserve user focus when messages arrive. Enter sends once, Shift+Enter adds newline, composition Enter never sends, Escape returns focus predictably without a send, and typing cannot move the avatar or launch Express. Disclose that the service relays readable text and that no missed messages are recovered.

## Exact acceptance cases for the proposed slice

1. A/B/C share one authoritative bubble with every microphone off: A's message reaches B/C and one reconciled sender row; no permission prompt is needed
2. D is visible nearby but outside that bubble, E is in another bubble, F in another room: none receives A's text
3. C joins after message M1: C never receives M1; C receives a later M2 only after admitted membership is effective
4. B leaves before emission: delivery is dropped. B rejoins with a new admission or reconnects with a new connection epoch: old pending events never appear
5. A submits against an old bubble/member/revision then moves, changes room/status into an excluded context, loses authorization or expires: reject without sending to a new bubble
6. A microphone consent toggle changes media state but leaves the same text audience available; a bubble above the P2P media threshold still gets all-member text without an SFU
7. Forged author name/ID, target list, room or admission is rejected/ignored according to the typed schema; server identity is rendered
8. Newline/Unicode at both length boundaries works; 2,001 code points, over-8-KiB payloads, blank bodies and non-text fields fail. Sixth immediate send is rate-limited; a token becomes available after one second
9. Retry of one request ID in the same valid epoch produces one accepted event/row; a reused ID with different content fails; retries after leave cannot replay
10. Disconnect and send are visibly unsuccessful/unsent; reconnect preserves only local rows already received, never missed remote messages. Full page reload is empty
11. Leave/rejoin preserves read-only locally received rows but sends no old draft automatically; local history trim never changes delivery authorization
12. A member is kicked, deleted or loses private-room visibility between capture and emission: no body reaches that session; authority read failure sends nothing
13. Exercise all live sibling sessions explicitly, including one joining/leaving during send; state the account-level adaptation and prevent duplicate rows per session
14. HTML/script/link payload displays as plain text. Message bodies do not appear in durable DB/storage or expected logs; restart creates no recoverable text history
15. Keyboard/browser tests cover Enter once, Shift+Enter, IME, Escape, Tab, focus restoration, incoming text while another control/thread is focused, avatar movement suppression and no Express launch
16. Feature off leaves existing room chat/DM/Express unchanged; named meeting, Silent/stage/audience and Matrix paths never accidentally receive ordinary bubble text

Remaining gaps: no deployed configuration was examined, no live runtime was executed, no source test suite was run, attachment storage/security was not audited, the generic Space admission path was not proven spatially authoritative, global/proxy rate limits were not established, and keyboard/IME behavior needs browser acceptance. These are explicit limits of this bounded audit.

[groups]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/back/src/Services/SocketManager.ts#L594-L621
[membership]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/WebRtc/ProximitySpaceManager.ts#L10-L39
[join]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Connection/Proximity/ProximityChatRoom.ts#L967-L1034
[send]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Connection/Proximity/ProximityChatRoom.ts#L355-L445
[space-send]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Space/Space.ts#L434-L441
[websocket]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Connection/RoomConnection.ts#L1967-L1977
[world]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/pusher/controllers/IoSocketController.ts#L1156-L1162
[gate]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/pusher/services/SocketManager.ts#L1062-L1073
[sender]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/pusher/services/SocketManager.ts#L1431-L1453
[identity]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/back/src/Model/EventProcessorInit.ts#L5-L31
[back-forward]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/back/src/Model/Space.ts#L402-L408
[fanout]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/pusher/models/SpaceToFrontDispatcher.ts#L405-L416
[registry]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Space/SpaceRegistry/SpaceRegistry.ts#L203-L214
[receive]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Connection/Proximity/ProximityChatRoom.ts#L1051-L1084
[join-query]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/pusher/controllers/IoSocketController.ts#L975-L1002
[join-handler]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/pusher/services/SocketManager.ts#L372-L440
[schema]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/messages/protos/messages.proto#L1035-L1050
[received-content]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Connection/Proximity/ProximityChatRoom.ts#L552-L649
[composer]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Components/Room/MessageInputBar.svelte#L146-L206
[payload-ceiling]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/pusher/controllers/IoSocketController.ts#L217-L230
[renderer]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Components/Room/Message/MessageText.svelte#L14-L88
[sanitizer]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Components/Room/Message/WA-HTML-Sanitizer.ts#L1-L12
[model]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Connection/Proximity/ProximityChatRoom.ts#L92-L153
[menu]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Components/Room/Message.svelte#L196-L205
[upload]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Components/Room/MessageInputBar.svelte#L210-L255
[file-gate]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Components/Room/MessageInputBar.svelte#L421-L438
[file-limits]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Components/Room/MessageInputBar.svelte#L517-L558
[typing]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Connection/Proximity/ProximityChatRoom.ts#L899-L940
[leave]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Connection/Proximity/ProximityChatRoom.ts#L1398-L1507
[guide]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/docs/user/chat.md#L20-L36
[history]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Connection/Proximity/ProximityChatRoom.ts#L149-L205
[thread]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Components/Room/RoomTimeline.svelte#L343-L455
[continuation]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Connection/Proximity/ProximitySessions.ts#L132-L148
[continuation-match]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Connection/Proximity/ProximitySessions.ts#L202-L222
[draft]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Components/Room/MessageInputBar.svelte#L110-L134
[carry]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Connection/Proximity/ProximityChatRoom.ts#L771-L835
[stash]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Stores/ProximitySessionStore.ts#L1-L53
[selection]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Connection/Proximity/ProximityChatRoom.ts#L667-L707
[join-display]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Connection/Proximity/ProximityChatRoom.ts#L1238-L1255
[textbox]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Components/Room/MessageInput.svelte#L23-L100
[focus]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Components/Room/MessageInputBar.svelte#L593-L602
[movement]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Stores/UserInputStore.ts#L14-L47
[destination]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Components/Room/SendDestination.ts#L1-L49
[say]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/back/src/Model/User.ts#L286-L296
[zone]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/back/src/Model/Zone.ts#L121-L160
[say-initial]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/back/src/Services/SocketManager.ts#L409-L424
[meeting]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Phaser/Game/MapEditor/AreasPropertiesListener.ts#L913-L933
[matrix-send]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Connection/Matrix/MatrixChatRoom.ts#L498-L508
[matrix-history]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Connection/Matrix/MatrixChatRoom.ts#L452-L472
[matrix-encryption]: https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Chat/Connection/Matrix/MatrixChatRoom.ts#L126-L133

