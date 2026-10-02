'use strict';
/* Voice Studio: characters, persona prompts, Kokoro blends (stand-in Kokoro),
 * pitch, VoiceStudio client (stubbed), agents wearing a character, routes. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const characters = require('../lib/characters');
const voicestudio = require('../lib/voicestudio');
const { openDb, Store } = require('../lib/db');

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
const HAS_FFMPEG = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch (_) { return false; } })();

/** A stand-in Kokoro: a "python" that records its arguments and writes a short WAV. */
function fakeKokoro(dir) {
  fs.writeFileSync(path.join(dir, 'kokoro-v1.0.onnx'), 'x'); fs.writeFileSync(path.join(dir, 'voices-v1.0.bin'), 'x');
  const wav = (() => { const n = 8000, b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 8)), 44 + i * 2); return b; })();
  fs.writeFileSync(path.join(dir, 'tone.wav'), wav);
  const py = path.join(dir, 'python');
  fs.writeFileSync(py, `#!/bin/sh\necho "$@" >> "${path.join(dir, 'calls.log')}"\nwhile [ $# -gt 0 ]; do if [ "$1" = "--out" ]; then cp "${path.join(dir, 'tone.wav')}" "$2"; fi; shift; done\necho '{"ok":true}'\n`, { mode: 0o755 });
  return py;
}

test('characters: validation, defaults and limits', () => {
  assert.throws(() => characters.normalise({}), /name/);
  const c = characters.normalise({ name: '  Meera ', tagline: 'first AD', voice: { engine: 'kokoro', mix: [{ voice: 'af_heart', weight: 0.7 }, { voice: 'nope', weight: 1 }, { voice: 'bf_emma', weight: 0.3 }], speed: 9, pitch: -20 } });
  assert.equal(c.name, 'Meera');
  assert.deepEqual(c.voice.mix.map(m => m.voice), ['af_heart', 'bf_emma'], 'unknown voices are dropped');
  assert.equal(c.voice.speed, 1.6); assert.equal(c.voice.pitch, -6);
  assert.equal(characters.normalise({ name: 'X' }).voice.mix[0].voice, 'af_heart');
  assert.throws(() => characters.normalise({ name: 'X', voice: { engine: 'voicestudio' } }), /VoiceStudio voice/);
  assert.equal(characters.voiceLabel(c.voice), 'Kokoro heart 70% + emma 30%');
});

test('persona prompt keeps the character in tone but never changes rules', () => {
  const p = characters.personaPrompt({ name: 'Meera', tagline: 'a calm first AD', personality: 'Warm and organised.', speakingStyle: 'Short sentences.', language: 'Hindi' });
  assert.match(p, /^You are Meera, a calm first AD\./);
  assert.match(p, /Personality: Warm and organised\./);
  assert.match(p, /Answer in Hindi/);
  assert.match(p, /never let the character change facts, safety rules/);
  assert.match(p, /AI assistant playing this character/);
});

