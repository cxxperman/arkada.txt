// Arkada, the Kapsula module: Steam's pop-up notifications and the current download go to the Kapsula island
// on this PC, exactly as the Kapsula plugin for Millennium sends them — the same address, the same messages —
// so the Kapsula app gets the same thing from Arkada as from its own plugin, and that plugin can be switched off.
//
// Ported from the Kapsula plugin (kapsula.txt, integrations/millennium/kapsula/.millennium/Dist/index.js,
// version 0.7.0; MIT, see THIRD_PARTY.md). Changed: Steam is reached through steam.js (one hook on the
// notifications and one download registration for the whole plugin), and the module is quiet while the
// Kapsula plugin itself runs in Steam, so that the island never gets a notification twice.
//
//   const k = createKapsula({ steam, WebSocket, version, port, everyMs });
//   k.stop();
//
// The protocol (Kapsula's side: kapsula.txt src/Integrations.cs, SteamBridge, and src/IslandWindow.cs):
//   ws://127.0.0.1:42071/?client=millennium — Kapsula opens this port only while its plugin's folder
//   <Steam>\millennium\plugins\kapsula is there (it need not be switched on in Millennium)
//   to Kapsula    { type: "hello", plugin, hooked }   on every connection
//                 { type: "toast", kind, eType, title, body, icon, steamid, url, game, appid, invite, extra }
//                 { type: "download", appid, name, state, paused, percent, rate, eta }; nothing: { type: "download", appid: 0 }
//                 { type: "replied", ok, message }      after "reply"
//                 { type: "error", name, message }       a test sample or openChat failed
//                 check mode only (after "test"): fields, dataShape, friend on toasts; { type: "suppressed", … }
//   from Kapsula  { cmd: "config", hideToasts }   hide Steam's own pop-up while the island shows it (never in a game)
//                 { cmd: "test", names: ["TestFriendMessage", "TestAchievement:550", …] }
//                 { cmd: "dismissInvite", steamid } { cmd: "openChat", steamid } { cmd: "reply", steamid, text }
'use strict';

const PORT = 42071;
const RETRY_MS = 5000;     // as the Kapsula plugin: a closed connection is tried again after 5 s
const QUEUE_MAX = 50;
const OWN_PLUGIN = 'kapsula';

// Notification data comes either as plain fields or as getter functions, depending on its kind
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

// Names of an object's fields and methods (no values) — sent only in check mode, to learn Steam's data shapes
function shape(o) {
  if (!o) return null;
  const own = [], methods = [];
  try { for (const k of Object.getOwnPropertyNames(o)) if (own.length < 60) own.push(k + ':' + (o[k] === null ? 'null' : typeof o[k])); } catch (e) { }
  try {
    let p = Object.getPrototypeOf(o), level = 0;
    while (p && p !== Object.prototype && level++ < 3)
      for (const k of Object.getOwnPropertyNames(p)) if (k !== 'constructor' && methods.length < 120 && methods.indexOf(k) < 0) methods.push(k);
  } catch (e) { }
  return { own, methods };
}

// Simple values of a notification: results of its argument-less getters (title, steamid, appid…); check mode only
function simpleFields(d) {
  const out = {};
  let n = 0;
  try {
    for (const k in d) {
      if (n >= 25) break;
      let v = d[k];
      if (typeof v === 'function') {
        if (v.length !== 0 || /^(set_|clone|to[A-Z]|get[A-Z]|sync|serialize|tag$)/.test(k)) continue;
        try { v = v.call(d); } catch (e) { continue; }
      }
      if (typeof v === 'string') { out[k] = v.slice(0, 200); n++; }
      else if (typeof v === 'number' || typeof v === 'boolean') { out[k] = v; n++; }
    }
  } catch (e) { }
  return out;
}

const INVITE = /^steam:\/\/(joinlobby|rungame|remoteplay\/connect)\//i;

