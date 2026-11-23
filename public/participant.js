import { h, api, poll, sessionId, entryEl, rankEl, plural } from '/assets/common.js';

const id = sessionId();
const app = document.getElementById('app');
let state = null;
let sent = false; // Bestätigung nach dem Absenden zeigen
let draft = { wahrnehmung: '', wirkung: '', wunsch: '' };

// Abstimmung: das Token entsteht erst hier, lokal im Browser, und hat
// keinerlei Verbindung zu eingereichten Beiträgen.
const store = {
  get(k) { try { return localStorage.getItem(`klartext:${id}:${k}`); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`klartext:${id}:${k}`, v); } catch {} },
};
let alloc = {};
try { alloc = JSON.parse(store.get('alloc') || '{}'); } catch {}
let voteSaved = store.get('voted') === '1';
let memToken = null;
function voteToken() {
  let t = store.get('token') || memToken;
  if (!t) {
    t = crypto.randomUUID();
    memToken = t;
    store.set('token', t);
  }
  return t;
}

const FIELDS = [
  {
    key: 'wahrnehmung', label: 'Wahrnehmung', required: true,
    hint: 'Was beobachte ich konkret?',
    example: 'Mir fällt auf, dass Entscheidungen aus dem Jour fixe oft später wieder aufgemacht werden.',
  },
  {
    key: 'wirkung', label: 'Wirkung',
    hint: 'Was macht das mit mir oder mit unserer Arbeit?',
    example: 'Das führt bei mir dazu, dass ich Zusagen nicht mehr ernst nehme und keinen Fokus in meiner Arbeit habe.',
  },
  {
    key: 'wunsch', label: 'Wunsch',
    hint: 'Was wünsche ich mir stattdessen?',
    example: 'Ich wünsche mir, dass wir klären, wann eine Entscheidung gilt.',
  },
];

function shell(...content) {
  app.replaceChildren(
    h('main', { class: 'page' },
      h('div', { class: 'brand' },
        h('img', { src: '/assets/img/dec-logo.png', alt: 'Dehn Consulting' }),
        h('span', { class: 'tag' }, state?.title || '')),
      content));
}

function header(sub) {
  return [
    h('h1', {}, state.question),
    h('div', { class: 'bar' }),
    sub && h('p', { class: 'muted' }, sub),
  ];
}

function viewForm() {
  const error = h('p', { class: 'error', hidden: true, role: 'alert' });
  const button = h('button', { class: 'block', type: 'submit' }, 'Anonym absenden');
  const form = h('form', {
    onsubmit: async (ev) => {
      ev.preventDefault();
      error.hidden = true;
      if (!draft.wahrnehmung.trim()) {
        error.textContent = 'Bitte fülle mindestens das Feld „Wahrnehmung“ aus.';
        error.hidden = false;
        return;
      }
      button.disabled = true;
      try {
        await api(`/api/s/${id}/entries`, { method: 'POST', body: draft });
        draft = { wahrnehmung: '', wirkung: '', wunsch: '' };
        sent = true;
        render();
      } catch (e) {
        error.textContent = e.message;
        error.hidden = false;
        button.disabled = false;
      }
    },
  },
    FIELDS.map((f) => h('div', { class: 'field' },
      h('label', { for: f.key }, f.label, ' ',
        !f.required && h('span', { class: 'opt' }, '(optional, empfohlen)')),
      h('div', { class: 'hint' }, f.hint),
      h('textarea', {
        id: f.key, maxLength: 1000, value: draft[f.key], required: f.required,
        oninput: (ev) => { draft[f.key] = ev.target.value; },
      }),
      h('div', { class: 'example' }, `Beispiel: „${f.example}“`))),
    h('p', { class: 'small muted' }, 'Beschreibe Verhalten und Situationen, nenne keine Namen.'),
    error, button);

  shell(header(),
    h('div', { class: 'notice small' },
      'Dein Beitrag ist anonym. Es werden weder Name noch Gerät gespeichert. ',
      'Sichtbar wird er erst, wenn die Sammlung geschlossen ist.'),
    form);
}

function viewSent() {
  shell(header(),
    h('div', { class: 'notice' }, h('strong', {}, 'Danke, dein Beitrag ist eingegangen.'),
      h('div', { class: 'small muted' }, 'Er wird sichtbar, sobald die Sammlung geschlossen ist.')),
    h('button', { class: 'block', onclick: () => { sent = false; render(); } },
      'Weiteren Beitrag schreiben'));
}

