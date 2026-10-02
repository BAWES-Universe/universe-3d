import {IMAGE_ASSET_LIMITS, validateResolvedImageAsset} from './image-asset-schema.js';

export class ImageAssetLoadError extends Error {
  constructor(code, message) { super(message); this.name = 'ImageAssetLoadError'; this.code = code; }
}
export const imageAbortError = () => Object.assign(new Error('Image load cancelled'), {name: 'AbortError'});
const checkAbort = signal => { if (signal?.aborted) throw imageAbortError(); };
function baseOrigin(origin) {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new ImageAssetLoadError('UNSAFE_IMAGE_ORIGIN', 'Images require the current HTTP(S) origin');
  return base.origin;
}
export function imageAssetPath(resolved) {
  const asset = validateResolvedImageAsset(resolved);
  return `/api/rooms/${encodeURIComponent(asset.definition.roomId)}/assets/${encodeURIComponent(asset.definition.assetId)}/versions/${encodeURIComponent(asset.version.versionId)}/image`;
}
/** This resolver constructs a dedicated endpoint; it never reads a URL from instance JSON. */
export function resolveAuthorizedImageURL({resolved, context, origin}) {
  const asset = validateResolvedImageAsset(resolved);
  if (!context?.canRead || context.roomId !== asset.definition.roomId || !['active','archived'].includes(asset.status)) throw new ImageAssetLoadError('IMAGE_ACCESS_UNAVAILABLE', 'This image is unavailable in the current room');
  return new URL(imageAssetPath(asset), baseOrigin(origin)).href;
}
/** Resolver injection cannot expand the destination beyond the exact dedicated same-origin route. */
export function validateAuthorizedImageURL(candidate, {resolved, context, origin}) {
  const expected = resolveAuthorizedImageURL({resolved, context, origin});
  const url = new URL(candidate, baseOrigin(origin));
  if (url.href !== expected || url.username || url.password || url.hash || url.search) throw new ImageAssetLoadError('UNSAFE_IMAGE_URL', 'Image URLs must use the exact authenticated same-origin image endpoint');
  return expected;
}
function checkPngEnvelope(bytes, version) {
  // Defense in depth before browser allocation, not a replacement for server full PNG validation.
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || signature.some((value, i) => bytes[i] !== value) || bytes[8] !== 0 || bytes[9] !== 0 || bytes[10] !== 0 || bytes[11] !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') throw new ImageAssetLoadError('IMAGE_PNG_ENVELOPE', 'Image bytes must contain a PNG header');
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), width = data.getUint32(16), height = data.getUint32(20);
  if (width !== version.widthPixels || height !== version.heightPixels || width > IMAGE_ASSET_LIMITS.maxDimension || height > IMAGE_ASSET_LIMITS.maxDimension || width * height > IMAGE_ASSET_LIMITS.maxPixels) throw new ImageAssetLoadError('IMAGE_DIMENSION_MISMATCH', 'PNG dimensions do not match the bounded pinned version');
}
async function boundedBytes(response, expectedLength, signal) {
  const header = response.headers.get('content-length');
  if (header !== null && (!/^\d+$/.test(header) || Number(header) !== expectedLength)) throw new ImageAssetLoadError('IMAGE_LENGTH_MISMATCH', 'Image byte length does not match its pinned version');
  const reader = response.body?.getReader();
  if (!reader) throw new ImageAssetLoadError('IMAGE_BODY_UNAVAILABLE', 'Image response is not readable');
  const chunks = []; let size = 0;
  try {
    while (true) {
      checkAbort(signal); const {done, value} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > expectedLength || size > IMAGE_ASSET_LIMITS.maxBytes) throw new ImageAssetLoadError('IMAGE_TOO_LARGE', 'Image response exceeds the pinned byte limit');
      chunks.push(value);
    }
    if (size !== expectedLength) throw new ImageAssetLoadError('IMAGE_LENGTH_MISMATCH', 'Image response is truncated');
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    return bytes;
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
/** Fetch is bounded and authenticated, redirects are rejected, and the pinned SHA is verified
 * before image decoding. decodeTexture is the only engine-specific seam. */
export function createAuthenticatedImageLoader({origin = globalThis.location?.origin, fetchImage = globalThis.fetch?.bind(globalThis), resolveURL = resolveAuthorizedImageURL, digest = bytes => globalThis.crypto.subtle.digest('SHA-256', bytes), decodeTexture}) {
  const trustedOrigin = baseOrigin(origin);
  if (typeof fetchImage !== 'function' || typeof decodeTexture !== 'function') throw new TypeError('fetchImage and decodeTexture are required');
  return async ({resolved, placement, context, signal}) => {
    const asset = validateResolvedImageAsset(resolved); checkAbort(signal);
    const args = {resolved: asset, placement, context, origin: trustedOrigin, signal};
    const candidate = await resolveURL(args); checkAbort(signal);
    const url = validateAuthorizedImageURL(candidate, args);
    const response = await fetchImage(url, {method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: {Accept: 'image/png'}, signal});
    checkAbort(signal);
    if (!response.ok) throw new ImageAssetLoadError(response.status === 401 || response.status === 403 ? 'IMAGE_ACCESS_DENIED' : 'IMAGE_HTTP_ERROR', `Image request failed (${response.status})`);
    if (response.redirected || (response.url && response.url !== url)) throw new ImageAssetLoadError('UNSAFE_IMAGE_REDIRECT', 'Image redirects are not accepted');
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'image/png') throw new ImageAssetLoadError('IMAGE_MEDIA_TYPE', 'Image response must be PNG');
    const bytes = await boundedBytes(response, asset.version.byteLength, signal); checkAbort(signal);
    const hash = [...new Uint8Array(await digest(bytes))].map(value => value.toString(16).padStart(2, '0')).join(''); checkAbort(signal);
    if (hash !== asset.version.sha256) throw new ImageAssetLoadError('IMAGE_DIGEST_MISMATCH', 'Image bytes do not match the pinned asset version');
    checkPngEnvelope(bytes, asset.version);
    const resource = await decodeTexture({bytes, resolved: asset, placement, signal});
    if (signal?.aborted) { resource?.dispose?.(); throw imageAbortError(); }
    return resource;
  };
}