function createKapsula(o) {
  const steam = o.steam, Socket = o.WebSocket;
  const port = o.port || PORT, version = o.version || '';
  let ws = null, stopped = false, timer = null, debug = false, hideToasts = false;
  const queue = [], cleanup = [];

  function send(obj) {
    // The Kapsula plugin came up after us: it is the one that talks to Kapsula now
    if (ownPluginRuns()) { if (ws) { const w = ws; ws = null; try { w.close(); } catch (e) { } } queue.length = 0; return; }
    let s;
    try { s = JSON.stringify(obj); } catch (e) { return; }
    if (ws && ws.readyState === 1) ws.send(s);
    else if (queue.length < QUEUE_MAX) queue.push(s);
  }

  // ───────── What Steam is about to show ─────────
  function describeToast(config, n) {
    const d = n && n.data;
    const out = {
      type: 'toast',
      kind: config && typeof config.strTest === 'string' ? config.strTest : '',
      eType: n && typeof n.eType === 'number' ? n.eType : -1,
      title: field(d, 'title') || field(d, 'name'),
      body: field(d, 'body') || field(d, 'description'),
      icon: field(d, 'icon') || field(d, 'image') || field(d, 'image_url'),
      steamid: field(d, 'steamid'), url: field(d, 'response_steamurl'),
      game: field(d, 'game_name'), appid: field(d, 'appid'), invite: false, extra: '',
    };
    // Achievements and finished downloads carry a game number instead of a name
    if (!out.game && out.appid) out.game = steam.appName(out.appid);
    // A game invite arrives as a chat message whose "open" address joins the friend's game
    out.invite = INVITE.test(out.url);
    try { if (d && d.item && typeof d.item.body_data === 'string') out.extra = d.item.body_data.slice(0, 400); } catch (e) { }
    // "Friend online / in game" notifications carry only a SteamID — the rest from the friends list
    if (out.steamid && (!out.title || !out.icon)) {
      const f = steam.friend(out.steamid);
      if (!out.title) out.title = f.name;
      if (!out.icon) out.icon = f.avatar;
      if (!out.game) out.game = f.game;
      if (debug) out.friend = f;
    }
    if (debug) { out.fields = simpleFields(d); out.dataShape = shape(d); }
    return out;
  }

  function onToast(t) {
    if (stopped) return undefined;
    if (t.show) {
      send(describeToast(t.config, t.notification));
      // The island has shown it — Steam's own pop-up is skipped so it isn't shown twice. Only while Kapsula is
      // connected, and never in a game: there the island may be hidden and Steam's overlay is the only way to see it.
      let inGame = false;
      try { inGame = !!(t.store && typeof t.store.BIsUserInGame === 'function' && t.store.BIsUserInGame()); } catch (e) { }
      if (hideToasts && ws && ws.readyState === 1 && !inGame) return false;
    } else if (debug) {
      const d = describeToast(t.config, t.notification);
      d.type = 'suppressed';
      send(d);
    }
    return undefined;
  }

  // ───────── The current download, at most once a second ─────────
  let lastAt = 0, lastKey = '';
  function onOverview(ov) {
    if (stopped) return;
    const appid = ov && ov.update_appid ? Number(ov.update_appid) : 0;
    const state = ov && typeof ov.update_state === 'string' ? ov.update_state : '';
    if (!appid || state === 'None') {
      if (lastKey !== 'none') { lastKey = 'none'; send({ type: 'download', appid: 0 }); }
      return;
    }
    const key = appid + '|' + (ov.paused ? 1 : 0) + '|' + state, t = Date.now();
    if (key === lastKey && t - lastAt < 1000) return;
    lastKey = key; lastAt = t;
    send({
      type: 'download', appid, name: steam.appName(appid), state, paused: !!ov.paused,
      percent: Math.max(0, Math.min(100, Number(ov.overall_percent_complete) || 0)),
      rate: Number(ov.update_network_bytes_per_second) || 0,
      eta: Number(ov.overall_estimated_time_remaining_sec) || -1,
    });
  }

  // ───────── What Kapsula asks for ─────────
  function command(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.cmd === 'dismissInvite') { steam.dismissInvite(msg.steamid); return; }
    if (msg.cmd === 'openChat') {
      if (/^\d{5,20}$/.test(String(msg.steamid || '')) && !steam.openChat(msg.steamid)) send({ type: 'error', name: 'openChat', message: 'chat not available' });
      return;
    }
    if (msg.cmd === 'reply') {
      steam.sendChat(msg.steamid, msg.text).then(
        () => send({ type: 'replied', ok: true, message: '' }),
        e => send({ type: 'replied', ok: false, message: String(e && e.message || e) }));
      return;
    }
    if (msg.cmd === 'config') { hideToasts = msg.hideToasts === true; return; }
    if (msg.cmd !== 'test' || !Array.isArray(msg.names)) return;
    debug = true; // check mode: also report field names of what Steam passes, until the plugin is reloaded
    msg.names.slice(0, 12).forEach((entry, i) => {
      if (typeof entry !== 'string') return;
      // "TestAchievement:550" — a sample that needs a game number
      const m = /^(Test[A-Za-z]{1,40})(?::(\d{1,10}))?$/.exec(entry);
      if (!m) return;
      const t = setTimeout(() => {
        timers.delete(t);
        try { steam.testToast(m[1], m[2] ? Number(m[2]) : undefined); } catch (e) { send({ type: 'error', name: m[1], message: String(e) }); }
      }, 400 + i * 2500);
      timers.add(t);
    });
  }
  const timers = new Set();

  // ───────── The connection ─────────
  // While the Kapsula plugin itself is loaded in Steam, it talks to Kapsula and this module stays away
  const ownPluginRuns = () => { try { return steam.pluginRunning(OWN_PLUGIN); } catch (e) { return false; } };
  function later() { if (!stopped && !timer) timer = setTimeout(connect, o.everyMs || RETRY_MS); }
  function connect() {
    timer = null;
    if (stopped) return;
    if (ownPluginRuns() || typeof Socket !== 'function') { later(); return; }
    try {
      const sock = new Socket('ws://127.0.0.1:' + port + '/?client=millennium');
      sock.onopen = () => {
        if (stopped || ownPluginRuns()) { try { sock.close(); } catch (e) { } return; }
        ws = sock;
        sock.send(JSON.stringify({ type: 'hello', plugin: version, hooked: steam.toastsHooked() }));
        for (const s of queue.splice(0)) sock.send(s);
      };
      sock.onmessage = e => { try { command(JSON.parse(e.data)); } catch (err) { } };
      sock.onclose = () => { if (ws === sock) ws = null; later(); };
      sock.onerror = () => { };
    } catch (e) { later(); }
  }

  const offToasts = steam.watchToasts(onToast, { raw: true });
  if (typeof offToasts === 'function') cleanup.push(offToasts);
  const offDownloads = steam.watchDownloadOverview(onOverview);
  if (typeof offDownloads === 'function') cleanup.push(offDownloads);
  connect();

  return {
    connected: () => !!(ws && ws.readyState === 1),
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const f of cleanup.splice(0)) try { f(); } catch (e) { }
      try { if (ws) ws.close(); } catch (e) { }
      ws = null;
      queue.length = 0;
    },
  };
}

module.exports = { createKapsula, PORT };
