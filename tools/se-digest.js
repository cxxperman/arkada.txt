// A fingerprint of upstream/steam-enhanced: sha256 over every file's path and contents, in sorted order.
// tools/upstream.js records it in upstream/steam-enhanced.json ("digest") as it writes the folder;
// tools/check.js recomputes it, so a hand edit of their code is caught before it ships.
// Line endings are read as LF, so a checkout with core.autocrlf gives the same digest.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function digest(dir) {
  const files = [];
  (function walk(d, rel) {
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f), r = rel ? rel + '/' + f : f;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p, r); else files.push([r, p]);
    }
  })(dir, '');
  const all = crypto.createHash('sha256');
  for (const [r, p] of files) {
    let buf = fs.readFileSync(p);
    if (!buf.includes(0)) buf = Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    all.update(r + '\0' + crypto.createHash('sha256').update(buf).digest('hex') + '\n');
  }
  return { digest: all.digest('hex'), files: files.length };
}

module.exports = { digest };

if (require.main === module) {
  const r = digest(process.argv[2] || path.join(__dirname, '..', 'upstream', 'steam-enhanced'));
  console.log(r.digest + '  (' + r.files + ' files)');
}
