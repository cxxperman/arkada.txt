// Arkada, prices on a game's page in the Steam store: a link to the game's price history on SteamDB (no
// request: only a link), and — with the user's own IsThereAnyDeal API key — the best price in other shops
// right now and the lowest price ever, from IsThereAnyDeal API v2 (games/overview/v2). Written for Arkada
// from what Augmented Steam shows; no code taken from it.
//
// Runs in the store page itself (webkit.js): knows the page, not Steam.
//   const p = createPrices({ win, server, tokens });   p.stop();
//   server   (method, args) → Promise of the reply of the plugin's Lua backend (Millennium.callServerMethod),
//            null when there is no backend: ItadPrices { appid, country } → { success, hasKey, data | error },
//            ItadKey { key } → { success, hasKey } (an empty key removes it). See plugin/backend/arkada_itad.lua
//
// The key is not kept in the page: the backend writes it next to Steam (millennium/arkada-itad.json), asks
// api.isthereanydeal.com itself (one lookup of the game's ITAD id, then the overview, kept 6 hours) and gives
// the page only the prices. Without a key nothing goes to IsThereAnyDeal; the card shows the links and how
// to add a key.
//
// Where: with the theme, the top of the right column of its summary of the game; without it, the top of the
// purchase area (#game_area_purchase). One DOM watcher (watch.js) for the page: while the card is in place a
// pass is one isConnected check; the theme may draw its summary again, and the card goes back.
'use strict';
const { createWatch } = require('./watch.js');
const web = require('./web.js');
const { unwrap } = require('./share.js');

const ID = 'arkada-prices';
const APP = /^\/app\/(\d+)(?:\/|$)/i;
const KEY_PAGE = 'https://isthereanydeal.com/apps/my/';

function appOf(win) {
  const loc = win.location || {};
  if (String(loc.hostname).toLowerCase() !== 'store.steampowered.com') return null;
  const m = APP.exec(String(loc.pathname || ''));
  return m ? m[1] : null;
}

// ITAD's { amount, currency } → '1 299,00 ₴' (the currency of the country of the user's store)
function money(p) {
  if (!p || typeof p.amount !== 'number') return '';
  try { return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: String(p.currency || 'USD') }).format(p.amount); }
  catch (e) { return p.amount.toFixed(2) + ' ' + String(p.currency || ''); }
}
function day(iso) {
  const d = new Date(String(iso || ''));
  if (isNaN(d.getTime())) return '';
  try { return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return d.toISOString().slice(0, 10); }
}

