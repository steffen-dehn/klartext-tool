// Kompletter Durchlauf: 3 simulierte Smartphones, 15 Beiträge, alle Phasen.
// Die Claude API wird durch einen lokalen Stellvertreter ersetzt, der Rest ist echt.
// Aufruf: npm test   (Screenshots landen in test/shots)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
// Playwright ist bewusst keine Abhängigkeit der App; es wird global erwartet.
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const PORT = 3911;
const AI_PORT = 3912;
const URL = `http://localhost:${PORT}`;
const DB = './data/test.db';
const SHOTS = './test/shots';
rmSync(DB, { force: true });
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

// --- Stellvertreter für die Claude API ---
let aiRequest = null;
const ai = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  aiRequest = { url: req.url, beta: req.headers['anthropic-beta'], body: JSON.parse(raw) };
  const n = Number(/Hier sind (\d+) Beiträge/.exec(aiRequest.body.messages[0].content)[1]);
  const nums = Array.from({ length: n }, (_, i) => i + 1);
  const answer = {
    clusters: [
      { title: 'Verbindlichkeit von Entscheidungen', entries: nums.filter((x) => x % 3 === 1) },
      { title: 'Arbeitslast und Prioritäten', entries: nums.filter((x) => x % 3 === 2) },
      // Beitrag 3 fehlt absichtlich, Beitrag 1 ist doppelt: der Server muss das abfangen.
      { title: 'Zusammenarbeit im Team', entries: [1, ...nums.filter((x) => x % 3 === 0 && x !== 3)] },
    ],
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'msg_test', type: 'message', role: 'assistant', model: aiRequest.body.model,
    content: [{ type: 'text', text: JSON.stringify(answer) }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  }));
}).listen(AI_PORT);

// --- App starten ---
let log = '';
const app = spawn('node', ['--disable-warning=ExperimentalWarning', 'server.js'], {
  env: {
    ...process.env, PORT, DB_PATH: DB, MODERATOR_PASSWORD: 'test-passwort',
    ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://localhost:${AI_PORT}`,
  },
});
app.stdout.on('data', (d) => { log += d; });
app.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 50 && !log.includes('läuft'); i++) await new Promise((r) => setTimeout(r, 100));

const browser = await chromium.launch();
const errors = [];
const watch = (page, name) => {
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('401')) errors.push(`${name}: ${m.text()}`); });
};
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });
const step = (t) => console.log(`✓ ${t}`);

