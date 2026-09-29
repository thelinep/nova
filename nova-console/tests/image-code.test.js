'use strict';
/* Text from images (OCR) and image → page builds checked in a sandboxed browser. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ocr = require('../lib/ocr');
const i2c = require('../lib/image-to-code');
const activity = require('../lib/activity');
const chatTurn = require('../lib/chat-turn');
const media = require('../lib/media');
const { openDb, Store } = require('../lib/db');

const HAS_BROWSER = Boolean(i2c.findBrowser());
const HAS_OCR = ocr.engines().length > 0;
const CODE_PAGE = (bg = '#ffffff', fg = '#111111') => `<!doctype html><html><body style="margin:0;background:${bg};color:${fg};font:28px/1.5 monospace;padding:30px">
<div>function total(items) {</div><div>&nbsp;&nbsp;return items.length;</div><div>}</div><div style="margin-top:30px;background:#1e6fd9;color:#fff;padding:20px;width:300px">Book now</div></body></html>`;

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test('ocr.layout keeps reading order, rows and code indentation from Vision boxes', () => {
  // Vision: normalised boxes, y from the bottom.
  const items = [
    { t: 'return a + b;', c: 0.9, x: 0.14, y: 0.70, w: 0.26, h: 0.05 },
    { t: 'function add(a, b) {', c: 0.95, x: 0.10, y: 0.80, w: 0.40, h: 0.05 },
    { t: '}', c: 0.99, x: 0.10, y: 0.60, w: 0.02, h: 0.05 },
    { t: '// sums', c: 0.9, x: 0.55, y: 0.80, w: 0.14, h: 0.05 },
    { t: 'add(1, 2);', c: 0.9, x: 0.10, y: 0.35, w: 0.20, h: 0.05 },
  ];
  const r = ocr.layout(items);
  const lines = r.text.split('\n');
  assert.match(lines[0], /^function add\(a, b\) \{ +\/\/ sums$/, 'items on one row are joined left to right');
  assert.match(lines[1], /^ {2}return a \+ b;$/, 'indented by two characters');
  assert.equal(lines[2], '}');
  assert.equal(lines[3], '', 'a big vertical gap becomes a blank line');
  assert.equal(lines[4], 'add(1, 2);');
  assert.ok(r.confidence > 0.9);
  assert.equal(ocr.looksLikeCode(r.text), true);
  assert.equal(ocr.looksLikeCode('Dear team, the shoot moves to Friday.'), false);
});

test('ocr.recognize uses Apple Vision through osascript on macOS (runner stubbed)', { skip: process.platform !== 'darwin' }, async () => {
  const prev = ocr.setRunner(async (file, args) => { assert.match(file, /osascript$/); assert.equal(args[3], 'code'); return JSON.stringify([{ t: 'const x = 1;', c: 1, x: 0, y: 0.5, w: 0.3, h: 0.05 }]); });
  try { const png = path.join(tmp('nova-ocr-'), 'a.png'); fs.writeFileSync(png, 'x'); const r = await ocr.recognize(png, { mode: 'code' }); assert.equal(r.engine, 'apple-vision'); assert.equal(r.text, 'const x = 1;'); }
  finally { ocr.setRunner(prev); }
});

test('extractHtml, textRecall and wantsBuild', () => {
  assert.match(i2c.extractHtml('Sure!\n```html\n<!doctype html><html><body>Hi</body></html>\n```\nDone'), /^<!doctype html>/);
  assert.equal(i2c.extractHtml('no page here'), null);
  const r = i2c.textRecall('Book now for Friday', 'book now');
  assert.equal(r.missing.includes('friday'), true);
  assert.ok(r.recall > 0.4 && r.recall < 1);
  assert.equal(i2c.wantsBuild('Build this as an HTML page'), true);
  assert.equal(i2c.wantsBuild('recreate this landing page in react'), true);
  assert.equal(i2c.wantsBuild('/build'), true);
  assert.equal(i2c.wantsBuild('what does this error say?'), false);
});

test('render in a sandboxed browser, decode the PNG and compare images', { skip: !HAS_BROWSER, timeout: 60000 }, async () => {
  const dir = tmp('nova-render-');
  try {
    fs.writeFileSync(path.join(dir, 'a.html'), CODE_PAGE());
    fs.writeFileSync(path.join(dir, 'b.html'), CODE_PAGE('#222222', '#eeeeee'));
    fs.writeFileSync(path.join(dir, 'net.html'), '<!doctype html><html><body style="margin:0"><img src="https://example.com/x.png" onerror="document.body.style.background=\'#00ff00\'"></body></html>');
    const a = i2c.decodePng(fs.readFileSync(await i2c.render(path.join(dir, 'a.html'), path.join(dir, 'a.png'), { width: 600, height: 400 })));
    const a2 = i2c.decodePng(fs.readFileSync(await i2c.render(path.join(dir, 'a.html'), path.join(dir, 'a2.png'), { width: 600, height: 400 })));
    const b = i2c.decodePng(fs.readFileSync(await i2c.render(path.join(dir, 'b.html'), path.join(dir, 'b.png'), { width: 600, height: 400 })));
    assert.equal(a.width, 600); assert.equal(a.height, 400);
    assert.ok(i2c.compareImages(a, a2).similarity > 0.99);
    const diff = i2c.compareImages(a, b);
    assert.ok(diff.similarity < 0.5, String(diff.similarity));
    assert.ok(diff.regions.length > 0 && diff.colourNotes.length > 0);
    // The network is blocked: the image fails to load, so onerror paints the page green.
    const net = i2c.decodePng(fs.readFileSync(await i2c.render(path.join(dir, 'net.html'), path.join(dir, 'net.png'), { width: 200, height: 100 })));
    const o = (80 * net.width + 150) * 3; // away from the broken-image icon
    assert.deepEqual([...net.rgb.subarray(o, o + 3)], [0, 255, 0]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ocr.recognize reads code from a rendered screenshot (tesseract here, Apple Vision on a Mac)', { skip: !HAS_BROWSER || !HAS_OCR, timeout: 60000 }, async () => {
  const dir = tmp('nova-ocr-real-');
  try {
    fs.writeFileSync(path.join(dir, 'a.html'), CODE_PAGE());
    const png = await i2c.render(path.join(dir, 'a.html'), path.join(dir, 'a.png'), { width: 700, height: 420 });
    const r = await ocr.recognize(png, { mode: 'code' });
    assert.match(r.text, /function total\(items\)/);
    assert.match(r.text, /return items\.length;/);
    assert.match(r.text, /Book now/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('buildFromImage: writes, renders, compares, feeds back the differences and keeps the best attempt', { skip: !HAS_BROWSER, timeout: 120000 }, async () => {
  const dataDir = tmp('nova-build-');
  try {
    fs.writeFileSync(path.join(dataDir, 'orig.html'), CODE_PAGE());
    const original = await i2c.render(path.join(dataDir, 'orig.html'), path.join(dataDir, 'orig.png'), { width: 640, height: 400 });
    const seen = [];
    const ollama = { async chatFull(model, messages) {
      seen.push(messages);
      // First try: wrong colours. Second: right.
      return { message: { content: '```html\n' + (seen.length === 1 ? CODE_PAGE('#222222', '#eeeeee') : CODE_PAGE()) + '\n```' } };
    } };
    const steps = [];
    const job = { step: (label) => { const s = { label, status: 'running' }; steps.push(s); const api = { update() { return api; }, done(d) { s.status = 'done'; s.detail = d; return api; }, fail(e) { s.status = 'failed'; s.detail = String(e && e.message || e); return api; } }; return api; } };
    const b = await i2c.buildFromImage({ ollama, dataDir }, { model: 'v', imageFile: original, request: 'Build this page', canSee: true, ocrText: 'function total(items) { return items.length; } Book now' }, job);
    assert.equal(b.best, 2);
    assert.ok(b.similarity > 0.97, String(b.similarity));
    assert.equal(b.attempts.length, 2, 'stops once it looks right');
    assert.ok(b.attempts[0].similarity < 0.6);
    assert.match(seen[1][seen[1].length - 1].content, /looks \d+% alike/);
    assert.equal(seen[1][seen[1].length - 1].images.length, 2, 'the fix sees the original and its own render');
    assert.ok(steps.some(s => /sandboxed browser/.test(s.label)));
    assert.ok(fs.existsSync(i2c.buildFile(dataDir, b.id, 'index.html')));
    assert.ok(fs.existsSync(i2c.buildFile(dataDir, b.id, 'preview.png')));
    assert.throws(() => i2c.buildFile(dataDir, b.id, '../../etc/passwd'), /Not found/);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('chat turn: an attached image gives the model its exact text; a text-only model gets text, not pixels', { skip: !HAS_BROWSER || !HAS_OCR, timeout: 60000 }, async () => {
  activity._reset();
  const dataDir = tmp('nova-turn-img-');
  const { db } = openDb(dataDir); const store = new Store(db);
  try {
    activity.configure(store);
    fs.writeFileSync(path.join(dataDir, 'a.html'), CODE_PAGE());
    const png = await i2c.render(path.join(dataDir, 'a.html'), path.join(dataDir, 'a.png'), { width: 700, height: 420 });
    const rec = media.saveMedia(store, dataDir, { buffer: fs.readFileSync(png), originalName: 'code.png' });
    store.put('models', { id: 'txt', name: 'llama3', runtime: 'ollama', capabilities: ['completion'] });
    const calls = [];
    const ollama = { async chatStream(model, messages) { calls.push(messages); return { body: (async function* () { yield Buffer.from(JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n'); })() }; } };
    const events = [];
    await chatTurn.runTurn({ store, dataDir, ollama, media }, { sessionId: 's1', model: 'txt', followups: false, messages: [{ role: 'user', content: 'Extract the code from this screenshot', mediaIds: [rec.id] }] }, e => events.push(e));
    const sys = calls[0][0].content;
    assert.match(sys, /Text recognised in the attached image/);
    assert.match(sys, /return items\.length;/);
    assert.match(sys, /cannot see images/);
    assert.equal(calls[0][1].images, undefined, 'a text-only model is not sent pixels it would reject');
    const steps = events.filter(e => e.type === 'steps').pop().steps.map(s => s.label);
    assert.ok(steps.some(l => /Reading the text in code\.png/.test(l)), steps.join(' | '));
  } finally { activity._reset(); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
