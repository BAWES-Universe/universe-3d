# Physical image size client protocol

This checkout implements the bounded compatibility fence for the supported single-writer service, including the standalone admission page and preview controller. The combined candidate also applies the editor/world physical-size adapter to the polish source. Physical-size publishing stays off by default. The renderer and native sizing journeys are registered in the `imagesizing` browser group; their results must be checked against the exact combined source. This source has not been deployed.

## Process configuration and persisted reader requirement

`readRuntimeConfig` accepts `UNIVERSE_IMAGE_PHYSICAL_SIZE_ENABLED=0|1`, default `0`. The server factory accepts the corresponding boolean `imagePhysicalSizeEnabled`. Normal enable/disable uses process configuration and restart. `app.setImagePhysicalSizeEnabledForTest(boolean)` is only an in-process factory test seam for pending-body/decode races; there is no HTTP or operator settings endpoint.

Enabling writes persists `metadata.image_physical_size_protocol_floor=image-physical-size-v1`. Any valid pre-existing version with explicit physical fields also requires the new reader, even if publishing starts disabled. The floor is one-way: restarting this compatible runtime with writes off retains the reader fence and exact stored versions/bytes. A present empty or unknown marker fails startup instead of being treated as absent or rewritten. No scene, immutable version or PNG is migrated.

`GET /api/client-protocol`, session responses and SSE `hello` expose:

```json
{
  "imagePhysicalSize": {
    "enabled": false,
    "required": true,
    "capability": "image-physical-size-v1"
  },
  "storageCompatibility": {
    "version": 1,
    "requiredReaderCapabilities": ["image-physical-size-v1"]
  }
}
```

Before first enablement, with no sized data/floor, `required` is false and the required-reader list is empty. These declarations describe compatibility; they do not grant authentication, room access, placement or editing rights.

## Per-request and per-stream fence

Updated API calls send `X-Universe-Client-Capabilities: image-physical-size-v1`. Their own EventSource uses `/api/events?capabilities=image-physical-size-v1`. Capability belongs to each request/connection, never the shared cookie, account or session. Query capability is accepted only for EventSource; putting it on a metadata or mutation URL does not bypass the header requirement.

Once the reader floor is required, unqualified API requests receive HTTP426 `CLIENT_RELOAD_REQUIRED` before entering the protected action. Checks repeat after body reads and asynchronous decode, before transactional image writes, at delegated route boundaries, and before successful JSON serialization. Explicit/inherited sized writes with the switch off receive HTTP409 `IMAGE_PHYSICAL_SIZE_DISABLED` before reservation/quota/commit. Legacy omitted-dimension writes remain possible while the protocol permits that client. Exact committed receipts stay readable to compatible clients when publishing is disabled.

Every outgoing SSE envelope passes the per-connection fence. A connected incompatible tab first receives the old-client-understood `access-revoked` event targeted at its authenticated session's current room, then its captured stream room if different. At most two room IDs are considered; no historical-room registry is added. A final `roomId:null` event retires any visible local view. Each carries `code:CLIENT_RELOAD_REQUIRED`, `recoverDraft:true` and an explicit reload explanation, then the stream closes. An old reconnect receives its authenticated current-room retirement followed by the global fallback and closes before any `hello`, room or scene data. Targeted events matter because the baseline pending-arrival buffer ignores a null room ID; matching retirement marks its held destination denied before a late success can replace the dirty scene. This does not revoke membership, destroy a shared login session or bless an old sibling because a new tab declared capability. The internal test toggle sends a `client-protocol` policy event to compatible streams; normal restart refreshes through `hello`.

The exact baseline schema is retained as a fixture. It still rejects `version.widthMetres`; the corrected server withholds incompatible envelopes rather than deleting dimensions or substituting pixels/32 geometry.

## Narrow exemptions retain existing authorization

