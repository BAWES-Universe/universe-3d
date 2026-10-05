# Furniture workshop

A fresh implementation of the surviving Universe asset-workshop specification, now connected to room editing. The original workshop implementation and its historical test artifacts were unavailable; this work does not claim to recover them.

## Make a piece for your room

Open **Build → Furniture workshop**, or choose **Furniture workshop** from More or the command palette. Start a chair/table, or start empty and combine boxes, cylinders, spheres and wedges. Every starter is made from independently editable primitive parts, grouped for convenience.

- Select a part on the live 3D canvas or in Your parts. Grouped parts select together; Ungroup exposes each part
- Edit exact X/Y/Z position and dimensions, change a material or its base color, rotate on any axis, align, duplicate, group or delete. Shared material edits affect every part using it; Separate material gives a selected part its own color
- Drag in Edit mode to move on the X/Z plane without changing height. Grid snapping preserves group offsets. A drag is one undo step; Escape, blur, cancelled pointer capture and a second touch roll it back
- Switch to Camera to orbit or pinch without moving parts. Orbit, zoom and Frame asset buttons also work without gestures
- On the canvas, arrows nudge; Shift+Up/Down changes height; R rotates Y; D duplicates; Delete removes; Enter places a preview. Ctrl/Cmd+Z and Shift+Z undo/redo; Ctrl/Cmd+S saves to the room
- Save JSON exports an editable composition. Open JSON validates the entire file before replacing the draft. Unsupported keys/formats, embedded code, URLs and arbitrary mesh data are rejected

**Save furniture** publishes an immutable, room-scoped revision. **Place in room** returns to the normal room editor with a live placement preview. Click/tap to place, or use arrows and Enter. Rotate, move, duplicate, undo and Save room work through the same collaborative scene protocol as other furniture. Saving a definition does not itself place it.

To revise a placed piece, select it and choose **Edit furniture source**. Save creates a new source revision. Existing placements retain their old revision. Use **Update placed copy**, then Save room, to explicitly update the selected instance.

The saved library is shared with authorized people in the room. Owners, admins and room editors can publish/edit/archive definitions. Personal-space builders can place existing definitions only where their current permissions allow their entire footprint. Archiving hides a definition from new placement; already-saved instances retain their exact revision. Source edits use compare-and-swap revisions. A conflicting save keeps the local draft for export, reopening the current source, or Save as new copy.

A lost save response keeps the exact operation for Retry save, preventing duplicate publication. Unsaved drafts are tab-local and prompt before refresh or room travel; explicit JSON export is the portable recovery copy.

## Format and geometry

`modules/asset-workshop/model.js` implements strict `universe-asset-workshop` version 1 documents. It accepts exactly the primitive/material/group schema in the original integration specification. Budgets: 256 KiB JSON, 128 components, 32 materials, 64 flat groups, 65,536 triangles, 0.05–32 m positive dimensions, complete rotated extents within ±32 m, normalized quaternions, and 80 undo operations. Validation returns detached data. Group transforms use the mean of component centers.

The room stores a distinct `composition` instance, never an embedded definition or a disguised image. Its fields are exactly `id`, `type`, `name`, `x`, `z`, quarter-turn `rotation`, and `assetRef: {assetId, revision}`. Server-generated IDs and immutable revisions determine identity. Resolved definitions are authenticated room projections outside scene JSON.

Placement is ground-anchored using the complete composition’s minimum Y. The same pure transforms drive native meshes, previews, room boundaries, authorization and walking. Box collision conservatively encloses each solid primitive; elevated solids still block walking in X/Z. Decorative parts count toward edit bounds even when their collision is off. There is no pass-under or exact mesh physics. Materials render base colors; bounded inert texture IDs survive round trips but are never fetched.

Server libraries/instances have additional room-wide byte, triangle, mesh and revision budgets. See [server/FURNITURE.md](server/FURNITURE.md) for exact routes, quotas, receipts, authority fences and storage contracts.

## Compatibility and lifecycle

Legacy saved furniture/image/terrain scenes remain readable. Rooms with composition placements persist a `composition-furniture-v1` reader floor. Older tabs are retired before a composition scene is broadcast; incompatible reads/writes receive Reload required. Deployment storage observation and reader descriptors recognize the same capability and prevent unsafe rollback to an image-only reader.

The workshop owns and disposes its preview engine, scene, meshes, materials and camera controls. The room’s drawing is suspended while the preview is visible; presence, room events and authorization continue. Closing restores the current world state. Role loss disables publication while allowing local JSON recovery.

## Verification commands

- `node --test tests/workshop-model.test.mjs tests/workshop-world.test.mjs tests/workshop-server.test.mjs`
- `npm run build`
- `node tests/workshop.full.mjs`
- `npm test`, `npm run check`, `npm run verify`, `npm run verify:container-files`

New verification artifacts are generated under ignored `evidence/workshop/`. Historical test counts are not evidence for this implementation. Browser runs use the actual game and synthetic accounts on loopback with software WebGL; they do not certify physical iOS/Android devices, performance at full room budget, production load or live deployment.

No marketplace, payment service, AI generation service, texture upload or arbitrary mesh/script import is introduced.
