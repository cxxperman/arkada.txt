// A made-up Steam page for test/plugin.test.js: just enough of `window` for the plugin to run in Node.
// It imitates the calls the plugin makes (see the list in plugin/src/steam.js) with the shapes seen in the
// Kapsula plugin and in the client's script. It is NOT Steam: passing against it proves the plugin's own
// logic, not that Steam still has these calls.
'use strict';
const vm = require('vm');

function makeRoot() {
  const style = { props: {}, setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; } };
  const attrs = {};
  return { style, attrs, setAttribute(k, v) { attrs[k] = String(v); }, removeAttribute(k) { delete attrs[k]; } };
}
const account = steamid => Number(BigInt(steamid) & 0xFFFFFFFFn);

// A browser (and so the Steam client, which is Chromium) always fires `close` after a connection that
// failed to open; the hub client relies on it to try again. Node's built-in WebSocket (seen on v22.23)
// fires only `error` when nobody listens on the port and then stays "connecting" forever.
// This makes Node's behave like the browser's, so the test checks the page's logic, not Node's quirk.
function browserLikeWebSocket(Base) {
  return class extends Base {
    constructor(url, protocols) {
      super(url, protocols);
      let opened = false, closed = false;
      this.addEventListener('open', () => { opened = true; });
      this.addEventListener('close', () => { closed = true; });
      this.addEventListener('error', () => {
        setTimeout(() => {
          if (opened || closed) return;
          this.dispatchEvent(Object.assign(new Event('close'), { code: 1006, reason: '', wasClean: false }));
        }, 0);
      });
    }
  };
}

function makePage(o) {
  const calls = { urls: [], accepted: 0, unregistered: 0, ran: [] };
  const log = [], ipc = [];
  const listeners = { game: new Set(), download: new Set(), popup: new Set() };
  const listen = set => cb => { set.add(cb); return { unregister() { set.delete(cb); calls.unregistered++; } }; };
  const names = { 570: 'Dota 2', 730: 'Counter-Strike 2', 1245620: 'ELDEN RING' };
  const root = makeRoot(), popupRoot = makeRoot();
  const popups = [{ window: { document: { documentElement: popupRoot } } }];
  const data = new Map();
  const storage = { getItem: k => (data.has(k) ? data.get(k) : null), setItem(k, v) { data.set(k, String(v)); }, removeItem(k) { data.delete(k); } };

  // Steam keeps BShowToast on the class, not on the object — the plugin must put that back when it leaves
  class NotificationStore { BShowToast(config) { return config.showToast === true; } BIsUserInGame() { return false; } }

  const invite = { bDismissed: false, bAccepted: false, rtTimestamp: 100, AcceptGameInvite() { this.bAccepted = true; calls.accepted++; }, DismissInvite() { this.bDismissed = true; } };
  const players = new Map([
    [account('76561198000000002'), { display_name: 'Timur', persona: { m_strPlayerName: 'timur', GetCurrentGameName: () => 'Counter-Strike 2', avatar_url_medium: 'https://avatars.steamstatic.com/t.jpg', is_online: true, is_ingame: true } }],
    [account('76561198000000001'), { display_name: 'Liza', persona: { is_online: true, is_ingame: false, avatar_url_medium: '' } }],
    [account('76561198000000003'), { display_name: 'Offline', persona: { is_online: false, is_ingame: false } }],
  ]);

  const window = {
    WebSocket: o.WebSocket,
    setTimeout, clearTimeout, setInterval, clearInterval,
    console: Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(k => [k, (...a) => log.push([k, a.map(String).join(' ')])])),
    localStorage: storage,
    document: { documentElement: root },
    MILLENNIUM_API: {}, SP_REACT: {},
    MILLENNIUM_BACKEND_IPC: { postMessage: (...a) => ipc.push(a) },
    NotificationStore: new NotificationStore(),
    appStore: { GetAppOverviewByAppID: id => (names[id] ? { appid: id, display_name: names[id] } : null) },
    SteamUIStore: { RunningApps: [] },
    SteamClient: {
      GameSessions: { RegisterForAppLifetimeNotifications: listen(listeners.game) },
      Downloads: { RegisterForDownloadOverview: listen(listeners.download) },
      URL: { ExecuteSteamURL: url => { calls.urls.push(url); } },
      Apps: { RunGame: (...a) => { calls.ran.push(a); } },
    },
    g_FriendsUIApp: {
      FriendStore: { friends_list_ready: true, get all_friends() { return Array.from(players.values()); }, GetPlayer: id => players.get(id) || null },
      ChatStore: { GameInviteStore: { m_mapGameInvites: new Map([[account('76561198000000002'), new Map([[100, invite]])]]) } },
      AppInfoStore: { GetAppInfo: () => null },
    },
    g_PopupManager: {
      GetPopups: () => popups,
      AddPopupCreatedCallback(cb) { listeners.popup.add(cb); return { Unregister() { listeners.popup.delete(cb); } }; },
    },
  };
  window.window = window;
  const context = vm.createContext(window);

  const steam = {
    game(appId, running) { for (const cb of listeners.game) cb({ unAppID: appId, nInstanceID: 1, bRunning: running }); },
    download(overview) { for (const cb of listeners.download) cb(overview); },
    // Steam passes some notifications as plain fields and some as getter functions; achievements go the second way here
    toast(config, fields, show) {
      const d = config.strTest === 'Achievement' ? Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, () => v])) : fields;
      return window.NotificationStore.BShowToast(Object.assign({}, config, { showToast: show }), { eType: 1, data: d });
    },
    openPopup() {
      const r = makeRoot(), p = { window: { document: { documentElement: r } } };
      popups.push(p);
      for (const cb of listeners.popup) cb(p);
      return r;
    },
  };
  return { context, window, calls, log, ipc, storage, root, popupRoot, steam };
}

module.exports = { makePage, browserLikeWebSocket };
