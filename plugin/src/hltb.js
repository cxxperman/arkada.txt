// Arkada, How Long To Beat: on a game's page in the library, how long the game takes to beat — main story,
// main story with extras, everything (100%) — from howlongtobeat.com. Instead of the HLTB for Steam plugin;
// the requests to HLTB, their cache and the name matching live in the Lua backend (plugin/backend/arkada_hltb.lua,
// based on that plugin's code, MIT).
//
//   const h = createHltb({ steam, pages });
//   h.stop();
//
// Two ways it is shown:
//   - with the Steam Enhanced theme (Arkada's theme is built on it), its own card «Время прохождения» on the
//     game's page draws the times: it asks the backend GetHltbData itself (compat/hltb-for-steam, which our
//     patches/0010 makes ask the plugin "arkada" first). This module then only switches the backend on;
//   - without it, one more stat in Steam's stats row, next to «Размер на диске», drawn with Steam's own classes
//     as disksize.js does: «Время прохождения» «12 ч · 20 ч · 35 ч», the names in its tooltip, a click opens
//     the game's page on howlongtobeat.com in the browser.
// The backend does nothing while the feature is off (HltbSetup { on: false }): no request leaves the PC.
//
// Cost: the page is watched only on a game's page (pages.js); each game is asked of the backend once per
// ASK_MS in this session (the backend keeps the answers on disk for days); nothing reads layout.
'use strict';

const ROUTE = /^\/library\/app\/(\d+)(?:\/|$)/;
const ATTR = 'data-arkada-hltb';
const ASK_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const WAIT_MS = 90000; // the backend may first have to find HLTB's endpoint: several requests
const NBSP = ' ';
const STAGES = [['comp_main', 'Основной сюжет'], ['comp_plus', 'Сюжет и дополнительное'], ['comp_100', 'Всё на 100%']];

// 6 → "6 ч", 6.7 → "6,7 ч", 123.4 → "123 ч"
function formatHours(h) {
  const n = Number(h);
  if (!isFinite(n) || n <= 0) return '';
  const s = n >= 100 ? String(Math.round(n)) : (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '').replace('.', ',');
  return s + NBSP + 'ч';
}

// The reply of GetHltbData (a JSON string, maybe wrapped once more by Millennium) → the times, or null
function timesOf(reply) {
  let r = reply;
  for (let i = 0; i < 3 && typeof r === 'string'; i++) { try { r = JSON.parse(r); } catch (e) { return null; } }
  if (!r || r.success !== true || !r.data || r.data.game_id == null) return null;
  const out = { gameId: r.data.game_id, name: String(r.data.game_name || ''), stages: [] };
  for (const [k, label] of STAGES) if (typeof r.data[k] === 'number' && r.data[k] > 0) out.stages.push({ label, hours: r.data[k] });
  return out.stages.length ? out : null;
}

function describe(t) {
  const lines = t.stages.map(s => s.label + ': ' + formatHours(s.hours));
  lines.push('По данным howlongtobeat.com' + (t.name ? ' («' + t.name + '»)' : '') + '. Нажмите, чтобы открыть страницу игры');
  return lines.join('\n');
}

