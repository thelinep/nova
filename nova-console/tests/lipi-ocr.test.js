'use strict';
// Lipi OCR: the shipped model and its readings of the gallery, the missing-tools message,
// input checks, and (where Python has onnxruntime and OpenCV) a real local reading.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ocr-'));
process.env.DATA_DIR = dir;
const ocr = require('../lib/lipi-ocr');
const gallery = require('../lib/lipi-gallery');

test('the shipped model, its alphabet and the gallery readings', () => {
  const m = ocr.model();
  assert.ok(fs.existsSync(m.file) && fs.statSync(m.file).size > 1e6, 'model file');
  assert.equal(m.custom, false);
  const meta = JSON.parse(fs.readFileSync(m.file.replace(/\.onnx$/, '.json'), 'utf8'));
  assert.equal(meta.height, 40); assert.ok(meta.charset.length >= 60);
  assert.ok(meta.charset.includes('\u{11013}') && meta.charset.includes('\u{11046}'), 'ka and virama');
  const s = ocr.status();
  for (const it of gallery.gallery().items) {
    const r = s.readings[it.id];
    assert.ok(r, 'reading for ' + it.id);
    assert.ok(Array.isArray(r.lines) && typeof r.confidence === 'number');
    for (const l of r.lines) { assert.match(l.text, /^[\u{11000}-\u{1107F}]+$/u, it.id + ' Brahmi only'); assert.equal(typeof l.deva, 'string'); }
  }
  assert.ok(s.evaluation && s.evaluation.lumbini && typeof s.evaluation.lumbini.CER === 'number');
  assert.ok(s.summary.images === gallery.gallery().total);
});

test('input checks and the missing-tools message', async () => {
  await assert.rejects(ocr.read({}), e => e.statusCode === 400);
  await assert.rejects(ocr.read({ image: 'data:text/plain;base64,aGk=' }), e => e.statusCode === 400);
  await assert.rejects(ocr.read({ gallery: 'nope' }), e => e.statusCode === 404);
  const saved = { py: process.env.NOVA_OCR_PYTHON, path: process.env.PATH, home: process.env.HOME };
  process.env.NOVA_OCR_PYTHON = '/nonexistent/python'; process.env.PATH = '/nonexistent'; process.env.HOME = dir; ocr._reset();
  try {
    assert.equal(ocr.findPython().found, false);
    await assert.rejects(ocr.read({ gallery: 'lumbini' }), e => e.statusCode === 412 && /Install OCR/.test(e.message));
  } finally {
    process.env.PATH = saved.path; process.env.HOME = saved.home;
    if (saved.py === undefined) delete process.env.NOVA_OCR_PYTHON; else process.env.NOVA_OCR_PYTHON = saved.py;
    ocr._reset();
  }
});

test('a real local reading of the Lumbini inscription (skipped without onnxruntime and OpenCV)', { timeout: 120000 }, async t => {
  if (!ocr.findPython().found) { t.skip('Python with onnxruntime and OpenCV is not installed here'); return; }
  const r = await ocr.read({ gallery: 'lumbini' });
  assert.ok(r.lines.length >= 3, 'finds the lines');
  assert.ok(r.lines.every(l => /^[\u{11000}-\u{1107F}]+$/u.test(l.text)));
  assert.ok(r.lines[0].deva.length > 0);
});

test('HTTP: OCR status route on a temporary data folder', { timeout: 30000 }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ocr-http-'));
  const child = spawn(process.execPath, ['--no-warnings', '-e', "require('./server');"], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0', DATA_DIR: data, OLLAMA_HOST: 'http://127.0.0.1:9', NOVA_LIBRARY_DIR: path.join(data, 'library') }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const base = await new Promise((resolve, reject) => { let out = ''; const tm = setTimeout(() => reject(new Error('Startup timeout: ' + out)), 15000); child.stdout.on('data', d => { out += d; const m = out.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/); if (m) { clearTimeout(tm); resolve(m[1]); } }); child.stderr.on('data', d => { out += d; }); child.once('exit', c => reject(new Error('exited ' + c + ': ' + out))); });
    const req = (method, p, body) => new Promise((resolve, reject) => { const r = http.request(base + p, { method, headers: { Origin: base, 'Content-Type': 'application/json' } }, res => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(c).toString()); } catch (_) { json = null; } resolve({ status: res.statusCode, json }); }); }); r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end(); });
    const s = await req('GET', '/api/lipi/ocr');
    assert.equal(s.status, 200); assert.ok(s.json.readings.lumbini); assert.equal(typeof s.json.python, 'boolean');
    assert.equal((await req('POST', '/api/lipi/ocr/read', { image: 'nope' })).status, 400);
  } finally { child.kill('SIGTERM'); }
});
