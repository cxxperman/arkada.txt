// Arkada, prices in a Steam inventory (steamcommunity.com/…/inventory): next to every item that can be sold
// on the Community Market, its lowest price there now; above the inventory, what the items of the open
// game's inventory are worth together. Written for Arkada from what Augmented Steam shows; no code taken from it.
//
// Runs in the inventory page itself (webkit.js): knows the page, not Steam.
//   const v = createInventory({ win, storage, fetch, tokens });   v.stop();
//
// Data: Steam's own market/priceoverview (the price the inventory's sell dialog shows), asked by the page,
// for each kind of item once (market_hash_name), in the wallet's currency. Steam limits it hard, so:
// one request at a time, no sooner than EVERY_MS after the previous one; Steam says 429 → nothing for
// BACKOFF_MS (doubling, up to 10 minutes); a price is kept a day (CACHE_MS) in the page's localStorage, so
// opening the inventory again asks only for what is new. While the page is hidden nothing is asked.
// The items are Steam's own objects on the page (g_ActiveInventory, its m_rgAssets with their
// descriptions; the parts of the Steam inventory are its m_rgChildInventories): nothing reads layout.
// Which inventory is open is looked at every LOOK_MS (one comparison); no DOM watcher.
'use strict';
const web = require('./web.js');

const ID = 'arkada-inventory-value';
const PAGE = /^\/(?:id\/[^/]+|profiles\/\d{17})\/inventory\/?$/i;
const EVERY_MS = 1500;
const LOOK_MS = 1500;
const BACKOFF_MS = 60 * 1000;
const CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_KEPT = 4000;

// The items of the open inventory: [{ key, appid, name, amount, element }] — only what the market can sell
function itemsOf(inv) {
  const out = [];
  if (!inv) return out;
  const parts = inv.m_rgChildInventories && Object.keys(inv.m_rgChildInventories).length ? Object.values(inv.m_rgChildInventories) : [inv];
  for (const part of parts) {
    const assets = (part && part.m_rgAssets) || {};
    for (const id of Object.keys(assets)) {
      const a = assets[id], d = a && a.description;
      if (!d || !Number(d.marketable) || !d.market_hash_name) continue;
      out.push({ key: d.appid + '/' + d.market_hash_name, appid: String(d.appid), name: String(d.market_hash_name), amount: Math.max(1, Number(a.amount) || 1), element: a.element || null });
    }
  }
  return out;
}

