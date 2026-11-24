// Arkada, the sum of a wishlist in the Steam store: what all its games cost now, with today's discounts, what
// they would cost without them, and how many are on sale. Written for Arkada from what Augmented Steam shows;
// no code taken from it.
//
// Runs in the wishlist page itself (webkit.js): knows the page, not Steam.
//   const w = createWishlist({ win, storage, fetch, tokens });   w.stop();
//
// Data: Steam's own public Web API, the same the page itself uses, asked by the page (api.steampowered.com
// answers store.steampowered.com with CORS headers): IWishlistService/GetWishlist (the list's games) and
// IStoreBrowseService/GetItems (their price in the user's store: best_purchase_option), 100 games per request,
// one request at a time. The answer is kept in the page's localStorage for CACHE_MS. A private wishlist
// gives nothing, and nothing is shown.
//
// Where: under the list's title, in its block (the title's parent). The page is drawn by React and may draw its header again: a light timer
// (EVERY_MS, one isConnected check) puts the card back; no DOM watcher once the card is in.
'use strict';
const web = require('./web.js');

const ID = 'arkada-wishlist-sum';
const API = 'https://api.steampowered.com/';
const CACHE_MS = 30 * 60 * 1000;
const EVERY_MS = 1500;
const CHUNK = 100;
const PAGE = /^\/wishlist(?:\/(?:id\/[^/]+|profiles\/(\d{17})))?\/?$/i;

// The SSR data of the page: Steam's React pages keep their loaders' JSON in window.SSR.loaderData
function loaderData(win) {
  const out = [];
  try { for (const s of (win.SSR && win.SSR.loaderData) || []) { try { const v = typeof s === 'string' ? JSON.parse(s) : s; if (v && typeof v === 'object') out.push(v); } catch (e) { } } } catch (e) { }
  return out;
}

// Whose wishlist: the loader of the list ({ steamid, sort, filters }), else /wishlist/profiles/<id>, else the user (own list)
function ownerOf(win) {
  const data = loaderData(win);
  for (const v of data) if (/^\d{17}$/.test(String(v.steamid)) && ('sort' in v || 'filters' in v)) return String(v.steamid);
  const m = PAGE.exec(String(win.location && win.location.pathname || ''));
  if (m && m[1]) return m[1];
  if (m && /^\/wishlist\/?$/i.test(String(win.location.pathname))) {
    for (const v of data) if (/^\d{17}$/.test(String(v.steamid))) return String(v.steamid);
    const u = web.userInfo(win.document);
    if (u && /^\d{17}$/.test(String(u.steamid))) return String(u.steamid);
  }
  return null;
}
function contextOf(win) {
  for (const v of loaderData(win)) {
    const c = v.storeBrowseContext;
    if (c && /^[A-Z]{2}$/.test(String(c.country))) return { country_code: String(c.country), language: String(c.language || 'english') };
  }
  const u = web.userInfo(win.document);
  return { country_code: u && /^[A-Z]{2}$/.test(String(u.country_code)) ? String(u.country_code) : 'US', language: 'russian' };
}

// GetItems' store_items → { total, regular, priced, sale, free, sample }; cents as Steam gives them (strings)
function summarize(items) {
  const s = { total: 0, regular: 0, priced: 0, sale: 0, none: 0, sample: '' };
  for (const it of items) {
    const b = it && it.best_purchase_option;
    const final = b ? Number(b.final_price_in_cents) : NaN;
    if (!b || !isFinite(final)) { s.none++; continue; }
    const orig = Number(b.original_price_in_cents);
    s.total += final;
    s.regular += isFinite(orig) && orig > final ? orig : final;
    s.priced++;
    if (Number(b.discount_pct) > 0 || (isFinite(orig) && orig > final)) s.sale++;
    if (!s.sample && b.formatted_final_price) s.sample = String(b.formatted_final_price);
  }
  return s;
}

