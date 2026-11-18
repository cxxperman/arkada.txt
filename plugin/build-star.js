// Builds dist-star/arkada.star with Millennium's own compiler (starlight) installed in this folder by `npm install`.
// Always with an explicit output folder: starlight never looks for the Steam folder and never touches a running Steam.
//
// Windows starts a program only if its full path is shorter than 260 characters. When this folder sits deeper
// than that (starlight's own npm launcher then fails without a word), the compiler is copied next to this file
// under a short name for the time of the build.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

process.chdir(__dirname);
const win = os.platform() === 'win32';
const packaged = path.resolve('node_modules', '@steambrew', 'starlight', 'binaries', `starlight-${os.platform()}-${os.arch()}${win ? '.exe' : ''}`);
if (!fs.existsSync(packaged)) { console.error('No starlight here: run `npm install` in ' + __dirname); process.exit(1); }
if (/^\s*\[dev\]|output_path\s*=\s*"auto"/m.test(fs.readFileSync('millennium.toml', 'utf8').replace(/^\s*#.*$/gm, ''))) {
  console.error('millennium.toml must have no [dev] section and no output_path = "auto": they make starlight write into Steam.');
  process.exit(1);
}

let exe = packaged, copy = null;
if (win && packaged.length >= 250) {
  copy = path.resolve('sl.exe');
  fs.copyFileSync(packaged, copy);
  exe = copy;
  console.log('Path too long for Windows (' + packaged.length + ' characters): running a copy of starlight as ' + copy);
}
fs.mkdirSync('dist-star', { recursive: true });
let r = spawnSync(exe, ['pack', '--release', '-o', 'dist-star'], { stdio: 'inherit' });
// The script Millennium will run from the packed file, taken back out of it — so that the tests can run exactly it
if (r.status === 0) {
  const q = spawnSync(exe, ['--if', path.join('dist-star', 'arkada.star'), '-q', 'frontend:bundle.js'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (q.status === 0 && q.stdout) { fs.writeFileSync(path.join('dist-star', 'bundle.js'), q.stdout); console.log('Wrote plugin/dist-star/bundle.js (' + Buffer.byteLength(q.stdout) + ' bytes), the script inside arkada.star'); }
  else { console.error('Could not read the script back out of arkada.star'); r = q; }
}
if (copy) try { fs.unlinkSync(copy); } catch (e) { /* still held by the antivirus: harmless, removed next time */ }
if (r.error) console.error('Could not start starlight: ' + r.error.message);
process.exit(r.status === null ? 1 : r.status || 0);
