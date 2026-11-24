// Arkada plugin for Millennium: the entry point of its webkit script, which Millennium runs in the pages of
// the Steam store and community (.millennium/Dist/webkit.js, built by build.js). Two features live here:
//   «Поделиться» (share.js) on a game's page of the store; its friends list and messages go through the
//   plugin's part in the client (index.js, arkadaShare), reached with Millennium's callable;
//   Dota 2 statistics (dota.js) on a profile of the community, asked of api.opendota.com by the page itself.
'use strict';
const { createShare } = require('./share.js');
const { createDota } = require('./dota.js');

const PLUGIN = 'arkada';
const TOKENS = require('./tokens.js'); // the dev.txt tokens, written by build.js from theme/tokens.css
const SLOT = '__arkada_share_stop__';

// (method, arg) → a Promise of the reply of arkadaShare[method] in the client. [K] the way the Steam Share
// plugin on this PC reaches its own client part: MILLENNIUM_API.callable(plugin, "frontend:<name>")
function bridge(win) {
  const fns = {};
  return (method, arg) => {
    const api = win.MILLENNIUM_API;
    if (!api || typeof api.callable !== 'function') return Promise.reject(new Error('no bridge'));
    const fn = fns[method] || (fns[method] = api.callable(PLUGIN, 'frontend:arkadaShare.' + method));
    return Promise.resolve(arg === undefined ? fn() : fn(arg));
  };
}

exports.default = async function () {
  try { if (typeof window[SLOT] === 'function') window[SLOT](); } catch (e) { }
  const host = String(window.location && window.location.hostname).toLowerCase();
  let part = null;
  if (host === 'store.steampowered.com') part = createShare({ win: window, call: bridge(window), tokens: TOKENS });
  else if (host === 'steamcommunity.com') {
    let storage = null;
    try { storage = window.localStorage; } catch (e) { /* closed: every visit asks OpenDota */ }
    part = createDota({ win: window, storage, tokens: TOKENS });
  }
  if (!part) return;
  window[SLOT] = () => { window[SLOT] = null; part.stop(); };
};
