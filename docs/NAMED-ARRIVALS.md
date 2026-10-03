# Native named arrivals and room travel

This standalone 3D feature adapts the pinned WorkAdventure inline start/exit flow. It does not load Tiled/WAM maps, extension modules or external destination URLs, and does not add general area read/write restrictions, infinite terrain or a primitive/composite workshop.

## Shared scene and action contract

An ordinary area may independently carry `start: {key, isDefault?}`. The area retains its `id`, display `name`, geometry and existing behavior. The stable room-local key matches `/^[a-z0-9][a-z0-9_-]{0,63}$/`; it is deliberately separate from the display name, unlike the upstream name-based destination. Multiple defaults are allowed. Removing `start` removes that entry. Duplicate keys, unknown start fields, nonboolean default flags, starts smaller than 0.9 × 0.9 metres, and starts extending outside room bounds are rejected.

Teleport actions keep the existing `target` room ID and accept optional `entry`. Legacy object targets and legacy teleport areas also accept `entry`. Omit `entry` for default arrival; `''`, `null`, URL fragments and arbitrary URLs are not entry keys. Starts cannot be authored through personal object ownership: only full scene editors may change room layout, area settings or the legacy spawn. A personal object editor may still author ordinary object travel actions inside their own area.

`src/arrivals.js` exports `ENTRY_KEY_RE`, `ARRIVAL_LIMITS`, `validateEntryKey`, `validateStarts`, `entryCatalog`, `arrivalCandidates`, `resolveArrival`, and `validateArrivalGeometry`. Structural helpers throw errors with a `code` and readable message. Geometry uses the existing `canStand` implementation with current server-resolved image metadata, rotated built-in collision boxes and terrain blockers. Collision behaviour remains that of the native game; this is not a new arbitrary-angle hull system.

## Read and admission API

`GET /api/rooms/:roomId/entries` rechecks room, parent, membership, archive and ban visibility. It returns only:

```json
{"roomId":"other","revision":4,"entries":[{"key":"cafe","areaId":"welcome","name":"Café welcome","isDefault":true}]}
```

It does not grant access or expose private room/parent data. Ordinary shared destination links are separate from membership invitations.

`POST /api/rooms/:roomId/join` accepts `{entry?, mode?, sourceAction?}`. It rejects extra fields, so caller coordinates and server-owned arrival identifiers cannot be supplied. Bodyless legacy POST remains supported.

- `mode: 'travel'`: resolve a fresh arrival, including same-room travel
- `mode: 'enter'`: modern default entry for a new/entering session. Preserve the destination account’s accepted placement when another session remains there, including that sibling’s existing follow/media consent; otherwise resolve normal default/spawn. Retire only the entering session’s previous admission and atomically enable its modern movement guard. Cannot carry entry or sourceAction. A separately logged-in observer therefore joins without relocating its controlling sibling
- `mode: 'resume'`: require that this session is still admitted to the requested room, then retain its live accepted position or resolve a new placement if that room’s presence expired/disappeared. A different/null current room fails with HTTP 409 `RESUME_CONTEXT_CHANGED`, including a kick or travel after a client state check. Initial default entry uses enter; explicit destination travel uses travel. Cannot be combined with entry or sourceAction
- Omitted mode: legacy leave/rejoin semantics, including retirement of the joining session's controls. With an existing destination sibling session, preserve the account's existing accepted position. Supplying an entry or sourceAction is explicit travel

A saved travel action supplies `sourceAction: {roomId, revision, entityType, entityId, actionId}`. The server re-resolves its committed action under current session, source revision, position/distance and destination authorization. The URL room must match the saved target. A supplied entry must match the saved entry. The saved entry is used when the request omits it. This is distinct from a deliberate direct destination join. The existing `/actions/resolve` endpoint remains a canonical descriptor, not a transferable authorization grant.

A successful join or resume response includes the accepted placement beside its room snapshot:

```json
{"arrival":{"x":-8.2,"z":-2.4,"requestedEntry":"cafe","entry":"cafe","areaId":"welcome","source":"named","fallback":null,"resumed":false,"admissionId":"opaque-id","admissionEpoch":"server-process-id","admissionRevision":7}}
```

`source` is `named`, `default`, `spawn` or `resume`. Unknown well-formed entries use normal default/spawn resolution with `fallback: 'unknown-entry'` and retain `requestedEntry`. Malformed keys reject. A recognized blocked/crowded entry fails within that region; it never silently moves to a different entry.

Ordinary GET room snapshots do not include an arrival. To recover placement, read the session's current room and request strict resume; a concurrent room change makes that resume fail rather than travelling back. The exact same x/z and admission identity fields appear on the actor's first destination presence and the successful admission response. Clients must render this accepted position without a second local spawn sampler. `admissionId` is a placement identity, distinct from proximity membership `memberId`. Resume does not rotate it. `admissionRevision` increases strictly for each new placement within a server-process `admissionEpoch`, even when timestamps tie. SSE `hello.arrivalEpoch` announces that stream’s process scope. Clients buffer authoritative self-presence during pending travel and reconcile only strictly newer placement revisions within the same epoch. On a new epoch, discard old ordering and reconcile a fresh current-room snapshot/join; never compare revision numbers across processes. After explicit travel, resume or modern default entry, movement must supply it; old identifier-less clients remain supported only on legacy admissions. A legacy sibling rejoin cannot downgrade a protected placement. Movement-protocol opt-in is stored per authenticated session in a small SQLite guard table with a foreign key to the session. It survives placement TTL cleanup, subsequent room joins and process epochs, and is inherited by current destination sibling sessions when the shared actor is protected. Guard rows are removed with expired/deleted sessions; legacy-only sessions remain identifier-optional. Position and ordering records remain ephemeral. Every movement request also captures session epoch and placement identity before consuming its body, including legacy requests. In-flight movement cannot rebind itself to a new arrival by changing the last part of its JSON body. An expired or missing placement returns HTTP 409 `POSITION_UNCONFIRMED`; resume the current room or reconnect the event stream to obtain a newly resolved placement before sending movement again. SSE re-publication checks admission capacity and collision before opening the stream.

