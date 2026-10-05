import test from 'node:test';
import assert from 'node:assert/strict';
import {VertexData} from '@babylonjs/core/Meshes/mesh.vertexData.js';
import {Matrix, Quaternion, Vector3} from '@babylonjs/core/Maths/math.vector.js';
import {
  Workshop, createDocument, createFurniture, validate, parse, serialize, validateInstance,
  bounds, componentBounds, collisionMetadata, triangleCount, quaternion, multiply, rotateVector, LIMITS,
} from '../modules/asset-workshop/model.js';
import {geometry, SHAPES, TRIANGLES} from '../modules/asset-workshop/geometry.js';

const copy = value => JSON.parse(JSON.stringify(value));
const close = (a, b, epsilon = 1e-9) => {
  if (Array.isArray(a)) { assert.equal(a.length, b.length); a.forEach((value, i) => close(value, b[i], epsilon)); }
  else assert.ok(Math.abs(a - b) <= epsilon, `${a} ≈ ${b}`);
};
function one(shape = 'box') { const editor = new Workshop(); editor.add(shape); return editor; }
function two() { const editor = one(); editor.add('box', [2, .75, 1]); editor.select(editor.doc.components.map(part => part.id)); return editor; }
function state(editor) { return copy({doc: editor.doc, selection: [...editor.selection], history: editor.history, future: editor.future, gesture: editor.gesture}); }
function rejectsUnchanged(editor, operation, pattern) { const before = state(editor); assert.throws(operation, pattern); assert.deepEqual(state(editor), before); }
function filled(count, shape = 'box') {
  const doc = one(shape).doc, part = doc.components[0];
  doc.components = Array.from({length: count}, (_, i) => ({...copy(part), id: `part-${i + 1}`}));
  return doc;
}

// Format and trust-boundary coverage.
test('workshop default document and all starter parts are strictly valid and detached', () => {
  const doc = createDocument(); assert.equal(doc.asset.name, 'My furniture'); assert.equal(doc.components.length, 0);
  assert.deepEqual(validate(doc), doc); assert.equal(doc.asset.id, 'local-asset'); assert.equal(doc.asset.revision, 1);
  for (const kind of ['chair', 'table']) {
    const a = createFurniture(kind), b = createFurniture(kind);
    assert.deepEqual(a, b); assert.equal(a.groups.length, 1); assert.equal(bounds(a).min[1], 0);
    assert.equal(a.components.length, kind === 'chair' ? 8 : 5);
    const editor = new Workshop(a); editor.select(a.components[0].id); assert.equal(editor.selection.size, a.components.length);
    const before = copy(editor.doc.components); editor.ungroup();
    assert.equal(editor.doc.groups.length, 0);
    assert.deepEqual(editor.doc.components.map(part => ({...part, groupId: 'original'})), before.map(part => ({...part, groupId: 'original'})));
    b.components[0].size[0] = 9; assert.notEqual(a.components[0].size[0], 9);
  }
  assert.throws(() => createFurniture('unknown'));
});

test('round-trip preserves every primitive, flat groups, materials and inert texture references', () => {
  const editor = new Workshop();
  for (const shape of SHAPES) editor.add(shape);
  editor.select(editor.doc.components.map(part => part.id)); editor.group('All shapes');
  editor.doc.materials[0].textureRef = {assetId: 'opaque-asset', versionId: 'version_1', slot: 'baseColor'};
  const serialized = serialize(editor.doc); assert.deepEqual(parse(serialized), editor.doc);
  const detached = validate(editor.doc); detached.asset.name = 'Changed'; detached.components[0].position[0] = 4;
  detached.materials[0].textureRef.assetId = 'changed';
  assert.notEqual(editor.doc.asset.name, 'Changed'); assert.equal(editor.doc.components[0].position[0], 0);
  assert.equal(editor.doc.materials[0].textureRef.assetId, 'opaque-asset');
});

test('strict schema rejects unsupported versions, missing keys and extension/script fields at every level', () => {
  const source = one().doc;
  for (const path of [[], ['asset'], ['materials', 0], ['components', 0]]) {
    for (const mode of ['extra', 'missing']) {
      const doc = copy(source), object = path.reduce((value, key) => value[key], doc);
      if (mode === 'extra') object.script = 'alert(1)'; else delete object[Object.keys(object)[0]];
      assert.throws(() => validate(doc), /missing|unknown/);
    }
  }
  for (const version of [0, 2, '1', null]) { const doc = copy(source); doc.version = version; assert.throws(() => validate(doc)); }
  const doc = copy(source); doc.format = 'universe-image'; assert.throws(() => validate(doc));
  const grouped = two(); grouped.group(); grouped.doc.groups[0].children = []; assert.throws(() => validate(grouped.doc));
});

