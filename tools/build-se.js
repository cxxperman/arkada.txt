// Builds dist/arkada: Steam Enhanced (upstream/steam-enhanced, untouched) with Arkada's layer (overlay/) on top.
// No dependencies.
//   node tools/build-se.js
// What goes in, in this order (a later file of the same name wins; the folder is emptied first):
//   upstream/steam-enhanced/**          as is, except skin.json (merged, below), LICENSE (→ LICENSE-steam-enhanced),
//                                       README.md and assets/ (their README pictures and branding art; nothing loads them);
//                                       then patches/*.patch applied to this copy (tools/patches.js; a patch that no
//                                       longer applies stops the build) and the menu bundles (menuBundles below)
//   arkada/tokens.css                   theme/tokens.css (the --dt-… tokens of kit.txt) + overlay/tokens.css (their --se-… tokens)
//   arkada/brand.css, arkada/options/*  from overlay/
//   arkada/options/accent-*.css         from theme/options (the "Акцент" setting, the same files the CSS theme uses)
//   THIRD_PARTY.md, LICENSE-steam-enhanced
//   skin.json                           their skin.json merged with overlay/skin.json (mergeSkin below)
// Same input, same output: files are copied in sorted order and JSON is written with fixed indentation.
'use strict';
const fs = require('fs');
const path = require('path');
const { applyAll } = require('./patches.js');

const root = path.join(__dirname, '..');
const up = path.join(root, 'upstream', 'steam-enhanced');
const overlay = path.join(root, 'overlay');
const out = path.join(root, 'dist', 'arkada');
const rel = p => path.relative(root, p).replace(/\\/g, '/');
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));

if (!fs.existsSync(path.join(up, 'skin.json'))) {
  console.error('Error: no upstream/steam-enhanced/skin.json. Fetch it first: node tools/upstream.js');
  process.exit(1);
}
const meta = readJson(path.join(root, 'upstream', 'steam-enhanced.json'));

// Upstream paths (forward slashes, relative to their repo) that are not copied.
const SKIP = [/^skin\.json$/, /^LICENSE$/, /^README\.md$/, /^assets(\/|$)/];

function copyTree(from, to, skip = [], r = '') {
  for (const f of fs.readdirSync(from).sort()) {
    const p = path.join(from, f), q = r ? r + '/' + f : f;
    if (skip.some(re => re.test(q))) continue;
    if (fs.statSync(p).isDirectory()) copyTree(p, path.join(to, f), skip, q);
    else { fs.mkdirSync(to, { recursive: true }); fs.copyFileSync(p, path.join(to, f)); }
  }
}

// ───────── skin.json ─────────
// overlay/skin.json over theirs:
//   a field          replaces theirs; null removes it (header_image, github…)
//   Patches          appended after theirs (theirs are kept: core/core.js and client/loader.js run the theme)
//   Conditions       by name: null removes one; a new one comes before theirs; one they have is merged field by
//                    field, and its values by name the same way (null removes a value, a new value comes first)
function mergeKeyed(base = {}, over = {}, mergeOne) {
  const res = {};
  for (const [k, v] of Object.entries(over)) if (!(k in base) && v !== null) res[k] = v;
  for (const [k, v] of Object.entries(base)) {
    if (!(k in over)) res[k] = v;
    else if (over[k] !== null) res[k] = mergeOne ? mergeOne(v, over[k]) : over[k];
  }
  return res;
}
function mergeCondition(base, over) {
  const res = Object.assign({}, base);
  for (const [k, v] of Object.entries(over)) {
    if (k === 'values') res.values = mergeKeyed(base.values, v);
    else if (v === null) delete res[k];
    else res[k] = v;
  }
  return res;
}
function mergeSkin(base, over) {
  const res = Object.assign({}, base);
  for (const [k, v] of Object.entries(over)) {
    if (k === 'Patches') res.Patches = (base.Patches || []).concat(v || []);
    else if (k === 'Conditions') res.Conditions = mergeKeyed(base.Conditions, v, mergeCondition);
    else if (v === null) delete res[k];
    else res[k] = v;
  }
  return res;
}

const ours = readJson(path.join(overlay, 'skin.json'));
const skin = mergeSkin(readJson(path.join(up, 'skin.json')), ours);
// Their web loader (core/core.js) versions every file it loads with skin.json's version, so it has to change
// whenever their code does: our version, plus theirs as build metadata.
const upVersion = /^[0-9a-f]{40}$/.test(meta.ref) ? meta.ref.slice(0, 7) : meta.ref;
skin.version = ours.version + '+se.' + upVersion;