try {
  // Moderator
  const modCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const mod = await modCtx.newPage();
  watch(mod, 'moderator');
  mod.on('dialog', (d) => d.accept());

  await mod.goto(`${URL}/admin`);
  await mod.fill('#pw', 'falsch');
  await mod.click('button[type=submit]');
  await mod.getByText('Falsches Passwort.').waitFor();
  await mod.fill('#pw', 'test-passwort');
  await mod.click('button[type=submit]');
  await mod.getByRole('heading', { name: 'Neue Session' }).waitFor();
  await mod.fill('#t', 'Teamtag Vertrieb');
  await shot(mod, '01-admin');
  await mod.click('text=Session anlegen');
  await mod.waitForURL(/\/m\//);
  const id = mod.url().split('/').pop();
  await mod.getByText('Beiträge eingegangen').waitFor();
  step(`Login und Session angelegt (${id})`);

  // Ohne Anmeldung kein Zugriff auf die Moderator-API
  const anon = await fetch(`${URL}/api/admin/s/${id}`);
  assert.equal(anon.status, 401);

  // Beamer
  const beamCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const beamer = await beamCtx.newPage();
  watch(beamer, 'beamer');
  await beamer.goto(`${URL}/b/${id}`);
  await beamer.locator('.qr img').waitFor();
  const qr = await (await fetch(`${URL}/api/s/${id}/qr.svg`)).text();
  assert.match(qr, /<svg/);

  // 3 Smartphones, 15 Beiträge
  const phones = [];
  for (let i = 0; i < 3; i++) {
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const p = await ctx.newPage();
    watch(p, `phone${i}`);
    await p.goto(`${URL}/s/${id}`);
    await p.locator('#wahrnehmung').waitFor();
    phones.push(p);
  }
  await shot(phones[0], '02-phone-form');
  const overflow = await phones[0].evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, 'Maske darf auf dem Smartphone nicht horizontal scrollen');

  // Pflichtfeld
  await phones[0].fill('#wirkung', 'nur Wirkung');
  await phones[0].evaluate(() => document.querySelector('#wahrnehmung').removeAttribute('required'));
  await phones[0].click('button[type=submit]');
  await phones[0].getByText('Bitte fülle mindestens').waitFor();
  await phones[0].fill('#wirkung', '');

  let n = 0;
  for (let round = 0; round < 5; round++) {
    for (const p of phones) {
      n++;
      await p.fill('#wahrnehmung', `Wahrnehmung ${n}: <b>Entscheidungen</b> werden wieder aufgemacht.`);
      if (n % 2) await p.fill('#wirkung', `Wirkung ${n}`);
      if (n % 4 === 0) await p.fill('#wunsch', `Wunsch ${n}`);
      await p.click('button[type=submit]');
      await p.getByText('Danke, dein Beitrag ist eingegangen.').waitFor();
      if (n === 1) await shot(p, '03-phone-danke');
      await p.click('text=Weiteren Beitrag schreiben');
      await p.locator('#wahrnehmung').waitFor();
    }
  }
  step('15 Beiträge von 3 Smartphones eingereicht');

  await beamer.locator('.big-count', { hasText: '15' }).waitFor();
  await shot(beamer, '04-beamer-sammeln');

  // Während der Sammlung: nirgends Inhalte, auch nicht für den Moderator
  const cookie = (await modCtx.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const adminGet = async () => (await fetch(`${URL}/api/admin/s/${id}`, { headers: { cookie } })).json();
  const pubGet = async () => (await fetch(`${URL}/api/s/${id}/state`)).json();
  let a = await adminGet();
  assert.equal(a.count, 15);
  assert.equal(a.entries, undefined, 'Moderator sieht während der Sammlung keine Inhalte');
  assert.equal(JSON.stringify(await pubGet()).includes('Wahrnehmung 1'), false);
  await mod.locator('text=15').first().waitFor();
  await shot(mod, '05-mod-sammeln');
  step('Während der Sammlung sind keine Inhalte abrufbar');

  // Phase 2: Sichten
  await mod.click('text=Sammlung schließen und Beiträge sichten');
  await mod.getByText('Ohne Cluster (15)').waitFor();
  assert.equal(JSON.stringify(await pubGet()).includes('Wahrnehmung 1'), false, 'Sichtung ist nicht öffentlich');
  const late = await fetch(`${URL}/api/s/${id}/entries`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wahrnehmung: 'zu spät' }),
  });
  assert.equal(late.status, 409);
  await phones[0].getByText('Die Sammlung ist geschlossen').waitFor();

  // Reihenfolge ist nicht die Eingangsreihenfolge
  a = await adminGet();
  const order = a.entries.map((e) => Number(/Wahrnehmung (\d+)/.exec(e.wahrnehmung)[1]));
  assert.notDeepEqual(order, [...order].sort((x, y) => x - y), 'Beiträge müssen gemischt sein');
  step('Sammlung geschlossen, Reihenfolge gemischt, Nachzügler abgewiesen');

  // KI-Clustering
  await mod.click('text=Mit KI clustern');
  await mod.locator('input[aria-label="Cluster-Titel"]').first().waitFor();
  assert.equal(aiRequest.body.model, 'claude-opus-5-5');
  assert.equal(aiRequest.body.fallbacks, 'default');
  assert.match(aiRequest.beta, /server-side-fallback-2026-07-01/);
  assert.equal(aiRequest.body.output_config.format.type, 'json_schema');
  a = await adminGet();
  assert.equal(a.clusters.length, 4, '3 KI-Cluster + "Weitere Themen" für den vergessenen Beitrag');
  assert.ok(a.clusters.some((c) => c.title === 'Weitere Themen'));
  assert.ok(a.entries.every((e) => e.clusterId), 'jeder Beitrag hat genau einen Cluster');
  await shot(mod, '06-mod-cluster');
  step('KI-Clustering: jeder Beitrag genau einmal zugeordnet');

  // Manuell: umbenennen, verschieben, zusammenlegen, ausblenden
  const first = mod.locator('input[aria-label="Cluster-Titel"]').first();
  await first.fill('Wann gilt eine Entscheidung?');
  await first.press('Enter');
  await mod.waitForFunction(() =>
    [...document.querySelectorAll('input[aria-label="Cluster-Titel"]')].some((i) => i.value === 'Wann gilt eine Entscheidung?'));
  const rest = a.clusters.find((c) => c.title === 'Weitere Themen');
  const target = a.clusters.find((c) => c.title === 'Zusammenarbeit im Team');
  const post = (path, body) => fetch(`${URL}/api/admin/s/${id}${path}`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await post(`/clusters/${rest.id}`, { mergeInto: target.id })).status, 200);
  await mod.locator('.mod-cluster').nth(3).waitFor({ state: 'detached' });
  await mod.locator('.entry .tools button', { hasText: 'Ausblenden' }).first().click();
  await mod.getByText('Ausgeblendet: für die Gruppe nicht sichtbar').waitFor();
  a = await adminGet();
  assert.equal(a.clusters.length, 3);
  const hidden = a.entries.find((e) => e.hidden);
  assert.ok(hidden);
  step('Manuelle Korrektur: umbenennen, zusammenlegen, ausblenden');

  // Phase 3: Freigabe
  await mod.click('text=Für alle freigeben');
  await phones[1].locator('.cluster h2').first().waitFor();
  let pub = await pubGet();
  const shown = pub.clusters.flatMap((c) => c.entries);
  assert.equal(shown.length, 14, 'ausgeblendeter Beitrag ist nicht öffentlich');
  assert.equal(shown.some((e) => e.id === hidden.id), false);
  assert.equal(await phones[1].locator('b').count(), 0, 'HTML in Beiträgen wird nicht ausgeführt');
  await phones[1].getByText('<b>Entscheidungen</b>').first().waitFor();
  await beamer.locator('.board .cluster').first().waitFor();
  await shot(beamer, '07-beamer-freigabe');
  await shot(phones[1], '08-phone-freigabe');
  await mod.locator('text=Auf Beamer groß zeigen').first().click();
  await beamer.locator('.focus').waitFor();
  await shot(beamer, '09-beamer-fokus');
  step('Freigabe: 14 Originaltexte sichtbar, Fokus-Ansicht auf dem Beamer');

  // Phase 4: Abstimmung
  await mod.click('text=Abstimmung starten');
  for (const [i, p] of phones.entries()) {
    await p.locator('.vote-row').first().waitFor();
    const plus = p.locator('.vote-row').nth(i === 2 ? 1 : 0).locator('button', { hasText: '+' });
    await plus.click(); await plus.click(); await plus.click();
    assert.equal(await p.locator('.vote-row').nth(2).locator('button', { hasText: '+' }).isDisabled(), true,
      'nach 3 Punkten ist Schluss');
    if (i === 0) await shot(p, '10-phone-abstimmung');
    await p.click('text=Punkte abgeben');
    await p.getByText('Deine Punkte sind abgegeben').waitFor();
  }
  const cheat = await fetch(`${URL}/api/s/${id}/vote`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'x'.repeat(20), allocations: { [pub.clusters[0].id]: 9 } }),
  });
  assert.equal(cheat.status, 400);
  pub = await pubGet();
  assert.equal(pub.ballots, 3);
  assert.equal(pub.clusters[0].points, undefined, 'Zwischenstand ist nicht öffentlich');
  await beamer.getByText('3 Personen haben abgestimmt').waitFor();
  await shot(beamer, '11-beamer-abstimmung');

  await mod.click('text=Abstimmung schließen und Ergebnis zeigen');
  await beamer.locator('.rank').first().waitFor();
  pub = await pubGet();
  assert.deepEqual(pub.clusters.map((c) => c.points).sort((x, y) => y - x), [6, 3, 0]);
  await shot(beamer, '12-beamer-ergebnis');
  await phones[0].locator('.rank').first().waitFor();
  await shot(phones[0], '13-phone-ergebnis');
  await mod.getByRole('heading', { name: 'Ergebnis' }).waitFor();
  await shot(mod, '14-mod-ergebnis');
  step('Abstimmung: 3 Stimmzettel, Ergebnis 6 / 3 / 0');

  // Export
  const md = await (await fetch(`${URL}/api/admin/s/${id}/export.md`, { headers: { cookie } })).text();
  assert.match(md, /## .+ \(6 Punkte\)/);
  assert.equal(md.includes(hidden.wahrnehmung), false);
  const csv = await (await fetch(`${URL}/api/admin/s/${id}/export.csv`, { headers: { cookie } })).text();
  assert.equal(csv.trim().split('\r\n').length, 15);
  step('Export Markdown und CSV');

  // Datenbank: nichts Personenbeziehbares
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(DB);
  const cols = db.prepare(`SELECT m.name AS t, p.name AS c FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table'`).all();
  const names = cols.map((c) => `${c.t}.${c.c}`);
  assert.equal(names.some((x) => /ip|agent|device|time|created_at|rowid/i.test(x.split('.')[1])), false, names.join(', '));
  const dump = JSON.stringify(db.prepare('SELECT * FROM entries').all()) +
    JSON.stringify(db.prepare('SELECT * FROM ballots').all());
  assert.equal(/127\.0\.0\.1|::1|iPhone|Mozilla/.test(dump), false);
  assert.throws(() => db.prepare('SELECT rowid FROM entries').all(), /no such column/);
  db.close();
  assert.equal(/127\.0\.0\.1|::1|iPhone|Mozilla|Wahrnehmung \d/.test(log), false, 'Server-Log enthält keine Anfragedaten');
  step('Datenbank und Log: keine IP, kein Gerät, kein Zeitstempel, keine Eingangsreihenfolge');

  // Löschen
  await mod.click('text=Session löschen');
  await mod.waitForURL(/\/admin$/);
  assert.equal((await fetch(`${URL}/api/s/${id}/state`)).status, 404);
  assert.equal(readFileSync(DB).includes('Wahrnehmung 7'), false, 'gelöschte Texte stehen nicht mehr in der Datei');
  step('Session gelöscht, Texte aus der Datenbankdatei entfernt');

  assert.deepEqual(errors, [], 'keine Fehler in den Browser-Konsolen');
  console.log('\nAlle Prüfungen bestanden.');
} catch (e) {
  console.error('\nFEHLGESCHLAGEN:', e.message);
  if (errors.length) console.error('Browser-Fehler:', errors);
  console.error('Server-Log:', log);
  process.exitCode = 1;
} finally {
  await browser.close();
  app.kill();
  ai.close();
  rmSync(DB, { force: true });
}
