// Brings Steam Enhanced (github.com/NVHT/Steam-Enhanced, MIT) into upstream/steam-enhanced. No dependencies.
//   node tools/upstream.js                 the latest release (HEAD of main if the repo has no releases)
//   node tools/upstream.js --ref <tag|sha> that version instead
//   node tools/upstream.js --check         write nothing; say whether a newer version is out, exit 1 if it is
// The folder is their repository as it is in that version, minus .git and the pictures of their README
// (assets/readme, dev/readme-art*). It is never edited by hand: our changes live in overlay/ and
// tools/build-se.js puts the two together. upstream/steam-enhanced.json records which version is here and
// the folder's digest (tools/se-digest.js), which tools/check.js holds the folder to.
// GITHUB_TOKEN, when set, is sent to the GitHub API (more requests per hour). Under GitHub Actions the
// result is also written to $GITHUB_OUTPUT: changed, ref, old, new, compare.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { digest } = require('./se-digest');

const REPO = 'NVHT/Steam-Enhanced';
const BRANCH = 'main';
const root = path.join(__dirname, '..');
const dest = path.join(root, 'upstream', 'steam-enhanced');
const metaFile = path.join(root, 'upstream', 'steam-enhanced.json');
// Paths (relative to their repo, forward slashes) that are not copied.
const SKIP = [/^\.git(\/|$)/, /^assets\/readme(\/|$)/, /^dev\/readme-art[^/]*(\/|$)/];

const args = process.argv.slice(2);
const check = args.includes('--check');
const refAt = args.indexOf('--ref');
const wanted = refAt < 0 ? null : args[refAt + 1];
if (refAt >= 0 && (!wanted || wanted.startsWith('--'))) { console.error('--ref needs a tag or a commit'); process.exit(2); }

const headers = { 'User-Agent': 'arkada-upstream-sync', Accept: 'application/vnd.github+json' };
if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;

async function api(p) {
  const r = await fetch('https://api.github.com' + p, { headers });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('GitHub API ' + p + ': ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

// → { ref, commit, date }: ref is the tag (or what --ref named, or the branch), commit the full sha.
async function resolve() {
  let ref = wanted;
  if (!ref) {
    const rel = await api('/repos/' + REPO + '/releases/latest');
    ref = rel ? rel.tag_name : BRANCH;
  }
  const c = await api('/repos/' + REPO + '/commits/' + encodeURIComponent(ref));
  if (!c) throw new Error('No such tag or commit in ' + REPO + ': ' + ref);
  // A sha given as --ref is recorded in full; a tag or branch keeps its name.
  if (/^[0-9a-f]{7,40}$/i.test(ref) && c.sha.startsWith(ref.toLowerCase())) ref = c.sha;
  return { ref, commit: c.sha, date: c.commit.committer.date };
}

function readMeta() {
  try { return JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { return null; }
}

function output(o) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(o).map(([k, v]) => k + '=' + v + '\n').join(''));
}

// Windows' own tar (bsdtar) understands gzip and drive letters; the GNU tar of Git Bash may not.
function tarExe() {
  if (process.platform === 'win32') {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(sys)) return sys;
  }
  return 'tar';
}

async function download(commit) {
  const url = 'https://codeload.github.com/' + REPO + '/tar.gz/' + commit;
  const r = await fetch(url, { headers: { 'User-Agent': headers['User-Agent'] } });
  if (!r.ok) throw new Error('Download ' + url + ': ' + r.status);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arkada-upstream-'));
  fs.writeFileSync(path.join(tmp, 'src.tar.gz'), Buffer.from(await r.arrayBuffer()));
  fs.mkdirSync(path.join(tmp, 'x'));
  // Relative names and cwd: no drive letter ever reaches tar.
  execFileSync(tarExe(), ['-xzf', '../src.tar.gz'], { cwd: path.join(tmp, 'x'), stdio: 'inherit' });
  const top = fs.readdirSync(path.join(tmp, 'x'));
  if (top.length !== 1) throw new Error('Unexpected archive layout: ' + top.join(', '));
  return { tmp, dir: path.join(tmp, 'x', top[0]) };
}

function copyTree(from, to, rel = '') {
  let n = 0;
  for (const f of fs.readdirSync(from).sort()) {
    const r = rel ? rel + '/' + f : f;
    if (SKIP.some(re => re.test(r))) continue;
    const p = path.join(from, f);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { fs.mkdirSync(path.join(to, f), { recursive: true }); n += copyTree(p, path.join(to, f), r); }
    else { fs.copyFileSync(p, path.join(to, f)); n++; }
  }
  return n;
}

(async () => {
  const old = readMeta();
  const now = await resolve();
  const changed = !old || old.commit !== now.commit;
  const compare = old && changed ? 'https://github.com/' + REPO + '/compare/' + old.commit + '...' + now.commit : '';

  if (check) {
    if (!changed) console.log('Up to date: ' + REPO + ' ' + now.ref + ' (' + now.commit.slice(0, 7) + ')');
    else console.log((wanted ? 'Differs: ' : 'Newer: ') + REPO + ' ' + now.ref + ' (' + now.commit.slice(0, 7) + '), here ' + (old ? old.ref + ' (' + old.commit.slice(0, 7) + ')' : 'nothing') + (compare ? '\n  ' + compare : ''));
    output({ changed, ref: now.ref, old: old ? old.commit : '', new: now.commit, compare });
    process.exit(changed ? 1 : 0);
  }

  console.log('Fetching ' + REPO + ' ' + now.ref + ' (' + now.commit + ')');
  const { tmp, dir } = await download(now.commit);
  try {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    const n = copyTree(dir, dest);
    console.log('Wrote upstream/steam-enhanced (' + n + ' files)');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // digest: what tools/check.js holds the folder to (tools/se-digest.js)
  const meta = { repo: REPO, ref: now.ref, commit: now.commit, date: now.date, digest: digest(dest).digest };
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');
  console.log('Wrote upstream/steam-enhanced.json' + (changed ? (old ? ' (was ' + old.ref + ')' : '') : ' (same version as before)'));
  output({ changed, ref: now.ref, old: old ? old.commit : '', new: now.commit, compare });
})().catch(e => { console.error('Error: ' + e.message); process.exit(2); });
