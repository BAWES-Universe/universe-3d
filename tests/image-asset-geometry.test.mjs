import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeImageAssetDraft, validateImageDefinition, ImageAssetValidationError} from '../src/image-asset-schema.js';
import {resolveImagePlacement, imageFootprint, imageCollisionCells, imagePlacementInside, imagePlacementChangeInside, imageAlphaHitTest, IMAGE_ALPHA_CUTOFF} from '../src/image-asset-geometry.js';
const stamp = '2026-10-02T00:00:00.000Z';
function asset(raw = {}, width = 64, height = 96, versionId = 'v1') {
  const definition = {schemaVersion: 1, assetId: 'a1', roomId: 'r1', createdBy: 'u1', createdAt: stamp, originKind: 'upload'};
  const version = {...normalizeImageAssetDraft({name: 'Tree', floating: false, collisionGrid: [[0, 0], [1, 1], [1, 1]], ...raw}, {width, height, byteLength: 200, mediaType: 'image/png'}), schemaVersion: 1, assetId: 'a1', roomId: 'r1', versionId, sequence: versionId === 'v1' ? 1 : 2, sha256: 'f'.repeat(64), createdBy: 'u1', createdAt: stamp};
  return {...validateImageDefinition(definition, version), status: 'active'};
}
const instance = (rotation = 0, extra = {}) => ({id: 'i1', type: 'image', assetRef: {assetId: 'a1', versionId: 'v1'}, x: 10, z: 20, rotation, ...extra});
const pointPairs = points => points.map(({x, z}) => [x, z]);
const centers = cells => cells.map(({row, col, x, z, width, depth}) => [row, col, x, z, width, depth]);
const inCell = (cell, x, z, padding = 0) => Math.abs(x - cell.x) <= cell.width / 2 + padding && Math.abs(z - cell.z) <= cell.depth / 2 + padding;

