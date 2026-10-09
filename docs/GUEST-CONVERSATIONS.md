# Public guest conversations

This change restores account-free social participation in admitted public rooms. The server still issues an opaque HttpOnly guest session, authorizes the public universe/world/room hierarchy, enforces bans and admission epochs, and grants no durable ownership or editing rights.

## Player flow

1. Choose **Explore as guest**. No signup is required.
2. Walk near another person and stop. A native bubble forms automatically within the configured distance and capacity. The contextual strip names the participants and offers **Bubble chat** and **Audio / video**. **Walk to [person]** approaches the nearest person when outside a bubble.
3. Bubble chat is live Nearby text, independent of media consent. Its received history stays in the tab and clears on reload; leaving ends that stay. It is not persistent room chat or a DM.
4. Audio / video opens the existing real WebRTC controls. **Join audio** opts into receiving/connecting; microphone, camera and screen sharing each need an explicit device action and browser permission. No device prompt is triggered by entering a room, forming a bubble, or sending text. Walk away to leave the bubble; **Leave audio** stops the media session.
5. Click a resident to check its actual player-text availability. A resident out of reach offers **Walk to resident**. Owner/editor management remains a separate button with the original authorization.

## Express bubble placement

Say, Think and emote bubbles attach to the rendered head silhouette, including hats, body size, elevation, seating and interpolated remote motion. Their tails keep a small CSS-pixel gap above the visible head/nameplate across camera zoom and orbit; the existing nameplate position is unchanged. This removes the former duplicated 2.6-unit height offset. Head geometry and per-frame projection are cached, and stacked expressions reserve each tail's height.

## Defaults and explicit operator configuration

The normal `server.mjs` entry now enables bounded native bubbles and Nearby text when `UNIVERSE_PROXIMITY_CONFIG` is absent. These are explicit 3D product values, not an assertion about 2D coordinate scale or deployed settings:

- 4 participants per bubble, with direct P2P allowed up to 4
- Encounter distance 4 world units; group radius 3; scale 1
- Existing 60-second presence lease, 8 sessions/member, bounded room/account capacity

An explicit config still wins and is strictly validated. Explicit membership/text `enabled:false` retains the existing legacy-media fallback and disables Nearby. That fallback does not have the native membership protocol's full admission/media-scope signal fencing. This PR does not configure TURN/SFU or change deployment files, credentials, public signup policy or private access.

## Bot integration boundary

Public bot chat is a new separate `/api/rooms/:roomId/bots/:botId/chat` GET/POST service. It reuses the credential-free loopback adapter through the trusted `createGameServer({ publicResidentChatProvider: { endpoint, model, timeoutMs } })` option. The endpoint must be literal loopback HTTP with the adapter's fixed `/v1/chat/completions` path. HTTP guests cannot provide a URL/model/credential.

The shipped process entry does not configure this provider. Residents therefore honestly report unavailable until a host integrates an approved local adapter. The manager-only `/turns` harness is not opened to players and is not relabeled as public chat. Public replies:

- Require a live, admitted session, current bot revision, enabled/respond-to-players bot, response-radius proximity and no mute
- Use one bounded provider call, no tools, no manager-private instructions, four global concurrent calls, one per player, six per player per minute and 60 total per minute
- Never write guest profiles or transcripts into SQLite; short-lived bounded replay receipts remain process-local
- Retire on leave, expiry, mute, bot changes or lost room access; do not replay across a different room visit
- Render untrusted model text as text, with no HTML execution or invented tool result

Only a synthetic local provider is used in tests. No live accounts, secrets, paid generation or deployed room mutations were used. Native conversational bot voice is unsupported. Connecting the production bot service/provider is a separate operator integration dependency.

## Actual 2D comparison

Read-only audit: `workadventure-universe` branch `universe-develop` at `6accae707e5a26bc56231ef241c64b397a5cea70`.

- Anonymous identity: `ConnectionManager.ts`, `LocalUserStore.ts`, pusher `AuthenticateController.ts` and `JWTTokenManager.ts` issue/store a guest UUID + signed JWT. Browser-local identity can survive revisits; token expiry is 30 days. 3D currently retains its existing 24-hour process-local cookie identity, which survives reload/reconnect but is lost on restart/expiry. This PR does not claim identical identity durability.
- Admission: `Room.ts` and `IoSocketController.ts` respect optional versus mandatory authentication and the Admin room-access service. Guest access is not universal private-room access.
- Human movement/bubbles/text/A/V: `GameRoom.ts`, `SocketManager.ts`, `ProximityChatRoom.ts`, `SimplePeer.ts` and `MediaStore.ts` have no account gate after admission. Matrix durable chat is separate.
- Bot text: extension `BotApiService.ts`, bot `BotAPI.ts`, `BotClient.ts` and `IdleBehavior.ts` accept guest game identity, conditional on configured bot/provider infrastructure.
- Bot voice: `AIProviderRegistry.ts` explicitly rejects unimplemented Ultravox/GPT Voice providers; `FileParser.ts` does not transcribe audio attachments. Audio-file messages are not native conversational bot voice.

## Verification scope

Real local HTTP/SQLite/SSE tests cover guest/guest text, typing, guest/account media signaling and ICE authority, private-room denial, no durable guest writes, mute, leave/rejoin/reconnect, logout and expiry. Bot tests use an actual loopback HTTP mock provider and real application authorization. Browser tests use the real built source with synthetic denied devices; they do not establish successful cross-network audio/video packets, TURN traversal or physical-device capture.

### Local acceptance result

The full unit suite passed 2,143 tests with one existing skip and no failures. Independent review added guest quest persistence regressions and checked public/private and bot authorization boundaries.

Native Chromium media diagnostics used synthetic audio/video devices, actual `RTCPeerConnection`, guest sessions, HTTP/SSE signaling and the authorized ICE response. Both sides acquired live enabled audio and video tracks. Both received host-only ICE configuration with zero ICE servers, gathered zero candidates, received zero media bytes and displayed the real failure state. No remote tracks were received. A local UDP self-test worked, while network-interface enumeration failed with `uv_interface_addresses` error 1 in this executor. This is consistent with a host-discovery environment restriction, but is not proof of production behavior. Successful calls across normal browsers and production TURN traversal remain acceptance gates; no network/security setting was relaxed.

The placement follow-up passed 81 camera/appearance combinations, eight renderer scenarios, 20 Express component checks and five real bundled-shell checks. Guest and Express acceptance are included in the existing signup/core browser groups. Closing an already closed resident panel is inert, preserving focus during unrelated browser-history navigation.
