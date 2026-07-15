// Inline demo-data.json into the page so it is a single self-contained file:
// no server, no fetch, no wallet, no key. Judges open one file.
import { readFileSync, writeFileSync } from 'node:fs';
const tpl = readFileSync('web/index.template.html', 'utf8');
const data = readFileSync('web/demo-data.json', 'utf8');
const out = tpl.replace('/*__DATA__*/ null', data.trim());
if (out === tpl) { console.error('FAIL: data placeholder not found'); process.exit(1); }
writeFileSync('web/index.html', out);
console.log(`web/index.html written (${(out.length/1024).toFixed(0)} KB, self-contained)`);
