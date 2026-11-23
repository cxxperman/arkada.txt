// Takes a snapshot of the CSS-module class maps of the Steam client. No dependencies.
//   node tools/steam-classes.js                  Steam folder from the registry (HKCU\Software\Valve\Steam, SteamPath)
//   node tools/steam-classes.js --steam <folder> that Steam folder
//   node tools/steam-classes.js [...] --out <f>  write there instead of ./steam-classes.json
//
// The client's scripts (<Steam>\steamui\*.js) carry one object per CSS module, like
//   12345:(e=>{e.exports={PlayBar:"_2L3s2nzh7yCnNESfI5_dN1",SuperNav:"_2D64jIEK7wpUR_NlObDW76",...}})
// The keys are the names Valve wrote in its source; the values are the hashed classes in the page.
// The snapshot keeps every such module (only its hashed entries), so the theme can be written with the
// names and built without Steam. tools/build.js resolves the names, tools/check.js --steam compares.
'use strict';
const fs = require('fs');
const path = require('path');

// ───────── Where Steam is ─────────
function steamFolder(args) {
  const at = args.indexOf('--steam');
  if (at >= 0 && args[at + 1] && !args[at + 1].startsWith('--')) return path.resolve(args[at + 1]);
  if (process.platform !== 'win32') throw new Error('Steam folder unknown: pass --steam <folder>');
  const { execFileSync } = require('child_process');
  let out;
  try { out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8' }); }
  catch (e) { throw new Error('Steam is not in the registry (HKCU\\Software\\Valve\\Steam, SteamPath): pass --steam <folder>'); }
  const m = /SteamPath\s+REG_SZ\s+(.+)/.exec(out);
  if (!m) throw new Error('SteamPath not found in the registry: pass --steam <folder>');
  return path.resolve(m[1].trim());
}

// A hashed class: what css-loader writes for a local name. Breakpoints ("1158px"), durations ("800ms")
// and other values that modules export next to the classes are left out.
const isHash = v => /^[A-Za-z0-9_-]{16,32}$/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v) && !/^\d+(px|ms|s|em|rem|%)?$/.test(v);

// Every `exports={…}` whose body is nothing but `key:"value"` pairs
function modulesIn(text) {
  const out = [];
  const head = /exports=\{/g;
  const pair = /^(?:([A-Za-z_$][\w$]*)|"((?:[^"\\]|\\.)*)"):"((?:[^"\\]|\\.)*)"(,|\})/;
  let m;
  while ((m = head.exec(text))) {
    let i = m.index + m[0].length;
    const map = {};
    let ok = true, n = 0;
    if (text[i] === '}') continue;
    for (;;) {
      const p = pair.exec(text.slice(i, i + 400));
      if (!p) { ok = false; break; }
      map[p[1] || p[2]] = p[3];
      n++;
      i += p[0].length;
      if (p[4] === '}') break;
    }
    if (!ok || !n) continue;
    const classes = {};
    for (const [k, v] of Object.entries(map)) if (isHash(v)) classes[k] = v;
    if (Object.keys(classes).length) out.push(classes);
    head.lastIndex = i;
  }
  return out;
}

function clientVersion(steam) {
  for (const f of ['steam_client_win64.manifest', 'steam_client_win32.manifest', 'steam_client_ubuntu12.manifest', 'steam_client_osx.manifest']) {
    const file = path.join(steam, 'package', f);
    if (!fs.existsSync(file)) continue;
    const m = /"version"\s+"(\d+)"/.exec(fs.readFileSync(file, 'utf8'));
    if (m) return { version: m[1], date: new Date(Number(m[1]) * 1000).toISOString().slice(0, 10), from: 'package/' + f };
  }
  return null;
}

function snapshot(steam) {
  const ui = path.join(steam, 'steamui');
  if (!fs.existsSync(ui)) throw new Error('no steamui folder in ' + steam);
  const files = fs.readdirSync(ui).filter(f => f.endsWith('.js')).sort();
  const seen = new Map(); // body → module
  for (const f of files) {
    for (const classes of modulesIn(fs.readFileSync(path.join(ui, f), 'utf8'))) {
      const sorted = {};
      for (const k of Object.keys(classes).sort()) sorted[k] = classes[k];
      const key = JSON.stringify(sorted);
      if (seen.has(key)) { const mod = seen.get(key); if (!mod.files.includes(f)) mod.files.push(f); }
      else seen.set(key, { files: [f], classes: sorted });
    }
  }
  // Stable order for a readable diff: by the module's keys, then its hashes
  const modules = [...seen.values()].sort((a, b) => {
    const ka = Object.keys(a.classes).join(','), kb = Object.keys(b.classes).join(',');
    return ka < kb ? -1 : ka > kb ? 1 : JSON.stringify(a.classes) < JSON.stringify(b.classes) ? -1 : 1;
  });
  return { client: clientVersion(steam), modules };
}
const pairsOf = snap => snap.modules.reduce((n, m) => n + Object.keys(m.classes).length, 0);

// One module per line: diffs show exactly which modules changed
function serialize(snap) {
  const lines = [
    '{',
    '  "about": "Class maps of the Steam client: readable name -> hashed class, one CSS module per line. Written by tools/steam-classes.js; do not edit by hand.",',
    '  "client": ' + JSON.stringify(snap.client) + ',',
    '  "count": ' + JSON.stringify({ modules: snap.modules.length, pairs: pairsOf(snap) }) + ',',
    '  "modules": [',
  ];
  snap.modules.forEach((m, i) => lines.push('    ' + JSON.stringify(m) + (i < snap.modules.length - 1 ? ',' : '')));
  lines.push('  ]', '}', '');
  return lines.join('\n');
}

module.exports = { steamFolder, snapshot, serialize, modulesIn };

if (require.main === module) {
  const args = process.argv.slice(2);
  try {
    const steam = steamFolder(args);
    const outAt = args.indexOf('--out');
    const out = outAt >= 0 ? path.resolve(args[outAt + 1]) : path.join(__dirname, '..', 'steam-classes.json');
    const snap = snapshot(steam);
    if (!snap.modules.length) throw new Error('no class maps found in ' + path.join(steam, 'steamui'));
    fs.writeFileSync(out, serialize(snap));
    console.log('Wrote ' + path.relative(process.cwd(), out) + ': ' + snap.modules.length + ' modules, ' + pairsOf(snap) + ' classes' +
      (snap.client ? ', client ' + snap.client.version + ' (' + snap.client.date + ')' : '') + ' from ' + steam);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
