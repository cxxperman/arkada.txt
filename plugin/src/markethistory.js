// Arkada, the totals of the Community Market history (steamcommunity.com/market/history): how much you have
// bought and sold on the market altogether, and how many times. Written for Arkada from what Augmented Steam
// shows; no code taken from it.
//
// Runs in the history page itself (webkit.js): knows the page, not Steam.
//   const m = createMarketHistory({ win, storage, fetch, tokens });   m.stop();
//
// Data: Steam's own market/myhistory/render (the history the page shows, as JSON with HTML rows), read
// only when the user presses «Посчитать», PAGE_SIZE rows a request, one request at a time no sooner than
// EVERY_MS after the previous one; 429 → waits BACKOFF_MS once, then stops. A row is a purchase when Steam
// marks it «+», a sale when «−»; listings put up or taken down are not counted. The totals are kept a day in
// the page's localStorage and shown at once next time, with «Пересчитать».
//
// Where: under the page's tabs (the link «История операций», a[href="history"]). The page is drawn by React:
// a light timer (EVERY_MS, one isConnected check) puts the card back; no DOM watcher.
'use strict';
const web = require('./web.js');

const ID = 'arkada-market-history';
const KEY = 'arkada.market.history';
const PAGE = /^\/market\/history\/?$/i;
const PAGE_SIZE = 100;
const EVERY_MS = 2000;
const BACKOFF_MS = 60 * 1000;
const MAX_ROWS = 20000;

