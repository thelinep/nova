'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const media = require('../lib/media');
const transcriber = require('../lib/transcribe');
const imageGen = require('../lib/image-gen');
const edit = require('../lib/image-edit');
const actions = require('../lib/media-actions');
const timeline = require('../lib/timeline');
const boards = require('../lib/boards');
const audioGen = require('../lib/audio-gen');
const ltx = require('../lib/video-ltx');

function store(){const s=new Map();return{all(n){return[...(s.get(n)?.values()||[])].map(r=>JSON.parse(JSON.stringify(r)));},get(n,id){const r=s.get(n)?.get(id);return r?JSON.parse(JSON.stringify(r)):null;},put(n,r){if(!s.has(n))s.set(n,new Map());s.get(n).set(r.id,JSON.parse(JSON.stringify(r)));return r;},delete(n,id){s.get(n)?.delete(id);}};}
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ffmpegPath = () => transcriber.status(tmp('nova-ct-')).ffmpeg;
function make(ffmpeg, dir, name, args) { const f = path.join(dir, name); execFileSync(ffmpeg, ['-loglevel', 'error', '-y', ...args, f]); return fs.readFileSync(f); }

test('image sizes are read from PNG, JPEG and GIF bytes', t => {
  const ffmpeg = ffmpegPath(); if (!ffmpeg) return t.skip('ffmpeg is not installed');
  const dir = tmp('nova-size-');
  for (const ext of ['png', 'jpg', 'gif', 'webp']) {
    let buf; try { buf = make(ffmpeg, dir, 'a.' + ext, ['-f', 'lavfi', '-i', 'testsrc=size=640x360', '-frames:v', '1']); } catch (_) { continue; }
    assert.deepEqual(edit.imageSize(buf), { width: 640, height: 360 }, ext);
  }
  assert.throws(() => edit.imageSize(Buffer.from('nope')), /size of this image/);
});

test('expand plans keep the picture centred and SDXL-sized; masks and LoRAs wire into the graphs', () => {
  const p = edit.expandPlan(1024, 1024, '16:9');
  assert.ok(p.width > p.height && p.top === 0 && p.bottom === 0 && p.left > 0 && Math.abs(p.left - p.right) <= 8, JSON.stringify(p));
  assert.equal((p.width * p.height) > 0.9 * 1024 * 1024, true);
  for (const k of ['left', 'top', 'right', 'bottom', 'width', 'height']) assert.equal(p[k] % 8, 0, k);
  assert.throws(() => edit.expandPlan(1920, 1080, '16:9'), /already that shape/);
  const all = edit.expandPlan(800, 600, 'all'); assert.ok(all.left > 0 && all.top > 0);
  const s = { checkpoint: 'sdxl.safetensors', prompt: 'a red door', negative: '', steps: 20, cfg: 6, sampler: 'euler', scheduler: 'karras', seed: 1, width: 1024, height: 768, grow: 8, mode: 'edit', strength: 0.8, lora: 'asha.safetensors', loraStrength: 0.7 };
  const g = edit.inpaintGraph(s, 'src.png', 'mask.png');
  assert.equal(g['12'].class_type, 'SetLatentNoiseMask');
  assert.equal(g['3'].inputs.denoise, 0.8);
  assert.deepEqual(g['3'].inputs.model, ['30', 0], 'the sampler uses the LoRA model');
  assert.deepEqual(g['6'].inputs.clip, ['30', 1]);
  assert.equal(g['30'].inputs.lora_name, 'asha.safetensors');
  assert.deepEqual(g['17'].inputs.destination, ['11', 0], 'unpainted pixels are composited back');
  const r = edit.inpaintGraph({ ...s, mode: 'remove', strength: 1, lora: undefined }, 'src.png', 'mask.png');
  assert.equal(r['12'].class_type, 'VAEEncodeForInpaint'); assert.equal(r['30'], undefined);
  const o = edit.outpaintGraph({ ...s, ...p }, 'src.png');
  assert.equal(o['12'].class_type, 'ImagePadForOutpaint'); assert.deepEqual(o['13'].inputs.mask, ['12', 1]);
  const u = edit.upscaleGraph({ model: '4x-UltraSharp.pth', modelScale: 4, factor: 2 }, 'src.png');
  assert.equal(u['22'].inputs.scale_by, 0.5); assert.deepEqual(u['9'].inputs.images, ['22', 0]);
  assert.deepEqual([edit.modelScale('4x-UltraSharp.pth'), edit.modelScale('RealESRGAN_x2plus.pth'), edit.modelScale('foo.pth')], [4, 2, 4]);
  const tg = imageGen.graph({ ...s, batch: 1 });
  assert.deepEqual(tg['3'].inputs.model, ['30', 0]);
  assert.throws(() => imageGen.normalise({ prompt: 'x', lora: 'nope.safetensors' }, ['a.safetensors'], ['asha.safetensors']), /Unknown LoRA/);
  assert.equal(imageGen.normalise({ prompt: 'x', lora: 'asha.safetensors', loraStrength: 5 }, ['a.safetensors'], ['asha.safetensors']).loraStrength, 2);
});