function viewWait() {
  shell(header('Die Sammlung ist geschlossen. Die Beiträge werden gleich gemeinsam angeschaut.'),
    h('div', { class: 'card' }, plural(state.count, 'Beitrag ist', 'Beiträge sind'), ' eingegangen.'));
}

function clustersEl() {
  return state.clusters.map((c) => h('section', { class: 'cluster' },
    h('h2', {}, c.title),
    h('div', { class: 'meta' }, plural(c.entries.length, 'Beitrag', 'Beiträge')),
    c.entries.map((e) => entryEl(e))));
}

function viewReveal() {
  shell(header(), clustersEl());
}

function viewVote() {
  const ids = new Set(state.clusters.map((c) => c.id));
  for (const k of Object.keys(alloc)) if (!ids.has(k)) delete alloc[k];
  const used = () => Object.values(alloc).reduce((a, b) => a + b, 0);
  const left = () => state.votesPerPerson - used();
  const error = h('p', { class: 'error', hidden: true, role: 'alert' });

  const change = (cid, d) => {
    const n = (alloc[cid] || 0) + d;
    if (n < 0 || (d > 0 && left() <= 0)) return;
    alloc[cid] = n;
    voteSaved = false;
    store.set('alloc', JSON.stringify(alloc));
    store.set('voted', '0');
    viewVote();
  };

  const submit = h('button', { class: 'block', disabled: used() === 0 || voteSaved }, voteSaved
    ? 'Deine Punkte sind abgegeben'
    : 'Punkte abgeben');
  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      await api(`/api/s/${id}/vote`, { method: 'POST', body: { token: voteToken(), allocations: alloc } });
      voteSaved = true;
      store.set('voted', '1');
      viewVote();
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      submit.disabled = false;
    }
  });

  shell(
    h('h1', {}, 'Worüber sprechen wir zuerst?'),
    h('div', { class: 'bar' }),
    h('p', { class: 'muted' },
      `Verteile ${state.votesPerPerson} Punkte auf die Themen. Mehrere Punkte auf ein Thema sind möglich.`),
    state.clusters.map((c) => h('div', { class: 'vote-row' },
      h('span', { class: 'title' }, c.title),
      h('div', { class: 'stepper' },
        h('button', {
          class: 'secondary', 'aria-label': `Punkt entfernen: ${c.title}`,
          disabled: !alloc[c.id], onclick: () => change(c.id, -1),
        }, '−'),
        h('span', { class: 'n' }, alloc[c.id] || 0),
        h('button', {
          'aria-label': `Punkt vergeben: ${c.title}`,
          disabled: left() <= 0, onclick: () => change(c.id, 1),
        }, '+')))),
    h('div', { class: 'sticky' },
      h('p', { class: 'small muted' },
        voteSaved
          ? 'Du kannst deine Punkte ändern, bis die Abstimmung geschlossen wird.'
          : `Noch ${plural(left(), 'Punkt', 'Punkte')} zu vergeben.`),
      error, submit),
    h('details', { class: 'small' }, h('summary', {}, 'Beiträge noch einmal lesen'), clustersEl()));
}

function viewResult() {
  shell(
    h('h1', {}, 'Ergebnis'),
    h('div', { class: 'bar' }),
    h('p', { class: 'muted' }, `${plural(state.ballots, 'Person hat', 'Personen haben')} abgestimmt.`),
    rankEl(state.clusters),
    h('details', { class: 'small' }, h('summary', {}, 'Beiträge noch einmal lesen'), clustersEl()));
}

function render() {
  if (!state) return;
  if (state.phase === 'collect') return sent ? viewSent() : viewForm();
  sent = false;
  if (state.phase === 'review') return viewWait();
  if (state.phase === 'reveal') return viewReveal();
  if (state.phase === 'vote') return viewVote();
  return viewResult();
}

let last = '';
poll(`/api/s/${id}/state`, (s) => {
  const prev = state;
  state = s;
  // Während der Sammlung ändert sich nur der Zähler: Formular nicht neu
  // aufbauen, sonst ginge beim Tippen der Fokus verloren.
  const key = s.phase === 'collect' ? 'collect' : `${s.phase}:${s.version}`;
  if (key === last && prev) return;
  // Stimmen kommen laufend herein; die eigene Auswahl dabei nicht neu zeichnen.
  if (s.phase === 'vote' && prev?.phase === 'vote' &&
      JSON.stringify(prev.clusters) === JSON.stringify(s.clusters)) return;
  last = key;
  render();
}, (e) => {
  if (e.status === 404) {
    app.replaceChildren(h('main', { class: 'page' },
      h('h1', {}, 'Diese Session gibt es nicht (mehr).'), h('div', { class: 'bar' })));
  }
});