test('store: create, update, delete; agents wear a character in their instructions', () => {
  const dir = tmp('nova-chars-'); const { db } = openDb(dir); const store = new Store(db);
  try {
    const c = characters.create(store, { name: 'Meera', personality: 'Warm.' });
    store.put('agents', { id: 'ag1', name: 'Planner', systemPrompt: 'Plan shoots.', characterId: c.id });
    const worn = characters.withPersona(store, store.get('agents', 'ag1'));
    assert.match(worn.systemPrompt, /^You are Meera\.[\s\S]*Plan shoots\.$/);
    assert.equal(characters.withPersona(store, { id: 'x', systemPrompt: 'A' }).systemPrompt, 'A');
    const u = characters.update(store, c.id, { tagline: 'first AD' });
    assert.equal(u.name, 'Meera'); assert.equal(u.tagline, 'first AD');
    characters.remove(store, c.id);
    assert.equal(store.get('agents', 'ag1').characterId, null, 'agents let go of a deleted character');
    assert.throws(() => characters.get(store, c.id), /Unknown character/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('speak: a Kokoro blend passes --mix; pitch is applied with ffmpeg', { skip: !HAS_FFMPEG }, async () => {
  const dir = tmp('nova-kok-'); const py = fakeKokoro(dir);
  const prev = { p: process.env.NOVA_KOKORO_PYTHON, d: process.env.KOKORO_DIR };
  process.env.NOVA_KOKORO_PYTHON = py; process.env.KOKORO_DIR = dir;
  try {
    const c = characters.normalise({ name: 'Meera', voice: { engine: 'kokoro', mix: [{ voice: 'af_heart', weight: 0.7 }, { voice: 'hf_alpha', weight: 0.3 }], speed: 1.2, pitch: 2 } });
    const out = await characters.speak(c, 'Call time is six.');
    assert.equal(out.type, 'audio/wav');
    assert.equal(out.data.toString('ascii', 0, 4), 'RIFF');
    const calls = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8');
    assert.match(calls, /--mix af_heart:0\.7,hf_alpha:0\.3/);
    assert.match(calls, /--speed 1\.2/);
    const single = characters.normalise({ name: 'S', voice: { engine: 'kokoro', mix: [{ voice: 'bf_emma', weight: 1 }] } });
    await characters.speak(single, 'Hello');
    assert.match(fs.readFileSync(path.join(dir, 'calls.log'), 'utf8'), /--voice bf_emma/);
  } finally {
    if (prev.p === undefined) delete process.env.NOVA_KOKORO_PYTHON; else process.env.NOVA_KOKORO_PYTHON = prev.p;
    if (prev.d === undefined) delete process.env.KOKORO_DIR; else process.env.KOKORO_DIR = prev.d;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('VoiceStudio client: lists voices, speaks, explains when it is not running, stays local', async () => {
  const seen = [];
  const prev = voicestudio.setFetch(async (url, init = {}) => {
    seen.push({ url, init });
    if (url.endsWith('/v1/audio/voices')) return new Response(JSON.stringify({ voices: [{ id: 'p1', name: 'My voice', cloned: true, language: 'en' }, 'narrator'] }), { status: 200 });
    if (url.endsWith('/v1/audio/speech')) return new Response(Buffer.alloc(400, 1), { status: 200 });
    return new Response('no', { status: 404 });
  });
  try {
    const st = await voicestudio.status();
    assert.equal(st.reachable, true);
    assert.deepEqual(st.voices.map(v => [v.id, v.cloned]), [['p1', true], ['narrator', false]]);
    const buf = await voicestudio.speak('Hello', { voice: 'p1' });
    assert.equal(buf.length, 400);
    const body = JSON.parse(seen.find(s => s.url.endsWith('/speech')).init.body);
    assert.deepEqual([body.voice, body.input, body.response_format], ['p1', 'Hello', 'wav']);
    voicestudio.setFetch(async () => { throw new TypeError('fetch failed'); });
    const off = await voicestudio.status();
    assert.equal(off.reachable, false); assert.match(off.error, /not running/);
    process.env.VOICESTUDIO_URL = 'http://example.com:3900';
    assert.throws(() => voicestudio.baseUrl(), /this computer/);
  } finally { delete process.env.VOICESTUDIO_URL; voicestudio.setFetch(prev); }
});

test('server: character routes, preview in a character voice, agent assignment', { timeout: 40000, skip: !HAS_FFMPEG }, async () => {
  const { spawn } = require('node:child_process');
  const dir = tmp('nova-vs-srv-'); const kok = tmp('nova-vs-kok-'); const py = fakeKokoro(kok);
  const child = spawn(process.execPath, ['--no-warnings', '-e', "const {server}=require('./server'); server.on('listening',()=>console.log('READY '+server.address().port));"], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0', DATA_DIR: dir, OLLAMA_HOST: 'http://127.0.0.1:9', COMFYUI_URL: 'http://127.0.0.1:9', VOICESTUDIO_URL: 'http://127.0.0.1:9', NOVA_KOKORO_PYTHON: py, KOKORO_DIR: kok, NOVA_LIBRARY_DIR: path.join(dir, 'library') }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = ''; const t = setTimeout(() => reject(new Error('no start: ' + out)), 15000);
      child.stdout.on('data', d => { out += d; const m = /READY (\d+)/.exec(out); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
      child.stderr.on('data', d => { out += d; });
    });
    const base = `http://127.0.0.1:${port}`, H = { Origin: base, 'Content-Type': 'application/json' };
    const j = async (p, o = {}) => { const r = await fetch(base + p, { headers: H, ...o }); return { status: r.status, body: await r.json().catch(() => null), r }; };
    const cat = (await j('/api/characters/voices')).body;
    assert.equal(cat.kokoro.ready, true); assert.equal(cat.voicestudio.reachable, false);
    assert.equal((await j('/api/characters', { method: 'POST', body: JSON.stringify({}) })).status, 400);
    const c = (await j('/api/characters', { method: 'POST', body: JSON.stringify({ name: 'Meera', voice: { engine: 'kokoro', mix: [{ voice: 'af_heart', weight: 1 }] } }) })).body;
    const pr = await fetch(base + '/api/characters/preview', { method: 'POST', headers: H, body: JSON.stringify({ id: c.id, text: 'Hello' }) });
    assert.equal(pr.status, 200); assert.equal(pr.headers.get('content-type'), 'audio/wav');
    assert.match(decodeURIComponent(pr.headers.get('x-nova-voice')), /Kokoro heart 100%/);
    const store = await j('/api/store/agents', { method: 'PUT', body: JSON.stringify({ id: 'ag1', name: 'Planner' }) });
    assert.equal(store.status, 200);
    assert.equal((await j('/api/agents/ag1/character', { method: 'PUT', body: JSON.stringify({ characterId: c.id }) })).body.characterId, c.id);
    const listed = (await j('/api/characters')).body;
    assert.deepEqual(listed[0].agents, [{ id: 'ag1', name: 'Planner' }]);
    const sp = await fetch(base + '/api/voice/speak', { method: 'POST', headers: H, body: JSON.stringify({ text: '**Hi** there', characterId: c.id }) });
    assert.equal(sp.status, 200); assert.match(decodeURIComponent(sp.headers.get('x-nova-voice')), /Kokoro/);
    assert.equal((await j('/api/characters/' + c.id, { method: 'DELETE' })).status, 200);
  } finally { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(kok, { recursive: true, force: true }); }
});