test('upscale falls back to ffmpeg when ComfyUI is not running', async t => {
  const ffmpeg = ffmpegPath(); if (!ffmpeg) return t.skip('ffmpeg is not installed');
  const saved = process.env.COMFYUI_URL; process.env.COMFYUI_URL = 'http://127.0.0.1:9';
  try {
    const dir = tmp('nova-up-'), db = store();
    const img = media.saveMedia(db, dir, { buffer: make(ffmpeg, dir, 's.png', ['-f', 'lavfi', '-i', 'testsrc=size=320x180', '-frames:v', '1']), originalName: 'frame.png' });
    const { job, done } = await edit.upscale(db, dir, { mediaId: img.id, factor: 2 }, { ffmpeg });
    await done;
    const fin = db.get('generationJobs', job.id);
    assert.equal(fin.status, 'done', fin.error);
    const out = db.get('media', fin.mediaIds[0]);
    assert.deepEqual(edit.imageSize(fs.readFileSync(media.filePath(dir, out))), { width: 640, height: 360 });
    assert.equal(out.provenance.engine, 'ffmpeg-lanczos'); assert.match(out.originalName, /upscaled 2x/);
    await assert.rejects(edit.upscale(db, dir, { mediaId: img.id, factor: 4 }, {}), /upscale model|ffmpeg/);
  } finally { if (saved === undefined) delete process.env.COMFYUI_URL; else process.env.COMFYUI_URL = saved; }
});

test('enhance speech cleans audio and redoes only the sound of a video', async t => {
  const ffmpeg = ffmpegPath(); if (!ffmpeg) return t.skip('ffmpeg is not installed');
  const dir = tmp('nova-enh-'), db = store();
  const aud = media.saveMedia(db, dir, { buffer: make(ffmpeg, dir, 'a.wav', ['-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', '-f', 'lavfi', '-i', 'anoisesrc=d=2:a=0.05', '-filter_complex', 'amix=inputs=2']), originalName: 'dialogue.wav' });
  const vid = media.saveMedia(db, dir, { buffer: make(ffmpeg, dir, 'v.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac']), originalName: 'take3.mp4' });
  for (const [rec, kind] of [[aud, 'audio'], [vid, 'video']]) {
    const { job, done } = await actions.enhanceSpeech(db, dir, rec.id, { strength: 'strong' });
    await done;
    const fin = db.get('generationJobs', job.id);
    assert.equal(fin.status, 'done', fin.error);
    const out = db.get('media', fin.mediaIds[0]);
    assert.equal(out.kind, kind); assert.match(out.originalName, /speech enhanced/); assert.equal(out.provenance.strength, 'strong');
  }
  const a = actions.enhanceArgs({ kind: 'video' }, '/in.mp4', '/out.mp4', 'light');
  assert.ok(a.includes('copy') && a.includes('0:v:0'), 'the picture is copied, not re-encoded');
});

