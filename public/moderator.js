import { h, api, poll, sessionId, entryEl, rankEl, plural } from '/assets/common.js';

const id = sessionId();
const app = document.getElementById('app');
const base = `/api/admin/s/${id}`;
const PHASES = ['collect', 'review', 'reveal', 'vote', 'result'];
const LABEL = { collect: '1 Sammeln', review: '2 Sichten', reveal: '3 Freigabe', vote: '4 Abstimmung', result: '5 Ergebnis' };
const NEXT = {
  collect: 'Sammlung schließen und Beiträge sichten',
  review: 'Für alle freigeben',
  reveal: 'Abstimmung starten',
  vote: 'Abstimmung schließen und Ergebnis zeigen',
};
const CONFIRM = {
  review: 'Sammlung schließen? Danach können keine Beiträge mehr eingereicht werden und du siehst alle Inhalte.',
  reveal: 'Beiträge jetzt für alle sichtbar machen (Beamer und Smartphones)?',
};

let state = null;
let message = '';
let busy = false;
let poller;
let typing = false; // läuft gerade eine Texteingabe? Dann nicht neu zeichnen.
const track = { oninput: () => { typing = true; }, onblur: () => { typing = false; } };

async function act(fn) {
  message = '';
  try {
    await fn();
  } catch (e) {
    message = e.message;
    render();
  }
  poller.refresh();
}
const post = (path, body = {}) => api(base + path, { method: 'POST', body });

function setPhase(phase) {
  if (CONFIRM[phase] && PHASES.indexOf(phase) > PHASES.indexOf(state.phase) && !confirm(CONFIRM[phase])) return;
  act(() => post('/phase', { phase }));
}

function headerEl() {
  const i = PHASES.indexOf(state.phase);
  const share = `${location.origin}/s/${id}`;
  return [
    h('div', { class: 'brand' },
      h('a', { href: '/admin' }, h('img', { src: '/assets/img/dec-logo.png', alt: 'Zur Übersicht' })),
      h('span', { class: 'tag' }, 'Klartext · Moderation')),
    h('h1', {}, state.title),
    h('div', { class: 'bar' }),
    h('p', { class: 'muted' }, state.question),
    h('ol', { class: 'steps' }, PHASES.map((p, n) =>
      h('li', { class: n === i ? 'active' : n < i ? 'done' : '' }, LABEL[p]))),
    message && h('p', { class: 'error', role: 'alert' }, message),
    h('div', { class: 'row', style: 'margin-bottom:22px' },
      NEXT[state.phase] && h('button', { onclick: () => setPhase(PHASES[i + 1]) }, NEXT[state.phase]),
      i > 0 && h('button', { class: 'secondary', onclick: () => setPhase(PHASES[i - 1]) },
        `Zurück zu „${LABEL[PHASES[i - 1]].slice(2)}“`),
      h('a', { class: 'btn secondary', href: `/b/${id}`, target: '_blank', rel: 'noopener' }, 'Beamer-Ansicht öffnen')),
    h('details', { class: 'card', open: state.phase === 'collect' },
      h('summary', {}, h('strong', {}, 'Link und QR-Code für Teilnehmende')),
      h('div', { class: 'row', style: 'margin-top:12px; align-items:flex-start' },
        h('div', { class: 'qr-box' }, h('img', { src: `/api/s/${id}/qr.svg`, alt: 'QR-Code' })),
        h('div', { class: 'grow' },
          h('p', {}, h('a', { href: share, target: '_blank', rel: 'noopener' }, share)),
          h('p', { class: 'small muted' },
            'Der QR-Code steht auch groß in der Beamer-Ansicht. Die Beamer-Ansicht folgt automatisch der Phase, die du hier einstellst.')))),
  ];
}

function collectEl() {
  return h('div', { class: 'card' },
    h('div', { style: 'font-size:56px; font-weight:600; line-height:1' }, state.count),
    h('p', {}, state.count === 1 ? 'Beitrag eingegangen' : 'Beiträge eingegangen'),
    h('p', { class: 'small muted' },
      'Solange die Sammlung läuft, siehst auch du keine Inhalte. Das kannst du der Gruppe so sagen.'));
}

