// Checks what can be checked without Steam. No dependencies.
//   node tools/check.js                              skin.json, plugin.json, the theme's own rules, every Steam class name in theme/src;
//                                                    overlay/ (colours only from tokens, files skin.json names) and
//                                                    upstream/steam-enhanced still as fetched (its digest)
//   node tools/check.js --steam [folder]             also: compare steam-classes.json with the Steam client installed here
//                                                    (folder from the registry when not given): which names the theme uses
//                                                    are gone from the client or now mean another hash
//   node tools/check.js --kit <folder of kit.txt>    also: are the copies kept here (tokens.json, the hub client) still the same as in kit.txt?
//   node tools/check.js --offline                    do not fetch the plugin schema from the address plugin.json names
'use strict';
const fs = require('fs');
const path = require('path');
const classes = require('./classes');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const steamAt = args.indexOf('--steam');
const steam = steamAt < 0 ? null : { folder: args[steamAt + 1] && !args[steamAt + 1].startsWith('--') ? args[steamAt + 1] : null };
const offline = args.includes('--offline');
const kitAt = args.indexOf('--kit');
const kit = kitAt < 0 ? null : path.resolve(args[kitAt + 1]);

let bad = 0;
const fail = m => { bad++; console.log('  FAIL  ' + m); };
const pass = m => console.log('  ok    ' + m);
const note = m => console.log('  note  ' + m);
const readJson = rel => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const themeFile = rel => path.join(root, 'theme', rel);

// ───────── skin.json ─────────
// Millennium publishes no schema for skin.json. The shape checked here is the one its own code reads:
// interfaces Theme, Patch, ICondition, ConditionalPatch in src/typescript/frontend/types/index.ts.
function checkSkin() {
  console.log('theme/skin.json');
  const skin = readJson('theme/skin.json');
  const errors = [];
  const isStr = v => typeof v === 'string' && v.length > 0;
  const fileOk = (rel, where) => { if (!isStr(rel)) errors.push(where + ': not a path'); else if (!fs.existsSync(themeFile(rel))) errors.push(where + ': no file ' + rel); };
  const regexOk = (re, where) => { try { new RegExp(re); } catch (e) { errors.push(where + ': bad regex ' + re); } };
  const known = ['name', 'description', 'author', 'version', 'tags', 'github', 'funding', 'discord_support', 'header_image', 'splash_image', 'RootColors', 'Steam-WebKit', 'webkitCSS', 'webkitJS', 'Patches', 'UseDefaultPatches', 'Conditions'];
  for (const k of Object.keys(skin)) if (!known.includes(k)) errors.push('unknown field ' + k);
  for (const k of ['name', 'description', 'author']) if (!isStr(skin[k])) errors.push(k + ' is required');
  if (skin.version !== undefined && !/^\d+\.\d+\.\d+$/.test(skin.version)) errors.push('version is not x.y.z');
  if (skin.tags !== undefined && !(Array.isArray(skin.tags) && skin.tags.every(isStr))) errors.push('tags must be strings');
  if (skin['Steam-WebKit'] !== undefined) fileOk(skin['Steam-WebKit'], 'Steam-WebKit');
  if (skin.RootColors !== undefined) fileOk(skin.RootColors, 'RootColors');
  if (skin.UseDefaultPatches && (skin.Patches || skin['Steam-WebKit'])) errors.push('UseDefaultPatches must not be combined with Patches or Steam-WebKit (Millennium docs)');
  const targets = (v, where) => { for (const f of Array.isArray(v) ? v : [v]) fileOk(f, where); };
  for (const [i, p] of (skin.Patches || []).entries()) {
    const where = 'Patches[' + i + ']';
    if (!isStr(p.MatchRegexString)) errors.push(where + ': MatchRegexString is required'); else regexOk(p.MatchRegexString, where);
    if (p.TargetCss === undefined && p.TargetJs === undefined) errors.push(where + ': nothing to insert');
    if (p.TargetCss !== undefined) targets(p.TargetCss, where + '.TargetCss');
    if (p.TargetJs !== undefined) targets(p.TargetJs, where + '.TargetJs');
    for (const k of Object.keys(p)) if (!['MatchRegexString', 'TargetCss', 'TargetJs'].includes(k)) errors.push(where + ': unknown field ' + k);
  }
  for (const [name, c] of Object.entries(skin.Conditions || {})) {
    const where = 'Conditions["' + name + '"]';
    if (!c.values || typeof c.values !== 'object' || !Object.keys(c.values).length) { errors.push(where + ': values is required'); continue; }
    if (!(c.default in c.values)) errors.push(where + ': default is not one of the values');
    for (const k of Object.keys(c)) if (!['default', 'description', 'tab', 'section', 'slider', 'values'].includes(k)) errors.push(where + ': unknown field ' + k);
    for (const [value, flow] of Object.entries(c.values)) {
      for (const kind of Object.keys(flow)) {
        const w = where + '.' + value + '.' + kind;
        if (!['TargetCss', 'TargetJs'].includes(kind)) { errors.push(w + ': unknown'); continue; }
        const t = flow[kind];
        if (!Array.isArray(t.affects) || !t.affects.length) errors.push(w + ': affects is required');
        else for (const re of t.affects) { regexOk(re, w); if (re === '*') errors.push(w + ': "*" is not a regex, use ".*"'); }
        fileOk(t.src, w + '.src');
      }
    }
  }
  if (errors.length) for (const e of errors) fail(e);
  else pass('fields, patterns and every file it names (' + (skin.Patches || []).length + ' patches, ' + Object.keys(skin.Conditions || {}).length + ' settings)');
  return skin;
}