const SVG = 'http://www.w3.org/2000/svg';
// A clock, drawn for Arkada in the stroke of Steam's stat icons (currentColor, 1.5 px at 24)
function clockIcon(doc) {
  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of [
    ['circle', { cx: '12', cy: '12', r: '8.25', stroke: 'currentColor', 'stroke-width': '1.5' }],
    ['path', { d: 'M12 7.5V12l3 2', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }],
  ]) {
    const el = doc.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

function createHltb(o) {
  const steam = o.steam, pages = o.pages;
  const now = o.now || (() => Date.now());
  const known = new Map(); // appId → { times, at, retryAt }
  const asking = new Set();
  let stopped = false, last = null;

  // The backend works only while the feature is on; the user's id lets HLTB match the library by its import
  const setup = on => Promise.resolve(steam.callBackend('HltbSetup', { on, steam_user_id: on ? steam.currentUserId() || '' : '' }, WAIT_MS)).catch(() => null);
  setup(true);

  function ask(appId) {
    if (asking.has(appId)) return;
    asking.add(appId);
    Promise.resolve(steam.callBackend('GetHltbData', { app_id: appId, fallback_name: steam.appName(appId) || '', force_refresh: false }, WAIT_MS))
      .then(r => r, () => null)
      .then(r => {
        asking.delete(appId);
        if (stopped) return;
        const t = r === null ? undefined : timesOf(r);
        if (t === undefined) known.set(appId, Object.assign(known.get(appId) || { times: null }, { at: 0, retryAt: now() + RETRY_MS })); // no answer: again in a minute
        else known.set(appId, { times: t, at: now(), retryAt: 0 });
        if (last) draw(last);
      });
  }

  function remove(doc) {
    try { for (const el of Array.from(doc.querySelectorAll('[' + ATTR + ']'))) el.remove(); } catch (e) { }
  }

  function build(doc, cls, appId, t) {
    const box = doc.createElement('div');
    box.className = [cls.GameStat, cls.LastPlayed, 'Panel'].filter(Boolean).join(' ');
    box.setAttribute(ATTR, appId + ':' + t.stages.map(s => s.hours).join('/'));
    box.setAttribute('role', 'link');
    box.setAttribute('tabindex', '0');
    box.title = describe(t);
    box.style.order = '2';
    box.style.cursor = 'pointer';
    const icon = doc.createElement('div');
    icon.className = [cls.GameStatIcon, cls.PlaytimeIcon].filter(Boolean).join(' ');
    icon.appendChild(clockIcon(doc));
    const right = doc.createElement('div');
    right.className = cls.GameStatRight || '';
    const label = doc.createElement('div');
    label.className = cls.PlayBarLabel || '';
    label.textContent = 'Время прохождения';
    const value = doc.createElement('div');
    value.className = [cls.PlayBarDetailLabel, cls.LastPlayedInfo].filter(Boolean).join(' ');
    value.textContent = t.stages.map(s => formatHours(s.hours)).join(' · ');
    right.appendChild(label);
    right.appendChild(value);
    box.appendChild(icon);
    box.appendChild(right);
    const open = e => { if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return; e.preventDefault(); steam.openInBrowser('https://howlongtobeat.com/game/' + encodeURIComponent(t.gameId)); };
    box.addEventListener('click', open);
    box.addEventListener('keydown', open);
    return box;
  }

  function draw(ctx) {
    const doc = ctx.doc, appId = Number(ctx.match[1]);
    // Steam Enhanced draws its own card with these times: nothing of ours on the page
    if (ctx.win && ctx.win.__seHltb) { if (doc.querySelector('[' + ATTR + ']')) remove(doc); return; }
    const cls = steam.classes('GameStatsSection');
    if (!cls || !cls.GameStatsSection) return;
    const section = doc.querySelector('.' + cls.GameStatsSection);
    if (!section) return;
    const k = known.get(appId), t = k && k.times;
    const key = t ? appId + ':' + t.stages.map(s => s.hours).join('/') : '';
    const here = section.querySelector('[' + ATTR + ']');
    if (here && here.getAttribute(ATTR) === key) return;
    remove(doc);
    if (key) section.appendChild(build(doc, cls, appId, t));
  }

  const off = pages.add({
    route: ROUTE,
    update(ctx) {
      if (stopped) return;
      last = ctx;
      const appId = Number(ctx.match[1]);
      if (!appId) return;
      if (!(ctx.win && ctx.win.__seHltb)) {
        const k = known.get(appId), t = now();
        if (!k || (k.retryAt ? t >= k.retryAt : t - k.at >= ASK_MS)) ask(appId);
      }
      draw(ctx);
    },
    leave(ctx) { last = null; if (ctx && ctx.doc) remove(ctx.doc); },
  });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try { off(); } catch (e) { }
      setup(false);
    },
  };
}

module.exports = { createHltb, formatHours, timesOf, describe, ROUTE, ATTR };
