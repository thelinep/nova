'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const media = require('../lib/media');
const transcriber = require('../lib/transcribe');
const videoGen = require('../lib/video-gen');

function store(){const s=new Map();return{all(n){return[...(s.get(n)?.values()||[])].map(r=>JSON.parse(JSON.stringify(r)));},get(n,id){const r=s.get(n)?.get(id);return r?JSON.parse(JSON.stringify(r)):null;},put(n,r){if(!s.has(n))s.set(n,new Map());s.get(n).set(r.id,JSON.parse(JSON.stringify(r)));return r;},delete(n,id){s.get(n)?.delete(id);}};}
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
function iso(brand, handler) {
  const ftyp = Buffer.concat([u32(20), Buffer.from('ftyp' + brand), u32(0), Buffer.from(brand)]);
  const hdlr = handler ? Buffer.concat([u32(33), Buffer.from('hdlr'), u32(0), u32(0), Buffer.from(handler), Buffer.alloc(13)]) : Buffer.alloc(0);
  return Buffer.concat([ftyp, hdlr, Buffer.alloc(16)]);
}
const MP4 = iso('isom', 'vide');

test('media store tells MP4/MOV video from M4A audio by the track handler', () => {
  assert.deepEqual(media.sniff(MP4), { kind: 'video', mime: 'video/mp4', ext: '.mp4' });
  assert.deepEqual(media.sniff(iso('qt  ', 'vide')), { kind: 'video', mime: 'video/quicktime', ext: '.mov' });
  assert.equal(media.sniff(iso('M4A ', 'soun')).kind, 'audio');
  assert.equal(media.sniff(iso('isom', 'soun')).kind, 'audio', 'an isom file with only a sound track is audio');
  assert.equal(media.sniff(iso('M4A ', null)).kind, 'audio');
  const db = store(), dir = tmp('nova-v-');
  const clip = media.saveMedia(db, dir, { buffer: MP4, originalName: 'take.mp4' });
  assert.equal(clip.kind, 'video');
  assert.throws(() => media.saveMedia(db, dir, { buffer: MP4, originalName: 'x', expectKind: 'image' }), /Expected an image/);
});

test('camera moves: validates shots and builds one ffmpeg graph that joins them', () => {
  const db = store(), dir = tmp('nova-v-');
  const a = media.saveMedia(db, dir, { buffer: PNG, originalName: 'a.png' });
  const b = media.saveMedia(db, dir, { buffer: PNG, originalName: 'b.png' });
  const clip = media.saveMedia(db, dir, { buffer: MP4, originalName: 'c.mp4' });
  assert.throws(() => videoGen.normaliseMotion(db, { shots: [] }), /at least one image/);
  assert.throws(() => videoGen.normaliseMotion(db, { shots: [{ mediaId: clip.id }] }), /not an image/);
  const s = videoGen.normaliseMotion(db, { shots: [{ mediaId: a.id, move: 'pan-left', seconds: 2 }, { mediaId: b.id, move: 'nonsense', seconds: 99 }], size: '1920x1080', fps: 25 });
  assert.deepEqual(s.shots.map(x => [x.move, x.seconds]), [['pan-left', 2], ['push-in', 30]]);
  assert.equal(s.prompt, 'Animatic · 2 shots · 32s');
  const args = videoGen.motionArgs(s, ['/a.png', '/b.png'], '/out.mp4', ['-c:v', 'libx264']);
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /\[0:v\].*zoompan=z='1.2':x='\(iw-iw\/zoom\)\*\(1-on\/49\)'.*d=50:s=1920x1080:fps=25/);
  assert.match(graph, /\[v0\]\[v1\]concat=n=2:v=1:a=0\[out\]$/);
  assert.equal(args.at(-1), '/out.mp4');
});

