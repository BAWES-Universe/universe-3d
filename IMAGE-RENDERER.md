# Room image objects: Babylon 9.28 bridge

This bridge is integrated with the room image-library service, shared scene model, direct builder and current game renderer. Images remain floor decals or upright, double-sided textured panels. No mesh reconstruction, extruded image, directional sprite, tint substitute or source painter-order parity is claimed.

## Integration surface

```js
import {
  createBabylonImageTexturePool,
  createBabylonImageObjectView,
  pickWithImageAlpha
} from './src/babylon-image-object-view.js';

// Exactly one pool per native scene, shared by every instance.
const texturePool = createBabylonImageTexturePool(scene);
const context = {roomId, roomEpoch, authorityEpoch, canRead};
const view = createBabylonImageObjectView({
  scene,
  texturePool,
  resolved, // authoritative room+asset+pinned-version server envelope
  instance, // existing image-instance identity/position/quarter-turn only
  context,
  onState: state => updateAccessibleObjectStatus(state)
});
await view.ready;

// Use update for transforms, pinned source changes, or context changes.
await view.update({resolved, instance: movedInstance, context});

// Pass the actual scene picking ray, preserving the caller's allowed-mesh filter.
const hit = pickWithImageAlpha(scene, ray, mesh => allowedToPick(mesh));
const id = hit?.pickedMesh.metadata?.id;

// Normal object-list and keyboard routes must still include this record.
const selection = view.getSelectionRecord();

// Dispose all handles on scene/room teardown, then the pool.
view.dispose();
texturePool.dispose();
```

The bridge returns a zero-transform `TransformNode` whose child plane vertices already contain the shared resolver's world corners. Do not apply the instance transform to that node again. Call `view.update` instead. `view.placement` is the exact deeply frozen result of `resolveImagePlacement`; selection uses its `editBounds`. There is no second size, pivot, source-row or quarter-turn calculation here. Geometry data are float32 in Babylon; numeric tests allow the unavoidable float32 representation error.

Image mesh metadata contains `{id,type:'object',kind:'image',assetRef,imageObject:true,dynamic:true}`. Preserve those identities and do not merge image planes into generic furniture batches. The `dynamic` flag also prevents existing integrations from permanently freezing a transform that the editor later needs to update. Keep image materials/textures under this bridge's ownership rather than including them in generic material disposal caches.

The instance's authoritative collision cells remain `view.placement.collisionCells`. The bridge never changes colliders on a network failure, never infers collision from alpha and never creates supporting terrain. Existing human/bot/permission/save code must consume the same resolver independently. This adapter does not authorize edits.

## Context and lifecycle

`context` requires `roomId`, finite-number-or-string `roomEpoch`, finite-number-or-string `authorityEpoch`, and boolean `canRead`. These are invalidation fences, not credentials. The integration must update or dispose handles whenever the room, session identity, source version, read authority or authority epoch changes. It must increment authorityEpoch even when a new session can read the same room. A read revoke is expressed by `canRead:false`; a room change to a different room immediately revokes an old-room handle. Do not leave old handles enabled while requesting new room metadata.

States are `loading`, `ready`, `error`, `revoked`, `disposed`, with an instance ID, pinned reference, user-readable status label and stable error code when available. A loading/error/revoked handle shows only a non-pickable ground footprint status outline, never a fake texture or furniture fallback. Object-list/keyboard selection retains the full extent in all states, including entirely transparent PNGs. The integration must expose state/Retry in accessible UI; the line alone is not that UI. `view.retry()` performs a new acquisition, and cannot change read authority. Invalid/deleted/mismatched source updates immediately cancel and hide the old visual; retry remains blocked until a valid authoritative update arrives. An invalid initial definition fails construction because no authoritative geometry exists to draw.

Movement of an already loaded same-version instance retains its texture. Source/context change aborts the old request, detaches and releases its lease, and invalidates late completion. Native browser image decoding cannot be interrupted mid-decode; a late bitmap is closed without creating/attaching a texture. GPU-load cancellation disposes the provisional texture. Blob URLs are revoked after successful upload or failure/cancellation. Idempotent disposal releases node, plane, status line, per-instance material and its lease. A native node-dispose observer also releases the handle if existing room cleanup calls `node.dispose(false,false)` directly; scene disposal closes the shared pool. Never use forced recursive texture disposal on image nodes because another instance may still hold a lease.

## Serving and security seam

The default loader fetches only:

`/api/rooms/:roomId/assets/:assetId/versions/:versionId/image`

