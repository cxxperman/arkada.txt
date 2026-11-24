// Arkada plugin for Millennium, version 0.2.2: the part Millennium runs in Steam's store pages.
// Built by plugin/build.js from plugin/src — do not edit by hand. Adds «Поделиться» to a game's page; nothing goes to the internet.
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
      "./tokens.js": function (module, exports, require) {
        // Written by build.js from theme/tokens.css (the --dt-… tokens of kit.txt). Do not edit by hand.
        module.exports = {
          "base": "--dt-brand: #F08A4B; --dt-blue: #0A84FF; --dt-green: #6CCB5F; --dt-red: #C42B1C; --dt-orange: #FF9F0A; --dt-yellow: #FCE100; --dt-purple: #8A5CF6; --dt-pink: #FF375F; --dt-accent: var(--dt-blue); --dt-radius-block: 8px; --dt-radius-row: 4px; --dt-radius-control: 4px; --dt-radius-tip: 4px; --dt-font-text: 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif; --dt-font-display: 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif; --dt-font-mono: 'Cascadia Mono', 'Consolas', monospace; --dt-size-display: 28px; --dt-size-title: 20px; --dt-size-heading: 14px; --dt-size-body: 14px; --dt-size-caption: 12px; --dt-size-micro: 12px; --dt-ease-out: cubic-bezier(0, 0, 0, 1); --dt-dur-press: 83ms; --dt-dur-fast: 167ms; --dt-dur-base: 250ms; --dt-dur-slow: 333ms; --dt-dur-reveal: 500ms; --dt-bg: #202020; --dt-surface: #272727; --dt-raised: #2C2C2C; --dt-label: #FFFFFF; --dt-label-2: rgb(255 255 255 / 0.786); --dt-label-3: rgb(255 255 255 / 0.544); --dt-separator: rgb(255 255 255 / 0.0837); --dt-fill: rgb(255 255 255 / 0.0605); --dt-fill-2: rgb(255 255 255 / 0.0837); --dt-fill-press: rgb(255 255 255 / 0.0326); --dt-edge: rgb(255 255 255 / 0.0698); --dt-edge-top: rgb(255 255 255 / 0.093); --dt-menu: rgb(44 44 44 / 0.96); --dt-tooltip: #2C2C2C; --dt-glass: linear-gradient(180deg, rgb(255 255 255 / 0.0605), rgb(255 255 255 / 0.0605)); --dt-glass-hover: linear-gradient(180deg, rgb(255 255 255 / 0.0837), rgb(255 255 255 / 0.0837)); --dt-glass-strong: linear-gradient(180deg, rgb(255 255 255 / 0.0512), rgb(255 255 255 / 0.0512)); --dt-rim: linear-gradient(145deg, rgb(255 255 255 / 0.093) 0%, rgb(255 255 255 / 0.0698) 100%);",
          "reduced": "--dt-dur-press: 0ms; --dt-dur-fast: 0ms; --dt-dur-base: 0ms; --dt-dur-slow: 0ms; --dt-dur-reveal: 0ms;"
        };
      },
      "./webkit.js": function (module, exports, require) {
        // Arkada plugin for Millennium: the entry point of its webkit script, which Millennium runs in the pages of
        // the Steam store and community (.millennium/Dist/webkit.js, built by build.js). Only «Поделиться» lives
        // here (share.js); it does anything only on a game's page of the store. Its friends list and messages go
        // through the plugin's part in the client (index.js, arkadaShare), reached with Millennium's callable.
        'use strict';
        const { createShare } = require('./share.js');

        const PLUGIN = 'arkada';
        const TOKENS = require('./tokens.js'); // the dev.txt tokens, written by build.js from theme/tokens.css
        const SLOT = '__arkada_share_stop__';

        // (method, arg) → a Promise of the reply of arkadaShare[method] in the client. [K] the way the Steam Share
        // plugin on this PC reaches its own client part: MILLENNIUM_API.callable(plugin, "frontend:<name>")
        function bridge(win) {
          const fns = {};
          return (method, arg) => {
            const api = win.MILLENNIUM_API;
            if (!api || typeof api.callable !== 'function') return Promise.reject(new Error('no bridge'));
            const fn = fns[method] || (fns[method] = api.callable(PLUGIN, 'frontend:arkadaShare.' + method));
            return Promise.resolve(arg === undefined ? fn() : fn(arg));
          };
        }

        exports.default = async function () {
          try { if (typeof window[SLOT] === 'function') window[SLOT](); } catch (e) { }
          if (!/^(store\.steampowered\.com)$/i.test(String(window.location && window.location.hostname))) return; // community pages: nothing to do
          const share = createShare({ win: window, call: bridge(window), tokens: TOKENS });
          window[SLOT] = () => { window[SLOT] = null; share.stop(); };
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