test('camera moves render a real MP4 with ffmpeg and save it with its recipe', async t => {
  const dir = tmp('nova-v-');
  const ffmpeg = transcriber.status(dir).ffmpeg;
  if (!ffmpeg) return t.skip('ffmpeg is not installed');
  const still = path.join(dir, 'still.png');
  require('node:child_process').execFileSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180', '-frames:v', '1', still]);
  const db = store();
  const a = media.saveMedia(db, dir, { buffer: fs.readFileSync(still), originalName: 'frame.png' });
  const { job, done } = videoGen.startMotion(db, dir, { shots: [{ mediaId: a.id, move: 'push-in', seconds: 1 }, { mediaId: a.id, move: 'hold', seconds: 0.5 }], size: '1280x720' });
  assert.equal(job.status, 'running');
  await done;
  const finished = db.get('generationJobs', job.id);
  assert.equal(finished.status, 'done', finished.error);
  const clip = db.get('media', finished.mediaIds[0]);
  assert.equal(clip.kind, 'video'); assert.equal(clip.mime, 'video/mp4'); assert.equal(clip.source, 'nova-motion');
  assert.equal(clip.provenance.shots.length, 2); assert.equal(clip.provenance.seconds, 1.5);
});

function fakeComfy({ models = true, clip = ['umt5_xxl_fp8_e4m3fn_scaled.safetensors', 'umt5_xxl_fp16.safetensors'] } = {}, seen = {}) {
  return http.createServer((req, res) => {
    const json = body => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const list = (node, field, items) => json({ [node]: { input: { required: { [field]: [items] } } } });
    if (req.url === '/system_stats') return json({ system: { comfyui_version: 'test', os: 'darwin' }, devices: [{ name: 'mps' }] });
    if (req.url === '/object_info/Wan22ImageToVideoLatent') return json({ Wan22ImageToVideoLatent: { input: {} } });
    if (req.url === '/object_info/UNETLoader') return list('UNETLoader', 'unet_name', models ? ['flux.safetensors', 'wan2.2_ti2v_5B_fp16.safetensors'] : []);
    if (req.url === '/object_info/CLIPLoader') return list('CLIPLoader', 'clip_name', clip);
    if (req.url === '/object_info/VAELoader') return list('VAELoader', 'vae_name', models ? ['wan2.2_vae.safetensors'] : []);
    if (req.url === '/upload/image') { const parts = []; req.on('data', c => parts.push(c)); req.on('end', () => { seen.upload = Buffer.concat(parts); json({ name: 'nova-upload.png', subfolder: '', type: 'input' }); }); return; }
    if (req.url === '/prompt') { let b = ''; req.on('data', c => b += c); req.on('end', () => { seen.graph = JSON.parse(b).prompt; json({ prompt_id: 'v1' }); }); return; }
    if (req.url === '/history/v1') return json({ v1: { status: { status_str: 'success' }, outputs: { '12': { images: [{ filename: 'nova_00001_.mp4', subfolder: 'video', type: 'output' }], animated: [true] } } } });
    if (req.url.startsWith('/view?')) { seen.view = req.url; res.writeHead(200, { 'Content-Type': 'video/mp4' }); return res.end(MP4); }
    res.writeHead(404); res.end();
  });
}

test('AI motion names the missing Wan 2.2 files', async () => {
  const server = fakeComfy({ models: false, clip: [] });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const saved = process.env.COMFYUI_URL; process.env.COMFYUI_URL = 'http://127.0.0.1:' + server.address().port; process.env.NOVA_TOTAL_RAM_GB = '64'; // a large Mac, so the 16 GB Wan guard does not apply
  try {
    const s = await videoGen.aiStatus();
    assert.equal(s.reachable, true); assert.equal(s.ready, false);
    assert.equal(s.missing.length, 3);
    assert.match(s.missing.join(' '), /wan2\.2_ti2v_5B_fp16.*umt5_xxl_fp16.*wan2\.2_vae/);
    const db = store(), dir = tmp('nova-v-'); const a = media.saveMedia(db, dir, { buffer: PNG, originalName: 'a.png' });
    await assert.rejects(() => videoGen.startAi(db, dir, { mediaId: a.id, prompt: 'x' }), /AI video needs/);
  } finally { delete process.env.NOVA_TOTAL_RAM_GB; process.env.COMFYUI_URL = saved; if (saved === undefined) delete process.env.COMFYUI_URL; server.close(); }
});