The format fence exempts health/access/client-protocol; POST session/login/logout; the exact standalone admission routes GET/POST `/api/site-invites`, POST `/api/site-invites/:id/revoke`, POST `/api/site-admission/check|redeem`; and exact GET/HEAD binary routes `/api/rooms/:room/files/:file` and `/api/rooms/:room/assets/:asset/versions/:version/image`.

These routes carry no image geometry metadata. Existing authentication, authorization and binary access rules still apply. File/image lists, room/catalog metadata, action geometry, and mutations are fenced. Binary exemptions preserve native protected links and downloads, which cannot supply a custom header. No broader prefix or query-string exception is accepted. The standalone admission page's same-origin JSON fetch port declares the reader capability, so normal owner and friend session reads continue when the floor is required. The one-line change recorded in `docs/image-protocol-admission-port.patch` is already applied in this combined source. It changes no signup authority, invite token handling, or external link headers.

## Updated client and recovery

The updated main API/EventSource paths retire a tab before binding incompatible data and fence late successes with a permanent client guard. Reload is deliberate. The user can export the captured room draft and image recovery before reloading; no automatic restore or retry is promised.

Image transport declares capability and reports HTTP 426 before shell suspension so recovery can be captured. `imageLibrary.getRecoverySnapshot()` synchronously returns actor/room, an unsent upload `File` and fields, exact pending upload bytes/draft/operation ID, and setup drafts with original source/base plus pending version args. It returns null when empty and never exports another account/room's retained drafts or credentials. File serialization happens only after the user clicks Export. Pending receipts are described as uncertain: an HTTP 426 may follow an earlier authorized commit whose response was delayed, so it is not proof of non-commit. A texture request receiving HTTP 426 reports the same reload guard before decode.

The real library derives `canSize` only when read authority and server availability are both present. Size-policy changes do not advance its room epoch or erase unsent image work. With publishing off, ordinary PNG uploads remain available at the original 32 pixels per metre: metre controls are disabled, the preview shows that exact footprint, and upload payloads omit both physical fields. A new draft selected with sizing enabled uses explicit dimensions. The draft retains its legacy or explicit mode across later policy changes; a legacy draft becomes explicit only when the user changes a size control. Disabling sizing blocks an existing explicit draft without dropping its dimensions or reinterpreting it as a legacy upload.

Pending sized uploads and setup saves retain their exact operation identity and allow read-only receipt checks while sizing is off. A committed receipt resolves normally; not-found keeps the original draft and ID, explains the disabled policy, and leaves resubmission blocked. Re-enabling allows a deliberate retry of that same operation. Saved images, metadata/archive/placement, and unchanged-size legacy depth/collision edits remain available. Inherited sized versions cannot be newly published while off. No stored dimensions are stripped to satisfy an old reader.

## Old-binary presentation limit

An unmodified old browser understands the retirement events and offers its existing captured dirty-room export. The current/captured-room targeting closes the reproduced same-room held-resume case through that binary's existing arrival-denial buffer. The server still cannot revoke arbitrary bytes already delivered to an old binary or give it the updated client's permanent late-response guard. Unrelated previously delivered responses outside those known room contexts are not claimed safe for local presentation. Later unqualified metadata/mutation requests remain rejected with HTTP 426 and its EventSource reconnect retires it again; it cannot regain authoritative permission or receive the new geometry. Keep that local-presentation limit distinct from server authorization and the tested dirty-draft flows.

## Packaged target descriptor and rollback contract

`server/image-protocol-capabilities.json` is an immutable source/package descriptor:

```json
{"version":1,"readerCapabilities":["image-physical-size-v1","composition-furniture-v1"]}
```

Both existing runtime Docker copy contracts place it at `/app/server/image-protocol-capabilities.json`. The pure `checkImageReaderCompatibility(storageCompatibility,targetDescriptor)` helper returns a machine-readable decision. It rejects missing target JSON (`IMAGE_READER_DESCRIPTOR_MISSING`), unknown/invalid descriptor versions or fields/capabilities (`IMAGE_READER_DESCRIPTOR_INVALID`), insufficient readers (`IMAGE_READER_CAPABILITY_MISSING`), and unrecognized storage requirements (`IMAGE_STORAGE_REQUIREMENT_INVALID`). Success is `IMAGE_READER_COMPATIBLE`. Missing evidence is never interpreted as compatibility, even if the current required-reader list is empty. This helper does not load or execute target code.

