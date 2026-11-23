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
