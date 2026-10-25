'use strict';
// Indus signs board: every picture is on disk with a credit, every sign box lies inside its picture,
// groups and reference signs are consistent, and the routes serve the board.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const ind = require('../lib/lipi-indus');

test('pictures, credits, sign boxes and groups', () => {
  const d = ind.board();
  assert.ok(d.objects.length >= 25 && d.signs.length >= 80 && d.refs.length >= 15);
  for (const o of [...d.objects, ...d.refs]) {
    const buf = fs.readFileSync(path.join(__dirname, '..', 'public', o.image));
    assert.ok(buf[0] === 0xff && buf[1] === 0xd8, o.id + ' is a JPEG');
    assert.match(o.credit.source, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/, o.id);
    assert.ok(o.credit.author && o.credit.licence, o.id);
  }
  const ids = new Set(d.objects.map(o => o.id));
  for (const s of d.signs) {
    assert.ok(ids.has(s.object), s.id + ' object');
    assert.ok(d.groups[s.group], s.id + ' group');
    const [a, b, c, e] = s.box;
    assert.ok(a >= 0 && b >= 0 && c <= 1 && e <= 1 && a < c && b < e, s.id + ' box inside the picture');
  }
  for (const g of Object.values(d.groups)) for (const r of g.refs) assert.ok(d.refs.some(x => x.number === r), 'group points to a known reference sign ' + r);
  assert.deepEqual(d.signLists.map(l => l.signs), [417, 386, 694]);
  const credits = fs.readFileSync(path.join(__dirname, '..', 'public', 'lipi-indus', 'CREDITS.md'), 'utf8');
  for (const o of d.objects) assert.ok(credits.includes(o.id + '.jpg'), o.id + ' in CREDITS.md');
});

test('filters and lookups', () => {
  assert.ok(ind.board({ group: 'wheel' }).signs.every(s => s.group === 'wheel'));
  assert.throws(() => ind.board({ group: 'nope' }), e => e.statusCode === 400);
  assert.ok(ind.object('bm-impression').signs.length >= 5);
  assert.throws(() => ind.object('nope'), e => e.statusCode === 404);
});

test('HTTP: Indus routes on a temporary data folder', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-indus-'));
  const child = spawn(process.execPath, ['--no-warnings', '-e', "require('./server');"], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0', DATA_DIR: dir, OLLAMA_HOST: 'http://127.0.0.1:9', NOVA_LIBRARY_DIR: path.join(dir, 'library') }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const base = await new Promise((resolve, reject) => { let out = ''; const t = setTimeout(() => reject(new Error('Startup timeout: ' + out)), 15000); child.stdout.on('data', d => { out += d; const m = out.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/); if (m) { clearTimeout(t); resolve(m[1]); } }); child.stderr.on('data', d => { out += d; }); child.once('exit', c => reject(new Error('exited ' + c + ': ' + out))); });
    const get = p => new Promise((resolve, reject) => { http.get(base + p, { headers: { Origin: base } }, res => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => { const t = Buffer.concat(c); let json = null; try { json = JSON.parse(t.toString()); } catch (_) { json = null; } resolve({ status: res.statusCode, type: res.headers['content-type'], json, size: t.length }); }); }).on('error', reject); });
    const all = await get('/api/lipi/indus');
    assert.equal(all.status, 200); assert.equal(all.json.total, all.json.signs.length);
    assert.equal((await get('/api/lipi/indus/bm-impression')).json.id, 'bm-impression');
    assert.equal((await get('/api/lipi/indus/nope')).status, 404);
    const img = await get('/lipi-indus/bm-impression.jpg');
    assert.equal(img.status, 200); assert.equal(img.type, 'image/jpeg');
  } finally { child.kill('SIGTERM'); }
});
