import test from 'node:test';
import assert from 'node:assert/strict';
import {IMAGE_ASSET_LIMITS, ImageAssetValidationError, normalizeImageAssetDraft, validateAssetReference, validateImageDefinition, validateResolvedImageAsset, validateImageInstance, canUseImageReference, normalizeImageRotation} from '../src/image-asset-schema.js';
const info = (width = 64, height = 96) => ({width, height, byteLength: 250, mediaType: 'image/png'});
const definition = () => ({schemaVersion: 1, assetId: 'asset-1', roomId: 'room-A', createdBy: 'editor-1', createdAt: '2026-10-02T00:00:00.000Z', originKind: 'upload'});
const version = (raw = {}, decoded = info()) => ({...normalizeImageAssetDraft({name: 'Tree', ...raw}, decoded), schemaVersion: 1, assetId: 'asset-1', roomId: 'room-A', versionId: 'version-1', sequence: 1, sha256: 'a'.repeat(64), createdBy: 'editor-1', createdAt: '2026-10-02T00:00:00.000Z'});
const envelope = () => ({...validateImageDefinition(definition(), version()), status: 'active'});
const instance = () => ({id: 'placed-1', type: 'image', assetRef: {assetId: 'asset-1', versionId: 'version-1'}, x: 0, z: 0, rotation: 90});
const invalid = (fn, field) => assert.throws(fn, error => error instanceof ImageAssetValidationError && (!field || error.field === field));