test('AI motion uploads the still, sends the Wan 2.2 graph and saves the clip with its recipe', async () => {
  const seen = {};
  const server = fakeComfy({}, seen);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const saved = process.env.COMFYUI_URL; process.env.COMFYUI_URL = 'http://127.0.0.1:' + server.address().port; process.env.NOVA_TOTAL_RAM_GB = '64'; // a large Mac, so the 16 GB Wan guard does not apply
  try {
    const s = await videoGen.aiStatus();
    assert.equal(s.ready, true, s.missing.join('; '));
    assert.equal(s.models.clip, 'umt5_xxl_fp16.safetensors', 'on Apple Silicon the fp16 text encoder is preferred over fp8');
    const db = store(), dir = tmp('nova-v-');
    const still = media.saveMedia(db, dir, { buffer: PNG, originalName: 'marine-drive.png' });
    await assert.rejects(() => videoGen.startAi(db, dir, { mediaId: still.id, prompt: '' }), /Describe the motion/);
    const { job, done } = await videoGen.startAi(db, dir, { mediaId: still.id, prompt: 'Slow push-in, waves roll in', seconds: 3, seed: 7, size: '1280x704' });
    await done;
    const finished = db.get('generationJobs', job.id);
    assert.equal(finished.status, 'done', finished.error);
    assert.ok(seen.upload.includes(PNG), 'the still is uploaded to ComfyUI');
    const g = seen.graph;
    assert.equal(g['4'].inputs.image, 'nova-upload.png');
    assert.deepEqual([g['7'].class_type, g['7'].inputs.width, g['7'].inputs.height, g['7'].inputs.length], ['Wan22ImageToVideoLatent', 1280, 704, 73]);
    assert.equal((g['7'].inputs.length - 1) % 4, 0, 'Wan needs 4n+1 frames');
    assert.deepEqual([g['9'].inputs.seed, g['9'].inputs.sampler_name, g['9'].inputs.scheduler, g['8'].inputs.shift], [7, 'uni_pc', 'simple', 8]);
    assert.equal(g['2'].inputs.type, 'wan');
    assert.equal(g['12'].class_type, 'SaveVideo');
    assert.match(seen.view, /subfolder=video/);
    const clip = db.get('media', finished.mediaIds[0]);
    assert.equal(clip.kind, 'video'); assert.equal(clip.source, 'comfyui');
    assert.equal(clip.provenance.mediaId, still.id); assert.equal(clip.provenance.frames, 73); assert.equal(clip.provenance.seconds, 3);
  } finally { delete process.env.NOVA_TOTAL_RAM_GB; process.env.COMFYUI_URL = saved; if (saved === undefined) delete process.env.COMFYUI_URL; server.close(); }
});

