// Arkada plugin for Millennium, version 0.1.0. Built by plugin/build.js from plugin/src — do not edit by hand.
// Runs inside the Steam client and tells the dev.txt hub on this PC (ws://127.0.0.1:42080/hub) what Steam is doing.
// Nothing goes to the internet, and Steam's own notifications are left exactly as they were.
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
      },
      "./version.js": function (module, exports, require) {
        // Written by build.js from plugin.json. Do not edit by hand.
        module.exports = "0.1.0";
      },
      "./index.js": function (module, exports, require) {
        // Arkada plugin for Millennium: the entry point Millennium calls inside the Steam client.
        // It joins the three parts: the hub client of kit.txt (hub-client.js, copied as is), what is said to
        // the hub (core.js) and the calls into Steam (steam.js). Nothing here talks to the internet:
        // the only connection is ws://127.0.0.1:42080/hub, the dev.txt hub on this PC.
        'use strict';
        const { connect } = require('./hub-client.js');
        const { createArkada } = require('./core.js');
        const { createSteam } = require('./steam.js');

        const VERSION = require('./version.js'); // written by build.js from plugin.json
        const SLOT = '__arkada_stop__';       // the running copy, so that a second load replaces it instead of doubling it

        exports.default = async function () {
          try { if (typeof window[SLOT] === 'function') window[SLOT](); } catch (e) { /* the old copy is gone anyway */ }
          let storage = null;
          try { storage = window.localStorage; } catch (e) { /* closed: settings live until Steam restarts */ }
          const arkada = createArkada({ connect, steam: createSteam(window), storage, version: VERSION });
          const stop = () => { if (window[SLOT] === stop) window[SLOT] = null; arkada.stop(); };
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
    exports.default = load("./index.js").default;
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
