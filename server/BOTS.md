# Local native-3D residents

This is an original, local implementation of the resident-authoring slice. It does not connect the legacy Universe runtime, an AI provider, MCP, external tools, credential storage, or paid services. It neither speaks for an AI model nor adds synthetic people to human conversations, quest participants, membership, or audio/video peer graphs.

## Server integration

```js
import {createBotService} from './bots.mjs';
const bots=createBotService({store,presence,body,send,session,emitRoom,now});
// Authenticated API router, after its session/origin check:
if(await bots.handle({req,res,path,method,userId,session:s}))return;
// Room snapshots (separate from human presence):
const publicResidents=bots.snapshot(roomId);
// On human join/leave, scene edits and policy changes:
bots.reconcileRoom(roomId);
// Service owns an unref'd 100ms timer. For deterministic tests, autoTick:false
// then call bots.tick() after advancing the injected clock.
// Shutdown before closing SQLite:
bots.close();
```

The `bots` SSE event is `{roomId,bots:[publicResident]}`. It is emitted only when the public resident snapshot changes. Consumers replace that room's rendered resident list and must never append it to the real-person presence map. `bots.capabilities(roomId,userId).canManage` is the management capability. Do not derive it from room `canEditScene`: a legacy room-only editor has no bot-authoring rights.

Public residents contain exactly `id`, `botId`, `kind:'bot'`, `roomId`, `name`, `appearance`, `x`, `z`, `moving`, `heading`, `direction`, `status`, `revision`, and `providerStatus:'unconnected'`. No private instructions, permission masks, route, operation receipt or manager settings are copied into public snapshots/events.

## Authenticated API

`GET /api/rooms/:roomId/bot-permissions` is available to any current room-authorized viewer and returns only `{canManage}`. It exposes no catalog or configuration.

All remaining paths below require a current same-origin session and room access, plus universe ownership or world `admin`/`editor` membership. The same authorization is checked again after streaming the body and inside the SQLite write transaction. Cross-world editor roles and legacy room-only roles do not qualify.

- `GET /api/rooms/:roomId/bots` returns `{bots,capabilities:{canManage:true},catalog}`. Disabled residents remain listed. Catalog appearances are exclusively the current original native-3D wardrobe.
- `GET /api/rooms/:roomId/bots/:id` returns `{bot}`. The immutable ID must belong to that room.
- `POST /api/rooms/:roomId/bots` with `{clientOperationId,config}` returns `{bot}` (201 or duplicate 200).
- `PATCH /api/rooms/:roomId/bots/:id` with `{clientOperationId,revision,patch}` returns `{bot}`. Only declared fields can change. Nested values such as appearance, spawn, permissions and route are replaced as complete values; omitted fields persist.
- `DELETE /api/rooms/:roomId/bots/:id` with `{clientOperationId,revision}` returns `{deleted:true,id}`. Deletion leaves a tombstone; retries cannot resurrect it.
- `POST /api/rooms/:roomId/bots/:id/commands` with `{clientOperationId,command}` accepts the local `pause`, `resume`, and `return` abilities only. Returns `{accepted:true,id,command,providerStatus:'unconnected'}`. These are manager controls, not language-model tools or MCP calls.

Each mutation needs a stable operation ID retained for an uncertain retry. Receipts bind actor, room, action and exact JSON payload. Reusing an ID for different data gives 409 `OPERATION_REUSED`. Retrying a successful operation returns its historical accepted result plus `duplicate:true`, without executing again; the current catalog is authoritative after intervening edits/deletion. A revision conflict returns 409 `BOT_REVISION_CONFLICT` with current manager-visible configuration. Deleted or wrong-room IDs return 404. Saves never upsert an old ID.

A manager can disable a resident even if a later scene edit obstructed its spawn, deleted a restricted area, or otherwise made its old route unusable. Re-enabling requires a valid current configuration.

## Configuration

Flat manager records add immutable `id`, `roomId`, `revision`, `createdAt`, and `updatedAt` to these values:

- `name` (1–60 chars), `enabled` (boolean), `appearance` (validated original `avatar-spec.js` data)
- `spawn:{x,z}` on walkable ground; `radius` 0–100; `responseRadius` 0–20
- `behavior`: `idle`, `patrol`, or `social`
- Ordered `waypoints:[{x,z}]` (at most 64), `speed` .2–4 world units/sec, `pauseMs` 0–60000, `loop` boolean
- `respondToPlayers` boolean, retained for a future provider integration; no conversational behavior is executed while unconnected
- `privateInstructions` (up to 4000 chars): manager-only local storage, not executed, not a credential field
- `permissions:{pause,resume,return}` boolean allowlist for local manager movement controls
- `restrictedAreaIds` optional deny-only area IDs in this room

At most 24 nondeleted configurations exist per room. Unknown fields, arbitrary assets, credential/provider configuration, caller IDs, caller coordinates and external tool names are rejected. There are no external network calls in the resident service.

## Runtime and navigation policy

