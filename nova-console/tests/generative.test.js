'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const media = require('../lib/media');
const transcriber = require('../lib/transcribe');
const imageGen = require('../lib/image-gen');
const { ensureFirstPartySkills, SKILLS } = require('../lib/first-party-skills');
const { runSkillSandboxed } = require('../lib/skill-runner');
const { buildSkillHost } = require('../lib/skill-host');

function store(){const s=new Map();return{all(n){return[...(s.get(n)?.values()||[])].map(r=>JSON.parse(JSON.stringify(r)));},get(n,id){const r=s.get(n)?.get(id);return r?JSON.parse(JSON.stringify(r)):null;},put(n,r){if(!s.has(n))s.set(n,new Map());s.get(n).set(r.id,JSON.parse(JSON.stringify(r)));return r;},delete(n,id){s.get(n)?.delete(id);}};}
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(32)]);
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
async function until(fn, ms = 10000){ const end = Date.now() + ms; for(;;){ const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 30)); } }

test('media store detects types from bytes, rejects others, and feeds images to chat', () => {
  const db = store(), dir = tmp('nova-media-');
  const image = media.saveMedia(db, dir, { buffer: PNG, originalName: 'frame.txt' });
  assert.equal(image.kind, 'image'); assert.equal(image.mime, 'image/png'); assert.equal(image.fileName.endsWith('.png'), true, 'extension comes from content, not the name');
  assert.equal(media.saveMedia(db, dir, { buffer: WAV, originalName: 'note.wav' }).kind, 'audio');
  assert.throws(() => media.saveMedia(db, dir, { buffer: Buffer.from('#!/bin/sh\nrm -rf /'), originalName: 'x.png' }), /Unsupported file type/);
  assert.throws(() => media.saveMedia(db, dir, { buffer: WAV, originalName: 'a', expectKind: 'image' }), /Expected an image/);
  assert.deepEqual(media.imagesForChat(db, dir, [image.id]), [PNG.toString('base64')]);
  assert.throws(() => media.imagesForChat(db, dir, [db.all('media').find(m => m.kind === 'audio').id]), /not an image/);
  media.deleteMedia(db, dir, image.id);
  assert.throws(() => media.getMedia(db, image.id), /Unknown media/);
});

