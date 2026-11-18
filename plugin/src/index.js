// Arkada plugin for Millennium: the entry point Millennium calls inside the Steam client.
// It joins the three parts: the hub client of kit.txt (hub-client.js, copied as is), what is said to
// the hub (core.js) and the calls into Steam (steam.js). Nothing here talks to the internet:
// the only connection is ws://127.0.0.1:42080/hub, the dev.txt hub on this PC.
'use strict';
const { connect } = require('./hub-client.js');
const { createArkada } = require('./core.js');
const { createSteam } = require('./steam.js');

const VERSION = require('./version.js'); // written by build.js from plugin.json
const SLOT = '__arkada_stop__';       // the running copy, so that a second load replaces it instead of doubling it

exports.default = async function () {
  try { if (typeof window[SLOT] === 'function') window[SLOT](); } catch (e) { /* the old copy is gone anyway */ }
  let storage = null;
  try { storage = window.localStorage; } catch (e) { /* closed: settings live until Steam restarts */ }
  const arkada = createArkada({ connect, steam: createSteam(window), storage, version: VERSION });
  const stop = () => { if (window[SLOT] === stop) window[SLOT] = null; arkada.stop(); };
  window[SLOT] = stop;
  // No title/content: the plugin has no page of its own, its settings are on the settings page of core.txt
  return { icon: null, onDismount: stop };
};
