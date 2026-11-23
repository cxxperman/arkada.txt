// Arkada, the start page: Steam's main window opens on the library's Home, not on the store.
// Knows nothing about Steam itself — it gets steam.readFlags / currentRoute / navigate (steam.js).
//
//   const s = createStartPage({ steam, storage, once: window });   s.stop();
//
// The theme's setting «Начальная страница» (tab «Arkada», overlay/skin.json) puts --arkada-start-library:
// on (Библиотека, the default: overlay/tokens.css) or off (Как в Steam: options/start-library-off.css) on <html>.
// The last answer is kept in localStorage, so that at the next start it is known before the theme is in.
//
// Once per Steam start (a flag on `once`, the SharedJSContext window, which outlives a reload of the
// plugin), while the main window's first page is not the library: one Navigate('/library/home'), as soon
// as Steam's router is there (checked every EVERY_MS), so the store shows for a moment at most. Never after
// that first page: if the first page is the library, the setting is off, the theme never answers, or
// LIMIT_MS have passed, nothing is done. Steam's own «Start up location» setting is not touched.
'use strict';

const STORAGE_KEY = 'arkada.start-library';
const FLAG = 'start-library';
const ONCE = '__arkadaStartPageDone';
const EVERY_MS = 100;
const LIMIT_MS = 15000;

function createStartPage(o) {
  const steam = o.steam, storage = o.storage || null, once = o.once || {};
  const now = o.now || (() => Date.now());
  const every = o.everyMs || EVERY_MS, limit = o.limitMs || LIMIT_MS;
  let stopped = false, timer = null;
  const stop = () => { stopped = true; if (timer) clearTimeout(timer); timer = null; };
  if (once[ONCE]) return { stop, state: () => 'done before' };
  once[ONCE] = true;

  let saved = null;
  try { const v = storage && storage.getItem(STORAGE_KEY); if (v === 'on' || v === 'off') saved = v; } catch (e) { }
  const started = now();
  let state = 'waiting';

  function tick() {
    timer = null;
    if (stopped) return;
    let flag = null;
    try { flag = steam.readFlags([FLAG])[FLAG]; } catch (e) { flag = null; }
    if (flag === 'on' || flag === 'off') {
      if (flag !== saved) { saved = flag; try { if (storage) storage.setItem(STORAGE_KEY, flag); } catch (e) { } }
    }
    const route = steam.currentRoute();
    if (route) {
      if (/^\/library(\/|$)/.test(route)) { state = 'library already'; return; }
      if (saved === 'off') { state = 'off'; return; }
      if (saved === 'on') { state = steam.navigate('/library/home') ? 'moved from ' + route : 'no router'; return; }
    }
    if (now() - started >= limit) { state = 'gave up'; return; }
    timer = setTimeout(tick, every);
  }
  tick();
  return { stop, state: () => state };
}

module.exports = { createStartPage, STORAGE_KEY };
