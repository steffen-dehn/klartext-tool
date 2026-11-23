// Datenhaltung über libSQL: lokal eine SQLite-Datei, im Betrieb eine
// gehostete Turso-Datenbank (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN).
//
// Bewusst gespeichert wird NICHT: IP, User-Agent, Geräte-ID,
// Zeitstempel pro Beitrag, Eingangsreihenfolge.
// - Beiträge haben eine zufällige ID und einen zufälligen Sortierschlüssel.
// - WITHOUT ROWID: SQLite vergibt sonst eine fortlaufende rowid, aus der sich
//   die Reihenfolge des Eingangs ablesen ließe.
import { createClient } from '@libsql/client';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const remote = process.env.TURSO_DATABASE_URL;
const file = process.env.DB_PATH || './data/klartext.db';
if (!remote) mkdirSync(dirname(file), { recursive: true });

export const storage = remote ? 'Turso' : `lokale Datei ${file}`;
const client = createClient(
  remote
    ? { url: remote, authToken: process.env.TURSO_AUTH_TOKEN }
    : { url: `file:${file}` },
);

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    question TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'collect',
    version INTEGER NOT NULL DEFAULT 1,
    focus_cluster TEXT,
    votes_per_person INTEGER NOT NULL DEFAULT 3,
    created_day TEXT NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS clusters (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    position INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    wahrnehmung TEXT NOT NULL,
    wirkung TEXT NOT NULL DEFAULT '',
    wunsch TEXT NOT NULL DEFAULT '',
    cluster_id TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    sort_key REAL NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS ballots (
    session_id TEXT NOT NULL,
    token TEXT NOT NULL,
    allocations TEXT NOT NULL,
    PRIMARY KEY (session_id, token)
  ) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS entries_session ON entries (session_id)',
  'CREATE INDEX IF NOT EXISTS clusters_session ON clusters (session_id)',
];

export async function init() {
  if (!remote) {
    // Nur lokal einstellbar: gelöschte Inhalte auf der Platte überschreiben.
    await client.execute('PRAGMA journal_mode = DELETE');
    await client.execute('PRAGMA secure_delete = ON');
  }
  await client.batch(SCHEMA, 'write');
}

export const newId = (bytes = 9) => randomBytes(bytes).toString('base64url');
// Kurze, gut abtippbare Session-ID für QR-Code und Beamer-Link
export const newSessionId = () => {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(randomBytes(8), (b) => abc[b % abc.length]).join('');
};

// Kurzform für ein Statement: st('UPDATE … WHERE id = ?', id)
export const st = (sql, ...args) => ({ sql, args });

export const q = {
  all: async (sql, ...args) => (await client.execute({ sql, args })).rows,
  get: async (sql, ...args) => (await client.execute({ sql, args })).rows[0],
  run: async (sql, ...args) => client.execute({ sql, args }),
  // Mehrere Statements als eine Transaktion: alle oder keines.
  batch: (statements) => client.batch(statements, 'write'),
};

// Löscht eine Session vollständig. Ausdrücklich pro Tabelle, damit nichts
// davon abhängt, ob die Datenbank Fremdschlüssel durchsetzt.
export const deleteSessionStatements = (id) => [
  st('DELETE FROM ballots WHERE session_id = ?', id),
  st('DELETE FROM entries WHERE session_id = ?', id),
  st('DELETE FROM clusters WHERE session_id = ?', id),
  st('DELETE FROM sessions WHERE id = ?', id),
];

// Sessions werden nach RETENTION_DAYS automatisch vollständig gelöscht.
export async function purgeOld(days = Number(process.env.RETENTION_DAYS || 30)) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const old = await q.all('SELECT id FROM sessions WHERE created_day < ?', cutoff);
  for (const s of old) await q.batch(deleteSessionStatements(s.id));
  return old.map((s) => s.id);
}
