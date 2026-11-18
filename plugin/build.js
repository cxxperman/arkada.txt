// Builds the plugin the way Millennium loads it from <Steam>\millennium\plugins:
//   dist/arkada/plugin.json
//   dist/arkada/.millennium/Dist/index.js
// The wrapper around the code is the one Millennium's own bundler writes (and the Kapsula plugin uses);
// the modules of src/ are put inside it as they are, so the build needs nothing but Node.
// It also writes src/version.js from the version in plugin.json.
//   node plugin/build.js           write the files
//   node plugin/build.js --check   fail if the files on disk differ from what would be written
'use strict';
const fs = require('fs');
const path = require('path');

const here = __dirname;
const meta = JSON.parse(fs.readFileSync(path.join(here, 'plugin.json'), 'utf8'));
const MODULES = ['hub-client.js', 'core.js', 'steam.js', 'version.js', 'index.js']; // index.js is the entry

// The version lives in plugin.json; the code reads it from this small generated file (so does the .star build)
const versionJs = `// Written by build.js from plugin.json. Do not edit by hand.
module.exports = ${JSON.stringify(meta.version)};
`;

const read = f => (f === 'version.js' ? versionJs : fs.readFileSync(path.join(here, 'src', f), 'utf8').replace(/\r\n/g, '\n'));
const shown = file => path.relative(path.join(here, '..'), file).split(path.sep).join('/');
const indent = (text, n) => text.split('\n').map(l => (l ? ' '.repeat(n) + l : l)).join('\n');

function bundle() {
  const mods = MODULES.map(f =>
    `      ${JSON.stringify('./' + f)}: function (module, exports, require) {\n${indent(read(f).trimEnd(), 8)}\n      },`).join('\n');
  return `// Arkada plugin for Millennium, version ${meta.version}. Built by plugin/build.js from plugin/src — do not edit by hand.
// Runs inside the Steam client and tells the dev.txt hub on this PC (ws://127.0.0.1:42080/hub) what Steam is doing.
// Nothing goes to the internet, and Steam's own notifications are left exactly as they were.
const MILLENNIUM_IS_CLIENT_MODULE = !0, pluginName = ${JSON.stringify(meta.name)};
(window.PLUGIN_LIST ||= {})[pluginName] ||= {}, window.MILLENNIUM_SIDEBAR_NAVIGATION_PANELS ||= {};
let PluginEntryPointMain = function () {
  return function (exports, millenniumApi, react) {
    "use strict";
    const modules = {
${mods}
    };
    const loaded = {};
    function load(name) {
      if (loaded[name]) return loaded[name].exports;
      if (!modules[name]) throw new Error("Arkada: no module " + name);
      const module = loaded[name] = { exports: {} };
      modules[name](module, module.exports, load);
      return module.exports;
    }
    exports.default = load("./index.js").default;
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

const out = path.join(here, 'dist', meta.name);
const files = {
  '../../src/version.js': versionJs,
  'plugin.json': fs.readFileSync(path.join(here, 'plugin.json'), 'utf8').replace(/\r\n/g, '\n'),
  '.millennium/Dist/index.js': bundle(),
};
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
