'use strict';
// Brahmi gallery: every image is on disk with a full credit, licences are open, and the routes serve it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const g = require('../lib/lipi-gallery');

const OPEN = new Set(['Public domain', 'CC0', 'CC BY 2.0', 'CC BY 4.0', 'CC BY-SA 2.0', 'CC BY-SA 3.0', 'CC BY-SA 4.0', 'GODL-India']);

test('every item has an image on disk, a credit, an open licence and a Commons source', () => {
  const d = g.gallery();
  assert.ok(d.total >= 50);
  const ids = new Set();
  for (const i of d.items) {
    assert.ok(!ids.has(i.id), 'unique id ' + i.id); ids.add(i.id);
    const f = path.join(__dirname, '..', 'public', i.image);
    const buf = fs.readFileSync(f);
    assert.ok(buf[0] === 0xff && buf[1] === 0xd8 && buf.length > 5000 && buf.length < 400000, i.id + ' is a JPEG of sane size');
    assert.ok(d.variants[i.variant], i.id + ' variant');
    assert.ok(i.credit.author && i.credit.author.length > 1, i.id + ' author');
    assert.ok(OPEN.has(i.credit.licence) || /^CC BY(-SA)? [0-9.]+( [a-z]{2})?$/.test(i.credit.licence), i.id + ' licence ' + i.credit.licence);
    if (!/^(Public domain|CC0)$/.test(i.credit.licence)) assert.match(i.credit.licenceUrl, /^https?:\/\//, i.id + ' licence link');
    assert.match(i.credit.source, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/, i.id + ' source');
    assert.ok(Number.isFinite(i.from) && i.from <= i.to, i.id + ' dates');
    assert.ok(i.title && i.site && i.dateLabel && i.note, i.id + ' text');
  }
  for (let k = 1; k < d.items.length; k++) assert.ok(d.items[k - 1].from <= d.items[k].from, 'oldest first');
  for (const k of Object.keys(d.variants)) assert.ok(d.counts[k] >= 1, 'variant ' + k + ' has an image');
  const credits = fs.readFileSync(path.join(__dirname, '..', 'public', 'lipi-brahmi', 'CREDITS.md'), 'utf8');
  for (const i of d.items) assert.ok(credits.includes(i.id + '.jpg'), i.id + ' in CREDITS.md');
});

test('filters, search and lookups', () => {
  assert.ok(g.gallery({ variant: 'tamil' }).items.every(i => i.variant === 'tamil'));
  assert.ok(g.gallery({ q: 'kalinga' }).items.some(i => i.id === 'dhauli'));
  assert.equal(g.item('lumbini').country, 'Nepal');
  assert.throws(() => g.item('nope'), e => e.statusCode === 404);
  assert.throws(() => g.gallery({ variant: 'xx' }), e => e.statusCode === 400);
});

test('HTTP: gallery routes and images on a temporary data folder', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-gallery-'));
  const child = spawn(process.execPath, ['--no-warnings', '-e', "require('./server');"], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0', DATA_DIR: dir, OLLAMA_HOST: 'http://127.0.0.1:9', NOVA_LIBRARY_DIR: path.join(dir, 'library') }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const base = await new Promise((resolve, reject) => { let out = ''; const t = setTimeout(() => reject(new Error('Startup timeout: ' + out)), 15000); child.stdout.on('data', d => { out += d; const m = out.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/); if (m) { clearTimeout(t); resolve(m[1]); } }); child.stderr.on('data', d => { out += d; }); child.once('exit', c => reject(new Error('exited ' + c + ': ' + out))); });
    const req = p => new Promise((resolve, reject) => { http.get(base + p, { headers: { Origin: base } }, res => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => { const t = Buffer.concat(c); let json = null; try { json = JSON.parse(t.toString()); } catch (_) { json = null; } resolve({ status: res.statusCode, type: res.headers['content-type'], json, size: t.length }); }); }).on('error', reject); });
    const all = await req('/api/lipi/brahmi-gallery?variant=ashokan');
    assert.equal(all.status, 200); assert.ok(all.json.items.length >= 10);
    assert.equal((await req('/api/lipi/brahmi-gallery/girnar')).json.variant, 'ashokan');
    assert.equal((await req('/api/lipi/brahmi-gallery/nope')).status, 404);
    const img = await req('/lipi-brahmi/girnar.jpg');
    assert.equal(img.status, 200); assert.equal(img.type, 'image/jpeg'); assert.ok(img.size > 5000);
  } finally { child.kill('SIGTERM'); }
});