function entryTools(e) {
  const select = h('select', {
    'aria-label': 'Beitrag verschieben',
    onchange: (ev) => act(() => post(`/entries/${e.id}`, { clusterId: ev.target.value || null })),
  },
    h('option', { value: '', selected: !e.clusterId }, 'Ohne Cluster'),
    state.clusters.map((c) => h('option', { value: c.id, selected: c.id === e.clusterId }, c.title)));
  return h('div', { class: 'tools no-print' },
    h('span', { class: 'small muted' }, 'Verschieben nach'), select,
    h('button', {
      class: 'quiet', onclick: () => act(() => post(`/entries/${e.id}`, { hidden: !e.hidden })),
    }, e.hidden ? 'Wieder einblenden' : 'Ausblenden'),
    e.hidden && h('span', { class: 'small' }, 'Ausgeblendet: für die Gruppe nicht sichtbar'));
}

function clusterEl(c) {
  const entries = state.entries.filter((e) => e.clusterId === c.id);
  const others = state.clusters.filter((o) => o.id !== c.id);
  const focused = state.focus === c.id;
  return h('section', { class: 'mod-cluster' },
    h('div', { class: 'head' },
      h('input', {
        type: 'text', value: c.title, maxLength: 80, 'aria-label': 'Cluster-Titel', ...track,
        onchange: (ev) => { typing = false; return act(() => post(`/clusters/${c.id}`, { title: ev.target.value })); },
      }),
      others.length > 0 && h('select', {
        'aria-label': 'Cluster zusammenlegen',
        onchange: (ev) => {
          if (ev.target.value) act(() => post(`/clusters/${c.id}`, { mergeInto: ev.target.value }));
        },
      },
        h('option', { value: '' }, 'Zusammenlegen mit …'),
        others.map((o) => h('option', { value: o.id }, o.title))),
      h('button', {
        class: 'quiet',
        onclick: () => {
          if (confirm(`Cluster „${c.title}“ auflösen? Die Beiträge bleiben erhalten und stehen dann ohne Cluster da.`)) {
            act(() => api(`${base}/clusters/${c.id}`, { method: 'DELETE' }));
          }
        },
      }, 'Auflösen'),
      state.phase === 'reveal' && h('button', {
        class: focused ? '' : 'secondary',
        onclick: () => act(() => post('/focus', { clusterId: focused ? null : c.id })),
      }, focused ? 'Auf Beamer groß (beenden)' : 'Auf Beamer groß zeigen')),
    h('div', { class: 'meta small muted', style: 'margin-top:6px' },
      plural(entries.length, 'Beitrag', 'Beiträge'),
      state.points && ` · ${plural(state.points[c.id] || 0, 'Punkt', 'Punkte')}`),
    entries.map((e) => entryEl(e, entryTools(e))));
}

