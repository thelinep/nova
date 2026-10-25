'use strict';
// Brahmi report: the word list and its dhatus, finds with their areas in the picture, and the report routes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const A = require('../lib/lipi-analysis');
const ocr = require('../lib/lipi-ocr');

const LEX = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'lipi-brahmi-lexicon.json'), 'utf8'));

test('the word list: every category, Brahmi forms, and every verb traced to a Dhatupatha root', () => {
  const cats = new Set(LEX.entries.map(e => e.cat));
  for (const c of ['dhatu', 'sangya', 'sarvanaam', 'sankhya', 'jyamiti', 'antariksh', 'anya']) assert.ok(cats.has(c), c);
  for (const e of LEX.entries) for (const f of e.forms) assert.match(f.brahmi, /^[\u{11000}-\u{1107F}]+$/u, f.deva);
  for (const e of LEX.entries.filter(x => x.cat === 'dhatu')) {
    assert.match(e.dhatu.code || '', /^\d\d\.\d{4}$/, e.head + ' has a Dhatupatha number');
    assert.ok(e.dhatu.deva && e.dhatu.artha, e.head);
  }
  assert.equal(LEX.entries.find(e => e.head === 'कालापित').dhatu.code, '08.0010');
});

test('a made-up reading: finds, sure and possible, and their areas follow the line', () => {
  const s = require('../lib/lipi-scripts');
  const text = s.fromDeva('हिदबुधेजातेसक्यमुनीति', 'Brah').text;
  const aks = A.splitAksharas(text);
  const line = { text, conf: 0.95, poly: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.2], [0.1, 0.2]], aksharas: aks.map((t, i) => [t, i / aks.length, (i + 1) / aks.length]) };
  const r = A.analyse({ lines: [line] }, 'ashokan');
  const jate = r.finds.find(f => f.cat === 'dhatu' && f.head === 'जाते');
  assert.ok(jate && jate.sure, 'jāte found as a sure verb');
  assert.equal(jate.dhatu.deva, 'जनी');
  assert.ok(jate.area[0][0] > 0.1 && jate.area[1][0] < 0.9 && jate.area[0][1] === 0.1 && jate.area[2][1] === 0.2, 'area inside the line');
  assert.ok(r.finds.some(f => f.cat === 'sangya' && f.head === 'सक्यमुनि' && f.sure));
  assert.ok(r.finds.some(f => f.cat === 'sanyukta' && f.deva === 'क्य' && f.valid));
  assert.equal(r.letters.total, aks.length);
  const unsure = A.analyse({ lines: [{ ...line, conf: 0.5 }] }, 'ashokan');
  assert.ok(unsure.finds.filter(f => f.cat !== 'sanyukta').every(f => !f.sure), 'nothing is sure in a doubtful line');
  const gupta = A.analyse({ lines: [line] }, 'gupta');
  assert.ok(gupta.finds.every(f => !f.sure), 'nothing is sure in a variant the model does not read');
});

test('the gallery report: Lumbini verbs and per-category tables', () => {
  const rep = ocr.report();
  assert.ok(rep.categories.dhatu.some(e => e.key === 'जाते' && e.sure >= 1));
  assert.ok(rep.totals.letters > 1000);
  const lum = ocr.report('lumbini');
  assert.ok(lum.finds.some(f => f.cat === 'dhatu' && f.head === 'महीयिते' && f.sure && f.area));
  assert.ok(lum.lines.every(l => l.poly && l.poly.length === 4));
  assert.throws(() => ocr.report('nope'), e => e.statusCode === 404);
});

test('HTTP: report routes on a temporary data folder', { timeout: 30000 }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-report-'));
  const child = spawn(process.execPath, ['--no-warnings', '-e', "require('./server');"], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0', DATA_DIR: data, OLLAMA_HOST: 'http://127.0.0.1:9', NOVA_LIBRARY_DIR: path.join(data, 'library') }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const base = await new Promise((resolve, reject) => { let out = ''; const tm = setTimeout(() => reject(new Error('Startup timeout: ' + out)), 15000); child.stdout.on('data', d => { out += d; const m = out.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/); if (m) { clearTimeout(tm); resolve(m[1]); } }); child.stderr.on('data', d => { out += d; }); child.once('exit', c => reject(new Error('exited ' + c + ': ' + out))); });
    const get = p => new Promise((resolve, reject) => { http.get(base + p, { headers: { Origin: base } }, res => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(c).toString()); } catch (_) { json = null; } resolve({ status: res.statusCode, json }); }); }).on('error', reject); });
    const all = await get('/api/lipi/brahmi-report');
    assert.equal(all.status, 200); assert.ok(all.json.labels.dhatu); assert.ok(all.json.items.lumbini.counts);
    const one = await get('/api/lipi/brahmi-report/girnar');
    assert.equal(one.status, 200); assert.ok(one.json.finds.length > 0);
    assert.equal((await get('/api/lipi/brahmi-report/nope')).status, 404);
  } finally { child.kill('SIGTERM'); }
});
