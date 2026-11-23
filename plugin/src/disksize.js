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