// ───────── A menu window's stylesheets in one file (patches/0001-loader-menu-bundle.patch) ─────────
// The files their loader (client/loader.js, FEATURES) gives a menu window, in its order, once each:
// core/menu.bundle.css for the groups "all", core/menu-tray.bundle.css for "all" + "tray".
// The bundles sit in core/, so the only relative url() (core/font.css's fonts/…) still resolves;
// any other file with a relative url() or an @import would break that, and stops the build.
function menuBundles() {
  const loader = fs.readFileSync(path.join(out, 'client', 'loader.js'), 'utf8');
  const m = /const FEATURES = (\[[\s\S]*?\n  \]);/.exec(loader);
  let features = null;
  try { features = m && new Function('return ' + m[1])(); } catch (e) { features = null; }
  if (!Array.isArray(features)) { console.error('Error: cannot read FEATURES from their client/loader.js: update menuBundles() in tools/build-se.js'); process.exit(1); }
  const bundles = { 'core/menu.bundle.css': ['all'], 'core/menu-tray.bundle.css': ['all', 'tray'] };
  for (const [name, groups] of Object.entries(bundles)) {
    const seen = new Set(), parts = [];
    for (const [group, folder, files] of features) {
      if (!groups.includes(group)) continue;
      for (const f of files) {
        const file = folder + f;
        if (!file.endsWith('.css') || seen.has(file)) continue;
        seen.add(file);
        const css = fs.readFileSync(path.join(out, file), 'utf8');
        const bad = /@import/.test(css) || (!file.startsWith('core/') && /url\(\s*(?!['"]?(?:data:|https?:|#))/.test(css));
        if (bad) { console.error('Error: ' + file + ' has an @import or a relative url(): it cannot go into ' + name + ' as it is (tools/build-se.js, menuBundles)'); process.exit(1); }
        parts.push('/* ' + file + ' */\n' + css.replace(/\s*$/, '\n'));
      }
    }
    fs.writeFileSync(path.join(out, name), '/* Built by Arkada (tools/build-se.js) from the files client/loader.js gives a menu window, in its order. */\n' + parts.join('\n'));
  }
}

// ───────── write ─────────
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
copyTree(up, out, SKIP);
// Our patches to their code (patches/*.patch, tools/patches.js), on the copy: upstream/ stays as they wrote it
let patched = [];
try { patched = applyAll(out); } catch (e) {
  console.error('Error: ' + e.message + '\n  Steam Enhanced changed under a patch of ours: update the patch in patches/ for their new code (or drop it if they fixed it).');
  process.exit(1);
}
menuBundles();
fs.copyFileSync(path.join(up, 'LICENSE'), path.join(out, 'LICENSE-steam-enhanced'));
fs.copyFileSync(path.join(root, 'THIRD_PARTY.md'), path.join(out, 'THIRD_PARTY.md'));

const mine = path.join(out, 'arkada');
copyTree(overlay, mine, [/^skin\.json$/, /^tokens\.css$/]);
const options = path.join(root, 'theme', 'options');
for (const f of fs.readdirSync(options).sort())
  if (/^accent-.*\.css$/.test(f)) { fs.mkdirSync(path.join(mine, 'options'), { recursive: true }); fs.copyFileSync(path.join(options, f), path.join(mine, 'options', f)); }
fs.writeFileSync(path.join(mine, 'tokens.css'),
  `/* Сгенерировано tools/build-se.js из theme/tokens.css и overlay/tokens.css. Руками не править. */\n\n` +
  fs.readFileSync(path.join(root, 'theme', 'tokens.css'), 'utf8').replace(/\s*$/, '\n\n') +
  fs.readFileSync(path.join(overlay, 'tokens.css'), 'utf8'));
fs.writeFileSync(path.join(out, 'skin.json'), JSON.stringify(skin, null, 2) + '\n');

// ───────── every file skin.json names is there ─────────
const errors = [];
const need = (f, where) => {
  for (const x of Array.isArray(f) ? f : [f]) if (typeof x !== 'string' || !fs.existsSync(path.join(out, x))) errors.push(where + ': no file ' + x);
};
for (const k of ['Steam-WebKit', 'RootColors', 'webkitCSS', 'webkitJS']) if (skin[k] !== undefined) need(skin[k], k);
for (const [i, p] of (skin.Patches || []).entries()) {
  if (p.TargetCss !== undefined) need(p.TargetCss, 'Patches[' + i + '].TargetCss');
  if (p.TargetJs !== undefined) need(p.TargetJs, 'Patches[' + i + '].TargetJs');
}
for (const [name, c] of Object.entries(skin.Conditions || {})) {
  if (!c.values || !(c.default in c.values)) errors.push('Conditions["' + name + '"]: default "' + c.default + '" is not one of its values');
  for (const [value, flow] of Object.entries(c.values || {}))
    for (const [kind, t] of Object.entries(flow)) need(t && t.src, 'Conditions["' + name + '"].' + value + '.' + kind);
}
if (errors.length) {
  for (const e of errors) console.error('Error: ' + e);
  process.exit(1);
}

let n = 0;
(function count(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) count(p); else n++; } })(out);
console.log('Wrote ' + rel(out) + ' (' + n + ' files): Steam Enhanced ' + meta.ref + ' (' + meta.commit.slice(0, 7) + ') + overlay, version ' + skin.version +
  ', ' + skin.Patches.length + ' patches, ' + Object.keys(skin.Conditions).length + ' settings, ' + patched.length + ' patch(es) of ours to their code');