// One page of results_html → [{ sign: '+' | '-', text }]
function rowsOf(html) {
  const out = [];
  const parts = String(html || '').split(/class="market_listing_row\b/).slice(1);
  for (const p of parts) {
    const g = /market_listing_gainorloss"\s*>\s*([+-])\s*</.exec(p);
    const price = /class="market_listing_price"\s*>\s*([^<]*?)\s*</.exec(p);
    if (!g || !price) continue;
    out.push({ sign: g[1], text: price[1].replace(/&nbsp;/g, ' ').trim() });
  }
  return out;
}
function totals(rows) {
  const t = { bought: 0, sold: 0, nBought: 0, nSold: 0, sample: '' };
  for (const r of rows) {
    const v = web.parseMoney(r.text);
    if (v == null) continue;
    if (!t.sample) t.sample = r.text;
    if (r.sign === '+') { t.bought += v; t.nBought++; } else { t.sold += v; t.nSold++; }
  }
  t.bought = Math.round(t.bought * 100) / 100;
  t.sold = Math.round(t.sold * 100) / 100;
  return t;
}

function createMarketHistory(o) {
  const win = o.win, doc = win.document;
  const get = o.fetch || (typeof win.fetch === 'function' ? (u, i) => win.fetch(u, i) : null);
  const now = o.now || (() => Date.now());
  const cache = web.createCache(o.storage || null, '', now);
  const h = web.builder(doc);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const path = String(win.location && win.location.pathname || '');
  let stopped = false, card = null, timer = null, busy = false;
  let state = { result: cache.get(KEY, 24 * 60 * 60 * 1000) || null, at: cache.at(KEY), progress: '', error: '' };

  async function page(start) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await get('/market/myhistory/render/?query=&start=' + start + '&count=' + PAGE_SIZE, { credentials: 'include' });
      if (r && r.status === 429 && attempt === 0) { state.progress = 'Steam попросил подождать — продолжу через минуту…'; draw(); await wait(o.backoffMs || BACKOFF_MS); continue; }
      if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status));
      const j = await r.json();
      if (!j || !j.success) throw new Error('no history');
      return j;
    }
    throw new Error('429');
  }

  async function count() {
    if (busy || stopped) return;
    busy = true;
    state.error = '';
    const rows = [];
    try {
      let start = 0, total = Infinity;
      while (start < total && start < MAX_ROWS && !stopped) {
        if (start > 0) await wait(o.everyMs || EVERY_MS);
        state.progress = 'Читаю историю: ' + start + (isFinite(total) ? ' из ' + total : '') + '…';
        draw();
        const j = await page(start);
        total = Number(j.total_count) || 0;
        const got = rowsOf(j.results_html);
        for (const r of got) rows.push(r);
        start += PAGE_SIZE;
        if (!String(j.results_html || '').includes('market_listing_row')) break;
      }
      if (stopped) return;
      state.result = Object.assign(totals(rows), { rows: total === Infinity ? rows.length : total });
      state.at = now();
      cache.set(KEY, state.result);
    } catch (e) {
      state.error = 'Не получилось прочитать историю (' + String(e && e.message || e) + '). Попробуйте позже.';
    }
    busy = false;
    state.progress = '';
    draw();
  }

  function build() {
    const box = h('div', 'arkada-card');
    box.id = ID;
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Итоги истории операций');
    const btn = h('button', 'arkada-card-btn', busy ? 'Считаю…' : state.result ? 'Пересчитать' : 'Посчитать');
    btn.setAttribute('type', 'button');
    btn.disabled = busy;
    btn.addEventListener('click', () => { count(); });
    box.appendChild(h('div', 'arkada-card-head', h('span', 'arkada-card-title', 'Итоги истории'), btn));
    const r = state.result;
    if (r) {
      const money = v => web.formatLike(r.sample, v);
      const row = (cap, val) => h('div', 'arkada-card-row', h('span', 'arkada-card-cap', cap), h('span', 'arkada-card-val', val));
      box.appendChild(row('Куплено', money(r.bought) + ' · ' + r.nBought + ' ' + web.plural(r.nBought, 'покупка', 'покупки', 'покупок')));
      box.appendChild(row('Продано', money(r.sold) + ' · ' + r.nSold + ' ' + web.plural(r.nSold, 'продажа', 'продажи', 'продаж')));
      const diff = Math.round((r.sold - r.bought) * 100) / 100;
      box.appendChild(row('Продано минус куплено', money(diff)));
      let when = '';
      try { when = new Date(state.at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }); } catch (e) { }
      box.appendChild(h('div', 'arkada-card-note', 'Суммы — цены из вашей истории операций Steam, как она их показывает' + (when ? '; посчитано ' + when : '') + '.'));
    } else if (!state.progress) {
      box.appendChild(h('div', 'arkada-card-hint', 'Сколько вы купили и продали на Торговой площадке за всё время. Arkada прочитает историю операций — по 100 строк раз в 2 секунды.'));
    }
    if (state.progress) box.appendChild(h('div', 'arkada-card-sub', state.progress));
    if (state.error) box.appendChild(h('div', 'arkada-card-hint', state.error));
    return box;
  }

  function draw() {
    if (stopped) return;
    const box = build();
    if (card && card.parentNode) { card.parentNode.insertBefore(box, card); card.remove(); card = box; return; }
    card = box;
    place();
  }

  function place() {
    if (stopped || !card) return;
    if (String(win.location && win.location.pathname || '') !== path) { try { card.remove(); } catch (e) { } return; }
    if (card.isConnected) return;
    const tab = doc.querySelector('a[href="history"]');
    const bar = tab && tab.parentNode;
    if (!bar || !bar.parentNode) return;
    web.ensureStyle(doc, o.tokens);
    bar.parentNode.insertBefore(card, bar.nextSibling);
  }

  const loc = win.location || {};
  if (String(loc.hostname).toLowerCase() === 'steamcommunity.com' && PAGE.test(path) && get && !web.switchedOff(win, 'market')) {
    card = build();
    place();
    timer = setInterval(place, o.placeMs || EVERY_MS);
  }

  return {
    state: () => state,
    count,
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (card) try { card.remove(); } catch (e) { }
      web.dropStyle(doc);
    },
  };
}

module.exports = { createMarketHistory, rowsOf, totals, ID };
