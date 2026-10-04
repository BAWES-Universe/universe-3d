/** Pure v1 metadata contract. Shape validation does not establish authorization or decode PNG bytes. */
export const IMAGE_ASSET_SCHEMA_VERSION = 1;
export const IMAGE_ASSET_LIMITS = Object.freeze({minMetres: 0.0001, maxMetres: 64, maxBytes: 5 * 1024 * 1024, maxDimension: 2048, maxPixels: 4194304, maxCells: 4096, maxName: 120, maxTags: 20, maxTag: 40, maxCoordinate: 1000000});
export const IMAGE_PIXELS_PER_METRE = 32;

/** Absent dimensions identify legacy versions; never materialize them into saved metadata. */
export function imagePhysicalSize(version) {
  return {widthMetres: version.widthMetres ?? version.widthPixels / IMAGE_PIXELS_PER_METRE,
    heightMetres: version.heightMetres ?? version.heightPixels / IMAGE_PIXELS_PER_METRE};
}
/** A starting suggestion, not a placement/obstruction guarantee. */
export function suggestImagePhysicalSize(widthPixels, heightPixels, bounds) {
  const roomLimit = bounds && [bounds.width, bounds.depth].every(n => Number.isFinite(n) && n > 0)
    ? Math.min(bounds.width, bounds.depth) / 4 : 2;
  const longest = Math.max(IMAGE_ASSET_LIMITS.minMetres * Math.max(widthPixels, heightPixels) / Math.min(widthPixels, heightPixels), Math.min(2, roomLimit));
  const scale = longest / Math.max(widthPixels, heightPixels);
  return {widthMetres: widthPixels * scale, heightMetres: heightPixels * scale};
}

