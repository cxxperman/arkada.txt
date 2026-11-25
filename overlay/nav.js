/*
 * Arkada over Steam Enhanced: a page change in the main window comes in the way a WinUI Frame
 * navigates (a short fade and rise), the moment Steam draws the new page. Nothing is held back.
 *
 * Loaded into every window by its own Patch (overlay/skin.json, TargetJs); does anything only in
 * the main window ("Steam"). Their files stay untouched.
 *
 * How. On a route change (Steam's router, below) the old page stays as Steam leaves it until
 * Steam mounts the new one: the first commit adding BIG elements under .MainPanel (measured: 60-200 ms
 * for a game page, ~300 ms for Home, which is Steam's own time). In that same MutationObserver
 * callback, before the frame is painted, <html data-arkada-nav="in"> starts the entrance
 * (overlay/win11.css: --dt-dur-fast, opacity and 6px). No waiting for the page to go quiet.
 *
 * A game page is different: Steam builds it for 1-2.5 s (the hero, then the sections from the
 * network). From the route change a skeleton of plates stands where its parts will be (a game
 * opened before: where they were, the cache below), the page under it is not drawn, and it comes in
 * one crossfade when it is ready: the hero drawn, the cover and description placed, the columns
 * still (or a timeout). Their layout (client/game-page/layout.js with patches/0007) keeps each
 * column a stack, so what grows later moves only the blocks under it: those slide (transform), the
 * grown block is uncovered with them (clip-path), a late block fades in rising 6px; see watchGame.
 *
 * Route changes come from Steam's own router (SteamUIStore.WindowStore.MainWindowInstance.m_history,
 * history v4's listen()), reached through window.opener like their core/runtime.js does. If it
 * is not there, nothing here runs and pages show as Steam draws them.
 *
 * Reduced motion (the hub's data-arkada-motion, the system setting, their "Animations: Reduced"):
 * no entrance, the skeleton gives way to the page at once, no moves animated.
 */
