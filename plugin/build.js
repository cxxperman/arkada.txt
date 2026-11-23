// Builds the plugin the way Millennium loads it from <Steam>\millennium\plugins:
//   dist/arkada/plugin.json
//   dist/arkada/.millennium/Dist/index.js    the client part (SharedJSContext), entry src/index.js
//   dist/arkada/.millennium/Dist/webkit.js   the part Millennium runs in store and community pages, entry src/webkit.js
//   dist/arkada/backend/…                 backend/ as it is: the Lua backend (main.lua) and LICENSE-dwmx
// The wrapper around the code is the one Millennium's own bundler writes (and the Kapsula plugin uses);
// the modules of src/ are put inside it as they are, so the build needs nothing but Node.
// It also writes three small modules of src/ from other files of the repository (not edited by hand):
//   src/version.js         the version in plugin.json
//   src/steam-snapshot.js  the classes of Steam's game stats row from steam-classes.json (disksize.js uses
//                          them when Millennium cannot find them in the running client)
//   src/tokens.js          the dev.txt tokens from theme/tokens.css (share.js draws its menu with them)
//   node plugin/build.js           write the files
//   node plugin/build.js --check   fail if the files on disk differ from what would be written
'use strict';
const fs = require('fs');
const path = require('path');

const here = __dirname;
const meta = JSON.parse(fs.readFileSync(path.join(here, 'plugin.json'), 'utf8'));
const MODULES = ['hub-client.js', 'core.js', 'steam-snapshot.js', 'steam.js', 'backdrop.js', 'features.js', 'watch.js', 'pages.js',
  'disksize.js', 'kapsula.js', 'startpage.js', 'version.js', 'index.js']; // index.js is the entry
const WEBKIT_MODULES = ['watch.js', 'share.js', 'tokens.js', 'webkit.js']; // webkit.js is the entry

// The version lives in plugin.json; the code reads it from this small generated file (so does the .star build)
const versionJs = `// Written by build.js from plugin.json. Do not edit by hand.
module.exports = ${JSON.stringify(meta.version)};
`;

// The classes of the game stats row (one style module of the client), from the snapshot tools/steam-classes.js takes
const SNAPSHOT_NAMES = ['GameStatsSection', 'GameStat', 'GameStatIcon', 'GameStatRight', 'LastPlayed', 'LastPlayedInfo', 'PlayBarLabel', 'PlayBarDetailLabel', 'PlaytimeIcon'];
function snapshotJs() {
  const snap = JSON.parse(fs.readFileSync(path.join(here, '..', 'steam-classes.json'), 'utf8'));
  const found = (snap.modules || []).find(m => m && m.classes && typeof m.classes.GameStatsSection === 'string');
  const mod = found ? found.classes : null;
  const picked = {};
  if (mod) for (const n of SNAPSHOT_NAMES) if (typeof mod[n] === 'string') picked[n] = mod[n];
  const client = snap.client ? ' (client ' + snap.client.version + ', ' + snap.client.date + ')' : '';
  return `// Written by build.js from steam-classes.json${client}. Do not edit by hand.
// Probe name → the hashed classes of the client's style module that has it (steam.js, classes()).
module.exports = ${JSON.stringify(mod ? { GameStatsSection: picked } : {}, null, 2)};
`;
}
// The tokens of kit.txt as CSS declarations: the dark :root block of theme/tokens.css, and its reduced-motion block
function tokensJs() {
  const css = fs.readFileSync(path.join(here, '..', 'theme', 'tokens.css'), 'utf8').replace(/\r\n/g, '\n');
  const decls = m => (m ? m[1].split('\n').map(l => l.trim()).filter(l => /^--dt-[\w-]+\s*:/.test(l)).join(' ') : '');
  const base = decls(/^:root\s*\{([^}]*)\}/m.exec(css));
  const reduced = decls(/prefers-reduced-motion[^{]*\{\s*:root\s*\{([^}]*)\}/.exec(css));
  if (!base) throw new Error('theme/tokens.css: no :root block');
  return `// Written by build.js from theme/tokens.css (the --dt-… tokens of kit.txt). Do not edit by hand.
module.exports = ${JSON.stringify({ base, reduced }, null, 2)};
`;
}
const GENERATED = { 'version.js': versionJs, 'steam-snapshot.js': snapshotJs(), 'tokens.js': tokensJs() };

const read = f => (GENERATED[f] !== undefined ? GENERATED[f] : fs.readFileSync(path.join(here, 'src', f), 'utf8').replace(/\r\n/g, '\n'));
const shown = file => path.relative(path.join(here, '..'), file).split(path.sep).join('/');
const indent = (text, n) => text.split('\n').map(l => (l ? ' '.repeat(n) + l : l)).join('\n');
const moduleTable = list => list.map(f =>
  `      ${JSON.stringify('./' + f)}: function (module, exports, require) {\n${indent(read(f).trimEnd(), 8)}\n      },`).join('\n');
