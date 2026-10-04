# World presentation: warm garden polish

Base: `bc715ff6ccc0c3d2537e4c003cb4a7bb82745a34`

Branch: `external/world-presentation`

Implementation and tests: `f221b0ce1ae9c04341e4280454267e620e367b1c`

Local work only. No push, PR, deployment, production access, provider use or purchased/generated external assets.

## What changed

1. **Warm, quiet materials.** Creamier paving with finer joints, quieter sage ground, and lighter procedural foliage prevent the existing authored object tint from making canopies nearly black. Slightly warmer neutral fill preserves shape against the ink backdrop. Coral/gold flower accents and gold path inlays use existing brand roles; portal paving becomes warm stone. Existing character colors, UI, fonts and geometry remain intact.
2. **Readable water.** Wider, periodic teal ripples replace the dense noisy pattern. It remains opaque, flat, at the exact existing terrain height. No transparency, refraction, apparent underwater depth, swimming or collision behavior was introduced.
3. **Feathered grounding.** One original radial texture replaces hard-edged object/player contact cylinders with two-triangle planes. Authored objects, interaction IDs, coordinates, picking predicates and static shadow-map behavior remain unchanged. Contact planes cannot intercept picks.
4. **Selection and motion clarity.** A gold footprint gets eight short corners with dark borders, batched into two extra meshes. These use ordinary depth testing, so a wall still conceals and intercepts selection behind it. Reduced-motion preference is read live. Decorative water, portal and navigation-marker motion pause in Build; gameplay character/camera behavior is unchanged. Renderer disposal now removes its world/player labels.

Only `src/renderer.js`, `src/environment-materials.js`, `src/scene-layout.js`, and new `world-presentation-*` tests/evidence/docs changed. The allowed `src/terrain-render.js` was inspected but needed no edit. Shell, editor, movement/physics, server, saved data, schemas, package/CI and `modules/asset-workshop/` are untouched. No integration hook in another lane is required.

## Brand and contract grounding

Read the exact-base README, ASSETS, BRAND-PORT, terrain workbench and image renderer/setup-version contracts. No AGENTS.md existed in the checkout or checked ancestor paths. Read the actual `public/universe-tokens.css`, including coral `#e96d51`, star gold `#e9c74c`, teal world role and ink surfaces. Its source notes pin game #598 `966d723d1a5d7ab31debd1fe08d68b5878017e80`, Orbit #236 `d7577b79`, and control refinements from game #609 `9a68beea`; these are repository-recorded proposal provenance, not independently checked deployment claims. Also inspected the local `bawes-new-website` checkout at `8e7cf905dc39b5a249577b3b09a683cd5b1ba48c`, including actual Inter/Space Grotesk declarations. No UI typography changes or substitute brand assets were introduced.

## Reproducible captures and performance

`tests/world-presentation-capture.mjs` builds the real renderer, plays the real shell first, then uses deterministic Commons, sparse water/deck, crowded (+32 furniture objects) and Studio fixtures. The controlled fixture is a renderer test, not a screenshot-only renderer: it imports the same production createRenderer and materials. All four before/after camera-state objects compare exactly equal. Screenshots include all four scenes, selection and 390×844 portrait. The gameplay MP4 is separate actual-game mouse/keyboard input at original screencast timestamps.

**Software rendering only:** Chromium 153, ANGLE Vulkan SwiftShader (Subzero), shared Linux host; 1280×800, DPR1 controlled performance captures. DPR2 picking and 390px/320px touch are emulated. No physical phone/GPU FPS, player capacity, or production performance claim.

Each scene has 12 requestAnimationFrame warm-up draws followed by 90 draws / 89 frame intervals. The table uses real rAF timestamps, not the fixed simulation delta. Raw frame intervals, synchronous submission times, draw-call arrays, camera states and full resource counts are in before/after results.json. Resource counts include renderer caches warmed by the preceding scenes. The baseline lifecycle-only rerun warmed fewer scene palettes than the after run; compare stability within each switch loop, not those two absolute cache totals.

| Scene | Draw calls before → after | Before p50/p95/max ms | After p50/p95/max ms | Vertices before → after | Textures before → after |
|---|---:|---:|---:|---:|---:|
| Commons | 76 → 76 | 266.7/466.6/750.0 | 266.6/516.6/600.0 | 50,797 → 49,321 | 11 → 12 |
| Sparse | 26 → 26 | 83.4/149.9/216.7 | 66.7/133.3/166.7 | 15,480 → 15,152 | 11 → 12 |
| Crowded | 76 → 76 | 316.6/616.6/750.0 | 250.0/516.7/783.3 | 64,678 → 60,578 | 12 → 13 |
| Studio | 48 → 48 | 183.3/233.4/333.4 | 133.4/266.7/383.4 | 21,777 → 20,875 | 13 → 14 |