test('identifiers and names use exact bounds with separate ID namespaces', () => {
  for (const id of ['', 'x'.repeat(65), 'an/id', 'é', 'a b']) { const doc = one().doc; doc.asset.id = id; assert.throws(() => validate(doc)); }
  const doc = one().doc; doc.asset.id = 'x'.repeat(64); doc.components[0].id = doc.materials[0].id; assert.doesNotThrow(() => validate(doc));
  doc.asset.id = '__proto__'; assert.equal(validate(doc).asset.id, '__proto__');
  for (const invalid of ['', 'x'.repeat(81), 'newline\n', 'tab\t', 'nul\0', 'delete\x7f', 42, null]) {
    const candidate = one().doc; candidate.asset.name = invalid; assert.throws(() => validate(candidate));
  }
  doc.asset.name = '🙂'.repeat(40); assert.doesNotThrow(() => validate(doc));
  doc.asset.name += '🙂'; assert.throws(() => validate(doc));
});

test('duplicate IDs and unresolved references fail in every local namespace', () => {
  const doc = one().doc; doc.components.push(copy(doc.components[0])); assert.throws(() => validate(doc), /Duplicate/);
  doc.components.pop(); doc.materials.push(copy(doc.materials[0])); assert.throws(() => validate(doc), /Duplicate/);
  const grouped = two(); grouped.group(); grouped.doc.groups.push(copy(grouped.doc.groups[0])); assert.throws(() => validate(grouped.doc), /Duplicate/);
  for (const changes of [{materialId: 'absent'}, {groupId: 'absent'}, {collision: 'sphere'}, {shape: 'mesh'}]) {
    const candidate = one().doc; Object.assign(candidate.components[0], changes); assert.throws(() => validate(candidate));
  }
});

test('materials are bounded, references are inert IDs, and color/roughness types are strict', () => {
  for (const change of [{color: 'red'}, {color: '#fff'}, {roughness: -1}, {roughness: 1.1}, {roughness: '0.5'}, {textureRef: 'https://example.test/texture'}, {textureRef: {assetId: 'a', versionId: 'v', slot: 'normal'}}, {textureRef: {assetId: 'https://example.test/a', versionId: 'v', slot: 'baseColor'}}, {textureRef: {assetId: 'a', versionId: 'v', slot: 'baseColor', url: 'https://example.test'}}]) {
    const doc = one().doc; Object.assign(doc.materials[0], change); assert.throws(() => validate(doc));
  }
  const doc = createDocument(); doc.materials = []; assert.throws(() => validate(doc));
  doc.materials = Array.from({length: 32}, (_, i) => ({id: `m${i}`, name: 'Material', color: '#ABCdef', roughness: 1, textureRef: null}));
  assert.equal(validate(doc).materials.length, 32); doc.materials.push({...doc.materials[0], id: 'extra'}); assert.throws(() => validate(doc));
});

test('non-finite values, wrong types, holes, accessors and non-plain data never validate', () => {
  for (const value of [NaN, Infinity, -Infinity, '1', null, undefined]) for (const key of ['position', 'size', 'rotation']) {
    const doc = one().doc; doc.components[0][key][0] = value; assert.throws(() => validate(doc));
  }
  const doc = one().doc; delete doc.components[0].position[1]; assert.throws(() => validate(doc), /dense/);
  const extra = one().doc; extra.components[0].size.extra = true; assert.throws(() => validate(extra), /dense/);
  let invoked = false; const getter = one().doc;
  Object.defineProperty(getter.asset, 'name', {enumerable: true, get() { invoked = true; return 'bad'; }});
  assert.throws(() => validate(getter), /plain data/); assert.equal(invoked, false);
  const exotic = one().doc; Object.setPrototypeOf(exotic.asset, {owner: true}); assert.throws(() => validate(exotic), /object/);
  const inherited = one().doc; class CustomArray extends Array {}
  inherited.components[0].position = new CustomArray(0, .5, 0); assert.throws(() => validate(inherited));
  assert.throws(() => validate(null)); assert.throws(() => validate([]));
});

