import {createHash} from 'node:crypto';
import {normalizeImageAssetDraft, validateImageDefinition} from '../src/image-asset-schema.js';
import {makePng} from '../fixtures/png-fixtures.mjs';
const stamp = '2026-10-02T00:00:00.000Z';
export const renderContext = {roomId: 'r1', roomEpoch: 1, authorityEpoch: 1, canRead: true};
export function renderFixture({id = 'a1', versionId = 'v1', width = 64, height = 96, metadata = {}, pixel = (x, y) => [x < width / 2 ? 255 : 40, y < height / 2 ? 50 : 220, 90, x < width / 2 && y < height / 2 ? 0 : 255]} = {}) {
  const bytes = makePng({width, height, pixel});
  const definition = {schemaVersion: 1, assetId: id, roomId: 'r1', createdBy: 'u1', createdAt: stamp, originKind: 'upload'};
  const version = {...normalizeImageAssetDraft({name: 'Local test image', ...metadata}, {width, height, byteLength: bytes.length, mediaType: 'image/png'}), schemaVersion: 1, assetId: id, roomId: 'r1', versionId, sequence: 1, sha256: createHash('sha256').update(bytes).digest('hex'), createdBy: 'u1', createdAt: stamp};
  const resolved = {...validateImageDefinition(definition, version), status: 'active'};
  const instance = {id: 'i_' + id, type: 'image', assetRef: {assetId: id, versionId}, x: 0, z: 0, rotation: 0};
  return {bytes, resolved, instance};
}
export function fakePort() {
  const log = [];
  return {log, createNode(placement) { return {placement}; }, updatePlacement(node, placement) { node.placement = placement; log.push('placement'); }, setState(node, state) { node.state = state; log.push(state.status); }, setTexture(node, texture) { node.texture = texture; log.push('attach'); }, clearTexture(node) { node.texture = null; log.push('clear'); }, dispose(node) { node.disposed = true; log.push('dispose-node'); }};
}
export function fakeResource(alpha = [0, 255, 128, 127]) {
  let disposed = 0;
  return {texture: {}, alphaMask: {width: 2, height: 2, alpha}, isReady: () => !disposed, dispose() { disposed++; }, get disposed() { return disposed; }};
}
export function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; }
