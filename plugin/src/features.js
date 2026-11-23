// Arkada, the switches of the plugin's features. Knows nothing about Steam.
//
// Every feature has a setting of the theme, tab «Arkada» (overlay/skin.json): Вкл (the default) or Выкл.
// The setting puts --arkada-<feature>: on | off on <html> of the windows (overlay/tokens.css says on,
// overlay/options/feature-<feature>-off.css off) — the same way «Подложка окна» reaches the plugin
// (backdrop.js). The off file also hides the feature's elements at once, before the plugin has noticed.
//
//   const f = createFeatures({ steam, storage, features: { kapsula: () => module, 'disk-size': () => module } });
//   f.stop();          a module is { stop() }; it is made when its feature turns on and stopped when it turns off
//
// When: read every EVERY_MS in the main window (steam.readFlags). The last answer is kept in localStorage,
// so that at the next start a feature is on (or stays off) at once. No answer at all for GIVE_UP_MS (no
// Arkada theme, or Steam's main window never opened): the features are on, their default.
'use strict';

const STORAGE_KEY = 'arkada.features';
const EVERY_MS = 2000;
const GIVE_UP_MS = 10000;

function createFeatures(o) {
  const steam = o.steam, storage = o.storage || null, makers = o.features;
  const names = Object.keys(makers);
  const now = o.now || (() => Date.now());
  const started = now(), giveUpMs = o.giveUpMs || GIVE_UP_MS;
  const running = new Map(); // name → module
  let saved = {}, stopped = false, answered = false;
  try { const v = JSON.parse((storage && storage.getItem(STORAGE_KEY)) || '{}'); if (v && typeof v === 'object') saved = v; } catch (e) { }

  const wanted = {};
  function turn(name, on) {
    if (stopped) return;
    wanted[name] = on;
    const m = running.get(name);
    if (on && !m) {
      try { running.set(name, makers[name]()); } catch (e) { /* this feature cannot start here: the others still do */ }
    } else if (!on && m) {
      running.delete(name);
      try { m.stop(); } catch (e) { }
    }
  }
  let written = JSON.stringify(saved);
  function remember() {
    const v = {};
    for (const n of names) v[n] = wanted[n] === false ? 'off' : 'on';
    const text = JSON.stringify(v);
    if (text === written) return;
    written = text;
    try { if (storage) storage.setItem(STORAGE_KEY, text); } catch (e) { }
  }

  function look() {
    if (stopped) return;
    const flags = steam.readFlags(names);
    let any = false;
    for (const n of names) {
      if (flags[n] === 'on' || flags[n] === 'off') { any = true; turn(n, flags[n] === 'on'); }
    }
    if (any) { answered = true; remember(); return; }
    // No answer: the main window is closed (Steam started in the tray), or there is no Arkada theme. Before
    // the first answer, after GIVE_UP_MS, what was answered last time, else the default (on); after it,
    // everything stays as it is
    if (!answered && now() - started > giveUpMs) for (const n of names) turn(n, saved[n] !== 'off');
  }

  // At the start: what was answered last time; a feature never answered for waits for the theme a little
  for (const n of names) if (saved[n] === 'on') turn(n, true);
  look();
  const timer = setInterval(look, o.everyMs || EVERY_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();

  return {
    on: name => running.has(name),
    module: name => running.get(name) || null,
    stop() {
      if (stopped) return;
      clearInterval(timer);
      for (const n of Array.from(running.keys())) turn(n, false);
      stopped = true;
    },
  };
}

module.exports = { createFeatures, STORAGE_KEY };