The descriptor covers both persisted formats. The physical-image admission policy and its metadata remain unchanged; the deployment observer also requires `composition-furniture-v1` for any persisted room furniture floor or composition scene placement. An image-only reader cannot be used as a rollback target after furniture persistence, or before starting a candidate that may persist furniture. Empty furniture tables and legacy room scenes add no storage requirement.

The preview controller now requires fresh SQLite floor/row observations and descriptor evidence bound to the exact target digest, source SHA, tree and Git blob. A protected review binds that tuple to its possible storage requirements. Both candidate and previous healthy readers must satisfy the conservative resulting requirement before any deployment mutation. The controller observes storage again after all writers stop, before start, and during recovery; an observed floor cannot later disappear. Missing, invalid or incompatible descriptors block replacement or rollback. The trusted controller validates bounded JSON data; it never executes target code to discover compatibility. See `deploy/preview/README.md` for the initial-baseline and review contract. **Direct rollback to unmodified bc715 after enablement/sized data is unsupported:** the old binary ignores this new marker and has no fence. This runtime cannot prevent an operator from directly launching such a binary. Retain a compatible reader with writes off, or restore a verified pre-enablement/pre-sized-data backup under an explicit rollback procedure. Never clear the marker, alter stored dimensions or corrupt data to force an old binary to fail.

## Verification entry points

The `imageprotocol` browser CI group checks out the exact baseline commit into an isolated directory and verifies its commit/tree before building it. Locally, set `UNIVERSE_LEGACY_SOURCE` to a clean checkout of `bc715ff6ccc0c3d2537e4c003cb4a7bb82745a34` and run `npm run test:browser -- imageprotocol`. The legacy checkout is never modified. Other browser fixtures match the EventSource path independently of its capability query while retaining their real disconnect and authority assertions.


- `tests/image-client-protocol-boundaries.test.mjs`: pending old CAS/scene operations/uploads; shared-cookie old/new streams; exact dimensions and byte exceptions; compatible restart/disable; existing-data floor detection
- `tests/image-client-protocol.full.mjs`: actual immutable bc715 browser, dirty-draft retirement/export, fresh current sibling, restart and held old/current responses
- `tests/image-protocol-format.test.mjs`: persisted format, precise exceptions, packaged descriptor and fail-closed target comparison
- `tests/preview-image-reader.test.mjs`: exact descriptor/source review, first-capable-baseline constraints, startup floor advancement, safe rollback, monotonic storage observations, and read-only SQLite inspection
- `tests/site-admission-format.test.mjs` and `tests/site-admission-ui.browser.mjs`: normal signup/login/session reads across enabled, disabled and retained-reader-floor states without implicit place or site authority
- Image service/shell/renderer tests: default-off publishing, decode-time changes, exact recovery, policy-only draft preservation and texture HTTP 426 propagation
- `tests/image-library-shell.browser.mjs`: native default-off legacy upload, enabled explicit sizing, policy changes preserving unsent work, and read-only pending upload receipt resolution while off
- `tests/image-physical-size.browser.mjs`: opted-in physical controls plus exact setup receipt/retry behavior across disable and re-enable
- Canonical image feature fixtures explicitly opt into enabled publishing; unrelated legacy/default tests remain default-off

Browser evidence is loopback Chromium/SwiftShader with synthetic data. It does not certify physical phones, hardware GPUs, Safari/Firefox, screen readers, distributed hosting or a hosted deployment. The combined source includes PR #1's polish changes, but reader-fence, physical-size renderer and full-shell journey results remain distinct checks.
