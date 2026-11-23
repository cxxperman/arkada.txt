// Builds the release archive that the installer of core.txt downloads.
//   npm run package   (= node tools/package.js)
// Runs the two builds (node tools/build-se.js → dist/arkada, node plugin/build.js → plugin/dist/arkada), then writes into release/:
//   arkada.zip                    (the file the installer takes; the release tag is v<version>)
//   arkada-<version>.zip          the same bytes under a name with the version
//                                 theme/  (dist/arkada)   plugin/  (plugin/dist/arkada, without .core-version)
//                                 manifest.json   THIRD_PARTY.md   LICENSE (only if the root has one)
//   arkada.zip.sha256, arkada-<version>.zip.sha256   hex sha256 of the archive
//   latest.json                   { version, file, sha256, size }
// The version is the one in plugin/plugin.json (the plugin is what Millennium loads and what a launcher reads
// back from the installed plugin.json); package.json carries the same number.
// The zip is written here, no dependencies: files sorted by path, fixed date, no extra fields, so two runs give
// the same bytes (and the same sha256).
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'release');
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));

// 1. The builds
for (const args of [['tools/build-se.js'], ['plugin/build.js']]) {
  execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
}

const version = readJson(path.join(root, 'plugin', 'plugin.json')).version;
if (!/^\d+\.\d+\.\d+([-+][\w.+-]+)?$/.test(version)) throw new Error('plugin/plugin.json: bad version ' + version);

// 2. The files of the archive: [path in the zip, bytes]
const entries = new Map();
function addDir(dir, prefix, skip) {
  if (!fs.existsSync(dir)) throw new Error('missing ' + path.relative(root, dir) + ' (the build did not make it)');
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile() && !(skip && skip(r))) entries.set(prefix + '/' + r, fs.readFileSync(path.join(d, e.name)));
    }
  })(dir, '');
}
addDir(path.join(root, 'dist', 'arkada'), 'theme');
addDir(path.join(root, 'plugin', 'dist', 'arkada'), 'plugin', r => r === '.core-version');
for (const f of ['THIRD_PARTY.md', 'LICENSE']) {
  if (fs.existsSync(path.join(root, f))) entries.set(f, fs.readFileSync(path.join(root, f)));
}
const manifest = {
  name: 'arkada',
  version,
  theme: { folder: 'arkada', installTo: 'millennium/themes/arkada' },
  plugin: { folder: 'arkada', installTo: 'millennium/plugins/arkada' },
  activeTheme: 'arkada',
  enablePlugin: 'arkada',
  replaces: ['size-on-disk', 'steam-share', 'kapsula', 'extendium'],
  // Kapsula opens its port only while its plugin.json is there, so its folder is never deleted
  keepFolders: ['kapsula'],
  minMillennium: null, // not known: Arkada was never run against a particular Millennium version
};
entries.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));

// 3. The zip
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01 00:00:00
function makeZip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const name of [...files.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const data = files.get(name), nameBuf = Buffer.from(name, 'utf8');
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const method = packed.length < data.length ? 8 : 0;
    const body = method === 8 ? packed : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x0800, 8); head.writeUInt16LE(method, 10);
    head.writeUInt16LE(DOS_TIME, 12); head.writeUInt16LE(DOS_DATE, 14); head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20); head.writeUInt32LE(data.length, 24); head.writeUInt16LE(nameBuf.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, nameBuf);
    parts.push(local, nameBuf, body);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
const zip = makeZip(entries);

// 4. release/
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const file = 'arkada.zip', fileV = `arkada-${version}.zip`;
const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
fs.writeFileSync(path.join(outDir, file), zip);
fs.writeFileSync(path.join(outDir, file + '.sha256'), sha256 + '\n');
fs.writeFileSync(path.join(outDir, fileV), zip);
fs.writeFileSync(path.join(outDir, fileV + '.sha256'), sha256 + '\n');
fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify({ version, file, sha256, size: zip.length }, null, 2) + '\n');
console.log(`release/${file} (and ${fileV})  ${zip.length} bytes  ${entries.size} files  sha256 ${sha256}`);
