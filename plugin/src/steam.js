// Arkada, the part that touches Steam. Every call into the client lives here and nowhere else,
// each behind a check and a try: a Steam update may remove any of them, and then that one feature
// goes quiet while the rest keeps working.
//
// Where each call comes from (none of it could be run inside Steam while writing this):
//   [K] used by the Kapsula plugin that already runs on this PC (integrations/millennium/kapsula)
//   [S] seen in the client's own script (steamui/sp.js) and in Millennium's typings, never run by us
//   [?] a guess from the same script; marked where it is used
'use strict';

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
  function watchDownloads(cb) {
    try {
      const d = client() && client().Downloads;
      if (!d || typeof d.RegisterForDownloadOverview !== 'function') return null;
      let lastAt = 0, lastKey = '';
      return unregister(d.RegisterForDownloadOverview(o => {
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
      }));
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

  // [K] NotificationStore.BShowToast decides whether Steam shows a pop-up. We only listen: the answer is
  //     passed on untouched, so Steam's own notification and the Kapsula plugin's hook stay as they were.
  function watchToasts(cb) {
    let dead = false, undo = null, tries = 0, timer = null;
    function hook() {
      const store = win.NotificationStore;
      if (!store || typeof store.BShowToast !== 'function') return false;
      const own = Object.prototype.hasOwnProperty.call(store, 'BShowToast'), orig = store.BShowToast;
      const wrapped = function (config, notification) {
        const show = orig.apply(this, arguments);
        if (show && !dead) try { cb(describeToast(config, notification)); } catch (e) { }
        return show;
      };
      store.BShowToast = wrapped;
      undo = () => {
        try {
          // Somebody hooked after us: leave the chain alone, `dead` already makes our link a pass-through
          if (store.BShowToast !== wrapped) return;
          if (own) store.BShowToast = orig; else delete store.BShowToast;
        } catch (e) { }
      };
      return true;
    }
    // The store may appear a little later than the plugin
    (function attempt() {
      timer = null;
      if (dead || hook() || ++tries >= 30) return;
      timer = setTimeout(attempt, 2000);
    })();
    return () => { dead = true; if (timer) clearTimeout(timer); if (undo) undo(); };
  }

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
  // The theme reads --arkada-hub-accent and [data-arkada-motion] on <html> of every Steam window.
  // [S] g_PopupManager.GetPopups() / AddPopupCreatedCallback — Millennium itself finds the windows this way.
  let look = { accent: null, reducedMotion: false }, popupHook = null;
  function paint(doc) {
    try {
      const el = doc && doc.documentElement;
      if (!el) return;
      if (look.accent) el.style.setProperty('--arkada-hub-accent', look.accent); else el.style.removeProperty('--arkada-hub-accent');
      if (look.reducedMotion) el.setAttribute('data-arkada-motion', 'reduced'); else el.removeAttribute('data-arkada-motion');
    } catch (e) { }
  }
  function applyTheme(next) {
    look = { accent: next.accent || null, reducedMotion: next.reducedMotion === true };
    paint(win.document);
    try {
      const pm = win.g_PopupManager;
      if (!pm) return;
      if (typeof pm.GetPopups === 'function') for (const p of Array.from(pm.GetPopups())) paint(p && p.window && p.window.document);
      if (!popupHook && typeof pm.AddPopupCreatedCallback === 'function')
        popupHook = pm.AddPopupCreatedCallback(p => paint(p && p.window && p.window.document));
    } catch (e) { }
  }

  return { appName, watchGames, watchDownloads, watchToasts, friendCounts, launch, openLibrary, acceptInvite, applyTheme };
}

module.exports = { createSteam };
