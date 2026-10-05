import {SHAPES, TRIANGLES} from './geometry.js';
export {SHAPES, TRIANGLES};

export const LIMITS = Object.freeze({
  bytes: 262144, components: 128, materials: 32, groups: 64, triangles: 65536,
  minSize: .05, maxSize: 32, extent: 32, history: 80, revision: 1000000,
  instanceExtent: 1000000, quaternionTolerance: 1e-6,
});
const FORMAT = 'universe-asset-workshop';
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const NAME = /^[^\x00-\x1f\x7f]{1,80}$/;
const clone = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw new Error(message); };

function record(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be an object`);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) fail(`${label} has missing or unknown fields`);
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !('value' in property) || !property.enumerable) fail(`${label}.${key} must be plain data`);
  }
  return value;
}
function list(value, max, label, min = 0) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max) fail(`${label} must contain ${min}–${max} entries`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(String(key)) || Number(key) >= value.length))) fail(`${label} must be a dense array`);
  for (let i = 0; i < value.length; i++) {
    const property = Object.getOwnPropertyDescriptor(value, String(i));
    if (!property || !('value' in property) || !property.enumerable) fail(`${label} must be plain data`);
  }
  return value;
}
function number(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label} must be a finite number from ${min} to ${max}`);
  return value;
}
function integer(value, min, max, label) {
  number(value, min, max, label);
  if (!Number.isInteger(value)) fail(`${label} must be an integer`);
  return value;
}
function identifier(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) fail(`${label} must be a 1–64 character identifier`);
  return value;
}
function name(value, label) {
  if (typeof value !== 'string' || !NAME.test(value)) fail(`${label} must be a nonempty name of at most 80 characters without control characters`);
  return value;
}
function vector(value, min, max, label) {
  list(value, 3, label, 3);
  return value.map((n, i) => number(n, min, max, `${label}[${i}]`));
}
function rotation(value, label) {
  list(value, 4, label, 4);
  const out = value.map((n, i) => number(n, -1, 1, `${label}[${i}]`));
  if (Math.abs(Math.hypot(...out) - 1) > LIMITS.quaternionTolerance) fail(`${label} must be a normalized quaternion`);
  return out;
}
function axisIndex(axis) {
  const result = typeof axis === 'string' ? ['x', 'y', 'z'].indexOf(axis.toLowerCase()) : axis;
  if (![0, 1, 2].includes(result)) fail('Choose the X, Y or Z axis');
  return result;
}
function normalized(q) {
  const length = Math.hypot(...q);
  return q.map(value => value / length);
}
/** Native quaternion convention; angles are degrees in editor controls. */
export function quaternion(axis, degrees) {
  const index = axisIndex(axis);
  number(degrees, -Number.MAX_VALUE, Number.MAX_VALUE, 'Angle');
  const angle = (degrees % 360) * Math.PI / 360, q = [0, 0, 0, Math.cos(angle)];
  q[index] = Math.sin(angle);
  return q;
}
/** Hamilton product, applying b first and then a. */
export function multiply(a, b) {
  const [x, y, z, w] = a, [X, Y, Z, W] = b;
  return [w * X + x * W + y * Z - z * Y, w * Y - x * Z + y * W + z * X, w * Z + x * Y - y * X + z * W, w * W - x * X - y * Y - z * Z];
}
export function rotateVector(v, q) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx];
}
/** Conservative AABB of the component's oriented dimensions, including decorative parts. */
export function componentBounds(component) {
  const axes = [0, 1, 2].map(axis => rotateVector([0, 1, 2].map(i => i === axis ? component.size[axis] / 2 : 0), component.rotation));
  const half = [0, 1, 2].map(axis => axes.reduce((sum, vector) => sum + Math.abs(vector[axis]), 0));
  const min = component.position.map((value, axis) => value - half[axis]);
  const max = component.position.map((value, axis) => value + half[axis]);
  return {min, max, center: [...component.position], size: half.map(value => value * 2)};
}