The shared host had other browser workloads. These single-run distributions are noisy and do **not** establish a speedup. Commons p95 increased while several other quantiles decreased. The reliable structural tradeoff is unchanged play-mode draw calls/mesh counts, fewer contact vertices, and one extra texture. Selection adds two draws beyond the original footprint; no selection means no added draws.

Six crowded/sparse room round trips retained identical post-warm-up mesh/node/material/texture/geometry counts. Eighty selection changes also retained exact counts. Disposal leaves zero Babylon engines and zero label elements; reopening succeeds. The original base left one avatar label behind. Existing caches are renderer-lifetime caches; this is not a global cap on arbitrary user-authored color combinations.

## Effect/resource limits

- Exactly one additional 64×64 RGBA contact texture per renderer (16 KiB base, approximately 21.3 KiB with mipmaps, excluding canvas/driver overhead), one shared contact material. Static object contacts batch together; each player keeps one contact mesh, as before.
- Nine existing procedural material kinds remain 128×128. No downloaded texture, particle system, extra light, reflection, post-processing pass or additional shadow map. Existing 1024px cached shadow map is retained.
- At most one selection root, one original footprint and two corner batches: 16 boxes total, 384 extra vertices. Two reusable corner materials; 80 changes do not accumulate resources.
- Water animation only changes a shared UV offset: at most 0.013 U amplitude and 0.007 V/second, unchanged from base. Surface coordinates, normals, heights, sparse-cell merging and collision flags are untouched. Build and reduced motion stop the decorative clock without a resume-time jump.
- Contact height remains below the existing 0.05m floor-image plane. Image texture/alpha sampling, authority, version pins and imported-image geometry are unchanged.

## Verification

All listed runs passed; detailed machine-readable results and text logs are included.

| Command | Result |
|---|---|
| `npm run build` | Built real shell/renderer successfully; no package changes |
| `npm run check` | 330 source files syntax checked |
| `node --test tests/terrain-render.test.mjs tests/terrain.test.mjs tests/scene-layout.test.mjs tests/render-resolution.test.mjs tests/world-presentation.test.mjs tests/image-asset-renderer.test.mjs tests/image-asset-geometry.test.mjs tests/image-setup-versions.test.mjs` | 87/87 |
| `node tests/world-presentation-capture.mjs` | 8 checks; paired fixtures, motion, resources and reopen |
| `DPR_EVIDENCE=evidence/world-presentation-dpr node tests/picking-dpr.browser.mjs` | 6 native mouse/touch checks, DPR2, orbit, opaque/transparent PNG picking |
| `node tests/camera-renderer.browser.mjs` | 12 checks, orbit/pan/tilt/zoom, merged object identity, ghost non-interception, narrow framing |
| `node tests/terrain-renderer.browser.mjs` | 10 checks, including contiguous and separated 4,096-cell scenes, erasure and resource bounds |
| `node tests/world-presentation-occlusion.mjs` | 6 checks, opaque-wall occlusion, 80 selections, motion preferences, short landscape |
| `node tests/world-presentation-play.mjs` | 4 journey checks; real gameplay MP4, no runtime exceptions |
| `node tests/image-setup-version.full.mjs` | 10 native acceptance checks, v1–v7 pins, immutable images, save/reload, collision, stale409, interrupted receipts, permissions, archive/restore and 320px touch |

The first baseline lifecycle assertion caught two lazily cached area materials because Build had not yet visited the crowded room. The fixture was corrected to warm that same room/mode before measuring, then passed. The initial performance probe submitted many synchronous warm-up frames; it was discarded and replaced by the rAF-paced method reported above. No application changes were made to make those tests pass. Browser CLI was unavailable; repository Playwright/Chromium harnesses were used.

## Integration

Apply the supplied binary-safe patch to the exact base with `git apply --check`, then `git apply`; or import the local commits from the bundle. The source ZIP contains every changed/new committed file, including evidence. No migration or saved-world rewrite is required. The renderer API remains compatible; getStats only adds read-only ambience/resource diagnostics. New tests need only the repository's existing Node24+, esbuild, Babylon and Playwright dependencies; recording also needs ffmpeg.

To regenerate a baseline, point the same capture test at a clean exact-base checkout and its built dist:

```sh
WORLD_PHASE=before WORLD_SOURCE_ROOT=/absolute/base-checkout WORLD_DIST=/absolute/base-checkout/dist node tests/world-presentation-capture.mjs
node tests/world-presentation-capture.mjs
```

For comparison, keep browser version, viewport, scene order and system load fixed. Existing test scripts regenerate their standard evidence filenames; this handoff groups their retained results under `evidence/world-presentation-regressions/`. Renderer harness bundles and redundant temporary captures are excluded. Physical-device validation and a dedicated-hardware performance run remain unperformed.