test('continuity: the last frame of a clip becomes a still, and clips join into one video', async t => {
  const dir = tmp('nova-v-');
  const ffmpeg = transcriber.status(dir).ffmpeg;
  if (!ffmpeg) return t.skip('ffmpeg is not installed');
  const { execFileSync } = require('node:child_process');
  const make = (name, color, size) => { const f = path.join(dir, name); execFileSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:size=${size}:duration=1:rate=24`, '-f', 'lavfi', '-i', `color=c=white:size=${size}:duration=0.25:rate=24`, '-filter_complex', '[0:v][1:v]concat=n=2:v=1[o]', '-map', '[o]', '-pix_fmt', 'yuv420p', f]); return fs.readFileSync(f); };
  const db = store();
  const a = media.saveMedia(db, dir, { buffer: make('a.mp4', 'red', '320x180'), originalName: 'shot-1.mp4' });
  const b = media.saveMedia(db, dir, { buffer: make('b.mp4', 'blue', '180x320'), originalName: 'shot-2.mp4' });
  assert.equal(a.kind, 'video');
  const still = await videoGen.lastFrame(db, dir, a.id);
  assert.equal(still.kind, 'image'); assert.equal(still.originalName, 'shot-1 (last frame).png');
  assert.equal(still.provenance.videoId, a.id);
  // The clip ends on white, so the saved last frame must be white, not the red start.
  const rgb = execFileSync(ffmpeg, ['-loglevel', 'error', '-i', media.filePath(dir, still), '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  assert.ok(rgb[0] > 230 && rgb[1] > 230 && rgb[2] > 230, `last frame should be white, got ${[...rgb]}`);
  await assert.rejects(() => videoGen.lastFrame(db, dir, still.id), /Choose a video/);
  assert.throws(() => videoGen.startJoin(db, dir, { mediaIds: [a.id] }), /at least two/);
  const { job, done } = videoGen.startJoin(db, dir, { mediaIds: [a.id, b.id], size: '1280x720' });
  await done;
  const finished = db.get('generationJobs', job.id);
  assert.equal(finished.status, 'done', finished.error);
  const joined = db.get('media', finished.mediaIds[0]);
  const ffprobe = fs.existsSync(path.join(path.dirname(ffmpeg), 'ffprobe')) ? path.join(path.dirname(ffmpeg), 'ffprobe') : 'ffprobe';
  const probe = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=width,height,nb_frames', '-of', 'csv=p=0', media.filePath(dir, joined)], { encoding: 'utf8' }).trim();
  assert.equal(probe, '1280,720,60', 'two 1.25 s clips at 24 fps, fitted to 1280x720');
  assert.deepEqual(joined.provenance.clips.map(c => c.name), ['shot-1.mp4', 'shot-2.mp4']);
});

test('LTX-2: reports what is missing, then runs ltx-2-mlx and saves the clip with its recipe', async () => {
  const ltx = require('../lib/video-ltx');
  const dir = tmp('nova-ltx-'), bin = tmp('nova-ltx-bin-'), fakeHome = tmp('nova-ltx-home-');
  const saved = { ...process.env };
  try {
    process.env.HOME = fakeHome; delete process.env.LTX_MLX_BIN; delete process.env.LTX_MLX_MODEL;
    const missing = ltx.status();
    assert.equal(missing.ready, false);
    assert.match(missing.missing.join(' '), /Install LTX-2 video for NOVA/);
    // A fake ltx-2-mlx: records its arguments, prints progress, writes an MP4 to -o.
    fs.writeFileSync(path.join(dir, 'fixture.mp4'), MP4);
    const fake = path.join(bin, 'ltx-2-mlx');
    fs.writeFileSync(fake, `#!/bin/sh\necho "$@" > "${path.join(dir, 'args.txt')}"\necho "Denoising 4/8" >&2\nwhile [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done\n/bin/cp "${path.join(dir, 'fixture.mp4')}" "$out"\n`, { mode: 0o755 });
    process.env.LTX_MLX_BIN = fake; process.env.LTX_MLX_ANY_PLATFORM = '1';
    assert.match(ltx.status().missing.join(' '), /downloads only what Fast clips need/, 'without weights NOVA refuses rather than let ltx-2-mlx fetch 60 GB');
    // Fake Hugging Face cache: only the Fast files, plus the Gemma text encoder.
    const snap = path.join(fakeHome, '.cache', 'huggingface', 'hub', 'models--dgrauet--ltx-2.3-mlx-q4', 'snapshots', 'abc');
    fs.mkdirSync(snap, { recursive: true });
    for (const f of ['transformer-distilled-1.1.safetensors', 'connector.safetensors', 'vae_encoder.safetensors', 'vae_decoder.safetensors', 'audio_vae.safetensors', 'vocoder.safetensors', 'spatial_upscaler_x2_v1_1.safetensors', 'config.json']) fs.writeFileSync(path.join(snap, f), 'x');
    const gem = path.join(fakeHome, '.cache', 'huggingface', 'hub', 'models--mlx-community--gemma-3-12b-it-4bit', 'snapshots', 'g');
    fs.mkdirSync(gem, { recursive: true }); fs.writeFileSync(path.join(gem, 'model.safetensors'), 'x');
    const s = ltx.status();
    assert.equal(s.ready, true, s.missing.join('; '));
    assert.equal(s.model, 'dgrauet/ltx-2.3-mlx-q4');
    assert.equal(s.weightsDir, snap); assert.deepEqual(s.modes, ['distilled']);
    const db = store();
    const still = media.saveMedia(db, dir, { buffer: PNG, originalName: 'juhu.png' });
    const n = ltx.normalise(db, { mediaId: still.id, prompt: 'waves crash, gulls call', seconds: 4, seed: 9 });
    assert.deepEqual([n.frames, n.width, n.height, n.mode, n.seconds], [97, 704, 480, 'distilled', 4]);
    assert.equal((ltx.normalise(db, { mediaId: still.id, prompt: 'x', seconds: 3 }).frames - 1) % 8, 0, 'LTX needs 8k+1 frames');
    assert.throws(() => ltx.normalise(db, { mediaId: still.id, prompt: '' }), /Describe the motion and sound/);
    const a = ltx.args(n, '/in.png', '/out.mp4');
    assert.deepEqual(a.slice(0, 5), ['generate', '--prompt', 'waves crash, gulls call', '--image', '/in.png']);
    assert.ok(a.includes('--distilled') && a.includes('--low-ram') && a.includes('97'));
    assert.equal(a[a.indexOf('--frame-rate') + 1], '24', 'current ltx-2-mlx requires --frame-rate');
    assert.throws(() => ltx.normalise(db, { mediaId: still.id, prompt: 'x', mode: 'two-stage' }), /--better/);
    for (const f of ['transformer-dev.safetensors', 'ltx-2.3-22b-distilled-lora-384.safetensors']) fs.writeFileSync(path.join(snap, f), 'x');
    assert.deepEqual(ltx.status().modes, ['distilled', 'two-stage']);
    const { job, done } = ltx.start(db, dir, { mediaId: still.id, prompt: 'waves crash, gulls call', seconds: 4, seed: 9, mode: 'two-stage' });
    await done;
    const finished = db.get('generationJobs', job.id);
    assert.equal(finished.status, 'done', finished.error);
    assert.match(fs.readFileSync(path.join(dir, 'args.txt'), 'utf8'), /--two-stage --low-ram/);
    assert.ok(fs.readFileSync(path.join(dir, 'args.txt'), 'utf8').includes('--model ' + snap), 'the local folder is passed, so nothing more is downloaded');
    const clip = db.get('media', finished.mediaIds[0]);
    assert.equal(clip.kind, 'video'); assert.equal(clip.source, 'ltx');
    assert.equal(clip.provenance.engine, 'ltx-2-mlx'); assert.equal(clip.provenance.seed, 9); assert.equal(clip.provenance.audio, true);
  } finally { process.env = saved; }
});

