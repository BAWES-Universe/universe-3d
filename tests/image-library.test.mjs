import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeImageAssetDraft, validateImageDefinition} from '../src/image-asset-schema.js';
import {searchImageLibrary} from '../src/image-library.js';
function entry(assetId, name, tags = [], status = 'active') {
  const stamp = '2026-10-02T00:00:00.000Z';
  const definition = {schemaVersion: 1, assetId, roomId: 'room', createdBy: 'editor', createdAt: stamp, originKind: 'upload'};
  const version = {...normalizeImageAssetDraft({name, tags}, {width: 35, height: 57, byteLength: 100, mediaType: 'image/png'}), schemaVersion: 1, assetId, roomId: 'room', versionId: `${assetId}-v1`, sequence: 1, sha256: 'a'.repeat(64), createdBy: 'editor', createdAt: stamp};
  return {...validateImageDefinition(definition, version), status};
}
const ids = entries => entries.map(entry => entry.definition.assetId);
test('Custom search preserves original stable order and distinct same-name IDs', () => {
  const source = [entry('z', 'Tree', ['Green']), entry('a', 'Tree', ['Red']), entry('m', 'Table', ['Wood'])];
  assert.deepEqual(ids(searchImageLibrary(source)), ['z', 'a', 'm']);
  assert.deepEqual(ids(searchImageLibrary(source, {query: ' TREE '})), ['z', 'a']);
  assert.deepEqual(ids(searchImageLibrary(source, {query: 'tree red'})), ['a']);
  assert.deepEqual(ids(searchImageLibrary(source, {query: 'wOoD'})), ['m']);
  assert.deepEqual(ids(searchImageLibrary(source, {query: 'red green'})), []);
});
test('empty queries show committed active Custom entries only; unknown categories have no results', () => {
  const source = [entry('a', 'Tree'), entry('b', 'Deleted', [], 'deleted')];
  assert.deepEqual(ids(searchImageLibrary(source, {query: '   ', category: 'custom'})), ['a']);
  assert.deepEqual(ids(searchImageLibrary(source, {category: 'all'})), ['a']);
  assert.deepEqual(searchImageLibrary(source, {category: 'furniture'}), []);
});
test('search tokens match case-insensitive names and each tag without inventing variants or tints', () => {
  const source = [entry('x', 'Café tree', ['Big canopy', 'Garden']), entry('y', 'Tree', ['Kitchen'])];
  assert.deepEqual(ids(searchImageLibrary(source, {query: 'CAFE\u0301 canopy'})), ['x']);
  assert.deepEqual(ids(searchImageLibrary(source, {query: 'tree garden'})), ['x']);
  assert.deepEqual(ids(searchImageLibrary(source, {query: 'no match'})), []);
});
test('results are cloned/frozen and preserve literal names rather than generating HTML', () => {
  const source = entry('x', '<img src=x onerror=alert(1)>', ['tag']);
  const result = searchImageLibrary([source]); source.status = 'deleted';
  assert.equal(result[0].status, 'active'); assert.equal(result[0].version.name, '<img src=x onerror=alert(1)>');
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result[0].version.tags));
  assert.throws(() => { result[0].version.tags.push('bad'); }, TypeError);
});
test('malformed or uncommitted records are rejected instead of being offered for placement', () => {
  assert.throws(() => searchImageLibrary([{name: 'pending preview'}]));
  assert.throws(() => searchImageLibrary([{...entry('x', 'Tree'), status: undefined}]));
  assert.throws(() => searchImageLibrary(null)); assert.throws(() => searchImageLibrary([], {query: 'x'.repeat(1025)}));
});
