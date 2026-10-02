# Room image service and persistence seam

This service is mounted in the local game server through `image-asset-context.mjs`, using the existing Store database connection, same-origin request policy, cookie sessions and room authority. Version publication and deletion are deliberately not exposed. No existing document/file route is changed; documents remain download-only. Server integration does not by itself certify browser rendering, editor UI, deployment or full EDIT-06/07 parity.

## Integration

1. Import `initializeImageAssetSchema` and explicitly initialize an approved host-owned `DatabaseSync` connection with foreign keys enabled. Imports do not open a database. Tests only create fresh in-memory or `mkdtemp` databases
2. `createImageAssetRepository(db)` uses this exact connection. Its transaction helper is synchronous, uses `BEGIN IMMEDIATE`, and uses savepoints under an existing transaction
3. Create the service with `repo`, `authorizeRead`, `authorizeManage`, `resolveSession`, and `validateImage`. Authorization/session hooks are trusted synchronous host adapters, never client booleans. Both authorization hooks return true or throw/return false. `resolveSession(opaqueIdentity)` returns live `{userId,currentRoomId,expiresAt:number,sessionEpoch?:string|number}` or null. Session identity is required for all reads and mutations; never expose it in material URLs or metadata. A changing `sessionEpoch` also detects leave-and-return races
4. Wire `validatePng(bytes,{mediaType})` explicitly, or provide a vetted complete decoder with the same `{width,height,byteLength,mediaType}` result. No signature-only fallback exists. Validation and body reading may await; authorization is rechecked after both awaits
5. Optional `createImageAssetHttpHandler({service,getIdentity})` can be mounted by the host. `getIdentity(req)` returns the server-verified actor and opaque session from its existing same-origin authentication. The adapter never accepts either from JSON/query parameters. It returns false for unrelated paths

## API

All methods take server-side `{roomId,userId,sessionIdentity}` context.

- `list({...context,query?,status?})` -> `{entries}` using canonical `{schemaVersion:1,status,revision,metadata,definition,version}` records. Status defaults to active; archived requires full management authority
- `update({...context,assetId,change,expectedSessionStamp?})` atomically applies metadata or archive/restore with expectedRevision CAS. See `../IMAGE-ASSET-LIFECYCLE.md`
- `create({...context,draft,bytes:Uint8Array,mediaType:'image/png',operationId})` -> entry. Bytes and draft are detached before awaiting validation. Stable definition, immutable version, image bytes and idempotency record commit together
- `reconcileCreate({...context,operationId})` -> `{status:'committed',entry}` or `{status:'not-found'}`. The operation is actor+room scoped. Not-found only means no commit existed when read; a pending decode can still finish
- `readImage({...context,assetId,versionId,head?})` -> `{bytes,mediaType,byteLength,headers}`. HEAD uses null bytes. Returned bytes are a detached buffer; they are not a public URL
- `resolveSceneReferences({...context,scene})` -> frozen null-prototype dictionary keyed by `imageReferenceKey({assetId,versionId})`, i.e. `assetId:versionId`. This method requires an already-open transaction on the same repository connection
- `withResolvedSceneReferences(args,persistScene)` -> result of the synchronous host callback, invoked with the authoritative dictionary inside that same transaction

The host still performs full scene/action validation, scene CAS/history, live role checks for placement, personal-area ownership/footprints, actor overlap and arrival safety before writing its scene. Reference resolution only authorizes reading current room assets. The host must persist the exact validated scene without replacing it after resolution. Existing built-in scene objects are left untouched and remain subject to host validation.

The optional synchronous `transaction(fn)` adapter must open a transaction on this repository connection. Never await image create under a SQLite transaction. `afterCommit(event)` receives a single `imageAsset.created` or `imageAsset.lifecycle` event after durable commit, not on idempotent replay. Notification failure cannot turn durable success into a failed upload; the host should log/reconcile notification errors itself. Existing broadcasters are never called by this module.

## HTTP wire

- GET `/api/rooms/:roomId/assets?query=...&status=active|archived`
- PATCH `/api/rooms/:roomId/assets/:assetId`, JSON `{expectedRevision,metadata:{name,description,tags}}` or `{expectedRevision,status:"active"|"archived"}`; dedicated 32 KiB request cap
- POST `/api/rooms/:roomId/assets`, JSON `{draft,mediaType,operationId,pngBase64}` with canonical base64, dedicated 7 MiB request cap and 5 MiB image cap. No global body limit changes, remote URLs, multipart parser, compressed request bodies or client authority fields
- GET `/api/rooms/:roomId/assets/operations/:operationId` for read-only reconciliation
- GET/HEAD `/api/rooms/:roomId/assets/:assetId/versions/:versionId/image`