- One runtime object per immutable ID, independent of the number of visitors/sessions. Enabled residents spawn when at least one real authorized human is present. Empty rooms, archive/access changes, deletes and disables remove runtime residents. Human heartbeat expiry is 60 seconds; the service checks every 100ms.
- Configuration and idempotency receipts are durable SQLite records. Position, path progress, transient commands and pause state are deliberately ephemeral. Reentry/restart begins at the configured home; prior command receipts do not cause reexecution after restart.
- Idle stays home, including zero radius. Social remains stationary and visibly `social-unconnected`; it never emits pretend replies, greetings or engagement. `respondToPlayers` is not advertised as connected social behavior.
- Patrol visits saved waypoint order. It supports loop/nonloop ending and pauses. Moving real visitors within the response radius shorten a waypoint pause; idle visitors do not manufacture conversations. Humans are not solid navigation obstacles. Local `return` moves home and pauses; `resume` restores configured behavior.
- Name, appearance, private-instruction and permission-only edits preserve movement progress. Movement-affecting changes cancel the old route, return home safely, and plan from the new configuration. Disable removes it immediately.
- Ground-plane A* uses .5-unit cells, exact endpoint connectors, an explicit 16000-node budget, conservatively expanded native-model footprints (including rotation), and sampled swept edges. Visibility smoothing cannot cross blocked corners. No path is an explicit `blocked` status with bounded exponential retry up to 30 seconds, not a straight-line/teleport fallback.
- Live scene revision invalidates cached paths and resets the bounded retry. If an edit places a solid obstacle on the resident itself, it stays blocked until geometry changes or is disabled; it never teleports through the obstacle.
- Patrol stays in the assigned circle. After an authorized home/radius edit, return travel may use the circle centered on the new home whose radius reaches its current position; once home, ordinary motion uses the new assigned circle. Restricted zones and walls still apply throughout that transition.
- Explicit restricted zones, personal areas, and tag-restricted areas are deny-only for synthetic residents. A manager's authority does not grant a bot a human identity or personal-area ownership. Full 3D multilevel/navmesh traversal is not implemented.

## Verification and remaining source obligations

`node --test tests/bots.test.mjs` covers management scopes, stream-time revocation, CAS/idempotency/tombstones, wrong-room/foreign appearance rejection, public redaction, spawn/radius/route validation, occupancy/disable/reentry, zero-radius and silent social, patrol/local abilities, route revisions, obstacle navigation/recovery, and restart durability. The protocol fixture has a deliberately test-only actor header and is not part of the production server.

`node --test tests/bots-integration.test.mjs` additionally exercises the real app router with cookie sessions, same-origin enforcement, join/reconnect bot snapshots, public redaction, protected manager routes, revocation, and absence from human/media/quest/DM graphs. The result is recorded in `evidence/bots-http-integration.log`.

These tests are local evidence for parts of source contracts BOT-01..07, BOT-09/11/13/25 and runtime authorization BOT-54. They are not full legacy parity certification. Provider-backed greeting/active approach, social targeting/conversation, provider secret encryption/service-token access, external MCP tools, multilevel navigation, physical-phone/browser support matrices and legacy production-runtime behavior remain unconnected or unverified. Actual app-level verification is separate: `tests/tranche-smoke.browser.mjs` passes creation/save/reload, and `tests/tranche-bots.browser.mjs` passes native3D home/waypoint drag, release-only commit, Escape cancellation and saved route reload. These are local Chromium software-WebGL checks, not a physical-device matrix.

Source contract inputs were the preserved `universe-game-parity/acceptance-groups.json`, `v04-acceptance.json`, and the research bot contracts with their immutable source references. No existing Universe service or immutable checkpoint was changed.

## Editor integration and UI checks

`src/bot-editor.js` imports its responsive stylesheet and exports `createBotEditor({getRoom,getActorId,request,onPreview,onClose,onSaved,host})`. The injected request function receives a parsed JSON body in `options.body`; adapt it if an existing request helper expects a different signature. Omitting it uses same-origin fetch.

Methods `open`, `close`, `setRoom`, `select`, and `save` resolve boolean success. Await `close()` or `setRoom(nextRoom)` before leaving the current room; false means keep the current editor/draft visible and abort navigation. Failed and conflicting saves never imply persistence. An uncertain save retry retains its exact operation ID and payload. Edits made while a CAS is pending are drained serially after the acknowledged revision. For existing records, Close and Back flush pending edits; Reset returns to the accepted configuration. An uncreated resident is different: only the explicit Create button starts a POST. Back, Close, selection and room travel retain its draft in memory for that actor/room, without creating a resident. Reopening first fetches current permission/catalog before restoring it. Discard clears it; reload/sign-out clears memory and the UI warns about this. Account changes invalidate active and cached drafts. An already-requested Create may settle while closing; an ambiguous response retains the exact operation receipt for deliberate retry and cannot be silently reset into a duplicate.

Preview is `{roomId,botId,bot:config|null}` with null `botId` for an unsaved resident. `getIdentity()` returns `{roomId,botId}`, enabling native scene gestures to capture and verify selection identity. `updateMap({roomId?,botId?,spawn?,radius?,waypoints?})` rejects supplied stale room/bot identities, updates the canonical draft, and synchronizes the sidebar/plan. Commit a native-world drag only on release, and cancel it on changed selection/room. `isOpen`, `isDirty`, `isSaving`, and `getDraft` are read-only inspection helpers. `destroy` is final teardown, not a replacement for save-aware Close.

The mini-plan supports pointer and keyboard home/radius/waypoint edits; equivalent labeled numeric fields and route insert/move/remove controls remain available on narrow screens. Player movement and unrelated interaction remain blocked while the editor is open; explicit native resident handles and camera controls remain usable. Local command retries bind their room and bot, and runtime command errors are not mislabeled as CAS conflicts. Private instructions warn against passwords/API keys and are labeled stored/inactive while unconnected.

Run `node tests/bot-editor.browser.mjs` from the project root. It bundles only an isolated fixture in memory, uses controlled protocol responses, and does not modify shared `dist` or invoke WebGL. The final run passed 21 checks with zero page errors, including repeated/in-flight/uncertain saves, failure/conflict recovery, stale catalogs and gestures, ordered routes, native wardrobe form data, exact role denial, deletion, and 320px layout. `evidence/bot-editor-checks.json`, `bot-editor-desktop.png`, and `bot-editor-mobile.png` hold the report and inspected screenshots. These fixture checks do not substitute for integrated native-renderer or physical-device verification.
