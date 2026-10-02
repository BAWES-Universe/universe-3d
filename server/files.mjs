import { randomUUID, createHash } from 'node:crypto';
import { fail } from './validation.mjs';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ROOM_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_ROOM_FILES = 100;
const EDIT = ['owner', 'admin', 'editor'];
const FORMATS = {
  pdf: ['application/pdf'], png: ['image/png'], jpg: ['image/jpeg'], jpeg: ['image/jpeg'],
  gif: ['image/gif'], webp: ['image/webp'], txt: ['text/plain'],
  md: ['text/markdown', 'text/plain'], csv: ['text/csv', 'text/plain'], json: ['application/json', 'text/plain'],
};

function uploadMetadata(req) {
  if (!/^application\/octet-stream$/i.test(req.headers['content-type'] || ''))
    fail(415, 'FILE_BODY_REQUIRED', 'Upload file bytes with Content-Type: application/octet-stream');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')
    fail(415, 'FILE_ENCODING_REJECTED', 'Compressed upload requests are not supported');
  let name;
  try { name = decodeURIComponent(req.headers['x-file-name'] || ''); } catch { fail(400, 'INVALID_FILE_NAME', 'Invalid encoded filename'); }
  // Filenames are display metadata only. Reject path separators, controls, bidi overrides,
  // trailing dots/spaces, and hidden/path-like names rather than silently rewriting them.
  if (!name || name !== name.trim() || name.length > 160 || Buffer.byteLength(name) > 240 ||
      /^[.]/.test(name) || /[. ]$/.test(name) || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069/\\<>:"|?*]/u.test(name))
    fail(400, 'INVALID_FILE_NAME', 'Use a plain filename of at most 160 characters without paths or control characters');
  const extension = name.split('.').at(-1).toLowerCase();
  const allowed = FORMATS[extension];
  if (!allowed) fail(415, 'UNSUPPORTED_FILE', 'Choose a PDF, PNG, JPEG, GIF, WebP, text, Markdown, CSV, or JSON file');
  const supplied = req.headers['x-file-type'] || 'application/octet-stream';
  if (typeof supplied !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(supplied))
    fail(400, 'INVALID_FILE_TYPE', 'Invalid file content type');
  const contentType = supplied.toLowerCase() === 'application/octet-stream' ? allowed[0] : supplied.toLowerCase();
  if (!allowed.includes(contentType)) fail(415, 'FILE_TYPE_MISMATCH', 'The file type must match its filename extension');
  return { name, contentType, extension };
}

// Do not use async iteration here: throwing from it destroys the request socket,
// which would turn a clear 413 into an opaque client network error.
function readBytes(req) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
    req.resume();
    fail(413, 'FILE_TOO_LARGE', 'Files must be at most 5 MiB');
  }
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    const cleanup = () => { req.off('data', onData); req.off('end', onEnd); req.off('aborted', onAbort); req.off('error', onError); };
    const onError = error => { cleanup(); chunks = []; reject(error); };
    const onAbort = () => onError(Object.assign(new Error('Upload interrupted'), { status: 400, code: 'UPLOAD_INTERRUPTED' }));
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks, size)); };
    const onData = chunk => {
      size += chunk.length;
      if (size > MAX_FILE_BYTES) {
        cleanup(); chunks = []; req.resume();
        reject(Object.assign(new Error('Files must be at most 5 MiB'), { status: 413, code: 'FILE_TOO_LARGE' }));
      } else chunks.push(chunk);
    };
    req.on('data', onData); req.on('end', onEnd); req.on('aborted', onAbort); req.on('error', onError);
  });
}

function validateBytes(bytes, extension) {
  if (!bytes.length) fail(400, 'EMPTY_FILE', 'Choose a non-empty file');
  const starts = value => bytes.subarray(0, value.length).equals(value);
  const valid = extension === 'pdf' ? starts(Buffer.from('%PDF-')) :
    extension === 'png' ? starts(Buffer.from([137,80,78,71,13,10,26,10])) :
    ['jpg','jpeg'].includes(extension) ? starts(Buffer.from([255,216,255])) :
    extension === 'gif' ? ['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString()) :
    extension === 'webp' ? bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP' : true;
  if (!valid) fail(415, 'FILE_SIGNATURE_MISMATCH', 'The file content does not match its format');
  // Text formats are downloadable too; they never become same-origin HTML.
  if (['txt','md','csv','json'].includes(extension)) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(415, 'INVALID_TEXT_FILE', 'Text documents must be UTF-8'); }
    if (bytes.includes(0)) fail(415, 'INVALID_TEXT_FILE', 'Text documents cannot contain null bytes');
  }
}

