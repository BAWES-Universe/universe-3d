import { createHash } from 'node:crypto';
import { DIGEST, SHA, requireGate } from './contracts.mjs';

// This trusted, self-contained protocol is deliberately not imported from the
// selected application. The host code fingerprint covers every dependency here.
export const IMAGE_READER_PATH = 'server/image-protocol-capabilities.json';
export const IMAGE_SIZE_CAPABILITY = 'image-physical-size-v1';
export const IMAGE_FLOOR_KEY = 'image_physical_size_protocol_floor';
export const FURNITURE_CAPABILITY = 'composition-furniture-v1';
export const FURNITURE_FLOOR_TABLE = 'room_furniture_protocol_floor';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const capabilities = new Set([IMAGE_SIZE_CAPABILITY, FURNITURE_CAPABILITY]);
const known = value => Array.isArray(value) && value.every(item => capabilities.has(item)) && new Set(value).size === value.length;
export function assertStorageRequirements(storage) {
  requireGate(object(storage) && storage.version === 1 && known(storage.requiredReaderCapabilities) && Object.keys(storage).every(key => ['version', 'requiredReaderCapabilities'].includes(key)), 'IMAGE_STORAGE_REQUIREMENT_INVALID');
  return storage;
}
export function assertReaderCompatible(storage, descriptor) {
  assertStorageRequirements(storage);
  requireGate(descriptor !== undefined && descriptor !== null, 'IMAGE_READER_DESCRIPTOR_MISSING');
  requireGate(object(descriptor) && descriptor.version === 1 && known(descriptor.readerCapabilities) && Object.keys(descriptor).every(key => ['version', 'readerCapabilities'].includes(key)), 'IMAGE_READER_DESCRIPTOR_INVALID');
  requireGate(storage.requiredReaderCapabilities.every(capability => descriptor.readerCapabilities.includes(capability)), 'IMAGE_READER_CAPABILITY_MISSING');
  return descriptor;
}
export const descriptorBlobSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
export function reviewedReader(policy, target, evidence) {
  requireGate(DIGEST.test(target.digest) && SHA.test(target.sha) && SHA.test(target.tree), 'IMAGE_READER_TARGET_INVALID');
  requireGate(evidence && ['digest', 'sha', 'tree'].every(key => evidence[key] === target[key]) && evidence.path === IMAGE_READER_PATH && SHA.test(evidence.blobSha), 'IMAGE_READER_EVIDENCE_MISMATCH');
  assertReaderCompatible({ version: 1, requiredReaderCapabilities: [] }, evidence.descriptor);
  const matches = (policy.imageReaderCompatibility ?? []).filter(row => row.digest === target.digest && row.sha === target.sha && row.tree === target.tree);
  requireGate(matches.length === 1 && matches[0].reviewId && matches[0].descriptorBlobSha === evidence.blobSha, 'IMAGE_READER_REVIEW_MISSING');
  const review = matches[0];
  assertStorageRequirements(review.possibleStorageRequirements);
  // Treat all declared capabilities as potentially persisted, even if a review
  // claims a process flag is off. Startup can advance the floor before any row.
  const possible = mergeRequirements(review.possibleStorageRequirements, { version: 1, requiredReaderCapabilities: evidence.descriptor.readerCapabilities });
  assertReaderCompatible(possible, evidence.descriptor);
  return { descriptor: evidence.descriptor, possible, reviewId: review.reviewId, blobSha: evidence.blobSha };
}
export function mergeRequirements(...requirements) {
  requirements.forEach(assertStorageRequirements);
  return { version: 1, requiredReaderCapabilities: [...new Set(requirements.flatMap(value => value.requiredReaderCapabilities))].sort() };
}
export function assertReaderTransition(storage, candidate, previous) {
  const resulting = mergeRequirements(storage, candidate.possible, previous.possible);
  assertReaderCompatible(resulting, candidate.descriptor);
  assertReaderCompatible(resulting, previous.descriptor);
  return resulting;
}
// Caller holds one read-only SQLite snapshot, shared with schema observation.
// An old binary does not become safe merely because a marker is present. The
// historical image-named interface also covers persisted composition furniture.
export function observeImageStorage(db) {
  const table = name => db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
  const floor = table('metadata') && db.prepare('SELECT value FROM metadata WHERE key=?').all(IMAGE_FLOOR_KEY);
  requireGate(!floor || floor.length <= 1 && floor.every(row => row.value === IMAGE_SIZE_CAPABILITY), 'IMAGE_STORAGE_REQUIREMENT_INVALID');
  let sized = false;
  if (table('room_image_asset_versions')) {
    requireGate(!db.prepare('SELECT 1 FROM room_image_asset_versions WHERE json_valid(version_json)=0 LIMIT 1').get(), 'IMAGE_STORAGE_REQUIREMENT_INVALID');
    sized = !!db.prepare("SELECT 1 FROM room_image_asset_versions WHERE json_type(version_json,'$.widthMetres') IS NOT NULL OR json_type(version_json,'$.heightMetres') IS NOT NULL LIMIT 1").get();
  }
  let furniture = false;
  if (table(FURNITURE_FLOOR_TABLE)) {
    requireGate(!db.prepare('SELECT 1 FROM room_furniture_protocol_floor WHERE capability IS NULL OR capability!=? LIMIT 1').get(FURNITURE_CAPABILITY), 'IMAGE_STORAGE_REQUIREMENT_INVALID');
    furniture = !!db.prepare('SELECT 1 FROM room_furniture_protocol_floor LIMIT 1').get();
  }
  if (table('rooms')) {
    requireGate(!db.prepare('SELECT 1 FROM rooms WHERE scene IS NULL OR json_valid(scene)=0 LIMIT 1').get(), 'IMAGE_STORAGE_REQUIREMENT_INVALID');
    // Read persisted placements even if an older writer omitted the marker.
    // CASE avoids applying json_extract to scalar strings from a malformed
    // object list; malformed JSON itself has already failed closed above.
    furniture ||= !!db.prepare("SELECT 1 FROM rooms, json_each(rooms.scene, '$.objects') AS object WHERE CASE WHEN object.type='object' THEN json_extract(object.value,'$.type') END=? LIMIT 1").get('composition');
  }
  return { version: 1, requiredReaderCapabilities: [
    ...(floor?.length || sized ? [IMAGE_SIZE_CAPABILITY] : []),
    ...(furniture ? [FURNITURE_CAPABILITY] : [])
  ].sort() };
}
