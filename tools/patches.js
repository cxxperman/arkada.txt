// Build-time patches to Steam Enhanced: patches/*.patch, unified diffs against upstream/steam-enhanced.
// upstream/ is never edited; tools/build-se.js applies the patches to its copy in dist/arkada, and
// tools/check.js checks that every one still applies to upstream/ as it is now. No dependencies.
//
// A patch file: free text first (what it changes and why, for the pull request to Steam Enhanced),
// then one or more file diffs, as `git diff` writes them:
//   --- a/client/loader.js
//   +++ b/client/loader.js
//   @@ -515,7 +515,15 @@
//    context
//   -removed
//   +added
// A hunk is applied where its context and removed lines are found as they are (line endings aside),
// the nearest such place to the line it names; no fuzz. If they are not there, or are there more than
// once at the same distance, the patch fails with the file, the hunk and the line it looked for.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'patches');

function parse(text, name) {
  const files = [];
  let file = null, hunk = null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('--- ') && lines[i + 1] && lines[i + 1].startsWith('+++ ')) {
      const target = lines[i + 1].slice(4).trim().replace(/^b\//, '').replace(/\t.*$/, '');
      file = { path: target, hunks: [] };
      files.push(file);
      hunk = null;
      i++;
      continue;
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (h) {
      if (!file) throw new Error(name + ': a hunk before any file header (--- a/… +++ b/…)');
      hunk = { at: Number(h[1]), old: [], new: [], line: i + 1 };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (l.startsWith('\\')) continue; // "\ No newline at end of file"
    const c = l[0], body = l.slice(1);
    if (c === ' ') { hunk.old.push(body); hunk.new.push(body); }
    else if (c === '-') hunk.old.push(body);
    else if (c === '+') hunk.new.push(body);
    else if (l === '') { hunk.old.push(''); hunk.new.push(''); } // an empty context line some editors strip the space from
    else hunk = null; // the free text between file diffs
  }
  if (!files.length) throw new Error(name + ': no file diffs in it');
  return files;
}

// → the patched text, or throws an Error saying which hunk did not apply
function applyFile(text, filePatch, name) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let shift = 0;
  filePatch.hunks.forEach((h, n) => {
    // Trailing empty context lines (an empty last line of the patch file) are not needed to place a hunk
    const old = h.old.slice(), neu = h.new.slice();
    while (old.length && neu.length && old[old.length - 1] === '' && neu[neu.length - 1] === '') { old.pop(); neu.pop(); }
    const expected = Math.max(0, h.at - 1 + shift);
    const matchAt = i => old.every((l, k) => lines[i + k] !== undefined && lines[i + k] === l);
    let best = -1, bestDist = Infinity, tie = false;
    for (let i = 0; i + old.length <= lines.length; i++) {
      if (!matchAt(i)) continue;
      const d = Math.abs(i - expected);
      if (d < bestDist) { best = i; bestDist = d; tie = false; } else if (d === bestDist) tie = true;
    }
    if (best < 0 || tie) {
      const first = old.find(l => l.trim()) || '';
      throw new Error(name + ': hunk ' + (n + 1) + ' of ' + filePatch.path + ' (patch line ' + h.line + ', file line ' + h.at + ') ' +
        (tie ? 'matches two places equally' : 'no longer matches: their code there changed') + '; it starts with: ' + JSON.stringify(first.trim().slice(0, 100)));
    }
    lines.splice(best, old.length, ...neu);
    shift += neu.length - old.length + (best - expected);
  });
  return lines.join(eol);
}

const list = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.patch')).sort() : []);

// Applies every patch to the files under `base` (in place when write is true). → [{ patch, files }]; throws on the first failure
function applyAll(base, { write = true } = {}) {
  const done = [], texts = new Map();
  for (const f of list()) {
    const name = 'patches/' + f;
    const files = parse(fs.readFileSync(path.join(dir, f), 'utf8'), name);
    for (const fp of files) {
      const p = path.join(base, fp.path);
      if (!texts.has(p)) {
        if (!fs.existsSync(p)) throw new Error(name + ': ' + fp.path + ' is not in Steam Enhanced any more (renamed or removed)');
        texts.set(p, fs.readFileSync(p, 'utf8'));
      }
      texts.set(p, applyFile(texts.get(p), fp, name));
    }
    done.push({ patch: name, files: files.map(fp => fp.path) });
  }
  if (write) for (const [p, t] of texts) fs.writeFileSync(p, t);
  return done;
}

module.exports = { parse, applyFile, applyAll, list, dir };
