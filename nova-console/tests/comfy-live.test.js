'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const live = require('../lib/comfy-live');
const audioGen = require('../lib/audio-gen');

function store(){const s=new Map();return{all(n){return[...(s.get(n)?.values()||[])].map(r=>JSON.parse(JSON.stringify(r)));},get(n,id){const r=s.get(n)?.get(id);return r?JSON.parse(JSON.stringify(r)):null;},put(n,r){if(!s.has(n))s.set(n,new Map());s.get(n).set(r.id,JSON.parse(JSON.stringify(r)));return r;},delete(n,id){s.get(n)?.delete(id);}};}
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

test('tensor shapes are worked out from the graph the way ComfyUI makes them', () => {
  assert.deepEqual(live.shapesFor({ a: { class_type: 'EmptyAceStep1.5LatentAudio', inputs: { seconds: 30, batch_size: 1 } } }).latent, [1, 64, 750]);
  assert.deepEqual(live.shapesFor({ a: { class_type: 'EmptyAceStepLatentAudio', inputs: { seconds: 30, batch_size: 1 } } }).latent, [1, 8, 16, 322]);
  const img = live.shapesFor({ a: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 768, batch_size: 2 } } });
  assert.deepEqual([img.kind, img.latent, img.output], ['image', [2, 4, 96, 128], [2, 3, 768, 1024]]);
  assert.equal(live.stageOf('KSampler'), 'denoise'); assert.equal(live.stageOf('TextEncodeAceStepAudio1.5'), 'encode'); assert.equal(live.stageOf('VAEDecodeAudio'), 'decode');
});

test('socket messages become stages, timed steps and preview pictures (both preview formats)', () => {
  live.reset();
  const graph = { '1': { class_type: 'UNETLoader', inputs: {} }, '5': { class_type: 'TextEncodeAceStepAudio1.5', inputs: {} }, '6': { class_type: 'EmptyAceStep1.5LatentAudio', inputs: { seconds: 10, batch_size: 1 } }, '8': { class_type: 'KSampler', inputs: { steps: 8 } }, '9': { class_type: 'VAEDecodeAudio', inputs: {} }, '10': { class_type: 'SaveAudioMP3', inputs: {} } };
  live.register('pA', { graph, label: 'Song' }); // no baseUrl: no socket, messages fed by hand
  live.onJson({ type: 'execution_start', data: { prompt_id: 'pA' } });
  live.onJson({ type: 'executing', data: { node: '1', prompt_id: 'pA' } });
  live.onJson({ type: 'executing', data: { node: '8', prompt_id: 'pA' } });
  live.onJson({ type: 'progress', data: { value: 1, max: 8, prompt_id: 'pA', node: '8' } });
  const head = Buffer.alloc(8); head.writeUInt32BE(1, 0); head.writeUInt32BE(1, 4);
  live.onBinary(Buffer.concat([head, JPEG]));
  live.onJson({ type: 'progress', data: { value: 2, max: 8, prompt_id: 'pA', node: '8' } });
  const meta = Buffer.from(JSON.stringify({ prompt_id: 'pA', node_id: '8', image_type: 'image/jpeg' }));
  const h4 = Buffer.alloc(8); h4.writeUInt32BE(4, 0); h4.writeUInt32BE(meta.length, 4);
  live.onBinary(Buffer.concat([h4, meta, JPEG]));
  let snap = live.snapshot();
  assert.equal(snap.active, true);
  assert.equal(snap.run.stage, 'denoise'); assert.deepEqual([snap.run.step, snap.run.max], [2, 8]);
  assert.equal(snap.run.previews.length, 2); assert.equal(snap.run.stepTimes.length, 1);
  assert.deepEqual(snap.run.stages.map(s => [s.id, s.state]), [['load', 'done'], ['encode', 'waiting'], ['latent', 'waiting'], ['denoise', 'active'], ['decode', 'waiting'], ['save', 'waiting']]);
  assert.equal(snap.run.stages.find(s => s.id === 'denoise').label, 'Denoise × 8');
  assert.deepEqual(live.preview('pA', 'latest').data, JPEG);
  assert.equal(live.preview('pA', 1).step, 1);
  live.onJson({ type: 'executing', data: { node: null, prompt_id: 'pA' } });
  snap = live.snapshot();
  assert.equal(snap.active, false); assert.equal(snap.run.status, 'done');
  assert.ok(snap.run.stages.every(s => s.state !== 'active'));
  live.onJson({ type: 'progress', data: { value: 3, max: 8, prompt_id: 'nobody' } }); // other clients' prompts are ignored
});