test('translate dubs each line at its start time over the original sound, and keeps an SRT', async t => {
  const ffmpeg = ffmpegPath(); if (!ffmpeg) return t.skip('ffmpeg is not installed');
  const dir = tmp('nova-tr-'), bin = tmp('nova-tr-bin-'), db = store();
  const saved = { ...process.env };
  try {
    // A fake `say` that writes one second of tone to -o, and a fake whisper that is never needed (the item has a transcript).
    const say = path.join(bin, 'say');
    fs.writeFileSync(say, `#!/bin/sh\nif [ "$1" = "-v" ] && [ "$2" = "?" ]; then echo "Lekha               hi_IN    # नमस्ते"; echo "Samantha            en_US    # Hello"; exit 0; fi\nwhile [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done\n"${ffmpeg}" -loglevel error -y -f lavfi -i sine=frequency=500:duration=1 -f aiff "$out"\n`, { mode: 0o755 });
    process.env.NOVA_SAY_BIN = say; process.env.KOKORO_DIR = path.join(bin, 'nokokoro'); audioGen._resetVoices();
    const vid = media.saveMedia(db, dir, { buffer: make(ffmpeg, dir, 'v.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=200:duration=4', '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac']), originalName: 'scene12.mp4' });
    const rec = db.get('media', vid.id);
    rec.transcript = { text: '', segments: [{ fromMs: 0, toMs: 1500, text: 'The storm is coming.' }, { fromMs: 2000, toMs: 3500, text: 'Close the windows.' }] };
    db.put('media', rec);
    db.put('models', { id: 'llama3:8b', name: 'llama3:8b', runtime: 'ollama', status: 'available' });
    const calls = [];
    const ollama = { chatFull: async (_m, msgs) => { calls.push(msgs); const lines = JSON.parse(msgs[1].content.split('\n')[0]).lines; return { message: { content: JSON.stringify({ lines: lines.map(l => 'हिंदी: ' + l) }) } }; } };
    assert.throws(() => actions.translate(db, dir, { ollama }, vid.id, {}), /Choose the language/);
    const { job, done } = actions.translate(db, dir, { ollama }, vid.id, { language: 'hi', mode: 'dub' });
    await done;
    const fin = db.get('generationJobs', job.id);
    assert.equal(fin.status, 'done', fin.error);
    const out = db.get('media', fin.mediaIds[0]);
    assert.equal(out.kind, 'video'); assert.equal(out.provenance.voice, 'Lekha', 'a Hindi voice is picked for Hindi');
    assert.match(out.provenance.srt, /00:00:02,000 --> 00:00:03,500\nहिंदी: Close the windows\./);
    assert.match(out.originalName, /Hindi dub/);
    const info = await actions.probe(ffmpeg, media.filePath(dir, out));
    assert.ok(info.hasAudio && info.hasVideo && info.duration > 3.5, JSON.stringify(info));
    assert.throws(() => actions.translate(db, dir, { ollama }, vid.id, { language: 'ja', mode: 'dub' }), /No Japanese voice/);
  } finally { process.env = saved; audioGen._resetVoices(); }
});

test('dub track: lines land at their start times; SRT times format correctly', () => {
  const pcm = Buffer.alloc(24000 * 2, 0); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
  const wav = actions.layTrack([{ atMs: 500, pcm }], 3000);
  const samples = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) / 2);
  assert.equal(samples[11000], 0); assert.equal(samples[12500], 1000); assert.equal(samples[37000], 0);
  assert.equal(actions.srtTime(3723004), '01:02:03,004');
});

