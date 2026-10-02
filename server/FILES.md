# Room document items

This standalone implementation covers authenticated uploads attached to map items and room-scoped downloads. The source documentation's document-item contract is `docs/map-building/inline-editor/entity-editor/upload-file.md` and `open-file.md`: select a PDF/image, attach it to an entity, and let authorized room members open its document. This is not an asset marketplace or a custom mesh/image-entity uploader. For safety, this local application downloads attachments instead of embedding active documents in the application origin.

## API

All routes require the existing HttpOnly session cookie and pass the application's same-origin checks. Universe owner, world admin, and authorized room/world editor roles can upload, remove, and restore. Current hierarchy-authorized users can list/download, including authenticated guest profiles when the entire ancestor chain is public. Visiting creates no durable membership. Private ancestors and bans override access. Each request rechecks ACL. Uploads additionally recheck the session and ACL after receiving their body.

- `POST /api/rooms/:roomId/files`: raw bytes, `Content-Type: application/octet-stream`, `X-File-Name: encodeURIComponent(originalFilename)`, `X-File-Type: original MIME type` (optional; absent or `application/octet-stream` is inferred from the allowed extension). Returns 201 `{file}`
- `GET /api/rooms/:roomId/files`: returns `{files,maxFileBytes,maxRoomBytes}`; no bytes in the listing
- `GET /api/rooms/:roomId/files?includeDeleted=1`: owner/admin/editor-only listing including recoverable removals
- `GET` or `HEAD /api/rooms/:roomId/files/:fileId`: authenticated download; a file ID cannot be used through another room's route
- `DELETE /api/rooms/:roomId/files/:fileId`: recoverable removal; returns `{file}` with `deletedAt`, removes it from ordinary listing and download
- `POST /api/rooms/:roomId/files/:fileId/restore`: restores retained bytes and the same URL; returns `{file}`

Metadata: `{id,roomId,name,contentType,size,createdAt,createdBy,deletedAt,url}`. IDs are server-generated UUIDs; all uploaded bytes and metadata live transactionally in SQLite. Uploaded names are never filesystem paths. Keeping the database preserves documents after restart. Archiving the containing universe/world/room retains its files and immediately blocks their URLs; recovery restores eligible access to the same bytes and identities.

Limits are 5 MiB per file, 50 MiB or 100 files per room, including recoverable removals. Supported extensions: PDF, PNG, JPG/JPEG, GIF, WebP, TXT, MD, CSV, JSON. MIME must agree with the extension; images/PDF require matching format signatures, and text must be UTF-8 without null bytes. Signature validation is not malware scanning or a complete document parser. Filenames cannot include paths, control/bidi characters, hidden-file prefixes, unsafe punctuation, or trailing dots/spaces; they are capped at 160 characters/240 UTF-8 bytes. Empty files and encoded/compressed request bodies are rejected. No URL-fetch ingestion exists.

Downloads always use `application/octet-stream`, `Content-Disposition: attachment` with both safe ASCII and encoded Unicode filenames, `nosniff`, private `no-store` caching, same-origin resource policy, and a restrictive sandbox CSP. HTML, SVG and script extensions/MIMEs are refused. HTML text disguised as `.txt` still downloads as an attachment. These defenses prevent same-origin document execution; users should still trust a file before opening it in a separate application.

## In-game integration

`src/files.js` exports:

- `attachRoomFile({roomId,file,signal?})` returns file metadata after upload
- `FILE_ACCEPT` for file input and `MAX_FILE_BYTES` for client guidance
- `listRoomFiles(roomId,{includeDeleted?,signal?})`
- `deleteRoomFile(roomId,fileId)` and `restoreRoomFile(roomId,fileId)`
- `roomDocumentLink(file)` creates an accessible anchor with the original download filename

Capture room ID and object ID before awaiting an upload. After success, set that object's `url` to `file.url` and its name to `file.name` (or the user's chosen title); persist the scene through normal revisioned saving. Do not attach the completed upload to a newly selected object or different room if navigation occurred while bytes were uploading. Browser cancellation uses `AbortSignal`. An interrupted upload before commit creates no metadata; if a client loses the response after commit, the owner/editor can find that file in the room file listing.

## Checks

`node --test tests/files.test.mjs` exercises owner/admin/editor/member/guest/banned permissions and private ancestry, in-flight role revocation, cross-room ID isolation, safe attachment/Unicode headers, active document refusal, filename/MIME/byte validation, declared/chunked oversize rejection, recoverable removal, storage quotas, and restart persistence including scene object URLs.
