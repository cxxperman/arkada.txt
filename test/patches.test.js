// tools/patches.js: our patches to Steam Enhanced (patches/*.patch) are applied, and a patch that no longer
// fits their code fails with a message that says where.   node test/patches.test.js
'use strict';
const path = require('path');
const { parse, applyFile, applyAll } = require(path.join(__dirname, '..', 'tools', 'patches.js'));

let passed = 0, failed = 0;
const ok = (cond, what, detail) => {
  if (cond) { passed++; console.log('  ok    ' + what); } else { failed++; console.log('  FAIL  ' + what + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
};

const patch = [
  'Free text: what and why.',
  '',
  '--- a/x.js',
  '+++ b/x.js',
  '@@ -2,3 +2,4 @@',
  ' two',
  '-three',
  '+THREE',
  '+three and a half',
  ' four',
  '',
].join('\n');
const files = parse(patch, 'test.patch');
ok(files.length === 1 && files[0].path === 'x.js' && files[0].hunks.length === 1, 'a patch file: free text, then a file diff with one hunk', files);
const src = 'one\ntwo\nthree\nfour\nfive\n';
ok(applyFile(src, files[0], 'test.patch') === 'one\ntwo\nTHREE\nthree and a half\nfour\nfive\n', 'the hunk is applied in place');
ok(applyFile('zero\n' + src, files[0], 'test.patch') === 'zero\none\ntwo\nTHREE\nthree and a half\nfour\nfive\n', 'their file moved by a line: the hunk is found where its lines are now');
ok(applyFile(src.replace(/\n/g, '\r\n'), files[0], 'test.patch') === 'one\r\ntwo\r\nTHREE\r\nthree and a half\r\nfour\r\nfive\r\n', 'CRLF files keep their line endings');
let msg = '';
try { applyFile(src.replace('three', 'tres'), files[0], 'test.patch'); } catch (e) { msg = e.message; }
ok(/test\.patch: hunk 1 of x\.js .*no longer matches/.test(msg), 'their code changed under the hunk → an error naming the patch, the file and the hunk', msg);

const done = applyAll(path.join(__dirname, '..', 'upstream', 'steam-enhanced'), { write: false });
ok(done.length >= 1, 'every patch in patches/ applies to upstream/steam-enhanced as it is', done);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
