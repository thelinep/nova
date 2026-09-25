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
  const saved = process.env.COMFYUI_URL; process.env.COMFYUI_URL = 'http://127.0.0.1:' + server.address().port;
  try {
    const s = await videoGen.aiStatus();
    assert.equal(s.reachable, true); assert.equal(s.ready, false);
    assert.equal(s.missing.length, 3);
    assert.match(s.missing.join(' '), /wan2\.2_ti2v_5B_fp16.*umt5_xxl_fp16.*wan2\.2_vae/);
    const db = store(), dir = tmp('nova-v-'); const a = media.saveMedia(db, dir, { buffer: PNG, originalName: 'a.png' });
    await assert.rejects(() => videoGen.startAi(db, dir, { mediaId: a.id, prompt: 'x' }), /AI video needs/);
  } finally { process.env.COMFYUI_URL = saved; if (saved === undefined) delete process.env.COMFYUI_URL; server.close(); }
});

test('AI motion uploads the still, sends the Wan 2.2 graph and saves the clip with its recipe', async () => {
  const seen = {};
  const server = fakeComfy({}, seen);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const saved = process.env.COMFYUI_URL; process.env.COMFYUI_URL = 'http://127.0.0.1:' + server.address().port;
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
  } finally { process.env.COMFYUI_URL = saved; if (saved === undefined) delete process.env.COMFYUI_URL; server.close(); }
});
