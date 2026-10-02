import { createHash, randomUUID } from 'node:crypto';
import { normalizeImageAssetDraft, validateImageDefinition, validateAssetReference, validateImageInstance } from '../src/image-asset-schema.js';
import { searchImageLibrary } from '../src/image-library.js';

export const IMAGE_ASSET_LIMITS = Object.freeze({ maxBytes: 5 * 1024 * 1024, maxRoomBytes: 50 * 1024 * 1024, maxRoomDefinitions: 100, maxSceneObjects: 2000 });
export const IMAGE_RESPONSE_HEADERS = Object.freeze({
  'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'private, no-store', 'Cross-Origin-Resource-Policy': 'same-origin',
});
export class ImageAssetServiceError extends Error {
  constructor(status, code, message) { super(message); this.name = 'ImageAssetServiceError'; this.status = status; this.code = code; }
}
function fail(status, code, message) { throw new ImageAssetServiceError(status, code, message); }
function identifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail(400, 'IMAGE_INVALID_ID', `Invalid ${label}`);
  return value;
}
function sync(value, label) {
  if (value && typeof value.then === 'function') throw new TypeError(`${label} must be synchronous for transaction-coupled authority`);
  return value;
}
function canonical(value, depth = 0) {
  if (depth > 16) fail(400, 'IMAGE_DRAFT', 'Image metadata is too deeply nested');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`;
  fail(400, 'IMAGE_DRAFT', 'Image metadata must be plain JSON');
}
function frozenEntry(entry) {
  const normalized = validateImageDefinition(entry.definition, entry.version);
  if (!['active', 'deleted'].includes(entry.status)) throw new Error('Repository returned invalid asset status');
  return Object.freeze({ ...normalized, status: entry.status });
}
export const imageReferenceKey = reference => `${reference.assetId}:${reference.versionId}`;

/**
 * Hooks are trusted host adapters, not client capability booleans.
 * authorizeRead/authorizeManage({roomId,userId,session}) must return true or
 * throw/return false. resolveSession(opaqueIdentity) returns a live
 * {userId,currentRoomId,expiresAt:number,sessionEpoch?:string|number} or null.
 * Hooks, repo and transaction are synchronous; ONLY image decoding may await.
 * A sessionEpoch lets a host reject leave-and-return during an upload as well.
 * validateImage is REQUIRED and must fully decode bounded bytes. Wire the
 * provided restrictive validatePng or a vetted decoder; never a signature test.
 */
export function createImageAssetService({ repo, authorizeRead, authorizeManage, resolveSession, validateImage, now = Date.now, newId = randomUUID, transaction, afterCommit = () => {}, limits = {} }) {
  for (const [name, value] of Object.entries({ authorizeRead, authorizeManage, resolveSession, validateImage })) if (typeof value !== 'function') throw new TypeError(`${name} is required`);
  if (!repo || typeof repo.transaction !== 'function') throw new TypeError('An image repository is required');
  const commitTransaction = transaction ?? (fn => repo.transaction(fn));
  const cap = {};
  for (const [name, ceiling] of Object.entries(IMAGE_ASSET_LIMITS)) {
    cap[name] = limits[name] ?? ceiling;
    if (!Number.isSafeInteger(cap[name]) || cap[name] < 1 || cap[name] > ceiling) throw new TypeError(`Invalid image asset limit: ${name}`);
  }
  function identity(args) {
    identifier(args.roomId, 'room'); identifier(args.userId, 'actor');
    if (typeof args.sessionIdentity !== 'string' || !args.sessionIdentity || args.sessionIdentity.length > 2048) fail(401, 'IMAGE_SESSION', 'An active room session is required');
    return Object.freeze({ roomId: args.roomId, userId: args.userId, sessionIdentity: args.sessionIdentity });
  }
  function authority(context, manage = false, expectedStamp) {
    const session = sync(resolveSession(context.sessionIdentity), 'resolveSession');
    if (!session || session.userId !== context.userId || session.currentRoomId !== context.roomId || !Number.isFinite(session.expiresAt) || session.expiresAt <= now()) fail(401, 'IMAGE_SESSION', 'The room session is no longer active');
    const stamp = canonical({ userId: session.userId, roomId: session.currentRoomId, epoch: session.sessionEpoch ?? null });
    if (expectedStamp !== undefined && expectedStamp !== stamp) fail(409, 'IMAGE_SESSION_CHANGED', 'The room session changed while the upload was pending');
    if (sync(authorizeRead({ roomId: context.roomId, userId: context.userId, session }), 'authorizeRead') !== true) fail(404, 'IMAGE_NOT_FOUND', 'Room image assets are unavailable');
    if (manage && sync(authorizeManage({ roomId: context.roomId, userId: context.userId, session }), 'authorizeManage') !== true) fail(403, 'IMAGE_MANAGE_DENIED', 'Full room editing rights are required to upload image assets');
    return stamp;
  }
  function findActive(roomId, reference) {
    const entry = repo.getVersion(roomId, reference.assetId, reference.versionId);
    if (!entry || entry.status !== 'active') fail(404, 'IMAGE_NOT_FOUND', 'The image reference is unavailable in this room');
    return frozenEntry(entry);
  }
  function replay(context, operationId, digest) {
    const previous = repo.getOperation(context.roomId, context.userId, operationId);
    if (!previous) return null;
    if (previous.digest !== digest) fail(409, 'IMAGE_OPERATION_CONFLICT', 'This upload operation was already used for different content');
    return findActive(context.roomId, previous);
  }
  const service = {
    // Transport uses this before awaiting a body. Returned stamp is server-only.
    checkAccess(args, { manage = false } = {}) { return authority(identity(args), manage); },
    list(args) {
      const context = identity(args); authority(context);
      if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 240)) fail(400, 'IMAGE_QUERY', 'Search query must be at most 240 characters');
      return Object.freeze({ entries: searchImageLibrary(repo.list(context.roomId).map(frozenEntry), { query: args.query ?? '', category: 'custom' }) });
    },
    reconcileCreate(args) {
      const context = identity(args); authority(context); identifier(args.operationId, 'operation');
      const previous = repo.getOperation(context.roomId, context.userId, args.operationId);
      if (!previous) return Object.freeze({ status: 'not-found' });
      return Object.freeze({ status: 'committed', entry: findActive(context.roomId, previous) });
    },
    async create(args) {
      const context = identity(args);
      const stamp = authority(context, true, args.expectedSessionStamp);
      const operationId = identifier(args.operationId, 'operation');
      if (!(args.bytes instanceof Uint8Array) || !args.bytes.length) fail(400, 'IMAGE_BYTES', 'Choose a nonempty PNG image');
      if (args.bytes.length > cap.maxBytes) fail(413, 'IMAGE_TOO_LARGE', 'Image exceeds the supported byte limit');
      // Own both mutable inputs before the first await. A browser/client mutation
      // during decode must never change what the digest or committed row means.
      const bytes = Buffer.from(args.bytes), mediaType = args.mediaType ?? 'image/png';
      const draftText = canonical(args.draft);
      if (Buffer.byteLength(draftText) > 64 * 1024) fail(400, 'IMAGE_DRAFT', 'Image metadata is too large');
      const draft = JSON.parse(draftText);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const digest = createHash('sha256').update(canonical({ draft, mediaType, sha256 })).digest('hex');
      const existing = replay(context, operationId, digest);
      if (existing) return existing;
      const decoded = await validateImage(Buffer.from(bytes), { mediaType });
      // Injected decoder is trusted, but cannot substitute bytes or media claims.
      if (!decoded || decoded.mediaType !== 'image/png' || decoded.byteLength !== bytes.length) fail(400, 'IMAGE_DECODE', 'Image decoder returned inconsistent image information');
      const metadata = normalizeImageAssetDraft(draft, decoded);
      if (repo.inTransaction) throw new Error('Image creation cannot commit inside an unrelated open transaction');
      let didCreate = false;
      const entry = sync(commitTransaction(() => {
        if (!repo.inTransaction) throw new Error('Image commits require the repository transaction connection');
        authority(context, true, stamp);
        const duplicate = replay(context, operationId, digest);
        if (duplicate) return duplicate;
        const usage = repo.usage(context.roomId);
        if (usage.definitions >= cap.maxRoomDefinitions || usage.bytes + bytes.length > cap.maxRoomBytes) fail(409, 'IMAGE_ROOM_QUOTA', 'Room image storage quota has been reached');
        const createdAt = new Date(now()).toISOString(), assetId = newId(), versionId = newId();
        const result = frozenEntry({ status: 'active',
          definition: { schemaVersion: 1, assetId, roomId: context.roomId, createdBy: context.userId, createdAt, originKind: 'upload' },
          version: { ...metadata, schemaVersion: 1, assetId, roomId: context.roomId, versionId, sequence: 1, sha256, createdBy: context.userId, createdAt },
        });
        repo.insertCreated({ entry: result, bytes, userId: context.userId, operationId, digest });
        didCreate = true;
        return result;
      }), 'transaction');
      // Creation cannot nest under another transaction: decoding is async and
      // afterCommit must truly follow durability. Scene resolution is sync below.
      if (didCreate) {
        const event = Object.freeze({ type: 'imageAsset.created', roomId: context.roomId, assetId: entry.definition.assetId, versionId: entry.version.versionId });
        // Delivery failure cannot relabel a durable commit as upload failure.
        try { await afterCommit(event); } catch { /* host can reconcile committed identity */ }
      }
      return entry;
    },
    readImage(args) {
      const context = identity(args); authority(context);
      const reference = validateAssetReference({ assetId: args.assetId, versionId: args.versionId });
      const entry = findActive(context.roomId, reference);
      const bytes = args.head ? null : repo.getBytes(context.roomId, reference.assetId, reference.versionId);
      if (!args.head && (!bytes || bytes.length !== entry.version.byteLength)) throw new Error('Stored image bytes are unavailable');
      return Object.freeze({ bytes, mediaType: 'image/png', byteLength: entry.version.byteLength,
        headers: Object.freeze({ ...IMAGE_RESPONSE_HEADERS, 'Content-Length': String(entry.version.byteLength) }) });
    },
    resolveSceneReferences(args) {
      if (!repo.inTransaction) throw new Error('Resolve image references inside the SAME transaction as the scene save');
      const context = identity(args); authority(context);
      const objects = args.scene?.objects;
      if (!Array.isArray(objects) || objects.length > cap.maxSceneObjects) fail(400, 'IMAGE_SCENE', 'A bounded scene object array is required');
      const resolved = Object.create(null);
      for (const object of objects) {
        if (!object || object.type !== 'image') continue; // Built-in validation remains the host's job.
        const instance = validateImageInstance(object);
        const key = imageReferenceKey(instance.assetRef);
        if (!Object.hasOwn(resolved, key)) resolved[key] = findActive(context.roomId, instance.assetRef);
      }
      // This authorizes reading the definitions, NEVER scene placement. The host
      // still validates actions, room CAS, areas, footprints, actors and arrival.
      return Object.freeze(resolved);
    },
    withResolvedSceneReferences(args, persistScene) {
      if (typeof persistScene !== 'function') throw new TypeError('A synchronous host scene commit callback is required');
      return sync(commitTransaction(() => sync(persistScene(service.resolveSceneReferences(args)), 'persistScene')), 'transaction');
    },
  };
  const create = service.create;
  service.create = args => {
    if (repo.inTransaction) return Promise.reject(new Error('Do not await image creation inside a SQLite transaction'));
    return create(args);
  };
  return Object.freeze(service);
}

export const IMAGE_UPLOAD_JSON_LIMIT = 7 * 1024 * 1024;
function readUploadJson(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) fail(415, 'IMAGE_BODY_TYPE', 'Use application/json for image uploads');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') fail(415, 'IMAGE_BODY_ENCODING', 'Compressed upload bodies are unsupported');
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > IMAGE_UPLOAD_JSON_LIMIT)) { req.resume(); fail(413, 'IMAGE_BODY_TOO_LARGE', 'Image upload body exceeds the limit'); }
  if (req.aborted) fail(400, 'IMAGE_UPLOAD_INTERRUPTED', 'Image upload was interrupted');
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('aborted', abort); req.off('error', error); };
    const error = cause => { cleanup(); chunks = []; reject(cause); };
    const abort = () => error(new ImageAssetServiceError(400, 'IMAGE_UPLOAD_INTERRUPTED', 'Image upload was interrupted'));
    const data = chunk => {
      size += chunk.length;
      if (size > IMAGE_UPLOAD_JSON_LIMIT) { error(new ImageAssetServiceError(413, 'IMAGE_BODY_TOO_LARGE', 'Image upload body exceeds the limit')); req.resume(); }
      else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
        const body = JSON.parse(text);
        if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(key => !['draft', 'pngBase64', 'mediaType', 'operationId'].includes(key))) fail(400, 'IMAGE_BODY', 'Invalid image upload fields');
        if (typeof body.pngBase64 !== 'string' || body.pngBase64.length > 4 * Math.ceil(IMAGE_ASSET_LIMITS.maxBytes / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.pngBase64)) fail(400, 'IMAGE_BASE64', 'Expected canonical base64 PNG bytes');
        const bytes = Buffer.from(body.pngBase64, 'base64');
        if (bytes.toString('base64') !== body.pngBase64) fail(400, 'IMAGE_BASE64', 'Expected canonical base64 PNG bytes');
        resolve({ draft: body.draft, mediaType: body.mediaType, operationId: body.operationId, bytes });
      } catch (cause) { reject(cause.status ? cause : new ImageAssetServiceError(400, 'IMAGE_BODY', 'Invalid UTF-8 JSON image upload')); }
      chunks = [];
    };
    req.on('data', data); req.on('end', end); req.on('aborted', abort); req.on('error', error);
  });
}

/** Optional standalone transport seam; never mounts itself or changes /files.
 * getIdentity(req) is a trusted synchronous cookie/session adapter, returning
 * {userId,sessionIdentity}. It must not accept identity from JSON or query args.
 * Return false for other routes so the host router can continue.
 */
export function createImageAssetHttpHandler({ service, getIdentity }) {
  if (typeof getIdentity !== 'function') throw new TypeError('A trusted request identity adapter is required');
  const json = (res, status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': String(Buffer.byteLength(body)) });
    res.end(body);
  };
  return async function handleImageAssets(req, res) {
    const url = new URL(req.url, 'http://image-assets.invalid');
    const match = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{1,128})\/assets(?:\/(?:operations\/([A-Za-z0-9_-]{1,128})|([A-Za-z0-9_-]{1,128})\/versions\/([A-Za-z0-9_-]{1,128})\/image))?$/);
    if (!match) return false;
    const [, roomId, operationId, assetId, versionId] = match;
    try {
      const authenticated = sync(getIdentity(req), 'getIdentity');
      const context = { userId: authenticated?.userId, sessionIdentity: authenticated?.sessionIdentity, roomId };
      if (!assetId && !operationId && req.method === 'GET') json(res, 200, service.list({ ...context, query: url.searchParams.get('query') ?? '' }));
      else if (operationId && req.method === 'GET') json(res, 200, service.reconcileCreate({ ...context, operationId }));
      else if (!assetId && !operationId && req.method === 'POST') {
        const expectedSessionStamp = service.checkAccess(context, { manage: true });
        const upload = await readUploadJson(req);
        const entry = await service.create({ ...upload, ...context, expectedSessionStamp });
        json(res, 201, entry);
      } else if (assetId && ['GET', 'HEAD'].includes(req.method)) {
        const result = service.readImage({ ...context, assetId, versionId, head: req.method === 'HEAD' });
        res.writeHead(200, result.headers); res.end(result.bytes);
      } else { json(res, 405, { error: { code: 'IMAGE_METHOD', message: 'Image asset method is unsupported' } }); }
    } catch (error) {
      req.resume();
      const status = Number.isInteger(error.status) ? error.status : error.name === 'ImageAssetValidationError' ? 400 : 500;
      if (!res.headersSent) json(res, status, { error: { code: status === 500 ? 'IMAGE_INTERNAL' : error.code ?? 'IMAGE_INVALID', message: status === 500 ? 'Image request could not be completed' : error.message } });
      else res.destroy();
    }
    return true;
  };
}
