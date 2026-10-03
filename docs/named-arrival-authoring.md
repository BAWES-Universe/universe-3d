# Native named-arrival authoring

This editor slice adds native room arrival regions and destination selection. It uses the existing rectangular areas, history, save transaction, and server capabilities. It does not import Tiled/WAM files, external map URLs, source extensions, tag-based area restrictions, or streamed worlds.

## Authoring

Select or place an area, then enable **Allow arrival here**. The area keeps its existing entry behavior, messages, personal-space settings, and ordered actions. An arrival can therefore also be a doorway; gameplay admission and initial exit suppression belong to the authoritative navigation integration.

- **Entry key** is the stable room-local destination key. It is separate from the area's display name. Renaming the display label does not change shared destinations. Keys use `^[a-z0-9][a-z0-9_-]{0,63}$` and must be unique within the room
- **Default arrival** includes that region among the room's defaults. Several defaults are allowed
- Regions must be at least 0.9 × 0.9 metres and entirely inside room bounds. Structural validation runs before save/import and when changing start geometry. The server checks landing safety at save and admission
- Pointer drag moves the region. Arrow keys nudge it relative to the camera; Shift+arrows resize a selected area. These changes participate in the existing undo/redo history. Form inputs retain ordinary native keyboard behavior
- Duplicating a start creates a distinct stable key while retaining its default flag and area behavior. New keys use the area label as a suggestion, remove diacritics, and add a numeric suffix when needed
- Saved start regions have named/default build markers. Their rings and labels do not collide or intercept picking. Gameplay removes these authoring markers

Only full room editors can create, change, remove, duplicate, or restore arrival/area settings. Personal-object ownership is insufficient. The editor rechecks authority on mutation, history operations, save, and the explicit trial callback. The server remains authoritative.

## Destination picker

Ordered teleport actions, legacy portal targets, and primary teleport areas share `src/destination-picker.js`. The room selector takes already-authorized room records; it never discovers rooms by fetching arbitrary URLs. The entry list comes only from `GET /api/rooms/:id/entries`.

Room labels can include universe/world/room hierarchy. Entry labels include the display name, stable key, and default flag. Changing the destination room clears `entry`. Choosing **Default arrival** omits `entry` rather than storing an empty string. A saved key that is absent from the current projection is retained and labeled unavailable, matching the server's default-fallback behavior. A denied or failed list remains a recoverable draft.

Each picker request is fenced by its current owning room, selected item, draft object identity, selected target/entry, and DOM lifetime. Detached callbacks and delayed responses cannot rewrite a newer item or draft. Only concurrent requests are shared; completed entry projections are not cached across subsequent renders.

## Integration hooks

`mountEditor` accepts two optional hooks:

```js
getDestinationRooms: () => [{ id, name, label }]
onTrySavedArrival: async ({ roomId, entry, revision, areaId }) => { /* actual admission */ }
```

When no directory hook is supplied, `destinationRoomsFromWorlds(state.worlds, state.universes)` supplies labels from the existing authorized directory.

**Try saved arrival** is shown only when its callback exists. It is enabled only for a saved selected region, with full edit authority and no dirty/pending/conflicting/saving draft. It becomes disabled while its callback is pending and rechecks context before dispatch. The callback must perform actual explicit server admission. The editor never writes player coordinates or triggers travel from preview.

The reusable picker exposes `mountDestinationPicker({ root, api, loadEntries, getRooms, getValue, onChange, isCurrent, isEnabled, keyPrefix })`, returning `refresh()` and `destroy()`. `getValue` and `onChange` use `{target, entry?}`. Its caller supplies context/authority predicates. `createDestinationEntryLoader` performs validated local requests; `readDestinationEntries` verifies the projection belongs to the requested room.

## Verification

- `tests/destination-picker.test.mjs`: hierarchy labels, projection identity/key validation, bounded local request paths, in-flight deduplication, refresh, and denial recovery
- `tests/arrival-editor.browser.mjs`: native editor start/default/key controls; keyboard and pointer geometry/history; duplicate keys; invalid-save draft recovery; committed trial hook; stale and denied destination lists; ordered/legacy actions; scoped revocation; touch and room replacement
- `tests/arrival-renderer.browser.mjs`: build-only markers, ground/furniture picking, unchanged world data, and bounded resources across repeated syncs
- Existing editor transaction/action/terrain fixtures remain regression checks

The isolated authoring fixture stubs admission and persistence responses. Full server admission, canonical action authority, first presence publication, room history, and sharing must be verified by the combined application tests; these editor fixtures do not certify those paths.

Verified on 2026-10-03 in the isolated authoring checkout: all 30 focused unit tests passed; the native arrival editor (16 checks), existing action editor (15), editor transactions (10), terrain editor (14), and arrival renderer (3) all passed in a serialized Chromium run. The native tests include desktop keyboard/pointer and 390px touch interactions. Captured mobile inspector and desktop marker screenshots were visually inspected. Build, whole-source syntax, and package smoke were also checked; the package serves 91 static files without dependency installation.
