// Klartext Tool – anonymes 3W-Feedback für moderierte Workshops.
// Der Server schreibt bewusst KEIN Request-Log und liest keine IP-Adressen.
import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { q, st, init, storage, newId, newSessionId, purgeOld, deleteSessionStatements } from './db.js';
import { clusterEntries } from './cluster.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const FONTS = join(ROOT, 'node_modules/@fontsource/poppins/files');
const PORT = Number(process.env.PORT || 3000);

const PHASES = ['collect', 'review', 'reveal', 'vote', 'result'];
const DEFAULT_QUESTION =
  'Darüber sollten wir heute sprechen, auch wenn es niemand auf den Tisch bringen möchte';
const MAX_TEXT = 1000;
const MAX_ENTRIES = 300;
const MIN_FOR_AI = 4;

let PASSWORD = process.env.MODERATOR_PASSWORD;
if (!PASSWORD) {
  PASSWORD = randomBytes(9).toString('base64url');
  console.log(`MODERATOR_PASSWORD nicht gesetzt. Passwort für diesen Lauf: ${PASSWORD}`);
}
const COOKIE_VALUE = createHmac('sha256', PASSWORD).update('klartext-moderator').digest('hex');

// ---------- Hilfsfunktionen ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    ...headers,
  });
  res.end(body);
}
const json = (res, status, obj) =>
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });

async function body(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) {
    fail(415, 'JSON erwartet.');
  }
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 20_000) fail(413, 'Zu groß.');
    chunks.push(c);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {}
  fail(400, 'Ungültiges JSON.');
}

const clean = (v, max = MAX_TEXT) =>
  typeof v === 'string' ? v.replace(/\r/g, '').trim().slice(0, max) : '';

function isModerator(req) {
  const m = /(?:^|;\s*)klartext_mod=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(COOKIE_VALUE);
  return a.length === b.length && timingSafeEqual(a, b);
}

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
async function sendFile(res, dir, name, cache = 'no-cache') {
  const path = normalize(join(dir, name));
  if (!path.startsWith(dir)) fail(404, 'Nicht gefunden.');
  try {
    const data = await readFile(path);
    send(res, 200, data, {
      'Content-Type': MIME[extname(path)] || 'application/octet-stream',
      'Cache-Control': cache,
    });
  } catch {
    fail(404, 'Nicht gefunden.');
  }
}

// ---------- Datenzugriff ----------

const getSession = async (id) =>
  (await q.get('SELECT * FROM sessions WHERE id = ?', id)) || fail(404, 'Session nicht gefunden.');