function createInventory(o) {
  const win = o.win, doc = win.document, storage = o.storage || null;
  const get = o.fetch || (typeof win.fetch === 'function' ? (u, i) => win.fetch(u, i) : null);
  const now = o.now || (() => Date.now());
  const h = web.builder(doc);
  let stopped = false, card = null, looker = null, current = null, items = [], backoff = o.backoffMs || BACKOFF_MS, waitingUntil = 0;
  const queue = web.createQueue({ everyMs: o.everyMs || EVERY_MS, now });
  const asked = new Set();

  let currency = null;
  try { const w = win.g_rgWalletInfo; if (w && Number(w.wallet_currency) > 0) currency = Number(w.wallet_currency); } catch (e) { }
  const storeKey = 'arkada.inventory.prices.' + currency;
  // { key: [at, price, text] } — one entry per kind of item, the oldest dropped past MAX_KEPT
  let kept = {};
  try { const v = JSON.parse((storage && storage.getItem(storeKey)) || '{}'); if (v && typeof v === 'object') kept = v; } catch (e) { }
  function remember(key, price, text) {
    kept[key] = [now(), price, text];
    const keys = Object.keys(kept);
    if (keys.length > MAX_KEPT) keys.sort((a, b) => kept[a][0] - kept[b][0]).slice(0, keys.length - MAX_KEPT).forEach(k => delete kept[k]);
    try { if (storage) storage.setItem(storeKey, JSON.stringify(kept)); } catch (e) { }
  }
  const fresh = key => kept[key] && now() - kept[key][0] < CACHE_MS ? kept[key] : null;

  function badge(item) {
    const p = fresh(item.key);
    const el = item.element;
    if (!p || p[1] == null || !el || typeof el.querySelector !== 'function') return;
    let b = el.querySelector('.arkada-inv-price');
    if (!b) { b = doc.createElement('span'); b.className = 'arkada-inv-price'; el.appendChild(b); }
    if (b.textContent !== p[2]) b.textContent = p[2];
  }

  function draw() {
    if (stopped) return;
    const kinds = new Set(items.map(i => i.key));
    let sum = 0, priced = 0, sample = '', none = 0;
    const done = new Set();
    for (const it of items) {
      const p = fresh(it.key);
      if (!p) continue;
      if (p[1] == null) { if (!done.has(it.key)) none++; done.add(it.key); continue; }
      sum += p[1] * it.amount;
      if (!sample) sample = p[2];
      if (!done.has(it.key)) priced++;
      done.add(it.key);
    }
    const left = kinds.size - done.size;
    const box = h('div', 'arkada-card');
    box.id = ID;
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Стоимость инвентаря');
    box.appendChild(h('div', 'arkada-card-head', h('span', 'arkada-card-title', 'Стоимость на Торговой площадке'),
      h('span', 'arkada-card-sub', items.length ? priced + ' из ' + kinds.size + ' ' + web.plural(kinds.size, 'вида', 'видов', 'видов') + ' оценено' : '')));
    if (!items.length) box.appendChild(h('div', 'arkada-card-hint', 'Здесь нет предметов, которые можно продать на Торговой площадке.'));
    else {
      box.appendChild(h('span', 'arkada-card-big', (left ? 'не меньше ' : '') + (sample ? web.formatLike(sample, sum) : '—')));
      if (left) {
        const mins = Math.ceil(left * (o.everyMs || EVERY_MS) / 60000);
        const wait = waitingUntil > now() ? ' Steam попросил подождать — продолжу через ' + Math.ceil((waitingUntil - now()) / 1000) + ' с.' : '';
        box.appendChild(h('div', 'arkada-card-hint', 'Ещё ' + left + ' — примерно ' + mins + ' мин: цены спрашиваются по одной, чтобы Steam не ограничил запросы.' + wait));
      }
      if (none) box.appendChild(h('div', 'arkada-card-sub', none + ' без предложений на продажу — не считаются.'));
    }
    box.appendChild(h('div', 'arkada-card-note', 'По самой низкой цене продажи на Торговой площадке Steam сейчас, без вычета комиссии; цены хранятся сутки. Считаются предметы открытой игры, которые можно продать и которые Steam уже загрузил на страницу (большой инвентарь он догружает по мере листания).'));
    web.ensureStyle(doc, o.tokens);
    const at = doc.getElementById('inventory_logos');
    if (card && card.parentNode) { card.parentNode.insertBefore(box, card); card.remove(); card = box; }
    else if (at && at.parentNode) { at.parentNode.insertBefore(box, at); card = box; }
  }

  function ask(item) {
    return async () => {
      if (stopped || fresh(item.key)) return;
      if (doc.hidden || doc.visibilityState === 'hidden') { asked.delete(item.key); queue.pause(LOOK_MS); return; }
      const url = '/market/priceoverview/?appid=' + encodeURIComponent(item.appid) + '&currency=' + currency + '&market_hash_name=' + encodeURIComponent(item.name);
      let r = null;
      try { r = await get(url, { credentials: 'include' }); } catch (e) { r = null; }
      if (stopped) return;
      if (r && r.status === 429) {
        asked.delete(item.key);
        waitingUntil = now() + backoff;
        queue.pause(backoff);
        backoff = Math.min(backoff * 2, 10 * 60 * 1000);
        queue.push(ask(item));
        asked.add(item.key);
        draw();
        return;
      }
      if (!r || !r.ok) { asked.delete(item.key); return; }
      backoff = o.backoffMs || BACKOFF_MS;
      let j = null;
      try { j = await r.json(); } catch (e) { j = null; }
      if (!j || !j.success) { remember(item.key, null, ''); draw(); return; }
      const text = String(j.lowest_price || j.median_price || '').trim();
      const price = web.parseMoney(text);
      remember(item.key, price, text);
      for (const it of items) if (it.key === item.key) badge(it);
      draw();
    };
  }

  function look() {
    if (stopped) return;
    let inv = null;
    try { inv = win.g_ActiveInventory || null; } catch (e) { }
    const list = itemsOf(inv);
    const sig = inv ? inv.appid + '_' + inv.contextid + '_' + list.length + '_' + list.filter(i => i.element).length : '';
    if (inv === current.inv && sig === current.sig) { if (!card || !card.isConnected) draw(); return; }
    current = { inv, sig };
    items = list;
    queue.clear();
    asked.clear();
    for (const it of items) {
      badge(it);
      if (!fresh(it.key) && !asked.has(it.key)) { asked.add(it.key); queue.push(ask(it)); }
    }
    draw();
  }

  const loc = win.location || {};
  if (String(loc.hostname).toLowerCase() === 'steamcommunity.com' && PAGE.test(String(loc.pathname || '')) && get && currency && !web.switchedOff(win, 'market')) {
    current = { inv: undefined, sig: null };
    look();
    looker = setInterval(look, o.lookMs || LOOK_MS);
  }

  return {
    items: () => items,
    stop() {
      if (stopped) return;
      stopped = true;
      queue.stop();
      if (looker) clearInterval(looker);
      looker = null;
      if (card) try { card.remove(); } catch (e) { }
      for (const b of doc.querySelectorAll('.arkada-inv-price')) try { b.remove(); } catch (e) { }
      web.dropStyle(doc);
    },
  };
}

module.exports = { createInventory, itemsOf, ID };