test('arbitrary-size noncolliding image preserves decoded pixels and explicit image representation', () => {
  const result = normalizeImageAssetDraft({name: '  Banner  '}, info(47, 93));
  assert.deepEqual(result, {name: 'Banner', tags: [], representation: 'upright', depthPreset: 'standing', depthPivot: 1, floating: true, collisionGrid: null, widthPixels: 47, heightPixels: 93, byteLength: 250, mediaType: 'image/png'});
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.tags));
});
test('normalizes Unicode and trimmed case-insensitive duplicate tags without truncation', () => {
  const result = normalizeImageAssetDraft({name: 'Cafe\u0301', tags: ' Green , TREE, green, , Big tree, cafe\u0301, Café'}, info());
  assert.equal(result.name, 'Café'); assert.deepEqual(result.tags, ['Green', 'TREE', 'Big tree', 'café']);
  invalid(() => normalizeImageAssetDraft({name: 'x', tags: Array.from({length: 21}, (_, i) => `t${i}`)}, info()), 'draft.tags');
  invalid(() => normalizeImageAssetDraft({name: 'x', tags: ['x'.repeat(41)]}, info()), 'draft.tags.0');
  invalid(() => normalizeImageAssetDraft({name: 'x'.repeat(121)}, info()), 'draft.name');
});
test('accepts exact 64x96 binary collision grid with floating false and detaches source arrays', () => {
  const grid = [[0, 0], [1, 1], [1, 1]], result = normalizeImageAssetDraft({name: 'Table', floating: false, collisionGrid: grid}, info());
  assert.deepEqual(result.collisionGrid, grid); grid[0][0] = 1;
  assert.equal(result.collisionGrid[0][0], 0); assert.ok(Object.isFrozen(result.collisionGrid[0]));
  assert.throws(() => { result.collisionGrid[0][0] = 1; }, TypeError);
});
test('rejects floating grids, non-multiple dimensions, ragged/sparse/nonbinary/overlarge grids', () => {
  invalid(() => normalizeImageAssetDraft({name: 'x', collisionGrid: [[0, 0], [0, 0], [0, 0]]}, info()), 'draft.collisionGrid');
  for (const grid of [[], [[0, 0]], [[0, 0], [1], [1, 1]], [[0, 0], [1, true], [1, 1]], [[0, 0], [1, '1'], [1, 1]], [[0, 0], [1, 2], [1, 1]], [[0, 0], [1, ,], [1, 1]], Array.from({length: 65}, () => [1, 1])]) invalid(() => normalizeImageAssetDraft({name: 'x', floating: false, collisionGrid: grid}, info()));
  invalid(() => normalizeImageAssetDraft({name: 'x', floating: false, collisionGrid: [[1]]}, info(33, 32)), 'draft.collisionGrid');
});
test('no grid and all-zero grids remain traversable without removing image dimensions', () => {
  const arbitrary = normalizeImageAssetDraft({name: 'x', floating: false}, info(33, 57));
  assert.equal(arbitrary.collisionGrid, null); assert.equal(arbitrary.widthPixels, 33);
  const empty = normalizeImageAssetDraft({name: 'x', floating: false, collisionGrid: [[0, 0], [0, 0], [0, 0]]}, info());
  assert.deepEqual(empty.collisionGrid, [[0, 0], [0, 0], [0, 0]]);
});
test('preset/pivot representations are consistent and unsupported geometry fails explicitly', () => {
  const floor = normalizeImageAssetDraft({name: 'x', depthPreset: 'floor'}, info());
  assert.equal(floor.representation, 'floor'); assert.equal(floor.depthPivot, 0.5);
  assert.equal(normalizeImageAssetDraft({name: 'x', depthPreset: 'custom', depthPivot: 1 / 3}, info()).depthPivot, 1 / 3);
  for (const raw of [{depthPreset: 'custom'}, {depthPreset: 'custom', depthPivot: -0.1}, {depthPreset: 'custom', depthPivot: 1.01}, {depthPreset: 'custom', depthPivot: NaN}, {depthPreset: 'floor', representation: 'upright'}, {depthPreset: 'standing', depthPivot: 0}, {representation: 'mesh'}, {depthPreset: 'billboard'}]) invalid(() => normalizeImageAssetDraft({name: 'x', ...raw}, info()));
});
test('bounds decoded metadata and rejects mismatched format, dimensions and client geometry', () => {
  for (const decoded of [{...info(), width: 0}, {...info(), width: 2049}, {...info(), height: Infinity}, {...info(), width: '64'}, {...info(), width: 1.5}, {...info(), byteLength: IMAGE_ASSET_LIMITS.maxBytes + 1}, {...info(), mediaType: 'image/svg+xml'}]) invalid(() => normalizeImageAssetDraft({name: 'x'}, decoded));
  for (const key of ['widthPixels', 'heightPixels', 'width', 'depth', 'scale', 'url', 'sha256', 'createdBy', 'roomId', 'canManage', 'solid', 'alpha']) invalid(() => normalizeImageAssetDraft({name: 'x', [key]: 1}, info()), `draft.${key}`);
});
test('strict references reject client privilege, URL and geometry fields', () => {
  assert.deepEqual(validateAssetReference({assetId: 'asset-1', versionId: 'v-1'}), {assetId: 'asset-1', versionId: 'v-1'});
  for (const key of ['roomId', 'width', 'url', 'solid', 'createdBy', 'sha256', 'canPlace', 'collisionGrid']) invalid(() => validateAssetReference({assetId: 'a', versionId: 'v', [key]: true}));
  for (const id of ['', 'has space', '../secret', 'a:b', 'x'.repeat(129)]) invalid(() => validateAssetReference({assetId: id, versionId: 'v'}));
});
test('definition and immutable version are detached, frozen and distinct from instances', () => {
  const def = {...definition(), provenance: {source: 'https://example.invalid/art', license: 'User supplied text'}}, ver = version({tags: ['tree']});
  const out = validateImageDefinition(def, ver); def.provenance.license = 'changed'; ver.tags = ['changed'];
  assert.equal(out.definition.provenance.license, 'User supplied text'); assert.deepEqual(out.version.tags, ['tree']);
  assert.ok(Object.isFrozen(out.definition.provenance)); assert.ok(Object.isFrozen(out.version));
  assert.equal('floating' in out.definition, false); assert.equal(out.version.floating, true);
  invalid(() => validateImageDefinition({...definition(), floating: true}, version()));
});
test('version records require complete shape, consistent identity, ISO timestamps and digest', () => {
  for (const patch of [{assetId: 'other'}, {roomId: 'other'}, {schemaVersion: 2}, {sequence: 0}, {sequence: 1.5}, {sha256: 'A'.repeat(64)}, {sha256: 'a'.repeat(63)}, {createdAt: '2026-02-30T00:00:00.000Z'}, {createdAt: '2026-10-02'}, {mediaType: 'text/html'}, {url: 'https://example.invalid'}]) invalid(() => validateImageDefinition(definition(), {...version(), ...patch}));
  const incomplete = version(); delete incomplete.collisionGrid; invalid(() => validateImageDefinition(definition(), incomplete), 'version.collisionGrid');
  invalid(() => validateImageDefinition({...definition(), originKind: 'collection'}, version()), 'definition.originKind');
});
test('explicit status and exact pinned identity are required; this check grants no role', () => {
  const ref = {assetId: 'asset-1', versionId: 'version-1'}, active = envelope();
  assert.equal(canUseImageReference(ref, active), true);
  assert.equal(canUseImageReference(ref, {...active, status: 'deleted'}), false);
  assert.equal(canUseImageReference(ref, {...active, status: undefined}), false);
  assert.equal(canUseImageReference({...ref, versionId: 'latest'}, active), false);
  assert.equal(canUseImageReference(ref, {...active, version: {...active.version, roomId: 'elsewhere'}}), false);
  assert.ok(Object.isFrozen(validateResolvedImageAsset(active)));
});
test('immutable pinned version does not drift when a separate current version advances', () => {
  const old = envelope(), current = {...old, version: {...old.version, name: 'New name', versionId: 'version-2', sequence: 2}};
  assert.equal(canUseImageReference({assetId: 'asset-1', versionId: 'version-1'}, old), true);
  assert.equal(canUseImageReference({assetId: 'asset-1', versionId: 'version-1'}, current), false);
  assert.equal(old.version.name, 'Tree');
});
test('quarter turns normalize exactly; non-cardinal and non-finite rotations reject', () => {
  for (const [raw, expected] of [[0, 0], [-0, 0], [90, 90], [180, 180], [270, 270], [360, 0], [-90, 270], [450, 90]]) assert.equal(normalizeImageRotation(raw), expected);
  for (const value of [45, 0.01, 89.999999, 359.999999, NaN, Infinity, '90', null, Number.MAX_SAFE_INTEGER + 1]) invalid(() => normalizeImageRotation(value), 'instance.rotation');
});
test('instance references can be reused without coupling names, actions, or identity', () => {
  const source = {...instance(), name: 'First tree', actions: [{kind: 'text', text: 'Hello'}]}, a = validateImageInstance(source), b = validateImageInstance({...source, id: 'placed-2', name: 'Second tree'});
  source.actions[0].text = 'mutated'; assert.equal(a.actions[0].text, 'Hello'); assert.equal(b.actions[0].text, 'Hello');
  assert.equal(a.name, 'First tree'); assert.equal(b.name, 'Second tree'); assert.notEqual(a.id, b.id); assert.deepEqual(a.assetRef, b.assetRef);
  assert.ok(Object.isFrozen(a.actions[0]));
});
test('instance authority/geometry/scale claims and invalid coordinates are never trusted', () => {
  for (const key of ['width', 'height', 'depth', 'widthPixels', 'scale', 'solid', 'collisionGrid', 'url', 'createdBy', 'ownerId', 'y', 'rotationY', 'definition', 'version', 'canPlace', 'roomId']) invalid(() => validateImageInstance({...instance(), [key]: 0}), `instance.${key}`);
  for (const x of [NaN, Infinity, '0', 1000001]) invalid(() => validateImageInstance({...instance(), x}));
  invalid(() => validateImageInstance({...instance(), type: 'table'}));
  invalid(() => validateImageInstance({...instance(), actions: [JSON.parse('{"__proto__":{"polluted":true}}')]}));
});
test('explicit null authoring values do not silently become defaults', () => {
  for (const raw of [{floating: null}, {depthPreset: null}, {tags: null}]) invalid(() => normalizeImageAssetDraft({name: 'x', ...raw}, info()));
});
test('actions remain bounded across all fields and sparse arrays are not accepted as JSON', () => {
  invalid(() => validateImageInstance({...instance(), actions: Array.from({length: 5}, () => ({text: 'x'.repeat(16384)}))}));
  invalid(() => validateImageInstance({...instance(), actions: new Array(2)}));
});
