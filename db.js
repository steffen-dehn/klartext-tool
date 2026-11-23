// Datenhaltung. Bewusst gespeichert wird NICHT: IP, User-Agent, Geräte-ID,
// Zeitstempel pro Beitrag, Eingangsreihenfolge.
// - Beiträge haben eine zufällige ID und einen zufälligen Sortierschlüssel.
// - WITHOUT ROWID: SQLite vergibt sonst eine fortlaufende rowid, aus der sich
//   die Reihenfolge des Eingangs ablesen ließe.
// - secure_delete: gelöschte Inhalte werden auf der Platte überschrieben.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const file = process.env.DB_PATH || './data/klartext.db';
if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec(`
  PRAGMA journal_mode = DELETE;
  PRAGMA secure_delete = ON;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    question TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'collect',
    version INTEGER NOT NULL DEFAULT 1,
    focus_cluster TEXT,
    votes_per_person INTEGER NOT NULL DEFAULT 3,
    created_day TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS clusters (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    position INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    wahrnehmung TEXT NOT NULL,
    wirkung TEXT NOT NULL DEFAULT '',
    wunsch TEXT NOT NULL DEFAULT '',
    cluster_id TEXT REFERENCES clusters(id) ON DELETE SET NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    sort_key REAL NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS ballots (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    allocations TEXT NOT NULL,
    PRIMARY KEY (session_id, token)
  ) WITHOUT ROWID;
`);

export const newId = (bytes = 9) => randomBytes(bytes).toString('base64url');
// Kurze, gut abtippbare Session-ID für QR-Code und Beamer-Link
export const newSessionId = () => {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(randomBytes(8), (b) => abc[b % abc.length]).join('');
};

export const q = {
  all: (sql, ...p) => db.prepare(sql).all(...p),
  get: (sql, ...p) => db.prepare(sql).get(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};

export const bump = (sessionId) =>
  q.run('UPDATE sessions SET version = version + 1 WHERE id = ?', sessionId);

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Sessions werden nach RETENTION_DAYS automatisch vollständig gelöscht.
export function purgeOld(days = Number(process.env.RETENTION_DAYS || 30)) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  return q.run('DELETE FROM sessions WHERE created_day < ?', cutoff).changes;
}