It requires the current authorized active room envelope, sends same-origin session cookies, uses `mode:'same-origin'`, `cache:'no-store'` and `redirect:'error'`. A resolver seam can customize how the URL is obtained, but its result must still equal that exact dedicated same-origin endpoint. External, data, blob, document-download, query-token and fragment URLs are rejected before fetch. URLs are never read from an image instance.

The response must succeed and have PNG media type; the stream is capped by both the pinned byte count and shared maximum. Length and SHA-256 must match the immutable version before decode. A PNG-signature/IHDR envelope check prevents oversized or mismatched browser allocation; browser decode and exact decoded dimensions must then succeed. The envelope check is defense in depth, not a replacement for the service's complete PNG validation. Server cookies and role checks remain authoritative; client context booleans are not authorization.

`createAuthenticatedImageLoader({origin,fetchImage,resolveURL,digest,decodeTexture})` exposes bounded transport and decode seams for tests/adapters. `createImageObjectView({port,loadTexture,...})` is engine-independent. An injected resource must return an actually ready texture, alpha hit-testing and a disposal function before the controller can become ready. `origin` defaults to the current browser origin; integration should not supply a different origin. Never put credentials in these options or asset records.

## Shared resources, budgets and picking

`createImageTexturePool` keys a texture by room, asset ID, immutable version ID, SHA-256, room epoch and authority epoch. Concurrent repeated placements share one fetch, decode, alpha mask and GPU texture. Each consumer gets a lease. Cancelling one request does not cancel other consumers; cancelling/releasing the last lease disposes the resource, including an in-flight request. No retained warm cache exists after the last consumer. A failed entry is removed so retry can fetch again. A revoked/deleted/cross-room request cannot acquire a cached lease.

Defaults are 16,777,216 resident source pixels and 50 MiB of source bytes across live/pending unique versions. Pixel reservations bound roughly 64 MiB of uncompressed RGBA GPU data plus 16 MiB of retained alpha masks at capacity, excluding GPU/runtime overhead and transient decode buffers. Both budgets are configurable. An over-budget image stays explicitly unavailable (`IMAGE_TEXTURE_BUDGET`) and can retry after resources are released. `texturePool.getStats()` reports reservations, entries, pending loads and leases. Loading is eager within these budgets. Frustum/lazy streaming and LRU eviction are not implemented.

Each decoded image produces one full-resolution cached alpha-byte mask, bounded by the shared 2048px/4,194,304-pixel limit (at most 4 MiB per image). There is one bounded canvas readback on load; pointer events only index cached alpha bytes. The shared pure `imageAlphaHitTest` supplies the threshold. Native textures use nearest filtering without mipmaps so exact source-alpha selection matches sampled rendering, including the 127-discard / 128-keep boundary. This preserves source pixels but can shimmer/minify at distant camera angles; changing filtering later requires revisiting pick/render alpha correspondence.

`pickWithImageAlpha` sorts actual Babylon ray hits by distance. Opaque image pixels select that instance; transparent pixels pass to later image/ordinary-object/ground hits. It does not use the larger conservative edit footprint as a hit surface. Back-face picking is supported, while the image remains world-oriented rather than facing the camera. Completely transparent images have no pointer hit but keep object-list/keyboard identity. The source top-left UV convention is maintained on the fixed plane; viewing its back naturally reverses its apparent horizontal orientation.

Materials use native alpha testing and normal depth writing/testing with Babylon's default rendering group. No always-on-top override is used. Collision, shadow registration and camera policy remain the integration owner's responsibility. Exact edge-on panels are intentionally flat; arbitrary orbit is not a modeled object or a pixel-for-pixel reproduction of a 2D painter engine.

## Verification

Run `node --test tests/image-asset-renderer.test.mjs` for resource and transport contracts, and `npm run test:browser:images` for the actual shell, authenticated bytes, native renderer, direct builder and persistence. The full test uses generated PNGs and a fresh loopback server; it does not use actual user uploads, external providers or the development database.

Actual-game coverage includes floor PNGs above Commons paving, native furniture occlusion, upright custom pivot, transparent pixels passing through to a chair/ground, pointer drag and version-preserving duplicate, painted-cell player collision, durable save/reload, interrupted upload reconciliation, room cleanup and 320px native touch placement. Module tests cover digest/size/MIME/route rejection, bounded allocation, stale asynchronous completion, malformed resources, resource disposal and texture budgets. Physical-device GPUs and large-room performance remain unverified.

## Shared floor surface policy

The integrated shared floor-image offset is **0.05m**, in `image-asset-geometry.js`. It clears existing walkable sheets up to 0.04m; actual Commons and compact-room screenshots verify visible pixels. Raised objects and rugs keep ordinary native depth occlusion. The renderer does not override this height or disable depth testing. A flat image is not a terrain-conforming projection.
