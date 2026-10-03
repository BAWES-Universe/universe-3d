# Native terrain cells

Terrain is an optional layer of the existing native 3D scene. It is separate from furniture instances, image definitions and areas. This is a bounded authoring extension informed by layer/collision concepts; it does not import Tiled maps or introduce infinite chunks.

```js
scene.terrain = {version: 1, cells: [[-2, 3, 'water', true], [0, 0, 'wood', false]]};
```

Each tuple is `[worldX, worldZ, material, blocked]`. Integer coordinates identify a one-metre cell's lower corner, including negative coordinates. Its visible/collision centre is `(worldX + .5, worldZ + .5)`. The full footprint must fit within the room's centred bounds. Materials are `grass`, `soil`, `stone`, `wood`, and `water`; collision is always an explicit boolean. Water's authoring default may be blocked, but its material does not force collision.

There may be at most 4,096 unique cells. Validation rejects malformed tuples, unsupported versions/materials, non-integer/non-finite coordinates, non-boolean collision, extra terrain fields, duplicate coordinates and footprints outside bounds. Terrain remains subject to the existing scene-wide 512,000-byte and 40,000-value JSON limits. It persists in the existing scene JSON under the existing room revision CAS; there is no database migration. Legacy scenes remain unchanged and need no terrain field.

## Shared API

- `terrainCell({x,z})` floors a ground point to a lower-corner cell
- `terrainRect(fromCell,toCell)` returns inclusive `{minX,minZ,maxX,maxZ}` in either drag direction
- `applyTerrainRect(terrain,rect,{material,blocked,erase=false})` returns a new deeply frozen terrain value, ordered by z then x. It repaints intersected cells, preserves outside cells, or erases to the original base floor. Rejected operations leave input unchanged
- `validateTerrain(terrain,bounds)` returns its input or undefined for a legacy scene, and otherwise throws an error with code `INVALID_TERRAIN`. It does not normalize or mutate input
- `terrainCollisionBoxes(terrain)` returns the blocking cells as centred one-metre boxes
- `terrainBlocks(scene,x,z,r=.3)` tests conservative square-body overlap with inclusive boundaries, matching existing player collision

Terrain values have a replace-only contract. Use `applyTerrainRect`, a fresh decoded import/reload, or a previous immutable value for undo. Never mutate the cells of a terrain value after using it for collision. The collision index is a WeakMap keyed by terrain identity; normal queries inspect only nearby integer cells rather than all 4,096 cells. New edit/import/undo identities select the correct index. The model tests prove repeated queries do not reread the cell array and replacement removes stale blockers.

## Authority and navigation

Full room editors can change terrain. A personal-area owner's scoped object permission does not grant terrain permission. Ordinary walls remain furniture objects and retain existing scoped object authority.

The server's `validateTerrainSceneDelta` runs synchronously inside the existing scene CAS transaction, after current session/room/scoped-object and pinned-image validation. It independently checks full-scene permission for terrain changes. Newly blocked cells and new/moved/resized wall footprints must leave the arrival's .75-metre margin clear and cannot cover authorized active humans or active server resident snapshots with a .4-metre margin. Humans need recent presence, a live session in that room and current room visibility. Expired/departed/revoked presence does not veto edits. Existing blockers' material/name changes and erasure do not become new placement operations. The operation fails atomically instead of relocating an occupant.

The existing bounded arrival flood must remain usable when it was usable before an edit. This checks a route out of the immediate arrival neighbourhood, not connectivity to every point in the room. Imported terrain is structurally validated and cannot cover the arrival margin. All player keyboard movement, click paths, safe landing lookup, resident spawn checks and resident swept paths consume terrain collision. Floors can be painted under furniture; erasing terrain does not erase furniture or its collision.

Integration in `server/app.mjs`:

```js
import {validateTerrainSceneDelta} from './terrain.mjs';
// Inside the scene CAS, immediately after validateImageSceneDelta:
validateTerrainSceneDelta({store,presence,residents:bots.snapshot(roomId),now,room:row,userId,before,next:b.scene,beforeImages:resolvedImages.before,nextImages:resolvedImages.next});
```

Focused tests: `node --test tests/terrain.test.mjs tests/terrain-app.test.mjs tests/worlds.test.mjs tests/bots.test.mjs`. The HTTP suite uses real temporary SQLite files and local HTTP servers, including a partially streamed request whose editor permission is revoked before the body finishes.
