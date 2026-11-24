// Arkada, about the game on its page in the Steam store: how long you have played it and since when it is on
// your account — from the Steam client itself (its library: appStore, the plugin's part in the client,
// index.js arkadaGame.info) — and links to the game on SteamDB, PCGamingWiki and ProtonDB (links only, no
// request). Written for Arkada from what Augmented Steam and SteamDB's extension show; no code taken from them.
//
// Runs in the store page itself (webkit.js): knows the page, not Steam.
//   const g = createGameInfo({ win, call, tokens });   g.stop();
//   call   (name, arg) → Promise: the plugin's part in the client, "arkadaGame.info" appid →
//          { owned, minutes, minutesTwoWeeks, lastPlayed, purchased } (seconds since 1970), or null
//
// Where: under «Цены» — with the theme in the right column of its summary of the game, without it at the top of
// Steam's right column (.rightcol.game_meta_data). One DOM watcher for the page, as prices.js. Nothing goes to the internet.
'use strict';
const { createWatch } = require('./watch.js');
const web = require('./web.js');
const { unwrap } = require('./share.js');
const { appOf } = require('./prices.js');

const ID = 'arkada-game-info';

// 8302 minutes → '138,4 ч'; under an hour → '45 мин'
function hours(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m < 60) return m + ' мин';
  const v = Math.round(m / 6) / 10;
  return String(v).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ч';
}
function date(seconds) {
  const s = Number(seconds) || 0;
  if (s <= 0) return '';
  const d = new Date(s * 1000);
  try { return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return d.toISOString().slice(0, 10); }
}

function createGameInfo(o) {
  const win = o.win, doc = win.document, call = o.call || (() => Promise.reject(new Error('no bridge')));
  const h = web.builder(doc);
  const appId = appOf(win);
  let stopped = false, card = null, watch = null, info = undefined;

  function build() {
    const box = h('div', 'arkada-card');
    box.id = ID;
    box.setAttribute('data-arkada-order', '2');
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Об игре');
    box.appendChild(h('div', 'arkada-card-head', h('span', 'arkada-card-title', 'Об игре')));
    const row = (cap, val) => h('div', 'arkada-card-row', h('span', 'arkada-card-cap', cap), h('span', 'arkada-card-val', val));
    if (info && info.owned) {
      box.appendChild(row('Вы играли', hours(info.minutes)));
      if (Number(info.minutesTwoWeeks) > 0) box.appendChild(row('За две недели', hours(info.minutesTwoWeeks)));
      if (date(info.lastPlayed)) box.appendChild(row('Последний запуск', date(info.lastPlayed)));
      if (date(info.purchased)) box.appendChild(row('На аккаунте с', date(info.purchased)));
    }
    box.appendChild(h('div', 'arkada-card-links',
      web.link(doc, 'SteamDB', 'https://steamdb.info/app/' + appId + '/', 'Сведения об игре на steamdb.info'),
      web.link(doc, 'PCGamingWiki', 'https://www.pcgamingwiki.com/api/appid.php?appid=' + appId, 'Исправления и настройки на pcgamingwiki.com'),
      web.link(doc, 'ProtonDB', 'https://www.protondb.com/app/' + appId, 'Как игра идёт на Linux и Steam Deck, protondb.com')));
    if (info && info.owned) box.appendChild(h('div', 'arkada-card-note', 'Время и дата — из вашей библиотеки в клиенте Steam.'));
    return box;
  }

  // In place: the whole pass is this check. The theme may draw its summary again: the card goes back in
  function reconcile() {
    if (stopped || info === undefined || (card && card.isConnected)) return;
    const slot = web.appSlot(doc, () => {
      for (const c of doc.querySelectorAll('.rightcol.game_meta_data')) if (!c.id) return { parent: c, before: c.firstChild };
      return null;
    });
    if (!slot) return;
    web.ensureStyle(doc, o.tokens);
    if (!card) card = build();
    web.insertOrdered(slot, card);
  }

  if (appId && !web.switchedOff(win, 'game-info')) {
    Promise.resolve().then(() => call('arkadaGame.info', appId)).then(unwrap, () => null).then(r => {
      if (stopped) return;
      info = r && typeof r === 'object' ? r : null;
      reconcile();
      watch = createWatch(win, reconcile);
      watch.start();
    });
  }

  return {
    info: () => info,
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

module.exports = { createGameInfo, hours, ID };