const count = async (table, id) =>
  (await q.get(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`, id)).n;

async function points(sessionId) {
  const sum = {};
  for (const b of await q.all('SELECT allocations FROM ballots WHERE session_id = ?', sessionId)) {
    for (const [cid, n] of Object.entries(JSON.parse(b.allocations))) {
      sum[cid] = (sum[cid] || 0) + n;
    }
  }
  return sum;
}

const entryView = (e) => ({
  id: e.id,
  wahrnehmung: e.wahrnehmung,
  wirkung: e.wirkung,
  wunsch: e.wunsch,
});

// Cluster mit sichtbaren Beiträgen, Beiträge in zufälliger (stabiler) Reihenfolge
async function visibleClusters(sessionId) {
  const entries = await q.all(
    'SELECT * FROM entries WHERE session_id = ? AND hidden = 0 ORDER BY sort_key',
    sessionId,
  );
  return (await q.all('SELECT * FROM clusters WHERE session_id = ? ORDER BY position', sessionId))
    .map((c) => ({
      id: c.id,
      title: c.title,
      entries: entries.filter((e) => e.cluster_id === c.id).map(entryView),
    }))
    .filter((c) => c.entries.length);
}

// Was Teilnehmende und Beamer sehen dürfen – abhängig von der Phase.
async function publicState(s) {
  const out = {
    id: s.id,
    title: s.title,
    question: s.question,
    phase: s.phase,
    version: s.version,
    votesPerPerson: s.votes_per_person,
    count: await count('entries', s.id),
  };
  if (['reveal', 'vote', 'result'].includes(s.phase)) {
    out.clusters = await visibleClusters(s.id);
    out.focus = out.clusters.some((c) => c.id === s.focus_cluster) ? s.focus_cluster : null;
  }
  if (s.phase === 'vote' || s.phase === 'result') out.ballots = await count('ballots', s.id);
  if (s.phase === 'result') {
    const p = await points(s.id);
    for (const c of out.clusters) c.points = p[c.id] || 0;
  }
  return out;
}

// Zwischenspeicher für den öffentlichen Stand. Alle Geräte fragen alle 2 s nach;
// ohne Änderung kostet das keine Datenbankabfrage. Setzt genau eine laufende
// Instanz voraus (siehe README).
const cache = new Map(); // sessionId → { version, pub }
const generation = new Map();
function touch(id) {
  cache.delete(id);
  generation.set(id, (generation.get(id) || 0) + 1);
}
function forget(id) {
  cache.delete(id);
  generation.delete(id);
}
async function current(id) {
  const hit = cache.get(id);
  if (hit) return hit;
  const g = generation.get(id) || 0;
  const s = await getSession(id);
  const entry = { version: s.version, pub: await publicState(s) };
  // Nur merken, wenn währenddessen nichts geändert wurde.
  if ((generation.get(id) || 0) === g) cache.set(id, entry);
  return entry;
}

const bump = (id) => st('UPDATE sessions SET version = version + 1 WHERE id = ?', id);
// Änderung schreiben: Statements und Versionssprung in einer Transaktion.
async function write(id, ...statements) {
  await q.batch([...statements.flat(), bump(id)]);
  touch(id);
}

async function adminState(s) {
  const out = {
    id: s.id,
    title: s.title,
    question: s.question,
    phase: s.phase,
    version: s.version,
    votesPerPerson: s.votes_per_person,
    createdDay: s.created_day,
    focus: s.focus_cluster,
    count: await count('entries', s.id),
    ballots: await count('ballots', s.id),
    aiAvailable: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    minForAi: MIN_FOR_AI,
  };
  // Während der Sammlung sieht auch der Moderator keine Inhalte.
  if (s.phase !== 'collect') {
    out.clusters = (await q.all(
      'SELECT id, title FROM clusters WHERE session_id = ? ORDER BY position', s.id,
    )).map((c) => ({ id: c.id, title: c.title }));
    out.entries = (await q.all('SELECT * FROM entries WHERE session_id = ? ORDER BY sort_key', s.id))
      .map((e) => ({ ...entryView(e), clusterId: e.cluster_id, hidden: Boolean(e.hidden) }));
    if (s.phase === 'result') out.points = await points(s.id);
  }
  return out;
}

const addClusterSt = (id, sessionId, title) => st(
  `INSERT INTO clusters (id, session_id, title, position)
   SELECT ?, ?, ?, COALESCE(MAX(position), 0) + 1 FROM clusters WHERE session_id = ?`,
  id, sessionId, title, sessionId,
);

// Vor der Freigabe: Beiträge ohne Cluster landen in "Weitere Themen",
// damit nichts stillschweigend unter den Tisch fällt.
async function leftoverStatements(sessionId) {
  const loose = await q.get(
    'SELECT COUNT(*) AS n FROM entries WHERE session_id = ? AND cluster_id IS NULL', sessionId,
  );
  if (!loose.n) return [];
  const title = (await count('clusters', sessionId)) ? 'Weitere Themen' : 'Beiträge';
  const existing = await q.get(
    'SELECT id FROM clusters WHERE session_id = ? AND title = ?', sessionId, title,
  );
  const cid = existing ? existing.id : newId();
  return [
    !existing && addClusterSt(cid, sessionId, title),
    st('UPDATE entries SET cluster_id = ? WHERE session_id = ? AND cluster_id IS NULL', cid, sessionId),
  ].filter(Boolean);
}

const pruneEmptyClustersSt = (sessionId) => st(
  `DELETE FROM clusters WHERE session_id = ?
   AND id NOT IN (SELECT cluster_id FROM entries WHERE session_id = ? AND cluster_id IS NOT NULL)`,
  sessionId, sessionId,
);

// ---------- Export ----------

async function exportData(s) {
  const p = await points(s.id);
  const clusters = (await visibleClusters(s.id)).map((c) => ({ ...c, points: p[c.id] || 0 }));
  if (s.phase === 'result') clusters.sort((a, b) => b.points - a.points);
  return clusters;
}

async function exportMarkdown(s) {
  const voted = (await count('ballots', s.id)) > 0;
  const lines = [`# ${s.title}`, '', `**Leitfrage:** ${s.question}`, ''];
  for (const c of await exportData(s)) {
    lines.push(`## ${c.title}${voted ? ` (${c.points} Punkte)` : ''}`, '');
    for (const e of c.entries) {
      lines.push(`- **Wahrnehmung:** ${e.wahrnehmung.replace(/\n+/g, ' ')}`);
      if (e.wirkung) lines.push(`  **Wirkung:** ${e.wirkung.replace(/\n+/g, ' ')}`);
      if (e.wunsch) lines.push(`  **Wunsch:** ${e.wunsch.replace(/\n+/g, ' ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function exportCsv(s) {
  // Führendes Apostroph verhindert, dass Excel Text als Formel ausführt.
  const cell = (v) => {
    let t = String(v ?? '');
    if (/^[=+\-@\t]/.test(t)) t = `'${t}`;
    return `"${t.replace(/"/g, '""')}"`;
  };
  const rows = [['Cluster', 'Punkte', 'Wahrnehmung', 'Wirkung', 'Wunsch']];
  for (const c of await exportData(s)) {
    for (const e of c.entries) rows.push([c.title, c.points, e.wahrnehmung, e.wirkung, e.wunsch]);
  }
  return '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n');
}

// ---------- Login-Schutz (global, ohne IP-Bezug) ----------

let loginFailures = [];
function loginAllowed() {
  const now = Date.now();
  loginFailures = loginFailures.filter((t) => now - t < 10 * 60_000);
  return loginFailures.length < 10;
}

// ---------- Routen ----------

const routes = [];
const route = (method, pattern, handler, admin = false) =>
  routes.push({ method, pattern, handler, admin });

// Seiten
route('GET', /^\/$/, (c) => send(c.res, 302, '', { Location: '/admin' }));
route('GET', /^\/admin$/, (c) => sendFile(c.res, PUBLIC, 'admin.html'));
route('GET', /^\/m\/[a-z0-9]+$/, (c) => sendFile(c.res, PUBLIC, 'moderator.html'));
route('GET', /^\/s\/[a-z0-9]+$/, (c) => sendFile(c.res, PUBLIC, 'participant.html'));
route('GET', /^\/b\/[a-z0-9]+$/, (c) => sendFile(c.res, PUBLIC, 'beamer.html'));
route('GET', /^\/assets\/([\w./-]+)$/, (c) => sendFile(c.res, PUBLIC, c.m[1]));
route('GET', /^\/fonts\/(poppins-latin-(?:300|600)-normal\.woff2)$/, (c) =>
  sendFile(c.res, FONTS, c.m[1], 'public, max-age=31536000, immutable'));

// Öffentliche API
route('GET', /^\/api\/s\/([a-z0-9]+)\/state$/, async (c) => {
  const cur = await current(c.m[1]);
  if (Number(c.url.searchParams.get('v')) === cur.version) {
    return json(c.res, 200, { unchanged: true });
  }
  json(c.res, 200, cur.pub);
});

route('GET', /^\/api\/s\/([a-z0-9]+)\/qr\.svg$/, async (c) => {
  await current(c.m[1]);
  const svg = await QRCode.toString(`${baseUrl(c.req)}/s/${c.m[1]}`, {
    type: 'svg', margin: 1, errorCorrectionLevel: 'M',
  });
  send(c.res, 200, svg, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
});

route('POST', /^\/api\/s\/([a-z0-9]+)\/entries$/, async (c) => {
  const id = c.m[1];
  const { pub } = await current(id);
  if (pub.phase !== 'collect') fail(409, 'Die Sammlung ist bereits geschlossen.');
  const b = await body(c.req);
  const wahrnehmung = clean(b.wahrnehmung);
  if (!wahrnehmung) fail(400, 'Bitte fülle das Feld „Wahrnehmung“ aus.');
  if (pub.count >= MAX_ENTRIES) fail(429, 'Die maximale Anzahl an Beiträgen ist erreicht.');
  // Die Phase wird im INSERT noch einmal geprüft, falls die Sammlung genau jetzt schließt.
  const [inserted] = await q.batch([
    st(
      `INSERT INTO entries (id, session_id, wahrnehmung, wirkung, wunsch, sort_key)
       SELECT ?, id, ?, ?, ?, ? FROM sessions WHERE id = ? AND phase = 'collect'`,
      newId(), wahrnehmung, clean(b.wirkung), clean(b.wunsch),
      randomBytes(6).readUIntBE(0, 6) / 2 ** 48, id,
    ),
    bump(id),
  ]);
  touch(id);
  if (!inserted.rowsAffected) fail(409, 'Die Sammlung ist bereits geschlossen.');
  json(c.res, 201, { ok: true });
});

route('POST', /^\/api\/s\/([a-z0-9]+)\/vote$/, async (c) => {
  const id = c.m[1];
  const { pub } = await current(id);
  if (pub.phase !== 'vote') fail(409, 'Die Abstimmung ist nicht geöffnet.');
  const b = await body(c.req);
  const token = typeof b.token === 'string' && /^[\w-]{16,64}$/.test(b.token) ? b.token : null;
  if (!token) fail(400, 'Ungültige Abstimmung.');
  const valid = new Set(pub.clusters.map((x) => x.id));
  const alloc = {};
  let total = 0;
  for (const [cid, n] of Object.entries(b.allocations || {})) {
    if (!valid.has(cid) || !Number.isInteger(n) || n < 0) fail(400, 'Ungültige Abstimmung.');
    if (n > 0) alloc[cid] = n;
    total += n;
  }
  if (total > pub.votesPerPerson) fail(400, 'Zu viele Punkte vergeben.');
  await write(id, st(
    `INSERT INTO ballots (session_id, token, allocations) VALUES (?, ?, ?)
     ON CONFLICT (session_id, token) DO UPDATE SET allocations = excluded.allocations`,
    id, token, JSON.stringify(alloc),
  ));
  json(c.res, 200, { ok: true });
});

// Moderator: Login
route('POST', /^\/api\/admin\/login$/, async (c) => {
  if (!loginAllowed()) fail(429, 'Zu viele Fehlversuche. Bitte in 10 Minuten erneut versuchen.');
  const b = await body(c.req);
  const given = createHmac('sha256', 'cmp').update(String(b.password ?? '')).digest();
  const real = createHmac('sha256', 'cmp').update(PASSWORD).digest();
  if (!timingSafeEqual(given, real)) {
    loginFailures.push(Date.now());
    await new Promise((r) => setTimeout(r, 600));
    fail(401, 'Falsches Passwort.');
  }
  const secure = baseUrl(c.req).startsWith('https') ? '; Secure' : '';
  c.res.setHeader(
    'Set-Cookie',
    `klartext_mod=${COOKIE_VALUE}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`,
  );
  json(c.res, 200, { ok: true });
});
route('POST', /^\/api\/admin\/logout$/, (c) => {
  c.res.setHeader('Set-Cookie', 'klartext_mod=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  json(c.res, 200, { ok: true });
});
route('GET', /^\/api\/admin\/me$/, (c) => json(c.res, 200, { moderator: isModerator(c.req) }));

// Moderator: Sessions
route('GET', /^\/api\/admin\/sessions$/, async (c) => {
  const list = await q.all(
    `SELECT s.id, s.title, s.phase, s.created_day,
       (SELECT COUNT(*) FROM entries e WHERE e.session_id = s.id) AS n
     FROM sessions s ORDER BY s.created_day DESC, s.title`,
  );
  json(c.res, 200, {
    sessions: list.map((s) => ({
      id: s.id, title: s.title, phase: s.phase, createdDay: s.created_day, count: s.n,
    })),
    defaultQuestion: DEFAULT_QUESTION,
  });
}, true);

route('POST', /^\/api\/admin\/sessions$/, async (c) => {
  const b = await body(c.req);
  const title = clean(b.title, 120) || fail(400, 'Bitte gib einen Titel an.');
  const question = clean(b.question, 300) || DEFAULT_QUESTION;
  const votes = Number.isInteger(b.votesPerPerson) && b.votesPerPerson >= 1 && b.votesPerPerson <= 10
    ? b.votesPerPerson : 3;
  const id = newSessionId();
  await q.run(
    'INSERT INTO sessions (id, title, question, votes_per_person, created_day) VALUES (?, ?, ?, ?, ?)',
    id, title, question, votes, new Date().toISOString().slice(0, 10),
  );
  json(c.res, 201, { id });
}, true);

route('GET', /^\/api\/admin\/s\/([a-z0-9]+)$/, async (c) => {
  const cur = await current(c.m[1]);
  if (Number(c.url.searchParams.get('v')) === cur.version) {
    return json(c.res, 200, { unchanged: true });
  }
  json(c.res, 200, await adminState(await getSession(c.m[1])));
}, true);

route('DELETE', /^\/api\/admin\/s\/([a-z0-9]+)$/, async (c) => {
  await getSession(c.m[1]);
  await q.batch(deleteSessionStatements(c.m[1]));
  forget(c.m[1]);
  json(c.res, 200, { ok: true });
}, true);

route('POST', /^\/api\/admin\/s\/([a-z0-9]+)\/phase$/, async (c) => {
  const s = await getSession(c.m[1]);
  const { phase } = await body(c.req);
  const idx = PHASES.indexOf(phase);
  if (idx < 0) fail(400, 'Unbekannte Phase.');
  await write(s.id,
    // Zurück in Sammlung/Sichtung: abgegebene Punkte passen nicht mehr zu den Clustern.
    idx <= 1 ? [st('DELETE FROM ballots WHERE session_id = ?', s.id)] : [],
    idx >= 2 ? [...await leftoverStatements(s.id), pruneEmptyClustersSt(s.id)] : [],
    st('UPDATE sessions SET phase = ?, focus_cluster = NULL WHERE id = ?', phase, s.id),
  );
  json(c.res, 200, { ok: true });
}, true);

const needReview = (s) => {
  if (s.phase === 'collect') fail(409, 'Erst die Sammlung schließen.');
};

route('POST', /^\/api\/admin\/s\/([a-z0-9]+)\/autocluster$/, async (c) => {
  const s = await getSession(c.m[1]);
  if (s.phase !== 'review') fail(409, 'KI-Clustering ist nur in der Sichtung möglich.');
  const entries = await q.all(
    'SELECT * FROM entries WHERE session_id = ? AND hidden = 0 ORDER BY sort_key', s.id,
  );
  if (entries.length < MIN_FOR_AI) {
    fail(400, `Für das KI-Clustering braucht es mindestens ${MIN_FOR_AI} sichtbare Beiträge.`);
  }
  let result;
  try {
    result = await clusterEntries(entries);
  } catch (e) {
    console.error('Clustering fehlgeschlagen:', e?.status || '', e?.name || 'Error');
    fail(502, 'Das KI-Clustering ist fehlgeschlagen. Du kannst es erneut versuchen oder manuell clustern.');
  }
  const statements = [
    st('UPDATE entries SET cluster_id = NULL WHERE session_id = ?', s.id),
    st('DELETE FROM clusters WHERE session_id = ?', s.id),
  ];
  result.forEach((cl, i) => {
    const cid = newId();
    statements.push(st(
      'INSERT INTO clusters (id, session_id, title, position) VALUES (?, ?, ?, ?)',
      cid, s.id, cl.title, i + 1,
    ));
    for (const n of cl.indexes) {
      statements.push(st('UPDATE entries SET cluster_id = ? WHERE id = ?', cid, entries[n].id));
    }
  });
  await write(s.id, statements);
  json(c.res, 200, { ok: true });
}, true);

route('POST', /^\/api\/admin\/s\/([a-z0-9]+)\/clusters$/, async (c) => {
  const s = await getSession(c.m[1]);
  needReview(s);
  const title = clean((await body(c.req)).title, 80) || fail(400, 'Bitte gib einen Titel an.');
  const id = newId();
  await write(s.id, addClusterSt(id, s.id, title));
  json(c.res, 201, { id });
}, true);

const getCluster = async (sid, cid) =>
  (await q.get('SELECT * FROM clusters WHERE id = ? AND session_id = ?', cid, sid)) ||
  fail(404, 'Cluster nicht gefunden.');

const dissolveSt = (clusterId, moveTo = null) => [
  st('UPDATE entries SET cluster_id = ? WHERE cluster_id = ?', moveTo, clusterId),
  st('DELETE FROM clusters WHERE id = ?', clusterId),
];

route('POST', /^\/api\/admin\/s\/([a-z0-9]+)\/clusters\/([\w-]+)$/, async (c) => {
  const s = await getSession(c.m[1]);
  needReview(s);
  const cl = await getCluster(s.id, c.m[2]);
  const b = await body(c.req);
  const statements = [];
  if (b.title !== undefined) {
    const title = clean(b.title, 80) || fail(400, 'Bitte gib einen Titel an.');
    statements.push(st('UPDATE clusters SET title = ? WHERE id = ?', title, cl.id));
  }
  if (b.mergeInto !== undefined) {
    const target = await getCluster(s.id, b.mergeInto);
    if (target.id === cl.id) fail(400, 'Ziel und Quelle sind identisch.');
    statements.push(...dissolveSt(cl.id, target.id));
  }
  await write(s.id, statements);
  json(c.res, 200, { ok: true });
}, true);

route('DELETE', /^\/api\/admin\/s\/([a-z0-9]+)\/clusters\/([\w-]+)$/, async (c) => {
  const s = await getSession(c.m[1]);
  needReview(s);
  const cl = await getCluster(s.id, c.m[2]);
  await write(s.id, dissolveSt(cl.id)); // Beiträge werden "ohne Cluster"
  json(c.res, 200, { ok: true });
}, true);

route('POST', /^\/api\/admin\/s\/([a-z0-9]+)\/entries\/([\w-]+)$/, async (c) => {
  const s = await getSession(c.m[1]);
  needReview(s);
  const e = (await q.get('SELECT * FROM entries WHERE id = ? AND session_id = ?', c.m[2], s.id)) ||
    fail(404, 'Beitrag nicht gefunden.');
  const b = await body(c.req);
  const statements = [];
  if (b.clusterId !== undefined) {
    const cid = b.clusterId === null ? null : (await getCluster(s.id, b.clusterId)).id;
    statements.push(st('UPDATE entries SET cluster_id = ? WHERE id = ?', cid, e.id));
  }
  if (b.hidden !== undefined) {
    statements.push(st('UPDATE entries SET hidden = ? WHERE id = ?', b.hidden ? 1 : 0, e.id));
  }
  await write(s.id, statements);
  json(c.res, 200, { ok: true });
}, true);

route('POST', /^\/api\/admin\/s\/([a-z0-9]+)\/focus$/, async (c) => {
  const s = await getSession(c.m[1]);
  const { clusterId } = await body(c.req);
  const cid = clusterId ? (await getCluster(s.id, clusterId)).id : null;
  await write(s.id, st('UPDATE sessions SET focus_cluster = ? WHERE id = ?', cid, s.id));
  json(c.res, 200, { ok: true });
}, true);

route('GET', /^\/api\/admin\/s\/([a-z0-9]+)\/export\.(md|csv)$/, async (c) => {
  const s = await getSession(c.m[1]);
  if (s.phase === 'collect') fail(409, 'Export erst nach Schließen der Sammlung.');
  const md = c.m[2] === 'md';
  send(c.res, 200, md ? await exportMarkdown(s) : await exportCsv(s), {
    'Content-Type': md ? 'text/markdown; charset=utf-8' : 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="klartext-${s.id}.${c.m[2]}"`,
    'Cache-Control': 'no-store',
  });
}, true);

// ---------- Server ----------

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      if (r.admin && !isModerator(req)) fail(401, 'Nicht angemeldet.');
      return await r.handler({ req, res, url, m });
    }
    fail(404, 'Nicht gefunden.');
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return json(res, e.status, { error: e.message });
    // Nur Fehlertyp loggen, nie Inhalte oder Anfragedaten.
    console.error('Serverfehler:', e?.name || 'Error', e?.code || '');
    json(res, 500, { error: 'Interner Fehler.' });
  }
});

const purge = () => purgeOld().then((ids) => ids.forEach(forget))
  .catch((e) => console.error('Aufräumen fehlgeschlagen:', e?.name || 'Error'));

await init();
await purge();
setInterval(purge, 6 * 3600_000).unref();
server.listen(PORT, () => console.log(`Klartext Tool läuft auf Port ${PORT} (Daten: ${storage})`));