test('parse bounds UTF-8 bytes before JSON parsing and rejects malformed text', () => {
  assert.throws(() => parse(null), /text/); assert.throws(() => parse('{broken'), /valid JSON/);
  assert.throws(() => parse(' '.repeat(LIMITS.bytes + 1)), /byte/);
  assert.throws(() => parse('"' + 'é'.repeat(140000) + '"'), /byte/);
  const json = serialize(createDocument());
  const exact = json + ' '.repeat(LIMITS.bytes - new TextEncoder().encode(json).length);
  assert.deepEqual(parse(exact), createDocument()); assert.throws(() => parse(exact + ' '), /byte/);
});

test('component and exact triangle budgets are independently enforced', () => {
  assert.equal(validate(filled(128)).components.length, 128); assert.throws(() => validate(filled(129)), /Components/);
  const doc = filled(124, 'sphere'); doc.components.push({...copy(doc.components[0]), id: 'cylinder', shape: 'cylinder'});
  assert.equal(triangleCount(validate(doc)), 65536);
  doc.components.push({...copy(doc.components[0]), id: 'wedge', shape: 'wedge'}); assert.throws(() => validate(doc), /triangle/);
});

test('flat groups require at least two members and respect the 64-group limit', () => {
  const doc = filled(128); doc.groups = Array.from({length: 64}, (_, i) => ({id: `g${i}`, name: 'Group'}));
  doc.components.forEach((part, i) => { part.groupId = `g${Math.floor(i / 2)}`; });
  assert.equal(validate(doc).groups.length, 64);
  doc.groups.push({id: 'extra', name: 'Extra'}); assert.throws(() => validate(doc), /Groups/);
  doc.groups.pop(); doc.components[0].groupId = null; assert.throws(() => validate(doc), /two components/);
  const empty = createDocument(); empty.groups.push({id: 'empty', name: 'Empty'}); assert.throws(() => validate(empty), /two components/);
});

test('revision and exact dimensions reject coercion and all out-of-budget geometry', () => {
  for (const revision of [0, 1000001, 1.5, '1', NaN]) { const doc = createDocument(); doc.asset.revision = revision; assert.throws(() => validate(doc)); }
  for (const size of [0, -.5, .049, 32.001, Infinity]) { const doc = one().doc; doc.components[0].size[0] = size; assert.throws(() => validate(doc)); }
  const doc = one().doc; doc.components[0].size = [.05, 32, 32]; doc.components[0].position = [0, 0, 0]; assert.doesNotThrow(() => validate(doc));
  doc.components[0].position = [31.98, 0, 0]; assert.throws(() => validate(doc), /entire rotated/);
  doc.components[0].position = [33, 0, 0]; assert.throws(() => validate(doc), /position/);
});

test('rotations must be normalized quaternions and extents use the rotated box', () => {
  for (const q of [[0, 0, 0, 0], [0, 0, 0, 2], [0, 0, 0], [0, 0, 0, .999], [1, 1, 0, 0]]) {
    const doc = one().doc; doc.components[0].rotation = q; assert.throws(() => validate(doc));
  }
  const doc = one().doc; const part = doc.components[0]; part.position = [31.2, 0, 0]; part.size = [1, 2, 1];
  assert.doesNotThrow(() => validate(doc)); part.rotation = quaternion('z', 45); assert.throws(() => validate(doc), /entire rotated/);
  part.position = [0, 0, 0]; close(componentBounds(part).size, [3 / Math.sqrt(2), 3 / Math.sqrt(2), 1]);
});

// Geometry is tested against the actual locked Babylon math implementation.
test('original primitive data has fixed triangle counts, unit extents, finite UVs and detached arrays', () => {
  for (const shape of SHAPES) {
    const mesh = geometry(shape); assert.equal(mesh.indices.length / 3, TRIANGLES[shape]);
    assert.equal(mesh.positions.length, mesh.normals.length); assert.equal(mesh.uvs.length, mesh.positions.length / 3 * 2);
    assert.ok(mesh.positions.every(value => Number.isFinite(value) && value >= -.5 && value <= .5));
    assert.ok(mesh.uvs.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
    assert.ok(mesh.indices.every(value => Number.isInteger(value) && value >= 0 && value < mesh.positions.length / 3));
    for (const axis of [0, 1, 2]) { const values = mesh.positions.filter((_, i) => i % 3 === axis); close(Math.min(...values), -.5); close(Math.max(...values), .5); }
    mesh.positions[0] = 99; assert.notEqual(geometry(shape).positions[0], 99);
  }
  assert.throws(() => geometry('mesh'));
});

test('every triangle is nondegenerate and faces outward with Babylon winding and normals', () => {
  for (const shape of SHAPES) {
    const {positions, indices, normals} = geometry(shape), babylonNormals = [];
    VertexData.ComputeNormals(positions, indices, babylonNormals); close(normals, babylonNormals);
    const inside = shape === 'wedge' ? [0, -1 / 6, 1 / 6] : [0, 0, 0];
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = indices.slice(i, i + 3).map(id => Vector3.FromArray(positions, id * 3));
      const n = Vector3.Cross(a.subtract(b), c.subtract(b));
      assert.ok(n.length() > 1e-8, `${shape} triangle is nondegenerate`);
      const outward = a.add(b).add(c).scale(1 / 3).subtract(Vector3.FromArray(inside));
      assert.ok(Vector3.Dot(n, outward) > 1e-8, `${shape} triangle points outwards`);
    }
    for (let i = 0; i < normals.length; i += 3) close(Math.hypot(...normals.slice(i, i + 3)), 1);
  }
});