(() => {
  if (window.__arkadaNav || document.title !== 'Steam') return;
  window.__arkadaNav = true;
  // A copy of this script run again in the same window (a reload of the theme's scripts) takes over:
  // the older one stops acting on route changes
  const gen = (window.__arkadaNavGen = (window.__arkadaNavGen || 0) + 1);

  const MOUNT_MAX_MS = 1500; // a route that never draws a new page: stop looking
  const ENTER_MS = 250; // the entrance's run (--dt-dur-fast and a margin), then the attribute goes
  const BIG = 15; // elements added in one commit that make a page, not a ticker's update
  const root = document.documentElement;

  const reduced = () =>
    root.getAttribute('data-arkada-motion') === 'reduced' ||
    matchMedia('(prefers-reduced-motion: reduce)').matches ||
    !!document.querySelector('link[href*="motion-reduced.css"]');

  const findHistory = () => {
    const wins = [window];
    for (const k of ['opener', 'parent']) {
      try {
        if (window[k] && window[k] !== window) wins.push(window[k]);
      } catch {}
    }
    for (const w of wins) {
      try {
        const h = w.SteamUIStore?.WindowStore?.MainWindowInstance?.m_history;
        if (h && typeof h.listen === 'function') return h;
      } catch {}
    }
    return null;
  };

  // Their nodes and Steam's small live parts are not the new page: what Steam adds in one commit
  // under .MainPanel (or with a new .MainPanel: Downloads has none of its own) counts
  const OURS = /(?:^|\s)se-/;
  const added = (records) => {
    let n = 0;
    for (const r of records) {
      if (r.type !== 'childList') continue;
      const inPanel = r.target.closest?.('.MainPanel');
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1 || OURS.test(typeof node.className === 'string' ? node.className : '')) continue;
        if (!inPanel && !node.matches('.MainPanel') && !node.querySelector('.MainPanel')) continue;
        n += 1 + node.getElementsByTagName('*').length;
      }
    }
    return n;
  };

  let run = 0;
  let observer = null;
  let timers = [];
  let stopMoves = null;
  const clear = () => {
    observer?.disconnect();
    observer = null;
    timers.forEach(clearTimeout);
    timers = [];
    stopMoves?.();
    stopMoves = null;
  };

  const enter = (id) => {
    if (reduced()) return;
    root.setAttribute('data-arkada-nav', 'in');
    timers.push(setTimeout(() => id === run && root.removeAttribute('data-arkada-nav'), ENTER_MS));
  };

  /* ---------- A game page: a skeleton at once, the page in one crossfade, later moves slide ---------- */

  // The page's grid (ColumnContainer's Container) and the boxes their layout.css dissolves with
  // display: contents (ColumnContainer, RightColumn, LeftColumn, AppGameInfoContainer,
  // ConciseContainer, InnerContainer): their children are the grid's blocks.
  const GRID = '.MainPanel ._27RcNu8aXKBpYkHcNNrt-X';
  const WRAPS = '.OhSdLYuggDtBcWjYP0j_9, ._2aor4XVOYzN1PBSREk0UbO, ._1sZgBDTw5NH-yuVDZK1SUU, ._25oBZpa3dUcMw8QAsa2u67, ._2jPMy2QZr8bWi6yrk5ZzHA, ._37mmOlZM_8n5yJAG5CHiW7';
  const HERO = '.MainPanel ._2gZXhRmKUk68pA28-5ZmGQ'; // Header
  const HERO_ART = 'img.HNbe3eZf6H7dtJ042x1vM:not(.ImgBlur)'; // its artwork (ImgSrc, not the blurred copies)
  const NO_ART = '._1amMH3zqcKV3WYkLKNId8R'; // TopCapsule without artwork
  const BAR = '.MainPanel ._3Yf8b2v5oOD8Wqsxu04ar._1U7LKpx70kEsz3jJwAFOi-'; // play bar, in page
  const LINKS = '.MainPanel ._3-V8vjmrwuJM6Ws3tsjFJj'; // the page's tabs
  const SKEL = 'arkada-skel';
  // The cover and the description: Steam mounts them ~1 s in, at the top of their columns, after
  // sections under them (a page shown without them would move every block of both columns)
  const FIRST = ['._1Id6ZFEUVa5PKEMIvSg4nE', '._2AMl0koRXkR77BaY7Sa3Ie'];
  // For a remembered game their rows are held (patches/0007, --se-hold-<column>: "rows:order") and
  // the page is shown without waiting for them: [kinds at the top of the column, the order after them]
  const HELD = [
    [['_1Id6ZFEUVa5PKEMIvSg4nE', '_3cntzF30xAuwn1ARWJjvCb'], 12], // cover, facts
    [['notice', '_2AMl0koRXkR77BaY7Sa3Ie', 'nkIX48cHLbjc0eaP5CNmM', '_11kuVRYZvWXn-3rBJ_6yL8'], 23], // notice, description, tags, events
  ];
  const LIFT = 6; // px a late block rises as it fades in
  const BLEED = 64; // px a block's clip leaves around it while it grows (the cover's shadow)
  const STILL_MS = 120; // nothing on the first screen has moved for this long: the page is ready
  const SETTLED_MS = 250; // ...a remembered block of another height counts as come after this long
  const WAIT_NEW_MS = 1500; // shown by then whatever it is: a game not opened before
  const WAIT_KNOWN_MS = 2000; // ...a game whose layout is remembered (its blocks usually all came well before)
  const SETTLE_MS = 1500; // no block changed for this long: the layout is saved
  const CACHE_KEY = 'arkada.gamePage.v4';
  const CACHE_MAX = 100; // games remembered; the one opened longest ago goes first
  const span = (el) => el.style.getPropertyValue('--se-span');
  const rowOf = (el) => el.style.getPropertyValue('--se-row');
  const fromStyle = (style, name) => (String(style || '').match(new RegExp(name + ':\\s*(\\d+)')) || [])[1] || '';
  // A piece of the grid: a child of the grid or of a box it dissolves
  const pieceOf = (el, grid) => {
    const p = el.parentElement;
    return !!p && (p === grid || p.matches(WRAPS)) && !el.matches(WRAPS);
  };
  // Which block a node is, across Steam re-creating it and across visits: their section name,
  // else Steam's first class
  const kindOf = (el) => el.getAttribute('data-se-sec') || el.classList[0] || el.tagName;
  const piecesIn = (box, out = []) => {
    for (const el of box.children) {
      if (el.matches(WRAPS)) piecesIn(el, out);
      else out.push(el);
    }
    return out;
  };
  // Blocks their layout has placed (layout.js fit(): --se-row, --se-span)
  const blocksOf = (grid) => piecesIn(grid).filter((el) => span(el) !== '' && rowOf(el) !== '');

  /*
   * Per game: where its blocks were, relative to the page (.MainPanel), at the page width they
   * were saved at; and the page's frame (hero, play bar, tabs, columns), the same for every game
   * at a width. localStorage, the last CACHE_MAX games.
   */
  const cache = {
    all() {
      try {
        const o = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        if (o && Array.isArray(o.lru) && o.apps && typeof o.apps === 'object') return o;
      } catch {}
      return { lru: [], apps: {}, frame: null };
    },
    get(app) {
      return this.all().apps[app] || null;
    },
    frame() {
      return this.all().frame || null;
    },
    put(app, data, frame) {
      try {
        const o = this.all();
        o.apps[app] = data;
        o.frame = frame;
        o.lru = [app, ...o.lru.filter((a) => a !== app)];
        for (const gone of o.lru.splice(CACHE_MAX)) delete o.apps[gone];
        localStorage.setItem(CACHE_KEY, JSON.stringify(o));
      } catch {}
    },
  };

  const timing = () => {
    const cs = getComputedStyle(root);
    const ms = (name, fallback) => {
      const v = cs.getPropertyValue(name).trim();
      const n = parseFloat(v);
      return Number.isFinite(n) ? (/ms$/.test(v) ? n : n * 1000) : fallback;
    };
    return {
      move: ms('--dt-dur-base', 250),
      fade: ms('--dt-dur-fast', 167),
      show: ms('--dt-dur-fast', 167) + 33, // the page's one crossfade: ~200 ms
      easing: cs.getPropertyValue('--dt-ease-out').trim() || 'cubic-bezier(0, 0, 0, 1)',
    };
  };

  const rel = (el, base) => {
    const r = el.getBoundingClientRect();
    return [Math.round(r.left - base.left), Math.round(r.top - base.top), Math.round(r.width), Math.round(r.height)];
  };

  // The frame of a game page at a page width when none was saved: Steam's and their layout's sizes
  // (hero 1920:620 of the page, play bar over its lower edge, tabs, columns under them)
  const typicalFrame = (w) => {
    const inner = w - 10; // the page's scrollbar
    const hero = Math.round((inner * 620) / 1920);
    const pad = w < 1180 ? 16 : 32;
    const lw = Math.round(Math.min(333, Math.max(220, (inner - 2 * pad) * 0.26)));
    const gap = 20;
    return {
      w,
      hero: [0, 0, inner, hero],
      bar: [Math.round(inner / 2 - 420), hero - 52, 840, 75],
      links: [pad, hero + 27, inner - 2 * pad, 72],
      cols: [[pad, lw], [pad + lw + gap, inner - 2 * pad - lw - gap]],
      top: hero + 99,
    };
  };
  // A game not opened before: a cover and its facts on the left, a description and a few sections
  const typicalBlocks = (f) => {
    const [[lx, lw], [rx, rw]] = f.cols;
    const out = [];
    let y = f.top;
    for (const h of [Math.round(lw * 1.5), 168]) out.push([lx, y, lw, h]), (y += h + 16);
    y = f.top;
    for (const h of [68, 48, 180, 300]) out.push([rx, y, rw, h]), (y += h + 16);
    return out;
  };

  /*
   * The skeleton: from the route change (the same frame), plates where the page's parts will be,
   * over the page Steam is building, which is not drawn (html[data-arkada-gp="hold"],
   * overlay/win11.css). Plain WinUI plates, no shimmer.
   */
  let skel = null;
  const dropSkeleton = () => {
    skel?.remove();
    skel = null;
    root.removeAttribute('data-arkada-gp');
  };
  const showSkeleton = (app) => {
    dropSkeleton();
    const panel = document.querySelector('.MainPanel');
    if (!panel) return false;
    const p = panel.getBoundingClientRect();
    const w = Math.round(p.width);
    const fr = cache.frame();
    const f = fr && Math.abs(fr.w - w) <= 8 ? fr : typicalFrame(w);
    const saved = cache.get(app);
    const blocks = saved && Math.abs(saved.w - w) <= 8 && Array.isArray(saved.b) ? saved.b : typicalBlocks(f);
    const el = document.createElement('div');
    el.className = SKEL;
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = `left:${p.left}px;top:${p.top}px;width:${p.width}px;height:${p.height}px`;
    const plate = ([x, y, pw, ph], kind) => {
      if (!(pw > 0 && ph > 0) || y > p.height) return;
      const d = document.createElement('i');
      d.className = kind;
      d.style.cssText = `left:${x}px;top:${y}px;width:${pw}px;height:${ph}px`;
      el.append(d);
    };
    plate(f.hero, 'hero');
    plate(f.bar, 'bar');
    plate(f.links, 'links');
    for (const b of blocks) plate(b, '');
    document.body.append(el);
    skel = el;
    root.setAttribute('data-arkada-gp', 'hold');
    return !!saved && blocks === saved.b;
  };
  // The page comes in one crossfade over the skeleton
  const reveal = (id) => {
    if (id !== run || root.getAttribute('data-arkada-gp') !== 'hold') return;
    const T = timing();
    const el = skel;
    skel = null;
    if (reduced() || !el) {
      el?.remove();
      root.removeAttribute('data-arkada-gp');
      return;
    }
    root.setAttribute('data-arkada-gp', 'show');
    const out = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: T.show, easing: T.easing, fill: 'forwards' });
    out.onfinish = () => el.remove();
    timers.push(setTimeout(() => id === run && root.getAttribute('data-arkada-gp') === 'show' && root.removeAttribute('data-arkada-gp'), T.show + 50));
  };

  /*
   * Their layout (layout.js, patches/0007) stacks each column: a block's place is its first row
   * (--se-row, rows of 1px) and its height its span (--se-span), both in its style attribute and
   * written in the frame the block's size changed, before it is painted. While the page is held
   * under the skeleton this only says when the columns are still (ready); once it is shown, a
   * change of place is read off the attribute itself (old row minus new row, in px), with no
   * layout read, and animated in that same frame:
   *   - a block whose row changed slides from where it was drawn to its new place (transform);
   *   - a block whose span grew is uncovered downwards with the blocks under it (clip-path);
   *   - a block that gets its first place fades in rising LIFT px.
   * A change during a running one starts from where the block is drawn now: nothing accumulates.
   */
  const watchGame = (id, grid, app, known, since) => {
    const T = timing();
    const holding = () => root.getAttribute('data-arkada-gp') === 'hold';
    const motion = () => T.move > 0 && !reduced() && !holding();
    const slides = new WeakMap(); // block -> { anim, dy }
    const uncovers = new WeakMap(); // block -> { anim, d }
    const seen = new Set(); // kinds of block shown on this page (a node Steam makes anew comes in place)
    let lastMove = performance.now();
    let lastSeenMove = lastMove;
    let top = null;
    const gridTop = () => {
      if (top == null) {
        const p = grid.closest('.MainPanel');
        top = p ? grid.getBoundingClientRect().top - p.getBoundingClientRect().top : 0;
      }
      return top;
    };
    let saveTimer = 0;
    let readyTimer = 0;
    const saved = known ? cache.get(app) : null;
    const screen = grid.closest('.MainPanel')?.clientHeight || innerHeight; // the first screen's bottom
    const heldKinds = new Set();
    if (saved) {
      HELD.forEach(([kinds, order], col) => {
        const rows = saved.b.filter((b) => kinds.includes(b[4])).reduce((n, b) => n + Math.ceil(b[3] + 16), 0);
        if (rows > 0) grid.style.setProperty('--se-hold-' + col, rows + ':' + order);
        kinds.forEach((k) => heldKinds.add(k));
      });
    }

    const left = (map, el, key) => {
      const m = map.get(el);
      if (!m) return 0;
      const p = m.anim.effect?.getComputedTiming?.().progress;
      if (m.anim.playState !== 'running' || p == null) return 0;
      return m[key] * (1 - p);
    };
    const slide = (el, dy) => {
      dy += left(slides, el, 'dy');
      slides.get(el)?.anim.cancel();
      if (Math.abs(dy) < 1) return;
      const anim = el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], {
        duration: T.move,
        easing: T.easing,
        composite: 'add',
      });
      slides.set(el, { anim, dy });
      anim.onfinish = anim.oncancel = () => slides.get(el)?.anim === anim && slides.delete(el);
    };
    const uncover = (el, d) => {
      d += left(uncovers, el, 'd');
      uncovers.get(el)?.anim.cancel();
      if (d < 1) return;
      const anim = el.animate(
        [{ clipPath: `inset(-${BLEED}px -${BLEED}px ${d}px -${BLEED}px)` }, { clipPath: `inset(-${BLEED}px)` }],
        { duration: T.move, easing: T.easing }
      );
      uncovers.set(el, { anim, d });
      anim.onfinish = anim.oncancel = () => uncovers.get(el)?.anim === anim && uncovers.delete(el);
    };
    const fadeIn = (el) => {
      el.animate(
        [{ opacity: 0, transform: `translateY(${LIFT}px)` }, { opacity: 1, transform: 'none' }],
        { duration: T.fade, easing: T.easing, fill: 'backwards', composite: 'add' }
      );
    };

    // leaving: the route has already changed (run moved on) but the page is still there
    const save = (leaving = false) => {
      saveTimer = 0;
      if (!app || (!leaving && id !== run) || !grid.isConnected || holding()) return;
      const panel = grid.closest('.MainPanel');
      if (!panel) return;
      const p = panel.getBoundingClientRect();
      const scroller = grid.closest('.Body') || grid.parentElement;
      const dy = scroller?.scrollTop || 0;
      const at = (el) => {
        const r = rel(el, p);
        r[1] += dy;
        return r;
      };
      const b = [];
      for (const el of blocksOf(grid)) {
        const r = at(el);
        if (r[2] > 0 && r[3] > 0) b.push([...r, kindOf(el)]);
      }
      const hero = document.querySelector(HERO);
      const bar = document.querySelector(BAR);
      const links = document.querySelector(LINKS);
      if (!b.length || !hero || !bar || !links) return;
      const w = Math.round(p.width);
      const t = typicalFrame(w);
      const frame = { ...t, hero: at(hero), bar: at(bar), links: at(links) };
      // Leaving mid-scroll the hero's box is still where it is in the page: dy counted above
      cache.put(app, { w, b }, frame);
    };

    // Ready: the hero's artwork is drawn (or it has none), the columns have blocks and have not
    // moved for STILL_MS, and a remembered game has its remembered blocks; or the wait is over
    const heroReady = () => {
      const h = document.querySelector(HERO);
      if (!h) return false;
      if (h.querySelector(NO_ART)) return true;
      // This game's artwork (Steam's URLs name the app), not the last game's still on the page
      const img = [...h.querySelectorAll(HERO_ART)].find((i) => !/\/apps\/\d+\//.test(i.src) || i.src.includes('/apps/' + app + '/'));
      return !!img && img.complete && img.naturalWidth > 0;
    };
    const check = () => {
      readyTimer = 0;
      if (id !== run || !holding()) return;
      const now = performance.now();
      const here = blocksOf(grid);
      const n = here.length;
      const placed = (sel) => [...grid.querySelectorAll(sel)].some((el) => rowOf(el) !== '');
      // A remembered game: every block it had on the first screen is placed and as tall as it was
      // (Steam fills them from the network); what is under the screen may still grow after the
      // page is shown: it moves only what is under it. A new game: its cover and description are
      // placed and the columns are still
      // A block that runs past the screen's bottom needs only to fill the screen: its growth
      // under it moves nothing on screen. A block whose content is not what was remembered (a
      // feed, new events) counts once nothing on screen has moved for SETTLED_MS
      const tall = new Map(here.map((el) => [kindOf(el), parseInt(span(el), 10) - 16]));
      const near = (b) => {
        if (!tall.has(b[4])) return false;
        const h = tall.get(b[4]);
        if (b[1] + b[3] > screen) return h >= screen - b[1] - 6;
        return Math.abs(h - b[3]) <= Math.max(6, b[3] * 0.05) || now - lastSeenMove >= SETTLED_MS;
      };
      const full = saved
        ? saved.b.every((b) => !b[4] || b[1] >= screen || heldKinds.has(b[4]) || near(b))
        : FIRST.every(placed);
      const still = saved || now - lastSeenMove >= STILL_MS;
      const due = now - since >= (known ? WAIT_KNOWN_MS : WAIT_NEW_MS);
      if (due || (heroReady() && n >= 2 && full && still)) {
        for (const el of blocksOf(grid)) seen.add(kindOf(el));
        reveal(id);
        return;
      }
      readyTimer = setTimeout(check, 30);
    };

    const changed = (records) => {
      if (id !== run) return stop();
      const was = new Map(); // each block's style before this batch (the first record's old value)
      for (const r of records) {
        const el = r.target;
        if (el.nodeType !== 1 || was.has(el) || !pieceOf(el, grid)) continue;
        was.set(el, r.oldValue);
      }
      const animate = motion();
      for (const [el, old] of was) {
        const s0 = fromStyle(old, '--se-span');
        const s1 = span(el);
        const r0 = fromStyle(old, '--se-row');
        const r1 = rowOf(el);
        if (s0 === s1 && r0 === r1) continue;
        lastMove = performance.now();
        // On the first screen (rows count from the grid's top): what the page will show
        if (Math.min(Number(r0) || 1e9, Number(r1) || 1e9) + gridTop() < screen) lastSeenMove = lastMove;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, SETTLE_MS);
        if (!s1 || !r1) continue;
        if (!s0 || !r0) {
          // Placed for the first time; a block of a kind already shown (Steam made its node anew)
          // comes in place
          const k = kindOf(el);
          if (seen.has(k)) continue;
          seen.add(k);
          if (animate) fadeIn(el);
          continue;
        }
        if (!animate) continue;
        if (r0 !== r1) slide(el, Number(r0) - Number(r1));
        if (Number(s1) > Number(s0)) uncover(el, Number(s1) - Number(s0));
      }
    };

    const mo = new MutationObserver(changed);
    function stop() {
      mo.disconnect();
      clearTimeout(readyTimer);
      if (saveTimer) {
        clearTimeout(saveTimer);
        save(true); // leaving the page: what is there now is this game's layout
      }
    }
    mo.observe(grid, { attributes: true, subtree: true, attributeOldValue: true, attributeFilter: ['style'] });
    if (holding()) check();
    else for (const el of blocksOf(grid)) seen.add(kindOf(el));
    saveTimer = setTimeout(save, SETTLE_MS);
    return stop;
  };

  // The grid may come a commit after the page: look for it in each commit until it is there
  const watchGamePage = (id, app, known, since) => {
    const before = new Set(document.querySelectorAll(GRID)); // the page being left (one game for another)
    const start = () => {
      // The new page's grid; the old one only if Steam keeps it for the new game
      const grids = [...document.querySelectorAll(GRID)];
      const fresh = grids.filter((x) => !before.has(x));
      const grid = fresh.pop() || (performance.now() - since > 300 ? grids.pop() : null);
      if (!grid) return false;
      stopMoves = watchGame(id, grid, app, known, since);
      return true;
    };
    if (start()) return;
    const wait = new MutationObserver(() => {
      if (id !== run) return wait.disconnect();
      if (start()) wait.disconnect();
    });
    wait.observe(document.body, { childList: true, subtree: true });
    if (before.size) timers.push(setTimeout(() => id === run && start() && wait.disconnect(), 320));
    const prev = stopMoves;
    stopMoves = () => {
      wait.disconnect();
      prev?.();
    };
    timers.push(
      setTimeout(() => {
        if (id !== run || document.querySelector(GRID)) return;
        wait.disconnect();
        reveal(id); // no game page came: show what there is
      }, MOUNT_MAX_MS)
    );
  };

  const navigate = (path) => {
    const id = ++run;
    clear();
    root.removeAttribute('data-arkada-nav');
    const game = /^\/library\/app\/(\d+)/.exec(path);
    const since = performance.now();
    if (game) {
      // The old page goes and the skeleton is there in this frame; the page comes when ready
      const known = showSkeleton(game[1]);
      watchGamePage(id, game[1], known, since);
      return;
    }
    dropSkeleton();
    let mounted = false;
    observer = new MutationObserver((records) => {
      if (id !== run) return;
      if (!mounted) {
        if (added(records) < BIG) return;
        mounted = true;
        enter(id);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    timers.push(setTimeout(() => id === run && !mounted && observer?.disconnect(), MOUNT_MAX_MS));
  };

  /* ---------- Warming a game page before it is opened ---------- */

  /*
   * What a game page waits for on its first open is Steam's app details (libraryAssets, the
   * description, achievements, associations) and its pictures (hero, logo, cover). Asked for
   * ahead, the page finds them ready:
   *   - when the pointer rests HOVER_MS on a game (the library's list, Home's shelves, a
   *     collection): that game;
   *   - IDLE_DELAY_MS after the window comes up, while it is idle: the games played last, one by
   *     one with a pause.
   * One game at a time; a game is warmed once a session; the pictures are decoded (new Image()),
   * a hover that leaves before HOVER_MS asks nothing.
   */
  const HOVER_MS = 100;
  const IDLE_DELAY_MS = 5000;
  const IDLE_GAMES = 15;
  const IDLE_PAUSE_MS = 700;
  const warmed = new Set();
  let warming = null; // the appid being warmed now
  const stores = () => {
    const w = window.opener || window;
    return { details: w.appDetailsStore, apps: w.appStore, collections: w.collectionStore };
  };
  const decode = (url) =>
    new Promise((done) => {
      if (!url) return done();
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      img.decode().then(done, done);
    });
  const urls = (list) => (Array.isArray(list) ? list : list ? [list] : []).filter((u) => typeof u === 'string');
  const warm = async (appid) => {
    appid = Number(appid);
    if (!(appid > 0) || warmed.has(appid) || warming === appid) return;
    const { details, apps } = stores();
    const ov = apps?.GetAppOverviewByAppID?.(appid);
    if (!details || !ov) return;
    warmed.add(appid);
    warming = appid;
    try {
      for (const ask of ['RequestDescriptionsData', 'RequestAssociationData', 'RequestAchievements']) {
        // Steam's asks are async and some reject (RequestAchievements on a game with no data
        // yet reads `.achievements` of null): a rejection is caught here, not left unhandled
        try {
          const p = details[ask]?.(appid);
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch {}
      }
      await Promise.race([details.RequestAppDetails(appid), new Promise((r) => setTimeout(r, 2000))]);
      const pick = (fn, ...a) => {
        try {
          return fn.apply(apps, a);
        } catch {
          return null;
        }
      };
      const hero = details.GetHeroImagesForAppId?.(appid)?.rgHeroImages;
      const logo = details.GetLogoImagesForAppId?.(appid)?.rgLogoImages;
      // Each list: the URLs Steam tries in turn (a cached copy first); the page shows the first
      // that loads, so the first of each is enough
      const lists = [
        urls(pick(apps.GetCustomHeroImageURLs, ov)),
        urls(hero),
        urls(pick(apps.GetCustomLogoImageURLs, ov)),
        urls(logo),
        urls(pick(apps.GetCustomVerticalCapsuleURLs, ov)),
        urls(pick(apps.GetVerticalCapsuleURLForApp, ov)),
      ];
      await Promise.all(lists.map((l) => decode(l[0])));
    } catch {}
    if (warming === appid) warming = null;
  };
  // The game a node stands for: the props Steam's list rows, capsules and play bars carry
  const appOf = (node) => {
    for (let el = node, i = 0; el && el.nodeType === 1 && i < 4; el = el.parentElement, i++) {
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      if (!key) continue;
      for (let f = el[key], d = 0; f && d < 6; f = f.return, d++) {
        const p = f.memoizedProps;
        if (!p || typeof p !== 'object') continue;
        const id = p.app?.appid ?? p.item?.appid ?? p.overview?.appid ?? p.appid;
        if (typeof id === 'number' && id > 0) return id;
      }
      return 0;
    }
    return 0;
  };
  let hoverTimer = 0;
  let hoverApp = 0;
  const onOver = (e) => {
    const t = e.target;
    if (!(t instanceof Element) || !t.closest('.MainPanel, [class*="gamelist"], [class*="GameList"]')) return;
    const id = appOf(t);
    if (id === hoverApp) return;
    hoverApp = id;
    clearTimeout(hoverTimer);
    if (id && !warmed.has(id)) hoverTimer = setTimeout(() => hoverApp === id && warm(id), HOVER_MS);
  };
  document.addEventListener('pointerover', onOver, { passive: true });
  // A way to warm a game from outside (a test: "the pointer rested on it")
  window.__arkadaWarm = (appid) => warm(appid);

  const idleWarm = () => {
    const { collections } = stores();
    let list = [];
    try {
      const all = collections?.allGamesCollection?.allApps || [];
      list = [...all]
        .filter((a) => a && a.appid && a.rt_last_time_played)
        .sort((a, b) => b.rt_last_time_played - a.rt_last_time_played)
        .slice(0, IDLE_GAMES)
        .map((a) => a.appid);
    } catch {}
    const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 3000 }) : setTimeout(fn, 200));
    const next = () => {
      if (gen !== window.__arkadaNavGen) return;
      const id = list.shift();
      if (!id) return;
      // Not while a page is being built or shown under the skeleton
      if (root.hasAttribute('data-arkada-gp') || warming) {
        list.unshift(id);
        return setTimeout(() => idle(next), IDLE_PAUSE_MS);
      }
      warm(id).then(() => setTimeout(() => idle(next), IDLE_PAUSE_MS));
    };
    idle(next);
  };
  setTimeout(idleWarm, IDLE_DELAY_MS);

  let tries = 0;
  const hook = () => {
    const history = findHistory();
    if (!history) {
      if (++tries < 60) setTimeout(hook, 500); // Steam's store comes up after the window
      return;
    }
    let path = history.location?.pathname;
    history.listen((location) => {
      if (gen !== window.__arkadaNavGen) return;
      const next = location?.pathname ?? history.location?.pathname;
      if (!next || next === path) return; // same page (a tab inside it, a search): no entrance
      path = next;
      // Only library pages; others (the store's browser view) show as Steam draws them
      if (!/^\/library(\/|$)/.test(next)) {
        run++;
        clear();
        dropSkeleton();
        return;
      }
      navigate(next);
    });
  };
  hook();
})();