function boardEl() {
  const loose = state.entries.filter((e) => !e.clusterId);
  const visible = state.entries.filter((e) => !e.hidden).length;
  const newTitle = h('input', { type: 'text', placeholder: 'Titel für neuen Cluster', maxLength: 80, 'aria-label': 'Titel für neuen Cluster', ...track });
  const aiButton = h('button', {
    class: busy ? 'busy' : '',
    disabled: busy || !state.aiAvailable || visible < state.minForAi,
    onclick: async () => {
      if (state.clusters.length && !confirm('Die bestehenden Cluster werden durch den KI-Vorschlag ersetzt. Fortfahren?')) return;
      busy = true;
      render();
      await act(() => post('/autocluster'));
      busy = false;
      render();
    },
  }, busy ? 'KI clustert' : 'Mit KI clustern');

  return [
    state.phase === 'review' && h('div', { class: 'card no-print' },
      h('div', { class: 'row' }, aiButton,
        h('form', {
          class: 'row grow',
          onsubmit: (ev) => {
            ev.preventDefault();
            typing = false;
            if (newTitle.value.trim()) act(() => post('/clusters', { title: newTitle.value }));
          },
        }, h('div', { class: 'grow' }, newTitle), h('button', { class: 'secondary', type: 'submit' }, 'Cluster anlegen'))),
      !state.aiAvailable && h('p', { class: 'small muted', style: 'margin:10px 0 0' },
        'KI-Clustering ist nicht eingerichtet (ANTHROPIC_API_KEY fehlt). Manuelles Clustern funktioniert.'),
      state.aiAvailable && visible < state.minForAi && h('p', { class: 'small muted', style: 'margin:10px 0 0' },
        `Unter ${state.minForAi} Beiträgen wird nicht geclustert. Die Beiträge erscheinen als Liste.`),
      h('p', { class: 'small muted', style: 'margin:10px 0 0' },
        'Die Gruppe sieht noch nichts. Beiträge ohne Cluster landen bei der Freigabe automatisch unter „Weitere Themen“.')),
    state.phase !== 'review' && h('p', { class: 'small muted no-print' },
      'Die Beiträge sind für die Gruppe sichtbar. Änderungen wirken sofort auf Beamer und Smartphones.'),
    state.phase === 'vote' && h('div', { class: 'notice' },
      `${plural(state.ballots, 'Person hat', 'Personen haben')} bisher abgestimmt. Das Ergebnis erscheint, wenn du die Abstimmung schließt.`),
    state.phase === 'result' && [h('h2', {}, 'Ergebnis'), h('div', { class: 'bar' }),
      rankEl(state.clusters.map((c) => ({ ...c, points: state.points[c.id] || 0 }))),
      h('p', { class: 'small muted' }, `${plural(state.ballots, 'Person hat', 'Personen haben')} abgestimmt.`)],
    loose.length > 0 && h('section', { class: 'mod-cluster loose' },
      h('strong', {}, `Ohne Cluster (${loose.length})`),
      loose.map((e) => entryEl(e, entryTools(e)))),
    state.clusters.map(clusterEl),
    !state.entries.length && h('p', { class: 'muted' }, 'Es sind keine Beiträge eingegangen.'),
  ];
}

function footerEl() {
  return h('div', { class: 'card no-print', style: 'margin-top:36px' },
    h('strong', {}, 'Dokumentation und Daten'),
    h('div', { class: 'row', style: 'margin-top:10px' },
      state.phase !== 'collect' && [
        h('a', { class: 'btn secondary', href: `${base}/export.md` }, 'Export Markdown'),
        h('a', { class: 'btn secondary', href: `${base}/export.csv` }, 'Export CSV (Excel)')],
      h('button', {
        class: 'danger',
        onclick: async () => {
          if (!confirm('Session mit allen Beiträgen endgültig löschen? Das lässt sich nicht rückgängig machen.')) return;
          await api(base, { method: 'DELETE' });
          location.href = '/admin';
        },
      }, 'Session löschen')),
    h('p', { class: 'small muted', style: 'margin:10px 0 0' },
      'Ausgeblendete Beiträge sind im Export nicht enthalten. Ohne Löschung wird die Session 30 Tage nach dem Anlegen automatisch entfernt.'));
}

function render() {
  if (!state) return;
  app.replaceChildren(h('main', { class: 'page wide' },
    headerEl(),
    state.phase === 'collect' ? collectEl() : boardEl(),
    footerEl()));
}

poller = poll(base, (s) => {
  state = s;
  // Nicht neu zeichnen, während gerade ein Titel getippt wird.
  if (typing) return;
  render();
}, (e) => {
  if (e.status === 401) location.href = '/admin';
  if (e.status === 404) {
    app.replaceChildren(h('main', { class: 'page' },
      h('h1', {}, 'Diese Session gibt es nicht (mehr).'), h('div', { class: 'bar' }),
      h('a', { class: 'btn', href: '/admin' }, 'Zur Übersicht')));
  }
});
