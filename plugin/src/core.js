// Arkada, the part that knows nothing about Steam: what is said to the dev.txt hub and when.
// Everything Steam-specific comes in through `steam` (see steam.js), so this file runs unchanged
// in Node against the reference hub — that is how test/plugin.test.js checks it.
//
//   const arkada = createArkada({ connect, steam, storage, version, now });
//   arkada.stop();
//
//   connect   the `connect` of the hub client (hub-client.js)
//   steam     { appName, watchGames, watchDownloads, watchToasts, friendCounts, launch, openLibrary, acceptInvite, applyTheme }
//   storage   { getItem, setItem } — localStorage of the Steam page
'use strict';

const APP = 'arkada';
const STORAGE_KEY = 'arkada.settings';
const FRIENDS_EVERY_MS = 15000;

// The four switches shown on the settings page of core.txt
const SWITCHES = [
  { key: 'shareGames', label: 'Показывать игры другим приложениям dev.txt', hint: 'Какая игра запущена и какие достижения получены' },
  { key: 'shareDownloads', label: 'Показывать загрузки', hint: 'Что Steam скачивает сейчас, сколько готово и с какой скоростью' },
  { key: 'shareInvites', label: 'Показывать приглашения', hint: 'Кто и в какую игру зовёт' },
  { key: 'shareMessages', label: 'Показывать сообщения', hint: 'Кто и что написал в личных сообщениях' },
];

const INVITE_URL = /^steam:\/\/(joinlobby|rungame|remoteplay\/connect)\/\d[A-Za-z0-9/_%.:?&=+~@,-]*$/i;
const str = (v, max) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').slice(0, max || 400);
const validSteamId = v => typeof v === 'string' && /^\d{5,20}$/.test(v);

