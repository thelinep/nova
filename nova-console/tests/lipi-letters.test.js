'use strict';
// Lipi OS letters board: every converted character has a record, grammar follows the
// Paninian places and pratyaharas, sounds exist on disk, and the HTTP routes serve them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const letters = require('../lib/lipi-letters');

const SCRIPTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'lipi-scripts.json'), 'utf8'));
const byChar = ch => letters.board().letters.find(l => l.char === ch);

test('every character Lipi OS converts is on the board, once', () => {
  const keys = new Set(Object.values(SCRIPTS.scripts).flatMap(s => Object.keys(s.map)));
  const b = letters.board();
  assert.equal(b.letters.length, keys.size);
  assert.deepEqual(new Set(b.letters.map(l => l.char)), keys);
  assert.equal(b.boards.length, 14);
  for (const l of b.letters) assert.ok(b.boards.includes(l.board), l.char + ' sits on a known board');
});

test('grammar: places, voicing, aspiration and pratyaharas', () => {
  const k = byChar('क'), gh = byChar('घ'), ny = byChar('ञ'), v = byChar('व'), e = byChar('ए'), sh = byChar('श');
  assert.equal(k.grammar.sthana, 'कण्ठ'); assert.match(k.grammar.voicing, /अघोष/); assert.match(k.grammar.aspiration, /अल्पप्राण/);
  assert.deepEqual(k.grammar.pratyahara, ['हल्', 'खय्', 'खर्', 'चर्', 'झल्']);
  assert.match(gh.grammar.voicing, /^घोष/); assert.match(gh.grammar.aspiration, /महाप्राण/);
  assert.equal(ny.grammar.sthana, 'तालु + नासिका'); assert.ok(ny.grammar.pratyahara.includes('ञम्'));
  assert.equal(v.grammar.sthana, 'दन्तोष्ठ'); assert.ok(v.grammar.pratyahara.includes('यण्'));
  assert.equal(e.grammar.sthana, 'कण्ठतालु'); assert.deepEqual(e.grammar.pratyahara, ['अच्', 'एङ्', 'एच्']);
  assert.deepEqual(byChar('आ').grammar.pratyahara, byChar('अ').grammar.pratyahara, 'a long vowel joins its short savarna');
  assert.ok(sh.grammar.pratyahara.includes('शल्') && sh.grammar.pratyahara.includes('चर्'));
});

test('samples, renders and missing forms', () => {
  assert.equal(byChar('ि').sample, 'कि');
  assert.equal(byChar('ं').sample, 'अं');
  assert.equal(byChar('क').renders.Brah, '𑀓');
  const lla = byChar('ळ');
  assert.ok(lla.scripts.lacks.includes('Beng') && !lla.scripts.writes.includes('Beng'));
  assert.equal(lla.renders.Beng, undefined);
  assert.equal(letters.letter('U+0933').char, 'ळ');
  assert.throws(() => letters.letter('Q'), e => e.statusCode === 404);
});

test('every sound file the board names exists and is a small MP3', () => {
  const b = letters.board();
  const withSound = b.letters.filter(l => l.sound.file);
  assert.equal(withSound.length, b.counts.withSound);
  assert.ok(withSound.length >= 100);
  for (const l of withSound) {
    const f = path.join(__dirname, '..', 'public', l.sound.file);
    const buf = fs.readFileSync(f);
    assert.ok(buf.length > 1500 && buf.length < 60000, l.char + ' sound size');
    assert.ok(buf.subarray(0, 3).toString() === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0), l.char + ' is MP3');
  }
  for (const l of b.letters.filter(x => !x.sound.file)) assert.ok(['ऽ', '।', '॥', '॰'].includes(l.char), l.char + ' is silent by design');
});

test('HTTP: letters routes and MP3 type on a temporary data folder', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-letters-'));
  const child = spawn(process.execPath, ['--no-warnings', '-e', "require('./server');"], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0', DATA_DIR: dir, OLLAMA_HOST: 'http://127.0.0.1:9', NOVA_LIBRARY_DIR: path.join(dir, 'library') }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const base = await new Promise((resolve, reject) => { let out = ''; const t = setTimeout(() => reject(new Error('Startup timeout: ' + out)), 15000); child.stdout.on('data', d => { out += d; const m = out.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/); if (m) { clearTimeout(t); resolve(m[1]); } }); child.stderr.on('data', d => { out += d; }); child.once('exit', c => reject(new Error('exited ' + c + ': ' + out))); });
    const req = p => new Promise((resolve, reject) => { http.get(base + p, { headers: { Origin: base } }, res => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => { const t = Buffer.concat(c); let json = null; try { json = JSON.parse(t.toString()); } catch (_) { json = null; } resolve({ status: res.statusCode, type: res.headers['content-type'], json, size: t.length }); }); }).on('error', reject); });
    const all = await req('/api/lipi/letters');
    assert.equal(all.status, 200); assert.equal(all.json.counts.letters, all.json.letters.length); assert.equal(all.json.scripts.length, 23);
    assert.equal((await req('/api/lipi/letters/' + encodeURIComponent('क'))).json.iast, 'ka');
    assert.equal((await req('/api/lipi/letters/u+0915')).json.char, 'क');
    assert.equal((await req('/api/lipi/letters/Q')).status, 404);
    const mp3 = await req('/lipi-sounds/u0915.mp3');
    assert.equal(mp3.status, 200); assert.equal(mp3.type, 'audio/mpeg'); assert.ok(mp3.size > 1500);
  } finally { child.kill('SIGTERM'); }
});
