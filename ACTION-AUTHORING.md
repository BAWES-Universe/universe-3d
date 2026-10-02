# Ordered functional actions

## Source-grounded scope

This tranche implements ordered authoring for objects (EDIT-04) and area extras (EDIT-13), including audio URL/label/volume (EDIT-17) and link tab/panel, size and closability settings (EDIT-18). It does not establish full parity for these contracts. Actual provider authentication, iframe policies, media transport and physical-device behavior need separate runtime evidence.

Baseline: BAWES-Universe/workadventure-universe at `bae18306bdfa63e58cd4124b1a3b5b290b61c286`.

- [Named objects and action menus](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/docs/map-building/inline-editor/entity-editor/index.md#L17-L41)
- [Multiple links and sounds on areas](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/docs/map-building/inline-editor/area-editor/index.md#L23-L43)
- [Audio URL, volume 0–1, optional label](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/docs/map-building/inline-editor/area-editor/play-sound.md#L19-L22)
- [Tab/panel, trigger, size and closability](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/docs/map-building/inline-editor/area-editor/open-link.md#L20-L22)
- [Loop and user-volume cap](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/docs/map-building/tiled-editor/special-zones.md#L44-L60)

The candidate uses rectangular areas, explicit array order, stable action IDs and a 30–90% panel-width range. Those numeric UI bounds are candidate design choices, not source-specified limits. New actions use deliberate interaction by default; areas can opt into entry activation. Message and room travel are existing candidate actions, not provider integrations.

## Data contract

`src/action-schema.js` is shared by authoring, validation and runtime consumers. `actions` is an ordered array of at most 20 entries. IDs are unique within one object or area.

Shared fields: `id`, `type`, optional `name`, `description`, `trigger` (`interact` or `enter`; objects permit only `interact`).

- `message`: `message`
- `link`: `url`, `label`, `mode` (`tab` or `embed`), `width` (30–90), `closable` (boolean)
- `audio`: `url`, `label`, `volume` (0–1), `loop` (boolean)
- `teleport`: `target` (room ID)

IDs and types are validated, unknown fields rejected, order preserved. Metadata cannot carry permission grants, credentials, or attached protected bytes. The server remains the authority for room and document access.

### Compatibility

`itemActions(item)` never mutates its input. When an object has no `actions` array, existing `target` and `url` become stable `legacy-target` and `legacy-url` actions. On the first ordered edit, `materializeItemActions` copies these into an explicit array. An explicit array, including `[]`, is authoritative, preventing a deleted legacy action from reappearing. Existing URL, document metadata and target fields remain intact for export. Legacy editor fields and document attachment synchronize their matching explicit legacy action.

Area primary semantics (`action`, `message`, `url`, `target`) remain intact. `area.actions` is the ordered additional list. `legacy-area-link`, `legacy-area-target` and `legacy-area-message` are reserved IDs to avoid collisions with primary-behavior resolvers.

### URL safety

`safeActionUrl(value, baseOrigin?)` returns `{url, kind, protocol}` or `null`. Kinds are `external`, `asset`, and `document`. Only HTTP(S) and safe local paths are accepted. Credentials, sensitive token/password query or hash parameters, control characters, backslashes, protocol-relative paths and encoded local traversal are rejected. Local `/api` routes are rejected except the exact protected attachment route `/api/rooms/{roomId}/files/{fileId}`. Protected attachments are download-only, never embedded or used as audio. Passing `location.origin` also classifies absolute same-origin URLs under the local restrictions.

## Editor behavior

Both objects and areas have add, move-up, move-down and delete controls. Stable field identities retain focus through reorder and field updates. Boundary reorder controls remain keyboard-focusable with `aria-disabled`, avoiding loss of focus when an action reaches the first/last position.

Text edits are flushed before save, selection or inspector rebuild; Ctrl/Cmd+S works from focused fields without letting movement shortcuts consume text. A pending edit enables Save. Mutation history preserves full arrays. Room attachment invalidates detached field callbacks and in-flight save responses.

Optional `editPolicy(state)` allows scoped building without granting whole-room edit rights. It returns `{canEdit, canEditItem(item), validateChange(before, next)}`. The latter returns `null` for an allowed diff or an explanatory error string. Room settings/area creation/import stay full-editor-only, and every mutation and save is checked. Server authorization must enforce the same scope; this callback is a UI guard, not a permission grant.

## Focused evidence

- `tests/action-schema.test.mjs`: accepted fields/order, legacy compatibility, malformed/forged fields, unsafe URL and same-origin API handling
- `tests/action-persistence.test.mjs`: real API save, late-join reads, unauthorized writes, stable action IDs/order through SQLite restart
- `tests/editor-actions.browser.mjs`: isolated real-browser authoring, duplicate field identity, settings, reorder/delete undo and focus, input flush, unsafe save recovery, multi-action areas, stale fields/saves and limited-policy guards
- `tests/editor-transactions.browser.mjs`: existing direct-manipulation transaction regressions
- `evidence/editor-actions-checks.json`: latest focused browser results