Authorization and bounded placement finish synchronously before source retirement or destination publication. Concurrent requests observe earlier accepted occupancy. Target failure preserves the previous room, position and follow relation. Explicit relocation of an already-present account in the destination retires that destination actor's admission through the existing presence/media lifecycle, including all destination-session control fences. It stops prior following/leadership and media consent without moving any other person. Cross-room source siblings keep their own source admission unless their controlling session leaves. Resume keeps accepted consent. Delayed action, control, presence and media-state bodies are fenced against the retired admission.

## Conditional cleanup after client initialization failure

The existing `POST /api/rooms/:roomId/leave` accepts optional expected placement fields `{admissionId, admissionEpoch, admissionRevision}`. All three are required together; unknown fields and actor overrides reject. A matching cleanup returns `{ok:true, applied:true}` and retires only that authenticated session through the normal leave lifecycle. Duplicate cleanup, an expired/missing placement, a different current room or a changed placement returns `{ok:true, applied:false, reason:'placement-changed'}` without participant, resident, media or consent mutation. Expired identity or denied room access still returns the normal authorization error.

The server captures current token and placement identity before consuming the body, then checks it again against fresh authenticated session/placement state. An unfinished cleanup body cannot be rebound to a newer arrival by replacing its final identity fields. Even a same-placement legacy rejoin with an account sibling changes the session fence and declines the older cleanup. Existing bodyless and empty-object leave requests keep their ordinary `{ok:true}` behavior.

Clients use this conditional form only when a known successful admission subsequently fails local initialization. A failed target authorization never calls it. This API does not make a successful but delayed join response safe to consume after a later scene/revocation event; the shell still has to enforce its response/event ordering.

## Native placement bounds

All constants are world metres, not pixel conversions:

- Avatar collision radius: 0.35 m
- Named region inset on each side: 0.45 m
- Minimum separation from other currently admitted human centres and predicted resident centres: 0.8 m. Resident projection uses current runtime position or enabled dormant spawn; when sole-actor same-room retirement resets runtime, it predicts the configured spawn. Projection never activates or publishes a resident on failed admission
- Named region candidate budget: 257 fixed low-discrepancy samples, including centre, visited in a seed-dependent order
- Legacy spawn budget: centre plus 256 bounded spiral candidates, at most 8 m from spawn

Named entries take precedence. Otherwise all configured defaults are eligible; a seeded order starts with one default and checks the remaining defaults if necessary. With no defaults, legacy spawn is used. A valid geometry slot occupied at every tested candidate produces `ARRIVAL_OCCUPIED`; no valid sampled geometry produces `ARRIVAL_BLOCKED`. Both are HTTP 409 on admission and include bounded `attempted` metadata. Sparse sampling may miss a tiny valid pocket and deliberately fails closed. It does not guarantee mathematically exhaustive packing or a route out of a region. Existing image/terrain/wall route checks remain independent.

Scene save and creation validate every named region with the same deterministic candidates and canonical geometry, without transient occupancy, and require a usable normal default/spawn resolution. A saved edit cannot silently invalidate all tested landing points of a named entry. Runtime admission still checks geometry because legacy/external persisted state can differ. Process restart ends in-memory placement identity; the next arrival is resolved again from persisted scene state, while a modern session retains its movement-protocol guard.

## Source evidence and deliberate differences

Pinned source: `BAWES-Universe/workadventure-universe` commit `bae18306bdfa63e58cd4124b1a3b5b290b61c286`.

- [StartPositionCalculator.ts](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Phaser/Game/StartPositionCalculator.ts): named starts, default region collection and fallback. Named inline sampling uses a pixel margin; the source default helper has its own default margin. Neither establishes native collision/occupancy safety
- [entry-exit.md](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/docs/map-building/inline-editor/area-editor/entry-exit.md): inline starts, destination start selection and distribution over a region
- [GameScene.ts](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Phaser/Game/GameScene.ts): same-room/cross-room transition and failed target resolution
- [TeleportPropertyEditor.svelte](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/external-modules/teleport/TeleportPropertyEditor.svelte): actual extension configuration is `url` plus optional `startArea`; its README's mandatory hierarchy-fields claim is not the pinned runtime contract. Native room-ID selectors are an adaptation

## Verification

`tests/arrivals.test.mjs` checks key/schema boundaries, precedence, every default's eligibility, native bounds, rotated furniture/image/terrain collision, finite crowd failures and spacing. `tests/arrivals-http.test.mjs` uses real loopback HTTP, SSE, SQLite and partial streamed bodies for persistence/restart, first-publication agreement, concurrent arrivals, authorization/revision/revocation races, personal ownership, resume/travel semantics, legacy clients and stale sibling-controller fencing. Existing group HTTP tests compare unchanged accepted positions instead of assuming all arrivals overlap at (0,0). Native editor/browser walkthroughs are separate integration verification.
