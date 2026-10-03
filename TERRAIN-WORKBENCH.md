# Native terrain workbench

The implemented boundary below is covered by focused model, authority, editor and renderer checks. Exact integrated verification and remaining limits are recorded in `DEVELOPMENT-STATUS.md`.

The workbench adds native floor and water painting, plus direct wall drawing, to the existing room editor. It is a requested 3D creation extension. The pinned [Tiled map contract](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/docs/map-building/tiled-editor/wa-maps.md) informs surface ordering and explicit collision, while the [inline entity contract](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/docs/map-building/inline-editor/entity-editor/index.md) distinguishes entities from authored base-map content. This work does not certify Tiled import, source layer semantics, collection import or script APIs.

## Authoring

- Choose a material, preview a snapped rectangle, and release to paint once. A click paints one cell. Repaint replaces the selected cells; erase restores their original room scenery
- Grass, soil, stone, wood and water are original procedural materials. Blocking is explicit and independent of appearance; water starts with blocking enabled. Water is a flat animated surface; shoreline depth, rounded edges and elevation remain later visual/geometry work. There is no swimming or resource mechanic
- Draw a straight orthogonal wall using the existing wall object. It remains selectable, movable, rotatable, duplicable and removable through ordinary object controls
- One completed drag is one undo step. A live preview does not change the scene or rebuild the environment. Escape, interrupted pointers, a camera gesture, blur, travel and permission loss cancel the pending gesture
- Keyboard and touch operate the same transactions. Every control remains reachable through native focus/activation; text fields and IME retain their existing shortcut isolation

## Data and authority

The optional scene field is `terrain: {version:1, cells:[[x,z,material,blocked], ...]}`. Each integer world coordinate names the lower corner of a one-metre cell. Authored cells are sparse, unique and bounded to the room, with a maximum of 4,096. Generated output has deterministic row order. A material key and a real boolean describe each cell; malformed, duplicated, fractional, oversized or out-of-room records are rejected. Existing total scene JSON budgets still apply.

These are ground records, separate from furniture definitions, placed objects and interactive areas. Future persistent chunks can partition the world coordinates. The current room remains bounded; this is not a streaming or infinite-world implementation.

Only an actor with current room-wide scene editing permission can alter terrain. A personal-space object grant does not acquire terrain rights. The scene save uses the existing server transaction, current authority check and compare-and-swap revision. Conflicting or rejected saves retain the local draft.

New blocking terrain or changed wall footprints must preserve arrival and its usable route, and cannot cover an active authorized person or resident. Rejection leaves the scene unchanged. Existing untouched geometry is not silently revalidated or relocated. Shared terrain geometry feeds player movement, click paths, safe arrival and resident navigation. Positions remain bounded client reports under the existing application model; this is not server-authoritative player physics.

Terrain edits replace the affected baked paving, decks, ground and decorative planting cleanly. Erase restores that underlying scenery. Rendering must not introduce coplanar flicker, hidden leftover blockers or per-cell material/resource leaks. Legacy scenes with no terrain field keep the existing environment path.

## Verification boundary

Pure and actual HTTP/SQLite tests cover schema/budgets, deterministic paint/erase, bounded collision lookup, scene persistence/CAS, occupant and arrival rejection, and full-room versus scoped authority. Editor tests cover transaction boundaries and interrupted pointer/keyboard/touch gestures. Renderer checks cover legacy compatibility, authored surface replacement, resource cleanup and correct picking.

The integrated browser walkthrough paints a path and water patch, draws and manipulates a wall, undoes/redoes the complete operation, saves and observes the same scene from another client, reloads it, exercises an occupied-cell rejection with draft recovery, and verifies native touch/camera cancellation. A separate native keyboard check covers material buttons, canvas Enter placement and Done dismissal. Screenshots show the actual shell and authored environment. Headless software-WebGL and emulated touch do not establish physical-device performance.