test('guard rails: one heavy job at a time, Wan refused on small Macs, LTX held to safe settings on 16 GB', async () => {
  const heavy = require('../lib/heavy-jobs');
  const ltx = require('../lib/video-ltx');
  const saved = { ...process.env };
  try {
    process.env.NOVA_TOTAL_RAM_GB = '16'; delete process.env.NOVA_ALLOW_WAN_LOW_RAM;
    const db = store(), dir = tmp('nova-guard-');
    heavy.check(db, 'ltx');
    assert.throws(() => heavy.check(db, 'wan'), /this Mac has 16 GB/);
    process.env.NOVA_ALLOW_WAN_LOW_RAM = '1'; heavy.check(db, 'wan'); delete process.env.NOVA_ALLOW_WAN_LOW_RAM;
    db.put('generationJobs', { id: 'gen_1', type: 'video-ltx', status: 'running', settings: { prompt: 'waves' } });
    assert.throws(() => heavy.check(db, 'image'), /Another image or video job is still running \(waves\)/);
    const still = media.saveMedia(db, dir, { buffer: PNG, originalName: 's.png' });
    const n = ltx.normalise(db, { mediaId: still.id, prompt: 'x', seconds: 8, size: '960x544', lowRam: false });
    assert.deepEqual([n.size, n.seconds <= 5, n.lowRam], ['704x480', true, true]);
    process.env.NOVA_TOTAL_RAM_GB = '64';
    const big = ltx.normalise(db, { mediaId: still.id, prompt: 'x', seconds: 8, size: '960x544' });
    assert.deepEqual([big.size, big.frames], ['960x544', 193]);
    // freeMemory unloads running Ollama models and asks ComfyUI to free its models.
    const unloaded = []; let freed = null;
    const server = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { freed = { url: req.url, body: JSON.parse(b) }; res.end('{}'); }); });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const out = await heavy.freeMemory({ ollama: { status: async () => ({ runningModelNames: ['llama3:latest'] }), unload: async n => unloaded.push(n) }, comfyUrl: 'http://127.0.0.1:' + server.address().port });
    server.close();
    assert.deepEqual(unloaded, ['llama3:latest']);
    assert.deepEqual(freed, { url: '/free', body: { unload_models: true, free_memory: true } });
    assert.deepEqual(out, ['ollama:llama3:latest', 'comfyui']);
  } finally { process.env = saved; }
});
