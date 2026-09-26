'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const media = require('../lib/media');
const audio = require('../lib/audio-gen');
const imageGen = require('../lib/image-gen');

function store(){const s=new Map();return{all(n){return[...(s.get(n)?.values()||[])].map(r=>JSON.parse(JSON.stringify(r)));},get(n,id){const r=s.get(n)?.get(id);return r?JSON.parse(JSON.stringify(r)):null;},put(n,r){if(!s.has(n))s.set(n,new Map());s.get(n).set(r.id,JSON.parse(JSON.stringify(r)));return r;},delete(n,id){s.get(n)?.delete(id);}};}
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(32)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]);
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('voice: lists macOS voices and speaks text into an audio item with its recipe', async () => {
  assert.deepEqual(audio.parseVoices('Lekha               hi_IN    # नमस्ते, मेरा नाम लेखा है।\nSamantha            en_US    # Hello, my name is Samantha.\nnonsense line'),
    [{ name: 'Lekha', locale: 'hi_IN', sample: 'नमस्ते, मेरा नाम लेखा है।' }, { name: 'Samantha', locale: 'en_US', sample: 'Hello, my name is Samantha.' }]);
  const bin = tmp('nova-say-'), dir = tmp('nova-say-data-');
  fs.writeFileSync(path.join(bin, 'wav'), WAV);
  const fake = path.join(bin, 'say');
  fs.writeFileSync(fake, `#!/bin/sh\nif [ "$2" = "?" ]; then printf 'Lekha               hi_IN    # नमस्ते\\nSamantha            en_US    # Hello\\n'; exit 0; fi\necho "$@" > "${path.join(bin, 'args')}"\nwhile [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done\n/bin/cp "${path.join(bin, 'wav')}" "$out"\n`, { mode: 0o755 });
  const saved = { ...process.env };
  try {
    process.env.NOVA_SAY_BIN = fake; process.env.NOVA_AFCONVERT_BIN = 'none'; audio._resetVoices();
    const st = await audio.status();
    assert.equal(st.voice.ready, true); assert.deepEqual(st.voice.voices.map(v => v.name), ['Lekha', 'Samantha']);
    const db = store();
    assert.throws(() => audio.speak(db, dir, { text: '' }), /Type the words/);
    const { job, done } = audio.speak(db, dir, { text: 'आशा समुद्र को देखती है।', voice: 'Lekha', rate: 160 });
    await done;
    const fin = db.get('generationJobs', job.id);
    assert.equal(fin.status, 'done', fin.error);
    const item = db.get('media', fin.mediaIds[0]);
    assert.equal(item.kind, 'audio'); assert.equal(item.source, 'nova-voice');
    assert.deepEqual([item.provenance.voice, item.provenance.locale, item.provenance.rate], ['Lekha', 'hi_IN', 160]);
    assert.match(fs.readFileSync(path.join(bin, 'args'), 'utf8'), /-v Lekha -r 160 -f .*\.txt -o .*voice\.aiff/);
  } finally { process.env = saved; audio._resetVoices(); }
});

function fakeComfy(seen, { audioModels = true } = {}) {
  return http.createServer((req, res) => {
    const json = b => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    const list = (node, field, items) => json({ [node]: { input: { required: { [field]: [items] } } } });
    if (req.url === '/system_stats') return json({ system: { comfyui_version: 't' }, devices: [{ name: 'mps' }] });
    if (req.url === '/object_info/CheckpointLoaderSimple') return list('CheckpointLoaderSimple', 'ckpt_name', ['sd_xl_base_1.0.safetensors', ...(audioModels ? ['stable-audio-open-1.0.safetensors', 'ace_step_v1_3.5b.safetensors'] : [])]);
    if (req.url === '/object_info/CLIPLoader') return list('CLIPLoader', 'clip_name', audioModels ? ['t5-base.safetensors'] : []);
    if (['/object_info/EmptyLatentAudio', '/object_info/EmptyAceStepLatentAudio', '/object_info/SaveAudioMP3'].includes(req.url)) { const n = req.url.split('/').pop(); return json({ [n]: { input: { required: {} } } }); }
    if (req.url === '/upload/image') { req.resume(); req.on('end', () => json({ name: 'nova-src.png', subfolder: '', type: 'input' })); return; }
    if (req.url === '/prompt') { let b = ''; req.on('data', c => b += c); req.on('end', () => { seen.graphs.push(JSON.parse(b).prompt); json({ prompt_id: 'p' + seen.graphs.length }); }); return; }
    if (req.url.startsWith('/history/')) { const id = req.url.split('/').pop(); const g = seen.graphs[Number(id.slice(1)) - 1]; const isImage = Object.values(g).some(n => n.class_type === 'SaveImage'); return json({ [id]: { status: { status_str: 'success' }, outputs: { '9': isImage ? { images: [{ filename: 'nova_00001_.png', subfolder: '', type: 'output' }] } : { audio: [{ filename: 'nova_00001_.mp3', subfolder: 'audio', type: 'output' }] } } } }); }
    if (req.url.startsWith('/view?')) { res.writeHead(200); return res.end(req.url.includes('.mp3') ? MP3 : PNG); }
    res.writeHead(404); res.end();
  });
}

