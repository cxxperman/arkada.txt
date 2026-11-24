// Arkada, the part that touches Steam. Every call into the client lives here and nowhere else,
// each behind a check and a try: a Steam update may remove any of them, and then that one feature
// goes quiet while the rest keeps working.
//
// Where each call comes from (none of it could be run inside Steam while writing this):
//   [K] used by the Kapsula plugin that already runs on this PC (integrations/millennium/kapsula)
//   [S] seen in the client's own script (steamui/sp.js) and in Millennium's typings, never run by us
//   [?] a guess from the same script; marked where it is used
'use strict';

const PLUGIN = 'arkada'; // the plugin's name in plugin.json: Millennium routes backend calls by it
const SNAPSHOT = require('./steam-snapshot.js'); // a few class modules of the client, written by build.js from steam-classes.json

function createSteam(win) {
  const client = () => win.SteamClient;
  const friendsApp = () => win.g_FriendsUIApp;
  const accountOf = steamid => Number(BigInt(steamid) & 0xFFFFFFFFn);
  const unregister = h => () => { try { if (h && typeof h.unregister === 'function') h.unregister(); else if (h && typeof h.Unregister === 'function') h.Unregister(); } catch (e) { /* gone already */ } };

  // [K] Name of a game by its number, from Steam's own library data
  function appName(appId) {
    const id = Number(appId);
    if (!id) return '';
    try { const o = win.appStore && win.appStore.GetAppOverviewByAppID && win.appStore.GetAppOverviewByAppID(id); if (o && o.display_name) return String(o.display_name); } catch (e) { }
    try { const a = friendsApp().AppInfoStore.GetAppInfo(id); if (a && a.name) return String(a.name); } catch (e) { }
    return '';
  }

  // ───────── Games ─────────
  function watchGames(cb) {
    // [?] Games already running when the plugin loads. If this is not there, a game started before Steam
    //     loaded the plugin is simply not reported until the next one starts.
    try {
      const apps = win.SteamUIStore && win.SteamUIStore.RunningApps;
      if (Array.isArray(apps)) for (const a of apps) if (a && a.appid) cb(Number(a.appid), true);
    } catch (e) { }
    // [S] SteamClient.GameSessions.RegisterForAppLifetimeNotifications → { unAppID, nInstanceID, bRunning }
    try {
      const gs = client() && client().GameSessions;
      if (!gs || typeof gs.RegisterForAppLifetimeNotifications !== 'function') return null;
      return unregister(gs.RegisterForAppLifetimeNotifications(n => { if (n) cb(Number(n.unAppID) || 0, n.bRunning === true); }));
    } catch (e) { return null; }
  }

  // ───────── Downloads ───────── [K] the same call and the same fields as in the Kapsula plugin, at most once a second
  // One registration with Steam for everybody who listens (the hub part and the Kapsula module): `cb(overview)`
  // gets Steam's overview as it is. The registration goes when the last listener does.
  const overviewListeners = new Set();
  let overviewOff = null;
  function watchDownloadOverview(cb) {
    overviewListeners.add(cb);
    if (!overviewOff) {
      try {
        const d = client() && client().Downloads;
        if (d && typeof d.RegisterForDownloadOverview === 'function')
          overviewOff = unregister(d.RegisterForDownloadOverview(o => { for (const l of Array.from(overviewListeners)) try { l(o); } catch (e) { } }));
      } catch (e) { overviewOff = null; }
    }
    if (!overviewOff) { overviewListeners.delete(cb); return null; }
    return () => {
      overviewListeners.delete(cb);
      if (!overviewListeners.size && overviewOff) { const off = overviewOff; overviewOff = null; off(); }
    };
  }
  function watchDownloads(cb) {
    try {
      let lastAt = 0, lastKey = '';
      return watchDownloadOverview(o => {
        const appId = o && o.update_appid ? Number(o.update_appid) : 0;
        const state = o && typeof o.update_state === 'string' ? o.update_state : '';
        if (!appId || state === 'None') {
          if (lastKey !== 'none') { lastKey = 'none'; cb(null); }
          return;
        }
        const key = appId + '|' + (o.paused ? 1 : 0) + '|' + state, t = Date.now();
        if (key === lastKey && t - lastAt < 1000) return;
        lastKey = key; lastAt = t;
        cb({
          appId,
          progress: (Number(o.overall_percent_complete) || 0) / 100,
          bytesPerSecond: Number(o.update_network_bytes_per_second) || 0,
          paused: !!o.paused,
        });
      });
    } catch (e) { return null; }
  }

  // ───────── Friends ─────────
  // [S] g_FriendsUIApp.FriendStore.all_friends, friend.persona.is_online / is_ingame
  function friendCounts() {
    try {
      const store = friendsApp() && friendsApp().FriendStore;
      if (!store || store.friends_list_ready === false) return null;
      const all = store.all_friends;
      if (!Array.isArray(all)) return null;
      let online = 0, inGame = 0;
      for (const f of all) {
        const p = f && f.persona;
        if (!p || !p.is_online) continue;
        online++;
        if (p.is_ingame) inGame++;
      }
      return { online, inGame };
    } catch (e) { return null; }
  }

  // ───────── Notifications ─────────
  // Notification data comes either as plain fields or as getter functions, depending on its kind. [K]
  function field(d, name) {
    try {
      if (!d) return '';
      let v = d[name];
      if (typeof v === 'function') v = v.call(d);
      if (typeof v === 'string') return v.length > 400 ? v.slice(0, 400) + '…' : v;
      if (typeof v === 'number') return String(v);
    } catch (e) { }
    return '';
  }

  // [K] A friend by SteamID from Steam's own friends list: name, avatar and the game they are in
  function friend(steamid) {
    const out = { name: '', game: '', avatar: '' };
    try {
      if (!steamid) return out;
      const store = friendsApp() && friendsApp().FriendStore;
      const p = store && typeof store.GetPlayer === 'function' ? store.GetPlayer(accountOf(steamid)) : null;
      if (!p) return out;
      const per = p.persona;
      out.name = String(p.display_name || (per && per.m_strPlayerName) || '');
      if (per) {
        let game = '';
        try { if (typeof per.GetCurrentGameName === 'function') game = per.GetCurrentGameName() || ''; } catch (e) { }
        out.game = String(game || per.m_strGameExtraInfo || '');
        out.avatar = String(per.avatar_url_medium || '');
      }
    } catch (e) { }
    return out;
  }

  // [K] What Steam is about to show, in plain fields
  function describeToast(config, n) {
    const d = n && n.data;
    const out = {
      kind: config && typeof config.strTest === 'string' ? config.strTest : '',
      title: field(d, 'title') || field(d, 'name'),
      body: field(d, 'body') || field(d, 'description'),
      icon: field(d, 'icon') || field(d, 'image') || field(d, 'image_url'),
      steamid: field(d, 'steamid'), url: field(d, 'response_steamurl'),
      game: field(d, 'game_name'), appId: Number(field(d, 'appid')) || 0,
    };
    if (!out.game && out.appId) out.game = appName(out.appId);
    if (out.steamid && (!out.title || !out.icon || !out.game)) {
      const f = friend(out.steamid);
      if (!out.title) out.title = f.name;
      if (!out.icon) out.icon = f.avatar;
      if (!out.game) out.game = f.game;
    }
    return out;
  }

  // [K] NotificationStore.BShowToast decides whether Steam shows a pop-up. One hook for every listener:
  //   watchToasts(cb)                cb(describeToast(…)) for each pop-up Steam is about to show (the hub part)
  //   watchToasts(cb, { raw: true }) cb({ config, notification, show, store }) for every call, shown or not
  //                                  (the Kapsula module); returning false hides Steam's own pop-up — only
  //                                  the Kapsula module does that, when Kapsula asks for it
  // Otherwise Steam's answer is passed on untouched. The hook goes when the last listener does.
  const toastListeners = new Set();
  let toastUndo = null, toastTimer = null, toastTries = 0;
  function hookToasts() {
    const store = win.NotificationStore;
    if (!store || typeof store.BShowToast !== 'function') return false;
    const own = Object.prototype.hasOwnProperty.call(store, 'BShowToast'), orig = store.BShowToast;
    let dead = false;
    const wrapped = function (config, notification) {
      const show = orig.apply(this, arguments);
      if (dead) return show;
      let hide = false, described = null;
      for (const l of Array.from(toastListeners)) {
        try {
          if (l.raw) { if (l.cb({ config, notification, show, store: this }) === false && show) hide = true; }
          else if (show) l.cb(described || (described = describeToast(config, notification)));
        } catch (e) { /* one listener must not break Steam's notifications */ }
      }
      return hide ? false : show;
    };
    store.BShowToast = wrapped;
    toastUndo = () => {
      dead = true;
      try {
        // Somebody hooked after us: leave the chain alone, `dead` already makes our link a pass-through
        if (store.BShowToast !== wrapped) return;
        if (own) store.BShowToast = orig; else delete store.BShowToast;
      } catch (e) { }
    };
    return true;
  }
  function watchToasts(cb, opts) {
    const l = { cb, raw: !!(opts && opts.raw) };
    toastListeners.add(l);
    // The store may appear a little later than the plugin
    if (!toastUndo && !toastTimer) {
      toastTries = 0;
      (function attempt() {
        toastTimer = null;
        if (!toastListeners.size || toastUndo || hookToasts() || ++toastTries >= 30) return;
        toastTimer = setTimeout(attempt, 2000);
      })();
    }
    return () => {
      toastListeners.delete(l);
      if (toastListeners.size) return;
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
      if (toastUndo) { const u = toastUndo; toastUndo = null; u(); }
    };
  }
  const toastsHooked = () => !!toastUndo;

  // ───────── Commands ─────────
  // [S] SteamClient.URL.ExecuteSteamURL — the client itself opens steam:// addresses with it
  function steamUrl(url) {
    try {
      const u = client() && client().URL;
      if (!u || typeof u.ExecuteSteamURL !== 'function') return false;
      u.ExecuteSteamURL(url);
      return true;
    } catch (e) { return false; }
  }

  function launch(appId) {
    if (steamUrl('steam://rungameid/' + appId)) return true;
    // [S] the call behind the Play button; 100 is the "launched from the client" source in Millennium's typings
    try { client().Apps.RunGame(String(appId), '', -1, 100); return true; } catch (e) { return false; }
  }

  const openLibrary = () => steamUrl('steam://open/library');

  // [S] An invite in Steam's chat has AcceptGameInvite(), next to the DismissInvite() that Kapsula already calls [K].
  //     Failing that, the "join" address from the notification is opened, the way Kapsula does it.
  function acceptInvite(a) {
    try {
      if (a.steamid) {
        const store = friendsApp().ChatStore.GameInviteStore;
        const list = store && store.m_mapGameInvites && store.m_mapGameInvites.get(accountOf(a.steamid));
        let latest = null;
        if (list) list.forEach(inv => { if (inv && !inv.bDismissed && !inv.bAccepted && (!latest || inv.rtTimestamp > latest.rtTimestamp)) latest = inv; });
        if (latest && typeof latest.AcceptGameInvite === 'function') { latest.AcceptGameInvite(); return true; }
      }
    } catch (e) { }
    return a.url ? steamUrl(a.url) : false;
  }

  // ───────── The shared look of dev.txt ─────────
  // The theme reads --arkada-hub-accent, [data-arkada-motion] and [data-arkada-backdrop] on <html> of every Steam window.
  // [S] g_PopupManager.GetPopups() / AddPopupCreatedCallback — Millennium itself finds the windows this way.
  let look = { accent: null, reducedMotion: false, backdrop: null }, popupHook = null;
  const windowListeners = new Set();
  // [?] Big Picture's window is named "SP BPM_…" in the client's script; it keeps no backdrop (the backend skips it too)
  const isBigPicture = p => { try { return /BPM|BigPicture|Big Picture/i.test(String(p.m_strName || p.m_strTitle || '')); } catch (e) { return false; } };
  function paint(doc, bigPicture) {
    try {
      const el = doc && doc.documentElement;
      if (!el) return;
      if (look.accent) el.style.setProperty('--arkada-hub-accent', look.accent); else el.style.removeProperty('--arkada-hub-accent');
      if (look.reducedMotion) el.setAttribute('data-arkada-motion', 'reduced'); else el.removeAttribute('data-arkada-motion');
      if (look.backdrop && !bigPicture) el.setAttribute('data-arkada-backdrop', look.backdrop); else el.removeAttribute('data-arkada-backdrop');
    } catch (e) { }
  }
  // Menus (title "… Menu", "… Supernav"): the backend gives them no backdrop (their window is bigger than the
  // menu, for its shadow), so they are not marked either and the theme draws their panel solid
  const isMenu = p => { try { return /(?:Menu|Supernav)$/.test(String(p.window.document.title || '')); } catch (e) { return false; } };
  const paintPopup = p => paint(p && p.window && p.window.document, p ? isBigPicture(p) || isMenu(p) : false);
  function popups() {
    try {
      const pm = win.g_PopupManager;
      return pm && typeof pm.GetPopups === 'function' ? Array.from(pm.GetPopups()) : [];
    } catch (e) { return []; }
  }
  function hookPopups() {
    try {
      const pm = win.g_PopupManager;
      if (popupHook || !pm || typeof pm.AddPopupCreatedCallback !== 'function') return;
      popupHook = pm.AddPopupCreatedCallback(p => {
        paintPopup(p);
        for (const cb of windowListeners) try { cb(p); } catch (e) { }
      });
    } catch (e) { }
  }
  function paintAll() {
    paint(win.document, false);
    for (const p of popups()) paintPopup(p);
    hookPopups();
  }
  function applyTheme(next) {
    look.accent = next.accent || null;
    look.reducedMotion = next.reducedMotion === true;
    paintAll();
  }

  // ───────── Window backdrop (Mica / Acrylic) ─────────
  // The theme says which backdrop it wants with --arkada-backdrop on <html> ("mica", "acrylic" or "off",
  // see overlay/options/backdrop-*.css). null: no theme answered yet.
  // "off" is what overlay/tokens.css says before the setting's own file (options/backdrop-*.css) is in, so
  // a window still loading its styles says "off" for a moment: a window that says mica or acrylic outweighs
  // it, and "off" is the answer only when every window that answers says so. Windows that disagree on
  // mica / acrylic (the setting just changed): the main window's word, else the first one's.
  function readBackdrop() {
    const answers = [];
    const read = (w, main) => {
      try {
        if (!w || typeof w.getComputedStyle !== 'function' || !w.document || !w.document.documentElement) return;
        const v = String(w.getComputedStyle(w.document.documentElement).getPropertyValue('--arkada-backdrop') || '')
          .trim().replace(/^["']|["']$/g, '').toLowerCase();
        if (v === 'blur' || v === 'mica' || v === 'acrylic' || v === 'off') answers.push({ v, main });
      } catch (e) { }
    };
    read(win, false);
    for (const p of popups()) read(p && p.window, !!p && /^SP Desktop/.test(String(p.m_strName || '')));
    const on = answers.filter(a => a.v !== 'off');
    if (on.length) return (on.find(a => a.main) || on[0]).v;
    return answers.length ? 'off' : null;
  }
  // The theme draws see-through only where <html data-arkada-backdrop> says the backdrop is on
  function markBackdrop(mode) {
    look.backdrop = mode === 'blur' || mode === 'mica' || mode === 'acrylic' ? mode : null;
    paintAll();
  }
  // A new Steam window: called with its popup once g_PopupManager knows it
  function watchWindows(cb) {
    windowListeners.add(cb);
    hookPopups();
    return () => { windowListeners.delete(cb); };
  }
  // A Steam window comes on screen: cb() each time one of the popups' documents turns visible.
  // Menus are made hidden ahead of time and only shown on a click, with no window.open then; the
  // document's visibilitychange is the moment their window is there for the backend to patch.
  function watchShown(cb) {
    let dead = false;
    const hooked = new Set();
    const hook = p => {
      try {
        const doc = p && p.window && p.window.document;
        if (!doc || hooked.has(doc) || typeof doc.addEventListener !== 'function') return;
        const on = () => { if (!dead && doc.visibilityState === 'visible') try { cb(p); } catch (e) { } };
        doc.addEventListener('visibilitychange', on);
        hooked.add(doc);
      } catch (e) { }
    };
    for (const p of popups()) hook(p);
    windowListeners.add(hook);
    hookPopups();
    return () => { dead = true; windowListeners.delete(hook); hooked.clear(); };
  }
  // [S] The client opens its windows with window.open(url), the window's kind in the address (`createflags=…`);
  //     the way the DWMX plugin rewrites it. `rewrite(url)` → the address to open, `after()` runs once it is open.
  function patchWindowOpen(rewrite, after) {
    const orig = win.open;
    if (typeof orig !== 'function') return null;
    let dead = false;
    const wrapped = function (url) {
      const args = Array.prototype.slice.call(arguments);
      if (!dead) try { args[0] = rewrite(url); } catch (e) { args[0] = url; }
      const w = orig.apply(this, args);
      if (!dead) try { after(); } catch (e) { }
      return w;
    };
    win.open = wrapped;
    return () => {
      dead = true;
      try { if (win.open === wrapped) win.open = orig; } catch (e) { } // somebody wrapped us: `dead` makes our link a pass-through
    };
  }
  // [K] Millennium.callServerMethod(plugin, method, kwargs) — how Millennium's own `callable` reaches a Lua
  //     backend (the size-on-disk and HLTB plugins on this PC call it so). → a Promise of the reply, or null
  //     when there is no backend or it does not answer within waitMs (5 s unless said: HLTB may need a minute).
  function callBackend(method, args, waitMs) {
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (!done) { done = true; clearTimeout(timer); resolve(v === undefined ? null : v); } };
      const timer = setTimeout(() => finish(null), Number(waitMs) > 0 ? Number(waitMs) : 5000);
      try {
        const m = win.Millennium;
        if (!m || typeof m.callServerMethod !== 'function') return finish(null);
        Promise.resolve(m.callServerMethod(PLUGIN, method, args)).then(finish, () => finish(null));
      } catch (e) { finish(null); }
    });
  }

  // ───────── Chat (the Kapsula module, sharing a store page) ─────────
  const validId = s => typeof s === 'string' && /^\d{5,20}$/.test(s);
  // [K] SteamClient.WebChat.ShowFriendChatDialog(steamid) — the Kapsula plugin opens a chat this way
  function openChat(steamid) {
    if (!validId(steamid)) return false;
    try { client().WebChat.ShowFriendChatDialog(steamid); return true; } catch (e) { return false; }
  }
  // [K] g_FriendsUIApp.ChatStore.GetFriendChat(account, true).SendChatMessage(text) — the Kapsula plugin
  //     answers a friend from the island this way. → a Promise of true, or an Error with the reason
  async function sendChat(steamid, text) {
    if (!validId(steamid) || typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('bad request');
    const chat = friendsApp().ChatStore.GetFriendChat(accountOf(steamid), true);
    if (!chat || typeof chat.SendChatMessage !== 'function') throw new Error('chat not available');
    await chat.SendChatMessage(text);
    return true;
  }
  // [K] An invite in Steam's chat: DismissInvite(), as the Dismiss button in the chat does
  function dismissInvite(steamid) {
    try {
      if (!validId(steamid)) return false;
      const store = friendsApp() && friendsApp().ChatStore && friendsApp().ChatStore.GameInviteStore;
      const list = store && store.m_mapGameInvites && store.m_mapGameInvites.get(accountOf(steamid));
      if (!list) return false;
      list.forEach(inv => { try { if (!inv.bDismissed && !inv.bAccepted) inv.DismissInvite(); } catch (e) { } });
      return true;
    } catch (e) { return false; }
  }
  // [K] Steam's own sample notifications (NotificationStore.TestFriendMessage(), TestAchievement(550)…)
  function testToast(name, arg) {
    const store = win.NotificationStore;
    if (!/^Test[A-Za-z]{1,40}$/.test(String(name)) || !store || typeof store[name] !== 'function') return false;
    if (arg !== undefined) store[name](arg); else store[name]();
    return true;
  }
  // Another Millennium plugin is loaded and running in this context: its bundle has put its exports
  // (with `default`) into PLUGIN_LIST under its name, as ours does
  function pluginRunning(name) {
    try { const p = win.PLUGIN_LIST && win.PLUGIN_LIST[name]; return !!p && typeof p.default === 'function'; } catch (e) { return false; }
  }
  // [S] The friends list for the share dialog of a store page: g_FriendsUIApp.FriendStore.all_friends
  //     (persona.is_online / is_ingame as in friendCounts; steamid64, accountid, localized_online_status
  //     [?] from the client's script). → [{ id, name, status, avatar, online, inGame }], online first, by name
  function friendsList() {
    const store = friendsApp() && friendsApp().FriendStore;
    const all = store && store.all_friends;
    if (!Array.isArray(all)) throw new Error('not ready');
    const out = [];
    for (const f of all) {
      try {
        if (!f || f.is_friend === false) continue;
        const per = f.persona || f.m_persona || {};
        let id = f.steamid64 ? String(f.steamid64) : '';
        if (!id && per.m_steamid && typeof per.m_steamid.ConvertTo64BitString === 'function') id = String(per.m_steamid.ConvertTo64BitString());
        if (!validId(id)) continue;
        let game = '';
        try { if (typeof per.GetCurrentGameName === 'function') game = per.GetCurrentGameName() || ''; } catch (e) { }
        const online = !!per.is_online, inGame = online && !!per.is_ingame;
        const status = typeof f.localized_online_status === 'string' && f.localized_online_status ? f.localized_online_status
          : inGame ? (game ? 'Играет в ' + game : 'В игре') : online ? 'В сети' : 'Не в сети';
        out.push({ id, name: String(f.display_name || per.m_strPlayerName || id).slice(0, 80), status: String(status).slice(0, 80), avatar: String(per.avatar_url_medium || '').slice(0, 400), online, inGame });
      } catch (e) { }
    }
    out.sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
    return out;
  }

  // ───────── The theme's switches for the plugin's features ─────────
  // The setting «Arkada: …» of the theme puts --arkada-<name>: on | off on <html> (overlay/tokens.css says on,
  // overlay/options/feature-*-off.css off). Read in the main window only: it has had its styles for long,
  // a window just opening would say "on" for a moment. → { name: 'on' | 'off' | null }, null: no answer
  const mainPopup = () => popups().find(p => p && /^SP Desktop/.test(String(p.m_strName || ''))) || null;
  function readFlags(names) {
    const out = {};
    for (const n of names) out[n] = null;
    try {
      const p = mainPopup(), w = p && p.window;
      if (!w || typeof w.getComputedStyle !== 'function' || !w.document || !w.document.documentElement) return out;
      const cs = w.getComputedStyle(w.document.documentElement);
      for (const n of names) {
        const v = String(cs.getPropertyValue('--arkada-' + n) || '').trim().replace(/^["']|["']$/g, '').toLowerCase();
        if (v === 'on' || v === 'off') out[n] = v;
      }
    } catch (e) { }
    return out;
  }

  // ───────── The main window's pages (the size on disk) ─────────
  // The main window (popup "SP Desktop_…") with its document, or null while it is closed (Steam in the tray)
  function mainWindow() { const p = mainPopup(); try { return p && p.window && p.window.document ? p.window : null; } catch (e) { return null; } }
  // [S] Steam's router: SteamUIStore.WindowStore.MainWindowInstance.m_history (history v4: location, listen) —
  //     overlay/nav.js and Steam Enhanced's runtime listen to it. cb(path) now and on every change; the path
  //     without the "/routes" some builds put in front. Retries for a minute while the store is not up.
  function watchRoute(cb) {
    let dead = false, off = null, timer = null, tries = 0;
    const clean = p => String(p || '').replace(/^\/routes(?=\/)/, '');
    (function attempt() {
      timer = null;
      if (dead) return;
      let h = null;
      try { h = win.SteamUIStore.WindowStore.MainWindowInstance.m_history; } catch (e) { }
      if (!h || typeof h.listen !== 'function') { if (++tries < 60) timer = setTimeout(attempt, 1000); return; }
      try {
        const u = h.listen(loc => { if (!dead) cb(clean((loc && loc.pathname) || (h.location && h.location.pathname))); });
        off = typeof u === 'function' ? u : null;
      } catch (e) { return; }
      cb(clean(h.location && h.location.pathname));
    })();
    return () => { dead = true; if (timer) clearTimeout(timer); if (off) try { off(); } catch (e) { } };
  }
  // The main window's page now (history v4 location of the router above), or null while it is not up
  function currentRoute() {
    try {
      const h = win.SteamUIStore.WindowStore.MainWindowInstance.m_history;
      const p = h && h.location && h.location.pathname;
      return p ? String(p).replace(/^\/routes(?=\/)/, '') : null;
    } catch (e) { return null; }
  }
  // [S] SteamUIStore.Navigate(path): how the client itself opens its pages in the main window
  function navigate(path) {
    try {
      const s = win.SteamUIStore;
      if (!s || typeof s.Navigate !== 'function') return false;
      s.Navigate(path);
      return true;
    } catch (e) { return false; }
  }
  // [K] MILLENNIUM_API.findClassModule(m => m.GameStat) — the hashed classes of one of Steam's style modules,
  //     as the Size on Disk plugin finds them. Failing that, the snapshot of the client taken by
  //     tools/steam-classes.js (steam-snapshot.js, written by build.js). null: neither knows them.
  const classCache = new Map();
  function classes(probe) {
    if (classCache.has(probe)) return classCache.get(probe);
    let m = null;
    try { const api = win.MILLENNIUM_API; if (api && typeof api.findClassModule === 'function') m = api.findClassModule(x => x && typeof x === 'object' && typeof x[probe] === 'string') || null; } catch (e) { m = null; }
    if (!m) m = (SNAPSHOT[probe] && SNAPSHOT[probe][probe]) ? SNAPSHOT[probe] : null;
    if (m) classCache.set(probe, m);
    return m;
  }
  // [K] SteamClient.InstallFolder.GetInstallFolders() → the library folders with their games (vecApps: nAppID,
  //     nUsedSize, nDLCSize, nWorkshopSize, nShaderSize; strFolderPath, strDriveName, strUserLabel), as the Size on
  //     Disk plugin reads them. Asked of the client on this PC: nothing goes to the network. → a Map appId → sizes
  async function installedSizes() {
    const f = client() && client().InstallFolder;
    if (!f || typeof f.GetInstallFolders !== 'function') return null;
    const folders = await f.GetInstallFolders();
    const map = new Map();
    for (const folder of Array.isArray(folders) ? folders : []) {
      for (const a of (folder && Array.isArray(folder.vecApps)) ? folder.vecApps : []) {
        const appId = Number(a && a.nAppID);
        if (!appId) continue;
        map.set(appId, {
          appId, name: String(a.strAppName || ''),
          total: Number(a.nUsedSize) || 0, dlc: Number(a.nDLCSize) || 0, workshop: Number(a.nWorkshopSize) || 0, shaders: Number(a.nShaderSize) || 0,
          folder: String(folder.strFolderPath || ''), drive: String(folder.strDriveName || ''), label: String(folder.strUserLabel || ''),
        });
      }
    }
    return map;
  }
  // [?] SteamClient.Apps.OpenAppSettingsDialog(appId, "localfiles") — the game's Properties on «Установленные файлы»
  function openLocalFiles(appId) {
    try { const a = client() && client().Apps; if (a && typeof a.OpenAppSettingsDialog === 'function') { a.OpenAppSettingsDialog(Number(appId), 'localfiles'); return true; } } catch (e) { }
    return false;
  }

  // [S] SteamClient.System.OpenInSystemBrowser(url) — the client opens outside links with it. Only https links
  function openInBrowser(url) {
    if (typeof url !== 'string' || !/^https:\/\/[^\s]+$/.test(url)) return false;
    try { const s = client() && client().System; if (s && typeof s.OpenInSystemBrowser === 'function') { s.OpenInSystemBrowser(url); return true; } } catch (e) { }
    return steamUrl('steam://openurl_external/' + url);
  }
  // [K] App.m_CurrentUser.strSteamID — the SteamID64 of the user signed in (the HLTB plugin reads it so). '' if unknown
  function currentUserId() {
    try { const id = win.App && win.App.m_CurrentUser && win.App.m_CurrentUser.strSteamID; return /^\d{5,20}$/.test(String(id || '')) ? String(id) : ''; } catch (e) { return ''; }
  }

  function dispose() {
    windowListeners.clear();
    toastListeners.clear();
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    if (toastUndo) { const u = toastUndo; toastUndo = null; u(); }
    overviewListeners.clear();
    if (overviewOff) { const off = overviewOff; overviewOff = null; off(); }
    try { if (popupHook && typeof popupHook.Unregister === 'function') popupHook.Unregister(); else if (popupHook && typeof popupHook.unregister === 'function') popupHook.unregister(); } catch (e) { }
    popupHook = null;
  }

  return {
    appName, watchGames, watchDownloads, watchDownloadOverview, watchToasts, toastsHooked, friendCounts, launch, openLibrary, acceptInvite, applyTheme,
    readBackdrop, markBackdrop, watchWindows, watchShown, patchWindowOpen, callBackend,
    friend, openChat, sendChat, dismissInvite, testToast, pluginRunning, friendsList,
    readFlags, mainWindow, watchRoute, currentRoute, navigate, classes, installedSizes, openLocalFiles, openInBrowser, currentUserId, dispose,
  };
}

module.exports = { createSteam };
