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