/** Strict v1 validation returns new plain records; unknown fields never survive. */
export function validate(input) {
  record(input, ['format', 'version', 'asset', 'materials', 'groups', 'components'], 'Composition');
  if (input.format !== FORMAT || input.version !== 1) fail('Unsupported composition format or version');
  record(input.asset, ['id', 'revision', 'name'], 'Asset');
  const asset = {id: identifier(input.asset.id, 'Asset ID'), revision: integer(input.asset.revision, 1, LIMITS.revision, 'Asset revision'), name: name(input.asset.name, 'Asset name')};
  const materialIds = new Set(), groupIds = new Set(), componentIds = new Set(), members = new Map();
  const unique = (id, ids, label) => { identifier(id, `${label} ID`); if (ids.has(id)) fail(`Duplicate ${label} ID`); ids.add(id); return id; };
  const materials = list(input.materials, LIMITS.materials, 'Materials', 1).map(material => {
    record(material, ['id', 'name', 'color', 'roughness', 'textureRef'], 'Material');
    const id = unique(material.id, materialIds, 'material');
    if (typeof material.color !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(material.color)) fail('Material color must be six-digit hex');
    let textureRef = null;
    if (material.textureRef !== null) {
      record(material.textureRef, ['assetId', 'versionId', 'slot'], 'Texture reference');
      if (material.textureRef.slot !== 'baseColor') fail('Unsupported texture slot');
      textureRef = {assetId: identifier(material.textureRef.assetId, 'Texture asset ID'), versionId: identifier(material.textureRef.versionId, 'Texture version ID'), slot: 'baseColor'};
    }
    return {id, name: name(material.name, 'Material name'), color: material.color, roughness: number(material.roughness, 0, 1, 'Material roughness'), textureRef};
  });
  const groups = list(input.groups, LIMITS.groups, 'Groups').map(group => {
    record(group, ['id', 'name'], 'Group');
    const id = unique(group.id, groupIds, 'group'); members.set(id, 0);
    return {id, name: name(group.name, 'Group name')};
  });
  let triangles = 0;
  const components = list(input.components, LIMITS.components, 'Components').map(component => {
    record(component, ['id', 'name', 'shape', 'position', 'rotation', 'size', 'materialId', 'groupId', 'collision'], 'Component');
    const id = unique(component.id, componentIds, 'component');
    if (!SHAPES.includes(component.shape)) fail('Unsupported primitive shape');
    if (!materialIds.has(component.materialId)) fail('Unresolved component material');
    if (component.groupId !== null && !groupIds.has(component.groupId)) fail('Unresolved component group');
    if (!['none', 'box'].includes(component.collision)) fail('Unsupported collision mode');
    const out = {id, name: name(component.name, 'Component name'), shape: component.shape,
      position: vector(component.position, -LIMITS.extent, LIMITS.extent, 'Component position'),
      rotation: rotation(component.rotation, 'Component rotation'), size: vector(component.size, LIMITS.minSize, LIMITS.maxSize, 'Component size'),
      materialId: component.materialId, groupId: component.groupId, collision: component.collision};
    const aabb = componentBounds(out);
    if (aabb.min.some(value => value < -LIMITS.extent) || aabb.max.some(value => value > LIMITS.extent)) fail('Keep the entire rotated component within −32 to +32 metres');
    if (out.groupId !== null) members.set(out.groupId, members.get(out.groupId) + 1);
    triangles += TRIANGLES[out.shape];
    return out;
  });
  if ([...members.values()].some(count => count < 2)) fail('Each group must contain at least two components');
  if (triangles > LIMITS.triangles) fail('Composition exceeds the triangle budget');
  return {format: FORMAT, version: 1, asset, materials, groups, components};
}

export function parse(text) {
  if (typeof text !== 'string') fail('Import must be JSON text');
  // The code-unit bound avoids allocating an unbounded encoder buffer for huge input.
  if (text.length > LIMITS.bytes || new TextEncoder().encode(text).byteLength > LIMITS.bytes) fail('Import exceeds the 262,144-byte limit');
  let document;
  try { document = JSON.parse(text); } catch { fail('Import is not valid JSON'); }
  return validate(document);
}
export function serialize(document) { return JSON.stringify(validate(document), null, 2); }
export function triangleCount(document) { return document.components.reduce((sum, component) => sum + TRIANGLES[component.shape], 0); }
export function bounds(document) {
  const doc = validate(document);
  if (!doc.components.length) return {min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], size: [0, 0, 0]};
  const boxes = doc.components.map(componentBounds);
  const min = [0, 1, 2].map(axis => Math.min(...boxes.map(box => box.min[axis])));
  const max = [0, 1, 2].map(axis => Math.max(...boxes.map(box => box.max[axis])));
  return {min, max, center: min.map((value, axis) => (value + max[axis]) / 2), size: min.map((value, axis) => max[axis] - value)};
}
export function collisionMetadata(document) {
  return validate(document).components.filter(component => component.collision === 'box').map(component => ({
    componentId: component.id, center: [...component.position], rotation: [...component.rotation], size: [...component.size], aabb: componentBounds(component),
  }));
}
export function validateInstance(input) {
  record(input, ['id', 'assetRef', 'position', 'rotation'], 'Instance');
  record(input.assetRef, ['assetId', 'revision'], 'Asset reference');
  return {id: identifier(input.id, 'Instance ID'), assetRef: {assetId: identifier(input.assetRef.assetId, 'Referenced asset ID'), revision: integer(input.assetRef.revision, 1, LIMITS.revision, 'Referenced revision')},
    position: vector(input.position, -LIMITS.instanceExtent, LIMITS.instanceExtent, 'Instance position'), rotation: rotation(input.rotation, 'Instance rotation')};
}

