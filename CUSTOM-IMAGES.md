# Custom room images · v0.6 slice

Build → Custom images supports a real local file chooser, draft preview, name/tags, floor/standing/custom-pivot planes and optional painted collision cells. Upload is explicit. Search matches mutable library names/descriptions/tags; Place selects a repeat placement tool. Each placed instance pins an immutable version and supports native ghost/select/drag/quarter-turn/duplicate/keyboard/undo/redo/save/reload. Transparent pixels can be picked through; keyboard selection still reaches wholly transparent objects.

## Storage and authority

Definitions, immutable version metadata/bytes and placed instances are separate. The server decodes and validates bytes, derives dimensions, enforces same-room current actor/session authority before and after upload, and provides actor-bound retry receipts. Scene saves resolve both previous and proposed version references from the database inside compare-and-swap validation. Client-provided dimensions/URLs/ownership are rejected. Full image extents govern personal-area edit rights; only painted cells govern collision. Transparent pixels do not shrink either policy.

The image endpoint is same-origin and cookie-authenticated: `/api/rooms/:room/assets/:asset/versions/:version/image`. It never reuses the document attachment route. Responses are no-store/nosniff with same-origin resource policy. Room/session changes and revoked access invalidate pending loads and cached GPU leases. UI error/retry states are explicit; interrupted upload uses the same operation identity and does not fabricate a library card.

## Current limits and incomplete features

- PNG only, 5MiB maximum, 2048px per dimension and 4,194,304 pixels. Accepted codec subset: 8-bit noninterlaced grayscale/RGB with optional alpha and sRGB. ICC/gamma/EXIF/APNG and other ancillary chunks, unsupported depths and interlacing fail with a validation error; no silent re-encoding
- 32 pixels = 1 world metre. Collision grids require 32px-multiple dimensions, nonfloating placement and at most 4096 binary cells. Floating means collision-free/free-position placement, not levitation
- 100 definitions and 50MiB retained image bytes per room. Shared renderer budget: 16,777,216 source pixels and 50MiB source bytes, about64MiB raw RGBA plus16MiB alpha masks at capacity before overhead. Loading is eager within budget; no frustum streaming/LRU claim
- Upright panels/floor sheets are flat image geometry, not modeled assets. Quarter-turns only. Floor height0.05m clears existing paving; raised props retain depth. Nearest sampling/alpha cutoff preserves pixel selection but is not smooth semi-transparency or exact 2D painter-order parity
- Library name/description/tag editing and reversible archive/restore are implemented with revision conflicts and full-editor authority. Existing saved instances retain exact versions and remain editable; archived images cannot be newly placed/duplicated. See `IMAGE-ASSET-LIFECYCLE.md`
- Replacing versions, changing version geometry/depth, irreversible deletion and collection import are not exposed
- Composite primitive workshop, GLB import, marketplaces, terrain/chunks and creator game logic remain separate future work

## Tests and evidence

`npm test` covers shared schema/geometry, PNG decoding, immutable storage, upload receipts, real HTTP authority and scoped scene guards. `npm run test:browser:images` runs shell and direct-builder fixtures plus the actual full game with generated local PNGs and native pointer/touch input. It covers explicit upload without placement, search, alpha/depth, drag/rotate/duplicate, persistence/exact protected bytes, uncertainty/retry, room cleanup and painted-cell movement collision. The final320px layout includes original logo ratio, reachable Share/You, native dock scrolling, 48px image controls and internal collision-grid scrolling.

These are bounded local Chromium/SwiftShader results. No real user's assets, production service, external provider, physical phone, OS file-drop or large-world load is certified. See `DEVELOPMENT-STATUS.md` for the exact snapshot and remaining regression state.