test('wedge rises toward positive Z and cylinder main axis is Y', () => {
  const wedge = geometry('wedge').positions;
  for (let i = 0; i < wedge.length; i += 3) if (wedge[i + 2] === -.5) assert.equal(wedge[i + 1], -.5);
  const cylinder = geometry('cylinder').positions;
  for (let i = 0; i < cylinder.length; i += 3) assert.equal(Math.abs(cylinder[i + 1]), .5);
});

test('quaternion transforms match Babylon and multiply composes in world-axis order', () => {
  const v = [1.2, -.3, 2.1];
  for (const axis of ['x', 'y', 'z']) for (const angle of [-90, 15, 45, 180, 720]) {
    const q = quaternion(axis, angle), matrix = Matrix.Compose(Vector3.One(), Quaternion.FromArray(q), Vector3.Zero());
    close(rotateVector(v, q), Vector3.TransformCoordinates(Vector3.FromArray(v), matrix).asArray(), 1e-6);
  }
  const a = quaternion('y', 45), b = quaternion('x', 90);
  close(rotateVector(v, multiply(a, b)), rotateVector(rotateVector(v, b), a));
  assert.throws(() => quaternion('bad', 15)); assert.throws(() => quaternion('x', NaN));
});

// Authoring operations and transactional state.
test('each operation commits once, undo and redo remain stable for 100 cycles', () => {
  const editor = one(); editor.patch({size: [2, .5, 3]}); editor.move([1, .25, -2]); editor.rotate('x', 15);
  const result = copy(editor.doc), count = editor.history.length;
  for (let i = 0; i < 100; i++) { assert.equal(editor.undo(), true); assert.equal(editor.redo(), true); assert.deepEqual(editor.doc, result); }
  assert.equal(editor.history.length, count); assert.equal(editor.future.length, 0);
});

test('undo history is bounded at 80 and a committed change invalidates redo', () => {
  const editor = one();
  for (let i = 0; i < 100; i++) editor.patch({name: `Part ${i}`});
  assert.equal(editor.history.length, LIMITS.history);
  for (let i = 0; i < 80; i++) assert.equal(editor.undo(), true);
  assert.equal(editor.undo(), false); assert.equal(editor.doc.components[0].name, 'Part 19');
  assert.equal(editor.future.length, 80); editor.patch({name: 'New branch'});
  assert.equal(editor.canRedo, false); assert.equal(editor.redo(), false);
});

test('selection and no-op edits never consume history or clear redo', () => {
  const editor = one(); editor.move([1, 0, 0]); editor.undo();
  const history = editor.history.length, future = editor.future.length;
  editor.select([]); editor.move([1, 0, 0]); editor.select('part-1'); editor.move([0, 0, 0]);
  assert.equal(editor.history.length, history); assert.equal(editor.future.length, future);
  rejectsUnchanged(editor, () => editor.select('unknown'));
});

test('invalid edits are atomic for document, selection, redo and history', () => {
  const editor = one(); editor.move([1, 0, 0]); editor.undo();
  for (const operation of [() => editor.patch({size: [-1, 1, 1]}), () => editor.patch({position: [99, 0, 0]}), () => editor.patch({name: undefined}), () => editor.patch({id: 'another'}), () => editor.move([Infinity, 0, 0]), () => editor.scale(100), () => editor.group(), () => editor.add('sphere', [99, 0, 0]), () => editor.add('box', [0, 0, 0], {name: undefined})]) rejectsUnchanged(editor, operation);
  const size = [1, 1, 1]; size.extra = true; rejectsUnchanged(editor, () => editor.patch({size}));
});