export function createDocument(assetName = 'My furniture') {
  return validate({format: FORMAT, version: 1, asset: {id: 'local-asset', revision: 1, name: assetName}, materials: [
    {id: 'mint', name: 'Mint', color: '#2dd4bf', roughness: .75, textureRef: null},
    {id: 'wood', name: 'Warm wood', color: '#9c6644', roughness: .8, textureRef: null},
    {id: 'gold', name: 'Gold', color: '#f4c95d', roughness: .5, textureRef: null},
    {id: 'ink', name: 'Ink', color: '#292738', roughness: .8, textureRef: null},
    {id: 'violet', name: 'Violet', color: '#8b5cf6', roughness: .65, textureRef: null},
  ], groups: [], components: []});
}

function newId(prefix, records) {
  const used = new Set(records.map(record => record.id));
  for (let number = 1; ; number++) if (!used.has(`${prefix}-${number}`)) return `${prefix}-${number}`;
}
function cleanupGroups(doc) {
  const counts = new Map(doc.groups.map(group => [group.id, 0]));
  for (const component of doc.components) if (component.groupId !== null) counts.set(component.groupId, (counts.get(component.groupId) || 0) + 1);
  const removed = new Set([...counts].filter(([, count]) => count < 2).map(([id]) => id));
  doc.groups = doc.groups.filter(group => !removed.has(group.id));
  for (const component of doc.components) if (removed.has(component.groupId)) component.groupId = null;
}
function patchFields(changes, permitted) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) fail('Changes must be an object');
  record(changes, Object.keys(changes), 'Changes');
  for (const key of Object.keys(changes)) if (!permitted.includes(key)) fail(`Cannot patch ${key}`);
}
const EDITABLE = ['name', 'shape', 'position', 'rotation', 'size', 'materialId', 'collision'];

