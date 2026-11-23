import { h, poll, sessionId, entryEl, rankEl, plural } from '/assets/common.js';

const id = sessionId();
const app = document.getElementById('app');
const joinUrl = `${location.host}/s/${id}`;

function stage(title, body, foot, scroll = false) {
  app.replaceChildren(
    h('main', { class: 'stage' },
      h('h1', {}, title),
      h('div', { class: 'bar' }),
      h('div', { class: `body${scroll ? ' scroll' : ''}` }, body),
      foot && h('div', { class: 'foot' }, foot),
      h('img', { class: 'logo', src: '/assets/img/dec-logo.png', alt: 'Dehn Consulting' })));
}

const qr = () => h('div', { class: 'qr' },
  h('img', { src: `/api/s/${id}/qr.svg`, alt: 'QR-Code zur Teilnahme' }),
  h('div', { class: 'url' }, joinUrl));

function render(s) {
  if (s.phase === 'collect') {
    return stage(s.question,
      h('div', { class: 'collect' },
        h('div', {},
          h('p', {}, 'Scanne den QR-Code und schreibe anonym, was aus deiner Sicht auf den Tisch gehört.'),
          h('ul', { class: 'steps3' },
            h('li', {}, h('b', {}, 'Wahrnehmung'), 'Was beobachte ich konkret?'),
            h('li', {}, h('b', {}, 'Wirkung'), 'Was macht das mit mir oder unserer Arbeit?'),
            h('li', {}, h('b', {}, 'Wunsch'), 'Was wünsche ich mir stattdessen?')),
          h('p', { class: 'muted' }, 'Es werden weder Name noch Gerät gespeichert. ',
            'Die Beiträge werden erst sichtbar, wenn die Sammlung geschlossen ist.'),
          h('div', { class: 'big-count' }, s.count),
          h('div', { class: 'muted' }, s.count === 1 ? 'Beitrag eingegangen' : 'Beiträge eingegangen')),
        qr()));
  }
  if (s.phase === 'review') {
    return stage(s.question,
      h('div', {},
        h('div', { class: 'big-count' }, s.count),
        h('p', { class: 'muted' }, s.count === 1 ? 'Beitrag eingegangen.' : 'Beiträge eingegangen.',
          ' Die Sammlung ist geschlossen, die Beiträge werden gleich gemeinsam angeschaut.')));
  }
  if (s.phase === 'reveal') {
    const focus = s.clusters.find((c) => c.id === s.focus);
    if (focus) {
      return stage(focus.title,
        h('div', { class: 'focus' },
          h('div', { class: 'entries' }, focus.entries.map((e) => entryEl(e)))),
        plural(focus.entries.length, 'Beitrag', 'Beiträge'), true);
    }
    return stage(s.question,
      h('div', { class: 'board', style: `--cols:${Math.min(4, Math.max(2, s.clusters.length))}` },
        s.clusters.map((c) => h('section', { class: 'cluster' },
          h('h2', {}, c.title),
          c.entries.map((e) => entryEl(e))))),
      `${plural(s.clusters.reduce((n, c) => n + c.entries.length, 0), 'Beitrag', 'Beiträge')} in ${plural(s.clusters.length, 'Thema', 'Themen')}`, true);
  }
  if (s.phase === 'vote') {
    return stage('Worüber sprechen wir zuerst?',
      h('div', { class: 'collect' },
        h('div', {},
          h('p', {}, `Verteile ${s.votesPerPerson} Punkte auf deinem Smartphone.`),
          h('div', { class: 'vote-list' }, s.clusters.map((c) => h('div', {}, c.title)))),
        qr()),
      `${plural(s.ballots, 'Person hat', 'Personen haben')} abgestimmt`);
  }
  stage('Worüber sprechen wir zuerst?', rankEl(s.clusters),
    `${plural(s.ballots, 'Person hat', 'Personen haben')} abgestimmt`);
}

poll(`/api/s/${id}/state`, render, (e) => {
  if (e.status === 404) stage('Diese Session gibt es nicht (mehr).', null);
});