function createPrices(o) {
  const win = o.win, doc = win.document, server = o.server || (() => Promise.resolve(null));
  const h = web.builder(doc);
  const appId = appOf(win);
  let stopped = false, card = null, watch = null, state = { phase: 'loading' }, editing = false;

  const ask = (method, args) => Promise.resolve().then(() => server(method, args)).then(unwrap, () => null);
  const country = () => { const u = web.userInfo(doc); return u && /^[A-Z]{2}$/.test(String(u.country_code)) ? String(u.country_code) : 'US'; };

  function row(cap, val, sub) {
    return h('div', 'arkada-card-row', h('span', 'arkada-card-cap', cap), h('span', 'arkada-card-val', val, sub ? h('span', 'arkada-card-sub', ' ' + sub) : null));
  }
  function deal(d) {
    const text = money(d.price) + (d.shop ? ' · ' + d.shop : '');
    const cut = Number(d.cut) > 0 ? '−' + Math.round(Number(d.cut)) + '%' : '';
    if (d.url) { const a = web.link(doc, text, d.url, 'Открыть предложение (ссылка IsThereAnyDeal)'); return [a, cut]; }
    return [text, cut];
  }

  function keyForm(has) {
    const input = h('input', 'arkada-card-input');
    input.setAttribute('type', 'password');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('placeholder', 'Ключ API IsThereAnyDeal');
    input.setAttribute('aria-label', 'Ключ API IsThereAnyDeal');
    const save = h('button', 'arkada-card-btn arkada-card-primary', 'Сохранить');
    save.setAttribute('type', 'button');
    const cancel = h('button', 'arkada-card-btn', 'Отмена');
    cancel.setAttribute('type', 'button');
    const form = h('div', 'arkada-card-form', input, save, cancel);
    const submit = value => {
      save.disabled = true;
      ask('ItadKey', { key: value }).then(r => {
        editing = false;
        if (!r || !r.success) { state = { phase: 'error', text: 'Ключ не сохранён: ' + String((r && r.error) || 'нет ответа плагина') }; draw(); return; }
        load();
      });
    };
    save.addEventListener('click', () => { const v = String(input.value || '').trim(); if (v) submit(v); });
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { const v = String(input.value || '').trim(); if (v) submit(v); } else if (ev.key === 'Escape') { editing = false; draw(); } });
    cancel.addEventListener('click', () => { editing = false; draw(); });
    const parts = [form];
    if (has) {
      const remove = h('button', 'arkada-card-btn', 'Удалить ключ');
      remove.setAttribute('type', 'button');
      remove.addEventListener('click', () => submit(''));
      form.appendChild(remove);
    }
    parts.push(h('div', 'arkada-card-note',
      'Ключ даёт IsThereAnyDeal бесплатно: зарегистрируйте приложение на ', web.link(doc, 'isthereanydeal.com/apps/my', KEY_PAGE),
      '. Ключ хранится только на этом компьютере (папка Steam, millennium/arkada-itad.json) и уходит только на api.isthereanydeal.com.'));
    setTimeout(() => { try { input.focus(); } catch (e) { } }, 0);
    return parts;
  }

  function build() {
    const box = h('div', 'arkada-card');
    box.id = ID;
    box.setAttribute('data-arkada-order', '1');
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Цены');
    const keyLink = h('a', 'arkada-card-link', state.hasKey ? 'Ключ IsThereAnyDeal' : 'Добавить ключ');
    keyLink.setAttribute('role', 'button');
    keyLink.setAttribute('tabindex', '0');
    const openForm = () => { editing = true; draw(); };
    keyLink.addEventListener('click', openForm);
    keyLink.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openForm(); } });
    box.appendChild(h('div', 'arkada-card-head', h('span', 'arkada-card-title', 'Цены'), state.backend ? keyLink : null));
    const d = state.data;
    if (state.phase === 'loading') box.appendChild(h('div', 'arkada-card-sub', 'Узнаю цены…'));
    else if (state.phase === 'error') box.appendChild(h('div', 'arkada-card-hint', state.text));
    else if (state.hasKey && !d) box.appendChild(h('div', 'arkada-card-hint', 'IsThereAnyDeal не знает этой игры или её цен.'));
    else if (d) {
      if (d.current) { const [v, cut] = deal(d.current); box.appendChild(row('Сейчас дешевле всего', v, cut)); }
      if (d.lowest) { const [v, cut] = deal(d.lowest); box.appendChild(row('Исторический минимум', v, [cut, day(d.lowest.timestamp)].filter(Boolean).join(', '))); }
    } else if (state.backend) {
      box.appendChild(h('div', 'arkada-card-hint', 'Лучшая цена в других магазинах и исторический минимум появятся здесь, если добавить личный ключ IsThereAnyDeal.'));
    }
    if (editing) for (const p of keyForm(state.hasKey)) box.appendChild(p);
    const itad = d && d.game ? d.game : 'https://isthereanydeal.com/steam/app/' + appId + '/';
    box.appendChild(h('div', 'arkada-card-links',
      web.link(doc, 'История цен на SteamDB', 'https://steamdb.info/app/' + appId + '/#pricehistory', 'steamdb.info'),
      web.link(doc, 'IsThereAnyDeal', itad, 'Цены этой игры в магазинах, isthereanydeal.com')));
    if (d) box.appendChild(h('div', 'arkada-card-note', 'Цены — IsThereAnyDeal (isthereanydeal.com) для страны вашего магазина, обновляются не чаще раза в 6 часов. Arkada с IsThereAnyDeal не связана.'));
    return box;
  }

  function draw() {
    if (stopped) return;
    const old = card;
    card = build();
    if (old && old.parentNode) { old.parentNode.insertBefore(card, old); old.remove(); }
    else reconcile();
  }

  // In place: the whole pass is this check. The theme may draw its summary again: the card goes back in
  function reconcile() {
    if (stopped || !card || card.isConnected) return;
    const slot = web.appSlot(doc, () => { const a = doc.getElementById('game_area_purchase'); return a ? { parent: a, before: a.firstChild } : null; });
    if (!slot) return;
    web.ensureStyle(doc, o.tokens);
    web.insertOrdered(slot, card);
  }

  function load() {
    state = { phase: 'loading', backend: state.backend, hasKey: state.hasKey };
    draw();
    ask('ItadPrices', { appid: Number(appId), country: country() }).then(r => {
      if (stopped) return;
      if (!r || typeof r !== 'object') state = { phase: 'done', backend: false };
      else if (r.success) state = { phase: 'done', backend: true, hasKey: !!r.hasKey, data: r.data || null };
      else if (r.error === 'no key') state = { phase: 'done', backend: true, hasKey: false };
      else if (r.error === 'bad key') state = { phase: 'error', backend: true, hasKey: true, text: 'IsThereAnyDeal не принял ключ — проверьте его.' };
      else if (r.error === 'rate') state = { phase: 'error', backend: true, hasKey: true, text: 'Слишком много запросов к IsThereAnyDeal — цены появятся позже.' };
      else state = { phase: 'error', backend: true, hasKey: !!r.hasKey, text: 'IsThereAnyDeal не ответил.' };
      draw();
    });
  }

  if (appId && !web.switchedOff(win, 'prices')) {
    load();
    watch = createWatch(win, reconcile);
    watch.start();
  }

  return {
    state: () => state,
    stop() {
      if (stopped) return;
      stopped = true;
      if (watch) watch.stop();
      watch = null;
      if (card) try { card.remove(); } catch (e) { }
      web.dropStyle(doc);
    },
  };
}

module.exports = { createPrices, money, appOf, ID };
