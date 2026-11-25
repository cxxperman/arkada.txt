// Arkada, the main window's browser view: the Store, Community and profile pages open from the first click.
// Knows nothing about the rest of the plugin: it gets the SharedJSContext window (where Steam keeps
// window.MainWindowBrowserManager, the object behind the Store / Community view of the main window).
//
//   const f = createBrowserFix({ win: window });   f.state();   f.stop();
//
// Why. At its start Steam (with Millennium and the theme in) mounts the main window's tree twice: the first
// tree makes a browser view and its manager, the second one destroys that view and makes another view and
// manager (window.MainWindowBrowserManager then is the second). The first manager stays: it still
// listens to the router, and Steam's own controls rendered before the second manager came keep it, Steam
// never re-renders them for the new one (its "manager created" flag is already true). Until something makes
// them render again (a page change), a click on «Магазин» / «Сообщество» / the profile in the header asks
// the FIRST manager: the route becomes /browser/, but the URL is loaded into the destroyed view, and the
// window shows an empty page. Seen as «nothing but the library opens».
//
// What. The managers' class (the prototype of window.MainWindowBrowserManager) is patched once: a manager
// that is not the current one (stale) no longer follows the router (the current one does), and what it is
// asked to load, reload or show is done by the current one. The current manager runs Steam's code as is.
// Steam's code is not touched in any other way; stop() puts the class back as it was.
'use strict';

const EVERY_MS = 250;     // how often to look for the manager while Steam has not made it yet
const LIMIT_MS = 120000;  // no manager by then (no main window): stop looking
const MARK = '__arkadaBrowserFix';
// What a stale manager hands to the current one: methods, then getters Steam's URL bar reads
const METHODS = ['LoadURL', 'Reload', 'GetLastActiveTab'];
const GETTERS = ['DisplayURL', 'PageSecurity', 'Loading', 'Title'];

function createBrowserFix(o) {
  const win = o.win;
  const every = o.everyMs || EVERY_MS, limit = o.limitMs || LIMIT_MS;
  const now = o.now || (() => Date.now());
  const started = now();
  let stopped = false, timer = null, state = 'waiting', proto = null;
  const saved = []; // [name, own descriptor or undefined] to put back

  const current = () => { try { return win.MainWindowBrowserManager || null; } catch (e) { return null; } };
  // The current manager when `m` is not it (and it is one of the same class), else null
  const newer = m => {
    const c = current();
    return c && c !== m && Object.getPrototypeOf(c) === proto ? c : null;
  };

  function patch(p) {
    proto = p;
    const own = name => Object.getOwnPropertyDescriptor(p, name);
    const put = (name, desc) => { saved.push([name, own(name)]); Object.defineProperty(p, name, Object.assign({ configurable: true }, desc)); };

    const sync = p.SyncWithNewRouterEvent;
    put('SyncWithNewRouterEvent', {
      writable: true,
      value: function (location, action) {
        if (newer(this)) { this.m_lastLocation = location; return undefined; }
        return sync.apply(this, arguments);
      },
    });
    for (const name of METHODS) {
      const fn = p[name];
      if (typeof fn !== 'function') continue;
      put(name, {
        writable: true,
        value: function () {
          const c = newer(this);
          if (!c) return fn.apply(this, arguments);
          // The current manager expects the browser's history to change (as after its own ShowURL),
          // else it would take the change for one made inside the page and push a route of its own
          if (name === 'LoadURL' && typeof c.StartWaitingForHistoryCallback === 'function') c.StartWaitingForHistoryCallback();
          return c[name].apply(c, arguments);
        },
      });
    }
    for (const name of GETTERS) {
      const d = own(name);
      if (!d || typeof d.get !== 'function') continue;
      const get = d.get;
      put(name, { enumerable: d.enumerable, get: function () { const c = newer(this); return c ? c[name] : get.call(this); } });
    }
    put(MARK, { writable: true, value: true });
  }

  function tick() {
    timer = null;
    if (stopped) return;
    const m = current();
    const p = m && Object.getPrototypeOf(m);
    if (p && typeof p.SyncWithNewRouterEvent === 'function' && typeof p.LoadURL === 'function') {
      // A second copy of the plugin (a reload) finds the class patched by the first: that one's stop() undoes it
      if (Object.prototype.hasOwnProperty.call(p, MARK)) { state = 'patched before'; return; }
      try { patch(p); state = 'on'; } catch (e) { state = 'failed'; }
      return;
    }
    if (now() - started >= limit) { state = 'gave up'; return; }
    timer = setTimeout(tick, every);
  }
  tick();

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    for (let i = saved.length - 1; i >= 0; i--) {
      const [name, desc] = saved[i];
      try { if (desc) Object.defineProperty(proto, name, desc); else delete proto[name]; } catch (e) { }
    }
    saved.length = 0;
    if (state === 'on') state = 'stopped';
  }
  return { stop, state: () => state };
}

module.exports = { createBrowserFix };
