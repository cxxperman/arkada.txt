// Arkada, the pages of the client's main window: which page is open, and one DOM watcher for the modules
// that draw something on it. Knows nothing about Steam — the route and the window come from steam.js.
//
//   const pages = createPages({ steam });
//   const off = pages.add({ route: /^\/library\/app\/(\d+)/, update(ctx), leave(ctx) });
//   pages.stop();
//
// A module says on which pages it works (`route`, tested on the path, e.g. "/library/app/570").
//   update({ win, doc, path, match })   the page is open and its DOM may have changed: put your element in
//                                       place (return at once when it is still there)
//   leave({ win, doc })                 the page is gone, or the module is switched off: take everything away
// The DOM watcher (watch.js) runs only while the open page is one some module works on, and only on the main
// window; on other pages, and while the main window is closed, there is no observer at all. The route
// itself comes from Steam's router (steam.watchRoute) and costs nothing between page changes.
'use strict';
const { createWatch } = require('./watch.js');

function createPages(o) {
  const steam = o.steam;
  const modules = new Set();
  let path = '', win = null, watch = null, stopped = false;
  const active = new Map(); // module → the window it drew in

  const matching = () => Array.from(modules).map(m => [m, m.route.exec(path)]).filter(([, r]) => r);

  function leave(m) {
    const w = active.get(m);
    if (!w) return;
    active.delete(m);
    try { m.leave({ win: w, doc: w.document }); } catch (e) { }
  }

  function pass() {
    if (stopped || !win) return;
    for (const [m, match] of matching()) {
      active.set(m, win);
      try { m.update({ win, doc: win.document, path, match }); } catch (e) { }
    }
  }

  // Where things stand now: which window, which page, which modules; the watcher follows
  function settle() {
    if (stopped) return;
    const now = steam.mainWindow();
    if (now !== win) {
      for (const m of Array.from(active.keys())) leave(m);
      if (watch) watch.stop();
      watch = null;
      win = now;
    }
    const want = matching().map(([m]) => m);
    for (const m of Array.from(active.keys())) if (!want.includes(m)) leave(m);
    if (!win || !want.length) { if (watch) watch.stop(); return; }
    if (!watch) watch = createWatch(win, pass);
    if (!watch.running()) watch.start(); else watch.kick();
  }

  const offRoute = steam.watchRoute(p => { path = p || ''; settle(); });
  // The main window is made again when Steam comes back from the tray
  const offWindows = steam.watchWindows(() => settle());

  return {
    add(m) {
      modules.add(m);
      settle();
      return () => { modules.delete(m); leave(m); settle(); };
    },
    path: () => path,
    watching: () => !!(watch && watch.running()),
    stop() {
      if (stopped) return;
      for (const m of Array.from(active.keys())) leave(m);
      stopped = true;
      if (watch) watch.stop();
      for (const f of [offRoute, offWindows]) if (typeof f === 'function') try { f(); } catch (e) { }
    },
  };
}

module.exports = { createPages };
