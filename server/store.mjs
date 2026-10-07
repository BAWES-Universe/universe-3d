import {initializePublicGuests,publicGuestMethods} from './public-guests.mjs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {normalizeAppearance} from '../src/avatar-spec.js';
import {migrateHierarchy,hierarchyMethods} from './hierarchy-store.mjs';
import {migratePersonalAreas,personalAreaMethods} from './personal-area-store.mjs';
import {migrateSceneOperations} from './scene-operation-store.mjs';

export class Store {
  constructor(filename, seeds = [], now = Date.now, {claimUnownedOnCreate = true} = {}) {
    this.now=now;
    this.claimUnownedOnCreate=!!claimUnownedOnCreate;
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    // WAL selection/recovery can contend with another opening process too.
    // Install the existing bounded wait policy before selecting the journal mode.
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,name TEXT NOT NULL,woka TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'online',created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY COLLATE NOCASE,email TEXT COLLATE NOCASE UNIQUE,user_id TEXT NOT NULL UNIQUE REFERENCES users(id),salt TEXT NOT NULL,password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worlds (id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_id TEXT REFERENCES users(id),public INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY,world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,name TEXT NOT NULL,owner_id TEXT REFERENCES users(id),public INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 0,scene TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL,current_room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL);
      CREATE TABLE IF NOT EXISTS members (room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL DEFAULT 'member',muted_until INTEGER NOT NULL DEFAULT 0,banned INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(room_id,user_id));
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),text TEXT NOT NULL,created_at INTEGER NOT NULL,edited_at INTEGER,deleted INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS message_room_time ON messages(room_id,created_at);
      CREATE TABLE IF NOT EXISTS reactions (message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),emoji TEXT NOT NULL,PRIMARY KEY(message_id,user_id,emoji));
      CREATE TABLE IF NOT EXISTS direct_messages (id TEXT PRIMARY KEY,sender_id TEXT NOT NULL REFERENCES users(id),recipient_id TEXT NOT NULL REFERENCES users(id),text TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS dm_participants ON direct_messages(sender_id,recipient_id,created_at);
      CREATE TABLE IF NOT EXISTS invites (token_hash TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
    for (const table of ['messages','direct_messages']) {
      if (!this.all(`PRAGMA table_info(${table})`).some(c => c.name === 'client_operation_id')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN client_operation_id TEXT`);
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS message_idempotency ON messages(user_id,client_operation_id) WHERE client_operation_id IS NOT NULL; CREATE UNIQUE INDEX IF NOT EXISTS dm_idempotency ON direct_messages(sender_id,client_operation_id) WHERE client_operation_id IS NOT NULL;');
    // Seed once only: renamed/deleted rooms are never resurrected on restart.
    if (!this.get('SELECT value FROM metadata WHERE key=?', 'seeded')) this.transaction(() => {
      for (const world of seeds) {
        this.run('INSERT INTO worlds(id,name,created_at) VALUES(?,?,?)', world.id, world.name, Date.now());
        for (const room of world.rooms || []) this.run('INSERT INTO rooms(id,world_id,name,scene,created_at) VALUES(?,?,?,?,?)', room.id, world.id, room.name, JSON.stringify(room.scene), Date.now());
      }
      this.run('INSERT INTO metadata(key,value) VALUES(?,?)', 'seeded', '1');
    });
    initializePublicGuests(this);
    migrateHierarchy(this);
    migratePersonalAreas(this);
    migrateSceneOperations(this);
  }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  user(id) { const row = this.publicGuestProfiles.get(id)??this.get('SELECT u.*,a.username FROM users u LEFT JOIN accounts a ON a.user_id=u.id WHERE u.id=?', id); return row && { id: row.id, name: row.name, woka: JSON.parse(row.woka), appearance: normalizeAppearance(JSON.parse(row.woka)), status: row.status, account: !!row.username, username: row.username || null, ...(this.isPublicGuest(id)?{ephemeralGuest:true}:{}) }; }
  createUser(name, woka) {
    const userId = randomUUID();
    this.transaction(() => {
      this.run('INSERT INTO users(id,name,woka,created_at) VALUES(?,?,?,?)', userId, name, woka, Date.now());
      if(this.claimUnownedOnCreate){
        this.run('UPDATE worlds SET owner_id=? WHERE owner_id IS NULL', userId);
        this.run('UPDATE rooms SET owner_id=? WHERE owner_id IS NULL', userId);
        this.claimUnowned(userId);
      }
    });
    return this.user(userId);
  }
  membership(roomId, userId) { if(this.isPublicGuest(userId))return this.publicGuestModeration.get(`${roomId}:${userId}`);return this.get('SELECT * FROM members WHERE room_id=? AND user_id=?', roomId, userId); }
  message(row, userId) {
    const reactions = {};
    for (const r of this.all('SELECT emoji,user_id FROM reactions WHERE message_id=?',row.id)) (reactions[r.emoji] ||= []).push(r.user_id);
    return { id: row.id, roomId: row.room_id, userId: row.user_id, author: this.user(row.user_id), text: row.deleted ? '' : row.text, createdAt: row.created_at, editedAt: row.edited_at, deleted: !!row.deleted, reactions };
  }
  messages(roomId, userId, before = Number.MAX_SAFE_INTEGER, limit = 100) { return this.all('SELECT * FROM messages WHERE room_id=? AND created_at<? ORDER BY created_at DESC,rowid DESC LIMIT ?', roomId, before, limit).reverse().map(r => this.message(r,userId)); }
  messagesPage(roomId, userId, { before = Number.MAX_SAFE_INTEGER, cursor = null, limit = 100 } = {}) {
    let rows;
    if (cursor) {
      const match = cursor.match(/^(\d+)_(\d+)$/); if (!match) fail(400,'INVALID_CURSOR','Invalid message cursor');
      const timestamp=Number(match[1]),rowid=Number(match[2]);
      if(!Number.isSafeInteger(timestamp)||!Number.isSafeInteger(rowid)) fail(400,'INVALID_CURSOR','Invalid message cursor');
      rows=this.all('SELECT rowid AS sequence,* FROM messages WHERE room_id=? AND (created_at<? OR (created_at=? AND rowid<?)) ORDER BY created_at DESC,rowid DESC LIMIT ?',roomId,timestamp,timestamp,rowid,limit+1);
    } else rows=this.all('SELECT rowid AS sequence,* FROM messages WHERE room_id=? AND created_at<? ORDER BY created_at DESC,rowid DESC LIMIT ?',roomId,before,limit+1);
    const hasMore=rows.length>limit;rows=rows.slice(0,limit);const last=rows.at(-1);
    return {messages:rows.reverse().map(r=>this.message(r,userId)),hasMore,nextCursor:hasMore&&last?`${last.created_at}_${last.sequence}`:null};
  }
  close() { this.publicGuestProfiles.clear();this.publicGuestSessions.clear();this.publicGuestModeration.clear();this.db.close(); }
}

Object.assign(Store.prototype,hierarchyMethods,personalAreaMethods,publicGuestMethods);
