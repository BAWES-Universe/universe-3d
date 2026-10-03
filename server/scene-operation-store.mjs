export const MAX_SCENE_REPLAY_BYTES = 1024 * 1024;

/** Scene-only journal, independent of durable actor/operation identity tombstones.
 * Triggers cover legacy PUT and personal-area scene writers as well as batches. */
export function migrateSceneOperations(store) {
 store.transaction(()=>{
  store.db.exec(`
   CREATE TABLE IF NOT EXISTS scene_operation_receipts (
    actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL, room_id TEXT NOT NULL,
    request_hash TEXT NOT NULL, applied_revision INTEGER NOT NULL,
    protocol_version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(actor_id,operation_id)
   );
   CREATE TABLE IF NOT EXISTS scene_operation_journal (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL, scene TEXT NOT NULL,
    PRIMARY KEY(room_id,revision)
   );
   CREATE TRIGGER IF NOT EXISTS scene_operation_journal_insert AFTER INSERT ON rooms BEGIN
    INSERT INTO scene_operation_journal(room_id,revision,scene) VALUES(NEW.id,NEW.revision,NEW.scene);
   END;
   CREATE TRIGGER IF NOT EXISTS scene_operation_journal_update AFTER UPDATE OF revision ON rooms WHEN NEW.revision>OLD.revision BEGIN
    INSERT INTO scene_operation_journal(room_id,revision,scene) VALUES(NEW.id,NEW.revision,NEW.scene);
    DELETE FROM scene_operation_journal WHERE room_id=NEW.id AND revision NOT IN
     (SELECT revision FROM scene_operation_journal WHERE room_id=NEW.id ORDER BY revision DESC LIMIT 64);
   END;
   INSERT OR IGNORE INTO scene_operation_journal(room_id,revision,scene) SELECT id,revision,scene FROM rooms;
  `);
  // Existing durable v1 identities keep their original hash and receipt version.
  if(!store.all('PRAGMA table_info(scene_operation_receipts)').some(column=>column.name==='protocol_version'))store.db.exec('ALTER TABLE scene_operation_receipts ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1');
 });
}

export function replaySceneOperations(store,roomId,userId,after) {
 // Authorization is deliberately performed before looking up historical rows.
 const {row}=store.authorize(roomId,userId),room=store.room(row,userId);
 // Current visibility does not grant historical disclosure: a public guest or
 // scoped owner may have arrived only after private text/assets were removed.
 // Full room editors can reconcile history; other readers receive current state.
 if(!room.capabilities.canEditScene)return {room,after,cursor:room.revision,mode:'snapshot',snapshots:[{revision:room.revision,scene:room.scene}]};
 // Check cardinality and UTF-8 bytes in SQLite before materializing historical
 // scene strings. A contiguous but large history resets explicitly, never as a
 // misleading partial replay. The current authorized projection remains separate.
 const budget=store.get('SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(scene AS BLOB))),0) AS bytes FROM scene_operation_journal WHERE room_id=? AND revision>? AND revision<=?',roomId,after,room.revision);
 const complete=after<=room.revision&&budget.count===room.revision-after&&budget.bytes<=MAX_SCENE_REPLAY_BYTES;
 const snapshots=complete?store.all('SELECT revision,scene FROM scene_operation_journal WHERE room_id=? AND revision>? AND revision<=? ORDER BY revision',roomId,after,room.revision).map(entry=>({revision:entry.revision,scene:JSON.parse(entry.scene)})):[{revision:room.revision,scene:room.scene}];
 return {room,after,cursor:room.revision,mode:complete?'replay':'snapshot',snapshots};
}
