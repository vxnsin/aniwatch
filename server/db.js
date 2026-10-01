/**
 * server/db.js – SQLite (node:sqlite) for things that should outlive a restart:
 *   users     – discord user ↔ aniworld profile name
 *   sessions  – our own session tokens (ws auth) ↔ discord user
 *   rooms     – last state of a room (queue, current episode, position) so a restart does not kill the watch party
 *   progress  – per room+episode position (resume)
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'aniwatch.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT, avatar TEXT, aniworld TEXT, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS progress (room_id TEXT NOT NULL, episode_href TEXT NOT NULL, position REAL NOT NULL, duration REAL NOT NULL, finished INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (room_id, episode_href));
`);

const q = {
  upsertUser: db.prepare(`INSERT INTO users (id, name, avatar, aniworld, updated_at) VALUES (?, ?, ?, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar, updated_at = excluded.updated_at`),
  getUser: db.prepare('SELECT * FROM users WHERE id = ?'),
  setAniworld: db.prepare('UPDATE users SET aniworld = ?, updated_at = ? WHERE id = ?'),
  putSession: db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)'),
  getSession: db.prepare('SELECT s.user_id, u.name, u.avatar, u.aniworld FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
  pruneSessions: db.prepare('DELETE FROM sessions WHERE created_at < ?'),
  putRoom: db.prepare('INSERT INTO rooms (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at'),
  getRoom: db.prepare('SELECT json FROM rooms WHERE id = ?'),
  pruneRooms: db.prepare('DELETE FROM rooms WHERE updated_at < ?'),
  putProgress: db.prepare(`INSERT INTO progress (room_id, episode_href, position, duration, finished, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_id, episode_href) DO UPDATE SET position = excluded.position, duration = CASE WHEN excluded.duration > 0 THEN excluded.duration ELSE progress.duration END, finished = MAX(progress.finished, excluded.finished), updated_at = excluded.updated_at`),
  getProgress: db.prepare('SELECT position, duration, finished FROM progress WHERE room_id = ? AND episode_href = ?'),
};

const now = () => Date.now();

module.exports = {
  saveUser(u) {
    q.upsertUser.run(u.id, u.name, u.avatar || null, now());
  },
  getUser(id) {
    return q.getUser.get(id) || null;
  },
  setAniworld(userId, name) {
    q.setAniworld.run(name || null, now(), userId);
  },
  createSession(token, userId) {
    q.putSession.run(token, userId, now());
  },
  getSession(token) {
    return q.getSession.get(token) || null;
  },
  saveRoom(id, json) {
    q.putRoom.run(id, JSON.stringify(json), now());
  },
  loadRoom(id) {
    const r = q.getRoom.get(id);
    try { return r ? JSON.parse(r.json) : null; } catch { return null; }
  },
  saveProgress(roomId, href, position, duration, finished) {
    q.putProgress.run(roomId, href, Math.floor(position || 0), Math.floor(duration || 0), finished ? 1 : 0, now());
  },
  getProgress(roomId, href) {
    return q.getProgress.get(roomId, href) || null;
  },
  housekeeping() {
    q.pruneSessions.run(now() - 30 * 24 * 3600_000);
    q.pruneRooms.run(now() - 14 * 24 * 3600_000);
  },
};
