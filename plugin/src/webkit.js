// Arkada plugin for Millennium: the entry point of its webkit script, which Millennium runs in the pages of
// the Steam store and community (.millennium/Dist/webkit.js, built by build.js). Only «Поделиться» lives
// here (share.js); it does anything only on a game's page of the store. Its friends list and messages go
// through the plugin's part in the client (index.js, arkadaShare), reached with Millennium's callable.
'use strict';
const { createShare } = require('./share.js');

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
  if (!/^(store\.steampowered\.com)$/i.test(String(window.location && window.location.hostname))) return; // community pages: nothing to do
  const share = createShare({ win: window, call: bridge(window), tokens: TOKENS });
  window[SLOT] = () => { window[SLOT] = null; share.stop(); };
};