/** Pure editor state. Every committed operation validates before changing document or history. */
export class Workshop {
  constructor(document = createDocument()) {
    this.doc = validate(document);
    this.selection = new Set();
    this.history = [];
    this.future = [];
    this.gesture = null;
  }
  get selected() { return this.doc.components.filter(component => this.selection.has(component.id)); }
  get canUndo() { return this.history.length > 0; }
  get canRedo() { return this.future.length > 0; }
  get inGesture() { return this.gesture !== null; }
  _snapshot() { return {doc: validate(this.doc), selection: [...this.selection]}; }
  _restore(state) { this.doc = validate(state.doc); this.selection = new Set(state.selection); }
  _remember(snapshot) {
    this.history.push(snapshot);
    if (this.history.length > LIMITS.history) this.history.shift();
    this.future = [];
  }
  _ids(doc = this.doc, selection = this.selection) {
    const groups = new Set(doc.components.filter(component => selection.has(component.id) && component.groupId !== null).map(component => component.groupId));
    return new Set(doc.components.filter(component => selection.has(component.id) || groups.has(component.groupId)).map(component => component.id));
  }
  _mutate(operation) {
    if (this.gesture) fail('Finish or cancel the active gesture first');
    const before = this._snapshot(), next = clone(before.doc), selection = this._ids(next);
    const result = operation(next, selection);
    const checked = validate(next);
    if (JSON.stringify(checked) !== JSON.stringify(before.doc)) this._remember(before);
    this.doc = checked;
    this.selection = new Set([...selection].filter(id => checked.components.some(component => component.id === id)));
    return result;
  }
  select(ids = [], {additive = false, toggle = false} = {}) {
    if (this.gesture) fail('Finish or cancel the active gesture first');
    const values = typeof ids === 'string' ? [ids] : ids === null ? [] : [...ids];
    if (values.some(id => !this.doc.components.some(component => component.id === id))) fail('Cannot select an unknown component');
    const selected = this._ids(this.doc, new Set(values));
    const next = additive || toggle ? this._ids() : new Set();
    if (toggle && [...selected].every(id => next.has(id))) for (const id of selected) next.delete(id);
    else for (const id of selected) next.add(id);
    this.selection = next;
    return this.selected;
  }
  add(shape, position = [0, .5, 0], overrides = {}) {
    if (!SHAPES.includes(shape)) fail('Unsupported primitive shape');
    patchFields(overrides, EDITABLE.filter(key => !['shape', 'position'].includes(key)));
    const id = this._mutate((doc, selection) => {
      const id = newId('part', doc.components);
      doc.components.push({id, name: shape[0]?.toUpperCase() + shape.slice(1), shape, position, rotation: [0, 0, 0, 1], size: [1, 1, 1], materialId: doc.materials[0].id, groupId: null, collision: 'box', ...overrides});
      selection.clear(); selection.add(id);
      return id;
    });
    return this.doc.components.find(component => component.id === id);
  }
  patch(changes) {
    patchFields(changes, EDITABLE);
    this._mutate((doc, selection) => { for (const component of doc.components) if (selection.has(component.id)) Object.assign(component, changes); });
    return this.doc;
  }
  _move(doc, selection, delta, options = {}) {
    vector(delta, -Number.MAX_VALUE, Number.MAX_VALUE, 'Movement');
    const snap = typeof options === 'number' ? options : options.snap ?? 0;
    number(snap, 0, LIMITS.maxSize, 'Snap step');
    const first = doc.components.find(component => selection.has(component.id));
    if (!first) return;
    const translation = [...delta];
    if (snap > 0) for (const axis of [0, 2]) translation[axis] = Math.round((first.position[axis] + delta[axis]) / snap) * snap - first.position[axis];
    for (const component of doc.components) if (selection.has(component.id)) component.position = component.position.map((value, axis) => value + translation[axis]);
  }
  move(delta, options = {}) {
    this._mutate((doc, selection) => this._move(doc, selection, delta, options));
    return this.doc;
  }
  rotate(axis, degrees = 15) {
    const q = quaternion(axis, degrees);
    this._mutate((doc, selection) => {
      const parts = doc.components.filter(component => selection.has(component.id));
      if (!parts.length) return;
      const pivot = [0, 1, 2].map(axis => parts.reduce((sum, part) => sum + part.position[axis], 0) / parts.length);
      for (const part of parts) {
        const rotated = rotateVector(part.position.map((value, axis) => value - pivot[axis]), q);
        part.position = rotated.map((value, axis) => value + pivot[axis]);
        part.rotation = normalized(multiply(q, part.rotation));
      }
    });
    return this.doc;
  }
  scale(factor) {
    number(factor, Number.MIN_VALUE, Number.MAX_VALUE, 'Scale');
    this._mutate((doc, selection) => {
      const parts = doc.components.filter(component => selection.has(component.id));
      if (!parts.length) return;
      const pivot = [0, 1, 2].map(axis => parts.reduce((sum, part) => sum + part.position[axis], 0) / parts.length);
      for (const part of parts) {
        part.position = part.position.map((value, axis) => pivot[axis] + (value - pivot[axis]) * factor);
        part.size = part.size.map(value => value * factor);
      }
    });
    return this.doc;
  }
  align(axis, mode = 'center') {
    const index = axisIndex(axis);
    if (!['min', 'max', 'center'].includes(mode)) fail('Choose minimum, maximum or center alignment');
    this._mutate((doc, selection) => {
      const parts = doc.components.filter(component => selection.has(component.id));
      if (parts.length < 2) return;
      const coordinate = part => mode === 'center' ? part.position[index] : componentBounds(part)[mode][index];
      const target = coordinate(parts[0]);
      for (const part of parts.slice(1)) part.position[index] += target - coordinate(part);
    });
    return this.doc;
  }
  group(groupName = 'Group') {
    return this._mutate((doc, selection) => {
      if (selection.size < 2) fail('Select at least two components to group');
      const id = newId('group', doc.groups);
      doc.groups.push({id, name: groupName});
      for (const component of doc.components) if (selection.has(component.id)) component.groupId = id;
      cleanupGroups(doc);
      return id;
    });
  }
  ungroup() {
    this._mutate((doc, selection) => {
      for (const component of doc.components) if (selection.has(component.id)) component.groupId = null;
      cleanupGroups(doc);
    });
    return this.doc;
  }
  duplicate(offset = [.25, 0, .25]) {
    vector(offset, -Number.MAX_VALUE, Number.MAX_VALUE, 'Duplicate offset');
    this._mutate((doc, selection) => {
      const parts = doc.components.filter(component => selection.has(component.id)), groupCopies = new Map();
      selection.clear();
      for (const part of parts) {
        if (part.groupId !== null && !groupCopies.has(part.groupId)) {
          const source = doc.groups.find(group => group.id === part.groupId), id = newId('group', doc.groups);
          doc.groups.push({id, name: source.name}); groupCopies.set(part.groupId, id);
        }
        const copy = {...clone(part), id: newId('part', doc.components), position: part.position.map((value, axis) => value + offset[axis]), groupId: part.groupId === null ? null : groupCopies.get(part.groupId)};
        doc.components.push(copy); selection.add(copy.id);
      }
    });
    return this.doc;
  }
  delete() {
    this._mutate((doc, selection) => { doc.components = doc.components.filter(component => !selection.has(component.id)); selection.clear(); cleanupGroups(doc); });
    return this.doc;
  }
  load(document) {
    const loaded = typeof document === 'string' ? parse(document) : validate(document);
    this._mutate((doc, selection) => { for (const key of Object.keys(doc)) doc[key] = loaded[key]; selection.clear(); });
    return this.doc;
  }
  begin() {
    if (this.gesture) fail('A gesture is already active');
    this.gesture = this._snapshot();
    this.gesture.selection = [...this._ids()];
    return this.doc;
  }
  previewMove(delta, options = {}) {
    if (!this.gesture) fail('Begin a gesture before previewing a move');
    const next = clone(this.gesture.doc), selection = new Set(this.gesture.selection);
    this._move(next, selection, delta, options);
    this.doc = validate(next); this.selection = selection;
    return this.doc;
  }
  commit() {
    if (!this.gesture) return false;
    const next = validate(this.doc), before = this.gesture;
    const changed = JSON.stringify(next) !== JSON.stringify(before.doc);
    if (changed) this._remember(before);
    this.doc = next; this.gesture = null;
    return changed;
  }
  cancel() {
    if (!this.gesture) return false;
    const before = this.gesture;
    this._restore(before); this.gesture = null;
    return true;
  }
  undo() {
    if (this.gesture) return this.cancel();
    if (!this.history.length) return false;
    const current = this._snapshot(), previous = this.history.at(-1);
    this._restore(previous); this.history.pop(); this.future.push(current);
    return true;
  }
  redo() {
    if (this.gesture) fail('Finish or cancel the active gesture first');
    if (!this.future.length) return false;
    const current = this._snapshot(), next = this.future.at(-1);
    this._restore(next); this.future.pop(); this.history.push(current);
    if (this.history.length > LIMITS.history) this.history.shift();
    return true;
  }
}

/** Starters use the same editable component operations as the manual editor. */
export function createFurniture(kind = 'chair') {
  if (!['chair', 'table'].includes(kind)) fail('Choose a chair or table starter');
  const editor = new Workshop(createDocument(kind === 'chair' ? 'My chair' : 'My table'));
  const add = (name, position, size, materialId = 'wood') => editor.add('box', position, {name, size, materialId});
  if (kind === 'chair') {
    add('Seat', [0, .7, 0], [1.3, .18, 1.3], 'mint');
    for (const x of [-.48, .48]) for (const z of [-.48, .48]) add('Leg', [x, .305, z], [.16, .61, .16]);
    add('Backrest', [0, 1.25, .55], [1.3, .9, .16], 'mint');
    for (const x of [-.48, .48]) add('Back support', [x, .94, .55], [.12, .6, .12]);
  } else {
    add('Tabletop', [0, 1.08, 0], [2.8, .2, 1.6], 'mint');
    for (const x of [-1.18, 1.18]) for (const z of [-.58, .58]) add('Leg', [x, .49, z], [.18, .98, .18]);
  }
  editor.select(editor.doc.components.map(part => part.id));
  editor.group(kind === 'chair' ? 'Chair' : 'Table');
  return validate(editor.doc);
}
