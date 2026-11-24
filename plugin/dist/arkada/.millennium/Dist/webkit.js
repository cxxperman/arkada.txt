// Arkada plugin for Millennium, version 0.4.0: the part Millennium runs in Steam's store pages.
// Built by plugin/build.js from plugin/src — do not edit by hand. On a game's page of the store: «Поделиться», «Об игре» (from the client)
// and «Цены» (a SteamDB link; IsThereAnyDeal through the plugin's backend, only with the user's own key); the store's lists without owned
// games; the sum of a wishlist (api.steampowered.com); on the community: Dota 2 statistics (api.opendota.com), inventory prices and
// market history totals (steamcommunity.com/market). Each only on its pages and only while its setting is on.
const MILLENNIUM_IS_CLIENT_MODULE = !1, pluginName = "arkada";
(window.PLUGIN_LIST ||= {})[pluginName] ||= {}, window.MILLENNIUM_SIDEBAR_NAVIGATION_PANELS ||= {};
let PluginEntryPointMain = function () {
  return function (exports, millenniumApi) {
    "use strict";
    const modules = {
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
      "./web.js": function (module, exports, require) {
        // Arkada, what the modules of the store and community pages share (webkit.js): the feature switch on the
        // page's <html>, a cache in the page's localStorage, a queue that keeps to a rate, money as Steam writes it,
        // a small element builder and one style sheet of cards in the look of Windows 11 on the dev.txt tokens.
        // Knows nothing of Steam's client; runs in the page.
        'use strict';

        const STYLE_ID = 'arkada-web-style';

        // The theme's switch of a feature: --arkada-<name> on the page's <html> says 'off' (overlay/options/feature-<name>-off.css)
        function switchedOff(win, name) {
          try {
            const v = win.getComputedStyle(win.document.documentElement).getPropertyValue('--arkada-' + name);
            return String(v || '').trim().replace(/^["']|["']$/g, '').toLowerCase() === 'off';
          } catch (e) { return false; }
        }

        // One JSON value per key in the page's localStorage, with the time it was written
        function createCache(storage, prefix, now) {
          const time = now || (() => Date.now());
          return {
            get(key, maxMs) {
              try {
                const v = JSON.parse((storage && storage.getItem(prefix + key)) || 'null');
                if (!v || typeof v !== 'object' || typeof v.at !== 'number') return undefined;
                if (maxMs && time() - v.at > maxMs) return undefined;
                return v.v;
              } catch (e) { return undefined; }
            },
            at(key) { try { const v = JSON.parse((storage && storage.getItem(prefix + key)) || 'null'); return v && typeof v.at === 'number' ? v.at : 0; } catch (e) { return 0; } },
            set(key, v) { try { if (storage) storage.setItem(prefix + key, JSON.stringify({ at: time(), v })); } catch (e) { /* full or closed: asked again next time */ } },
          };
        }

        // Jobs one at a time, the next no sooner than everyMs after the previous one started. A job returns a Promise;
        // pause(ms) holds the queue (Steam answered 429). stop() drops what is left.
        function createQueue(o) {
          const everyMs = o.everyMs, later = o.setTimeout || setTimeout, cancel = o.clearTimeout || clearTimeout;
          const now = o.now || (() => Date.now());
          const jobs = [];
          let busy = false, last = -Infinity, holdUntil = 0, timer = null, stopped = false;
          function next() {
            timer = null;
            if (stopped || busy || !jobs.length) return;
            const wait = Math.max(last + everyMs, holdUntil) - now();
            if (wait > 0) { timer = later(next, wait); return; }
            const job = jobs.shift();
            busy = true;
            last = now();
            Promise.resolve().then(job).catch(() => { }).then(() => { busy = false; if (!timer) next(); });
          }
          return {
            push(job) { if (!stopped) { jobs.push(job); if (!timer && !busy) next(); } },
            pause(ms) { holdUntil = Math.max(holdUntil, now() + ms); },
            size: () => jobs.length + (busy ? 1 : 0),
            clear() { jobs.length = 0; },
            stop() { stopped = true; jobs.length = 0; if (timer) cancel(timer); timer = null; },
          };
        }

        // '1 234,56₴', '$12.99', '12,-€', '23₴', 'ARS$ 1.234,56' → the number, or null
        function parseMoney(text) {
          const s = String(text || '').replace(/[\s  ]/g, '');
          const m = /\d[\d.,']*/.exec(s);
          if (!m) return null;
          let n = m[0].replace(/[.,']+$/, '').replace(/'/g, '');
          const lastDot = n.lastIndexOf('.'), lastComma = n.lastIndexOf(',');
          const sep = Math.max(lastDot, lastComma);
          if (sep >= 0) {
            const tail = n.length - sep - 1, both = lastDot >= 0 && lastComma >= 0;
            // Both kinds: the last one is the decimal point. One kind, more than once or with three digits after it: thousands
            if (!both && (n.split(n[sep]).length > 2 || tail === 3)) n = n.split(n[sep]).join('');
            else n = n.slice(0, sep).replace(/[.,]/g, '') + '.' + n.slice(sep + 1);
          }
          const v = Number(n);
          return isFinite(v) ? v : null;
        }

        // The value written the way a sample price of the same currency is written: '23₴' + 1234.5 → '1 234,50₴'
        function formatLike(sample, value) {
          const s = String(sample || '').trim();
          const m = /\d[\d\s  .,']*\d|\d/.exec(s);
          const v = Math.round((Number(value) || 0) * 100) / 100;
          if (!m) return v.toFixed(2);
          const num = m[0];
          const decimals = /[.,]\d{1,2}$/.exec(num);
          // The decimal point: the sample's own; without one, the opposite of its thousands separator, else as dollars or euros write it
          let dec = decimals ? decimals[0][0] : /\d\.\d{3}/.test(num) ? ',' : /\d,\d{3}/.test(num) ? '.' : /[$£¥]/.test(s) ? '.' : ',';
          const group = dec === ',' ? (/\d\.\d{3}/.test(num) ? '.' : ' ') : (/\d,\d{3}/.test(num) || /[$£¥]/.test(s) ? ',' : ' ');
          const whole = Math.floor(Math.abs(v)), cents = Math.round((Math.abs(v) - whole) * 100);
          let out = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, group);
          if (cents || decimals) out += dec + String(cents).padStart(2, '0');
          return (v < 0 ? '−' : '') + s.slice(0, m.index) + out + s.slice(m.index + num.length);
        }

        // 1 игра, 2 игры, 5 игр
        function plural(n, one, few, many) {
          const a = Math.abs(n) % 100, b = a % 10;
          return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
        }

        // h('div', 'cls', child, 'text', …) in the page's document
        function builder(doc) {
          return function h(tag, cls, ...kids) {
            const el = doc.createElement(tag);
            if (cls) el.className = cls;
            for (const k of kids) if (k !== null && k !== undefined && k !== false) el.appendChild(typeof k === 'string' ? doc.createTextNode(k) : k);
            return el;
          };
        }
        // A link that leaves the page: a new window, no opener, only https
        function link(doc, text, href, title) {
          const a = doc.createElement('a');
          a.className = 'arkada-card-link';
          a.textContent = text;
          if (/^https:\/\//.test(href)) a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          if (title) a.title = title;
          return a;
        }

        // The cards of these modules: one sheet per page, scoped to .arkada-card (the page's own styles do not reach in)
        function styleText(tokens) {
          const t = tokens || {};
          return `
        .arkada-card { ${t.base || ''}
          --ark-accent: var(--se-accent, var(--dt-accent));
          display: block; margin: 0 0 16px; padding: 12px 16px; border-radius: var(--dt-radius-block); border: 1px solid var(--dt-edge);
          background: color-mix(in srgb, var(--dt-raised) 88%, transparent); color: var(--dt-label);
          font-family: var(--dt-font-text); font-size: var(--dt-size-body); line-height: 20px; -webkit-font-smoothing: antialiased;
          text-align: left; letter-spacing: normal; text-transform: none; font-weight: normal; }
        .arkada-card *, .arkada-card *::before, .arkada-card *::after { box-sizing: border-box; }
        .se-app-summary__cell > .arkada-card { margin: 0; }
        .arkada-card .arkada-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
        .arkada-card .arkada-card-title { font-family: var(--dt-font-display); font-size: var(--dt-size-heading); line-height: 24px; font-weight: 600; color: var(--dt-label); }
        .arkada-card .arkada-card-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-height: 24px; }
        .arkada-card .arkada-card-row + .arkada-card-row { margin-top: 2px; }
        .arkada-card .arkada-card-cap { color: var(--dt-label-2); }
        .arkada-card .arkada-card-val { color: var(--dt-label); font-variant-numeric: tabular-nums; text-align: right; }
        .arkada-card .arkada-card-big { display: block; font-family: var(--dt-font-display); font-size: 20px; line-height: 28px; font-weight: 600; font-variant-numeric: tabular-nums; }
        .arkada-card .arkada-card-good { color: var(--dt-green); }
        .arkada-card.arkada-card-inline { grid-column: 1 / -1; max-width: 720px; margin: 12px 0 0; }
        .arkada-card .arkada-card-stats { display: flex; flex-wrap: wrap; gap: 8px 32px; }
        .arkada-card .arkada-card-stat { display: flex; flex-direction: column; min-width: 0; }
        .arkada-card .arkada-card-sub { color: var(--dt-label-3); font-size: var(--dt-size-caption); }
        .arkada-card .arkada-card-links { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 8px; }
        .arkada-card .arkada-card-link { color: var(--ark-accent); text-decoration: none; cursor: pointer; }
        .arkada-card .arkada-card-link:hover { text-decoration: underline; }
        .arkada-card .arkada-card-note { margin-top: 8px; color: var(--dt-label-3); font-size: var(--dt-size-caption); line-height: 16px; }
        .arkada-card .arkada-card-hint { margin-top: 8px; color: var(--dt-label-2); }
        .arkada-card .arkada-card-form { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
        .arkada-card .arkada-card-input { flex: 1 1 200px; min-width: 0; height: 32px; padding: 0 10px; border: 1px solid var(--dt-edge); border-bottom-color: var(--dt-label-3);
          border-radius: var(--dt-radius-control); background: var(--dt-fill); color: var(--dt-label); font: inherit; outline: none; }
        .arkada-card .arkada-card-input:focus { border-bottom: 2px solid var(--ark-accent); background: var(--dt-bg); }
        .arkada-card .arkada-card-btn { height: 32px; padding: 0 12px; border: 1px solid var(--dt-edge); border-radius: var(--dt-radius-control); background: var(--dt-fill-2);
          color: var(--dt-label); font: inherit; cursor: default; transition: background var(--dt-dur-press) linear; }
        .arkada-card .arkada-card-btn:hover { background: var(--dt-fill-press); }
        .arkada-card .arkada-card-btn:disabled { color: var(--dt-label-3); background: var(--dt-fill); }
        .arkada-card .arkada-card-btn.arkada-card-primary { background: var(--ark-accent); border-color: transparent; color: var(--dt-label); }
        .arkada-card .arkada-card-btn:focus-visible, .arkada-card .arkada-card-link:focus-visible { outline: 2px solid var(--dt-label); outline-offset: 1px; }
        .arkada-inv-price { ${t.base || ''}
          position: absolute; left: 2px; bottom: 2px; z-index: 2; max-width: calc(100% - 4px); padding: 0 4px; border-radius: var(--dt-radius-row);
          background: color-mix(in srgb, var(--dt-bg) 82%, transparent); color: var(--dt-label); pointer-events: none;
          font-family: var(--dt-font-text); font-size: 11px; line-height: 16px; font-variant-numeric: tabular-nums;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        ${t.reduced ? '@media (prefers-reduced-motion: reduce) { .arkada-card { ' + t.reduced + ' } }' : ''}
        `;
        }
        function ensureStyle(doc, tokens) {
          if (doc.getElementById(STYLE_ID)) return;
          const s = doc.createElement('style');
          s.id = STYLE_ID;
          s.textContent = styleText(tokens);
          (doc.head || doc.documentElement).appendChild(s);
        }
        // The sheet goes with the last card of the page
        function dropStyle(doc) {
          if (doc.querySelector('.arkada-card') || doc.querySelector('.arkada-inv-price')) return;
          const s = doc.getElementById(STYLE_ID);
          if (s) try { s.remove(); } catch (e) { }
        }

        // Where a card of a game's store page goes: with the theme (Steam Enhanced draws the page anew and hides Steam's
        // own columns: <html class="se-app-summary-on">) at the top of the right column of its summary
        // (.se-app-summary__cell, the last one); without it, where `legacy()` says ({ parent, before }). null: not yet
        function appSlot(doc, legacy) {
          const html = doc.documentElement;
          if (html && html.classList && html.classList.contains('se-app-summary-on')) {
            const cells = doc.querySelectorAll('.se-app-summary__cell');
            const cell = cells[cells.length - 1];
            return cell ? { parent: cell, before: cell.firstChild } : null;
          }
          return legacy();
        }
        // Put a card at slot.before, after the cards of a lower data-arkada-order already there (Цены, then Об игре)
        function insertOrdered(slot, card) {
          const order = Number(card.getAttribute('data-arkada-order')) || 0;
          let ref = slot.before;
          while (ref && ref.parentNode === slot.parent && ref.classList && ref.classList.contains('arkada-card') && (Number(ref.getAttribute('data-arkada-order')) || 0) <= order) ref = ref.nextSibling;
          slot.parent.insertBefore(card, ref || null);
        }

        // The settings Steam writes on a store or community page: <div id="application_config" data-userinfo='{…}'>
        function userInfo(doc) {
          try {
            const el = doc.getElementById('application_config');
            const raw = el && (el.getAttribute('data-userinfo') || (el.dataset && el.dataset.userinfo));
            const v = raw ? JSON.parse(raw) : null;
            return v && typeof v === 'object' ? v : null;
          } catch (e) { return null; }
        }

        module.exports = { switchedOff, createCache, createQueue, parseMoney, formatLike, plural, builder, link, ensureStyle, dropStyle, appSlot, insertOrdered, userInfo, STYLE_ID };
      },
      "./share.js": function (module, exports, require) {
        // Arkada, «Поделиться» on a game's page in the Steam store: a button next to «В желаемое», «Подписаться»
        // and «Скрыть», and a menu of Windows 11 — copy the game's link, or send it to friends in Steam's chat.
        // Written for Arkada from what the Steam Share plugin does, no code taken from it.
        //
        // Runs in the store page itself (webkit.js, Millennium's webkit script): knows the page, not Steam.
        //   const s = createShare({ win, call, tokens });   s.stop();
        //   win        the store page's window
        //   call       (method, arg) → Promise: the plugin's part in the client (index.js, arkadaShare.*):
        //              "friends" → [{ id, name, status, avatar, online, inGame }]; "send" { ids, text } → [{ id, sent, error }]
        //   tokens     { base, reduced }: the dev.txt tokens as declarations (tokens.js, from theme/tokens.css): the menu
        //              and the dialog draw with them, scoped to their own elements, whatever the page has
        //
        // The button is Steam's own kind (.queue_control_button > .btnv6_blue_hoverfade > span), so the theme
        // (Steam Enhanced and Arkada's layer) draws it as one of the row. The theme setting «Arkada: поделиться» → Выкл
        // hides it at once (overlay/options/feature-share-off.css) and it is not put in again.
        //
        // Cost: one DOM watcher for the page (watch.js), and while the button is in place each pass is one
        // isConnected check. Layout is read only on a click (where to open the menu), never while scrolling:
        // a scroll closes the menu.
        'use strict';
        const { createWatch } = require('./watch.js');

        const ID = 'arkada-share';
        const STYLE_ID = 'arkada-share-style';
        const APP = /^\/app\/(\d+)(?:\/|$)/i;
        const STORE = 'store.steampowered.com';
        const TOAST_MS = 2200;
        // Segoe Fluent Icons (Windows 11), Segoe MDL2 Assets the same glyphs on Windows 10
        const ICON = { share: '', copy: '', send: '', check: '', search: '', person: '' };

        // The game of this page: { appId, title, url } or null. The address is the clean one, without tracking parameters
        function gameOf(loc, doc) {
          if (!loc || String(loc.hostname).toLowerCase() !== STORE) return null;
          const m = APP.exec(loc.pathname || '');
          if (!m) return null;
          let title = '';
          try { const n = doc.getElementById('appHubAppName') || doc.querySelector('.apphub_AppName'); if (n) title = String(n.textContent || '').trim(); } catch (e) { }
          if (!title) title = String(doc.title || '').replace(/\s+(?:в|on|на)\s+Steam\s*$/i, '').replace(/^Steam\s*[-—–:]\s*/i, '').trim();
          return { appId: m[1], title: title || 'Игра ' + m[1], url: 'https://' + STORE + '/app/' + m[1] + '/' };
        }

        const messageFor = g => g.title + ' в Steam:\n' + g.url;
        // 1 другу, 2 друзьям, 5 друзьям, 21 другу
        const friendsWord = n => (n % 10 === 1 && n % 100 !== 11 ? 'другу' : 'друзьям');

        // Replies from the client's part: a JSON string, or Millennium's { type: "string", value } around it
        function unwrap(r) {
          let v = r;
          for (let i = 0; i < 3 && typeof v === 'string'; i++) { try { v = JSON.parse(v); } catch (e) { break; } }
          if (v && typeof v === 'object' && !Array.isArray(v) && v.type === 'string' && typeof v.value === 'string') return unwrap(v.value);
          return v;
        }

        function styleText(tokens) {
          const t = tokens || {};
          return `
        .arkada-share-scope { ${t.base || ''}
          --ark-accent: var(--se-accent, var(--dt-accent));
          --ark-shadow: 0 8px 16px color-mix(in srgb, black 26%, transparent);
          --ark-shadow-dialog: 0 32px 64px color-mix(in srgb, black 37%, transparent), 0 2px 21px color-mix(in srgb, black 22%, transparent);
          font-family: var(--dt-font-text); font-size: var(--dt-size-body); line-height: 20px; color: var(--dt-label);
          -webkit-font-smoothing: antialiased; text-align: left; letter-spacing: normal; text-transform: none;
        }
        .arkada-share-scope *, .arkada-share-scope *::before, .arkada-share-scope *::after { box-sizing: border-box; }
        .arkada-share-ico { font-family: 'Segoe Fluent Icons', 'Segoe MDL2 Assets'; font-size: 16px; line-height: 1; font-weight: normal; font-style: normal; flex: none; }
        #${ID} .arkada-share-ico { font-size: 14px; }
        .arkada-share-layer { position: fixed; inset: 0; z-index: 2147483600; }
        .arkada-share-menu { position: fixed; min-width: 220px; padding: 4px; border-radius: var(--dt-radius-block); background: var(--dt-menu);
          border: 1px solid var(--dt-edge); box-shadow: var(--ark-shadow); backdrop-filter: blur(30px) saturate(1.25);
          opacity: 0; transform: translateY(-6px); transition: opacity var(--dt-dur-fast) var(--dt-ease-out), transform var(--dt-dur-base) var(--dt-ease-out); }
        .arkada-share-menu.arkada-share-open { opacity: 1; transform: none; }
        .arkada-share-item { display: flex; align-items: center; gap: 12px; width: 100%; height: 36px; padding: 0 12px; margin: 0; border: 0; border-radius: var(--dt-radius-row);
          background: transparent; color: var(--dt-label); font: inherit; cursor: default; outline: none; transition: background var(--dt-dur-press) linear; }
        .arkada-share-item + .arkada-share-item { margin-top: 2px; }
        .arkada-share-item:hover, .arkada-share-item:focus-visible { background: var(--dt-fill-2); }
        .arkada-share-item:active { background: var(--dt-fill-press); color: var(--dt-label-2); }
        .arkada-share-item:focus-visible { box-shadow: inset 0 0 0 2px var(--dt-label); }
        .arkada-share-smoke { position: fixed; inset: 0; display: grid; place-items: center; padding: 24px; background: color-mix(in srgb, black 40%, transparent);
          opacity: 0; transition: opacity var(--dt-dur-fast) var(--dt-ease-out); }
        .arkada-share-smoke.arkada-share-open { opacity: 1; }
        .arkada-share-dialog { display: flex; flex-direction: column; width: min(460px, 100%); height: min(600px, calc(100vh - 48px)); overflow: hidden;
          border-radius: var(--dt-radius-block); border: 1px solid var(--dt-edge); background: var(--dt-raised); box-shadow: var(--ark-shadow-dialog);
          transform: scale(1.05); transition: transform var(--dt-dur-base) var(--dt-ease-out); }
        .arkada-share-smoke.arkada-share-open .arkada-share-dialog { transform: none; }
        .arkada-share-body { display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 24px 24px 0; }
        .arkada-share-title { margin: 0 0 8px; font-family: var(--dt-font-display); font-size: var(--dt-size-title); line-height: 28px; font-weight: 600; color: var(--dt-label); }
        .arkada-share-text { margin: 0 0 16px; color: var(--dt-label-2); }
        .arkada-share-search { position: relative; margin-bottom: 8px; }
        .arkada-share-search .arkada-share-ico { position: absolute; right: 10px; top: 9px; color: var(--dt-label-2); pointer-events: none; }
        .arkada-share-input { width: 100%; height: 32px; padding: 0 36px 0 11px; border-radius: var(--dt-radius-control); border: 1px solid var(--dt-edge);
          border-bottom-color: var(--dt-label-3); background: var(--dt-fill); color: var(--dt-label); font: inherit; outline: none; }
        .arkada-share-input::placeholder { color: var(--dt-label-2); }
        .arkada-share-input:hover { background: var(--dt-fill-2); }
        .arkada-share-input:focus { background: var(--dt-bg); border-bottom: 2px solid var(--ark-accent); }
        .arkada-share-list { flex: 1; min-height: 120px; overflow-y: auto; margin: 0 -8px; padding: 0 8px 8px; }
        .arkada-share-friend { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 6px 12px; margin: 2px 0 0; border: 0;
          border-radius: var(--dt-radius-row); background: transparent; color: var(--dt-label); font: inherit; text-align: left; cursor: default; outline: none;
          transition: background var(--dt-dur-press) linear; }
        .arkada-share-friend:hover { background: var(--dt-fill); }
        .arkada-share-friend:active { background: var(--dt-fill-press); }
        .arkada-share-friend:focus-visible { box-shadow: inset 0 0 0 2px var(--dt-label); }
        .arkada-share-friend[aria-pressed="true"] { background: var(--dt-fill-2); }
        .arkada-share-avatar { width: 32px; height: 32px; flex: none; border-radius: 50%; object-fit: cover; background: var(--dt-fill-2);
          display: grid; place-items: center; color: var(--dt-label-2); }
        .arkada-share-offline .arkada-share-avatar { opacity: .55; }
        .arkada-share-who { display: grid; flex: 1; min-width: 0; }
        .arkada-share-name, .arkada-share-status { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .arkada-share-status { color: var(--dt-label-2); font-size: var(--dt-size-caption); line-height: 16px; }
        .arkada-share-mark { width: 20px; height: 20px; flex: none; display: grid; place-items: center; border-radius: var(--dt-radius-control);
          border: 1px solid var(--dt-label-3); color: transparent; font-size: 12px; transition: background var(--dt-dur-fast) var(--dt-ease-out), border-color var(--dt-dur-fast) var(--dt-ease-out); }
        .arkada-share-friend[aria-pressed="true"] .arkada-share-mark { background: var(--ark-accent); border-color: var(--ark-accent); color: var(--dt-label); }
        .arkada-share-empty { padding: 32px 12px; color: var(--dt-label-2); text-align: center; }
        .arkada-share-error { min-height: 20px; color: var(--dt-red); }
        .arkada-share-foot { display: flex; align-items: center; gap: 8px; padding: 24px; margin-top: 8px; background: var(--dt-surface); border-top: 1px solid var(--dt-separator); }
        .arkada-share-count { flex: 1; color: var(--dt-label-2); }
        .arkada-share-btn { min-width: 120px; height: 32px; padding: 0 12px; border-radius: var(--dt-radius-control); border: 1px solid var(--dt-edge);
          background: var(--dt-fill); color: var(--dt-label); font: inherit; cursor: default; outline: none; transition: background var(--dt-dur-press) linear; }
        .arkada-share-btn:hover { background: var(--dt-fill-2); }
        .arkada-share-btn:active { background: var(--dt-fill-press); color: var(--dt-label-2); }
        .arkada-share-btn:focus-visible { box-shadow: 0 0 0 2px var(--dt-label); }
        .arkada-share-primary { background: var(--ark-accent); border-color: transparent; color: var(--dt-label); }
        .arkada-share-primary:hover { background: color-mix(in srgb, var(--ark-accent) 90%, var(--dt-bg)); }
        .arkada-share-primary:active { background: color-mix(in srgb, var(--ark-accent) 80%, var(--dt-bg)); color: var(--dt-label-2); }
        .arkada-share-btn:disabled { opacity: .45; pointer-events: none; }
        .arkada-share-toast { position: fixed; z-index: 2147483601; max-width: 320px; padding: 8px 12px; border-radius: var(--dt-radius-tip); background: var(--dt-tooltip);
          border: 1px solid var(--dt-edge); box-shadow: var(--ark-shadow); color: var(--dt-label); pointer-events: none;
          opacity: 0; transform: translateY(4px); transition: opacity var(--dt-dur-fast) var(--dt-ease-out), transform var(--dt-dur-base) var(--dt-ease-out); }
        .arkada-share-toast.arkada-share-open { opacity: 1; transform: none; }
        ${t.reduced ? '@media (prefers-reduced-motion: reduce) { .arkada-share-scope { ' + t.reduced + ' } }' : ''}
        `;
        }

        function createShare(o) {
          const win = o.win, doc = win.document, call = o.call;
          let stopped = false, button = null, closeOpen = null, toastTimer = null, eatClick = false;

          // A small h(): an element with its props, attributes (strings in `attrs`) and children
          function h(tag, props, ...kids) {
            const el = doc.createElement(tag);
            for (const [k, v] of Object.entries(props || {})) {
              if (k === 'attrs') for (const [a, b] of Object.entries(v)) el.setAttribute(a, b);
              else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
              else el[k] = v;
            }
            for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.appendChild(typeof kid === 'string' ? doc.createTextNode(kid) : kid);
            return el;
          }
          const icon = name => h('span', { className: 'arkada-share-ico', attrs: { 'aria-hidden': 'true' } }, ICON[name]);

          function ensureStyle() {
            if (doc.getElementById(STYLE_ID)) return;
            const s = h('style', { id: STYLE_ID });
            s.textContent = styleText(o.tokens);
            (doc.head || doc.documentElement).appendChild(s);
          }

          // «Arkada: поделиться» → Выкл: the theme says off on <html>
          function switchedOff() {
            try { return String(win.getComputedStyle(doc.documentElement).getPropertyValue('--arkada-share') || '').trim().replace(/^["']|["']$/g, '').toLowerCase() === 'off'; } catch (e) { return false; }
          }

          // ───────── The button ─────────
          function place() {
            const row = doc.getElementById('queueActionsCtn') || doc.querySelector('.queue_actions_ctn');
            if (!row) return null;
            // After Ignore (its menu arrow with it), else after Follow, else after the wishlist button
            const after = row.querySelector('#ignoreBtn') || row.querySelector('.queue_btn_ignore') || row.querySelector('.queue_btn_follow') || row.querySelector('#add_to_wishlist_area');
            let anchor = after;
            while (anchor && anchor.parentNode !== row) anchor = anchor.parentNode;
            return { row, anchor };
          }
          function makeButton() {
            const inner = h('div', {
              className: 'btnv6_blue_hoverfade btn_medium',
              attrs: { role: 'button', tabindex: '0', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Поделиться ссылкой на игру' },
            }, h('span', null, icon('share'), 'Поделиться'));
            const open = e => {
              if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ' && e.key !== 'ArrowDown') return;
              e.preventDefault();
              e.stopPropagation();
              if (e.type === 'click' && eatClick) { eatClick = false; return; } // this press has just closed the menu
              if (closeOpen) { closeOpen(); return; }
              openMenu(inner, e.type === 'keydown');
            };
            inner.addEventListener('click', open);
            inner.addEventListener('keydown', open);
            return h('div', { id: ID, className: 'queue_control_button arkada-share-control arkada-share-scope' }, inner);
          }
          function reconcile() {
            if (stopped) return;
            const game = gameOf(win.location, doc);
            if (!game) { removeButton(); return; }
            if (button && button.isConnected) return; // in place: the whole pass is this check
            if (switchedOff()) return;
            const p = place();
            if (!p) return;
            ensureStyle();
            if (!button) button = makeButton();
            if (p.anchor && p.anchor.nextSibling) p.row.insertBefore(button, p.anchor.nextSibling);
            else if (p.anchor) p.row.appendChild(button);
            else {
              const right = p.row.querySelector('.right, .expand_to_fill');
              let a = right; while (a && a.parentNode !== p.row) a = a.parentNode;
              if (a) p.row.insertBefore(button, a); else p.row.appendChild(button);
            }
          }
          function removeButton() {
            if (closeOpen) closeOpen();
            if (button) try { button.remove(); } catch (e) { }
          }

          // ───────── Clipboard and a small message by the button ─────────
          async function copy(text) {
            try { if (win.navigator && win.navigator.clipboard && typeof win.navigator.clipboard.writeText === 'function') { await win.navigator.clipboard.writeText(text); return true; } } catch (e) { }
            try {
              const t = h('textarea', { value: text, attrs: { readonly: '', 'aria-hidden': 'true' } });
              t.style.position = 'fixed'; t.style.opacity = '0'; t.style.pointerEvents = 'none';
              doc.body.appendChild(t);
              t.select();
              const ok = doc.execCommand('copy');
              t.remove();
              return !!ok;
            } catch (e) { return false; }
          }
          let toastEl = null;
          function toast(text, near) {
            ensureStyle();
            if (!toastEl || !toastEl.isConnected) { toastEl = h('div', { className: 'arkada-share-scope arkada-share-toast', attrs: { role: 'status', 'aria-live': 'polite' } }); doc.body.appendChild(toastEl); }
            toastEl.textContent = text;
            toastEl.classList.remove('arkada-share-open');
            try {
              const r = (near && near.isConnected ? near : button).getBoundingClientRect(); // one read, now — not in a scroll
              const w = toastEl.offsetWidth, vw = win.innerWidth;
              toastEl.style.left = Math.round(Math.min(Math.max(8, r.left + (r.width - w) / 2), Math.max(8, vw - w - 8))) + 'px';
              toastEl.style.top = Math.round(Math.max(8, r.top - toastEl.offsetHeight - 8)) + 'px';
            } catch (e) { }
            win.requestAnimationFrame(() => toastEl && toastEl.classList.add('arkada-share-open'));
            if (toastTimer) clearTimeout(toastTimer);
            toastTimer = setTimeout(() => { toastTimer = null; if (toastEl) toastEl.classList.remove('arkada-share-open'); }, TOAST_MS);
          }

          // ───────── The menu ─────────
          function openMenu(anchor, fromKeyboard) {
            const game = gameOf(win.location, doc);
            if (!game) return;
            ensureStyle();
            const items = [
              h('button', { type: 'button', className: 'arkada-share-item', attrs: { role: 'menuitem' }, on: { click: () => { close(); copy(game.url).then(ok => toast(ok ? 'Ссылка скопирована' : 'Не удалось скопировать ссылку', anchor)); } } },
                icon('copy'), 'Копировать ссылку'),
              h('button', { type: 'button', className: 'arkada-share-item', attrs: { role: 'menuitem' }, on: { click: () => { close(); openDialog(game, anchor); } } },
                icon('send'), 'Отправить другу в Steam…'),
            ];
            const menu = h('div', { className: 'arkada-share-menu', attrs: { role: 'menu', 'aria-label': 'Поделиться' } }, ...items);
            const layer = h('div', { className: 'arkada-share-scope arkada-share-layer' }, menu);
            doc.body.appendChild(layer);
            // Where: under the button, kept on screen. Read once, at the click
            try {
              const r = anchor.getBoundingClientRect(), w = menu.offsetWidth, mh = menu.offsetHeight;
              const vw = win.innerWidth, vh = win.innerHeight;
              const left = Math.min(Math.max(8, r.left), Math.max(8, vw - w - 8));
              const top = r.bottom + 4 + mh <= vh - 8 ? r.bottom + 4 : Math.max(8, r.top - 4 - mh);
              menu.style.left = Math.round(left) + 'px';
              menu.style.top = Math.round(top) + 'px';
            } catch (e) { }
            win.requestAnimationFrame(() => menu.classList.add('arkada-share-open'));
            anchor.setAttribute('aria-expanded', 'true');
            if (fromKeyboard) items[0].focus();

            const onDown = e => { if (!menu.contains(e.target)) { eatClick = anchor.contains(e.target); close(); } };
            const onKey = e => {
              if (e.key === 'Escape') { e.preventDefault(); close(); anchor.focus(); return; }
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const i = items.indexOf(doc.activeElement), n = items.length;
                items[e.key === 'ArrowDown' ? (i + 1) % n : (i <= 0 ? n - 1 : i - 1)].focus();
              }
            };
            const onScroll = () => close();
            function close() {
              if (closeOpen !== close) return;
              closeOpen = null;
              anchor.setAttribute('aria-expanded', 'false');
              doc.removeEventListener('pointerdown', onDown, true);
              doc.removeEventListener('keydown', onKey, true);
              win.removeEventListener('scroll', onScroll, true);
              win.removeEventListener('resize', onScroll);
              win.removeEventListener('blur', onScroll);
              layer.remove();
            }
            if (closeOpen) closeOpen();
            closeOpen = close;
            layer.style.pointerEvents = 'none';
            menu.style.pointerEvents = 'auto';
            doc.addEventListener('pointerdown', onDown, true);
            doc.addEventListener('keydown', onKey, true);
            win.addEventListener('scroll', onScroll, { capture: true, passive: true });
            win.addEventListener('resize', onScroll);
            win.addEventListener('blur', onScroll);
          }

          // ───────── Send to friends ─────────
          function openDialog(game, anchor) {
            ensureStyle();
            const chosen = new Set();
            let friends = null, sending = false;
            const input = h('input', { type: 'search', className: 'arkada-share-input', placeholder: 'Поиск друзей', attrs: { 'aria-label': 'Поиск друзей', spellcheck: 'false' } });
            const list = h('div', { className: 'arkada-share-list', attrs: { role: 'group', 'aria-label': 'Друзья' } }, h('div', { className: 'arkada-share-empty' }, 'Загрузка друзей…'));
            const error = h('div', { className: 'arkada-share-error', attrs: { role: 'alert' } });
            const count = h('div', { className: 'arkada-share-count' });
            const sendBtn = h('button', { type: 'button', className: 'arkada-share-btn arkada-share-primary', disabled: true }, 'Отправить');
            const cancelBtn = h('button', { type: 'button', className: 'arkada-share-btn' }, 'Отмена');
            const dialog = h('div', { className: 'arkada-share-dialog', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Отправить другу' } },
              h('div', { className: 'arkada-share-body' },
                h('h2', { className: 'arkada-share-title' }, 'Отправить другу'),
                h('p', { className: 'arkada-share-text' }, 'Ссылка на «' + game.title + '» уйдёт в личные сообщения Steam.'),
                h('div', { className: 'arkada-share-search' }, input, icon('search')),
                list, error),
              h('div', { className: 'arkada-share-foot' }, count, sendBtn, cancelBtn));
            const smoke = h('div', { className: 'arkada-share-scope arkada-share-smoke' }, dialog);
            doc.body.appendChild(smoke);
            win.requestAnimationFrame(() => smoke.classList.add('arkada-share-open'));
            input.focus();

            function counted() {
              const n = chosen.size;
              count.textContent = n ? 'Выбрано: ' + n : '';
              sendBtn.disabled = !n || sending;
            }
            function row(f) {
              const avatar = f.avatar
                ? h('img', { className: 'arkada-share-avatar', src: f.avatar, alt: '', attrs: { loading: 'lazy', width: '32', height: '32' } })
                : h('span', { className: 'arkada-share-avatar' }, icon('person'));
              if (f.avatar) avatar.addEventListener('error', () => { avatar.removeAttribute('src'); });
              const b = h('button', { type: 'button', className: 'arkada-share-friend' + (f.online ? '' : ' arkada-share-offline'), attrs: { 'aria-pressed': String(chosen.has(f.id)) } },
                avatar, h('span', { className: 'arkada-share-who' }, h('span', { className: 'arkada-share-name' }, f.name), h('span', { className: 'arkada-share-status' }, f.status)),
                h('span', { className: 'arkada-share-mark', attrs: { 'aria-hidden': 'true' } }, h('span', { className: 'arkada-share-ico' }, ICON.check)));
              b.addEventListener('click', () => {
                if (chosen.has(f.id)) chosen.delete(f.id); else chosen.add(f.id);
                b.setAttribute('aria-pressed', String(chosen.has(f.id)));
                counted();
              });
              return b;
            }
            function render() {
              if (!friends) return;
              const q = String(input.value || '').trim().toLocaleLowerCase();
              const shown = q ? friends.filter(f => (f.name + ' ' + f.status).toLocaleLowerCase().includes(q)) : friends;
              while (list.firstChild) list.removeChild(list.firstChild);
              if (!shown.length) { list.appendChild(h('div', { className: 'arkada-share-empty' }, q ? 'Никого не нашлось' : 'В списке друзей пока никого нет')); return; }
              for (const f of shown) list.appendChild(row(f));
            }
            function close() {
              if (closeOpen !== close) return;
              closeOpen = null;
              doc.removeEventListener('keydown', onKey, true);
              smoke.remove();
              if (anchor && anchor.isConnected) anchor.focus();
            }
            const onKey = e => { if (e.key === 'Escape' && !sending) { e.preventDefault(); e.stopPropagation(); close(); } };
            if (closeOpen) closeOpen();
            closeOpen = close;
            doc.addEventListener('keydown', onKey, true);
            smoke.addEventListener('pointerdown', e => { if (e.target === smoke && !sending) close(); });
            cancelBtn.addEventListener('click', () => { if (!sending) close(); });
            input.addEventListener('input', render);

            Promise.resolve().then(() => call('friends')).then(unwrap).then(r => {
              if (!Array.isArray(r)) throw new Error('no list');
              friends = r.filter(f => f && typeof f.id === 'string' && /^\d{5,20}$/.test(f.id)).map(f => ({
                id: f.id, name: String(f.name || f.id), status: String(f.status || ''), avatar: /^https:\/\//.test(String(f.avatar || '')) ? String(f.avatar) : '', online: !!f.online,
              }));
              render();
              counted();
            }).catch(() => {
              while (list.firstChild) list.removeChild(list.firstChild);
              list.appendChild(h('div', { className: 'arkada-share-empty' }, 'Список друзей Steam сейчас недоступен. Ссылку можно скопировать из меню «Поделиться».'));
              input.disabled = true;
            });

            sendBtn.addEventListener('click', () => {
              if (sending || !chosen.size) return;
              sending = true;
              error.textContent = '';
              sendBtn.textContent = 'Отправка…';
              counted();
              cancelBtn.disabled = true;
              const ids = Array.from(chosen);
              Promise.resolve().then(() => call('send', JSON.stringify({ ids, text: messageFor(game) }))).then(unwrap).then(r => {
                const results = Array.isArray(r) ? r : [];
                const sent = results.filter(x => x && x.sent === true).length;
                if (!sent) throw new Error((results.find(x => x && x.error) || {}).error || 'not sent');
                sending = false;
                close();
                copy(game.url); // as the Steam Share plugin: the link is on the clipboard too
                toast(sent === ids.length ? 'Отправлено ' + sent + ' ' + friendsWord(sent) : 'Отправлено ' + sent + ' из ' + ids.length + ', остальным не удалось', anchor);
              }).catch(() => {
                sending = false;
                error.textContent = 'Steam не отправил сообщение. Попробуйте ещё раз.';
                sendBtn.textContent = 'Повторить';
                cancelBtn.disabled = false;
                counted();
              });
            });
          }

          const watch = createWatch(win, reconcile);
          watch.start();
          // Steam's store changes pages with history.pushState only here and there (the address does change)
          const onNav = () => watch.kick();
          win.addEventListener('popstate', onNav);

          return {
            stop() {
              if (stopped) return;
              stopped = true;
              watch.stop();
              win.removeEventListener('popstate', onNav);
              removeButton();
              if (toastTimer) clearTimeout(toastTimer);
              if (toastEl) try { toastEl.remove(); } catch (e) { }
              const st = doc.getElementById(STYLE_ID);
              if (st) try { st.remove(); } catch (e) { }
            },
          };
        }

        module.exports = { createShare, gameOf, unwrap, messageFor, friendsWord, ID };
      },
      "./dota.js": function (module, exports, require) {
        // Arkada, Dota 2 statistics on a Steam community profile: rank, matches and win rate, matches in the last
        // year, the three most played heroes and the three most frequent teammates — from OpenDota (api.opendota.com,
        // its free public API, no key). Instead of the Dota 2 Stats plugin; written for Arkada from what that plugin
        // shows (its own data comes through its author's proxy to STRATZ; here only OpenDota is asked).
        //
        // Runs in the profile page itself (webkit.js, Millennium's webkit script): knows the page, not Steam.
        //   const d = createDota({ win, storage, fetch, tokens });   d.stop();
        //   storage    the page's localStorage: answers are kept there for CACHE_MS, the heroes' names for a week
        //   fetch      the page's fetch: OpenDota answers a steamcommunity.com page with CORS headers of its own
        //   tokens     the dev.txt tokens (tokens.js): the card draws with them, scoped to itself
        //
        // Where: the top of the right column of the profile (.profile_rightcol), as that plugin puts it. Only on a
        // profile's own page (/id/<name> or /profiles/<id>, not its subpages). Nothing is shown when OpenDota knows no
        // matches of the player (never played, or the match data is hidden in Dota's settings).
        // The theme setting «Статистика Dota 2» → Выкл hides it at once (overlay/options/feature-dota-off.css), and the
        // page, reading --arkada-dota on its <html>, does not ask OpenDota at all.
        //
        // Cost: up to six requests to OpenDota per profile, once per CACHE_MS (OpenDota allows 60 a minute); one DOM
        // watcher only until the column is found; nothing reads layout.
        'use strict';
        const { createWatch } = require('./watch.js');

        const ID = 'arkada-dota';
        const STYLE_ID = 'arkada-dota-style';
        const API = 'https://api.opendota.com/api/';
        const CACHE_MS = 6 * 60 * 60 * 1000;
        const HEROES_MS = 7 * 24 * 60 * 60 * 1000;
        const KEY = 'arkada.dota.';
        const STEAM64 = 76561197960265728n;
        const PROFILE = /^\/(?:id\/[^/]+|profiles\/\d{17})\/?$/;
        const HERO_IMG = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/';
        const MEDALS = ['', 'Рекрут', 'Страж', 'Рыцарь', 'Герой', 'Легенда', 'Властелин', 'Божество', 'Титан'];

        // SteamID64 → Dota's account id (its lower 32 bits), or null
        function accountOf(steamid) {
          if (!/^\d{17}$/.test(String(steamid || ''))) return null;
          const id = BigInt(steamid) - STEAM64;
          return id > 0n && id < 4294967296n ? Number(id) : null;
        }

        // The profile's SteamID64: Steam's own g_rgProfileData on the page, else the address /profiles/<id>
        function steamIdOf(win) {
          try { const d = win.g_rgProfileData; if (d && /^\d{17}$/.test(String(d.steamid))) return String(d.steamid); } catch (e) { }
          const m = /^\/profiles\/(\d{17})/.exec(String(win.location && win.location.pathname || ''));
          return m ? m[1] : null;
        }

        // rank_tier 0–80 (tens: the medal, units: its stars) → «Властелин 3», «Титан», '' when not calibrated
        function rankName(tier, leaderboard) {
          const t = Number(tier) || 0, medal = Math.floor(t / 10), stars = t % 10;
          if (medal < 1 || medal > 8) return '';
          if (medal === 8) return 'Титан' + (Number(leaderboard) > 0 ? ' · №' + Number(leaderboard) + ' в таблице лидеров' : '');
          return MEDALS[medal] + (stars >= 1 && stars <= 5 ? ' ' + stars : '');
        }

        const percent = (win, games) => (games > 0 ? (Math.round(win / games * 1000) / 10).toFixed(1).replace('.', ',') + '%' : '—');
        const number = n => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
        // 1 матч, 2 матча, 5 матчей
        function matches(n) {
          const a = Math.abs(n) % 100, b = a % 10;
          return number(n) + ' ' + (a > 10 && a < 20 ? 'матчей' : b === 1 ? 'матч' : b >= 2 && b <= 4 ? 'матча' : 'матчей');
        }

        // The answers of OpenDota → what the card shows; null when there is nothing to show
        function summarize(a) {
          const p = a.player || {}, wl = a.wl || {}, year = a.year || {};
          const total = (Number(wl.win) || 0) + (Number(wl.lose) || 0);
          if (!p.profile || total <= 0) return null;
          const names = a.heroNames || {};
          const heroes = (Array.isArray(a.heroes) ? a.heroes : []).filter(h => h && h.games > 0).sort((x, y) => y.games - x.games).slice(0, 3)
            .map(h => { const n = names[h.hero_id] || {}; return { id: h.hero_id, name: n.name || 'Герой ' + h.hero_id, img: n.img || '', games: h.games, win: h.win }; });
          const peers = (Array.isArray(a.peers) ? a.peers : []).filter(x => x && x.with_games > 0).sort((x, y) => y.with_games - x.with_games).slice(0, 3)
            .map(x => ({ name: String(x.personaname || x.account_id).slice(0, 40), avatar: String(x.avatar || ''), games: x.with_games, win: x.with_win }));
          return {
            name: String(p.profile.personaname || ''), rank: rankName(p.rank_tier, p.leaderboard_rank), plus: !!p.profile.plus,
            total, win: Number(wl.win) || 0, year: (Number(year.win) || 0) + (Number(year.lose) || 0), heroes, peers,
            link: 'https://www.opendota.com/players/' + p.profile.account_id,
          };
        }

        function styleText(tokens) {
          const t = tokens || {};
          return `
        #${ID} { ${t.base || ''}
          --ark-accent: var(--se-accent, var(--dt-accent));
          margin: 0 0 16px; padding: 16px; border-radius: var(--dt-radius-block); border: 1px solid var(--dt-edge);
          background: color-mix(in srgb, var(--dt-raised) 88%, transparent); color: var(--dt-label);
          font-family: var(--dt-font-text); font-size: var(--dt-size-body); line-height: 20px; -webkit-font-smoothing: antialiased;
          text-align: left; letter-spacing: normal; text-transform: none; }
        #${ID} *, #${ID} *::before, #${ID} *::after { box-sizing: border-box; }
        #${ID} .arkada-dota-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
        #${ID} .arkada-dota-title { font-family: var(--dt-font-display); font-size: var(--dt-size-heading); font-weight: 600; }
        #${ID} .arkada-dota-link { color: var(--dt-label-2); font-size: var(--dt-size-caption); text-decoration: none; }
        #${ID} .arkada-dota-link:hover { color: var(--dt-label); text-decoration: underline; }
        #${ID} .arkada-dota-rank { color: var(--ark-accent); font-weight: 600; }
        #${ID} .arkada-dota-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 8px 0 12px; }
        #${ID} .arkada-dota-num { display: block; font-family: var(--dt-font-display); font-size: 18px; line-height: 24px; font-weight: 600; }
        #${ID} .arkada-dota-cap, #${ID} .arkada-dota-sub { display: block; color: var(--dt-label-2); font-size: var(--dt-size-caption); line-height: 16px; }
        #${ID} .arkada-dota-part { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--dt-separator); }
        #${ID} .arkada-dota-part-title { margin-bottom: 6px; color: var(--dt-label-2); font-size: var(--dt-size-caption); }
        #${ID} .arkada-dota-row { display: flex; align-items: center; gap: 10px; min-height: 32px; }
        #${ID} .arkada-dota-row + .arkada-dota-row { margin-top: 4px; }
        #${ID} .arkada-dota-pic { width: 48px; height: 27px; flex: none; border-radius: var(--dt-radius-control); object-fit: cover; background: var(--dt-fill-2); }
        #${ID} .arkada-dota-ava { width: 27px; height: 27px; flex: none; border-radius: 50%; object-fit: cover; background: var(--dt-fill-2); }
        #${ID} .arkada-dota-who { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #${ID} .arkada-dota-wr { flex: none; color: var(--dt-label-2); font-variant-numeric: tabular-nums; }
        #${ID} .arkada-dota-good { color: var(--dt-green); }
        #${ID} .arkada-dota-bad { color: var(--dt-red); }
        #${ID} .arkada-dota-note { margin-top: 12px; color: var(--dt-label-3); font-size: var(--dt-size-caption); line-height: 16px; }
        ${t.reduced ? '@media (prefers-reduced-motion: reduce) { #' + ID + ' { ' + t.reduced + ' } }' : ''}
        `;
        }

        function createDota(o) {
          const win = o.win, doc = win.document, storage = o.storage || null;
          const get = o.fetch || (typeof win.fetch === 'function' ? (u, i) => win.fetch(u, i) : null);
          const now = o.now || (() => Date.now());
          let stopped = false, card = null, data = undefined, loading = false, watch = null;

          function h(tag, cls, ...kids) {
            const el = doc.createElement(tag);
            if (cls) el.className = cls;
            for (const k of kids) if (k !== null && k !== undefined && k !== false) el.appendChild(typeof k === 'string' ? doc.createTextNode(k) : k);
            return el;
          }
          function img(cls, src) {
            const el = doc.createElement('img');
            el.className = cls;
            el.alt = '';
            el.setAttribute('loading', 'lazy');
            if (/^https:\/\//.test(src)) el.src = src;
            return el;
          }

          function switchedOff() {
            try { return String(win.getComputedStyle(doc.documentElement).getPropertyValue('--arkada-dota') || '').trim().replace(/^["']|["']$/g, '').toLowerCase() === 'off'; } catch (e) { return false; }
          }

          const read = k => { try { const v = JSON.parse((storage && storage.getItem(KEY + k)) || 'null'); return v && typeof v === 'object' ? v : null; } catch (e) { return null; } };
          const write = (k, v) => { try { if (storage) storage.setItem(KEY + k, JSON.stringify(v)); } catch (e) { } };
          const json = path => Promise.resolve(get(API + path)).then(r => {
            if (!r || !r.ok) throw new Error('OpenDota: HTTP ' + (r && r.status));
            return r.json();
          });

          // The heroes' names and pictures (OpenDota /heroes, kept a week): id → { name, img }
          async function heroNames() {
            const kept = read('heroes');
            if (kept && now() - kept.at < HEROES_MS && kept.map) return kept.map;
            const list = await json('heroes');
            const map = {};
            for (const x of Array.isArray(list) ? list : []) {
              if (!x || !x.id) continue;
              const short = String(x.name || '').replace(/^npc_dota_hero_/, '');
              map[x.id] = { name: String(x.localized_name || short), img: /^[a-z0-9_]+$/.test(short) ? HERO_IMG + short + '.png' : '' };
            }
            write('heroes', { at: now(), map });
            return map;
          }

          async function load(account) {
            const kept = read('p' + account);
            if (kept && now() - kept.at < CACHE_MS) return kept.data;
            const player = await json('players/' + account);
            let out = null;
            if (player && player.profile) {
              const [wl, year, heroes, peers, names] = await Promise.all([
                json('players/' + account + '/wl'), json('players/' + account + '/wl?date=365'),
                json('players/' + account + '/heroes').catch(() => []), json('players/' + account + '/peers').catch(() => []),
                heroNames().catch(() => ({})),
              ]);
              out = summarize({ player, wl, year, heroes, peers, heroNames: names });
            }
            write('p' + account, { at: now(), data: out });
            return out;
          }

          function build(s) {
            const box = h('div', '');
            box.id = ID;
            box.setAttribute('role', 'region');
            box.setAttribute('aria-label', 'Статистика Dota 2');
            const link = h('a', 'arkada-dota-link', 'OpenDota');
            link.href = s.link;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.title = 'Подробная статистика на opendota.com';
            box.appendChild(h('div', 'arkada-dota-head', h('span', 'arkada-dota-title', 'Dota 2'), link));
            if (s.rank) box.appendChild(h('div', 'arkada-dota-rank', s.rank));
            const wr = s.win / s.total;
            box.appendChild(h('div', 'arkada-dota-grid',
              h('div', '', h('span', 'arkada-dota-num', number(s.total)), h('span', 'arkada-dota-cap', 'матчей всего')),
              h('div', '', h('span', 'arkada-dota-num ' + (wr >= 0.5 ? 'arkada-dota-good' : 'arkada-dota-bad'), percent(s.win, s.total)), h('span', 'arkada-dota-cap', 'побед')),
              h('div', '', h('span', 'arkada-dota-num', number(s.year)), h('span', 'arkada-dota-cap', 'за последний год'))));
            const row = (pic, who, games, win) => h('div', 'arkada-dota-row', pic,
              h('span', 'arkada-dota-who', who, h('span', 'arkada-dota-sub', matches(games))),
              h('span', 'arkada-dota-wr ' + (win / games >= 0.5 ? 'arkada-dota-good' : 'arkada-dota-bad'), percent(win, games)));
            if (s.heroes.length) {
              const part = h('div', 'arkada-dota-part', h('div', 'arkada-dota-part-title', 'Любимые герои'));
              for (const x of s.heroes) part.appendChild(row(img('arkada-dota-pic', x.img), x.name, x.games, x.win));
              box.appendChild(part);
            }
            if (s.peers.length) {
              const part = h('div', 'arkada-dota-part', h('div', 'arkada-dota-part-title', 'Чаще всего играет с'));
              for (const x of s.peers) part.appendChild(row(img('arkada-dota-ava', x.avatar), x.name, x.games, x.win));
              box.appendChild(part);
            }
            box.appendChild(h('div', 'arkada-dota-note', 'По данным OpenDota: только матчи, открытые в настройках Dota 2.'));
            return box;
          }

          function ensureStyle() {
            if (doc.getElementById(STYLE_ID)) return;
            const s = doc.createElement('style');
            s.id = STYLE_ID;
            s.textContent = styleText(o.tokens);
            (doc.head || doc.documentElement).appendChild(s);
          }

          // Put the card in once the column is there and the data is in; done → the watcher goes
          function reconcile() {
            if (stopped || !data) return;
            if (card && card.isConnected) { if (watch) { watch.stop(); watch = null; } return; }
            const col = doc.querySelector('.profile_rightcol');
            if (!col) return;
            ensureStyle();
            card = build(data);
            col.insertBefore(card, col.firstChild);
            if (watch) { watch.stop(); watch = null; }
          }

          const account = PROFILE.test(String(win.location && win.location.pathname || '')) ? accountOf(steamIdOf(win)) : null;
          if (account && get && !switchedOff()) {
            loading = true;
            load(account).then(d => { data = d; }, () => { data = null; }).then(() => {
              loading = false;
              if (stopped || !data) return;
              reconcile(); // the column is usually there already; else wait for it
              if (card && card.isConnected) return;
              watch = createWatch(win, reconcile);
              watch.start();
            });
          }

          return {
            loading: () => loading,
            stop() {
              if (stopped) return;
              stopped = true;
              if (watch) watch.stop();
              watch = null;
              if (card) try { card.remove(); } catch (e) { }
              const st = doc.getElementById(STYLE_ID);
              if (st) try { st.remove(); } catch (e) { }
            },
          };
        }

        module.exports = { createDota, accountOf, steamIdOf, rankName, summarize, matches, ID };
      },
      "./prices.js": function (module, exports, require) {
        // Arkada, prices on a game's page in the Steam store: a link to the game's price history on SteamDB (no
        // request: only a link), and — with the user's own IsThereAnyDeal API key — the best price in other shops
        // right now and the lowest price ever, from IsThereAnyDeal API v2 (games/overview/v2). Written for Arkada
        // from what Augmented Steam shows; no code taken from it.
        //
        // Runs in the store page itself (webkit.js): knows the page, not Steam.
        //   const p = createPrices({ win, server, tokens });   p.stop();
        //   server   (method, args) → Promise of the reply of the plugin's Lua backend (Millennium.callServerMethod),
        //            null when there is no backend: ItadPrices { appid, country } → { success, hasKey, data | error },
        //            ItadKey { key } → { success, hasKey } (an empty key removes it). See plugin/backend/arkada_itad.lua
        //
        // The key is not kept in the page: the backend writes it next to Steam (millennium/arkada-itad.json), asks
        // api.isthereanydeal.com itself (one lookup of the game's ITAD id, then the overview, kept 6 hours) and gives
        // the page only the prices. Without a key nothing goes to IsThereAnyDeal; the card shows the links and how
        // to add a key.
        //
        // Where: with the theme, the top of the right column of its summary of the game; without it, the top of the
        // purchase area (#game_area_purchase). One DOM watcher (watch.js) for the page: while the card is in place a
        // pass is one isConnected check; the theme may draw its summary again, and the card goes back.
        'use strict';
        const { createWatch } = require('./watch.js');
        const web = require('./web.js');
        const { unwrap } = require('./share.js');

        const ID = 'arkada-prices';
        const APP = /^\/app\/(\d+)(?:\/|$)/i;
        const KEY_PAGE = 'https://isthereanydeal.com/apps/my/';

        function appOf(win) {
          const loc = win.location || {};
          if (String(loc.hostname).toLowerCase() !== 'store.steampowered.com') return null;
          const m = APP.exec(String(loc.pathname || ''));
          return m ? m[1] : null;
        }

        // ITAD's { amount, currency } → '1 299,00 ₴' (the currency of the country of the user's store)
        function money(p) {
          if (!p || typeof p.amount !== 'number') return '';
          try { return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: String(p.currency || 'USD') }).format(p.amount); }
          catch (e) { return p.amount.toFixed(2) + ' ' + String(p.currency || ''); }
        }
        function day(iso) {
          const d = new Date(String(iso || ''));
          if (isNaN(d.getTime())) return '';
          try { return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return d.toISOString().slice(0, 10); }
        }

        function createPrices(o) {
          const win = o.win, doc = win.document, server = o.server || (() => Promise.resolve(null));
          const h = web.builder(doc);
          const appId = appOf(win);
          let stopped = false, card = null, watch = null, state = { phase: 'loading' }, editing = false;

          const ask = (method, args) => Promise.resolve().then(() => server(method, args)).then(unwrap, () => null);
          const country = () => { const u = web.userInfo(doc); return u && /^[A-Z]{2}$/.test(String(u.country_code)) ? String(u.country_code) : 'US'; };

          function row(cap, val, sub) {
            return h('div', 'arkada-card-row', h('span', 'arkada-card-cap', cap), h('span', 'arkada-card-val', val, sub ? h('span', 'arkada-card-sub', ' ' + sub) : null));
          }
          function deal(d) {
            const text = money(d.price) + (d.shop ? ' · ' + d.shop : '');
            const cut = Number(d.cut) > 0 ? '−' + Math.round(Number(d.cut)) + '%' : '';
            if (d.url) { const a = web.link(doc, text, d.url, 'Открыть предложение (ссылка IsThereAnyDeal)'); return [a, cut]; }
            return [text, cut];
          }

          function keyForm(has) {
            const input = h('input', 'arkada-card-input');
            input.setAttribute('type', 'password');
            input.setAttribute('autocomplete', 'off');
            input.setAttribute('spellcheck', 'false');
            input.setAttribute('placeholder', 'Ключ API IsThereAnyDeal');
            input.setAttribute('aria-label', 'Ключ API IsThereAnyDeal');
            const save = h('button', 'arkada-card-btn arkada-card-primary', 'Сохранить');
            save.setAttribute('type', 'button');
            const cancel = h('button', 'arkada-card-btn', 'Отмена');
            cancel.setAttribute('type', 'button');
            const form = h('div', 'arkada-card-form', input, save, cancel);
            const submit = value => {
              save.disabled = true;
              ask('ItadKey', { key: value }).then(r => {
                editing = false;
                if (!r || !r.success) { state = { phase: 'error', text: 'Ключ не сохранён: ' + String((r && r.error) || 'нет ответа плагина') }; draw(); return; }
                load();
              });
            };
            save.addEventListener('click', () => { const v = String(input.value || '').trim(); if (v) submit(v); });
            input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { const v = String(input.value || '').trim(); if (v) submit(v); } else if (ev.key === 'Escape') { editing = false; draw(); } });
            cancel.addEventListener('click', () => { editing = false; draw(); });
            const parts = [form];
            if (has) {
              const remove = h('button', 'arkada-card-btn', 'Удалить ключ');
              remove.setAttribute('type', 'button');
              remove.addEventListener('click', () => submit(''));
              form.appendChild(remove);
            }
            parts.push(h('div', 'arkada-card-note',
              'Ключ даёт IsThereAnyDeal бесплатно: зарегистрируйте приложение на ', web.link(doc, 'isthereanydeal.com/apps/my', KEY_PAGE),
              '. Ключ хранится только на этом компьютере (папка Steam, millennium/arkada-itad.json) и уходит только на api.isthereanydeal.com.'));
            setTimeout(() => { try { input.focus(); } catch (e) { } }, 0);
            return parts;
          }

          function build() {
            const box = h('div', 'arkada-card');
            box.id = ID;
            box.setAttribute('data-arkada-order', '1');
            box.setAttribute('role', 'region');
            box.setAttribute('aria-label', 'Цены');
            const keyLink = h('a', 'arkada-card-link', state.hasKey ? 'Ключ IsThereAnyDeal' : 'Добавить ключ');
            keyLink.setAttribute('role', 'button');
            keyLink.setAttribute('tabindex', '0');
            const openForm = () => { editing = true; draw(); };
            keyLink.addEventListener('click', openForm);
            keyLink.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openForm(); } });
            box.appendChild(h('div', 'arkada-card-head', h('span', 'arkada-card-title', 'Цены'), state.backend ? keyLink : null));
            const d = state.data;
            if (state.phase === 'loading') box.appendChild(h('div', 'arkada-card-sub', 'Узнаю цены…'));
            else if (state.phase === 'error') box.appendChild(h('div', 'arkada-card-hint', state.text));
            else if (state.hasKey && !d) box.appendChild(h('div', 'arkada-card-hint', 'IsThereAnyDeal не знает этой игры или её цен.'));
            else if (d) {
              if (d.current) { const [v, cut] = deal(d.current); box.appendChild(row('Сейчас дешевле всего', v, cut)); }
              if (d.lowest) { const [v, cut] = deal(d.lowest); box.appendChild(row('Исторический минимум', v, [cut, day(d.lowest.timestamp)].filter(Boolean).join(', '))); }
            } else if (state.backend) {
              box.appendChild(h('div', 'arkada-card-hint', 'Лучшая цена в других магазинах и исторический минимум появятся здесь, если добавить личный ключ IsThereAnyDeal.'));
            }
            if (editing) for (const p of keyForm(state.hasKey)) box.appendChild(p);
            const itad = d && d.game ? d.game : 'https://isthereanydeal.com/steam/app/' + appId + '/';
            box.appendChild(h('div', 'arkada-card-links',
              web.link(doc, 'История цен на SteamDB', 'https://steamdb.info/app/' + appId + '/#pricehistory', 'steamdb.info'),
              web.link(doc, 'IsThereAnyDeal', itad, 'Цены этой игры в магазинах, isthereanydeal.com')));
            if (d) box.appendChild(h('div', 'arkada-card-note', 'Цены — IsThereAnyDeal (isthereanydeal.com) для страны вашего магазина, обновляются не чаще раза в 6 часов. Arkada с IsThereAnyDeal не связана.'));
            return box;
          }

          function draw() {
            if (stopped) return;
            const old = card;
            card = build();
            if (old && old.parentNode) { old.parentNode.insertBefore(card, old); old.remove(); }
            else reconcile();
          }

          // In place: the whole pass is this check. The theme may draw its summary again: the card goes back in
          function reconcile() {
            if (stopped || !card || card.isConnected) return;
            const slot = web.appSlot(doc, () => { const a = doc.getElementById('game_area_purchase'); return a ? { parent: a, before: a.firstChild } : null; });
            if (!slot) return;
            web.ensureStyle(doc, o.tokens);
            web.insertOrdered(slot, card);
          }

          function load() {
            state = { phase: 'loading', backend: state.backend, hasKey: state.hasKey };
            draw();
            ask('ItadPrices', { appid: Number(appId), country: country() }).then(r => {
              if (stopped) return;
              if (!r || typeof r !== 'object') state = { phase: 'done', backend: false };
              else if (r.success) state = { phase: 'done', backend: true, hasKey: !!r.hasKey, data: r.data || null };
              else if (r.error === 'no key') state = { phase: 'done', backend: true, hasKey: false };
              else if (r.error === 'bad key') state = { phase: 'error', backend: true, hasKey: true, text: 'IsThereAnyDeal не принял ключ — проверьте его.' };
              else if (r.error === 'rate') state = { phase: 'error', backend: true, hasKey: true, text: 'Слишком много запросов к IsThereAnyDeal — цены появятся позже.' };
              else state = { phase: 'error', backend: true, hasKey: !!r.hasKey, text: 'IsThereAnyDeal не ответил.' };
              draw();
            });
          }

          if (appId && !web.switchedOff(win, 'prices')) {
            load();
            watch = createWatch(win, reconcile);
            watch.start();
          }

          return {
            state: () => state,
            stop() {
              if (stopped) return;
              stopped = true;
              if (watch) watch.stop();
              watch = null;
              if (card) try { card.remove(); } catch (e) { }
              web.dropStyle(doc);
            },
          };
        }

        module.exports = { createPrices, money, appOf, ID };
      },
      "./gameinfo.js": function (module, exports, require) {
        // Arkada, about the game on its page in the Steam store: how long you have played it and since when it is on
        // your account — from the Steam client itself (its library: appStore, the plugin's part in the client,
        // index.js arkadaGame.info) — and links to the game on SteamDB, PCGamingWiki and ProtonDB (links only, no
        // request). Written for Arkada from what Augmented Steam and SteamDB's extension show; no code taken from them.
        //
        // Runs in the store page itself (webkit.js): knows the page, not Steam.
        //   const g = createGameInfo({ win, call, tokens });   g.stop();
        //   call   (name, arg) → Promise: the plugin's part in the client, "arkadaGame.info" appid →
        //          { owned, minutes, minutesTwoWeeks, lastPlayed, purchased } (seconds since 1970), or null
        //
        // Where: under «Цены» — with the theme in the right column of its summary of the game, without it at the top of
        // Steam's right column (.rightcol.game_meta_data). One DOM watcher for the page, as prices.js. Nothing goes to the internet.
        'use strict';
        const { createWatch } = require('./watch.js');
        const web = require('./web.js');
        const { unwrap } = require('./share.js');
        const { appOf } = require('./prices.js');

        const ID = 'arkada-game-info';

        // 8302 minutes → '138,4 ч'; under an hour → '45 мин'
        function hours(minutes) {
          const m = Math.max(0, Math.round(Number(minutes) || 0));
          if (m < 60) return m + ' мин';
          const v = Math.round(m / 6) / 10;
          return String(v).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ч';
        }
        function date(seconds) {
          const s = Number(seconds) || 0;
          if (s <= 0) return '';
          const d = new Date(s * 1000);
          try { return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return d.toISOString().slice(0, 10); }
        }

        function createGameInfo(o) {
          const win = o.win, doc = win.document, call = o.call || (() => Promise.reject(new Error('no bridge')));
          const h = web.builder(doc);
          const appId = appOf(win);
          let stopped = false, card = null, watch = null, info = undefined;

          function build() {
            const box = h('div', 'arkada-card');
            box.id = ID;
            box.setAttribute('data-arkada-order', '2');
            box.setAttribute('role', 'region');
            box.setAttribute('aria-label', 'Об игре');
            box.appendChild(h('div', 'arkada-card-head', h('span', 'arkada-card-title', 'Об игре')));
            const row = (cap, val) => h('div', 'arkada-card-row', h('span', 'arkada-card-cap', cap), h('span', 'arkada-card-val', val));
            if (info && info.owned) {
              box.appendChild(row('Вы играли', hours(info.minutes)));
              if (Number(info.minutesTwoWeeks) > 0) box.appendChild(row('За две недели', hours(info.minutesTwoWeeks)));
              if (date(info.lastPlayed)) box.appendChild(row('Последний запуск', date(info.lastPlayed)));
              if (date(info.purchased)) box.appendChild(row('На аккаунте с', date(info.purchased)));
            }
            box.appendChild(h('div', 'arkada-card-links',
              web.link(doc, 'SteamDB', 'https://steamdb.info/app/' + appId + '/', 'Сведения об игре на steamdb.info'),
              web.link(doc, 'PCGamingWiki', 'https://www.pcgamingwiki.com/api/appid.php?appid=' + appId, 'Исправления и настройки на pcgamingwiki.com'),
              web.link(doc, 'ProtonDB', 'https://www.protondb.com/app/' + appId, 'Как игра идёт на Linux и Steam Deck, protondb.com')));
            if (info && info.owned) box.appendChild(h('div', 'arkada-card-note', 'Время и дата — из вашей библиотеки в клиенте Steam.'));
            return box;
          }

          // In place: the whole pass is this check. The theme may draw its summary again: the card goes back in
          function reconcile() {
            if (stopped || info === undefined || (card && card.isConnected)) return;
            const slot = web.appSlot(doc, () => {
              for (const c of doc.querySelectorAll('.rightcol.game_meta_data')) if (!c.id) return { parent: c, before: c.firstChild };
              return null;
            });
            if (!slot) return;
            web.ensureStyle(doc, o.tokens);
            if (!card) card = build();
            web.insertOrdered(slot, card);
          }

          if (appId && !web.switchedOff(win, 'game-info')) {
            Promise.resolve().then(() => call('arkadaGame.info', appId)).then(unwrap, () => null).then(r => {
              if (stopped) return;
              info = r && typeof r === 'object' ? r : null;
              reconcile();
              watch = createWatch(win, reconcile);
              watch.start();
            });
          }

          return {
            info: () => info,
            stop() {
              if (stopped) return;
              stopped = true;
              if (watch) watch.stop();
              watch = null;
              if (card) try { card.remove(); } catch (e) { }
              web.dropStyle(doc);
            },
          };
        }

        module.exports = { createGameInfo, hours, ID };
      },
      "./hideowned.js": function (module, exports, require) {
        // Arkada, the Steam store without what you already have: games you own and games you have ignored are not
        // shown in the store's lists — search results, tag, genre and sale pages, recommendations. Written for
        // Arkada from what Augmented Steam does; no code taken from it.
        //
        // How: the store itself marks such items. Every item of its lists that Steam may collapse carries
        // .ds_collapse_flag, and Steam's own script (GDynamicStore.DecorateDynamicItems, from the user's data on the
        // page) adds .ds_owned or .ds_ignored to it. One style sheet hides exactly those — no watcher, no request,
        // no reading of the page: a row Steam adds while scrolling is hidden by the same rule.
        // Not on the page of a game, a package or a bundle (its list of DLC shows what you own on purpose), nor on
        // the wishlist. Items Steam draws without these marks (parts of its newer React pages) stay as they are.
        // The theme setting → Выкл takes effect on the next page that opens.
        'use strict';
        const web = require('./web.js');

        const STYLE_ID = 'arkada-hide-owned';
        const SKIP = /^\/(?:app|sub|bundle|wishlist|cart|account|checkout)\b/i;

        const CSS = `
        .ds_collapse_flag.ds_owned, .ds_collapse_flag.ds_ignored { display: none !important; }
        `;

        function createHideOwned(o) {
          const win = o.win, doc = win.document;
          const loc = win.location || {};
          let style = null;
          const store = String(loc.hostname).toLowerCase() === 'store.steampowered.com';
          if (store && !SKIP.test(String(loc.pathname || '')) && !web.switchedOff(win, 'hide-owned') && !doc.getElementById(STYLE_ID)) {
            style = doc.createElement('style');
            style.id = STYLE_ID;
            style.textContent = CSS;
            (doc.head || doc.documentElement).appendChild(style);
          }
          return {
            on: () => !!style,
            stop() { if (style) try { style.remove(); } catch (e) { } style = null; },
          };
        }

        module.exports = { createHideOwned, STYLE_ID };
      },
      "./wishlist.js": function (module, exports, require) {
        // Arkada, the sum of a wishlist in the Steam store: what all its games cost now, with today's discounts, what
        // they would cost without them, and how many are on sale. Written for Arkada from what Augmented Steam shows;
        // no code taken from it.
        //
        // Runs in the wishlist page itself (webkit.js): knows the page, not Steam.
        //   const w = createWishlist({ win, storage, fetch, tokens });   w.stop();
        //
        // Data: Steam's own public Web API, the same the page itself uses, asked by the page (api.steampowered.com
        // answers store.steampowered.com with CORS headers): IWishlistService/GetWishlist (the list's games) and
        // IStoreBrowseService/GetItems (their price in the user's store: best_purchase_option), 100 games per request,
        // one request at a time. The answer is kept in the page's localStorage for CACHE_MS. A private wishlist
        // gives nothing, and nothing is shown.
        //
        // Where: under the list's title, in its block (the title's parent). The page is drawn by React and may draw its header again: a light timer
        // (EVERY_MS, one isConnected check) puts the card back; no DOM watcher once the card is in.
        'use strict';
        const web = require('./web.js');

        const ID = 'arkada-wishlist-sum';
        const API = 'https://api.steampowered.com/';
        const CACHE_MS = 30 * 60 * 1000;
        const EVERY_MS = 1500;
        const CHUNK = 100;
        const PAGE = /^\/wishlist(?:\/(?:id\/[^/]+|profiles\/(\d{17})))?\/?$/i;

        // The SSR data of the page: Steam's React pages keep their loaders' JSON in window.SSR.loaderData
        function loaderData(win) {
          const out = [];
          try { for (const s of (win.SSR && win.SSR.loaderData) || []) { try { const v = typeof s === 'string' ? JSON.parse(s) : s; if (v && typeof v === 'object') out.push(v); } catch (e) { } } } catch (e) { }
          return out;
        }

        // Whose wishlist: the loader of the list ({ steamid, sort, filters }), else /wishlist/profiles/<id>, else the user (own list)
        function ownerOf(win) {
          const data = loaderData(win);
          for (const v of data) if (/^\d{17}$/.test(String(v.steamid)) && ('sort' in v || 'filters' in v)) return String(v.steamid);
          const m = PAGE.exec(String(win.location && win.location.pathname || ''));
          if (m && m[1]) return m[1];
          if (m && /^\/wishlist\/?$/i.test(String(win.location.pathname))) {
            for (const v of data) if (/^\d{17}$/.test(String(v.steamid))) return String(v.steamid);
            const u = web.userInfo(win.document);
            if (u && /^\d{17}$/.test(String(u.steamid))) return String(u.steamid);
          }
          return null;
        }
        function contextOf(win) {
          for (const v of loaderData(win)) {
            const c = v.storeBrowseContext;
            if (c && /^[A-Z]{2}$/.test(String(c.country))) return { country_code: String(c.country), language: String(c.language || 'english') };
          }
          const u = web.userInfo(win.document);
          return { country_code: u && /^[A-Z]{2}$/.test(String(u.country_code)) ? String(u.country_code) : 'US', language: 'russian' };
        }

        // GetItems' store_items → { total, regular, priced, sale, free, sample }; cents as Steam gives them (strings)
        function summarize(items) {
          const s = { total: 0, regular: 0, priced: 0, sale: 0, none: 0, sample: '' };
          for (const it of items) {
            const b = it && it.best_purchase_option;
            const final = b ? Number(b.final_price_in_cents) : NaN;
            if (!b || !isFinite(final)) { s.none++; continue; }
            const orig = Number(b.original_price_in_cents);
            s.total += final;
            s.regular += isFinite(orig) && orig > final ? orig : final;
            s.priced++;
            if (Number(b.discount_pct) > 0 || (isFinite(orig) && orig > final)) s.sale++;
            if (!s.sample && b.formatted_final_price) s.sample = String(b.formatted_final_price);
          }
          return s;
        }

        function createWishlist(o) {
          const win = o.win, doc = win.document;
          const get = o.fetch || (typeof win.fetch === 'function' ? (u, i) => win.fetch(u, i) : null);
          const cache = web.createCache(o.storage || null, 'arkada.wishlist.', o.now);
          const h = web.builder(doc);
          const path = String(win.location && win.location.pathname || '');
          let stopped = false, card = null, timer = null, sum = undefined;

          const json = url => Promise.resolve(get(url)).then(r => { if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status)); return r.json(); });

          async function load(owner) {
            const kept = cache.get(owner, CACHE_MS);
            if (kept) return kept;
            const list = await json(API + 'IWishlistService/GetWishlist/v1/?steamid=' + owner);
            const ids = ((list && list.response && list.response.items) || []).map(i => Number(i && i.appid)).filter(n => n > 0);
            const items = [];
            const context = contextOf(win);
            for (let i = 0; i < ids.length && !stopped; i += CHUNK) {
              const q = { ids: ids.slice(i, i + CHUNK).map(appid => ({ appid })), context: { language: context.language, country_code: context.country_code, steam_realm: 1 }, data_request: {} };
              const r = await json(API + 'IStoreBrowseService/GetItems/v1/?input_json=' + encodeURIComponent(JSON.stringify(q)));
              for (const it of (r && r.response && r.response.store_items) || []) items.push(it);
            }
            const s = Object.assign(summarize(items), { count: ids.length });
            cache.set(owner, s);
            return s;
          }

          function build(s) {
            const box = h('div', 'arkada-card arkada-card-inline');
            box.id = ID;
            box.setAttribute('role', 'region');
            box.setAttribute('aria-label', 'Сумма списка желаемого');
            const money = cents => web.formatLike(s.sample, cents / 100);
            box.appendChild(h('div', 'arkada-card-head', h('span', 'arkada-card-title', 'Сумма списка'),
              h('span', 'arkada-card-sub', s.priced + ' ' + web.plural(s.priced, 'игра', 'игры', 'игр') + ' с ценой' + (s.none ? ', ' + s.none + ' без цены' : ''))));
            const stat = (value, cap, cls) => h('div', 'arkada-card-stat', h('span', 'arkada-card-big' + (cls ? ' ' + cls : ''), value), h('span', 'arkada-card-sub', cap));
            const grid = h('div', 'arkada-card-stats', stat(money(s.total), 'сейчас, со скидками'));
            if (s.regular > s.total) {
              grid.appendChild(stat(money(s.regular), 'без скидок'));
              grid.appendChild(stat(money(s.regular - s.total), 'экономия: ' + s.sale + ' ' + web.plural(s.sale, 'игра', 'игры', 'игр') + ' со скидкой', 'arkada-card-good'));
            }
            box.appendChild(grid);
            box.appendChild(h('div', 'arkada-card-note', 'Цены магазина Steam в вашем регионе, с сегодняшними скидками; без цены — ещё не вышедшие и бесплатные. Обновляется раз в 30 минут.'));
            return box;
          }

          function place() {
            if (stopped || !sum) return;
            if (String(win.location && win.location.pathname || '') !== path) { if (card) try { card.remove(); } catch (e) { } return; }
            if (card && card.isConnected) return;
            const title = doc.querySelector('h2');
            const at = title && title.parentNode;
            if (!at) return;
            web.ensureStyle(doc, o.tokens);
            card = card || build(sum);
            at.appendChild(card);
          }

          const owner = PAGE.test(path) && String(win.location.hostname).toLowerCase() === 'store.steampowered.com' ? ownerOf(win) : null;
          if (owner && get && !web.switchedOff(win, 'wishlist-sum')) {
            load(owner).then(s => { sum = s && s.priced > 0 ? s : null; }, () => { sum = null; }).then(() => {
              if (stopped || !sum) return;
              place();
              timer = setInterval(place, o.everyMs || EVERY_MS);
            });
          }

          return {
            sum: () => sum,
            stop() {
              if (stopped) return;
              stopped = true;
              if (timer) clearInterval(timer);
              timer = null;
              if (card) try { card.remove(); } catch (e) { }
              web.dropStyle(doc);
            },
          };
        }

        module.exports = { createWishlist, summarize, ownerOf, ID };
      },
      "./inventory.js": function (module, exports, require) {
        // Arkada, prices in a Steam inventory (steamcommunity.com/…/inventory): next to every item that can be sold
        // on the Community Market, its lowest price there now; above the inventory, what the items of the open
        // game's inventory are worth together. Written for Arkada from what Augmented Steam shows; no code taken from it.
        //
        // Runs in the inventory page itself (webkit.js): knows the page, not Steam.
        //   const v = createInventory({ win, storage, fetch, tokens });   v.stop();
        //
        // Data: Steam's own market/priceoverview (the price the inventory's sell dialog shows), asked by the page,
        // for each kind of item once (market_hash_name), in the wallet's currency. Steam limits it hard, so:
        // one request at a time, no sooner than EVERY_MS after the previous one; Steam says 429 → nothing for
        // BACKOFF_MS (doubling, up to 10 minutes); a price is kept a day (CACHE_MS) in the page's localStorage, so
        // opening the inventory again asks only for what is new. While the page is hidden nothing is asked.
        // The items are Steam's own objects on the page (g_ActiveInventory, its m_rgAssets with their
        // descriptions; the parts of the Steam inventory are its m_rgChildInventories): nothing reads layout.
        // Which inventory is open is looked at every LOOK_MS (one comparison); no DOM watcher.
        'use strict';
        const web = require('./web.js');

        const ID = 'arkada-inventory-value';
        const PAGE = /^\/(?:id\/[^/]+|profiles\/\d{17})\/inventory\/?$/i;
        const EVERY_MS = 1500;
        const LOOK_MS = 1500;
        const BACKOFF_MS = 60 * 1000;
        const CACHE_MS = 24 * 60 * 60 * 1000;
        const MAX_KEPT = 4000;

        // The items of the open inventory: [{ key, appid, name, amount, element }] — only what the market can sell
        function itemsOf(inv) {
          const out = [];
          if (!inv) return out;
          const parts = inv.m_rgChildInventories && Object.keys(inv.m_rgChildInventories).length ? Object.values(inv.m_rgChildInventories) : [inv];
          for (const part of parts) {
            const assets = (part && part.m_rgAssets) || {};
            for (const id of Object.keys(assets)) {
              const a = assets[id], d = a && a.description;
              if (!d || !Number(d.marketable) || !d.market_hash_name) continue;
              out.push({ key: d.appid + '/' + d.market_hash_name, appid: String(d.appid), name: String(d.market_hash_name), amount: Math.max(1, Number(a.amount) || 1), element: a.element || null });
            }
          }
          return out;
        }

        function createInventory(o) {
          const win = o.win, doc = win.document, storage = o.storage || null;
          const get = o.fetch || (typeof win.fetch === 'function' ? (u, i) => win.fetch(u, i) : null);
          const now = o.now || (() => Date.now());
          const h = web.builder(doc);
          let stopped = false, card = null, looker = null, current = null, items = [], backoff = o.backoffMs || BACKOFF_MS, waitingUntil = 0;
          const queue = web.createQueue({ everyMs: o.everyMs || EVERY_MS, now });
          const asked = new Set();

          let currency = null;
          try { const w = win.g_rgWalletInfo; if (w && Number(w.wallet_currency) > 0) currency = Number(w.wallet_currency); } catch (e) { }
          const storeKey = 'arkada.inventory.prices.' + currency;
          // { key: [at, price, text] } — one entry per kind of item, the oldest dropped past MAX_KEPT
          let kept = {};
          try { const v = JSON.parse((storage && storage.getItem(storeKey)) || '{}'); if (v && typeof v === 'object') kept = v; } catch (e) { }
          function remember(key, price, text) {
            kept[key] = [now(), price, text];
            const keys = Object.keys(kept);
            if (keys.length > MAX_KEPT) keys.sort((a, b) => kept[a][0] - kept[b][0]).slice(0, keys.length - MAX_KEPT).forEach(k => delete kept[k]);
            try { if (storage) storage.setItem(storeKey, JSON.stringify(kept)); } catch (e) { }
          }
          const fresh = key => kept[key] && now() - kept[key][0] < CACHE_MS ? kept[key] : null;

          function badge(item) {
            const p = fresh(item.key);
            const el = item.element;
            if (!p || p[1] == null || !el || typeof el.querySelector !== 'function') return;
            let b = el.querySelector('.arkada-inv-price');
            if (!b) { b = doc.createElement('span'); b.className = 'arkada-inv-price'; el.appendChild(b); }
            if (b.textContent !== p[2]) b.textContent = p[2];
          }

          function draw() {
            if (stopped) return;
            const kinds = new Set(items.map(i => i.key));
            let sum = 0, priced = 0, sample = '', none = 0;
            const done = new Set();
            for (const it of items) {
              const p = fresh(it.key);
              if (!p) continue;
              if (p[1] == null) { if (!done.has(it.key)) none++; done.add(it.key); continue; }
              sum += p[1] * it.amount;
              if (!sample) sample = p[2];
              if (!done.has(it.key)) priced++;
              done.add(it.key);
            }
            const left = kinds.size - done.size;
            const box = h('div', 'arkada-card');
            box.id = ID;
            box.setAttribute('role', 'region');
            box.setAttribute('aria-label', 'Стоимость инвентаря');
            box.appendChild(h('div', 'arkada-card-head', h('span', 'arkada-card-title', 'Стоимость на Торговой площадке'),
              h('span', 'arkada-card-sub', items.length ? priced + ' из ' + kinds.size + ' ' + web.plural(kinds.size, 'вида', 'видов', 'видов') + ' оценено' : '')));
            if (!items.length) box.appendChild(h('div', 'arkada-card-hint', 'Здесь нет предметов, которые можно продать на Торговой площадке.'));
            else {
              box.appendChild(h('span', 'arkada-card-big', (left ? 'не меньше ' : '') + (sample ? web.formatLike(sample, sum) : '—')));
              if (left) {
                const mins = Math.ceil(left * (o.everyMs || EVERY_MS) / 60000);
                const wait = waitingUntil > now() ? ' Steam попросил подождать — продолжу через ' + Math.ceil((waitingUntil - now()) / 1000) + ' с.' : '';
                box.appendChild(h('div', 'arkada-card-hint', 'Ещё ' + left + ' — примерно ' + mins + ' мин: цены спрашиваются по одной, чтобы Steam не ограничил запросы.' + wait));
              }
              if (none) box.appendChild(h('div', 'arkada-card-sub', none + ' без предложений на продажу — не считаются.'));
            }
            box.appendChild(h('div', 'arkada-card-note', 'По самой низкой цене продажи на Торговой площадке Steam сейчас, без вычета комиссии; цены хранятся сутки. Считаются предметы открытой игры, которые можно продать и которые Steam уже загрузил на страницу (большой инвентарь он догружает по мере листания).'));
            web.ensureStyle(doc, o.tokens);
            const at = doc.getElementById('inventory_logos');
            if (card && card.parentNode) { card.parentNode.insertBefore(box, card); card.remove(); card = box; }
            else if (at && at.parentNode) { at.parentNode.insertBefore(box, at); card = box; }
          }

          function ask(item) {
            return async () => {
              if (stopped || fresh(item.key)) return;
              if (doc.hidden || doc.visibilityState === 'hidden') { asked.delete(item.key); queue.pause(LOOK_MS); return; }
              const url = '/market/priceoverview/?appid=' + encodeURIComponent(item.appid) + '&currency=' + currency + '&market_hash_name=' + encodeURIComponent(item.name);
              let r = null;
              try { r = await get(url, { credentials: 'include' }); } catch (e) { r = null; }
              if (stopped) return;
              if (r && r.status === 429) {
                asked.delete(item.key);
                waitingUntil = now() + backoff;
                queue.pause(backoff);
                backoff = Math.min(backoff * 2, 10 * 60 * 1000);
                queue.push(ask(item));
                asked.add(item.key);
                draw();
                return;
              }
              if (!r || !r.ok) { asked.delete(item.key); return; }
              backoff = o.backoffMs || BACKOFF_MS;
              let j = null;
              try { j = await r.json(); } catch (e) { j = null; }
              if (!j || !j.success) { remember(item.key, null, ''); draw(); return; }
              const text = String(j.lowest_price || j.median_price || '').trim();
              const price = web.parseMoney(text);
              remember(item.key, price, text);
              for (const it of items) if (it.key === item.key) badge(it);
              draw();
            };
          }

          function look() {
            if (stopped) return;
            let inv = null;
            try { inv = win.g_ActiveInventory || null; } catch (e) { }
            const list = itemsOf(inv);
            const sig = inv ? inv.appid + '_' + inv.contextid + '_' + list.length + '_' + list.filter(i => i.element).length : '';
            if (inv === current.inv && sig === current.sig) { if (!card || !card.isConnected) draw(); return; }
            current = { inv, sig };
            items = list;
            queue.clear();
            asked.clear();
            for (const it of items) {
              badge(it);
              if (!fresh(it.key) && !asked.has(it.key)) { asked.add(it.key); queue.push(ask(it)); }
            }
            draw();
          }

          const loc = win.location || {};
          if (String(loc.hostname).toLowerCase() === 'steamcommunity.com' && PAGE.test(String(loc.pathname || '')) && get && currency && !web.switchedOff(win, 'market')) {
            current = { inv: undefined, sig: null };
            look();
            looker = setInterval(look, o.lookMs || LOOK_MS);
          }

          return {
            items: () => items,
            stop() {
              if (stopped) return;
              stopped = true;
              queue.stop();
              if (looker) clearInterval(looker);
              looker = null;
              if (card) try { card.remove(); } catch (e) { }
              for (const b of doc.querySelectorAll('.arkada-inv-price')) try { b.remove(); } catch (e) { }
              web.dropStyle(doc);
            },
          };
        }

        module.exports = { createInventory, itemsOf, ID };
      },
      "./markethistory.js": function (module, exports, require) {
        // Arkada, the totals of the Community Market history (steamcommunity.com/market/history): how much you have
        // bought and sold on the market altogether, and how many times. Written for Arkada from what Augmented Steam
        // shows; no code taken from it.
        //
        // Runs in the history page itself (webkit.js): knows the page, not Steam.
        //   const m = createMarketHistory({ win, storage, fetch, tokens });   m.stop();
        //
        // Data: Steam's own market/myhistory/render (the history the page shows, as JSON with HTML rows), read
        // only when the user presses «Посчитать», PAGE_SIZE rows a request, one request at a time no sooner than
        // EVERY_MS after the previous one; 429 → waits BACKOFF_MS once, then stops. A row is a purchase when Steam
        // marks it «+», a sale when «−»; listings put up or taken down are not counted. The totals are kept a day in
        // the page's localStorage and shown at once next time, with «Пересчитать».
        //
        // Where: under the page's tabs (the link «История операций», a[href="history"]). The page is drawn by React:
        // a light timer (EVERY_MS, one isConnected check) puts the card back; no DOM watcher.
        'use strict';
        const web = require('./web.js');

        const ID = 'arkada-market-history';
        const KEY = 'arkada.market.history';
        const PAGE = /^\/market\/history\/?$/i;
        const PAGE_SIZE = 100;
        const EVERY_MS = 2000;
        const BACKOFF_MS = 60 * 1000;
        const MAX_ROWS = 20000;

        // One page of results_html → [{ sign: '+' | '-', text }]
        function rowsOf(html) {
          const out = [];
          const parts = String(html || '').split(/class="market_listing_row\b/).slice(1);
          for (const p of parts) {
            const g = /market_listing_gainorloss"\s*>\s*([+-])\s*</.exec(p);
            const price = /class="market_listing_price"\s*>\s*([^<]*?)\s*</.exec(p);
            if (!g || !price) continue;
            out.push({ sign: g[1], text: price[1].replace(/&nbsp;/g, ' ').trim() });
          }
          return out;
        }
        function totals(rows) {
          const t = { bought: 0, sold: 0, nBought: 0, nSold: 0, sample: '' };
          for (const r of rows) {
            const v = web.parseMoney(r.text);
            if (v == null) continue;
            if (!t.sample) t.sample = r.text;
            if (r.sign === '+') { t.bought += v; t.nBought++; } else { t.sold += v; t.nSold++; }
          }
          t.bought = Math.round(t.bought * 100) / 100;
          t.sold = Math.round(t.sold * 100) / 100;
          return t;
        }

        function createMarketHistory(o) {
          const win = o.win, doc = win.document;
          const get = o.fetch || (typeof win.fetch === 'function' ? (u, i) => win.fetch(u, i) : null);
          const now = o.now || (() => Date.now());
          const cache = web.createCache(o.storage || null, '', now);
          const h = web.builder(doc);
          const wait = ms => new Promise(r => setTimeout(r, ms));
          const path = String(win.location && win.location.pathname || '');
          let stopped = false, card = null, timer = null, busy = false;
          let state = { result: cache.get(KEY, 24 * 60 * 60 * 1000) || null, at: cache.at(KEY), progress: '', error: '' };

          async function page(start) {
            for (let attempt = 0; attempt < 2; attempt++) {
              const r = await get('/market/myhistory/render/?query=&start=' + start + '&count=' + PAGE_SIZE, { credentials: 'include' });
              if (r && r.status === 429 && attempt === 0) { state.progress = 'Steam попросил подождать — продолжу через минуту…'; draw(); await wait(o.backoffMs || BACKOFF_MS); continue; }
              if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status));
              const j = await r.json();
              if (!j || !j.success) throw new Error('no history');
              return j;
            }
            throw new Error('429');
          }

          async function count() {
            if (busy || stopped) return;
            busy = true;
            state.error = '';
            const rows = [];
            try {
              let start = 0, total = Infinity;
              while (start < total && start < MAX_ROWS && !stopped) {
                if (start > 0) await wait(o.everyMs || EVERY_MS);
                state.progress = 'Читаю историю: ' + start + (isFinite(total) ? ' из ' + total : '') + '…';
                draw();
                const j = await page(start);
                total = Number(j.total_count) || 0;
                const got = rowsOf(j.results_html);
                for (const r of got) rows.push(r);
                start += PAGE_SIZE;
                if (!String(j.results_html || '').includes('market_listing_row')) break;
              }
              if (stopped) return;
              state.result = Object.assign(totals(rows), { rows: total === Infinity ? rows.length : total });
              state.at = now();
              cache.set(KEY, state.result);
            } catch (e) {
              state.error = 'Не получилось прочитать историю (' + String(e && e.message || e) + '). Попробуйте позже.';
            }
            busy = false;
            state.progress = '';
            draw();
          }

          function build() {
            const box = h('div', 'arkada-card');
            box.id = ID;
            box.setAttribute('role', 'region');
            box.setAttribute('aria-label', 'Итоги истории операций');
            const btn = h('button', 'arkada-card-btn', busy ? 'Считаю…' : state.result ? 'Пересчитать' : 'Посчитать');
            btn.setAttribute('type', 'button');
            btn.disabled = busy;
            btn.addEventListener('click', () => { count(); });
            box.appendChild(h('div', 'arkada-card-head', h('span', 'arkada-card-title', 'Итоги истории'), btn));
            const r = state.result;
            if (r) {
              const money = v => web.formatLike(r.sample, v);
              const row = (cap, val) => h('div', 'arkada-card-row', h('span', 'arkada-card-cap', cap), h('span', 'arkada-card-val', val));
              box.appendChild(row('Куплено', money(r.bought) + ' · ' + r.nBought + ' ' + web.plural(r.nBought, 'покупка', 'покупки', 'покупок')));
              box.appendChild(row('Продано', money(r.sold) + ' · ' + r.nSold + ' ' + web.plural(r.nSold, 'продажа', 'продажи', 'продаж')));
              const diff = Math.round((r.sold - r.bought) * 100) / 100;
              box.appendChild(row('Продано минус куплено', money(diff)));
              let when = '';
              try { when = new Date(state.at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }); } catch (e) { }
              box.appendChild(h('div', 'arkada-card-note', 'Суммы — цены из вашей истории операций Steam, как она их показывает' + (when ? '; посчитано ' + when : '') + '.'));
            } else if (!state.progress) {
              box.appendChild(h('div', 'arkada-card-hint', 'Сколько вы купили и продали на Торговой площадке за всё время. Arkada прочитает историю операций — по 100 строк раз в 2 секунды.'));
            }
            if (state.progress) box.appendChild(h('div', 'arkada-card-sub', state.progress));
            if (state.error) box.appendChild(h('div', 'arkada-card-hint', state.error));
            return box;
          }

          function draw() {
            if (stopped) return;
            const box = build();
            if (card && card.parentNode) { card.parentNode.insertBefore(box, card); card.remove(); card = box; return; }
            card = box;
            place();
          }

          function place() {
            if (stopped || !card) return;
            if (String(win.location && win.location.pathname || '') !== path) { try { card.remove(); } catch (e) { } return; }
            if (card.isConnected) return;
            const tab = doc.querySelector('a[href="history"]');
            const bar = tab && tab.parentNode;
            if (!bar || !bar.parentNode) return;
            web.ensureStyle(doc, o.tokens);
            bar.parentNode.insertBefore(card, bar.nextSibling);
          }

          const loc = win.location || {};
          if (String(loc.hostname).toLowerCase() === 'steamcommunity.com' && PAGE.test(path) && get && !web.switchedOff(win, 'market')) {
            card = build();
            place();
            timer = setInterval(place, o.placeMs || EVERY_MS);
          }

          return {
            state: () => state,
            count,
            stop() {
              if (stopped) return;
              stopped = true;
              if (timer) clearInterval(timer);
              timer = null;
              if (card) try { card.remove(); } catch (e) { }
              web.dropStyle(doc);
            },
          };
        }

        module.exports = { createMarketHistory, rowsOf, totals, ID };
      },
      "./tokens.js": function (module, exports, require) {
        // Written by build.js from theme/tokens.css (the --dt-… tokens of kit.txt). Do not edit by hand.
        module.exports = {
          "base": "--dt-brand: #F08A4B; --dt-blue: #0A84FF; --dt-green: #6CCB5F; --dt-red: #C42B1C; --dt-orange: #FF9F0A; --dt-yellow: #FCE100; --dt-purple: #8A5CF6; --dt-pink: #FF375F; --dt-accent: var(--dt-blue); --dt-radius-block: 8px; --dt-radius-row: 4px; --dt-radius-control: 4px; --dt-radius-tip: 4px; --dt-font-text: 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif; --dt-font-display: 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif; --dt-font-mono: 'Cascadia Mono', 'Consolas', monospace; --dt-size-display: 28px; --dt-size-title: 20px; --dt-size-heading: 14px; --dt-size-body: 14px; --dt-size-caption: 12px; --dt-size-micro: 12px; --dt-ease-out: cubic-bezier(0, 0, 0, 1); --dt-dur-press: 83ms; --dt-dur-fast: 167ms; --dt-dur-base: 250ms; --dt-dur-slow: 333ms; --dt-dur-reveal: 500ms; --dt-bg: #202020; --dt-surface: #272727; --dt-raised: #2C2C2C; --dt-label: #FFFFFF; --dt-label-2: rgb(255 255 255 / 0.786); --dt-label-3: rgb(255 255 255 / 0.544); --dt-separator: rgb(255 255 255 / 0.0837); --dt-fill: rgb(255 255 255 / 0.0605); --dt-fill-2: rgb(255 255 255 / 0.0837); --dt-fill-press: rgb(255 255 255 / 0.0326); --dt-edge: rgb(255 255 255 / 0.0698); --dt-edge-top: rgb(255 255 255 / 0.093); --dt-menu: rgb(44 44 44 / 0.96); --dt-tooltip: #2C2C2C; --dt-glass: linear-gradient(180deg, rgb(255 255 255 / 0.0605), rgb(255 255 255 / 0.0605)); --dt-glass-hover: linear-gradient(180deg, rgb(255 255 255 / 0.0837), rgb(255 255 255 / 0.0837)); --dt-glass-strong: linear-gradient(180deg, rgb(255 255 255 / 0.0512), rgb(255 255 255 / 0.0512)); --dt-rim: linear-gradient(145deg, rgb(255 255 255 / 0.093) 0%, rgb(255 255 255 / 0.0698) 100%);",
          "reduced": "--dt-dur-press: 0ms; --dt-dur-fast: 0ms; --dt-dur-base: 0ms; --dt-dur-slow: 0ms; --dt-dur-reveal: 0ms;"
        };
      },
      "./webkit.js": function (module, exports, require) {
        // Arkada plugin for Millennium: the entry point of its webkit script, which Millennium runs in the pages of
        // the Steam store and community (.millennium/Dist/webkit.js, built by build.js). Each feature is a module
        // that does something only on its own pages (by the address) and only while its theme setting is on (the
        // page reads --arkada-<feature> on its <html>, web.js):
        //   store.steampowered.com
        //     /app/<id>          «Поделиться» (share.js: the friends and the sending go through the plugin's part in
        //                        the client, index.js arkadaShare), «Цены» (prices.js: SteamDB, IsThereAnyDeal through
        //                        the Lua backend), «Об игре» (gameinfo.js: your hours and the date from the client)
        //     /wishlist/…        the sum of the wishlist (wishlist.js, Steam's Web API)
        //     the store's lists  owned and ignored games hidden (hideowned.js, one style sheet)
        //   steamcommunity.com
        //     /id/<name>, /profiles/<id>   Dota 2 statistics (dota.js, api.opendota.com)
        //     …/inventory                  the market prices of the items (inventory.js, market/priceoverview)
        //     /market/history              the totals of the market history (markethistory.js, market/myhistory)
        'use strict';
        const { createShare } = require('./share.js');
        const { createDota } = require('./dota.js');
        const { createPrices } = require('./prices.js');
        const { createGameInfo } = require('./gameinfo.js');
        const { createHideOwned } = require('./hideowned.js');
        const { createWishlist } = require('./wishlist.js');
        const { createInventory } = require('./inventory.js');
        const { createMarketHistory } = require('./markethistory.js');

        const PLUGIN = 'arkada';
        const TOKENS = require('./tokens.js'); // the dev.txt tokens, written by build.js from theme/tokens.css
        const SLOT = '__arkada_share_stop__';
        const BACKEND_MS = 20000;

        // ('arkadaShare.friends', arg) → a Promise of the reply of that export of the client part. [K] the way the
        // Steam Share plugin on this PC reaches its own client part: MILLENNIUM_API.callable(plugin, "frontend:<name>")
        function bridge(win) {
          const fns = {};
          return (name, arg) => {
            const api = win.MILLENNIUM_API;
            if (!api || typeof api.callable !== 'function') return Promise.reject(new Error('no bridge'));
            const fn = fns[name] || (fns[name] = api.callable(PLUGIN, 'frontend:' + name));
            return Promise.resolve(arg === undefined ? fn() : fn(arg));
          };
        }
        // (method, args) → a Promise of the Lua backend's reply, or null: no backend, or no answer in BACKEND_MS.
        // [K] Millennium.callServerMethod is on the store pages too (seen on store.steampowered.com, Millennium's webkit API)
        function backend(win) {
          return (method, args) => new Promise(resolve => {
            let done = false;
            const finish = v => { if (!done) { done = true; clearTimeout(timer); resolve(v === undefined ? null : v); } };
            const timer = setTimeout(() => finish(null), BACKEND_MS);
            try {
              const m = win.Millennium;
              if (!m || typeof m.callServerMethod !== 'function') return finish(null);
              Promise.resolve(m.callServerMethod(PLUGIN, method, args)).then(finish, () => finish(null));
            } catch (e) { finish(null); }
          });
        }

        exports.default = async function () {
          try { if (typeof window[SLOT] === 'function') window[SLOT](); } catch (e) { }
          const host = String(window.location && window.location.hostname).toLowerCase();
          let storage = null;
          try { storage = window.localStorage; } catch (e) { /* closed: every visit asks again */ }
          const call = bridge(window);
          const makers = [];
          if (host === 'store.steampowered.com') {
            makers.push(
              () => createShare({ win: window, call: (method, arg) => call('arkadaShare.' + method, arg), tokens: TOKENS }),
              () => createGameInfo({ win: window, call, tokens: TOKENS }),
              () => createPrices({ win: window, server: backend(window), tokens: TOKENS }),
              () => createHideOwned({ win: window }),
              () => createWishlist({ win: window, storage, tokens: TOKENS }));
          } else if (host === 'steamcommunity.com') {
            makers.push(
              () => createDota({ win: window, storage, tokens: TOKENS }),
              () => createInventory({ win: window, storage, tokens: TOKENS }),
              () => createMarketHistory({ win: window, storage, tokens: TOKENS }));
          }
          const parts = [];
          for (const make of makers) try { parts.push(make()); } catch (e) { /* this feature cannot start here: the others still do */ }
          if (!parts.length) return;
          window[SLOT] = () => { window[SLOT] = null; for (const p of parts) try { p.stop(); } catch (e) { } };
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
    exports.default = load("./webkit.js").default;
    Object.defineProperty(exports, "__esModule", { value: !0 });
    return exports;
  }({}, window.MILLENNIUM_API);
};
(async () => {
  const e = PluginEntryPointMain();
  Object.assign(window.PLUGIN_LIST[pluginName], { ...e, __millennium_internal_plugin_name_do_not_use_or_change__: pluginName });
  const t = await e.default();
  t && void 0 !== t.title && void 0 !== t.icon && void 0 !== t.content && (window.MILLENNIUM_SIDEBAR_NAVIGATION_PANELS[pluginName] = t);
})();
