// Checks what can be checked without Steam. No dependencies.
//   node tools/check.js                              skin.json, plugin.json, the theme's own rules
//   node tools/check.js --steam-css <file> [...]     also: are the Steam classes the theme names still in these css files?
//                                                    (the client's css lives in <Steam>\steamui\css; any copy will do)
//   node tools/check.js --kit <folder of kit.txt>    also: are the copies kept here (tokens.json, the hub client) still the same as in kit.txt?
//   node tools/check.js --offline                    do not fetch the plugin schema from the address plugin.json names
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const cssAt = args.indexOf('--steam-css');
const steamCss = [];
if (cssAt >= 0) for (const a of args.slice(cssAt + 1)) { if (a.startsWith('--')) break; steamCss.push(a); }
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
function cssFiles() {
  const out = [];
  (function walk(dir) { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.css')) out.push(p); } })(themeFile(''));
  return out;
}
const strip = css => css.replace(/\/\*[\s\S]*?\*\//g, '');

function checkCss() {
  console.log('theme/*.css');
  const tokens = fs.readFileSync(themeFile('tokens.css'), 'utf8');
  const defined = new Set([...tokens.matchAll(/(--dt-[a-z0-9-]+)\s*:/g)].map(m => m[1]));
  let rawColours = 0, unknownVars = 0, imports = 0;
  for (const file of cssFiles()) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    if (rel === 'theme/tokens.css') continue;
    const css = strip(fs.readFileSync(file, 'utf8'));
    // Rule 1 of kit.txt: colours come from the tokens. `white`, `black` and `transparent` are allowed as the other half of a mix.
    for (const m of css.matchAll(/#[0-9a-f]{3,8}\b(?![^{]*\{)|\b(?:rgba?|hsla?)\(/gi)) { rawColours++; fail(rel + ': colour written by hand: ' + m[0]); }
    for (const m of css.matchAll(/var\((--dt-[a-z0-9-]+)/g)) if (!defined.has(m[1])) { unknownVars++; fail(rel + ': no such token ' + m[1]); }
    for (const m of css.matchAll(/@import\s+url\("([^"]+)"\)/g)) { imports++; if (!fs.existsSync(path.join(path.dirname(file), m[1]))) fail(rel + ': imports a missing file ' + m[1]); }
    const open = (css.match(/\{/g) || []).length, close = (css.match(/\}/g) || []).length;
    if (open !== close) fail(rel + ': unbalanced braces');
  }
  if (!rawColours) pass('no colour is written by hand: every one is a --dt-… token or a mix of them');
  if (!unknownVars) pass('every --dt-… variable used exists in tokens.css (' + defined.size + ' tokens)');
  pass(imports + ' @import lines checked');
}

// Classes of Steam the theme names, split into readable ones and hashed ones
function steamClasses() {
  const out = { client: new Map(), web: new Map() };
  for (const file of cssFiles()) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    if (rel === 'theme/tokens.css' || rel.startsWith('theme/options/')) continue;
    const css = strip(fs.readFileSync(file, 'utf8')).replace(/url\("[^"]*"\)/g, '');
    const into = rel === 'theme/webkit.css' ? out.web : out.client;
    for (const m of css.matchAll(/([^{}]+)\{/g))
      for (const c of m[1].matchAll(/[.#]([A-Za-z_][A-Za-z0-9_-]*)/g)) {
        if (c[1].startsWith('MillenniumWindow_')) continue; // set by Millennium, not by Steam
        if (!into.has(c[1])) into.set(c[1], new Set());
        into.get(c[1]).add(rel);
      }
  }
  return out;
}
const hashed = name => /^[A-Za-z0-9_-]{18,24}$/.test(name) && /\d/.test(name) && /[A-Z]/.test(name) && /[a-z]/.test(name) && !/^[A-Z][a-z]+([A-Z][a-z]+)*(_[A-Za-z]+)*$/.test(name);

function checkSteamClasses() {
  console.log('Steam classes the theme relies on');
  const { client, web } = steamClasses();
  const fragile = [...client.keys()].filter(hashed), readable = [...client.keys()].filter(n => !hashed(n));
  note(readable.length + ' readable client classes, ' + fragile.length + ' hashed (fragile) ones, ' + web.size + ' names from the store website');
  if (fragile.length > 15) fail('more than 15 hashed classes: the theme is meant to stay small');
  if (!steamCss.length) { note('not compared with Steam: pass --steam-css <files> to see which of them the client still has'); return; }
  let text = '';
  for (const f of steamCss) text += fs.readFileSync(f, 'utf8') + '\n';
  const has = name => new RegExp('\\.' + name.replace(/[-]/g, '\\-') + '(?![A-Za-z0-9_-])').test(text);
  const missing = [...client.keys()].filter(n => !has(n));
  if (missing.length) for (const n of missing) fail((hashed(n) ? 'hashed' : 'readable') + ' class .' + n + ' is not in the given css (used in ' + [...client.get(n)].join(', ') + ')');
  else pass('all ' + client.size + ' client classes are present in the given css (' + steamCss.length + ' files, ' + text.length + ' bytes)');
  note('names from the store website are not compared: ' + [...web.keys()].join(', '));
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
  if (own.length) for (const e of own) fail(e); else pass('name, version, no backend; millennium.toml agrees');

  const dist = path.join(root, 'plugin', 'dist', meta.name);
  if (!fs.existsSync(path.join(dist, '.millennium', 'Dist', 'index.js'))) fail('plugin/dist/' + meta.name + '/.millennium/Dist/index.js is not built (run: node plugin/build.js)');
  else if (fs.readFileSync(path.join(dist, 'plugin.json'), 'utf8').replace(/\r\n/g, '\n') !== fs.readFileSync(path.join(root, 'plugin', 'plugin.json'), 'utf8').replace(/\r\n/g, '\n')) fail('plugin/dist/' + meta.name + '/plugin.json differs from plugin/plugin.json');
  else pass('built layout: dist/' + meta.name + '/plugin.json and dist/' + meta.name + '/.millennium/Dist/index.js');

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
  checkSteamClasses();
  checkKit();
  await checkPlugin();
  console.log(bad ? '\n' + bad + ' problem(s)' : '\nAll checks passed');
  process.exit(bad ? 1 : 0);
})();