/* A fake ComfyUI with a real (minimal) WebSocket endpoint, to check NOVA's whole live path. */
function wsFrame(payload, binary) {
  const len = payload.length; let head;
  if (len < 126) head = Buffer.from([binary ? 0x82 : 0x81, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = binary ? 0x82 : 0x81; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = binary ? 0x82 : 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

test('NOVA queues ComfyUI jobs under its live client id, asks for previews, and the tensor view follows the job', async t => {
  if (typeof WebSocket !== 'function') return t.skip('this Node.js has no WebSocket client');
  live.reset();
  const seen = { bodies: [], wsClient: null }, sockets = [], pending = [], played = new Set();
  const combo = items => ['COMBO', { options: items }];
  const play = () => {
    const sock = sockets[0]; if (!sock) return;
    while (pending.length) {
      const id = pending.shift();
      const send = (o) => sock.write(wsFrame(Buffer.from(JSON.stringify(o))));
      send({ type: 'execution_start', data: { prompt_id: id } });
      send({ type: 'executing', data: { node: '1', prompt_id: id } });
      send({ type: 'executing', data: { node: '8', prompt_id: id } });
      for (let i = 1; i <= 3; i++) {
        send({ type: 'progress', data: { value: i, max: 8, prompt_id: id, node: '8' } });
        const h = Buffer.alloc(8); h.writeUInt32BE(1, 0); h.writeUInt32BE(1, 4);
        sock.write(wsFrame(Buffer.concat([h, JPEG, Buffer.alloc(200 * i)]), true));
      }
      send({ type: 'executing', data: { node: '9', prompt_id: id } });
      setTimeout(() => { played.add(id); }, 150);
    }
  };
  const server = http.createServer((req, res) => {
    const json = b => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    const node = (n, field, spec) => json({ [n]: { input: { required: { [field]: spec } } } });
    const u = req.url;
    if (u === '/system_stats') return json({ system: { comfyui_version: 't', ram_total: 18e9, ram_free: 6e9 }, devices: [{ name: 'mps', vram_total: 18e9, vram_free: 6e9 }] });
    if (u === '/object_info/CheckpointLoaderSimple') return node('CheckpointLoaderSimple', 'ckpt_name', combo([]));
    if (u === '/object_info/DualCLIPLoader') return node('DualCLIPLoader', 'clip_name1', combo(['qwen_0.6b_ace15.safetensors', 'qwen_1.7b_ace15.safetensors']));
    if (u === '/object_info/CLIPLoader') return node('CLIPLoader', 'clip_name', combo(['qwen_0.6b_ace15.safetensors', 'qwen_1.7b_ace15.safetensors']));
    if (u === '/object_info/UNETLoader') return node('UNETLoader', 'unet_name', combo(['acestep_v1.5_turbo.safetensors']));
    if (u === '/object_info/VAELoader') return node('VAELoader', 'vae_name', combo(['ace_1.5_vae.safetensors']));
    if (u.startsWith('/object_info/')) { const n = decodeURIComponent(u.split('/').pop()); return node(n, 'seconds', ['FLOAT', {}]); }
    if (u === '/prompt') { let b = ''; req.on('data', c => b += c); req.on('end', () => { const body = JSON.parse(b); seen.bodies.push(body); const id = 'lp' + seen.bodies.length; pending.push(id); json({ prompt_id: id }); setTimeout(play, 30); }); return; }
    if (u.startsWith('/history/')) { const id = u.split('/').pop(); return json(played.has(id) ? { [id]: { status: { status_str: 'success' }, outputs: { '10': { audio: [{ filename: 'nova_' + id + '.mp3', subfolder: 'audio', type: 'output' }] } } } } : {}); }
    if (u.startsWith('/view?')) { res.writeHead(200); return res.end(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200)])); }
    res.writeHead(404); res.end();
  });
  server.on('upgrade', (req, sock) => {
    seen.wsClient = new URL(req.url, 'http://x').searchParams.get('clientId');
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sock.on('error', () => {});
    sockets.push(sock); setTimeout(play, 30);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const saved = { ...process.env };
  process.env.COMFYUI_URL = 'http://127.0.0.1:' + server.address().port; process.env.NOVA_ALLOW_MUSIC_OLD_MACOS = '1';
  try {
    const db = store(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-live-'));
    const { job, done } = await audioGen.generate(db, dir, 'music', { prompt: 'lofi piano', lyrics: '[instrumental]', seconds: 12, seed: 1, title: 'Night' });
    await done;
    const fin = db.get('generationJobs', job.id);
    assert.equal(fin.status, 'done', fin.error);
    assert.equal(seen.bodies[0].client_id, live.CLIENT_ID, 'queued under the live client id');
    assert.equal(seen.bodies[0].extra_data.preview_method, 'latent2rgb', 'previews asked for per prompt');
    assert.equal(seen.wsClient, live.CLIENT_ID, 'the socket listens for that client id');
    const snap = live.snapshot();
    assert.equal(snap.run.promptId, fin.promptId); assert.equal(snap.run.jobId, job.id);
    assert.equal(snap.run.status, 'done');
    assert.equal(snap.run.previews.length, 3); assert.deepEqual(snap.run.shapes.latent, [1, 64, 300]);
    assert.match(snap.run.label, /Night/);
    assert.ok(snap.run.stages.find(s => s.id === 'denoise').state === 'done');
    assert.equal(live.preview(fin.promptId, 'latest').data.length, JPEG.length + 600);
    assert.ok(snap.stats && snap.stats.ramTotal === 18e9, 'memory comes from ComfyUI system_stats');
  } finally { process.env = saved; live.reset(); sockets.forEach(s => s.destroy()); server.close(); }
});