test('sound effects and music run the Stable Audio and ACE-Step graphs and save audio with recipes', async () => {
  const seen = { graphs: [] }, server = fakeComfy(seen);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const saved = process.env.COMFYUI_URL; process.env.COMFYUI_URL = 'http://127.0.0.1:' + server.address().port;
  try {
    const st = await audio.comfyStatus();
    assert.equal(st.sfx.ready, true, st.sfx.missing.join('; ')); assert.equal(st.music.ready, true);
    const db = store(), dir = tmp('nova-aud-');
    await assert.rejects(() => audio.generate(db, dir, 'sfx', { prompt: '' }), /Describe the sound/);
    const s = await audio.generate(db, dir, 'sfx', { prompt: 'monsoon rain on a tin roof', seconds: 99, seed: 3 });
    await s.done;
    const m = await audio.generate(db, dir, 'music', { prompt: 'cinematic, tabla, strings', seconds: 45 });
    await m.done;
    const [g1, g2] = seen.graphs;
    assert.deepEqual([g1['10'].inputs.type, g1['11'].inputs.seconds, g1['3'].inputs.seed, g1['19'].class_type], ['stable_audio', 47, 3, 'SaveAudioMP3']);
    assert.deepEqual([g2['14'].inputs.tags, g2['14'].inputs.lyrics, g2['17'].inputs.seconds, g2['51'].inputs.shift], ['cinematic, tabla, strings', '[instrumental]', 45, 5]);
    for (const { job } of [s, m]) {
      const fin = db.get('generationJobs', job.id);
      assert.equal(fin.status, 'done', fin.error);
      const item = db.get('media', fin.mediaIds[0]);
      assert.equal(item.kind, 'audio'); assert.equal(item.mime, 'audio/mpeg');
    }
    assert.equal(db.get('media', db.get('generationJobs', m.job.id).mediaIds[0]).provenance.engine, 'ace-step-v1-3.5b');
  } finally { process.env.COMFYUI_URL = saved; if (saved === undefined) delete process.env.COMFYUI_URL; server.close(); }
});

test('audio reports the missing model files', async () => {
  const seen = { graphs: [] }, server = fakeComfy(seen, { audioModels: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const saved = process.env.COMFYUI_URL; process.env.COMFYUI_URL = 'http://127.0.0.1:' + server.address().port;
  try {
    const st = await audio.comfyStatus();
    assert.match(st.sfx.missing.join(' '), /stable-audio-open.*t5-base/); assert.match(st.music.missing.join(' '), /ace_step/);
    await assert.rejects(() => audio.generate(store(), tmp('a-'), 'music', { prompt: 'x' }), /Music needs/);
  } finally { process.env.COMFYUI_URL = saved; if (saved === undefined) delete process.env.COMFYUI_URL; server.close(); }
});

test('image to image uploads the source and re-noises it by the chosen strength', async () => {
  const seen = { graphs: [] }, server = fakeComfy(seen);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const saved = process.env.COMFYUI_URL; process.env.COMFYUI_URL = 'http://127.0.0.1:' + server.address().port;
  try {
    const db = store(), dir = tmp('nova-i2i-');
    const src = media.saveMedia(db, dir, { buffer: PNG, originalName: 'india-gate.png' });
    const { job, done } = await imageGen.generateFromImage(db, dir, { mediaId: src.id, prompt: 'same view, heavy monsoon rain, night', strength: 0.4, seed: 5, checkpoint: 'sd_xl_base_1.0.safetensors' });
    await done;
    const g = seen.graphs[0];
    assert.equal(g['10'].inputs.image, 'nova-src.png');
    assert.deepEqual([g['3'].inputs.denoise, g['3'].inputs.seed, g['11'].class_type, g['11'].inputs.width, g['11'].inputs.height], [0.4, 5, 'ImageScale', 1024, 1024]);
    assert.deepEqual(g['12'].inputs.pixels, ['11', 0]);
    const fin = db.get('generationJobs', job.id);
    assert.equal(fin.status, 'done', fin.error);
    const out = db.get('media', fin.mediaIds[0]);
    assert.deepEqual([out.kind, out.provenance.mode, out.provenance.sourceMediaId, out.provenance.strength], ['image', 'img2img', src.id, 0.4]);
    assert.throws(() => imageGen.normaliseImg2Img(db, { mediaId: 'nope', prompt: 'x' }, ['a']), /Unknown media/);
  } finally { process.env.COMFYUI_URL = saved; if (saved === undefined) delete process.env.COMFYUI_URL; server.close(); }
});
