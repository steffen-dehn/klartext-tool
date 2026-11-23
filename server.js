// Klartext Tool – anonymes 3W-Feedback für moderierte Workshops.
// Der Server schreibt bewusst KEIN Request-Log und liest keine IP-Adressen.
import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { q, tx, bump, newId, newSessionId, purgeOld } from './db.js';
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

const getSession = (id) =>
  q.get('SELECT * FROM sessions WHERE id = ?', id) || fail(404, 'Session nicht gefunden.');
const entryCount = (id) =>
  q.get('SELECT COUNT(*) AS n FROM entries WHERE session_id = ?', id).n;
const ballotCount = (id) =>
  q.get('SELECT COUNT(*) AS n FROM ballots WHERE session_id = ?', id).n;

function points(sessionId) {
  const sum = {};
  for (const b of q.all('SELECT allocations FROM ballots WHERE session_id = ?', sessionId)) {
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
function visibleClusters(sessionId) {
  const entries = q.all(
    'SELECT * FROM entries WHERE session_id = ? AND hidden = 0 ORDER BY sort_key',
    sessionId,
  );
  return q
    .all('SELECT * FROM clusters WHERE session_id = ? ORDER BY position', sessionId)
    .map((c) => ({
      id: c.id,
      title: c.title,
      entries: entries.filter((e) => e.cluster_id === c.id).map(entryView),
    }))
    .filter((c) => c.entries.length);
}

// Was Teilnehmende und Beamer sehen dürfen – abhängig von der Phase.
function publicState(s) {
  const out = {
    id: s.id,
    title: s.title,
    question: s.question,
    phase: s.phase,
    version: s.version,
    votesPerPerson: s.votes_per_person,
    count: entryCount(s.id),
  };
  if (['reveal', 'vote', 'result'].includes(s.phase)) {
    out.clusters = visibleClusters(s.id);
    out.focus = out.clusters.some((c) => c.id === s.focus_cluster) ? s.focus_cluster : null;
  }
  if (s.phase === 'vote' || s.phase === 'result') out.ballots = ballotCount(s.id);
  if (s.phase === 'result') {
    const p = points(s.id);
    for (const c of out.clusters) c.points = p[c.id] || 0;
  }
  return out;
}

function adminState(s) {
  const out = {
    id: s.id,
    title: s.title,
    question: s.question,
    phase: s.phase,
    version: s.version,
    votesPerPerson: s.votes_per_person,
    createdDay: s.created_day,
    focus: s.focus_cluster,
    count: entryCount(s.id),
    ballots: ballotCount(s.id),
    aiAvailable: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    minForAi: MIN_FOR_AI,
  };
  // Während der Sammlung sieht auch der Moderator keine Inhalte.
  if (s.phase !== 'collect') {
    out.clusters = q
      .all('SELECT id, title FROM clusters WHERE session_id = ? ORDER BY position', s.id);
    out.entries = q
      .all('SELECT * FROM entries WHERE session_id = ? ORDER BY sort_key', s.id)
      .map((e) => ({ ...entryView(e), clusterId: e.cluster_id, hidden: Boolean(e.hidden) }));
    if (s.phase === 'result') out.points = points(s.id);
  }
  return out;
}

const nextPosition = (sessionId) =>
  q.get('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM clusters WHERE session_id = ?', sessionId).p;

function addCluster(sessionId, title) {
  const id = newId();
  q.run(
    'INSERT INTO clusters (id, session_id, title, position) VALUES (?, ?, ?, ?)',
    id, sessionId, title, nextPosition(sessionId),
  );
  return id;
}

// Vor der Freigabe: Beiträge ohne Cluster landen in "Weitere Themen",
// damit nichts stillschweigend unter den Tisch fällt.
function assignLeftovers(sessionId) {
  const loose = q.all(
    'SELECT id FROM entries WHERE session_id = ? AND cluster_id IS NULL', sessionId,
  );
  if (!loose.length) return;
  const any = q.get('SELECT COUNT(*) AS n FROM clusters WHERE session_id = ?', sessionId).n;
  const title = any ? 'Weitere Themen' : 'Beiträge';
  const existing = q.get(
    'SELECT id FROM clusters WHERE session_id = ? AND title = ?', sessionId, title,
  );
  const cid = existing ? existing.id : addCluster(sessionId, title);
  q.run('UPDATE entries SET cluster_id = ? WHERE session_id = ? AND cluster_id IS NULL', cid, sessionId);
}

function pruneEmptyClusters(sessionId) {
  q.run(
    `DELETE FROM clusters WHERE session_id = ?
     AND id NOT IN (SELECT cluster_id FROM entries WHERE session_id = ? AND cluster_id IS NOT NULL)`,
    sessionId, sessionId,
  );
}

// ---------- Export ----------

function exportData(s) {
  const p = points(s.id);
  const clusters = visibleClusters(s.id).map((c) => ({ ...c, points: p[c.id] || 0 }));
  if (s.phase === 'result') clusters.sort((a, b) => b.points - a.points);
  return clusters;
}

function exportMarkdown(s) {
  const voted = ballotCount(s.id) > 0;
  const lines = [`# ${s.title}`, '', `**Leitfrage:** ${s.question}`, ''];
  for (const c of exportData(s)) {
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

function exportCsv(s) {
  // Führendes Apostroph verhindert, dass Excel Text als Formel ausführt.
  const cell = (v) => {
    let t = String(v ?? '');
    if (/^[=+\-@\t]/.test(t)) t = `'${t}`;
    return `"${t.replace(/"/g, '""')}"`;
  };
  const rows = [['Cluster', 'Punkte', 'Wahrnehmung', 'Wirkung', 'Wunsch']];
  for (const c of exportData(s)) {
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
route('GET', /^\/api\/s\/([a-z0-9]+)\/state$/, (c) => {
  const s = getSession(c.m[1]);
  if (Number(c.url.searchParams.get('v')) === s.version) {
    return json(c.res, 200, { unchanged: true });
  }
  json(c.res, 200, publicState(s));
});

route('GET', /^\/api\/s\/([a-z0-9]+)\/qr\.svg$/, async (c) => {
  const s = getSession(c.m[1]);
  const svg = await QRCode.toString(`${baseUrl(c.req)}/s/${s.id}`, {
    type: 'svg', margin: 1, errorCorrectionLevel: 'M',
  });
  send(c.res, 200, svg, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
});

route('POST', /^\/api\/s\/([a-z0-9]+)\/entries$/, async (c) => {
  const s = getSession(c.m[1]);
  if (s.phase !== 'collect') fail(409, 'Die Sammlung ist bereits geschlossen.');
  const b = await body(c.req);
  const wahrnehmung = clean(b.wahrnehmung);
  if (!wahrnehmung) fail(400, 'Bitte fülle das Feld „Wahrnehmung“ aus.');
  if (entryCount(s.id) >= MAX_ENTRIES) fail(429, 'Die maximale Anzahl an Beiträgen ist erreicht.');
  q.run(
    `INSERT INTO entries (id, session_id, wahrnehmung, wirkung, wunsch, sort_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
    newId(), s.id, wahrnehmung, clean(b.wirkung), clean(b.wunsch),
    randomBytes(6).readUIntBE(0, 6) / 2 ** 48,
  );
  bump(s.id);
  json(c.res, 201, { ok: true });
});

route('POST', /^\/api\/s\/([a-z0-9]+)\/vote$/, async (c) => {
  const s = getSession(c.m[1]);
  if (s.phase !== 'vote') fail(409, 'Die Abstimmung ist nicht geöffnet.');
  const b = await body(c.req);
  const token = typeof b.token === 'string' && /^[\w-]{16,64}$/.test(b.token) ? b.token : null;
  if (!token) fail(400, 'Ungültige Abstimmung.');
  const valid = new Set(visibleClusters(s.id).map((x) => x.id));
  const alloc = {};
  let total = 0;
  for (const [cid, n] of Object.entries(b.allocations || {})) {
    if (!valid.has(cid) || !Number.isInteger(n) || n < 0) fail(400, 'Ungültige Abstimmung.');
    if (n > 0) alloc[cid] = n;
    total += n;
  }
  if (total > s.votes_per_person) fail(400, 'Zu viele Punkte vergeben.');
  q.run(
    `INSERT INTO ballots (session_id, token, allocations) VALUES (?, ?, ?)
     ON CONFLICT (session_id, token) DO UPDATE SET allocations = excluded.allocations`,
    s.id, token, JSON.stringify(alloc),
  );
  bump(s.id);
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
route('GET', /^\/api\/admin\/sessions$/, (c) => {
  const list = q.all('SELECT * FROM sessions ORDER BY created_day DESC, title').map((s) => ({
    id: s.id, title: s.title, phase: s.phase, createdDay: s.created_day, count: entryCount(s.id),
  }));
  json(c.res, 200, { sessions: list, defaultQuestion: DEFAULT_QUESTION });
}, true);

route('POST', /^\/api\/admin\/sessions$/, async (c) => {
  const b = await body(c.req);
  const title = clean(b.title, 120) || fail(400, 'Bitte gib einen Titel an.');
  const question = clean(b.question, 300) || DEFAULT_QUESTION;
  const votes = Number.isInteger(b.votesPerPerson) && b.votesPerPerson >= 1 && b.votesPerPerson <= 10
    ? b.votesPerPerson : 3;
  const id = newSessionId();
  q.run(
    'INSERT INTO sessions (id, title, question, votes_per_person, created_day) VALUES (?, ?, ?, ?, ?)',
    id, title, question, votes, new Date().toISOString().slice(0, 10),
  );
  json(c.res, 201, { id });
}, true);

route('GET', /^\/api\/admin\/s\/([a-z0-9]+)$/, (c) => {
  const s = getSession(c.m[1]);
  if (Number(c.url.searchParams.get('v')) === s.version) {
    return json(c.res, 200, { unchanged: true });
  }
  json(c.res, 200, adminState(s));
}, true);

route('DELETE', /^\/api\/admin\/s\/([a-z0-9]+)$/, (c) => {
  getSession(c.m[1]);
  q.run('DELETE FROM sessions WHERE id = ?', c.m[1]);
  json(c.res, 200, { ok: true });
}, true);

route('POST', /^\/api\/admin\/s\/([a-z0-9]+)\/phase$/, async (c) => {
  const s = getSession(c.m[1]);
  const { phase } = await body(c.req);
  if (!PHASES.includes(phase)) fail(400, 'Unbekannte Phase.');
  tx(() => {
    const idx = PHASES.indexOf(phase);
    // Zurück in Sammlung/Sichtung: abgegebene Punkte passen nicht mehr zu den Clustern.
    if (idx <= 1) q.run('DELETE FROM ballots WHERE session_id = ?', s.id);
    if (idx >= 2) {
      assignLeftovers(s.id);
      pruneEmptyClusters(s.id);
    }
    q.run('UPDATE sessions SET phase = ?, focus_cluster = NULL WHERE id = ?', phase, s.id);
    bump(s.id);
  });
  json(c.res, 200, { ok: true });
}, true);

const needReview = (s) => {
  if (s.phase === 'collect') fail(409, 'Erst die Sammlung schließen.');
};

route('POST', /^\/api\/admin\/s\/([a-z0-9]+)\/autocluster$/, async (c) => {
  const s = getSession(c.m[1]);
  if (s.phase !== 'review') fail(409, 'KI-Clustering ist nur in der Sichtung möglich.');
  const entries = q.all(
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
  tx(() => {
    q.run('DELETE FROM clusters WHERE session_id = ?', s.id);
    for (const cl of result) {
      const cid = addCluster(s.id, cl.title);
      for (const i of cl.indexes) {
        q.run('UPDATE entries SET cluster_id = ? WHERE id = ?', cid, entries[i].id);
      }
    }
    bump(s.id);
  });
  json(c.res, 200, { ok: true });
}, true);

route('POST', /^\/api\/admin\/s\/([a-z0-9]+)\/clusters$/, async (c) => {
  const s = getSession(c.m[1]);
  needReview(s);
  const title = clean((await body(c.req)).title, 80) || fail(400, 'Bitte gib einen Titel an.');
  const id = addCluster(s.id, title);
  bump(s.id);
  json(c.res, 201, { id });
}, true);

const getCluster = (sid, cid) =>
  q.get('SELECT * FROM clusters WHERE id = ? AND session_id = ?', cid, sid) ||
  fail(404, 'Cluster nicht gefunden.');

route('POST', /^\/api\/admin\/s\/([a-z0-9]+)\/clusters\/([\w-]+)$/, async (c) => {
  const s = getSession(c.m[1]);
  needReview(s);
  const cl = getCluster(s.id, c.m[2]);
  const b = await body(c.req);
  tx(() => {
    if (b.title !== undefined) {
      const title = clean(b.title, 80) || fail(400, 'Bitte gib einen Titel an.');
      q.run('UPDATE clusters SET title = ? WHERE id = ?', title, cl.id);
    }
    if (b.mergeInto !== undefined) {
      const target = getCluster(s.id, b.mergeInto);
      if (target.id === cl.id) fail(400, 'Ziel und Quelle sind identisch.');
      q.run('UPDATE entries SET cluster_id = ? WHERE cluster_id = ?', target.id, cl.id);
      q.run('DELETE FROM clusters WHERE id = ?', cl.id);
    }
    bump(s.id);
  });
  json(c.res, 200, { ok: true });
}, true);

route('DELETE', /^\/api\/admin\/s\/([a-z0-9]+)\/clusters\/([\w-]+)$/, (c) => {
  const s = getSession(c.m[1]);
  needReview(s);
  const cl = getCluster(s.id, c.m[2]);
  q.run('DELETE FROM clusters WHERE id = ?', cl.id); // Beiträge werden "ohne Cluster"
  bump(s.id);
  json(c.res, 200, { ok: true });
}, true);

route('POST', /^\/api\/admin\/s\/([a-z0-9]+)\/entries\/([\w-]+)$/, async (c) => {
  const s = getSession(c.m[1]);
  needReview(s);
  const e = q.get('SELECT * FROM entries WHERE id = ? AND session_id = ?', c.m[2], s.id) ||
    fail(404, 'Beitrag nicht gefunden.');
  const b = await body(c.req);
  if (b.clusterId !== undefined) {
    const cid = b.clusterId === null ? null : getCluster(s.id, b.clusterId).id;
    q.run('UPDATE entries SET cluster_id = ? WHERE id = ?', cid, e.id);
  }
  if (b.hidden !== undefined) {
    q.run('UPDATE entries SET hidden = ? WHERE id = ?', b.hidden ? 1 : 0, e.id);
  }
  bump(s.id);
  json(c.res, 200, { ok: true });
}, true);

route('POST', /^\/api\/admin\/s\/([a-z0-9]+)\/focus$/, async (c) => {
  const s = getSession(c.m[1]);
  const { clusterId } = await body(c.req);
  const cid = clusterId ? getCluster(s.id, clusterId).id : null;
  q.run('UPDATE sessions SET focus_cluster = ? WHERE id = ?', cid, s.id);
  bump(s.id);
  json(c.res, 200, { ok: true });
}, true);

route('GET', /^\/api\/admin\/s\/([a-z0-9]+)\/export\.(md|csv)$/, (c) => {
  const s = getSession(c.m[1]);
  if (s.phase === 'collect') fail(409, 'Export erst nach Schließen der Sammlung.');
  const md = c.m[2] === 'md';
  send(c.res, 200, md ? exportMarkdown(s) : exportCsv(s), {
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

purgeOld();
setInterval(purgeOld, 6 * 3600_000).unref();
server.listen(PORT, () => console.log(`Klartext Tool läuft auf Port ${PORT}`));
