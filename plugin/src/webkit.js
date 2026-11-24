// Arkada plugin for Millennium: the entry point of its webkit script, which Millennium runs in the pages of
// the Steam store and community (.millennium/Dist/webkit.js, built by build.js). Each feature is a module
// that does something only on its own pages (by the address) and only while its theme setting is on (the
// page reads --arkada-<feature> on its <html>, web.js):
//   store.steampowered.com
//     /app/<id>          «Поделиться» (share.js: the friends and the sending go through the plugin's part in
//                        the client, index.js arkadaShare), «Цены» (prices.js: SteamDB, IsThereAnyDeal through
//                        the Lua backend), «Об игре» (gameinfo.js: your hours and the date from the client)
//     /wishlist/…        the sum of the wishlist (wishlist.js, Steam's Web API)
//     the store's lists  owned and ignored games hidden (hideowned.js, one style sheet)
//   steamcommunity.com
//     /id/<name>, /profiles/<id>   Dota 2 statistics (dota.js, api.opendota.com)
//     …/inventory                  the market prices of the items (inventory.js, market/priceoverview)
//     /market/history              the totals of the market history (markethistory.js, market/myhistory)
'use strict';
const { createShare } = require('./share.js');
const { createDota } = require('./dota.js');
const { createPrices } = require('./prices.js');
const { createGameInfo } = require('./gameinfo.js');
const { createHideOwned } = require('./hideowned.js');
const { createWishlist } = require('./wishlist.js');
const { createInventory } = require('./inventory.js');
const { createMarketHistory } = require('./markethistory.js');

const PLUGIN = 'arkada';
const TOKENS = require('./tokens.js'); // the dev.txt tokens, written by build.js from theme/tokens.css
const SLOT = '__arkada_share_stop__';
const BACKEND_MS = 20000;

// ('arkadaShare.friends', arg) → a Promise of the reply of that export of the client part. [K] the way the
// Steam Share plugin on this PC reaches its own client part: MILLENNIUM_API.callable(plugin, "frontend:<name>")
function bridge(win) {
  const fns = {};
  return (name, arg) => {
    const api = win.MILLENNIUM_API;
    if (!api || typeof api.callable !== 'function') return Promise.reject(new Error('no bridge'));
    const fn = fns[name] || (fns[name] = api.callable(PLUGIN, 'frontend:' + name));
    return Promise.resolve(arg === undefined ? fn() : fn(arg));
  };
}
// (method, args) → a Promise of the Lua backend's reply, or null: no backend, or no answer in BACKEND_MS.
// [K] Millennium.callServerMethod is on the store pages too (seen on store.steampowered.com, Millennium's webkit API)
function backend(win) {
  return (method, args) => new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; clearTimeout(timer); resolve(v === undefined ? null : v); } };
    const timer = setTimeout(() => finish(null), BACKEND_MS);
    try {
      const m = win.Millennium;
      if (!m || typeof m.callServerMethod !== 'function') return finish(null);
      Promise.resolve(m.callServerMethod(PLUGIN, method, args)).then(finish, () => finish(null));
    } catch (e) { finish(null); }
  });
}

exports.default = async function () {
  try { if (typeof window[SLOT] === 'function') window[SLOT](); } catch (e) { }
  const host = String(window.location && window.location.hostname).toLowerCase();
  let storage = null;
  try { storage = window.localStorage; } catch (e) { /* closed: every visit asks again */ }
  const call = bridge(window);
  const makers = [];
  if (host === 'store.steampowered.com') {
    makers.push(
      () => createShare({ win: window, call: (method, arg) => call('arkadaShare.' + method, arg), tokens: TOKENS }),
      () => createGameInfo({ win: window, call, tokens: TOKENS }),
      () => createPrices({ win: window, server: backend(window), tokens: TOKENS }),
      () => createHideOwned({ win: window }),
      () => createWishlist({ win: window, storage, tokens: TOKENS }));
  } else if (host === 'steamcommunity.com') {
    makers.push(
      () => createDota({ win: window, storage, tokens: TOKENS }),
      () => createInventory({ win: window, storage, tokens: TOKENS }),
      () => createMarketHistory({ win: window, storage, tokens: TOKENS }));
  }
  const parts = [];
  for (const make of makers) try { parts.push(make()); } catch (e) { /* this feature cannot start here: the others still do */ }
  if (!parts.length) return;
  window[SLOT] = () => { window[SLOT] = null; for (const p of parts) try { p.stop(); } catch (e) { } };
};
