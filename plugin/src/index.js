// Arkada plugin for Millennium: the entry point Millennium calls inside the Steam client.
// It joins the parts: the hub client of kit.txt (hub-client.js, copied as is), what is said to
// the hub (core.js), the window backdrop (backdrop.js, with the Lua backend in plugin/backend) and the calls
// into Steam (steam.js). And the features that replace separate plugins, each switched on and off by the
// theme (features.js, tab «Arkada» of the theme's settings):
//   kapsula     Steam's notifications to the Kapsula island (kapsula.js) — instead of the Kapsula plugin
//   disk-size   the size on disk on a game's page (disksize.js, on pages.js) — instead of Size on Disk
//   hltb        How Long To Beat on a game's page (hltb.js, on pages.js; the requests in the Lua backend,
//               arkada_hltb.lua) — instead of HLTB for Steam
//   start page  the main window opens on the library's Home (startpage.js), not on the store
//   share       «Поделиться» on a store page: its button lives in the page (webkit.js, share.js); the client's
//               part here only answers it (arkadaShare below) — instead of Steam Share
//   dota        Dota 2 statistics on a community profile, from api.opendota.com: lives in the page as well
//               (webkit.js, dota.js) — instead of Dota 2 Stats
//   prices, game-info, hide-owned, wishlist-sum, market   what the Augmented Steam and SteamDB extensions
//               add to the store and the community, in the pages too (webkit.js); the client's part here
//               only answers «Об игре» with the library's hours and date (arkadaGame below)
// This part talks to nothing outside the PC: its connections are ws://127.0.0.1:42080/hub, the dev.txt hub
// on this PC, and ws://127.0.0.1:42071, Kapsula on this PC. The features that go to the internet do it from
// the backend or the pages, each while its setting is on: How Long To Beat (the backend asks howlongtobeat.com
// and Steam's store API for the game's English name), IsThereAnyDeal (the backend, only with the user's key),
// Dota 2 statistics (the profile page asks api.opendota.com), the wishlist's sum (api.steampowered.com) and
// the market prices (steamcommunity.com/market).
'use strict';
const { connect } = require('./hub-client.js');
const { createArkada } = require('./core.js');
const { createSteam } = require('./steam.js');
const { createBackdrop } = require('./backdrop.js');
const { createFeatures } = require('./features.js');
const { createKapsula } = require('./kapsula.js');
const { createPages } = require('./pages.js');
const { createDiskSize } = require('./disksize.js');
const { createHltb } = require('./hltb.js');
const { createStartPage } = require('./startpage.js');

const VERSION = require('./version.js'); // written by build.js from plugin.json
const SLOT = '__arkada_stop__';       // the running copy, so that a second load replaces it instead of doubling it

let current = null; // the running copy's steam, for arkadaShare

// Called by the store page (webkit.js) through Millennium: MILLENNIUM_API.callable("arkada", "frontend:arkadaShare.friends").
// Millennium finds them among the plugin's exports. Replies are JSON strings.
exports.arkadaShare = {
  friends() {
    if (!current) throw new Error('not running');
    return JSON.stringify(current.friendsList());
  },
  async send(request) {
    if (!current) throw new Error('not running');
    let r = request;
    if (typeof r === 'string') r = JSON.parse(r);
    if (r && typeof r === 'object' && typeof r.request === 'string') r = JSON.parse(r.request);
    const ids = Array.isArray(r && r.ids) ? Array.from(new Set(r.ids.filter(id => typeof id === 'string' && /^\d{5,20}$/.test(id)))).slice(0, 50) : [];
    const text = r && typeof r.text === 'string' ? r.text.slice(0, 1000) : '';
    if (!ids.length || !text.trim()) throw new Error('bad request');
    const steam = current;
    const out = [];
    for (const id of ids) {
      try { await steam.sendChat(id, text); out.push({ id, sent: true }); }
      catch (e) { out.push({ id, sent: false, error: String(e && e.message || e) }); }
    }
    return JSON.stringify(out);
  },
};

// Called by a game's page in the store (webkit.js, gameinfo.js): MILLENNIUM_API.callable("arkada", "frontend:arkadaGame.info").
// appid → JSON { owned, minutes, minutesTwoWeeks, lastPlayed, purchased } from the library of this client, or null
exports.arkadaGame = {
  info(appid) {
    if (!current) throw new Error('not running');
    let id = appid;
    if (id && typeof id === 'object') id = id.appid;
    if (!/^\d{1,10}$/.test(String(id))) throw new Error('bad request');
    return JSON.stringify(current.appPlaytime(Number(id)));
  },
};

exports.default = async function () {
  try { if (typeof window[SLOT] === 'function') window[SLOT](); } catch (e) { /* the old copy is gone anyway */ }
  let storage = null;
  try { storage = window.localStorage; } catch (e) { /* closed: settings live until Steam restarts */ }
  const steam = createSteam(window);
  current = steam;
  const arkada = createArkada({ connect, steam, storage, version: VERSION });
  // Mica / Acrylic under the windows, when the theme asks for it (backdrop.js, plugin/backend/main.lua)
  const backdrop = createBackdrop({ steam, storage });
  // For testing from SharedJSContext: window.__arkadaBackdrop.set('blur' | 'acrylic' | 'mica' | 'off' | null), .mode()
  window.__arkadaBackdrop = { set: m => backdrop.set(m), mode: () => backdrop.mode() };
  // The main window opens on the library's Home, once per Steam start (startpage.js, setting «Начальная страница»)
  const startPage = createStartPage({ steam, storage, once: window });
  // The main window's pages are watched only once a feature that draws on them is on
  let pages = null;
  const features = createFeatures({
    steam, storage,
    features: {
      kapsula: () => createKapsula({ steam, WebSocket: window.WebSocket, version: VERSION }),
      'disk-size': () => {
        if (!pages) pages = createPages({ steam });
        return createDiskSize({ steam, pages });
      },
      hltb: () => {
        if (!pages) pages = createPages({ steam });
        return createHltb({ steam, pages });
      },
    },
  });
  const stop = () => {
    if (window[SLOT] === stop) window[SLOT] = null;
    if (current === steam) current = null;
    features.stop();
    startPage.stop();
    if (pages) pages.stop();
    arkada.stop();
    backdrop.stop();
    try { delete window.__arkadaBackdrop; } catch (e) { }
    steam.dispose();
  };
  window[SLOT] = stop;
  // No title/content: the plugin has no page of its own, its settings are on the settings page of core.txt
  return { icon: null, onDismount: stop };
};