export function imageTextureKey({resolved, context}) {
  const asset = validateResolvedImageAsset(resolved);
  for (const epoch of [context?.roomEpoch, context?.authorityEpoch]) if (!['string', 'number'].includes(typeof epoch) || (typeof epoch === 'number' && !Number.isFinite(epoch))) throw new TypeError('Texture epochs must be finite numbers or strings');
  return JSON.stringify([asset.definition.roomId, asset.definition.assetId, asset.version.versionId, asset.version.sha256, context.roomEpoch, context.authorityEpoch]);
}
/** One decoded/GPU texture per pinned version + authority scope. No warm cache remains after
 * the last lease. Pending consumers share the request but retain independent cancellation. */
export function createImageTexturePool({loadTexture, maxResidentPixels = 16 * 1024 * 1024, maxResidentBytes = 50 * 1024 * 1024} = {}) {
  if (typeof loadTexture !== 'function' || !Number.isSafeInteger(maxResidentPixels) || maxResidentPixels < 1 || !Number.isSafeInteger(maxResidentBytes) || maxResidentBytes < 1) throw new TypeError('Texture pool requires a loader and positive integer budgets');
  const entries = new Map(); let pixels = 0, bytes = 0, disposed = false;
  function destroy(entry) {
    if (!entry.live) return;
    entry.live = false; entries.delete(entry.key); pixels -= entry.pixels; bytes -= entry.bytes;
    entry.controller.abort(); entry.resource?.dispose(); entry.resource = null;
  }
  function acquire(args) {
    if (disposed) return Promise.reject(new ImageAssetLoadError('IMAGE_POOL_DISPOSED', 'Image renderer is disposed'));
    if (args.signal?.aborted) return Promise.reject(imageAbortError());
    let key, asset;
    try {
      asset = validateResolvedImageAsset(args.resolved);
      if (!args.context?.canRead || args.context.roomId !== asset.definition.roomId || !['active','archived'].includes(asset.status)) throw new ImageAssetLoadError('IMAGE_ACCESS_UNAVAILABLE', 'This image is unavailable in the current room');
      key = imageTextureKey({...args, resolved: asset});
    } catch (error) { return Promise.reject(error); }
    let entry = entries.get(key);
    if (!entry) {
      const amount = asset.version.widthPixels * asset.version.heightPixels, size = asset.version.byteLength;
      if (pixels + amount > maxResidentPixels || bytes + size > maxResidentBytes) return Promise.reject(new ImageAssetLoadError('IMAGE_TEXTURE_BUDGET', 'Image texture budget reached; unload unused room images and retry'));
      entry = {key, pixels: amount, bytes: size, refs: 0, live: true, resource: null, controller: new AbortController()};
      pixels += amount; bytes += size; entries.set(key, entry);
      entry.promise = Promise.resolve().then(() => loadTexture({...args, resolved: asset, signal: entry.controller.signal})).then(resource => {
        if (!entry.live || entry.controller.signal.aborted) { resource?.dispose?.(); throw imageAbortError(); }
        if (!resource || typeof resource.dispose !== 'function' || !resource.texture || typeof resource.isReady !== 'function' || !resource.isReady() || (typeof resource.hitTest !== 'function' && !resource.alphaMask)) { resource?.dispose?.(); throw new ImageAssetLoadError('INVALID_IMAGE_RESOURCE', 'Texture loader returned an incomplete resource'); }
        entry.resource = resource; return resource;
      }).catch(error => { destroy(entry); throw error; });
    }
    entry.refs++;
    return new Promise((resolve, reject) => {
      let released = false, delivered = false;
      const release = () => { if (released) return; released = true; args.signal?.removeEventListener('abort', abort); if (--entry.refs === 0) destroy(entry); };
      const abort = () => { release(); if (!delivered) reject(imageAbortError()); };
      args.signal?.addEventListener('abort', abort, {once: true});
      if (args.signal?.aborted) { abort(); return; }
      entry.promise.then(resource => {
        if (released) return;
        if (!entry.live) { release(); reject(imageAbortError()); return; }
        delivered = true;
        resolve({texture: resource.texture, alphaMask: resource.alphaMask, hitTest: resource.hitTest?.bind(resource), isReady: () => entry.live && resource.isReady(), dispose: release, cacheKey: key});
      }, error => { release(); reject(error); });
    });
  }
  return {acquire, getStats: () => Object.freeze({entries: entries.size, pixels, bytes, maxResidentPixels, maxResidentBytes, loading: [...entries.values()].filter(entry => !entry.resource).length, leases: [...entries.values()].reduce((sum, entry) => sum + entry.refs, 0)}), dispose() { if (disposed) return; disposed = true; for (const entry of [...entries.values()]) destroy(entry); }};
}
