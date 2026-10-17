'use strict';
// Stands in for scripts/image-to-mesh.py in tests: copies a small mesh to --out.
// NOVA_TRIPOSR_PYTHON=<node> NOVA_TRIPOSR_SCRIPT=<this file>. FAKE_TRIPOSR_FAIL=1 makes it fail.
const fs = require('node:fs'), path = require('node:path');
const a = process.argv.slice(2), arg = k => a[a.indexOf(k) + 1];
if (!fs.existsSync(arg('--image'))) { console.error('no image'); process.exit(2); }
console.log('PROGRESS Reading the picture (test)…');
if (process.env.FAKE_TRIPOSR_FAIL) { console.error('RuntimeError: out of memory'); process.exit(1); }
setTimeout(() => { fs.copyFileSync(path.join(__dirname, 'scan-mesh.glb'), arg('--out')); console.log('DONE'); }, Number(process.env.FAKE_TRIPOSR_MS || 50));
