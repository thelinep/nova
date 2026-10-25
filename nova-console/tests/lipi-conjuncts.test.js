'use strict';
// Conjunct shape editor: the glyph data the editor draws from, saving and checking edits,
// the missing-font-tools message, and the edited-font path the server serves.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-conjuncts-'));
process.env.DATA_DIR = dir;
const cj = require('../lib/lipi-conjuncts');

function memStore() {
  const m = new Map();
  return { get: (s, id) => m.get(s + '/' + id) || null, put: (s, r) => { m.set(s + '/' + r.id, r); return r; } };
}

test('data: outlines, attachment points and edges for the three scripts', () => {
  const d = cj.data(memStore());
  assert.deepEqual(Object.keys(d.scripts).sort(), ['Brah', 'Diak', 'Shrd']);
  const ka = d.scripts.Brah.letters['क'];
  assert.ok(ka.base.d.length > 20 && ka.sub.d.length > 20, 'paths');
  assert.equal(ka.base.attach.length, 2);
  assert.ok(['edge', 'middle', 'right edge'].some(r => String(ka.base.rule).includes(r.split(' ')[0])), 'rule ' + ka.base.rule);
  assert.equal(d.scripts.Brah.scale, 0.75);
  assert.deepEqual(d.overrides, {});
  assert.equal(d.fonts.Brah.edited, false);
});

test('save keeps real edits, drops zero moves and default sizes, and checks ranges', () => {
  const store = memStore();
  const r = cj.save(store, { scripts: { Brah: { pairs: { 'क+त': { dx: 60, dy: -30 }, 'क+य': { dx: 0, dy: 0 } }, scale: { 'त': 0.6, 'य': 0.75 } } } });
  assert.deepEqual(r.overrides, { Brah: { pairs: { 'क+त': { dx: 60, dy: -30 } }, scale: { 'त': 0.6 } } });
  assert.deepEqual(cj.data(store).overrides, r.overrides);
  assert.ok(cj.data(store).savedAt);
  const bad = [
    { Xxxx: {} },
    { Brah: { pairs: { 'क+Q': { dx: 1 } } } },
    { Brah: { pairs: { 'क+त': { dx: 900 } } } },
    { Brah: { scale: { 'त': 0.2 } } },
    { Brah: { scale: { 'त': 'big' } } },
  ];
  for (const scripts of bad) assert.throws(() => cj.save(store, { scripts }), e => e.statusCode === 400, JSON.stringify(scripts));
});

test('rebuild without font tools explains how to install them', async () => {
  const saved = { py: process.env.NOVA_FONT_PYTHON, path: process.env.PATH, home: process.env.HOME };
  process.env.NOVA_FONT_PYTHON = '/nonexistent/python';
  process.env.PATH = '/nonexistent';
  process.env.HOME = dir;
  try {
    assert.equal(cj.findPython().found, false);
    await assert.rejects(cj.rebuild(memStore()), e => e.statusCode === 412 && /Install font tools/.test(e.message));
  } finally {
    process.env.PATH = saved.path; process.env.HOME = saved.home;
    if (saved.py === undefined) delete process.env.NOVA_FONT_PYTHON; else process.env.NOVA_FONT_PYTHON = saved.py;
  }
});

test('editedFont serves only built Maataa Lipi fonts from the data folder', () => {
  assert.equal(cj.editedFont('/fonts/lipi/maataa-lipi-brahmi.woff2'), null);
  const out = path.join(dir, 'fonts', 'lipi');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'maataa-lipi-brahmi.woff2'), 'x');
  assert.equal(cj.editedFont('/fonts/lipi/maataa-lipi-brahmi.woff2'), path.join(out, 'maataa-lipi-brahmi.woff2'));
  assert.equal(cj.editedFont('/fonts/lipi/../../server.js'), null);
  assert.equal(cj.editedFont('/fonts/lipi/other.woff2'), null);
  assert.equal(cj.data(memStore()).fonts.Brah.edited, true);
  assert.deepEqual(cj.resetFonts(), { ok: true });
  assert.equal(cj.editedFont('/fonts/lipi/maataa-lipi-brahmi.woff2'), null);
});

test('HTTP: save, rebuild and serve the edited font on a temporary data folder', { timeout: 240000 }, async t => {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-conjuncts-http-'));
  const child = spawn(process.execPath, ['--no-warnings', '-e', "require('./server');"], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0', DATA_DIR: data, OLLAMA_HOST: 'http://127.0.0.1:9', NOVA_LIBRARY_DIR: path.join(data, 'library') }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const base = await new Promise((resolve, reject) => { let out = ''; const tm = setTimeout(() => reject(new Error('Startup timeout: ' + out)), 15000); child.stdout.on('data', d => { out += d; const m = out.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/); if (m) { clearTimeout(tm); resolve(m[1]); } }); child.stderr.on('data', d => { out += d; }); child.once('exit', c => reject(new Error('exited ' + c + ': ' + out))); });
    const req = (method, p, body) => new Promise((resolve, reject) => {
      const r = http.request(base + p, { method, headers: { Origin: base, 'Content-Type': 'application/json' } }, res => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => { const buf = Buffer.concat(c); let json = null; try { json = JSON.parse(buf.toString()); } catch (_) { json = null; } resolve({ status: res.statusCode, type: res.headers['content-type'], json, buf }); }); });
      r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end();
    });
    const g = await req('GET', '/api/lipi/conjuncts');
    assert.equal(g.status, 200); assert.ok(g.json.scripts.Brah.letters['त']);
    const shipped = await req('GET', '/fonts/lipi/maataa-lipi-brahmi.woff2');
    assert.equal(shipped.status, 200);
    const s = await req('POST', '/api/lipi/conjuncts', { scripts: { Brah: { pairs: { 'क+त': { dx: 60, dy: -30 } } } } });
    assert.equal(s.status, 200); assert.deepEqual(s.json.overrides.Brah.pairs['क+त'], { dx: 60, dy: -30 });
    assert.equal((await req('POST', '/api/lipi/conjuncts', { scripts: { Brah: { scale: { 'त': 3 } } } })).status, 400);
    if (!g.json.python) { t.diagnostic('font tools not installed here; rebuild checked for its message only'); assert.equal((await req('POST', '/api/lipi/conjuncts/rebuild')).status, 412); return; }
    const b = await req('POST', '/api/lipi/conjuncts/rebuild');
    assert.equal(b.status, 200, JSON.stringify(b.json)); assert.equal(b.json.fonts.Brah.edited, true);
    const edited = await req('GET', '/fonts/lipi/maataa-lipi-brahmi.woff2');
    assert.equal(edited.status, 200); assert.equal(edited.type, 'font/woff2');
    assert.ok(!edited.buf.equals(shipped.buf), 'the edited font differs from the shipped one');
    assert.equal((await req('POST', '/api/lipi/conjuncts/reset-fonts')).json.ok, true);
    assert.ok((await req('GET', '/fonts/lipi/maataa-lipi-brahmi.woff2')).buf.equals(shipped.buf));
    assert.deepEqual((await req('GET', '/api/lipi/conjuncts')).json.overrides.Brah.pairs['क+त'], { dx: 60, dy: -30 }, 'edits survive a reset');
  } finally { child.kill('SIGTERM'); }
});
