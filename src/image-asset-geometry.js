import {IMAGE_PIXELS_PER_METRE, ImageAssetValidationError, canUseImageReference, freezeImageRecord, validateImageInstance, validateResolvedImageAsset} from './image-asset-schema.js';

// Flat decals sit above walkable surface sheets (0–0.04m), below raised props/rugs.
// This is a shared geometry policy, not a renderer depth-test override.
export const IMAGE_FLOOR_OFFSET = 0.05;
export const IMAGE_ALPHA_CUTOFF = 128 / 255;
const TRIG = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const zero = value => Object.is(value, -0) ? 0 : value;
function transformPoint(u, v, instance, y) {
  const [c, s] = TRIG[instance.rotation / 90];
  const result = {x: zero(instance.x + u * c - v * s), z: zero(instance.z + u * s + v * c)};
  if (y !== undefined) return {x: result.x, y, z: result.z};
  return result;
}
function groundBounds(corners) {
  const xs = corners.map(point => point.x), zs = corners.map(point => point.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  return {x: zero((minX + maxX) / 2), z: zero((minZ + maxZ) / 2), width: maxX - minX, depth: maxZ - minZ, minX, maxX, minZ, maxZ, corners};
}
function localRectangle(minU, minV, maxU, maxV, instance) {
  return [[minU, minV], [maxU, minV], [maxU, maxV], [minU, maxV]].map(([u, v]) => transformPoint(u, v, instance));
}
function worldBounds(corners) {
  const ground = groundBounds(corners), ys = corners.map(point => point.y);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return {...ground, y: (minY + maxY) / 2, height: maxY - minY, minY, maxY};
}

/** Authoritative geometry only after room-scoped server resolution. Never pass scene-supplied definitions here. */
export function resolveImagePlacement(resolved, rawInstance) {
  const asset = validateResolvedImageAsset(resolved), instance = validateImageInstance(rawInstance);
  if (!canUseImageReference(instance.assetRef, asset)) throw new ImageAssetValidationError('instance.assetRef', 'The exact active asset version is required', 'UNAVAILABLE_IMAGE_REFERENCE');
  const version = asset.version, width = version.widthPixels / IMAGE_PIXELS_PER_METRE, depth = version.heightPixels / IMAGE_PIXELS_PER_METRE;
  const editBounds = groundBounds(localRectangle(-width / 2, -depth / 2, width / 2, depth / 2, instance));
  const collisionCells = [];
  for (let row = 0; row < (version.collisionGrid?.length ?? 0); row++) {
    for (let col = 0; col < version.collisionGrid[row].length; col++) {
      if (version.collisionGrid[row][col] !== 1) continue;
      const minU = col - width / 2, minV = row - depth / 2;
      collisionCells.push({row, col, ...groundBounds(localRectangle(minU, minV, minU + 1, minV + 1, instance))});
    }
  }
  const upright = version.representation === 'upright', pivotZ = (version.depthPivot - 0.5) * depth;
  // Vertex order always follows source top-left, top-right, bottom-right, bottom-left.
  const localCorners = upright
    ? [{x: -width / 2, y: depth, z: pivotZ}, {x: width / 2, y: depth, z: pivotZ}, {x: width / 2, y: 0, z: pivotZ}, {x: -width / 2, y: 0, z: pivotZ}]
    : [{x: -width / 2, y: IMAGE_FLOOR_OFFSET, z: -depth / 2}, {x: width / 2, y: IMAGE_FLOOR_OFFSET, z: -depth / 2}, {x: width / 2, y: IMAGE_FLOOR_OFFSET, z: depth / 2}, {x: -width / 2, y: IMAGE_FLOOR_OFFSET, z: depth / 2}];
  const worldCorners = localCorners.map(point => transformPoint(point.x, point.z, instance, point.y));
  const normal = upright ? transformPoint(0, 1, {...instance, x: 0, z: 0}, 0) : {x: 0, y: 1, z: 0};
  const render = {kind: 'image-plane', representation: version.representation, width, height: depth, localCorners, worldCorners, uv: [{u: 0, v: 0}, {u: 1, v: 0}, {u: 1, v: 1}, {u: 0, v: 1}], doubleSided: true, alphaMode: 'test', alphaCutoff: IMAGE_ALPHA_CUTOFF, depthTest: true, depthWrite: true, billboard: false, supportsStanding: false};
  const pickDescriptor = {kind: 'image-plane', corners: worldCorners, normal, doubleSided: true, uvOrigin: 'top-left', pixelWidth: version.widthPixels, pixelHeight: version.heightPixels, alphaCutoff: IMAGE_ALPHA_CUTOFF, alphaMaskRequired: true, fallbackSelection: ['list', 'keyboard']};
  return freezeImageRecord({schemaVersion: 1, assetRef: instance.assetRef, instanceId: instance.id, transform: {x: instance.x, y: 0, z: instance.z, rotation: instance.rotation, rotationY: zero(-instance.rotation * Math.PI / 180)}, render, renderBounds: worldBounds(worldCorners), editBounds, collisionCells, pickDescriptor, migrationWarnings: []});
}
export function imageFootprint(resolved, instance) { return resolveImagePlacement(resolved, instance).editBounds; }
export function imageCollisionCells(resolved, instance) { return resolveImagePlacement(resolved, instance).collisionCells; }
function validArea(area) {
  return !!area && ['x', 'z', 'width', 'depth'].every(key => typeof area[key] === 'number' && Number.isFinite(area[key])) && area.width > 0 && area.depth > 0;
}
/** Pure containment, not role/ownership authorization. Touching the exact boundary is allowed; no shrink tolerance. */
export function imagePlacementInside(area, resolved, instance) {
  if (!validArea(area)) return false;
  const box = imageFootprint(resolved, instance);
  return box.corners.every(point => point.x >= area.x - area.width / 2 && point.x <= area.x + area.width / 2 && point.z >= area.z - area.depth / 2 && point.z <= area.z + area.depth / 2);
}
/** Tests both sides independently. The trusted resolver must resolve the exact pinned reference, not the current version. */
export function imagePlacementChangeInside(area, {before = null, after = null, resolve} = {}) {
  if (!validArea(area) || typeof resolve !== 'function' || (!before && !after)) return false;
  for (const instance of [before, after]) {
    if (!instance) continue;
    const normalized = validateImageInstance(instance), resolved = resolve(normalized.assetRef);
    if (resolved && typeof resolved.then === 'function') throw new ImageAssetValidationError('resolve', 'Containment requires a synchronous authoritative resolver');
    if (!resolved || !imagePlacementInside(area, resolved, normalized)) return false;
  }
  return true;
}
/** Broad bounds must not swallow transparent pixels. null means opacity is unknown; it is not a hit. */
export function imageAlphaHitTest(mask, {u, v} = {}) {
  if (typeof u !== 'number' || typeof v !== 'number' || !Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) return false;
  if (mask === null || mask === undefined) return null;
  const {width, height, alpha} = mask;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 256 || height > 256 || !Array.isArray(alpha) || alpha.length !== width * height || Array.from(alpha).some(value => !Number.isInteger(value) || value < 0 || value > 255)) throw new ImageAssetValidationError('alphaMask', 'Alpha masks must contain a bounded exact rectangle of 0–255 samples');
  const column = Math.min(width - 1, Math.floor(u * width)), row = Math.min(height - 1, Math.floor(v * height));
  return alpha[row * width + column] >= 128;
}
