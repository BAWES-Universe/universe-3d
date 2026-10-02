# Room image library lifecycle

This scoped increment adds mutable library names, descriptions and tags plus reversible archive/restore. The source editor explicitly supports name/tag editing ([pinned source EDIT-08 documentation](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/docs/map-building/inline-editor/entity-editor/index.md)). Description and reversible archive are this standalone implementation's bounded policy. This does not claim full EDIT-08, depth/version editing or source destructive-removal parity.

## User workflow

Build → Custom images offers Edit, Archive and an editor-only Library status filter. Edit changes name, description and tags; every search token matches these mutable fields. Tags retain the existing trimmed, case-insensitive deduplication and bounds. Existing placed names and immutable version fields do not change. A new placement starts with the current library name.

Archive requires an explicit in-panel confirmation. Archived images disappear from active discovery and cannot be newly placed or duplicated. Full room editors can see the original thumbnails under Archived images and restore them. Metadata edits and lifecycle changes carry an expected revision. A conflict or interrupted response preserves the draft and disables resubmission until the user explicitly loads current details; it never silently overwrites or retries an uncertain mutation.

Previously saved image instances keep their exact pinned reference, original PNG bytes, geometry, alpha picking and painted collision. Their existing instance ID can still move, rotate, rename, change actions, or be removed, within the same room/personal-space authority as before. Unsaved removal can be undone while the saved instance remains. Once removal is saved, Undo cannot add that archived instance back until its asset is restored.

## Authority and storage

- Only full room owner/admin/editor authority can edit metadata, archive, restore or list archived assets. Owning a personal area or uploading a file does not establish asset ownership or library-management permission
- Read and mutation endpoints enforce current session, room and ancestor admission. Mutations check before reading a bounded JSON body and again inside the synchronous SQLite write transaction; leaving/rejoining changes the checked session epoch
- Mutable metadata, revision and archived timestamp live on the library row. Immutable definition identity, version JSON, dimensions, hash and PNG bytes are never updated. Archive retains quota usage; no permanent-delete route exists
- `PATCH /api/rooms/:room/assets/:asset` accepts either `{expectedRevision,metadata:{name,description,tags}}` or `{expectedRevision,status:'active'|'archived'}`. Stale revisions return 409 `IMAGE_REVISION_CONFLICT`; archive/new-placement conflicts return 409 `IMAGE_ARCHIVED`
- `GET /api/rooms/:room/assets` defaults to active entries; `?status=archived` requires management authority. Current envelopes include revision and mutable metadata, separate from version data
- Ordinary readers can fetch archived bytes only for an exact version still pinned in the saved room scene. Full editors can also fetch them for management thumbnails. Both paths require live same-room access and retain private/no-store, nosniff and same-origin response headers
- A scene transaction checks every proposed instance, including repeated references. An archived reference is allowed only when the same instance ID and exact asset/version exist in the previous saved scene. A retained reference cannot authorize a new copy. Archive and scene save are serialized on the same SQLite connection/write lock
- Lifecycle notifications contain only IDs, revision and status. Clients update known status and refresh authorized library/room projections; hidden archived metadata is never broadcast to ordinary readers. Version bodies stay unchanged. Revision-aware merge prevents late room/list responses from reversing a newer archive/restore notification. Server checks remain authoritative when a client misses a notification

## Verification boundary

`tests/image-assets-lifecycle.test.mjs` exercises real loopback HTTP, cookie sessions, streamed requests and temporary SQLite databases. It covers edit/search/persistence, stale/concurrent CAS, old-schema migration, role/ancestor/session revocation, foreign rooms, editor-versus-reader bytes, personal-space bounds, historical-version pins, both archive/scene-save orderings, same-instance retention and new-copy/committed-removal rejection.

`tests/image-lifecycle-contract.test.mjs` and `tests/image-library-shell.test.mjs` cover metadata validation, exact archived geometry/collision, discovery separation, HTTP transport and stale-cache revisions.

`tests/image-lifecycle.full.mjs` is the actual-game acceptance entry in `npm run test:browser:images`. It uses local generated PNGs and native browser pointer/keyboard/file-chooser input, with read-only scene/projection diagnostics. Results and screenshots are written to `evidence/image-lifecycle-full/`. Record the final executed result separately; a test's presence is not a passing result.

All tests are bounded local Chromium/SwiftShader and fresh local databases. No production assets, external services, real relay/provider, physical-phone rendering, public deployment or irreversible data removal are exercised.

## Final local candidate snapshot · 2026-10-02

- 599 CPU/API tests passed, one explicitly skipped historical fixture; 199 JavaScript source files syntax-checked
- Build, package-startup verification and container-file simulation passed; no dependency installation
- Existing image regressions passed: 7 shell/bridge, 12 direct-builder and 18 full-game checks, including native 320px touch placement, all run serially. Regression log: `evidence/asset-lifecycle-final/image-regressions.log`
- All 9 actual-game lifecycle acceptance checks passed with no unhandled runtime errors. Final evidence is `evidence/image-lifecycle-final/results.json` with screenshots 01–08; prior interrupted/test-harness attempts remain separate and are not final passing evidence
- Tested JS SHA-256: `ff8c38512e11ea61d64848fd3b6bcbb6efb093bc050fb5ebb25912e643007672`; CSS: `a726de7058af0a6613cf0a24a96340ade22792e7b542321c2a0ed7b537a0218e`
- Source is based on published P2P commit `be6d136961010f986fde7c1ddaf13b66e164621a`. Existing P2P/freshness/resident/creator source is preserved; this record does not claim other browser groups were rerun on this bundle, remote CI, publication or deployment
