# Native named arrivals: integration boundary

This increment is separate from the frozen operator release candidate `76b83c34cb2d461523ccb1b3b065c3030104fd28`. The release candidate passed thirteen exact-head CI jobs and excludes this feature. Adding source here does not change an operator deployment pin.

## Working paths

- Full room editors author named/default start regions, stable keys, and item/area destination entries with undo, save and an explicit saved-arrival trial
- The server authorizes a committed doorway and its destination before choosing one bounded, collision/occupancy-aware placement. The client consumes that exact pose and placement identity without local resampling
- Initial plain entry preserves an existing same-account observer placement/consent. Explicit travel relocates; strict current-room resume cannot pull a session back after a sibling tab moves or access ends
- Entry-bearing links, same-room travel and Back/Forward carry the destination key. Ordinary shared links strip invitation/query capabilities and grant no membership
- Landing inside an automatic doorway does not immediately exit. Failed travel likewise attempts only once per physical entry and leaves deliberate retry available
- Held responses are ordered against current scene, access, self-placement and session-room evidence. Failed initialization cleans up only its exact accepted placement; uncertain POST outcomes read current authority instead of blindly retrying travel
- Same-admission reconnect preserves unsaved Build state, conflict recovery, exact embedded forms/history and accepted position. Fresh committed Silent or media denial takes effect while a resume response is held, before the retained editor base is reconciled

## Verification

Focused server tests exercise real loopback HTTP/SSE, SQLite, partial request bodies, restart, crowding, source/destination permissions and same-account leases. An independent review reproduced and verified corrections for buffered same-room revocation and same-cookie later-room travel before a held response. The lifecycle helper has explicit bounded ordering and recovery tests.

Native component tests cover editor keyboard/pointer/touch controls, marker picking/resource stability, landing actions and shared links. Actual bundled-app tests cover named/default admission, canonical item doorway, same-room/history travel, reload, saved-arrival trial, compact Share, denied source recovery, held scene/revocation and retained reconnect. Inert audio fixtures prove local stop/retention lifecycle only; no real camera, microphone, call or media packet claim follows. The existing group test retains every default assertion and provides a separately labeled observer-only replay for initial-entry compatibility.

Final combined aggregate and exact-head remote CI are recorded in `DEVELOPMENT-STATUS.md`; do not infer them from earlier isolated component results. The browser `arrivals` group includes all five new suites.

## Remaining scope

This is a native adaptation of the pinned inline start/exit flow. It does not implement Tiled/WAM import, arbitrary external map URLs, source extensions, general tag-restricted areas, guaranteed paths out of an entry, mathematically exhaustive packing, streamed infinite rooms, or the separately proposed primitive asset workshop. Headless touch emulation does not establish physical-phone acceptance. Provider-backed AV, deployment and whole-source parity remain separate.