// ───────── The theme's own rules ─────────
function cssFiles(dir = themeFile('')) {
  const out = [];
  (function walk(d) { for (const f of fs.readdirSync(d).sort()) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.css')) out.push(p); } })(dir);
  return out;
}
const strip = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const relOf = file => path.relative(root, file).replace(/\\/g, '/');
const srcDir = themeFile('src');
// The file Millennium loads for a source in theme/src (imports in a source are relative to that file)
const builtFor = file => path.join(themeFile(''), path.relative(srcDir, file));
const GENERATED = '/* Сгенерировано tools/build.js из theme/src/';

// Both the sources (theme/src) and the files Millennium loads (theme/…) follow the rules of kit.txt
function checkCss() {
  console.log('theme/src/*.css and theme/*.css');
  const tokens = fs.readFileSync(themeFile('tokens.css'), 'utf8');
  const defined = new Set([...tokens.matchAll(/(--dt-[a-z0-9-]+)\s*:/g)].map(m => m[1]));
  let rawColours = 0, unknownVars = 0, imports = 0, files = 0;
  for (const file of cssFiles()) {
    const rel = relOf(file);
    if (rel === 'theme/tokens.css') continue;
    files++;
    const inSrc = rel.startsWith('theme/src/');
    const css = strip(fs.readFileSync(file, 'utf8'));
    // Rule 1 of kit.txt: colours come from the tokens. `white`, `black` and `transparent` are allowed as the other half of a mix.
    for (const m of css.matchAll(/#[0-9a-f]{3,8}\b(?![^{]*\{)|\b(?:rgba?|hsla?)\(/gi)) { rawColours++; fail(rel + ': colour written by hand: ' + m[0]); }
    for (const m of css.matchAll(/var\((--dt-[a-z0-9-]+)/g)) if (!defined.has(m[1])) { unknownVars++; fail(rel + ': no such token ' + m[1]); }
    for (const m of css.matchAll(/@import\s+url\("([^"]+)"\)/g)) {
      imports++;
      const from = inSrc ? builtFor(file) : file;
      if (!fs.existsSync(path.join(path.dirname(from), m[1]))) fail(rel + ': imports a missing file ' + m[1]);
    }
    const open = (css.match(/\{/g) || []).length, close = (css.match(/\}/g) || []).length;
    if (open !== close) fail(rel + ': unbalanced braces');
  }
  if (!rawColours) pass('no colour is written by hand: every one is a --dt-… token or a mix of them (' + files + ' files)');
  if (!unknownVars) pass('every --dt-… variable used exists in tokens.css (' + defined.size + ' tokens)');
  pass(imports + ' @import lines checked');
}

// ───────── The Steam Enhanced build: our layer and their untouched code ─────────
// overlay/ follows the same colour rule as theme/: tokens (--dt-…, our --arkada-…, their --se-…) and mixes of them,
// with white, black and transparent as the other half of a mix. Colours inside url("data:…") pictures are not CSS.
function checkOverlay() {
  console.log('overlay/ (Steam Enhanced build)');
  const dir = path.join(root, 'overlay');
  if (!fs.existsSync(dir)) { note('no overlay/'); return; }
  const tokens = fs.readFileSync(themeFile('tokens.css'), 'utf8');
  const defined = new Set([...tokens.matchAll(/(--dt-[a-z0-9-]+)\s*:/g)].map(m => m[1]));
  let rawColours = 0, unknownVars = 0, files = 0;
  for (const file of cssFiles(dir)) {
    files++;
    const rel = relOf(file);
    const css = strip(fs.readFileSync(file, 'utf8')).replace(/url\("data:[^"]*"\)/g, 'url()');
    for (const m of css.matchAll(/#[0-9a-f]{3,8}\b(?![^{]*\{)|\b(?:rgba?|hsla?)\(/gi)) { rawColours++; fail(rel + ': colour written by hand: ' + m[0]); }
    for (const m of css.matchAll(/var\((--dt-[a-z0-9-]+)/g)) if (!defined.has(m[1])) { unknownVars++; fail(rel + ': no such token ' + m[1]); }
    const open = (css.match(/\{/g) || []).length, close = (css.match(/\}/g) || []).length;
    if (open !== close) fail(rel + ': unbalanced braces');
  }
  if (!rawColours) pass('no colour is written by hand in overlay/ (' + files + ' files)');
  if (!unknownVars) pass('every --dt-… variable overlay/ uses exists in tokens.css');
  // Every file overlay/skin.json names is one tools/build-se.js puts in dist/arkada/arkada/
  const skin = JSON.parse(fs.readFileSync(path.join(dir, 'skin.json'), 'utf8'));
  const named = [];
  for (const p of skin.Patches || []) for (const k of ['TargetCss', 'TargetJs']) if (p[k]) named.push(...[].concat(p[k]));
  for (const c of Object.values(skin.Conditions || {})) for (const v of Object.values(c.values || {})) for (const t of Object.values(v || {})) if (t && t.src) named.push(t.src);
  let missing = 0;
  for (const f of named.filter(f => f.startsWith('arkada/'))) {
    const rel = f.slice('arkada/'.length);
    const fromTheme = /^options\/accent-.*\.css$/.test(rel) && fs.existsSync(themeFile(rel));
    if (!fs.existsSync(path.join(dir, rel)) && !fromTheme && rel !== 'tokens.css') { missing++; fail('overlay/skin.json names ' + f + ', overlay/ has no ' + rel); }
  }
  if (!missing) pass('every arkada/… file overlay/skin.json names is in overlay/ (' + named.filter(f => f.startsWith('arkada/')).length + ')');
  checkI18n(dir);
}

// overlay/i18n.js parses, and its words are still in their code: a key or a pattern's probe gone from
// upstream is a note (their copy changed; the entry is dead weight), not a failure
function checkI18n(dir) {
  const file = path.join(dir, 'i18n.js');
  if (!fs.existsSync(file)) return;
  const r = require('child_process').spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) { fail('overlay/i18n.js does not parse: ' + (r.stderr || '').trim().split('\n').slice(0, 4).join(' ')); return; }
  let dict;
  try { delete require.cache[file]; dict = require(file); } catch (e) { fail('overlay/i18n.js cannot be loaded in Node: ' + e.message); return; }
  const up = path.join(root, 'upstream', 'steam-enhanced');
  if (!fs.existsSync(up)) { pass('overlay/i18n.js parses'); return; }
  const texts = [];
  (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.js')) texts.push(fs.readFileSync(p, 'utf8')); } })(path.join(up, 'client'));
  (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.js')) texts.push(fs.readFileSync(p, 'utf8')); } })(path.join(up, 'core'));
  // compat/: their cards for other plugins (the How Long To Beat card, which Arkada's plugin feeds)
  (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.js')) texts.push(fs.readFileSync(p, 'utf8')); } })(path.join(up, 'compat'));
  const code = texts.join('\n').replace(/\\(['"`])/g, '$1').replace(/&amp;/g, '&');
  const stale = Object.keys(dict.EXACT).filter(k => !code.includes(k));
  const probes = dict.PATTERNS.map(p => p[2]).filter(p => p && !code.includes(p));
  pass('overlay/i18n.js parses: ' + Object.keys(dict.EXACT).length + ' strings, ' + dict.PATTERNS.length + ' patterns');
  if (stale.length) note('overlay/i18n.js: ' + stale.length + ' string(s) no longer in their code: ' + stale.slice(0, 12).map(s => JSON.stringify(s)).join(', ') + (stale.length > 12 ? ', …' : ''));
  if (probes.length) note('overlay/i18n.js: ' + probes.length + ' pattern probe(s) no longer in their code: ' + probes.map(s => JSON.stringify(s)).join(', '));
  if (!stale.length && !probes.length) pass('every string and pattern of overlay/i18n.js is still in their code');
}

// upstream/steam-enhanced is their code as tools/upstream.js fetched it: its digest still matches the one recorded then
function checkUpstream() {
  console.log('upstream/steam-enhanced');
  const metaFile = path.join(root, 'upstream', 'steam-enhanced.json');
  if (!fs.existsSync(metaFile)) { note('no upstream/steam-enhanced.json'); return; }
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  if (!meta.digest) { note('upstream/steam-enhanced.json has no digest (run: node tools/upstream.js --ref ' + meta.ref + ')'); return; }
  const now = require('./se-digest').digest(path.join(root, 'upstream', 'steam-enhanced'));
  if (now.digest === meta.digest) pass('untouched: ' + now.files + ' files match the digest recorded for ' + meta.ref + ' (' + String(meta.commit).slice(0, 7) + ')');
  else fail('upstream/steam-enhanced differs from what tools/upstream.js fetched for ' + meta.ref + ': their code is never edited here (put the change in overlay/ or patches/, or fetch it again: node tools/upstream.js --ref ' + meta.ref + ')');
  // Our patches to their code (patches/*.patch) still apply to it as it is now; tools/build-se.js applies them to dist/
  const patches = require('./patches');
  try {
    const done = patches.applyAll(path.join(root, 'upstream', 'steam-enhanced'), { write: false });
    if (done.length) pass(done.length + ' patch(es) in patches/ apply to ' + meta.ref + ': ' + done.map(d => d.patch.replace('patches/', '') + ' (' + d.files.join(', ') + ')').join('; '));
  } catch (e) {
    fail(e.message + ' — update the patch for their new code, or drop it if they fixed it');
  }
}

// A class name that looks like css-loader's hash rather than a word
const hashed = name => /^[A-Za-z0-9_-]{18,26}$/.test(name) && /\d/.test(name) && /[A-Z]/.test(name) && /[a-z]/.test(name) && !/^[A-Z][a-z]+([A-Z][a-z]+)*(_[A-Za-z]+)*$/.test(name);
const selectorClasses = css => {
  const out = [];
  for (const m of strip(css).replace(/url\("[^"]*"\)/g, '').matchAll(/([^{}]+)\{/g))
    for (const c of m[1].matchAll(/\.((?:\\.|[A-Za-z0-9_-])+)/g)) out.push(c[1]);
  return out;
};

// Every readable name in theme/src resolves in steam-classes.json; no raw hash is written; built files are not orphans
function checkClasses() {
  console.log('Steam classes the theme relies on (steam-classes.json)');
  const idx = classes.load();
  const used = new Map(); // spec → { hash, files }
  let errors = 0, raw = 0;
  for (const file of cssFiles(srcDir)) {
    const rel = relOf(file), text = fs.readFileSync(file, 'utf8');
    const r = classes.compile(text, idx, rel);
    for (const e of r.errors) { errors++; fail(e); }
    for (const [s, h] of r.used) { if (!used.has(s)) used.set(s, { hash: h, files: new Set() }); used.get(s).files.add(rel); }
    for (const c of selectorClasses(text)) if (!c.startsWith('\\@') && hashed(c)) { raw++; fail(rel + ': raw hashed class .' + c + ' — write it by name (\\@Name), see tools/classes.js'); }
  }
  for (const file of cssFiles()) {
    const rel = relOf(file);
    if (rel.startsWith('theme/src/')) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (text.startsWith(GENERATED)) {
      if (!fs.existsSync(path.join(srcDir, path.relative(themeFile(''), file)))) fail(rel + ': generated, but theme/src has no source for it (delete it or restore the source)');
      if (/\\@[A-Za-z_]/.test(strip(text))) fail(rel + ': still has an unresolved \\@Name (run: node tools/build.js)');
    } else if (!rel.startsWith('theme/options/') && rel !== 'theme/tokens.css') fail(rel + ': hand-written next to the built files; its source belongs in theme/src');
  }
  if (!errors) pass('all ' + used.size + ' names in theme/src resolve to one class each' + (idx.client ? ' (snapshot of client ' + idx.client.version + ', ' + idx.client.date + ')' : ''));
  if (!raw) pass('no raw hashed class in theme/src');
  return used;
}

// The snapshot against the client installed on this computer
function checkSteam(used) {
  if (!steam) { note('not compared with the installed Steam: pass --steam [folder]'); return; }
  const snap = require('./steam-classes');
  let folder, live;
  try { folder = snap.steamFolder(steam.folder ? ['--steam', steam.folder] : []); live = classes.index(snap.snapshot(folder)); }
  catch (e) { fail('could not read the Steam client: ' + e.message); return; }
  console.log('Steam client in ' + folder);
  const mine = classes.load();
  const v = o => o.client ? o.client.version + ' (' + o.client.date + ')' : 'unknown';
  if (v(mine) !== v(live)) note('snapshot is of client ' + v(mine) + ', installed client is ' + v(live));
  let gone = 0, changed = 0;
  for (const [s, { hash, files }] of [...used].sort()) {
    const [key, ...quals] = s.split('\\@').filter(Boolean);
    const r = classes.resolve(live, key, quals);
    const where = ' (used in ' + [...files].join(', ') + ')';
    if (r.error) { gone++; fail('gone from the installed client: ' + r.error.split('\n')[0] + where); }
    else if (r.hash !== hash) { changed++; fail(s + ' is now .' + r.hash + ' (snapshot: .' + hash + ')' + where); }
  }
  if (gone || changed) note('refresh the snapshot and rebuild: node tools/steam-classes.js && node tools/build.js' + (gone ? '; names that are gone need a new name in theme/src' : ''));
  else pass('all ' + used.size + ' names mean the same classes in the installed client');
}

// ───────── plugin.json ─────────
// A small reader of JSON Schema draft-04: the part Millennium's plugin schema uses.
function validate(schema, value, where, errors) {
  const type = v => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v === 'number' && Number.isInteger(v) ? 'integer' : typeof v);
  if (schema.type) {
    const t = type(value), want = [].concat(schema.type);
    if (!want.includes(t) && !(t === 'integer' && want.includes('number'))) { errors.push(where + ': is ' + t + ', must be ' + want.join('/')); return; }
  }
  if (schema.enum && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value))) errors.push(where + ': not one of ' + JSON.stringify(schema.enum));
  if (schema.required && type(value) === 'object') for (const k of schema.required) if (!(k in value)) errors.push(where + ': ' + k + ' is required');
  if (schema.properties && type(value) === 'object') {
    for (const [k, s] of Object.entries(schema.properties)) if (k in value) validate(s, value[k], where + '.' + k, errors);
    if (schema.additionalProperties === false) for (const k of Object.keys(value)) if (!(k in schema.properties)) errors.push(where + ': field ' + k + ' is not allowed');
  }
  if (schema.items && Array.isArray(value)) value.forEach((v, i) => validate(schema.items, v, where + '[' + i + ']', errors));
}

async function checkPlugin() {
  console.log('plugin/plugin.json');
  const meta = readJson('plugin/plugin.json');
  const own = [];
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(meta.name || '')) own.push('name must also fit the hub: ^[a-z][a-z0-9-]{0,31}$');
  if (!/^\d+\.\d+\.\d+$/.test(meta.version || '')) own.push('version is not x.y.z');
  // Millennium switches off old plugins that have a backend which is not Lua (frontend/index.tsx, checkLegacyPlugins)
  if (meta.useBackend !== false && meta.backendType !== 'lua') own.push('useBackend must be false (or backendType "lua"), or Millennium disables the plugin as outdated');
  // The same plugin described for Millennium's packed format; the two descriptions must not drift apart
  const toml = fs.readFileSync(path.join(root, 'plugin', 'millennium.toml'), 'utf8').replace(/^\s*#.*$/gm, '');
  const tomlValue = key => (new RegExp('^' + key + '\\s*=\\s*"([^"]*)"', 'm').exec(toml) || [])[1];
  if (tomlValue('id') !== meta.name) own.push('millennium.toml: id is not ' + meta.name);
  if (tomlValue('version') !== meta.version) own.push('millennium.toml: version is not ' + meta.version);
  if (/^\s*\[dev\]/m.test(toml) || tomlValue('output_path') === 'auto') own.push('millennium.toml: [dev] or output_path = "auto" would make the compiler write into Steam');
  if (readJson('theme/skin.json').version !== meta.version) note('theme version ' + readJson('theme/skin.json').version + ' differs from plugin version ' + meta.version);
  // The Lua backend (window backdrop): Millennium runs backend/main.lua when useBackend is on
  if (meta.useBackend && !fs.existsSync(path.join(root, 'plugin', 'backend', 'main.lua'))) own.push('useBackend is on, but there is no plugin/backend/main.lua');
  if (own.length) for (const e of own) fail(e); else pass('name, version, ' + (meta.useBackend ? 'Lua backend' : 'no backend') + '; millennium.toml agrees');

  const dist = path.join(root, 'plugin', 'dist', meta.name);
  if (!fs.existsSync(path.join(dist, '.millennium', 'Dist', 'index.js'))) fail('plugin/dist/' + meta.name + '/.millennium/Dist/index.js is not built (run: node plugin/build.js)');
  else if (fs.readFileSync(path.join(dist, 'plugin.json'), 'utf8').replace(/\r\n/g, '\n') !== fs.readFileSync(path.join(root, 'plugin', 'plugin.json'), 'utf8').replace(/\r\n/g, '\n')) fail('plugin/dist/' + meta.name + '/plugin.json differs from plugin/plugin.json');
  else if (meta.useBackend && !fs.existsSync(path.join(dist, 'backend', 'main.lua'))) fail('plugin/dist/' + meta.name + '/backend/main.lua is not built (run: node plugin/build.js)');
  else pass('built layout: dist/' + meta.name + '/plugin.json and dist/' + meta.name + '/.millennium/Dist/index.js' + (meta.useBackend ? ' and backend/main.lua' : ''));

  if (offline) { note('schema not fetched (--offline)'); return; }
  let schema;
  try {
    const res = await fetch(meta.$schema, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    schema = await res.json();
  } catch (e) { fail('could not fetch the schema plugin.json names (' + meta.$schema + '): ' + (e && e.message || e)); return; }
  const errors = [];
  validate(schema, meta, 'plugin.json', errors);
  const extra = Object.keys(meta).filter(k => k !== '$schema' && !(k in (schema.properties || {})));
  if (errors.length) for (const e of errors) fail(e);
  else pass('valid against ' + meta.$schema);
  if (extra.length) note('fields the schema does not list (it allows extra ones): ' + extra.join(', '));
}

// ───────── Copies of kit.txt ─────────
function checkKit() {
  if (!kit) return;
  console.log('copies of kit.txt (' + kit + ')');
  const text = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
  const same = (mine, theirs) => text(path.join(root, mine)) === text(path.join(kit, theirs));
  for (const [mine, theirs, how] of [
    ['tokens.json', 'tokens/tokens.json', 'node tools/build.js <kit>/tokens/tokens.json'],
    ['theme/tokens.css', 'dist/tokens.css', 'node tools/build.js <kit>/tokens/tokens.json'],
    ['plugin/src/hub-client.js', 'hub/client.js', 'copy <kit>/hub/client.js over it, then node plugin/build.js'],
  ]) if (same(mine, theirs)) pass(mine + ' is the same as kit ' + theirs); else fail(mine + ' differs from kit ' + theirs + ' (' + how + ')');
}

(async () => {
  checkSkin();
  checkCss();
  checkSteam(checkClasses());
  checkOverlay();
  checkUpstream();
  checkKit();
  await checkPlugin();
  console.log(bad ? '\n' + bad + ' problem(s)' : '\nAll checks passed');
  process.exit(bad ? 1 : 0);
})();
