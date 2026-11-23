import { h, api, plural } from '/assets/common.js';

const app = document.getElementById('app');
const PHASE = { collect: 'Sammeln', review: 'Sichten', reveal: 'Freigabe', vote: 'Abstimmung', result: 'Ergebnis' };

function shell(...content) {
  app.replaceChildren(h('main', { class: 'page wide' },
    h('div', { class: 'brand' },
      h('img', { src: '/assets/img/dec-logo.png', alt: 'Dehn Consulting' }),
      h('span', { class: 'tag' }, 'Klartext Tool · Moderation')),
    content));
}

function viewLogin(message) {
  const error = h('p', { class: 'error', hidden: !message, role: 'alert' }, message);
  const pw = h('input', { type: 'password', id: 'pw', autocomplete: 'current-password', required: true });
  shell(
    h('h1', {}, 'Anmelden'), h('div', { class: 'bar' }),
    h('form', {
      class: 'card', style: 'max-width:420px',
      onsubmit: async (ev) => {
        ev.preventDefault();
        try {
          await api('/api/admin/login', { method: 'POST', body: { password: pw.value } });
          load();
        } catch (e) {
          error.textContent = e.message;
          error.hidden = false;
        }
      },
    },
      h('div', { class: 'field' }, h('label', { for: 'pw' }, 'Moderator-Passwort'), pw),
      error, h('button', { type: 'submit' }, 'Anmelden')));
  pw.focus();
}

function viewList({ sessions, defaultQuestion }) {
  const title = h('input', { type: 'text', id: 't', required: true, maxLength: 120, placeholder: 'z. B. Teamtag Vertrieb, 12.03.' });
  const question = h('textarea', { id: 'q', maxLength: 300, value: defaultQuestion });
  const votes = h('input', { type: 'number', id: 'v', min: 1, max: 10, value: 3 });
  const error = h('p', { class: 'error', hidden: true, role: 'alert' });

  shell(
    h('h1', {}, 'Sessions'), h('div', { class: 'bar' }),
    sessions.length
      ? h('table', {},
        h('thead', {}, h('tr', {}, ['Titel', 'Phase', 'Beiträge', 'Angelegt', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, sessions.map((s) => h('tr', {},
          h('td', {}, h('a', { href: `/m/${s.id}` }, h('strong', {}, s.title))),
          h('td', {}, PHASE[s.phase]),
          h('td', {}, s.count),
          h('td', {}, s.createdDay.split('-').reverse().join('.')),
          h('td', {}, h('a', { class: 'btn secondary', href: `/m/${s.id}` }, 'Öffnen'))))))
      : h('p', { class: 'muted' }, 'Noch keine Session angelegt.'),
    h('p', { class: 'small muted' }, 'Sessions werden 30 Tage nach dem Anlegen automatisch gelöscht.'),
    h('h2', { style: 'margin-top:36px' }, 'Neue Session'), h('div', { class: 'bar' }),
    h('form', {
      class: 'card',
      onsubmit: async (ev) => {
        ev.preventDefault();
        try {
          const r = await api('/api/admin/sessions', {
            method: 'POST',
            body: { title: title.value, question: question.value, votesPerPerson: Number(votes.value) },
          });
          location.href = `/m/${r.id}`;
        } catch (e) {
          error.textContent = e.message;
          error.hidden = false;
        }
      },
    },
      h('div', { class: 'field' }, h('label', { for: 't' }, 'Titel'),
        h('div', { class: 'hint' }, 'Für die Teilnehmenden sichtbar.'), title),
      h('div', { class: 'field' }, h('label', { for: 'q' }, 'Leitfrage'), question),
      h('div', { class: 'field', style: 'max-width:220px' },
        h('label', { for: 'v' }, 'Punkte pro Person'),
        h('div', { class: 'hint' }, 'Für die Priorisierung. 3 passt bis etwa 7 Themen.'), votes),
      error, h('button', { type: 'submit' }, 'Session anlegen')),
    h('p', {}, h('button', {
      class: 'quiet',
      onclick: async () => { await api('/api/admin/logout', { method: 'POST' }); viewLogin(); },
    }, 'Abmelden')));
}

async function load() {
  try {
    viewList(await api('/api/admin/sessions'));
  } catch (e) {
    viewLogin(e.status === 401 ? '' : e.message);
  }
}
load();