for (const fixture of [
  {rotation: 0, corners: [[9, 18.5], [11, 18.5], [11, 21.5], [9, 21.5]], dimensions: [2, 3], centers: [[1, 0, 9.5, 20, 1, 1], [1, 1, 10.5, 20, 1, 1], [2, 0, 9.5, 21, 1, 1], [2, 1, 10.5, 21, 1, 1]]},
  {rotation: 90, corners: [[11.5, 19], [11.5, 21], [8.5, 21], [8.5, 19]], dimensions: [3, 2], centers: [[1, 0, 10, 19.5, 1, 1], [1, 1, 10, 20.5, 1, 1], [2, 0, 9, 19.5, 1, 1], [2, 1, 9, 20.5, 1, 1]]},
  {rotation: 180, corners: [[11, 21.5], [9, 21.5], [9, 18.5], [11, 18.5]], dimensions: [2, 3], centers: [[1, 0, 10.5, 20, 1, 1], [1, 1, 9.5, 20, 1, 1], [2, 0, 10.5, 19, 1, 1], [2, 1, 9.5, 19, 1, 1]]},
  {rotation: 270, corners: [[8.5, 21], [8.5, 19], [11.5, 19], [11.5, 21]], dimensions: [3, 2], centers: [[1, 0, 10, 20.5, 1, 1], [1, 1, 10, 19.5, 1, 1], [2, 0, 11, 20.5, 1, 1], [2, 1, 11, 19.5, 1, 1]]}
]) {
  test(`64x96 exact full-image and occupied-cell oracle at ${fixture.rotation} degrees`, () => {
    const resolved = resolveImagePlacement(asset(), instance(fixture.rotation));
    assert.deepEqual(pointPairs(resolved.editBounds.corners), fixture.corners);
    assert.deepEqual([resolved.editBounds.width, resolved.editBounds.depth], fixture.dimensions);
    assert.deepEqual(centers(resolved.collisionCells), fixture.centers);
    assert.deepEqual(imageFootprint(asset(), instance(fixture.rotation)), resolved.editBounds);
    assert.deepEqual(imageCollisionCells(asset(), instance(fixture.rotation)), resolved.collisionCells);
    assert.ok(Object.isFrozen(resolved.collisionCells[0].corners[0]));
    assert.equal(resolved.transform.rotationY, fixture.rotation ? -fixture.rotation * Math.PI / 180 : 0);
  });
}
test('empty top grid row is traversable at each exact rotation; actors/bots/placement share cells', () => {
  const samples = [{r: 0, empty: [9.5, 19], occupied: [9.5, 20]}, {r: 90, empty: [11, 19.5], occupied: [10, 19.5]}, {r: 180, empty: [10.5, 21], occupied: [10.5, 20]}, {r: 270, empty: [9, 20.5], occupied: [10, 20.5]}];
  for (const sample of samples) {
    const cells = imageCollisionCells(asset(), instance(sample.r));
    for (const padding of [0, 0.3, 0.34]) {
      assert.equal(cells.some(cell => inCell(cell, ...sample.empty, padding)), false);
      assert.equal(cells.some(cell => inCell(cell, ...sample.occupied, padding)), true);
    }
  }
});
test('upright standing panel has actual 3D bounds different from full edit scope', () => {
  const result = resolveImagePlacement(asset(), instance());
  assert.deepEqual(result.render.worldCorners, [{x: 9, y: 3, z: 21.5}, {x: 11, y: 3, z: 21.5}, {x: 11, y: 0, z: 21.5}, {x: 9, y: 0, z: 21.5}]);
  assert.deepEqual([result.renderBounds.width, result.renderBounds.height, result.renderBounds.depth], [2, 3, 0]);
  assert.equal(result.editBounds.depth, 3); assert.equal(result.render.billboard, false);
  assert.equal(result.render.depthTest, true); assert.equal(result.render.depthWrite, true);
  assert.equal(result.render.alphaMode, 'test'); assert.equal(result.render.alphaCutoff, IMAGE_ALPHA_CUTOFF);
  assert.equal(result.render.supportsStanding, false); assert.equal(result.render.doubleSided, true);
  assert.deepEqual(result.pickDescriptor.normal, {x: 0, y: 0, z: 1});
  assert.deepEqual(result.pickDescriptor.corners, result.render.worldCorners);
});
test('upright 90 degree panel exactly follows native negative Babylon yaw', () => {
  const result = resolveImagePlacement(asset(), instance(90));
  assert.deepEqual(result.render.worldCorners, [{x: 8.5, y: 3, z: 19}, {x: 8.5, y: 3, z: 21}, {x: 8.5, y: 0, z: 21}, {x: 8.5, y: 0, z: 19}]);
  assert.deepEqual(result.pickDescriptor.normal, {x: -1, y: 0, z: 0});
  assert.deepEqual([result.renderBounds.width, result.renderBounds.height, result.renderBounds.depth], [0, 3, 2]);
});
test('custom pivot moves only the render/pick panel, never cells or scope', () => {
  const standing = resolveImagePlacement(asset(), instance());
  const custom = resolveImagePlacement(asset({depthPreset: 'custom', depthPivot: 1 / 3}), instance());
  assert.equal(custom.renderBounds.z, 19.5); assert.deepEqual(custom.collisionCells, standing.collisionCells); assert.deepEqual(custom.editBounds, standing.editBounds);
  assert.deepEqual(custom.render.localCorners.map(point => point.z), [-0.5, -0.5, -0.5, -0.5]);
});
test('floor decal preserves top-left source rows, fixed floor offset and native depth', () => {
  const floor = resolveImagePlacement(asset({depthPreset: 'floor'}), instance(90));
  assert.deepEqual(floor.render.worldCorners, [{x: 11.5, y: 0.05, z: 19}, {x: 11.5, y: 0.05, z: 21}, {x: 8.5, y: 0.05, z: 21}, {x: 8.5, y: 0.05, z: 19}]);
  assert.deepEqual(floor.render.uv, [{u: 0, v: 0}, {u: 1, v: 0}, {u: 1, v: 1}, {u: 0, v: 1}]);
  assert.equal(floor.renderBounds.height, 0); assert.deepEqual(floor.pickDescriptor.normal, {x: 0, y: 1, z: 0});
});
test('arbitrary pixel size and continuous floating positions are not silently snapped', () => {
  const result = resolveImagePlacement(asset({floating: true, collisionGrid: null}, 47, 93), instance(0, {x: 0.125, z: -0.25}));
  assert.deepEqual([result.editBounds.x, result.editBounds.z, result.editBounds.width, result.editBounds.depth], [0.125, -0.25, 47 / 32, 93 / 32]);
  assert.deepEqual(result.collisionCells, []);
});
test('broad transparent border and one occupied cell cannot shrink permission bounds', () => {
  const grid = Array.from({length: 8}, () => Array(8).fill(0)); grid[4][4] = 1;
  const broad = asset({collisionGrid: grid}, 256, 256), placed = instance(0, {x: 0, z: 0});
  const result = resolveImagePlacement(broad, placed);
  assert.deepEqual([result.editBounds.width, result.editBounds.depth], [8, 8]); assert.equal(result.collisionCells.length, 1);
  assert.equal(imagePlacementInside({x: 0.5, z: 0.5, width: 1, depth: 1}, broad, placed), false);
  assert.equal(imagePlacementInside({x: 0, z: 0, width: 8, depth: 8}, broad, placed), true);
  assert.equal(imagePlacementInside({x: 0, z: 0, width: 7.999999999, depth: 8}, broad, placed), false);
});
test('entirely transparent artwork retains nonzero edit scope and keyboard/list picking route', () => {
  const transparent = asset({floating: true, collisionGrid: null}, 128, 64), placed = instance(0, {x: 0, z: 0});
  const result = resolveImagePlacement(transparent, placed);
  assert.deepEqual([result.editBounds.width, result.editBounds.depth], [4, 2]); assert.deepEqual(result.collisionCells, []);
  assert.deepEqual(result.pickDescriptor.fallbackSelection, ['list', 'keyboard']);
  assert.equal(imageAlphaHitTest({width: 2, height: 2, alpha: [0, 0, 0, 0]}, {u: 0.5, v: 0.5}), false);
  assert.equal(imagePlacementInside({x: 0, z: 0, width: 1, depth: 1}, transparent, placed), false);
});
test('alpha threshold and top-left UV picking reject transparent pixels without affecting collision', () => {
  const mask = {width: 2, height: 2, alpha: [0, 127, 128, 255]};
  assert.equal(imageAlphaHitTest(mask, {u: 0.25, v: 0.25}), false);
  assert.equal(imageAlphaHitTest(mask, {u: 0.75, v: 0.25}), false);
  assert.equal(imageAlphaHitTest(mask, {u: 0.25, v: 0.75}), true);
  assert.equal(imageAlphaHitTest(mask, {u: 1, v: 1}), true);
  assert.equal(imageAlphaHitTest(mask, {u: -0.01, v: 0}), false);
  assert.equal(imageAlphaHitTest(null, {u: 0.5, v: 0.5}), null);
  assert.equal(imageCollisionCells(asset(), instance()).length, 4);
});
test('malformed and overlarge alpha masks are rejected independently of permission geometry', () => {
  for (const mask of [{width: 257, height: 1, alpha: []}, {width: 2, height: 2, alpha: [255]}, {width: 1, height: 1, alpha: [256]}, {width: 1, height: 1, alpha: [NaN]}, {width: 0, height: 1, alpha: []}]) assert.throws(() => imageAlphaHitTest(mask, {u: 0.5, v: 0.5}), ImageAssetValidationError);
});
test('personal-area edits check BOTH old and new authoritative version extents', () => {
  const oldAsset = asset({floating: true, collisionGrid: null}, 64, 64), bigger = asset({floating: true, collisionGrid: null}, 256, 256, 'v2');
  const resolve = ref => ({v1: oldAsset, v2: bigger})[ref.versionId], area = {x: 0, z: 0, width: 4, depth: 4};
  const inside = instance(0, {x: 0, z: 0}), outside = instance(0, {x: 4, z: 0}), enlarged = {...inside, assetRef: {assetId: 'a1', versionId: 'v2'}};
  assert.equal(imagePlacementChangeInside(area, {before: inside, after: {...inside, x: 1}, resolve}), true);
  assert.equal(imagePlacementChangeInside(area, {before: outside, after: inside, resolve}), false);
  assert.equal(imagePlacementChangeInside(area, {before: inside, after: outside, resolve}), false);
  assert.equal(imagePlacementChangeInside(area, {before: inside, after: enlarged, resolve}), false);
  assert.equal(imagePlacementChangeInside(area, {before: inside, resolve}), true);
  assert.equal(imagePlacementChangeInside(area, {after: inside, resolve}), true);
  assert.equal(imagePlacementChangeInside(area, {resolve}), false);
  assert.equal(imagePlacementChangeInside(area, {after: inside, resolve: () => null}), false);
  assert.throws(() => imagePlacementChangeInside(area, {after: inside, resolve: async () => oldAsset}), ImageAssetValidationError);
});
test('missing/deleted/wrong identity never falls back to furniture or empty collision', () => {
  for (const value of [null, {...asset(), status: 'deleted'}, {...asset(), version: {...asset().version, versionId: 'other'}}, {...asset(), definition: {...asset().definition, roomId: 'foreign'}}]) assert.throws(() => resolveImagePlacement(value, instance()), ImageAssetValidationError);
});
test('forged instance geometry and every noncardinal angle are rejected at all geometry entry points', () => {
  for (const altered of [{...instance(), width: 0.01}, {...instance(), scale: 0}, {...instance(), solid: false}, {...instance(), rotation: 45}, {...instance(), rotation: 89.999}]) {
    for (const fn of [resolveImagePlacement, imageFootprint, imageCollisionCells]) assert.throws(() => fn(asset(), altered), ImageAssetValidationError);
  }
});
test('sparse alpha samples reject rather than silently masquerading as transparency', () => {
  assert.throws(() => imageAlphaHitTest({width: 2, height: 1, alpha: new Array(2)}, {u: 0, v: 0}), ImageAssetValidationError);
});
