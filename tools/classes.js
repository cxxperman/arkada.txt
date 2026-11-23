// Readable names of Steam's hashed classes, resolved through the snapshot steam-classes.json. No dependencies.
// Used by tools/build.js (theme/src → theme) and tools/check.js.
//
// In theme/src a hashed class is written by the name Valve gave it:
//   .\@PlayBar               the hash of PlayBar; there must be exactly one
//   .\@TopBar\@URLBar        the hash of TopBar from the module that also has the key URLBar
//                            (any number of \@Key after the first: the module must have all of them)
// `.\@PlayBar` is valid CSS (a class named "@PlayBar"), so editors and linters read the sources as they are.
'use strict';
const fs = require('fs');
const path = require('path');

const snapshotFile = path.join(__dirname, '..', 'steam-classes.json');
const NAME = /\\@([A-Za-z_][A-Za-z0-9_-]*)((?:\\@[A-Za-z_][A-Za-z0-9_-]*)*)/g;

function load(file = snapshotFile) {
  return index(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// { client, modules: [{ classes }], byKey: Map(key → [module]) }
function index(snap) {
  const byKey = new Map();
  for (const m of snap.modules) for (const k of Object.keys(m.classes)) {
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(m);
  }
  return { client: snap.client, modules: snap.modules, byKey };
}

const spec = (key, quals) => '\\@' + [key, ...quals].join('\\@');

// A key that only this module (among `others`) has — to tell the reader how to pick it
function qualifierFor(mod, others) {
  const keys = Object.keys(mod.classes).filter(k => others.every(o => o === mod || !(k in o.classes)));
  // A longer name says more about the module than "Active" or "Icon"
  keys.sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  return keys[0];
}

// → { hash } or { error }
function resolve(idx, key, quals = []) {
  const all = idx.byKey.get(key);
  if (!all) {
    const low = key.toLowerCase();
    const like = [...idx.byKey.keys()].filter(k => k.toLowerCase() === low || k.toLowerCase().includes(low) || low.includes(k.toLowerCase()) && k.length > 3).slice(0, 8);
    return { error: 'no class ' + key + ' in the Steam client' + (like.length ? '; similar: ' + like.map(k => '\\@' + k).join(', ') : '') };
  }
  const missing = quals.filter(q => !idx.byKey.has(q));
  if (missing.length) return { error: spec(key, quals) + ': no key ' + missing.join(', ') + ' in the Steam client' };
  const mods = all.filter(m => quals.every(q => q in m.classes));
  if (!mods.length) return { error: spec(key, quals) + ': no module has ' + key + ' together with ' + quals.join(', ') + candidates(key, all, quals) };
  const hashes = [...new Set(mods.map(m => m.classes[key]))];
  if (hashes.length === 1) return { hash: hashes[0] };
  return { error: spec(key, quals) + ' is ambiguous: ' + hashes.length + ' different classes' + candidates(key, mods, quals) };
}

function candidates(key, mods, quals) {
  const groups = new Map(); // hash → modules
  for (const m of mods) { const h = m.classes[key]; if (!groups.has(h)) groups.set(h, []); groups.get(h).push(m); }
  const reps = [...groups.values()].map(g => g[0]);
  const out = reps.slice(0, 8).map(m => {
    const q = qualifierFor(m, reps);
    const sample = Object.keys(m.classes).filter(k => k !== key).slice(0, 4).join(', ');
    return '\n      ' + (q ? spec(key, [...quals, q]) : '(no unique key)') + '   module with ' + sample + '…';
  });
  return '; pick one:' + out.join('') + (reps.length > 8 ? '\n      … and ' + (reps.length - 8) + ' more' : '');
}

// Replace every readable name outside comments. → { css, used: Map(spec → hash), errors: [] }
function compile(css, idx, where) {
  const used = new Map(), errors = [];
  const parts = css.split(/(\/\*[\s\S]*?\*\/)/);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(NAME, (whole, key, rest, offset) => {
      const quals = rest ? rest.split('\\@').filter(Boolean) : [];
      const r = resolve(idx, key, quals);
      if (r.error) {
        const line = parts.slice(0, i).join('').split('\n').length + parts[i].slice(0, offset).split('\n').length - 1;
        errors.push((where ? where + ':' + line + ': ' : '') + r.error);
        return whole;
      }
      used.set(spec(key, quals), r.hash);
      return r.hash;
    });
  }
  return { css: parts.join(''), used, errors };
}

module.exports = { snapshotFile, load, index, resolve, compile, NAME };
