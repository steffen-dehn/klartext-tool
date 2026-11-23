// Gemeinsame Helfer. DOM wird ausschließlich über textContent befüllt,
// Beitragstexte können also kein HTML einschleusen.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const sessionId = () => location.pathname.split('/')[2];

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new Error('Keine Verbindung. Bitte erneut versuchen.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Etwas ist schiefgelaufen.');
    err.status = res.status;
    throw err;
  }
  return data;
}

// Fragt den Stand alle 2 s ab; der Server antwortet mit "unchanged",
// solange sich nichts getan hat (wenig Daten, robust bei schlechtem WLAN).
export function poll(url, onState, onError) {
  let version = 0;
  let timer;
  const tick = async () => {
    try {
      const s = await api(`${url}?v=${version}`);
      if (!s.unchanged) {
        version = s.version;
        onState(s);
      }
    } catch (e) {
      onError?.(e);
    }
    timer = setTimeout(tick, document.hidden ? 6000 : 2000);
  };
  tick();
  return {
    refresh() {
      clearTimeout(timer);
      version = 0;
      tick();
    },
  };
}

export function entryEl(e, extra) {
  return h('div', { class: `entry${e.hidden ? ' is-hidden' : ''}` },
    h('dl', {},
      h('dt', {}, 'Wahrnehmung'), h('dd', {}, e.wahrnehmung),
      e.wirkung && [h('dt', {}, 'Wirkung'), h('dd', {}, e.wirkung)],
      e.wunsch && [h('dt', {}, 'Wunsch'), h('dd', {}, e.wunsch)],
    ),
    extra,
  );
}

export function rankEl(clusters) {
  const sorted = [...clusters].sort((a, b) => (b.points || 0) - (a.points || 0));
  const max = Math.max(1, ...sorted.map((c) => c.points || 0));
  return h('div', {}, sorted.map((c, i) =>
    h('div', { class: 'rank' },
      h('span', { class: 'pos' }, `${i + 1}.`),
      h('span', { class: 'title' }, c.title),
      h('span', { class: 'pts' }, `${c.points || 0} ${c.points === 1 ? 'Punkt' : 'Punkte'}`),
      h('div', { class: 'track' },
        h('div', { class: 'fill', style: `width:${((c.points || 0) / max) * 100}%` })),
    )));
}

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
