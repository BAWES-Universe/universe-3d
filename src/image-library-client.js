// Accessible image-library boundary C. See ui/README.md for the frozen injection and async contract.
import { IMAGE_ASSET_LIMITS, validateAssetReference, validateResolvedImageAsset } from "./image-asset-schema.js";
function createImageLibraryClient({ transport }) {
  for (const method of ["list", "create", "readImage", "reconcileCreate"]) {
    if (typeof transport?.[method] !== "function") throw new TypeError(`transport.${method} is required`);
  }
  const entry = (value, roomId, status = "active") => {
    const result = validateResolvedImageAsset(value);
    if (result.definition.roomId !== roomId || (status ? result.status !== status : !["active", "archived"].includes(result.status))) throw new Error("Image is unavailable in this room");
    return result;
  };
  const versionReceipt = (value, args) => {
    if (value?.status !== 'committed') throw new Error('Version save status is still unknown');
    const current = entry(value.entry, args.roomId, null);
    const published = validateAssetReference({assetId: value.published?.assetId, versionId: value.published?.versionId});
    if (current.definition.assetId !== args.assetId || published.assetId !== args.assetId || !Number.isSafeInteger(value.published.sequence) || value.published.sequence < 2 || value.published.sequence > current.version.sequence || value.published.sequence === current.version.sequence && published.versionId !== current.version.versionId) throw new Error('Invalid version save receipt');
    return {status: 'committed', entry: current, published: {...published, sequence: value.published.sequence}};
  };
  return Object.freeze({
    async list(args) {
      const result = await transport.list(args);
      if (!Array.isArray(result?.entries)) throw new Error("Invalid library response");
      return { entries: result.entries.map((value) => entry(value, args.roomId, args.status || "active")) };
    },
    async update(args) {
      if (typeof transport.update !== 'function') throw new Error('Image management is unavailable');
      return entry(await transport.update(args), args.roomId, null);
    },
    async create(args) {
      return entry(await transport.create(args), args.roomId, null);
    },
    async createVersion(args) {
      if (typeof transport.createVersion !== 'function') throw new Error('Image setup editing is unavailable');
      return versionReceipt(await transport.createVersion(args), args);
    },
    async reconcileVersion(args) {
      if (typeof transport.reconcileVersion !== 'function') throw new Error('Image setup editing is unavailable');
      const result = await transport.reconcileVersion(args);
      return result?.status === 'not-found' ? {status: 'not-found'} : versionReceipt(result, args);
    },
    async reconcileCreate(args) {
      const result = await transport.reconcileCreate(args);
      if (result?.status === "committed") return { status: "committed", entry: entry(result.entry, args.roomId, null) };
      if (result?.status === "not-found") return { status: "not-found" };
      throw new Error("Upload status is still unknown");
    },
    async readImage(args) {
      const value = await transport.readImage(args);
      if (!(value instanceof Blob) && !(value?.bytes instanceof Uint8Array)) throw new Error("Image preview bytes are unavailable");
      const blob = value instanceof Blob ? value : new Blob([value.bytes], { type: value.mediaType });
      if (blob.type !== "image/png" || !blob.size || blob.size > IMAGE_ASSET_LIMITS.maxBytes) throw new Error("Image preview is unavailable");
      return blob;
    }
  });
}
async function decodeLocalPng(file, { signal } = {}) {
  if (!(file instanceof Blob) || file.type !== "image/png") throw new Error("Choose a PNG image");
  if (!file.size || file.size > IMAGE_ASSET_LIMITS.maxBytes) throw new Error("PNG images must be 5 MiB or smaller");
  const header = new Uint8Array(await file.slice(0, 24).arrayBuffer());
  if (signal?.aborted) throw new DOMException("Preview stopped", "AbortError");
  if (header.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => header[i] === n) || String.fromCharCode(...header.slice(12, 16)) !== "IHDR") throw new Error("This file is not a readable PNG image");
  const view = new DataView(header.buffer), w = view.getUint32(16), h = view.getUint32(20);
  if (!w || !h || w > IMAGE_ASSET_LIMITS.maxDimension || h > IMAGE_ASSET_LIMITS.maxDimension || w * h > IMAGE_ASSET_LIMITS.maxPixels) throw new Error("PNG dimensions must be 1\u20132048 pixels per side");
  const previewUrl = URL.createObjectURL(file), img = new Image();
  let disposed = false;
  const dispose = () => {
    if (!disposed) {
      disposed = true;
      URL.revokeObjectURL(previewUrl);
    }
  };
  try {
    await new Promise((resolve, reject) => {
      const abort = () => {
        cleanup();
        img.src = "";
        reject(new DOMException("Preview stopped", "AbortError"));
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", abort);
        img.onload = img.onerror = null;
      };
      img.onload = () => {
        cleanup();
        resolve();
      };
      img.onerror = () => {
        cleanup();
        reject(new Error("This PNG could not be decoded. Choose a different file"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      img.src = previewUrl;
    });
    if (img.naturalWidth !== w || img.naturalHeight !== h) throw new Error("PNG dimensions do not match its decoded image");
    return { width: w, height: h, previewUrl, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
export {
  createImageLibraryClient,
  decodeLocalPng
};