test('timeline export: shots in order, sounds at their start, fitted to the frame', async t => {
  const ffmpeg = ffmpegPath(); if (!ffmpeg) return t.skip('ffmpeg is not installed');
  const dir = tmp('nova-tl-'), db = store();
  const still = media.saveMedia(db, dir, { buffer: make(ffmpeg, dir, 's.png', ['-f', 'lavfi', '-i', 'testsrc=size=640x640', '-frames:v', '1']), originalName: 'poster.png' });
  const clip = media.saveMedia(db, dir, { buffer: make(ffmpeg, dir, 'v.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac']), originalName: 'waves.mp4' });
  const music = media.saveMedia(db, dir, { buffer: make(ffmpeg, dir, 'm.wav', ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=10']), originalName: 'theme.wav' });
  const tl = timeline.normalise(db, { name: 'Scene 12', size: '1280x720', tracks: { video: [{ mediaId: still.id, seconds: 2 }, { mediaId: clip.id, in: 1, clipVolume: 0.5 }, { mediaId: 'missing' }], music: [{ mediaId: music.id, start: 0.5, volume: 0.4, fadeOut: 1 }], voice: [{ mediaId: still.id }] } });
  assert.equal(tl.tracks.video.length, 2, 'unknown media are dropped'); assert.equal(tl.tracks.voice.length, 0, 'stills cannot go on a sound track');
  db.put('timelines', tl);
  const plan = timeline.buildArgs(tl, { [still.id]: { file: '/s.png', duration: 0 }, [clip.id]: { file: '/v.mp4', duration: 3, hasAudio: true }, [music.id]: { file: '/m.wav', duration: 10, hasAudio: true } }, '/out.mp4');
  assert.equal(plan.duration, 4); assert.deepEqual(plan.shots.map(s => s.at), [0, 2]);
  const fc = plan.args[plan.args.indexOf('-filter_complex') + 1];
  assert.match(fc, /adelay=2000\|2000/); assert.match(fc, /adelay=500\|500/); assert.match(fc, /amix=inputs=2/); assert.match(fc, /force_original_aspect_ratio=decrease,pad=1280:720/);
  const { job, done } = timeline.exportTimeline(db, dir, tl.id);
  await done;
  const fin = db.get('generationJobs', job.id);
  assert.equal(fin.status, 'done', fin.error);
  const out = db.get('media', fin.mediaIds[0]);
  const info = await actions.probe(ffmpeg, media.filePath(dir, out));
  assert.ok(Math.abs(info.duration - 4) < 0.3 && info.hasAudio, JSON.stringify(info));
  assert.equal(out.provenance.shots.length, 2); assert.equal(out.provenance.sound[0].track, 'music');
});

test('boards keep valid items only', () => {
  const db = store(); db.put('media', { id: 'media_1', kind: 'image', originalName: 'a.png' });
  const b = boards.normalise(db, { name: ' Look book ', items: [{ type: 'media', mediaId: 'media_1', x: 10, y: 20, w: 5 }, { type: 'media', mediaId: 'gone' }, { type: 'note', text: 'Warm, dusty, 1970s' }, { type: 'color', color: '#AA3300' }, { type: 'script' }] });
  assert.equal(b.name, 'Look book'); assert.equal(b.items.length, 3); assert.equal(b.items[0].w, 40, 'sizes are clamped');
  const again = boards.normalise(db, { items: b.items }, b);
  assert.equal(again.id, b.id); assert.equal(again.items[0].id, b.items[0].id);
});

test('LTX-2 text to video: no image means no --image flag', () => {
  const db = store();
  const n = ltx.normalise(db, { prompt: 'a monsoon street at night, rain hiss', seconds: 3 });
  assert.equal(n.mediaId, null); assert.equal(n.input, 'text-to-video');
  assert.equal(ltx.args(n, null, '/o.mp4').includes('--image'), false);
});

test('Kokoro voices speak English and Hindi when installed', async t => {
  const dirK = process.env.NOVA_TEST_KOKORO_DIR || '/tmp/kk';
  if (!fs.existsSync(path.join(dirK, 'kokoro-v1.0.onnx'))) return t.skip('Kokoro is not installed here');
  const saved = { ...process.env };
  try {
    process.env.KOKORO_DIR = dirK; process.env.NOVA_KOKORO_PYTHON = path.join(dirK, '.venv', 'bin', 'python'); process.env.NOVA_AFCONVERT_BIN = 'none';
    const k = audioGen.kokoroStatus(); assert.equal(k.ready, true);
    assert.ok(k.voices.some(v => v.name === 'kokoro:hf_alpha' && v.locale === 'hi'));
    assert.equal(audioGen.voiceFor('hi'), 'kokoro:hf_alpha');
    const dir = tmp('nova-kk-'), db = store();
    const { job, done } = audioGen.speak(db, dir, { text: 'तूफ़ान आ रहा है।', voice: 'kokoro:hf_alpha' });
    await done;
    const fin = db.get('generationJobs', job.id);
    assert.equal(fin.status, 'done', fin.error);
    const out = db.get('media', fin.mediaIds[0]);
    assert.equal(out.kind, 'audio'); assert.equal(out.provenance.engine, 'kokoro-82m'); assert.equal(out.provenance.locale, 'hi');
  } finally { process.env = saved; }
});