Image headers are `Content-Type: image/png`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, `Cross-Origin-Resource-Policy: same-origin` and exact Content-Length. There is no wildcard CORS, static public path, document-download bypass or arbitrary external fetch. The host remains responsible for its ordinary origin/CSRF policy and cookie policy when mounting a mutating endpoint.

## PNG/color contract

The restrictive decoder fully validates chunk boundaries/CRC/order, the complete bounded zlib stream, exact scanline sizes and every reconstructed row filter. It accepts only 8-bit noninterlaced grayscale, grayscale-alpha, RGB or RGBA, with IHDR, consecutive IDAT, IEND and at most one valid sRGB chunk. Palette PNG, 16-bit PNG, interlace, APNG, transparency-key tRNS, ICC profiles, gamma/chromaticity profiles, EXIF/text and all other ancillary chunks produce a clear unsupported capability error. Original accepted bytes are preserved exactly; no profile is silently stripped, no preview is re-encoded, and no color conversion is performed. Untagged accepted art has no stronger color-space guarantee than the renderer/browser's treatment of untagged PNG; production UI should state the restricted export formats and avoid promising cross-device color matching.

Bounds: 5 MiB bytes, 2048 per dimension, 4,194,304 pixels, 4096 chunks, and at most about 16 MiB decoded pixel storage. Service quotas are 100 definitions / 50 MiB retained bytes per room. Test-only configuration may lower caps, never raise them. Tombstones and prior versions remain counted. Current creation is version 1; repository constraints preserve room/definition/version referential integrity, immutable versions/bytes and stable definitions, consecutive version sequence and floating mode across future versions.

## Verification

Run `node --test tests/image-assets-service.test.mjs tests/image-assets-persistence.test.mjs` from the staging root. These are local generated fixtures and ephemeral HTTP/SQLite contracts, not external security probes or a deployment security audit. Persistence tests reopen a fresh file database, verify pinned historical versions, metadata/bytes/hash, authorization, idempotency, quotas, atomic rollback and same-connection scene-save coupling. Additional lifecycle tests exercise the actual metadata/archive/restore API. Historical version changes remain fixture-only SQL; there is no version-publication or permanent-deletion feature.

## Game host integration

- `createGameServer` initializes the dedicated schema on `Store.db`; no second database or image host is opened. Image create/list/reconcile/read routes run after the existing request-origin and HTTP-only session checks
- Reads and upload require a live current-room session. Upload requires full owner/admin/editor authority; owning a personal area does not grant library management. The upload service rechecks session identity, expiry, role and room authority after body streaming and PNG validation. A server-only session epoch rejects leave-and-return races
- Every full room DTO carries `imageDefinitions` keyed by `assetId:versionId`. It is a server-resolved read projection, never scene storage. Room list DTOs without scene carry an empty map. The host rejects scene-level image metadata fields (`imageDefinitions`, `imageAssets`, `assetDefinitions`, `imageLibrary`); image objects accept only immutable reference, identity, position, quarter rotation, optional name/actions
- Scene PUT captures the current session epoch, then resolves both old and new pinned references under the existing SQLite scene CAS transaction. Full validation, scoped old/new footprint checks, area provenance, scene revision and committed-build quest observations share that transaction
- Image placement uses the full exact PNG edit extent, including transparent portions, at 32 pixels per metre. Changed image collision cells cannot overlap arrival padding 0.75 or fresh authorized human positions padding 0.4, or close an arrival route that was open before. Name/action-only changes do not retrigger new-geometry checks
- Personal-area object counts, attribution and explicit revoke/remove-owned handling resolve exact canonical image metadata. Both old and new footprints must fit the owner’s area, without intersecting another owner’s area
- Item action range and resident spawn/navigation bind canonical scene metadata server-side. Bots use exact image collision cells, retaining existing built-in footprint behavior
- Metadata editing and reversible archive/restore exist with live CAS/authority checks; no permanent-delete/version-edit endpoint exists. Image bytes remain protected same-origin PNG responses, with private/no-store and nosniff headers

Run `node --test tests/image-assets-app.test.mjs tests/image-assets-service.test.mjs tests/image-assets-persistence.test.mjs` for local real-cookie/SQLite integration and service contracts. The app tests use generated PNG fixtures, temporary databases and localhost HTTP only.