function createArkada(o) {
  const steam = o.steam, storage = o.storage || null;
  const now = o.now || (() => Date.now());
  const cleanup = [];
  let stopped = false;

  // ───────── Settings ─────────
  const settings = { shareGames: true, shareDownloads: true, shareInvites: true, shareMessages: true };
  try {
    const saved = JSON.parse((storage && storage.getItem(STORAGE_KEY)) || '{}');
    for (const s of SWITCHES) if (typeof saved[s.key] === 'boolean') settings[s.key] = saved[s.key];
  } catch (e) { /* nothing saved yet, or the storage is closed: defaults */ }

  const settingsState = () => ({
    groups: [{
      title: 'Steam',
      items: SWITCHES.map(s => ({ key: s.key, type: 'switch', label: s.label, hint: s.hint, value: settings[s.key] })),
    }],
  });

  function setSetting(args) {
    const key = args && args.key;
    if (!SWITCHES.some(s => s.key === key)) throw new Error('unknown-key');
    if (typeof args.value !== 'boolean') throw new Error('bad-value');
    settings[key] = args.value;
    try { if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) { /* kept for this session only */ }
    hub.state(APP + '.settings', settingsState());
    publishGame();
    publishDownload();
    return { key, value: settings[key] };
  }

  // ───────── States: the hub gets one only when it really changed ─────────
  const said = new Map();
  function say(topic, data) {
    const text = JSON.stringify(data === undefined ? null : data);
    if (said.get(topic) === text) return;
    said.set(topic, text);
    hub.state(topic, data);
  }

  // Games running right now, oldest first; the newest one is "the game"
  const running = new Map(); // appId → since
  function publishGame() {
    let game = null;
    if (settings.shareGames) for (const [appId, since] of running) game = { appId, name: steam.appName(appId), since };
    say(APP + '.game', game);
  }
  function onGame(appId, isRunning) {
    appId = Number(appId);
    if (!Number.isInteger(appId) || appId <= 0) return; // shortcuts to non-Steam games come with 0
    if (isRunning) { if (!running.has(appId)) running.set(appId, now()); }
    else running.delete(appId);
    publishGame();
  }

  let download = null;
  function publishDownload() { say(APP + '.downloads', settings.shareDownloads ? download : null); }
  function onDownload(d) {
    const appId = d ? Number(d.appId) : 0;
    download = !appId ? null : {
      appId,
      name: steam.appName(appId),
      progress: Math.max(0, Math.min(1, Number(d.progress) || 0)),
      bytesPerSecond: Math.max(0, Number(d.bytesPerSecond) || 0),
      paused: d.paused === true,
    };
    publishDownload();
  }

  function publishFriends() {
    const c = steam.friendCounts();
    say(APP + '.friends', c ? { online: Number(c.online) || 0, inGame: Number(c.inGame) || 0 } : null);
  }

  // ───────── Events: Steam's own pop-up notifications ─────────
  // `t` is what steam.js makes of a notification: { kind, title, body, icon, steamid, url, game, appId }.
  const invites = new Map(); // steamid → the "join" address of the latest invite
  function onToast(t) {
    if (!t) return;
    const kind = str(t.kind, 60).toLowerCase();
    const url = str(t.url, 600);
    const base = { title: str(t.title), text: str(t.body), icon: str(t.icon, 600) };
    const appId = Number(t.appId) || 0;

    // A game invite arrives as a chat message whose "open" address joins the friend's game
    if (INVITE_URL.test(url)) {
      const steamid = validSteamId(t.steamid) ? t.steamid : '';
      if (steamid) {
        invites.delete(steamid);
        invites.set(steamid, url);
        while (invites.size > 20) invites.delete(invites.keys().next().value);
      }
      if (settings.shareInvites) hub.event(APP + '.invite', { steamid, from: base.title, game: str(t.game), appId, text: base.text, icon: base.icon, url });
      return;
    }
    if (kind === 'achievement') {
      if (settings.shareGames) hub.event(APP + '.achievement', { appId, game: str(t.game) || steam.appName(appId), title: base.title, text: base.text, icon: base.icon });
      return;
    }
    if (kind === 'friend message' && settings.shareMessages)
      hub.event(APP + '.message', { steamid: validSteamId(t.steamid) ? t.steamid : '', from: base.title, text: base.text, icon: base.icon });
  }

  // ───────── Commands from other apps ─────────
  const commands = {
    'game.launch'(args) {
      const appId = Number(args.appId);
      if (!Number.isInteger(appId) || appId <= 0 || appId > 0xFFFFFFFF) throw new Error('bad-app');
      if (!steam.launch(appId)) throw new Error('steam-unavailable');
      return { appId, name: steam.appName(appId) };
    },
    'library.open'() {
      if (!steam.openLibrary()) throw new Error('steam-unavailable');
      return null;
    },
    // { steamid } — the latest invite from that friend; { url } — the address from the `arkada.invite` event
    'invite.accept'(args) {
      const steamid = validSteamId(args.steamid) ? args.steamid : '';
      let url = str(args.url, 600);
      if (url && !INVITE_URL.test(url)) throw new Error('bad-url');
      if (!url && steamid) url = invites.get(steamid) || '';
      if (!url && !steamid) throw new Error('no-invite');
      if (!steam.acceptInvite({ steamid, url })) throw new Error('no-invite');
      if (steamid) invites.delete(steamid);
      return null;
    },
    'settings.set': setSetting,
    'settings.run'() { throw new Error('unknown-key'); }, // there are no buttons among the settings
  };

  // ───────── The hub ─────────
  const hub = o.connect({
    app: APP, name: 'Arkada', version: o.version || '', port: o.port,
    topics: ['hub.theme'],
    commands,
    onState(topic, data) {
      if (topic !== 'hub.theme') return;
      const t = data || {};
      steam.applyTheme({
        accent: typeof t.accent === 'string' && /^#[0-9a-f]{6}$/i.test(t.accent) ? t.accent : null,
        reducedMotion: t.reducedMotion === true,
      });
    },
    onStatus: o.onStatus,
  });

  hub.state(APP + '.settings', settingsState());
  publishGame();
  publishDownload();
  publishFriends();

  const guard = fn => function () { if (!stopped) try { return fn.apply(null, arguments); } catch (e) { /* one bad notification must not stop the rest */ } };
  for (const off of [steam.watchGames(guard(onGame)), steam.watchDownloads(guard(onDownload)), steam.watchToasts(guard(onToast))])
    if (typeof off === 'function') cleanup.push(off);
  const timer = setInterval(guard(publishFriends), o.friendsEveryMs || FRIENDS_EVERY_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();

  return {
    hub,
    settings: () => Object.assign({}, settings),
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      for (const f of cleanup.splice(0)) try { f(); } catch (e) { /* already gone */ }
      try { steam.applyTheme({ accent: null, reducedMotion: false }); } catch (e) { /* the window is closing */ }
      hub.close();
    },
  };
}

module.exports = { createArkada, SWITCHES, STORAGE_KEY, INVITE_URL };