test('patch inputs and add inputs remain detached after a successful operation', () => {
  const editor = new Workshop(), position = [0, .5, 0], size = [1, 2, 1];
  editor.add('box', position, {size}); position[0] = 99; size[0] = 99;
  assert.equal(editor.doc.components[0].position[0], 0); assert.equal(editor.doc.components[0].size[0], 1);
  const changed = [2, 2, 2]; editor.patch({size: changed}); changed[0] = 99; assert.equal(editor.doc.components[0].size[0], 2);
});

test('group selection expands membership, toggles together and ungroup keeps transforms', () => {
  const editor = two(); editor.group('Pair'); const before = copy(editor.doc.components);
  editor.select([]); editor.select(before[1].id); assert.equal(editor.selection.size, 2);
  editor.select(before[0].id, {toggle: true}); assert.equal(editor.selection.size, 0);
  editor.select(before[0].id); editor.ungroup(); assert.equal(editor.doc.groups.length, 0);
  for (let i = 0; i < before.length; i++) assert.deepEqual(editor.doc.components[i], {...before[i], groupId: null});
  editor.select(before[1].id); assert.equal(editor.selection.size, 1);
});

test('grouped duplication remaps IDs and groups without changing original transforms', () => {
  const editor = two(); editor.group('Pair'); const original = copy(editor.doc);
  editor.duplicate([1, 0, -1]); assert.equal(editor.doc.components.length, 4); assert.equal(editor.doc.groups.length, 2);
  assert.deepEqual(editor.doc.components.slice(0, 2), original.components);
  assert.equal(editor.selection.size, 2); assert.notEqual(editor.selected[0].groupId, original.groups[0].id);
  editor.selected.forEach((part, i) => close(part.position, original.components[i].position.map((v, a) => v + [1, 0, -1][a])));
  assert.equal(new Set(editor.doc.components.map(part => part.id)).size, 4);
  editor.delete(); assert.deepEqual(editor.doc, original);
  editor.undo(); assert.equal(editor.doc.components.length, 4);
});

test('grouping already grouped selections is flat and removes superseded groups', () => {
  const editor = two(); editor.group('Pair'); editor.add('sphere', [4, .5, 0]);
  editor.select(editor.doc.components.map(part => part.id)); editor.group('All');
  assert.equal(editor.doc.groups.length, 1); assert.equal(editor.doc.groups[0].name, 'All');
  assert.ok(editor.doc.components.every(part => part.groupId === editor.doc.groups[0].id));
  editor.delete(); assert.equal(editor.doc.groups.length, 0); assert.equal(editor.doc.components.length, 0);
});

test('snapping targets first document-order component and preserves group offsets and off-grid Y', () => {
  const editor = two(); editor.doc.components[0].position = [.13, .73, -.14]; editor.doc.components[1].position = [2.23, 1.07, .42];
  editor.select(['part-2', 'part-1']); const before = copy(editor.doc.components);
  editor.move([.12, 0, .2], {snap: .5});
  close(editor.doc.components[0].position, [.5, .73, 0]);
  close(editor.doc.components[1].position, [2.6, 1.07, .56]);
  close(editor.doc.components[1].position.map((v, i) => v - editor.doc.components[0].position[i]), before[1].position.map((v, i) => v - before[0].position[i]));
  editor.select('part-1'); editor.patch({position: [.13, .77, .19]}); close(editor.selected[0].position, [.13, .77, .19]);
});

test('group rotation and uniform scale use mean center and retain shape/material/editability', () => {
  const editor = two(); const initial = copy(editor.doc.components);
  const pivot = initial[0].position.map((v, axis) => (v + initial[1].position[axis]) / 2);
  editor.rotate('y', 90);
  editor.doc.components.forEach((part, i) => {
    close(part.position, rotateVector(initial[i].position.map((v, axis) => v - pivot[axis]), quaternion('y', 90)).map((v, axis) => v + pivot[axis]));
    close(part.rotation, quaternion('y', 90)); assert.equal(part.shape, 'box'); assert.equal(part.materialId, initial[i].materialId);
  });
  const rotated = copy(editor.doc.components); editor.scale(2);
  editor.doc.components.forEach((part, i) => { close(part.size, [2, 2, 2]); close(part.position, rotated[i].position.map((v, a) => pivot[a] + 2 * (v - pivot[a]))); });
});