const loader = `    const loaded = {};
    function load(name) {
      if (loaded[name]) return loaded[name].exports;
      if (!modules[name]) throw new Error("Arkada: no module " + name);
      const module = loaded[name] = { exports: {} };
      modules[name](module, module.exports, load);
      return module.exports;
    }`;

function bundle() {
  const mods = moduleTable(MODULES);
  return `// Arkada plugin for Millennium, version ${meta.version}. Built by plugin/build.js from plugin/src — do not edit by hand.
// Runs inside the Steam client and tells the dev.txt hub on this PC (ws://127.0.0.1:42080/hub) what Steam is doing,
// sends Steam's notifications to Kapsula on this PC (ws://127.0.0.1:42071) and shows the size on disk on a game's page.
// Nothing goes to the internet. Steam's own notifications are left as they were (Kapsula may ask to hide one it shows).
const MILLENNIUM_IS_CLIENT_MODULE = !0, pluginName = ${JSON.stringify(meta.name)};
(window.PLUGIN_LIST ||= {})[pluginName] ||= {}, window.MILLENNIUM_SIDEBAR_NAVIGATION_PANELS ||= {};
let PluginEntryPointMain = function () {
  return function (exports, millenniumApi, react) {
    "use strict";
    const modules = {
${mods}
    };
${loader}
    // Everything index.js exports: default (the entry) and arkadaShare (called from the store pages)
    Object.assign(exports, load("./index.js"));
    Object.defineProperty(exports, "__esModule", { value: !0 });
    return exports;
  }({}, window.MILLENNIUM_API, window.SP_REACT);
};
(async () => {
  const e = PluginEntryPointMain();
  Object.assign(window.PLUGIN_LIST[pluginName], { ...e, __millennium_internal_plugin_name_do_not_use_or_change__: pluginName });
  const t = await e.default();
  t && void 0 !== t.title && void 0 !== t.icon && void 0 !== t.content && (window.MILLENNIUM_SIDEBAR_NAVIGATION_PANELS[pluginName] = t),
    MILLENNIUM_BACKEND_IPC.postMessage(1, { pluginName: pluginName });
})();
`;
}

// The webkit script: the wrapper Millennium's bundler writes for webkit modules (no backend IPC there)
function webkitBundle() {
  const mods = moduleTable(WEBKIT_MODULES);
  return `// Arkada plugin for Millennium, version ${meta.version}: the part Millennium runs in Steam's store pages.
// Built by plugin/build.js from plugin/src — do not edit by hand. Adds «Поделиться» to a game's page; nothing goes to the internet.
const MILLENNIUM_IS_CLIENT_MODULE = !1, pluginName = ${JSON.stringify(meta.name)};
(window.PLUGIN_LIST ||= {})[pluginName] ||= {}, window.MILLENNIUM_SIDEBAR_NAVIGATION_PANELS ||= {};
let PluginEntryPointMain = function () {
  return function (exports, millenniumApi) {
    "use strict";
    const modules = {
${mods}
    };
${loader}
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
`;
}

const out = path.join(here, 'dist', meta.name);
const files = {
  '../../src/version.js': versionJs,
  '../../src/steam-snapshot.js': GENERATED['steam-snapshot.js'],
  '../../src/tokens.js': GENERATED['tokens.js'],
  'plugin.json': fs.readFileSync(path.join(here, 'plugin.json'), 'utf8').replace(/\r\n/g, '\n'),
  '.millennium/Dist/index.js': bundle(),
  '.millennium/Dist/webkit.js': webkitBundle(),
};
// The Lua backend goes as it is: Millennium's Lua host runs backend/main.lua (plugin.json: useBackend)
for (const f of fs.readdirSync(path.join(here, 'backend')).sort())
  files['backend/' + f] = fs.readFileSync(path.join(here, 'backend', f), 'utf8').replace(/\r\n/g, '\n');
const check = process.argv.includes('--check');
let stale = false;
for (const [rel, text] of Object.entries(files)) {
  const file = path.join(out, rel);
  if (check) {
    const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (now !== text) { console.error('Stale: ' + shown(file) + ' (run: node plugin/build.js)'); stale = true; }
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log('Wrote ' + shown(file) + ' (' + Buffer.byteLength(text) + ' bytes)');
  }
}
if (check && !stale) console.log('Up to date: plugin/dist/' + meta.name);
if (stale) process.exit(1);
