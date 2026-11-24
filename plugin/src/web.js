// Arkada, what the modules of the store and community pages share (webkit.js): the feature switch on the
// page's <html>, a cache in the page's localStorage, a queue that keeps to a rate, money as Steam writes it,
// a small element builder and one style sheet of cards in the look of Windows 11 on the dev.txt tokens.
// Knows nothing of Steam's client; runs in the page.
'use strict';

const STYLE_ID = 'arkada-web-style';

// The theme's switch of a feature: --arkada-<name> on the page's <html> says 'off' (overlay/options/feature-<name>-off.css)
function switchedOff(win, name) {
  try {
    const v = win.getComputedStyle(win.document.documentElement).getPropertyValue('--arkada-' + name);
    return String(v || '').trim().replace(/^["']|["']$/g, '').toLowerCase() === 'off';
  } catch (e) { return false; }
}

// One JSON value per key in the page's localStorage, with the time it was written
function createCache(storage, prefix, now) {
  const time = now || (() => Date.now());
  return {
    get(key, maxMs) {
      try {
        const v = JSON.parse((storage && storage.getItem(prefix + key)) || 'null');
        if (!v || typeof v !== 'object' || typeof v.at !== 'number') return undefined;
        if (maxMs && time() - v.at > maxMs) return undefined;
        return v.v;
      } catch (e) { return undefined; }
    },
    at(key) { try { const v = JSON.parse((storage && storage.getItem(prefix + key)) || 'null'); return v && typeof v.at === 'number' ? v.at : 0; } catch (e) { return 0; } },
    set(key, v) { try { if (storage) storage.setItem(prefix + key, JSON.stringify({ at: time(), v })); } catch (e) { /* full or closed: asked again next time */ } },
  };
}

// Jobs one at a time, the next no sooner than everyMs after the previous one started. A job returns a Promise;
// pause(ms) holds the queue (Steam answered 429). stop() drops what is left.
function createQueue(o) {
  const everyMs = o.everyMs, later = o.setTimeout || setTimeout, cancel = o.clearTimeout || clearTimeout;
  const now = o.now || (() => Date.now());
  const jobs = [];
  let busy = false, last = -Infinity, holdUntil = 0, timer = null, stopped = false;
  function next() {
    timer = null;
    if (stopped || busy || !jobs.length) return;
    const wait = Math.max(last + everyMs, holdUntil) - now();
    if (wait > 0) { timer = later(next, wait); return; }
    const job = jobs.shift();
    busy = true;
    last = now();
    Promise.resolve().then(job).catch(() => { }).then(() => { busy = false; if (!timer) next(); });
  }
  return {
    push(job) { if (!stopped) { jobs.push(job); if (!timer && !busy) next(); } },
    pause(ms) { holdUntil = Math.max(holdUntil, now() + ms); },
    size: () => jobs.length + (busy ? 1 : 0),
    clear() { jobs.length = 0; },
    stop() { stopped = true; jobs.length = 0; if (timer) cancel(timer); timer = null; },
  };
}

// '1 234,56₴', '$12.99', '12,-€', '23₴', 'ARS$ 1.234,56' → the number, or null
function parseMoney(text) {
  const s = String(text || '').replace(/[\s  ]/g, '');
  const m = /\d[\d.,']*/.exec(s);
  if (!m) return null;
  let n = m[0].replace(/[.,']+$/, '').replace(/'/g, '');
  const lastDot = n.lastIndexOf('.'), lastComma = n.lastIndexOf(',');
  const sep = Math.max(lastDot, lastComma);
  if (sep >= 0) {
    const tail = n.length - sep - 1, both = lastDot >= 0 && lastComma >= 0;
    // Both kinds: the last one is the decimal point. One kind, more than once or with three digits after it: thousands
    if (!both && (n.split(n[sep]).length > 2 || tail === 3)) n = n.split(n[sep]).join('');
    else n = n.slice(0, sep).replace(/[.,]/g, '') + '.' + n.slice(sep + 1);
  }
  const v = Number(n);
  return isFinite(v) ? v : null;
}

// The value written the way a sample price of the same currency is written: '23₴' + 1234.5 → '1 234,50₴'
function formatLike(sample, value) {
  const s = String(sample || '').trim();
  const m = /\d[\d\s  .,']*\d|\d/.exec(s);
  const v = Math.round((Number(value) || 0) * 100) / 100;
  if (!m) return v.toFixed(2);
  const num = m[0];
  const decimals = /[.,]\d{1,2}$/.exec(num);
  // The decimal point: the sample's own; without one, the opposite of its thousands separator, else as dollars or euros write it
  let dec = decimals ? decimals[0][0] : /\d\.\d{3}/.test(num) ? ',' : /\d,\d{3}/.test(num) ? '.' : /[$£¥]/.test(s) ? '.' : ',';
  const group = dec === ',' ? (/\d\.\d{3}/.test(num) ? '.' : ' ') : (/\d,\d{3}/.test(num) || /[$£¥]/.test(s) ? ',' : ' ');
  const whole = Math.floor(Math.abs(v)), cents = Math.round((Math.abs(v) - whole) * 100);
  let out = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, group);
  if (cents || decimals) out += dec + String(cents).padStart(2, '0');
  return (v < 0 ? '−' : '') + s.slice(0, m.index) + out + s.slice(m.index + num.length);
}

// 1 игра, 2 игры, 5 игр
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
}

// h('div', 'cls', child, 'text', …) in the page's document
function builder(doc) {
  return function h(tag, cls, ...kids) {
    const el = doc.createElement(tag);
    if (cls) el.className = cls;
    for (const k of kids) if (k !== null && k !== undefined && k !== false) el.appendChild(typeof k === 'string' ? doc.createTextNode(k) : k);
    return el;
  };
}
// A link that leaves the page: a new window, no opener, only https
function link(doc, text, href, title) {
  const a = doc.createElement('a');
  a.className = 'arkada-card-link';
  a.textContent = text;
  if (/^https:\/\//.test(href)) a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  if (title) a.title = title;
  return a;
}

// The cards of these modules: one sheet per page, scoped to .arkada-card (the page's own styles do not reach in)
function styleText(tokens) {
  const t = tokens || {};
  return `
.arkada-card { ${t.base || ''}
  --ark-accent: var(--se-accent, var(--dt-accent));
  display: block; margin: 0 0 16px; padding: 12px 16px; border-radius: var(--dt-radius-block); border: 1px solid var(--dt-edge);
  background: color-mix(in srgb, var(--dt-raised) 88%, transparent); color: var(--dt-label);
  font-family: var(--dt-font-text); font-size: var(--dt-size-body); line-height: 20px; -webkit-font-smoothing: antialiased;
  text-align: left; letter-spacing: normal; text-transform: none; font-weight: normal; }
.arkada-card *, .arkada-card *::before, .arkada-card *::after { box-sizing: border-box; }
.se-app-summary__cell > .arkada-card { margin: 0; }
.arkada-card .arkada-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.arkada-card .arkada-card-title { font-family: var(--dt-font-display); font-size: var(--dt-size-heading); line-height: 24px; font-weight: 600; color: var(--dt-label); }
.arkada-card .arkada-card-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-height: 24px; }
.arkada-card .arkada-card-row + .arkada-card-row { margin-top: 2px; }
.arkada-card .arkada-card-cap { color: var(--dt-label-2); }
.arkada-card .arkada-card-val { color: var(--dt-label); font-variant-numeric: tabular-nums; text-align: right; }
.arkada-card .arkada-card-big { display: block; font-family: var(--dt-font-display); font-size: 20px; line-height: 28px; font-weight: 600; font-variant-numeric: tabular-nums; }
.arkada-card .arkada-card-good { color: var(--dt-green); }
.arkada-card.arkada-card-inline { grid-column: 1 / -1; max-width: 720px; margin: 12px 0 0; }
.arkada-card .arkada-card-stats { display: flex; flex-wrap: wrap; gap: 8px 32px; }
.arkada-card .arkada-card-stat { display: flex; flex-direction: column; min-width: 0; }
.arkada-card .arkada-card-sub { color: var(--dt-label-3); font-size: var(--dt-size-caption); }
.arkada-card .arkada-card-links { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 8px; }
.arkada-card .arkada-card-link { color: var(--ark-accent); text-decoration: none; cursor: pointer; }
.arkada-card .arkada-card-link:hover { text-decoration: underline; }
.arkada-card .arkada-card-note { margin-top: 8px; color: var(--dt-label-3); font-size: var(--dt-size-caption); line-height: 16px; }
.arkada-card .arkada-card-hint { margin-top: 8px; color: var(--dt-label-2); }
.arkada-card .arkada-card-form { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.arkada-card .arkada-card-input { flex: 1 1 200px; min-width: 0; height: 32px; padding: 0 10px; border: 1px solid var(--dt-edge); border-bottom-color: var(--dt-label-3);
  border-radius: var(--dt-radius-control); background: var(--dt-fill); color: var(--dt-label); font: inherit; outline: none; }
.arkada-card .arkada-card-input:focus { border-bottom: 2px solid var(--ark-accent); background: var(--dt-bg); }
.arkada-card .arkada-card-btn { height: 32px; padding: 0 12px; border: 1px solid var(--dt-edge); border-radius: var(--dt-radius-control); background: var(--dt-fill-2);
  color: var(--dt-label); font: inherit; cursor: default; transition: background var(--dt-dur-press) linear; }
.arkada-card .arkada-card-btn:hover { background: var(--dt-fill-press); }
.arkada-card .arkada-card-btn:disabled { color: var(--dt-label-3); background: var(--dt-fill); }
.arkada-card .arkada-card-btn.arkada-card-primary { background: var(--ark-accent); border-color: transparent; color: var(--dt-label); }
.arkada-card .arkada-card-btn:focus-visible, .arkada-card .arkada-card-link:focus-visible { outline: 2px solid var(--dt-label); outline-offset: 1px; }
.arkada-inv-price { ${t.base || ''}
  position: absolute; left: 2px; bottom: 2px; z-index: 2; max-width: calc(100% - 4px); padding: 0 4px; border-radius: var(--dt-radius-row);
  background: color-mix(in srgb, var(--dt-bg) 82%, transparent); color: var(--dt-label); pointer-events: none;
  font-family: var(--dt-font-text); font-size: 11px; line-height: 16px; font-variant-numeric: tabular-nums;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
${t.reduced ? '@media (prefers-reduced-motion: reduce) { .arkada-card { ' + t.reduced + ' } }' : ''}
`;
}
function ensureStyle(doc, tokens) {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = styleText(tokens);
  (doc.head || doc.documentElement).appendChild(s);
}
// The sheet goes with the last card of the page
function dropStyle(doc) {
  if (doc.querySelector('.arkada-card') || doc.querySelector('.arkada-inv-price')) return;
  const s = doc.getElementById(STYLE_ID);
  if (s) try { s.remove(); } catch (e) { }
}

// Where a card of a game's store page goes: with the theme (Steam Enhanced draws the page anew and hides Steam's
// own columns: <html class="se-app-summary-on">) at the top of the right column of its summary
// (.se-app-summary__cell, the last one); without it, where `legacy()` says ({ parent, before }). null: not yet
function appSlot(doc, legacy) {
  const html = doc.documentElement;
  if (html && html.classList && html.classList.contains('se-app-summary-on')) {
    const cells = doc.querySelectorAll('.se-app-summary__cell');
    const cell = cells[cells.length - 1];
    return cell ? { parent: cell, before: cell.firstChild } : null;
  }
  return legacy();
}
// Put a card at slot.before, after the cards of a lower data-arkada-order already there (Цены, then Об игре)
function insertOrdered(slot, card) {
  const order = Number(card.getAttribute('data-arkada-order')) || 0;
  let ref = slot.before;
  while (ref && ref.parentNode === slot.parent && ref.classList && ref.classList.contains('arkada-card') && (Number(ref.getAttribute('data-arkada-order')) || 0) <= order) ref = ref.nextSibling;
  slot.parent.insertBefore(card, ref || null);
}

// The settings Steam writes on a store or community page: <div id="application_config" data-userinfo='{…}'>
function userInfo(doc) {
  try {
    const el = doc.getElementById('application_config');
    const raw = el && (el.getAttribute('data-userinfo') || (el.dataset && el.dataset.userinfo));
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v : null;
  } catch (e) { return null; }
}

module.exports = { switchedOff, createCache, createQueue, parseMoney, formatLike, plural, builder, link, ensureStyle, dropStyle, appSlot, insertOrdered, userInfo, STYLE_ID };
