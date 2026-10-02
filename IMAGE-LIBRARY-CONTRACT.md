# Image library contract v1

Shared integrated model for the EDIT-06 slice and supporting EDIT-03/07. It is consumed by the actual room service, builder, renderer, human/bot collision and scoped edit authority. This is not whole-contract parity certification. Pure `.js` ES modules work in the Node24 application and browser. No DOM, engine, filesystem, network, database, or dependencies are imported.

## Stable records

`normalizeImageAssetDraft(raw, decodedImageInfo)` validates authoring metadata against **server-decoded** `{width,height,byteLength,mediaType:'image/png'}`. The decoder is responsible for complete PNG validation; this function cannot prove byte decodability or a digest. Output: `{name,tags,representation,depthPreset,depthPivot,floating,collisionGrid,widthPixels,heightPixels,byteLength,mediaType}`. Dimensions never come from draft fields. Name is trimmed (1–120 code points). Tags accept comma-separated text or an array, are trimmed and case-insensitively deduplicated, and allow 20 unique tags of 40 code points each. Unknown fields fail with `ImageAssetValidationError`, carrying `code`, `field`, and `issues`.

- Defaults: tags `[]`, depthPreset `standing`, floating `true`, collisionGrid `null`
- Standing => upright, pivot `1`; floor => floor, pivot `0.5`; custom => upright, explicit pivot in `[0,1]`. Contradictory representation/pivot is rejected, not clamped
- Arbitrary image dimensions are allowed without a collision grid. A supplied grid requires floating false, 32-multiple pixel dimensions and exact row/column counts, binary numeric cells only
- Limits: PNG, 5 MiB, 2048px per side / 4,194,304 pixels, maximum 4096 cells. These are candidate v1 limits, not upstream constants

`validateImageDefinition(definition, version)` returns a deep-cloned, deeply frozen `{schemaVersion:1,definition,version}`. Definition: `{schemaVersion:1,assetId,roomId,createdBy,createdAt,originKind:'upload',provenance?}`. Optional provenance is plain user-supplied `{attribution?,source?,license?}` text, never fetched. Version: draft output plus `{schemaVersion:1,assetId,roomId,versionId,sequence,sha256,createdBy,createdAt}`. All IDs are opaque restricted strings; dates are canonical UTC ISO strings. `sequence` is a positive safe integer; hash is lowercase SHA-256. Identity and room must agree. Floating lives only in Version; storage must enforce that all versions of one definition retain its first version’s floating value. Changing floating requires a new definition. Cross-version monotonic sequence and immutability also require repository constraints: a pure function cannot prove history.

The server attaches an explicit `status:'active'|'deleted'` to that result to form the resolved envelope. It must retrieve this envelope through authorized room+asset+version lookup. It must not deserialize an envelope supplied in scene JSON as trusted authority. The immutable definition record itself has no mutable current-version pointer or tombstone state.

Library entries have `{schemaVersion:1,status,definition,version}` where `version` is the current version. A scene resolver returns the same shape with the **pinned** version, which can be older than the current one. Entry state and current-version pointer belong to storage, not identity.

## References, instances and search

`validateAssetReference(raw)` strictly accepts `{assetId,versionId}` only. `validateImageInstance(raw)` strictly accepts `{id,type:'image',assetRef,x,z,rotation?,name?,actions?}`. Rotation defaults to 0; negative and multiple-turn cardinal angles normalize into 0/90/180/270. Non-cardinal angles fail explicitly. Coordinate magnitude is capped at 1,000,000m. No dimensions, scale, URLs, owner, hash, collision or permission claims are allowed. Existing application action validation must also run; this module only verifies that actions are bounded JSON and retains a detached frozen copy.

`canUseImageReference(reference,resolved)` checks valid identity/room/status consistency only. It is never an authorization grant. It requires explicit active status. `searchImageLibrary(entries,{query='',category='custom'}={})` returns frozen validated active entries in input order, preserving duplicate names with distinct IDs. Categories are custom/all (same set in this custom-only module); unknown categories produce no results. Every whitespace-separated query token must occur in the case-insensitive name or tags. No HTML is generated; render with textContent.

## One geometry contract

`resolveImagePlacement(resolved,instance)` requires the explicit active resolved envelope and matching reference. Returns frozen `{schemaVersion,assetRef,instanceId,transform,render,renderBounds,editBounds,collisionCells,pickDescriptor,migrationWarnings}`. Helpers `imageFootprint` and `imageCollisionCells` return the identical corresponding values. `imagePlacementInside(area,resolved,instance)` and `imagePlacementChangeInside(area,{before,after,resolve})` use only the full edit extent. The latter checks both old and new extents, resolving each reference independently through the provided trusted synchronous resolver. Role, ownership and foreign-area overlap remain integration policy.

32 source pixels = 1m. Source image top is local negative Z. Full source extent is a centered W×D rectangle in ground X/Z, independent of alpha or collision. Renderer convention comes from current `renderer.js`: Babylon yaw is `-rotation * PI / 180`. Therefore ground transform is `x'=x+u*cos(a)-v*sin(a)`, `z'=z+u*sin(a)+v*cos(a)` for positive source angle a. Cardinal sine/cosine are exact lookup values, with no floating-point fuzz at 90°.

- Local cell center `(col+0.5-Wpx/64, row+0.5-Hpx/64)`; occupied cells only, each 1m square. Every cell returns exact rotated corners and AABB, consumed unchanged by human/bot/placement collision
- Edit bounds return full rotated corners plus `{x,z,width,depth,minX,maxX,minZ,maxZ}`. Transparent borders and all-transparent artwork never shrink them
- Upright plane X is `[-W/2,W/2]`, Y is `[0,D]`, Z is `(depthPivot-0.5)*D`. Floor plane covers W×D at Y=0.05. This shared candidate policy clears the existing walkable surface sheets (up to 0.04m), while raised props and rugs retain native depth occlusion. Images are flat sheets, not terrain-conforming projections. Render bounds describe the actual world plane, distinct from edit ground extent
- Render description uses double-sided alpha-tested planes, native depth test/write, no camera billboard, no arbitrary rendering group and no supporting terrain or inferred mesh
- Pick descriptor uses the actual render plane with top-left source UV convention (u rightward, v downward), independent of ground edit outline. `imageAlphaHitTest(mask,{u,v})` can reject transparent samples after intersection; missing mask returns null (unknown, never evidence of opacity). Bounded mask uses `{width,height,alpha:[0..255]}` with dimensions at most 256; cutoff 128/255. This is a picking aid only. List/keyboard selection remains required even if every alpha value is zero

No cell follows alpha. No authorization follows a pick. No collider-free or deleted fallback is emitted for unresolved assets. Unsupported representations/noncardinal angles reject. `migrationWarnings` is currently empty because unsupported schema states fail validation; Native depth and alpha picking have bounded actual-browser acceptance; exact source 2D painter-order fidelity is not claimed.

## Source and tests

Primary mapping: EDIT-06 image setup/discovery, EDIT-03 32px binary grids, EDIT-07 depth. Room scoping, native planes, 32px/m and conservative full edit footprints are explicit migration/security choices. Editing/deleting definitions (EDIT-08), collection import (EDIT-09) and terrain (EDIT-10) remain separate gaps.

Run `node --test tests/image-asset-schema.test.mjs tests/image-asset-geometry.test.mjs tests/image-library.test.mjs` for the pure contract; `npm run test:browser:images` exercises the integrated UI. See `CUSTOM-IMAGES.md` for all limits and the verification boundary.