export class ImageAssetValidationError extends Error {
  constructor(field, message, code = 'INVALID_IMAGE_ASSET') {
    super(message); this.name = 'ImageAssetValidationError'; this.code = code; this.field = field; this.status = 400;
    this.issues = Object.freeze([Object.freeze({field, code, message})]);
  }
}
const fail = (field, message, code) => { throw new ImageAssetValidationError(field, message, code); };
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const count = text => [...text].length;
function record(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(field, `${field} must be a plain record`);
  return value;
}
function keys(value, allowed, field) {
  record(value, field);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${field}.${key}`, `Unsupported field ${field}.${key}`, 'UNSUPPORTED_IMAGE_FIELD');
}
function required(value, fields, path) { for (const field of fields) if (!own(value, field)) fail(`${path}.${field}`, `${path}.${field} is required`); }
function finite(value, field, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(field, `${field} must be a finite number in [${min}, ${max}]`);
  return Object.is(value, -0) ? 0 : value;
}
function integer(value, field, min, max) {
  if (!Number.isSafeInteger(value)) fail(field, `${field} must be a safe integer`);
  return finite(value, field, min, max);
}
function text(value, field, max, empty = false) {
  if (typeof value !== 'string') fail(field, `${field} must be text`);
  const result = value.normalize('NFC').trim();
  if ((!empty && !result) || count(result) > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result)) fail(field, `${field} must contain ${empty ? '0' : '1'}–${max} characters without control characters`);
  return result;
}
function id(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail(field, `${field} must be an opaque ID of 1–128 letters, digits, underscores or hyphens`);
  return value;
}
function date(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) fail(field, `${field} must be a canonical UTC ISO timestamp`);
  return value;
}
/** Freezes newly constructed JSON-like results; callers must not pass shared mutable inputs. */
export function freezeImageRecord(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeImageRecord(child); Object.freeze(value); }
  return value;
}
function tags(raw = []) {
  if (typeof raw === 'string') { if (raw.length > 20000) fail('draft.tags', 'Tags input is too long'); raw = raw.split(','); }
  if (!Array.isArray(raw) || raw.length > 200) fail('draft.tags', 'Tags must be a bounded array or comma-separated text');
  const result = [], seen = new Set();
  for (const [index, value] of raw.entries()) {
    const tag = text(value, `draft.tags.${index}`, IMAGE_ASSET_LIMITS.maxTag, true), key = tag.toLowerCase();
    if (tag && !seen.has(key)) { seen.add(key); result.push(tag); }
  }
  if (result.length > IMAGE_ASSET_LIMITS.maxTags) fail('draft.tags', 'Use at most 20 unique tags');
  return result;
}
const DRAFT_FIELDS = ['name', 'tags', 'representation', 'depthPreset', 'depthPivot', 'floating', 'collisionGrid', 'widthMetres', 'heightMetres'];
/** Mutable discovery text; never substitutes version geometry, bytes, or identity. */
export function normalizeImageLibraryMetadata(raw) {
  keys(raw, ['name', 'description', 'tags'], 'metadata');
  required(raw, ['name', 'description'], 'metadata');
  return freezeImageRecord({name: text(raw.name, 'metadata.name', 120), description: text(raw.description, 'metadata.description', 2000, true), tags: tags(raw.tags)});
}
export function imageLibraryMetadata(entry) {
  return entry.metadata ?? {name: entry.version.name, description: '', tags: entry.version.tags};
}
export function normalizeImageAssetDraft(raw, decodedImageInfo) {
  keys(raw, DRAFT_FIELDS, 'draft'); record(decodedImageInfo, 'decodedImageInfo');
  const {maxDimension, maxPixels, maxBytes, maxCells} = IMAGE_ASSET_LIMITS;
  const widthPixels = integer(decodedImageInfo.width, 'image.width', 1, maxDimension);
  const heightPixels = integer(decodedImageInfo.height, 'image.height', 1, maxDimension);
  const byteLength = integer(decodedImageInfo.byteLength, 'image.byteLength', 1, maxBytes);
  if (widthPixels * heightPixels > maxPixels) fail('image.pixels', 'Image exceeds the decoded pixel limit');
  if (decodedImageInfo.mediaType !== 'image/png') fail('image.mediaType', 'Only fully validated PNG images are supported', 'UNSUPPORTED_IMAGE_FORMAT');
  const physical = {};
  if (own(raw, 'widthMetres') || own(raw, 'heightMetres')) {
    for (const key of ['widthMetres', 'heightMetres']) physical[key] = finite(raw[key], `draft.${key}`, IMAGE_ASSET_LIMITS.minMetres, IMAGE_ASSET_LIMITS.maxMetres);
  }
  const name = text(raw.name, 'draft.name', IMAGE_ASSET_LIMITS.maxName);
  const depthPreset = raw.depthPreset === undefined ? 'standing' : raw.depthPreset;
  if (!['standing', 'floor', 'custom'].includes(depthPreset)) fail('draft.depthPreset', 'Choose standing, floor, or custom', 'UNSUPPORTED_IMAGE_REPRESENTATION');
  const representation = depthPreset === 'floor' ? 'floor' : 'upright';
  if (own(raw, 'representation') && raw.representation !== representation) fail('draft.representation', 'Representation must match the depth preset', 'UNSUPPORTED_IMAGE_REPRESENTATION');
  const depthPivot = depthPreset === 'custom' ? finite(raw.depthPivot, 'draft.depthPivot', 0, 1) : depthPreset === 'standing' ? 1 : 0.5;
  if (own(raw, 'depthPivot') && raw.depthPivot !== depthPivot) fail('draft.depthPivot', 'This preset has a fixed pivot');
  const floating = raw.floating === undefined ? true : raw.floating;
  if (typeof floating !== 'boolean') fail('draft.floating', 'Floating must be true or false');
  let collisionGrid = null;
  if (raw.collisionGrid !== undefined && raw.collisionGrid !== null) {
    if (floating) fail('draft.collisionGrid', 'Floating image objects cannot have a collision grid');
    if (widthPixels % 32 || heightPixels % 32) fail('draft.collisionGrid', 'Colliding images require width and height to be multiples of 32 pixels');
    const rows = heightPixels / 32, columns = widthPixels / 32;
    if (rows * columns > maxCells || !Array.isArray(raw.collisionGrid) || raw.collisionGrid.length !== rows) fail('draft.collisionGrid', `Collision grid must have exactly ${rows} rows`);
    collisionGrid = [];
    for (let row = 0; row < rows; row++) {
      const cells = raw.collisionGrid[row];
      if (!Array.isArray(cells) || cells.length !== columns) fail(`draft.collisionGrid.${row}`, `Collision row must have exactly ${columns} cells`);
      const output = [];
      for (let col = 0; col < columns; col++) { if (cells[col] !== 0 && cells[col] !== 1) fail(`draft.collisionGrid.${row}.${col}`, 'Collision cells must be numeric 0 or 1'); output.push(cells[col]); }
      collisionGrid.push(output);
    }
  }
  return freezeImageRecord({...physical, name, tags: tags(raw.tags), representation, depthPreset, depthPivot, floating, collisionGrid, widthPixels, heightPixels, byteLength, mediaType: 'image/png'});
}

/** Setup-only changes inherit validated image dimensions and definition floating mode. */
export function normalizeImageAssetSetup(raw, sourceVersion) {
  const fields = ['depthPreset', 'depthPivot', 'collisionGrid'];
  keys(raw, [...fields, 'widthMetres', 'heightMetres'], 'setup'); required(raw, fields, 'setup');
  record(sourceVersion, 'sourceVersion');
  const normalized = normalizeImageAssetDraft({name: sourceVersion.name, tags: sourceVersion.tags, floating: sourceVersion.floating, ...(Object.hasOwn(raw, 'widthMetres') || Object.hasOwn(raw, 'heightMetres') ? {} : Object.hasOwn(sourceVersion, 'widthMetres') ? imagePhysicalSize(sourceVersion) : {}), ...raw},
    {width: sourceVersion.widthPixels, height: sourceVersion.heightPixels, byteLength: sourceVersion.byteLength, mediaType: sourceVersion.mediaType});
  return freezeImageRecord({...(Object.hasOwn(normalized, 'widthMetres') ? imagePhysicalSize(normalized) : {}), representation: normalized.representation, depthPreset: normalized.depthPreset, depthPivot: normalized.depthPivot, collisionGrid: normalized.collisionGrid});
}

export function validateAssetReference(raw) {
  keys(raw, ['assetId', 'versionId'], 'assetRef');
  return freezeImageRecord({assetId: id(raw.assetId, 'assetRef.assetId'), versionId: id(raw.versionId, 'assetRef.versionId')});
}
const DEFINITION_FIELDS = ['schemaVersion', 'assetId', 'roomId', 'createdBy', 'createdAt', 'originKind', 'provenance'];
const VERSION_FIELDS = [...DRAFT_FIELDS, 'widthPixels', 'heightPixels', 'byteLength', 'mediaType', 'schemaVersion', 'assetId', 'roomId', 'versionId', 'sequence', 'sha256', 'createdBy', 'createdAt'];
export function validateImageDefinition(definition, version) {
  keys(definition, DEFINITION_FIELDS, 'definition'); keys(version, VERSION_FIELDS, 'version');
  required(definition, DEFINITION_FIELDS.filter(key => key !== 'provenance'), 'definition'); required(version, VERSION_FIELDS.filter(key => !['widthMetres', 'heightMetres'].includes(key)), 'version');
  if (definition.schemaVersion !== 1 || version.schemaVersion !== 1) fail('schemaVersion', 'Unsupported image asset schema version', 'UNSUPPORTED_IMAGE_SCHEMA');
  if (definition.originKind !== 'upload') fail('definition.originKind', 'Only room-uploaded image objects are supported', 'UNSUPPORTED_IMAGE_ORIGIN');
  const def = {schemaVersion: 1, assetId: id(definition.assetId, 'definition.assetId'), roomId: id(definition.roomId, 'definition.roomId'), createdBy: id(definition.createdBy, 'definition.createdBy'), createdAt: date(definition.createdAt, 'definition.createdAt'), originKind: 'upload'};
  if (definition.provenance !== undefined) {
    keys(definition.provenance, ['attribution', 'source', 'license'], 'definition.provenance');
    def.provenance = {};
    for (const key of Object.keys(definition.provenance)) def.provenance[key] = text(definition.provenance[key], `definition.provenance.${key}`, 2000, true);
  }
  if (version.assetId !== def.assetId || version.roomId !== def.roomId) fail('version.assetId', 'Version must belong to the same room and definition', 'IMAGE_ASSET_IDENTITY_MISMATCH');
  if (typeof version.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(version.sha256)) fail('version.sha256', 'Version must carry a lowercase SHA-256 digest');
  const draft = {};
  for (const key of DRAFT_FIELDS) if (own(version, key)) draft[key] = version[key];
  const metadata = normalizeImageAssetDraft(draft, {width: version.widthPixels, height: version.heightPixels, byteLength: version.byteLength, mediaType: version.mediaType});
  const ver = {...metadata, schemaVersion: 1, assetId: def.assetId, roomId: def.roomId, versionId: id(version.versionId, 'version.versionId'), sequence: integer(version.sequence, 'version.sequence', 1, Number.MAX_SAFE_INTEGER), sha256: version.sha256, createdBy: id(version.createdBy, 'version.createdBy'), createdAt: date(version.createdAt, 'version.createdAt')};
  return freezeImageRecord({schemaVersion: 1, definition: def, version: ver});
}
const validatedResolved = new WeakSet();
export function validateResolvedImageAsset(raw) {
  if (raw && validatedResolved.has(raw)) return raw;
  keys(raw, ['schemaVersion', 'status', 'definition', 'version', 'metadata', 'revision'], 'resolved');
  if (raw.schemaVersion !== 1) fail('resolved.schemaVersion', 'Unsupported resolved schema', 'UNSUPPORTED_IMAGE_SCHEMA');
  if (!['active', 'archived', 'deleted'].includes(raw.status)) fail('resolved.status', 'An explicit active, archived or deleted status is required');
  const result = freezeImageRecord({...validateImageDefinition(raw.definition, raw.version), status: raw.status,
    ...(raw.metadata === undefined ? {} : {metadata: normalizeImageLibraryMetadata(raw.metadata)}),
    ...(raw.revision === undefined ? {} : {revision: integer(raw.revision, 'resolved.revision', 1, Number.MAX_SAFE_INTEGER)})});
  validatedResolved.add(result); return result;
}
export function canUseImageReference(reference, resolved) {
  try { const ref = validateAssetReference(reference), value = validateResolvedImageAsset(resolved); return value.status === 'active' && ref.assetId === value.definition.assetId && ref.versionId === value.version.versionId; }
  catch (error) { if (error instanceof ImageAssetValidationError) return false; throw error; }
}
/** Geometry/readability only. Archived references never authorize a new instance. */
export function canRenderImageReference(reference, resolved) {
  try { const ref = validateAssetReference(reference), value = validateResolvedImageAsset(resolved); return ['active', 'archived'].includes(value.status) && ref.assetId === value.definition.assetId && ref.versionId === value.version.versionId; }
  catch (error) { if (error instanceof ImageAssetValidationError) return false; throw error; }
}
export function normalizeImageRotation(value = 0) {
  if (!Number.isSafeInteger(value) || value % 90 !== 0) fail('instance.rotation', 'Image objects support quarter-turn rotations only', 'UNSUPPORTED_IMAGE_ROTATION');
  return ((value % 360) + 360) % 360;
}
function jsonCopy(value, field, state = {nodes: 0, characters: 0}, depth = 0) {
  if (++state.nodes > 4096 || depth > 16) fail(field, 'Instance actions exceed the bounded JSON limit');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') { state.characters += value.length; if (value.length > 16384 || state.characters > 65536) fail(field, 'Instance actions exceed the text budget'); return value; }
  if (typeof value === 'number') return finite(value, field, -Number.MAX_VALUE, Number.MAX_VALUE);
  if (Array.isArray(value)) return Array.from(value, (child, index) => jsonCopy(child, `${field}.${index}`, state, depth + 1));
  record(value, field); const result = {};
  for (const [key, child] of Object.entries(value)) { state.characters += key.length; if (key.length > 1024 || state.characters > 65536) fail(field, 'Instance actions exceed the text budget'); if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(field, 'Unsafe JSON key'); result[key] = jsonCopy(child, `${field}.${key}`, state, depth + 1); }
  return result;
}
export function validateImageInstance(raw) {
  keys(raw, ['id', 'type', 'assetRef', 'x', 'z', 'rotation', 'name', 'actions'], 'instance');
  if (raw.type !== 'image') fail('instance.type', 'Expected an image object');
  const result = {id: id(raw.id, 'instance.id'), type: 'image', assetRef: validateAssetReference(raw.assetRef), x: finite(raw.x, 'instance.x', -IMAGE_ASSET_LIMITS.maxCoordinate, IMAGE_ASSET_LIMITS.maxCoordinate), z: finite(raw.z, 'instance.z', -IMAGE_ASSET_LIMITS.maxCoordinate, IMAGE_ASSET_LIMITS.maxCoordinate), rotation: normalizeImageRotation(raw.rotation)};
  if (own(raw, 'name')) result.name = text(raw.name, 'instance.name', 120, true);
  if (own(raw, 'actions')) { if (!Array.isArray(raw.actions) || raw.actions.length > 100) fail('instance.actions', 'Actions must be an array of at most 100 items'); result.actions = jsonCopy(raw.actions, 'instance.actions'); }
  return freezeImageRecord(result);
}