function createWishlist(o) {
  const win = o.win, doc = win.document;
  const get = o.fetch || (typeof win.fetch === 'function' ? (u, i) => win.fetch(u, i) : null);
  const cache = web.createCache(o.storage || null, 'arkada.wishlist.', o.now);
  const h = web.builder(doc);
  const path = String(win.location && win.location.pathname || '');
  let stopped = false, card = null, timer = null, sum = undefined;

  const json = url => Promise.resolve(get(url)).then(r => { if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status)); return r.json(); });

  async function load(owner) {
    const kept = cache.get(owner, CACHE_MS);
    if (kept) return kept;
    const list = await json(API + 'IWishlistService/GetWishlist/v1/?steamid=' + owner);
    const ids = ((list && list.response && list.response.items) || []).map(i => Number(i && i.appid)).filter(n => n > 0);
    const items = [];
    const context = contextOf(win);
    for (let i = 0; i < ids.length && !stopped; i += CHUNK) {
      const q = { ids: ids.slice(i, i + CHUNK).map(appid => ({ appid })), context: { language: context.language, country_code: context.country_code, steam_realm: 1 }, data_request: {} };
      const r = await json(API + 'IStoreBrowseService/GetItems/v1/?input_json=' + encodeURIComponent(JSON.stringify(q)));
      for (const it of (r && r.response && r.response.store_items) || []) items.push(it);
    }
    const s = Object.assign(summarize(items), { count: ids.length });
    cache.set(owner, s);
    return s;
  }

  function build(s) {
    const box = h('div', 'arkada-card arkada-card-inline');
    box.id = ID;
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Сумма списка желаемого');
    const money = cents => web.formatLike(s.sample, cents / 100);
    box.appendChild(h('div', 'arkada-card-head', h('span', 'arkada-card-title', 'Сумма списка'),
      h('span', 'arkada-card-sub', s.priced + ' ' + web.plural(s.priced, 'игра', 'игры', 'игр') + ' с ценой' + (s.none ? ', ' + s.none + ' без цены' : ''))));
    const stat = (value, cap, cls) => h('div', 'arkada-card-stat', h('span', 'arkada-card-big' + (cls ? ' ' + cls : ''), value), h('span', 'arkada-card-sub', cap));
    const grid = h('div', 'arkada-card-stats', stat(money(s.total), 'сейчас, со скидками'));
    if (s.regular > s.total) {
      grid.appendChild(stat(money(s.regular), 'без скидок'));
      grid.appendChild(stat(money(s.regular - s.total), 'экономия: ' + s.sale + ' ' + web.plural(s.sale, 'игра', 'игры', 'игр') + ' со скидкой', 'arkada-card-good'));
    }
    box.appendChild(grid);
    box.appendChild(h('div', 'arkada-card-note', 'Цены магазина Steam в вашем регионе, с сегодняшними скидками; без цены — ещё не вышедшие и бесплатные. Обновляется раз в 30 минут.'));
    return box;
  }

  function place() {
    if (stopped || !sum) return;
    if (String(win.location && win.location.pathname || '') !== path) { if (card) try { card.remove(); } catch (e) { } return; }
    if (card && card.isConnected) return;
    const title = doc.querySelector('h2');
    const at = title && title.parentNode;
    if (!at) return;
    web.ensureStyle(doc, o.tokens);
    card = card || build(sum);
    at.appendChild(card);
  }

  const owner = PAGE.test(path) && String(win.location.hostname).toLowerCase() === 'store.steampowered.com' ? ownerOf(win) : null;
  if (owner && get && !web.switchedOff(win, 'wishlist-sum')) {
    load(owner).then(s => { sum = s && s.priced > 0 ? s : null; }, () => { sum = null; }).then(() => {
      if (stopped || !sum) return;
      place();
      timer = setInterval(place, o.everyMs || EVERY_MS);
    });
  }

  return {
    sum: () => sum,
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

module.exports = { createWishlist, summarize, ownerOf, ID };
