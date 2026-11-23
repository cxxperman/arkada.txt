// Arkada plugin for Millennium, version 0.1.0. Built by plugin/build.js from plugin/src — do not edit by hand.
// Runs inside the Steam client and tells the dev.txt hub on this PC (ws://127.0.0.1:42080/hub) what Steam is doing,
// sends Steam's notifications to Kapsula on this PC (ws://127.0.0.1:42071) and shows the size on disk on a game's page.
// Nothing goes to the internet. Steam's own notifications are left as they were (Kapsula may ask to hide one it shows).
const MILLENNIUM_IS_CLIENT_MODULE = !0, pluginName = "arkada";
(window.PLUGIN_LIST ||= {})[pluginName] ||= {}, window.MILLENNIUM_SIDEBAR_NAVIGATION_PANELS ||= {};
let PluginEntryPointMain = function () {
  return function (exports, millenniumApi, react) {
    "use strict";
    const modules = {
      "./hub-client.js": function (module, exports, require) {
        // Hub client: one file, no dependencies. Works in Node, Electron (either process) and a page inside
        // Discord or Steam. Copy it into the app; the protocol is in hub/PROTOCOL.md.
        //
        //   const hub = connect({
        //     app: 'aura', name: 'Aura', version: '0.26.2',
        //     topics: ['maska.voice', 'hub.theme'],
        //     commands: { 'fx.toggle': args => ({ on: toggle() }) },
        //     onState(topic, data, from) {}, onEvent(topic, data, from) {}, onStatus(online) {},
        //   });
        //   hub.state('aura.fx', { on: true });          // remembered by the hub, sent to late subscribers
        //   hub.event('aura.clip', { ms: 12 });          // not remembered
        //   const r = await hub.command('maska', 'voice.mute', { on: true });   // { ok, data, error }
        //
        // The hub being absent is normal: the client keeps trying quietly and nothing throws.
        'use strict';

        const PROTOCOL = 1;
        const DEFAULT_PORT = 42080;

        function connect(o) {
          const port = o.port || DEFAULT_PORT;
          const kind = o.transport || (typeof WebSocket !== 'undefined' ? 'ws' : 'http');
          const handlers = o.commands || {};
          const topics = (o.topics || []).slice();
          const own = new Map();     // what this app last said, to repeat after a reconnect
          const pending = new Map(); // command id → { resolve, timer }
          let online = false, seq = 0, closed = false;

          const status = on => { if (online !== on) { online = on; if (o.onStatus) o.onStatus(on); } };
          const finish = (id, result) => {
            const p = pending.get(id);
            if (!p) return;
            pending.delete(id);
            clearTimeout(p.timer);
            p.resolve(result);
          };

          const link = (kind === 'ws' ? wsTransport : httpTransport)(port, {
            open() {
              link.send({ type: 'hello', v: PROTOCOL, app: o.app, name: o.name || o.app, version: o.version || '', commands: Object.keys(handlers) });
              if (topics.length) link.send({ type: 'subscribe', topics });
              for (const [topic, data] of own) link.send({ type: 'state', topic, data });
            },
            close() {
              status(false);
              for (const id of [...pending.keys()]) finish(id, { ok: false, error: 'offline' });
            },
            message(m) {
              if (!m || typeof m.type !== 'string') return;
              if (m.type === 'welcome') return status(true);
              if (m.type === 'state') return o.onState && o.onState(m.topic, m.data, m.from);
              if (m.type === 'event') return o.onEvent && o.onEvent(m.topic, m.data, m.from);
              if (m.type === 'result') return finish(m.id, { ok: m.ok === true, data: m.data, error: m.error });
              if (m.type === 'error') return o.onError && o.onError(m);
              if (m.type === 'command') {
                const reply = r => link.send(Object.assign({ type: 'result', id: m.id, to: m.from }, r));
                const h = handlers[m.name];
                if (!h) return reply({ ok: false, error: 'unknown-command' });
                Promise.resolve().then(() => h(m.args || {}, m.from)).then(
                  data => reply({ ok: true, data: data === undefined ? null : data }),
                  e => reply({ ok: false, error: String((e && e.message) || e) }));
              }
            },
          });

          return {
            get online() { return online; },
            state(topic, data) {
              if (data === null || data === undefined) own.delete(topic); else own.set(topic, data);
              link.send({ type: 'state', topic, data: data === undefined ? null : data });
            },
            event(topic, data) { link.send({ type: 'event', topic, data: data === undefined ? null : data }); },
            subscribe(more) {
              const fresh = more.filter(t => !topics.includes(t));
              topics.push(...fresh);
              if (fresh.length) link.send({ type: 'subscribe', topics: fresh });
            },
            command(to, name, args, timeoutMs) {
              return new Promise(resolve => {
                if (!online || closed) return resolve({ ok: false, error: 'offline' });
                const id = o.app + '-' + (++seq);
                pending.set(id, { resolve, timer: setTimeout(() => finish(id, { ok: false, error: 'timeout' }), timeoutMs || 5000) });
                link.send({ type: 'command', id, to, name, args: args || {} });
              });
            },
            close() {
              closed = true;
              link.stop();
              status(false);
              for (const id of [...pending.keys()]) finish(id, { ok: false, error: 'offline' });
            },
          };
        }

        // Tries again after 1, 2, 4… up to 15 seconds
        function backoff() {
          let ms = 1000;
          return { next() { const d = ms; ms = Math.min(ms * 2, 15000); return d; }, reset() { ms = 1000; } };
        }

        function wsTransport(port, on) {
          const wait = backoff();
          let ws = null, timer = null, stopped = false;
          function open() {
            timer = null;
            let s;
            try { s = new WebSocket('ws://127.0.0.1:' + port + '/hub'); } catch (e) { return retry(); }
            ws = s;
            // A connection can end three ways: a close, an error with no close after it (a refused
            // connection in Node), or silence (a hub that never answers). Each of them leads here, once.
            let over = false;
            const lost = () => {
              if (over) return;
              over = true;
              clearTimeout(guard);
              if (ws === s) ws = null;
              try { s.close(); } catch (e) {}
              on.close();
              retry();
            };
            const guard = setTimeout(() => { if (s.readyState !== 1) lost(); }, 5000);
            s.onopen = () => { clearTimeout(guard); wait.reset(); on.open(); };
            s.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } on.message(m); };
            s.onerror = lost;
            s.onclose = lost;
          }
          function retry() { if (!stopped && !timer) timer = setTimeout(open, wait.next()); }
          open();
          return {
            send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); },
            stop() { stopped = true; clearTimeout(timer); const s = ws; ws = null; if (s) s.close(); },
          };
        }

        // Node only (for example Discord's main process): a POST to say something, a held GET to hear something
        function httpTransport(port, on) {
          const http = require('http');
          const wait = backoff();
          let client = null, out = [], busy = false, timer = null, stopped = false, gen = 0, held = null;

          function request(method, path, body, timeout) {
            return new Promise(resolve => {
              const text = body ? JSON.stringify(body) : null;
              const headers = text ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } : {};
              const req = http.request({ host: '127.0.0.1', port, path, method, headers, timeout }, res => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', c => { data += c; });
                res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (e) {} resolve({ status: res.statusCode, json }); });
              });
              req.on('error', () => resolve(null));
              req.on('timeout', () => req.destroy());
              if (method === 'GET') held = req;
              req.end(text || undefined);
            });
          }
          const deliver = list => { for (const m of Array.isArray(list) ? list : []) on.message(m); };

          function start() { timer = null; client = null; out = []; on.open(); }
          function lost() {
            if (stopped || timer) return;
            gen++; client = null; out = [];
            on.close();
            timer = setTimeout(start, wait.next());
          }
          async function flush() {
            if (busy || stopped || timer || !out.length) return;
            busy = true;
            const mine = gen, batch = out;
            out = [];
            const r = await request('POST', '/hub/http', { client, messages: batch }, 5000);
            busy = false;
            if (stopped) return;
            if (mine !== gen) return flush(); // the connection was lost meanwhile: what is queued now is the new hello
            if (!r || r.status !== 200 || !r.json) return lost();
            wait.reset();
            const first = client === null;
            client = r.json.client;
            deliver(r.json.messages);
            if (first) poll(gen);
            flush();
          }
          async function poll(mine) {
            while (!stopped && mine === gen) {
              const r = await request('GET', '/hub/http?client=' + encodeURIComponent(client), null, 30000);
              if (stopped || mine !== gen) return;
              if (!r || r.status !== 200 || !r.json) return lost();
              deliver(r.json.messages);
            }
          }
          timer = setTimeout(start, 0); // after connect() has the transport in hand
          return {
            send(m) { if (stopped || timer) return; out.push(m); flush(); },
            stop() {
              // Say goodbye so the hub does not wait for the silence to time out
              if (!stopped && client) request('POST', '/hub/http', { client, messages: out.concat([{ type: 'bye' }]) }, 2000);
              stopped = true;
              clearTimeout(timer);
              if (held) held.destroy();
            },
          };
        }

        if (typeof module !== 'undefined' && module.exports) module.exports = { connect, PROTOCOL, DEFAULT_PORT };
        else globalThis.DevTxtHub = { connect, PROTOCOL, DEFAULT_PORT };
      },
      "./core.js": function (module, exports, require) {
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
      },
      "./steam-snapshot.js": function (module, exports, require) {
        // Written by build.js from steam-classes.json (client 1794536281, 2026-11-13). Do not edit by hand.
        // Probe name → the hashed classes of the client's style module that has it (steam.js, classes()).
        module.exports = {
          "GameStatsSection": {
            "GameStatsSection": "_1mDAVT4sTzFRwJtlKCw2Ws",
            "GameStat": "_1kiZKVbDe-9Ikootk57kpA",
            "GameStatIcon": "_1tIg-QIrwMNtCm7NcYADyi",
            "GameStatRight": "_3m_zjRTQBqcfzCjXLXUHcR",
            "LastPlayed": "_3pS8kMrtScuY1Qf-W8tmRV",
            "LastPlayedInfo": "_1nfJNsQjTOXSQQyFahGnRi",
            "PlayBarLabel": "_34lrt5-Fc3usZU6trA1P0-",
            "PlayBarDetailLabel": "_2TYVGoD27ZMfjRirKQNLfk",
            "PlaytimeIcon": "_1GZdosVXnfrf69yU8DWASl"
          }
        };
      },
      "./steam.js": function (module, exports, require) {
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
          //     when there is no backend or it does not answer within 5 s.
          function callBackend(method, args) {
            return new Promise(resolve => {
              let done = false;
              const finish = v => { if (!done) { done = true; clearTimeout(timer); resolve(v === undefined ? null : v); } };
              const timer = setTimeout(() => finish(null), 5000);
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
            readFlags, mainWindow, watchRoute, currentRoute, navigate, classes, installedSizes, openLocalFiles, dispose,
          };
        }

        module.exports = { createSteam };
      },
      "./backdrop.js": function (module, exports, require) {
        // Arkada, the window backdrop: Mica or Acrylic of Windows 11 under the Steam windows, without DWMX.
        // Knows nothing about Steam itself — everything comes in through `steam` (see steam.js), so the logic runs in Node.
        //
        //   const backdrop = createBackdrop({ steam, storage, now, everyMs, giveUpMs });
        //   backdrop.stop();
        //
        // How the parts meet:
        //   theme    the setting «Подложка окна» puts --arkada-backdrop: mica | acrylic | off on <html> of its windows
        //            (overlay/options/backdrop-*.css; overlay/tokens.css says "off" when nothing is chosen)
        //   here     reads it every couple of seconds (steam.readBackdrop), remembers the last answer in localStorage
        //            for the next start, and while the mode is not "off":
        //              · rewrites window.open so that new windows are created see-through (createflags 4114 / 2 → 274,
        //                as DWMX does) and asks the backend to patch them once they are open;
        //              · asks the backend for the windows already open (a full pass), and for every new one
        //                (a new-window pass: 60 ms after window.open, again at 400 and 1500 ms only while
        //                nothing new got patched) and every time a Steam window comes on screen (menus are
        //                made hidden ahead of time and shown without a window.open);
        //              · once the backend says it worked, marks <html data-arkada-backdrop="mica|acrylic"> in every window —
        //                only then does the theme turn see-through (overlay/backdrop.css)
        //   backend  plugin/backend/main.lua, ApplyBackdrop(mode): DWMWA_SYSTEMBACKDROP_TYPE and friends
        'use strict';

        const STORAGE_KEY = 'arkada.backdrop';
        const MODES = ['blur', 'mica', 'acrylic', 'off'];
        const EVERY_MS = 2000;        // how often the theme's choice is read again
        const GIVE_UP_MS = 30000;     // no window answered for this long: no Arkada theme, the remembered mode is dropped
        const OFF_CONFIRM = 2;        // "off" is believed after this many reads in a row (see look())
        const AFTER_OPEN_MS = [60, 400, 1500]; // a new window: patched when Windows has it; the later steps only if it was not yet

        // The client's window kinds (`createflags` in the address window.open gets): 4114 and 2 are the usual windows,
        // 274 the same with a see-through surface. Taken from the DWMX plugin; other kinds (and any address without
        // the flag) are left exactly as they are.
        const FLAGS_FROM = [4114, 2];
        const FLAGS_TO = 274;
        function withTransparentFlags(url) {
          if (typeof url !== 'string') return url;
          return url.replace(/([?&]createflags=)(\d+)(?=[&#]|$)/i, (all, head, n) => (FLAGS_FROM.includes(Number(n)) ? head + FLAGS_TO : all));
        }

        function parseReply(r) {
          if (typeof r === 'string') { try { r = JSON.parse(r); } catch (e) { return null; } }
          return r && typeof r === 'object' ? r : null;
        }

        function createBackdrop(o) {
          const steam = o.steam, storage = o.storage || null;
          const now = o.now || (() => Date.now());
          const giveUpMs = o.giveUpMs || GIVE_UP_MS;
          const started = now();
          const timers = new Set();
          let stopped = false, themeSeen = false, everAsked = false;

          let mode = 'off';
          try { const saved = storage && storage.getItem(STORAGE_KEY); if (MODES.includes(saved)) mode = saved; } catch (e) { }

          function remember(m) { try { if (storage) storage.setItem(STORAGE_KEY, m); } catch (e) { /* kept for this session only */ } }

          // ───────── The backend ─────────
          // One call at a time. A full pass (start, a change of mode) looks at every window; a new-window pass
          // ({ only: 'new' }) only at windows the backend has not patched yet. Calls asked for while one runs are
          // folded into one, a full pass winning over a new-window one.
          let busy = false, againFull = false, againNew = false, againDone = [], mismatches = 0;
          async function push(onlyNew, done) {
            if (stopped) return;
            if (busy) {
              if (onlyNew) againNew = true; else againFull = true;
              if (done) againDone.push(done);
              return;
            }
            busy = true;
            const asked = mode;
            if (asked === 'off') steam.markBackdrop(null);
            let reply = null;
            try {
              everAsked = everAsked || asked !== 'off';
              const args = { mode: asked };
              if (onlyNew && asked !== 'off') { args.only = 'new'; if (done && openedAt) args.afterMs = Math.max(0, Math.round(now() - openedAt)); }
              reply = parseReply(await steam.callBackend('ApplyBackdrop', args));
              // The mark follows what the backend did, never only what was asked: an answer for another mode (an
              // "off" it did instead) takes the mark off and has the mode asked for again in full
              const did = reply && typeof reply.mode === 'string' ? reply.mode : asked;
              if (!stopped && did !== asked) { steam.markBackdrop(did === 'off' ? null : did); if (mismatches++ < 3) againFull = true; }
              else mismatches = 0;
              if (!stopped && did === asked && asked === mode && asked !== 'off') {
                if (reply && reply.ok === true) steam.markBackdrop(asked);
                else if (!onlyNew) steam.markBackdrop(null); // a new-window pass that did nothing leaves the windows as they were
              }
            } catch (e) { /* no backend: the theme stays opaque */ }
            busy = false;
            if (done) try { done(reply); } catch (e) { }
            if ((againFull || againNew) && !stopped) {
              const full = againFull, cbs = againDone;
              againFull = againNew = false; againDone = [];
              push(!full, cbs.length ? r => { for (const cb of cbs) cb(r); } : null);
            }
          }
          function later(fn, ms) {
            const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
            if (t && typeof t.unref === 'function') t.unref();
            timers.add(t);
            return t;
          }
          // A window was opened: the backend is asked at the first step; while nothing new got patched (Windows
          // has no visible window yet) at the next ones, and no more once one was
          let pending = null, openedAt = 0;
          function kick() {
            if (stopped || mode === 'off') return;
            openedAt = now();
            if (pending) { clearTimeout(pending); timers.delete(pending); pending = null; }
            const step = i => {
              pending = later(() => {
                pending = null;
                push(true, reply => {
                  if (stopped || pending || i + 1 >= AFTER_OPEN_MS.length) return;
                  if (reply && reply.patched > 0) return;
                  step(i + 1);
                });
              }, AFTER_OPEN_MS[i] - (i ? AFTER_OPEN_MS[i - 1] : 0));
            };
            step(0);
          }
          // A window came on screen (a menu shown): its hwnd is visible now, one new-window pass
          function shown() {
            if (stopped || mode === 'off') return;
            push(true);
          }

          // ───────── The theme's choice ─────────
          function setMode(next) {
            if (next === mode) return;
            mode = next;
            remember(next);
            if (next === 'off') { if (everAsked) push(); else steam.markBackdrop(null); }
            else push();
          }
          // "off" while a backdrop is on is taken only once it has been read OFF_CONFIRM times in a row: a window
          // still loading its styles answers "off" for a moment (steam.readBackdrop)
          let offSeen = 0;
          function look() {
            if (stopped || pinned) return;
            const v = steam.readBackdrop();
            if (v) {
              themeSeen = true;
              if (v === 'off' && mode !== 'off' && ++offSeen < OFF_CONFIRM) return;
              offSeen = 0;
              setMode(v);
              return;
            }
            if (!themeSeen && now() - started > giveUpMs && mode !== 'off') setMode('off');
          }

          const undoOpen = steam.patchWindowOpen(url => (mode === 'off' || stopped ? url : withTransparentFlags(url)), kick);
          const unwatch = steam.watchWindows(kick);
          const unwatchShown = typeof steam.watchShown === 'function' ? steam.watchShown(shown) : null;
          const timer = setInterval(look, o.everyMs || EVERY_MS);
          if (timer && typeof timer.unref === 'function') timer.unref();

          const first = steam.readBackdrop();
          if (first) { themeSeen = true; if (first !== mode && first !== 'off') { mode = first; remember(first); } }
          if (mode !== 'off') push();
          later(look, 0);

          // For testing without a restart: set('blur' | 'mica' | 'acrylic' | 'off') takes that mode now and holds it
          // (the theme's setting is not read meanwhile); set(null) goes back to the theme's setting
          let pinned = false;
          function set(next) {
            if (stopped) return mode;
            if (next === null || next === undefined) { pinned = false; offSeen = 0; look(); return mode; }
            if (!MODES.includes(next)) return mode;
            pinned = true;
            if (next !== mode) { mode = next; remember(next); if (next === 'off') { if (everAsked) push(); else steam.markBackdrop(null); } else push(); }
            return mode;
          }

          return {
            mode: () => mode,
            set,
            stop() {
              if (stopped) return;
              stopped = true;
              clearInterval(timer);
              for (const t of timers) clearTimeout(t);
              timers.clear();
              for (const f of [undoOpen, unwatch, unwatchShown]) if (typeof f === 'function') try { f(); } catch (e) { }
              try { steam.markBackdrop(null); } catch (e) { }
            },
          };
        }

        module.exports = { createBackdrop, withTransparentFlags, STORAGE_KEY };
      },
      "./features.js": function (module, exports, require) {
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
      },
      "./watch.js": function (module, exports, require) {
        // Arkada, one watcher of a document's DOM: every module that needs to see the page change shares it.
        // Used by pages.js (the main window of the client) and by webkit.js (a store page).
        //
        //   const w = createWatch(win, onChange);   win: the window of the document; onChange(): the DOM changed
        //   w.start(); w.stop(); w.kick();          kick(): call onChange on the next frame, as if the DOM changed
        //
        // What it costs. A MutationObserver on <body> (child lists only, no attributes), connected only between
        // start() and stop(). However many records come, onChange runs at most once per frame, in the next
        // requestAnimationFrame. It gets no records: modules look for their place with querySelector and return
        // at once when their element is still there. Nothing here reads layout, so a scroll that makes Steam add
        // rows costs one cheap pass per frame and no reflow.
        'use strict';

        function createWatch(win, onChange) {
          let observer = null, queued = 0, running = false;
          const raf = typeof win.requestAnimationFrame === 'function' ? f => win.requestAnimationFrame(f) : f => setTimeout(f, 16);
          const unraf = typeof win.cancelAnimationFrame === 'function' ? id => win.cancelAnimationFrame(id) : id => clearTimeout(id);
          function run() {
            queued = 0;
            if (!running) return;
            try { onChange(); } catch (e) { /* a module's bug must not stop the watcher */ }
          }
          function kick() { if (running && !queued) queued = raf(run) || 1; }
          return {
            start() {
              if (running) return;
              running = true;
              try {
                const doc = win.document, Obs = win.MutationObserver;
                const target = doc && (doc.body || doc.documentElement);
                if (typeof Obs === 'function' && target) {
                  observer = new Obs(kick);
                  observer.observe(target, { childList: true, subtree: true });
                }
              } catch (e) { observer = null; }
              kick();
            },
            stop() {
              running = false;
              if (observer) try { observer.disconnect(); } catch (e) { }
              observer = null;
              if (queued) try { unraf(queued); } catch (e) { }
              queued = 0;
            },
            kick,
            running: () => running,
          };
        }

        module.exports = { createWatch };
      },
      "./pages.js": function (module, exports, require) {
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
      },
      "./disksize.js": function (module, exports, require) {
        // Arkada, the size on disk: on a game's page in the library, next to «Последний запуск» and «Вы играли»,
        // one more stat — «Размер на диске» — with what the game, its DLC, the Workshop and the shader cache take.
        // Steam's page shows no size of its own (only Properties → Installed Files does); this is where the
        // Size on Disk plugin puts it too. Written for Arkada from what that plugin shows, no code taken from it.
        //
        //   const d = createDiskSize({ steam, pages });
        //   d.stop();
        //
        // Data: SteamClient.InstallFolder.GetInstallFolders() (steam.installedSizes) — what Steam itself knows of the
        // library folders on this PC. Nothing goes to the network, no folder is walked. Asked when a game's page
        // opens, at most once every REFRESH_MS. Games that are not Steam's (shortcuts) have no size there: nothing is
        // shown for them. A click opens the game's Properties on «Установленные файлы».
        //
        // Drawn with Steam's own classes of the stats row (GameStat, GameStatIcon, PlayBarLabel…, found with
        // steam.classes), so the theme styles it as one of Steam's. The theme setting «Arkada: размер на диске» →
        // Выкл hides it at once (overlay/options/feature-disk-size-off.css) and the plugin stops drawing it.
        'use strict';

        const ROUTE = /^\/library\/app\/(\d+)(?:\/|$)/;
        const ATTR = 'data-arkada-disk-size';
        const REFRESH_MS = 5000;
        const UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
        const NBSP = ' ';

        // 44 040 192 000 → "41 ГБ"; 1 288 490 189 → "1,2 ГБ". Steam's own units: 1 ГБ = 1024 МБ
        function formatSize(bytes) {
          let b = Number(bytes) || 0;
          if (b <= 0) return '0' + NBSP + UNITS[0];
          let i = 0;
          while (b >= 1024 && i < UNITS.length - 1) { b /= 1024; i++; }
          const s = i === 0 || b >= 100 ? String(Math.round(b)) : b.toFixed(1).replace(/\.0$/, '').replace('.', ',');
          return s + NBSP + UNITS[i];
        }

        // The tooltip: where the game lives and what of it takes how much
        function describe(info) {
          const where = info.label && info.drive ? info.label + ' (' + info.drive + ')' : info.folder || info.drive || '';
          const game = Math.max(0, info.total - info.dlc - info.workshop - info.shaders);
          const lines = ['Занято на диске: ' + formatSize(info.total) + (where ? ' — ' + where : ''), 'Игра: ' + formatSize(game)];
          if (info.dlc > 0) lines.push('DLC: ' + formatSize(info.dlc));
          if (info.workshop > 0) lines.push('Мастерская: ' + formatSize(info.workshop));
          if (info.shaders > 0) lines.push('Кэш шейдеров: ' + formatSize(info.shaders));
          lines.push('Нажмите, чтобы открыть установленные файлы');
          return lines.join('\n');
        }

        const SVG = 'http://www.w3.org/2000/svg';
        // A drive, drawn for Arkada in the stroke of Steam's stat icons (currentColor, 1.5 px at 24)
        function driveIcon(doc) {
          const svg = doc.createElementNS(SVG, 'svg');
          svg.setAttribute('viewBox', '0 0 24 24');
          svg.setAttribute('fill', 'none');
          svg.setAttribute('aria-hidden', 'true');
          for (const [tag, attrs] of [
            ['rect', { x: '3', y: '6', width: '18', height: '12', rx: '2.5', stroke: 'currentColor', 'stroke-width': '1.5' }],
            ['path', { d: 'M3.75 13.5h16.5', stroke: 'currentColor', 'stroke-width': '1.5' }],
            ['circle', { cx: '17', cy: '15.75', r: '1', fill: 'currentColor' }],
          ]) {
            const el = doc.createElementNS(SVG, tag);
            for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
            svg.appendChild(el);
          }
          return svg;
        }

        function createDiskSize(o) {
          const steam = o.steam, pages = o.pages;
          const now = o.now || (() => Date.now());
          let sizes = null, askedAt = -Infinity, asking = null, lastApp = 0, stopped = false, last = null;

          function refresh() {
            if (asking) return asking;
            askedAt = now();
            asking = Promise.resolve().then(() => steam.installedSizes()).then(
              m => { if (m) sizes = m; }, () => { }).then(() => {
              asking = null;
              if (!stopped && last) draw(last); // the answer is in: the page as it is now
            });
            return asking;
          }

          function remove(doc) {
            try { for (const el of Array.from(doc.querySelectorAll('[' + ATTR + ']'))) el.remove(); } catch (e) { }
          }

          function build(doc, cls, info) {
            const box = doc.createElement('div');
            box.className = [cls.GameStat, cls.LastPlayed, 'Panel'].filter(Boolean).join(' ');
            box.setAttribute(ATTR, info.appId + ':' + info.total);
            box.setAttribute('role', 'button');
            box.setAttribute('tabindex', '0');
            box.title = describe(info);
            box.style.order = '1';
            box.style.cursor = 'pointer';
            const icon = doc.createElement('div');
            icon.className = [cls.GameStatIcon, cls.PlaytimeIcon].filter(Boolean).join(' ');
            icon.appendChild(driveIcon(doc));
            const right = doc.createElement('div');
            right.className = cls.GameStatRight || '';
            const label = doc.createElement('div');
            label.className = cls.PlayBarLabel || '';
            label.textContent = 'Размер на диске';
            const value = doc.createElement('div');
            value.className = [cls.PlayBarDetailLabel, cls.LastPlayedInfo].filter(Boolean).join(' ');
            value.textContent = formatSize(info.total);
            right.appendChild(label);
            right.appendChild(value);
            box.appendChild(icon);
            box.appendChild(right);
            const open = e => { if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return; e.preventDefault(); steam.openLocalFiles(info.appId); };
            box.addEventListener('click', open);
            box.addEventListener('keydown', open);
            return box;
          }

          // Puts the stat where it belongs, or takes it away; does nothing when the right one is already there
          function draw(ctx) {
            const doc = ctx.doc, appId = Number(ctx.match[1]);
            const cls = steam.classes('GameStatsSection');
            if (!cls || !cls.GameStatsSection) return;
            const section = doc.querySelector('.' + cls.GameStatsSection);
            if (!section) return;
            const info = sizes && sizes.get(appId);
            const key = info && info.total > 0 ? info.appId + ':' + info.total : '';
            const here = section.querySelector('[' + ATTR + ']');
            if (here && here.getAttribute(ATTR) === key) return;
            remove(doc);
            if (key) section.appendChild(build(doc, cls, info));
          }

          const off = pages.add({
            route: ROUTE,
            update(ctx) {
              if (stopped) return;
              last = ctx;
              const appId = Number(ctx.match[1]);
              if (appId !== lastApp || !sizes) {
                lastApp = appId;
                if (now() - askedAt >= REFRESH_MS || !sizes) refresh();
              }
              draw(ctx);
            },
            leave(ctx) { last = null; lastApp = 0; if (ctx && ctx.doc) remove(ctx.doc); },
          });

          return {
            stop() {
              if (stopped) return;
              stopped = true;
              try { off(); } catch (e) { }
            },
          };
        }

        module.exports = { createDiskSize, formatSize, describe, ROUTE, ATTR };
      },
      "./kapsula.js": function (module, exports, require) {
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
      },
      "./startpage.js": function (module, exports, require) {
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
      },
      "./version.js": function (module, exports, require) {
        // Written by build.js from plugin.json. Do not edit by hand.
        module.exports = "0.1.0";
      },
      "./index.js": function (module, exports, require) {
        // Arkada plugin for Millennium: the entry point Millennium calls inside the Steam client.
        // It joins the parts: the hub client of kit.txt (hub-client.js, copied as is), what is said to
        // the hub (core.js), the window backdrop (backdrop.js, with the Lua backend in plugin/backend) and the calls
        // into Steam (steam.js). And the features that replace separate plugins, each switched on and off by the
        // theme (features.js, tab «Arkada» of the theme's settings):
        //   kapsula     Steam's notifications to the Kapsula island (kapsula.js) — instead of the Kapsula plugin
        //   disk-size   the size on disk on a game's page (disksize.js, on pages.js) — instead of Size on Disk
        //   start page  the main window opens on the library's Home (startpage.js), not on the store
        //   share       «Поделиться» on a store page: its button lives in the page (webkit.js, share.js); the client's
        //               part here only answers it (arkadaShare below) — instead of Steam Share
        // Nothing here talks to the internet: the connections are ws://127.0.0.1:42080/hub, the dev.txt hub
        // on this PC, and ws://127.0.0.1:42071, Kapsula on this PC.
        'use strict';
        const { connect } = require('./hub-client.js');
        const { createArkada } = require('./core.js');
        const { createSteam } = require('./steam.js');
        const { createBackdrop } = require('./backdrop.js');
        const { createFeatures } = require('./features.js');
        const { createKapsula } = require('./kapsula.js');
        const { createPages } = require('./pages.js');
        const { createDiskSize } = require('./disksize.js');
        const { createStartPage } = require('./startpage.js');

        const VERSION = require('./version.js'); // written by build.js from plugin.json
        const SLOT = '__arkada_stop__';       // the running copy, so that a second load replaces it instead of doubling it

        let current = null; // the running copy's steam, for arkadaShare

        // Called by the store page (webkit.js) through Millennium: MILLENNIUM_API.callable("arkada", "frontend:arkadaShare.friends").
        // Millennium finds them among the plugin's exports. Replies are JSON strings.
        exports.arkadaShare = {
          friends() {
            if (!current) throw new Error('not running');
            return JSON.stringify(current.friendsList());
          },
          async send(request) {
            if (!current) throw new Error('not running');
            let r = request;
            if (typeof r === 'string') r = JSON.parse(r);
            if (r && typeof r === 'object' && typeof r.request === 'string') r = JSON.parse(r.request);
            const ids = Array.isArray(r && r.ids) ? Array.from(new Set(r.ids.filter(id => typeof id === 'string' && /^\d{5,20}$/.test(id)))).slice(0, 50) : [];
            const text = r && typeof r.text === 'string' ? r.text.slice(0, 1000) : '';
            if (!ids.length || !text.trim()) throw new Error('bad request');
            const steam = current;
            const out = [];
            for (const id of ids) {
              try { await steam.sendChat(id, text); out.push({ id, sent: true }); }
              catch (e) { out.push({ id, sent: false, error: String(e && e.message || e) }); }
            }
            return JSON.stringify(out);
          },
        };

        exports.default = async function () {
          try { if (typeof window[SLOT] === 'function') window[SLOT](); } catch (e) { /* the old copy is gone anyway */ }
          let storage = null;
          try { storage = window.localStorage; } catch (e) { /* closed: settings live until Steam restarts */ }
          const steam = createSteam(window);
          current = steam;
          const arkada = createArkada({ connect, steam, storage, version: VERSION });
          // Mica / Acrylic under the windows, when the theme asks for it (backdrop.js, plugin/backend/main.lua)
          const backdrop = createBackdrop({ steam, storage });
          // For testing from SharedJSContext: window.__arkadaBackdrop.set('blur' | 'acrylic' | 'mica' | 'off' | null), .mode()
          window.__arkadaBackdrop = { set: m => backdrop.set(m), mode: () => backdrop.mode() };
          // The main window opens on the library's Home, once per Steam start (startpage.js, setting «Начальная страница»)
          const startPage = createStartPage({ steam, storage, once: window });
          // The main window's pages are watched only once a feature that draws on them is on
          let pages = null;
          const features = createFeatures({
            steam, storage,
            features: {
              kapsula: () => createKapsula({ steam, WebSocket: window.WebSocket, version: VERSION }),
              'disk-size': () => {
                if (!pages) pages = createPages({ steam });
                return createDiskSize({ steam, pages });
              },
            },
          });
          const stop = () => {
            if (window[SLOT] === stop) window[SLOT] = null;
            if (current === steam) current = null;
            features.stop();
            startPage.stop();
            if (pages) pages.stop();
            arkada.stop();
            backdrop.stop();
            try { delete window.__arkadaBackdrop; } catch (e) { }
            steam.dispose();
          };
          window[SLOT] = stop;
          // No title/content: the plugin has no page of its own, its settings are on the settings page of core.txt
          return { icon: null, onDismount: stop };
        };
      },
    };
    const loaded = {};
    function load(name) {
      if (loaded[name]) return loaded[name].exports;
      if (!modules[name]) throw new Error("Arkada: no module " + name);
      const module = loaded[name] = { exports: {} };
      modules[name](module, module.exports, load);
      return module.exports;
    }
    // Everything index.js exports: default (the entry) and arkadaShare (called from the store pages)
    Object.assign(exports, load("./index.js"));
    Object.defineProperty(exports, "__esModule", { value: !0 });
    return exports;
  }({}, window.MILLENNIUM_API, window.SP_REACT);
};
(async () => {
  const e = PluginEntryPointMain();
  Object.assign(window.PLUGIN_LIST[pluginName], { ...e, __millennium_internal_plugin_name_do_not_use_or_change__: pluginName });
  const t = await e.default();
  t && void 0 !== t.title && void 0 !== t.icon && void 0 !== t.content && (window.MILLENNIUM_SIDEBAR_NAVIGATION_PANELS[pluginName] = t),
    MILLENNIUM_BACKEND_IPC.postMessage(1, { pluginName: pluginName });
})();