test('transcription reports exactly what is missing, then runs whisper and files the transcript in Knowledge', async () => {
  const db = store(), dir = tmp('nova-tr-'), bin = tmp('nova-bin-');
  const saved = { ...process.env };
  try {
    process.env.PATH = bin; delete process.env.WHISPER_BIN; delete process.env.WHISPER_MODEL; delete process.env.FFMPEG_BIN;
    const missing = transcriber.status(dir);
    assert.equal(missing.ready, false);
    assert.equal(missing.missing.length, 3);
    // Fake ffmpeg copies input to output; fake whisper writes whisper.cpp -oj JSON.
    fs.writeFileSync(path.join(bin, 'ffmpeg'), '#!/bin/sh\nin="";out=""\nwhile [ $# -gt 0 ]; do case "$1" in -i) in="$2"; shift;; esac; out="$1"; shift; done\n/bin/cp "$in" "$out"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'whisper-cli'), `#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -of) of="$2"; shift;; esac; shift; done\n/bin/cat > "$of.json" <<'J'\n{"transcription":[{"offsets":{"from":0,"to":2500},"text":" Rolling on scene four."},{"offsets":{"from":62000,"to":65000},"text":" Cut, moving on."}]}\nJ\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(dir, 'models', 'whisper'), { recursive: true }); fs.writeFileSync(path.join(dir, 'models', 'whisper', 'ggml-base.en.bin'), 'x');
    assert.equal(transcriber.status(dir).ready, true);
    db.put('knowledgeCollections', { id: 'kc_dailies', name: 'Dailies' });
    const audio = media.saveMedia(db, dir, { buffer: WAV, originalName: 'take4.wav' });
    const ingested = [];
    const { record, done } = transcriber.start(db, dir, { ollama: {}, ingestDocument: async (_s, _o, doc) => { ingested.push(doc); return { document: { id: 'kd_1' } }; } }, audio.id, { collectionId: 'kc_dailies', language: 'en' });
    assert.equal(record.transcription.status, 'running');
    await done;
    const after = db.get('media', audio.id);
    assert.equal(after.transcription.status, 'done', after.transcription.error);
    assert.equal(after.transcript.text, '[00:00:00] Rolling on scene four.\n[00:01:02] Cut, moving on.');
    assert.equal(after.transcription.knowledgeDocumentId, 'kd_1');
    assert.equal(ingested[0].name, 'take4.wav (transcript)');
    const image = media.saveMedia(db, dir, { buffer: PNG, originalName: 'x.png' });
    assert.throws(() => transcriber.start(db, dir, {}, image.id), /Only audio/);
  } finally { process.env = saved; }
});

test('image generation drives ComfyUI and saves each image with its recipe', async () => {
  const graphs = [];
  const server = http.createServer((req, res) => {
    const json = body => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/system_stats') return json({ system: { comfyui_version: 'test' }, devices: [{ name: 'mps' }] });
    if (req.url === '/object_info/CheckpointLoaderSimple') return json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl.safetensors', 'sd15.safetensors']] } } } });
    if (req.url === '/prompt') { let b = ''; req.on('data', c => b += c); req.on('end', () => { graphs.push(JSON.parse(b).prompt); json({ prompt_id: 'p1' }); }); return; }
    if (req.url === '/history/p1') return json({ p1: { status: { status_str: 'success' }, outputs: { '9': { images: [{ filename: 'nova_0001.png', subfolder: '', type: 'output' }] } } } });
    if (req.url.startsWith('/view?')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const saved = process.env.COMFYUI_URL;
  process.env.COMFYUI_URL = 'http://127.0.0.1:' + server.address().port;
  try {
    const status = await imageGen.status();
    assert.deepEqual(status.checkpoints, ['sdxl.safetensors', 'sd15.safetensors']);
    const db = store(), dir = tmp('nova-gen-');
    await assert.rejects(() => imageGen.generate(db, dir, { prompt: '' }), /Describe the image/);
    await assert.rejects(() => imageGen.generate(db, dir, { prompt: 'x', checkpoint: 'missing.ckpt' }), /Unknown checkpoint/);
    const { job, done } = await imageGen.generate(db, dir, { prompt: 'Rain-soaked Mumbai street at dusk, anamorphic', negative: 'blurry', width: 1000, height: 600, steps: 30, cfg: 6.5, seed: 42, checkpoint: 'sdxl.safetensors' });
    await done;
    const finished = db.get('generationJobs', job.id);
    assert.equal(finished.status, 'done', finished.error);
    const image = db.get('media', finished.mediaIds[0]);
    assert.equal(image.source, 'comfyui');
    assert.deepEqual([image.provenance.seed, image.provenance.steps, image.provenance.width, image.provenance.height, image.provenance.checkpoint], [42, 30, 1000, 600, 'sdxl.safetensors']);
    assert.equal(graphs[0]['3'].inputs.seed, 42);
    assert.equal(graphs[0]['6'].inputs.text, 'Rain-soaked Mumbai street at dusk, anamorphic');
    assert.equal(fs.readFileSync(media.filePath(dir, image)).equals(PNG), true);
  } finally { process.env.COMFYUI_URL = saved; if (saved === undefined) delete process.env.COMFYUI_URL; server.close(); }
});

test('image generation refuses non-local ComfyUI addresses and reports an unreachable server', async () => {
  const saved = process.env.COMFYUI_URL;
  try {
    process.env.COMFYUI_URL = 'https://images.example.com';
    assert.equal((await imageGen.status()).reachable, false);
    await assert.rejects(() => imageGen.generate(store(), tmp('g-'), { prompt: 'x' }), /must run on this computer/);
    process.env.COMFYUI_URL = 'http://127.0.0.1:9';
    const s = await imageGen.status();
    assert.equal(s.reachable, false); assert.match(s.error, /not reachable/);
  } finally { process.env.COMFYUI_URL = saved; if (saved === undefined) delete process.env.COMFYUI_URL; }
});

test('first-party pre-production skills are added to existing installs only', () => {
  const fresh = store();
  assert.equal(ensureFirstPartySkills(fresh), 0);
  const existing = store(); existing.put('skills', { id: 'skl_codelint' }); existing.put('skills', { id: 'skl_shotlist', enabled: false });
  assert.equal(ensureFirstPartySkills(existing), 2);
  assert.equal(existing.get('skills', 'skl_shotlist').enabled, false, 'existing choices are kept');
  assert.equal(SKILLS.length, 3);
});

function fakeOllama(replies, calls){ return { chatFull: async (model, messages, opts) => { calls.push({ model, messages, opts }); return { message: { content: replies.shift() } }; } }; }
function skillFor(id, db){ const def = SKILLS.find(s => s.id === id); const rec = require('../lib/first-party-skills').record(def); db.put('skills', rec); return rec; }

test('shot list skill returns validated JSON, a Markdown table, and repairs once', async () => {
  const db = store(); db.put('models', { id: 'llama3:latest', runtime: 'ollama' });
  const skill = skillFor('skl_shotlist', db), calls = [];
  const good = { title: 'Monsoon', scenes: [{ scene: '1', heading: 'EXT. MARINE DRIVE - DUSK', shots: [{ shot: '1A', size: 'WS', angle: 'high', movement: 'drone push-in', description: 'City lights flicker on', durationSec: 6 }, { shot: '1B', size: 'CU', angle: 'eye level', movement: 'handheld', description: 'Asha looks at the sea', durationSec: 4 }] }] };
  const ollama = fakeOllama(['{"title":"Monsoon","scenes":[{"scene":"1","shots":[]}]}', JSON.stringify(good)], calls);
  const result = await runSkillSandboxed(skill, { text: 'Scene 1. Marine Drive at dusk. Asha watches the sea as the city lights come on.' }, async () => { throw new Error('no tools'); }, buildSkillHost(db, ollama, skill));
  assert.equal(result.repaired, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.format, 'json');
  assert.match(calls[1].messages[1].content, /previous reply was rejected: .*heading/);
  assert.match(result.markdown, /\| 1A \| WS \| high \| drone push-in \| TBC \| City lights flicker on \| 6 \|/);
  assert.match(result.markdown, /\*\*2 shots\*\*, about 0.2 minutes/);
});

test('treatment and call sheet skills render Markdown; a second invalid reply fails clearly', async () => {
  const db = store(); db.put('models', { id: 'llama3:latest', runtime: 'ollama' });
  const treatment = skillFor('skl_treatment', db);
  const t = { title: 'Monsoon', logline: 'A lifeguard...', synopsis: 'Asha...', characters: [{ name: 'Asha', description: 'lifeguard' }], structure: [{ part: 'Act 1', summary: 'The storm arrives.' }], themes: ['home'] };
  const r1 = await runSkillSandboxed(treatment, { text: 'brief', title: 'Monsoon' }, null, buildSkillHost(db, fakeOllama([JSON.stringify(t)], []), treatment));
  assert.match(r1.markdown, /^# Monsoon/); assert.match(r1.markdown, /- \*\*Asha:\*\* lifeguard/);
  const call = skillFor('skl_callsheet', db), calls = [];
  const c = { production: 'Monsoon', generalCall: '06:30', location: { name: 'Marine Drive' }, schedule: [{ time: '07:00', scene: '1', description: 'Dusk wides', cast: ['Asha'] }], notes: ['Tide at 18:40'] };
  const r2 = await runSkillSandboxed(call, { text: 'Day one at Marine Drive', date: '2026-10-02' }, null, buildSkillHost(db, fakeOllama([JSON.stringify(c)], calls), call));
  assert.match(r2.markdown, /Nearest hospital: TBC/);
  assert.match(calls[0].messages[1].content, /date: 2026-10-02/);
  await assert.rejects(() => runSkillSandboxed(call, { text: 'x' }, null, buildSkillHost(db, fakeOllama(['{}', 'not json'], []), call)), /still invalid after one repair/);
});