function metadata(row) {
  return { id: row.id, roomId: row.room_id, name: row.name, contentType: row.content_type, size: row.size,
    createdAt: row.created_at, createdBy: row.created_by, deletedAt: row.deleted_at,
    url: `/api/rooms/${row.room_id}/files/${row.id}` };
}

function disposition(name) {
  const fallback = name.replace(/[^A-Za-z0-9 ._()-]/g, '_');
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function createRoomFileService({ store, now = Date.now, send, session }) {
  // Store opaque-ID bytes and metadata in the same SQLite transaction. Neither an
  // uploaded filename nor URL is ever interpreted as an on-disk storage path.
  store.db.exec(`CREATE TABLE IF NOT EXISTS room_files (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL,
    bytes BLOB NOT NULL, sha256 TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL, deleted_at INTEGER
  ); CREATE INDEX IF NOT EXISTS room_files_room ON room_files(room_id,created_at);`);

  return { async handle({ req, res, path, method, userId, url }) {
    const match = path.match(/^\/api\/rooms\/([A-Za-z0-9_-]{1,80})\/files(?:\/([A-Za-z0-9_-]{1,80})(?:\/(restore))?)?$/);
    if (!match) return false;
    const [, roomId, fileId, action] = match;
    store.authorize(roomId, userId);
    if (!fileId && method === 'GET') {
      const includeDeleted = url.searchParams.get('includeDeleted') === '1';
      if (includeDeleted) store.authorize(roomId, userId, EDIT);
      const rows = store.all(`SELECT id,room_id,name,content_type,size,created_by,created_at,deleted_at FROM room_files WHERE room_id=? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY created_at DESC,id`, roomId);
      send(res, 200, { files: rows.map(metadata), maxFileBytes: MAX_FILE_BYTES, maxRoomBytes: MAX_ROOM_FILE_BYTES });
      return true;
    }
    if (!fileId && method === 'POST') {
      store.authorize(roomId, userId, EDIT);
      const info = uploadMetadata(req), bytes = await readBytes(req);
      validateBytes(bytes, info.extension);
      // Body reads yield: recheck session and role before committing the bytes.
      if (session(req).user_id !== userId) fail(401, 'AUTH_REQUIRED');
      const file = store.transaction(() => {
        store.authorize(roomId, userId, EDIT);
        const usage = store.get('SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM room_files WHERE room_id=?', roomId);
        // Tombstones retain bytes for recovery and therefore still consume quota.
        if (usage.count >= MAX_ROOM_FILES || usage.bytes + bytes.length > MAX_ROOM_FILE_BYTES)
          fail(409, 'ROOM_FILE_QUOTA', 'Room document storage is full (100 files or 50 MiB, including deleted files)');
        const id = randomUUID();
        store.run('INSERT INTO room_files(id,room_id,name,content_type,size,bytes,sha256,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id, roomId, info.name, info.contentType, bytes.length, bytes, createHash('sha256').update(bytes).digest('hex'), userId, now());
        return metadata(store.get('SELECT * FROM room_files WHERE room_id=? AND id=?', roomId, id));
      });
      send(res, 201, { file }); return true;
    }
    if (fileId && !action && ['GET','HEAD'].includes(method)) {
      const row = store.get('SELECT * FROM room_files WHERE room_id=? AND id=? AND deleted_at IS NULL', roomId, fileId);
      if (!row) fail(404, 'FILE_NOT_FOUND', 'Document not found');
      if(session(req).user_id!==userId)fail(401,'AUTH_REQUIRED');
      store.authorize(roomId,userId);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream', 'Content-Length': row.size,
        'Content-Disposition': disposition(row.name), 'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Security-Policy': "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.end(method === 'HEAD' ? undefined : Buffer.from(row.bytes)); return true;
    }
    if (fileId && ((!action && method === 'DELETE') || (action === 'restore' && method === 'POST'))) {
      const file = store.transaction(() => {
        store.authorize(roomId, userId, EDIT);
        const row = store.get('SELECT * FROM room_files WHERE room_id=? AND id=?', roomId, fileId);
        if (!row) fail(404, 'FILE_NOT_FOUND', 'Document not found');
        store.run('UPDATE room_files SET deleted_at=? WHERE room_id=? AND id=?', action === 'restore' ? null : row.deleted_at ?? now(), roomId, fileId);
        return metadata(store.get('SELECT * FROM room_files WHERE room_id=? AND id=?', roomId, fileId));
      });
      send(res, 200, { file }); return true;
    }
    fail(405, 'METHOD_NOT_ALLOWED', 'Unsupported document action');
  } };
}