test('alignment uses first document-order component and conservative rotated edges', () => {
  for (const mode of ['min', 'center', 'max']) {
    const editor = two(); editor.doc.components[0].size = [2, 1, 1]; editor.doc.components[1].rotation = quaternion('y', 45);
    editor.select(['part-2', 'part-1']); const first = copy(editor.doc.components[0]);
    editor.align('x', mode); assert.deepEqual(editor.doc.components[0], first);
    const coord = part => mode === 'center' ? part.position[0] : componentBounds(part)[mode][0];
    close(coord(editor.doc.components[0]), coord(editor.doc.components[1]));
  }
});

test('gesture previews are absolute from begin, commit creates exactly one undo operation', () => {
  const editor = one(), before = copy(editor.doc), count = editor.history.length;
  editor.begin();
  for (let i = 1; i <= 100; i++) editor.previewMove([i / 100, 0, 0]);
  close(editor.selected[0].position, [1, .5, 0]); assert.equal(editor.history.length, count);
  assert.equal(editor.commit(), true); assert.equal(editor.history.length, count + 1);
  assert.equal(editor.inGesture, false); editor.undo(); assert.deepEqual(editor.doc, before); editor.redo(); close(editor.selected[0].position, [1, .5, 0]);
});

test('cancelled, empty and invalid gestures preserve history, redo, selections and off-grid heights', () => {
  const editor = two(); editor.group(); editor.move([1, 0, 0]); editor.undo();
  const before = state(editor); editor.begin(); editor.previewMove([.34, 0, .34], {snap: .5});
  rejectsUnchanged(editor, () => editor.previewMove([99, 0, 0]));
  rejectsUnchanged(editor, () => editor.patch({name: 'not during drag'}));
  assert.equal(editor.cancel(), true); assert.deepEqual(state(editor), before);
  editor.begin(); assert.equal(editor.commit(), false); assert.deepEqual(state(editor), before);
  assert.equal(editor.commit(), false); assert.equal(editor.cancel(), false); assert.throws(() => editor.previewMove([0, 0, 0]));
  editor.begin(); editor.previewMove([.3, 0, 0]); assert.equal(editor.undo(), true); assert.deepEqual(state(editor), before);
});

test('valid imports and New are undoable while malformed imports retain current draft', () => {
  const editor = one('cylinder'), original = copy(editor.doc); editor.load(createFurniture('chair')); assert.equal(editor.doc.components.length, 8);
  editor.undo(); assert.deepEqual(editor.doc, original); editor.redo();
  rejectsUnchanged(editor, () => editor.load('{invalid')); const invalid = createDocument(); invalid.version = 2;
  rejectsUnchanged(editor, () => editor.load(invalid));
  const chair = copy(editor.doc); editor.load(createDocument('Fresh')); assert.equal(editor.doc.components.length, 0);
  editor.undo(); assert.deepEqual(editor.doc, chair);
});

test('full edit bounds include decorative geometry while colliders include only box policy', () => {
  const editor = two(); editor.doc.components[1].collision = 'none'; editor.doc.components[1].position = [10, 2, 0];
  const all = bounds(editor.doc), colliders = collisionMetadata(editor.doc);
  assert.equal(all.max[0], 10.5); assert.equal(colliders.length, 1); assert.equal(colliders[0].componentId, 'part-1');
  assert.deepEqual(colliders[0].center, [0, .5, 0]); assert.deepEqual(colliders[0].size, [1, 1, 1]);
  assert.deepEqual(colliders[0].aabb, componentBounds(editor.doc.components[0]));
  colliders[0].center[0] = 99; assert.equal(editor.doc.components[0].position[0], 0);
  assert.deepEqual(bounds(createDocument()).size, [0, 0, 0]);
});

test('instances are detached pinned references with separate large position bounds and no geometry', () => {
  const instance = {id: 'placed-1', assetRef: {assetId: 'asset-17', revision: 3}, position: [1000000, 0, -1000000], rotation: quaternion('y', 90)};
  const valid = validateInstance(instance); assert.deepEqual(valid, instance); valid.assetRef.revision = 4; assert.equal(instance.assetRef.revision, 3);
  for (const changes of [{ownerId: 'me'}, {size: [1, 1, 1]}, {components: []}, {position: [1000001, 0, 0]}, {rotation: [0, 0, 0, 0]}]) assert.throws(() => validateInstance({...instance, ...changes}));
  assert.throws(() => validateInstance({...instance, assetRef: {assetId: 'a', revision: 1, url: 'https://example.test'}}));
  assert.throws(() => validateInstance({...instance, assetRef: {assetId: 'a', revision: 0}}));
  assert.throws(() => validateInstance(createDocument()));
});
