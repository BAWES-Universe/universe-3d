/**
 * Dedicated image tables. Call initialization explicitly against an approved DB.
 * The host owns users/rooms and provides live authorization to the service.
 * Importing this file opens no DB and never touches the application's database.
 */
export function initializeImageAssetSchema(db) {
  if (!db.prepare('PRAGMA foreign_keys').get().foreign_keys) throw new Error('Image assets require SQLite foreign_keys=ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_image_assets (
      room_id TEXT NOT NULL, asset_id TEXT NOT NULL,
      definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
      current_version_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      deleted_at TEXT,
      metadata_json TEXT CHECK(metadata_json IS NULL OR json_valid(metadata_json)),
      archived_at TEXT,
      PRIMARY KEY(room_id,asset_id),
      CHECK(json_extract(definition_json,'$.roomId') IS room_id),
      CHECK(json_extract(definition_json,'$.assetId') IS asset_id),
      FOREIGN KEY(room_id,asset_id,current_version_id)
        REFERENCES room_image_asset_versions(room_id,asset_id,version_id)
        DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE IF NOT EXISTS room_image_asset_versions (
      room_id TEXT NOT NULL, asset_id TEXT NOT NULL, version_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(sequence > 0),
      version_json TEXT NOT NULL CHECK(json_valid(version_json)),
      sha256 TEXT NOT NULL CHECK(length(sha256)=64),
      byte_length INTEGER NOT NULL CHECK(byte_length > 0 AND byte_length <= 5242880),
      bytes BLOB NOT NULL CHECK(length(bytes)=byte_length),
      PRIMARY KEY(room_id,asset_id,version_id),
      UNIQUE(room_id,asset_id,sequence),
      FOREIGN KEY(room_id,asset_id) REFERENCES room_image_assets(room_id,asset_id)
        DEFERRABLE INITIALLY DEFERRED,
      CHECK(json_extract(version_json,'$.roomId') IS room_id),
      CHECK(json_extract(version_json,'$.assetId') IS asset_id),
      CHECK(json_extract(version_json,'$.versionId') IS version_id),
      CHECK(json_extract(version_json,'$.sequence') IS sequence),
      CHECK(json_extract(version_json,'$.sha256') IS sha256),
      CHECK(json_extract(version_json,'$.byteLength') IS byte_length),
      CHECK(json_extract(version_json,'$.mediaType') IS 'image/png')
    );
    CREATE TABLE IF NOT EXISTS room_image_asset_operations (
      room_id TEXT NOT NULL, user_id TEXT NOT NULL, operation_id TEXT NOT NULL,
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
      asset_id TEXT NOT NULL, version_id TEXT NOT NULL,
      PRIMARY KEY(room_id,user_id,operation_id),
      FOREIGN KEY(room_id,asset_id,version_id)
        REFERENCES room_image_asset_versions(room_id,asset_id,version_id)
        DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TRIGGER IF NOT EXISTS image_version_immutable_update
      BEFORE UPDATE ON room_image_asset_versions BEGIN SELECT RAISE(ABORT,'Image versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS image_version_immutable_delete
      BEFORE DELETE ON room_image_asset_versions BEGIN SELECT RAISE(ABORT,'Retain image versions for recoverable history'); END;
    CREATE TRIGGER IF NOT EXISTS image_definition_immutable
      BEFORE UPDATE OF room_id,asset_id,definition_json ON room_image_assets
      BEGIN SELECT RAISE(ABORT,'Image definition identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS image_definition_retained
      BEFORE DELETE ON room_image_assets BEGIN SELECT RAISE(ABORT,'Tombstone image definitions instead of deleting'); END;
    CREATE TRIGGER IF NOT EXISTS image_version_sequence
      BEFORE INSERT ON room_image_asset_versions
      WHEN NEW.sequence != COALESCE((SELECT MAX(sequence)+1 FROM room_image_asset_versions WHERE room_id=NEW.room_id AND asset_id=NEW.asset_id),1)
      BEGIN SELECT RAISE(ABORT,'Image version sequence must be consecutive'); END;
    CREATE TRIGGER IF NOT EXISTS image_floating_immutable
      BEFORE INSERT ON room_image_asset_versions
      WHEN EXISTS(SELECT 1 FROM room_image_asset_versions WHERE room_id=NEW.room_id AND asset_id=NEW.asset_id AND json_extract(version_json,'$.floating') IS NOT json_extract(NEW.version_json,'$.floating'))
      BEGIN SELECT RAISE(ABORT,'Floating mode requires a new image definition'); END;
  `);
  // Existing immutable definitions/versions stay untouched. Nullable additions
  // preserve legacy rows and give reads a well-defined display fallback.
  const nested = db.isTransaction;
  db.exec(nested ? 'SAVEPOINT image_asset_schema_migration' : 'BEGIN IMMEDIATE');
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(room_image_assets)').all().map(column => column.name));
    if (!columns.has('metadata_json')) db.exec('ALTER TABLE room_image_assets ADD COLUMN metadata_json TEXT CHECK(metadata_json IS NULL OR json_valid(metadata_json))');
    if (!columns.has('archived_at')) db.exec('ALTER TABLE room_image_assets ADD COLUMN archived_at TEXT');
    db.exec(nested ? 'RELEASE image_asset_schema_migration' : 'COMMIT');
  } catch (error) {
    db.exec(nested ? 'ROLLBACK TO image_asset_schema_migration; RELEASE image_asset_schema_migration' : 'ROLLBACK');
    throw error;
  }
}

const COLUMNS = 'a.definition_json,a.deleted_at,a.archived_at,a.metadata_json,a.revision,v.version_json';
function unpack(row) {
  if (!row) return null;
  const version = JSON.parse(row.version_json);
  return { schemaVersion: 1, status: row.deleted_at !== null ? 'deleted' : row.archived_at !== null ? 'archived' : 'active', revision: row.revision, metadata: row.metadata_json === null ? { name: version.name, description: '', tags: version.tags } : JSON.parse(row.metadata_json), definition: JSON.parse(row.definition_json), version };
}
export function createImageAssetRepository(db) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('A host-owned SQLite DatabaseSync is required');
  let savepoint = 0;
  return Object.freeze({
    get inTransaction() { return db.isTransaction; },
    // Nested use is a savepoint in the SAME connection, never a second DB.
    transaction(fn) {
      const nested = db.isTransaction, name = `image_assets_${++savepoint}`;
      db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
      try {
        const result = fn();
        if (result && typeof result.then === 'function') throw new TypeError('SQLite image transactions must be synchronous');
        db.exec(nested ? `RELEASE ${name}` : 'COMMIT');
        return result;
      } catch (error) {
        db.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK');
        throw error;
      }
    },
    list(roomId, { status = 'active' } = {}) {
      if (!['active', 'archived'].includes(status)) throw new TypeError('Invalid image library status');
      return db.prepare(`SELECT ${COLUMNS} FROM room_image_assets a JOIN room_image_asset_versions v ON v.room_id=a.room_id AND v.asset_id=a.asset_id AND v.version_id=a.current_version_id WHERE a.room_id=? AND a.deleted_at IS NULL AND a.archived_at IS ${status === 'active' ? '' : 'NOT '}NULL ORDER BY json_extract(a.definition_json,'$.createdAt'),a.asset_id`).all(roomId).map(unpack);
    },
    getCurrent(roomId, assetId) {
      return unpack(db.prepare(`SELECT ${COLUMNS} FROM room_image_assets a JOIN room_image_asset_versions v ON v.room_id=a.room_id AND v.asset_id=a.asset_id AND v.version_id=a.current_version_id WHERE a.room_id=? AND a.asset_id=?`).get(roomId, assetId));
    },
    updateLifecycle({ roomId, assetId, expectedRevision, metadata, status, archivedAt }) {
      if (!db.isTransaction) throw new Error('Asset lifecycle changes require a transaction');
      const result = metadata !== undefined
        ? db.prepare('UPDATE room_image_assets SET metadata_json=?,revision=revision+1 WHERE room_id=? AND asset_id=? AND revision=? AND deleted_at IS NULL').run(JSON.stringify(metadata), roomId, assetId, expectedRevision)
        : db.prepare('UPDATE room_image_assets SET archived_at=?,revision=revision+1 WHERE room_id=? AND asset_id=? AND revision=? AND deleted_at IS NULL').run(status === 'archived' ? archivedAt : null, roomId, assetId, expectedRevision);
      return result.changes === 1;
    },
    getVersion(roomId, assetId, versionId) {
      return unpack(db.prepare(`SELECT ${COLUMNS} FROM room_image_assets a JOIN room_image_asset_versions v ON v.room_id=a.room_id AND v.asset_id=a.asset_id WHERE a.room_id=? AND a.asset_id=? AND v.version_id=?`).get(roomId, assetId, versionId));
    },
    getBytes(roomId, assetId, versionId) {
      const row = db.prepare('SELECT bytes FROM room_image_asset_versions WHERE room_id=? AND asset_id=? AND version_id=?').get(roomId, assetId, versionId);
      return row ? Buffer.from(row.bytes) : null;
    },
    getOperation(roomId, userId, operationId) {
      const row = db.prepare('SELECT request_digest,asset_id,version_id FROM room_image_asset_operations WHERE room_id=? AND user_id=? AND operation_id=?').get(roomId, userId, operationId);
      return row ? { digest: row.request_digest, assetId: row.asset_id, versionId: row.version_id } : null;
    },
    usage(roomId) {
      return { definitions: db.prepare('SELECT count(*) AS count FROM room_image_assets WHERE room_id=?').get(roomId).count,
        bytes: db.prepare('SELECT coalesce(sum(byte_length),0) AS count FROM room_image_asset_versions WHERE room_id=?').get(roomId).count };
    },
    insertCreated({ entry, bytes, userId, operationId, digest }) {
      if (!db.isTransaction) throw new Error('Asset insertion requires a transaction');
      const { definition: definition, version } = entry;
      db.prepare('INSERT INTO room_image_assets(room_id,asset_id,definition_json,current_version_id,metadata_json) VALUES(?,?,?,?,?)').run(definition.roomId, definition.assetId, JSON.stringify(definition), version.versionId, JSON.stringify(entry.metadata));
      db.prepare('INSERT INTO room_image_asset_versions(room_id,asset_id,version_id,sequence,version_json,sha256,byte_length,bytes) VALUES(?,?,?,?,?,?,?,?)').run(definition.roomId, definition.assetId, version.versionId, version.sequence, JSON.stringify(version), version.sha256, version.byteLength, bytes);
      db.prepare('INSERT INTO room_image_asset_operations(room_id,user_id,operation_id,request_digest,asset_id,version_id) VALUES(?,?,?,?,?,?)').run(definition.roomId, userId, operationId, digest, definition.assetId, version.versionId);
    },
  });
}
