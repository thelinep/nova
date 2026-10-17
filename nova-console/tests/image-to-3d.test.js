'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const scan = require('../lib/image-to-3d');
const media = require('../lib/media');
const characters = require('../lib/characters');
const puppet = require('../lib/puppet');

function store(){const s=new Map();return{all(n){return[...(s.get(n)?.values()||[])].map(r=>JSON.parse(JSON.stringify(r)));},get(n,id){const r=s.get(n)?.get(id);return r?JSON.parse(JSON.stringify(r)):null;},put(n,r){if(!s.has(n))s.set(n,new Map());s.get(n).set(r.id,JSON.parse(JSON.stringify(r)));return r;},delete(n,id){s.get(n)?.delete(id);}};}
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return b => { let c = -1; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }; })();
function png(w, h, px) { // px(x, y) -> [r, g, b]
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = px(x, y), i = y * (w * 4 + 1) + 1 + x * 4; raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = 255; }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// A plain figure on white: dark hair, brown face, red top, blue trousers, black shoes.
const FIG = (x, y) => { const c = Math.abs(x - 50); if (y >= 6 && y < 12 && c < 9) return [30, 25, 20]; if (y >= 12 && y < 26 && c < 9) return [190, 130, 90]; if (y >= 26 && y < 60 && c < 16) return [200, 40, 40]; if (y >= 60 && y < 94 && c < 12) return [40, 60, 160]; if (y >= 94 && y < 99 && c < 12) return [15, 15, 15]; return [250, 250, 250]; };

test('scan measuring: colours come from the hair, face, top, bottom and shoes; landmarks give proportions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
  fs.copyFileSync(path.join(__dirname, '..', 'public', 'cs-scan.js'), path.join(dir, 's.mjs'));
  const S = await import(path.join(dir, 's.mjs'));
  const w = 100, h = 100, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = FIG(x, y), i = (y * w + x) * 4; data.set([r, g, b, 255], i); }
  const m = S.measure(data, w, h, null);
  assert.equal(m.metrics.hasPose, false); assert.equal(m.samples.background, '#fafafa');
  assert.deepEqual([m.box.x0, m.box.x1, m.box.y0, m.box.y1], [35, 65, 6, 98]);
  const near = (a, b) => assert.ok(S.colorDist(a, b) < 30, a + ' should be close to ' + b);
  near(m.samples.hair, '#1e1914'); near(m.samples.skin, '#be825a'); near(m.samples.top, '#c82828'); near(m.samples.bottom, '#283ca0'); near(m.samples.shoes, '#0f0f0f');
  // landmarks: a standing adult, normalised coordinates
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.9 }));
  const put = (i, x, y) => { lm[i] = { x, y, visibility: 0.95 }; };
  put(0, 0.5, 0.15); put(2, 0.48, 0.13); put(5, 0.52, 0.13); put(7, 0.46, 0.14); put(8, 0.54, 0.14);
  put(11, 0.4, 0.27); put(12, 0.6, 0.27); put(13, 0.37, 0.4); put(14, 0.63, 0.4); put(15, 0.36, 0.52); put(16, 0.64, 0.52);
  put(23, 0.43, 0.55); put(24, 0.57, 0.55); put(25, 0.43, 0.75); put(26, 0.57, 0.75); put(27, 0.43, 0.94); put(28, 0.57, 0.94); put(31, 0.43, 0.97); put(32, 0.57, 0.97);
  const p = S.fromLandmarks(lm, w, h);
  assert.equal(p.metrics.hasPose, true); assert.ok(Math.abs(p.metrics.headRatio - 0.4) < 0.01, 'ear to ear / shoulders');
  assert.ok(p.metrics.legRatio > 1.3 && p.metrics.legRatio < 1.5); assert.ok(p.metrics.armRatio > 0.8); assert.ok(Math.abs(p.metrics.shoulderHip - 1.43) < 0.02);
  for (const k of ['hair', 'skin', 'top', 'bottom', 'shoes']) assert.ok(p.points[k], k);
  lm[11].visibility = 0.1; assert.equal(S.fromLandmarks(lm, w, h), null, 'no upper body, no proportions');
});

test('rig from a scan: colours, proportions and the vision model\'s answer set the posable character', () => {
  const kid = scan.rigFromScan({ skin: '#c68642', hair: '#1a1a1a', top: '#d03030', bottom: '#c88a48', shoes: '#c68642' }, { headRatio: 0.6, legRatio: 1.4, armRatio: 1.1, hasPose: true });
  assert.equal(kid.body.height, 0.82, 'a big head for the shoulders reads as a child'); assert.ok(kid.body.headSize > 1.1);
  assert.equal(kid.body.skin, '#c68642'); assert.equal(kid.hair.color, '#1a1a1a'); assert.equal(kid.costume.topColor, '#d03030');
  assert.equal(kid.costume.bottom, 'shorts', 'legs the colour of the skin are bare'); assert.equal(kid.costume.shoes, 'barefoot');
  const adult = scan.rigFromScan({ skin: '#f1c27d', hair: '#eec088', top: '#224488', bottom: '#333333' }, { headRatio: 0.38, legRatio: 1.6, hasPose: true });
  assert.equal(adult.body.height, 1); assert.equal(adult.hair.style, 'bald', 'hair the colour of the skin'); assert.equal(adult.costume.bottom, 'pants'); assert.equal(adult.body.legLength, 1);
  const v = scan.parseVision('Sure! {"robot":false,"child":false,"hairStyle":"bun","top":"kurta","bottom":"dhoti","build":"round","extras":["glasses","sword"],"description":"An older man in a white kurta."}');
  assert.deepEqual(v.extras, ['glasses']); assert.equal(v.top, 'kurta');
  const named = scan.rigFromScan({ skin: '#8d5524', top: '#ffffff' }, { headRatio: 0.7 }, v);
  assert.equal(named.hair.style, 'bun'); assert.equal(named.costume.top, 'kurta'); assert.equal(named.costume.bottom, 'dhoti'); assert.equal(named.body.build, 'round');
  assert.equal(named.body.height, 1, 'the vision model\'s "not a child" wins over the head ratio'); assert.deepEqual(named.costume.extras, ['glasses']);
  const bot = scan.rigFromScan({ skin: '#9aa4b0', accent: '#00e0ff' }, {}, { ...v, robot: true });
  assert.equal(bot.body.robot, true); assert.equal(bot.face.eyeShape, 'glow'); assert.equal(bot.face.eyeColor, '#00e0ff');
  assert.equal(scan.parseVision('no json here'), null); assert.equal(scan.parseVision('{broken'), null);
  assert.ok(scan.PROMPT.includes('Do not identify the person'));
});

test('analyse: uses an installed vision model when there is one, and says so when there is not', async () => {
  const db = store(), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-data-'));
  const rec = media.saveMedia(db, dataDir, { buffer: png(100, 100, FIG), originalName: 'kid.png' });
  const samples = { skin: '#be825a', hair: '#1e1914', top: '#c82828', bottom: '#283ca0' };
  const none = await scan.analyse({ store: db, dataDir, ollama: null }, { mediaId: rec.id, samples, metrics: {} });
  assert.equal(none.vision, null); assert.match(none.note, /No vision model/); assert.equal(none.rig.costume.topColor, '#c82828');
  db.put('models', { id: 'qwen2.5vl:7b', runtime: 'ollama', capabilities: ['completion', 'vision'] });
  db.put('models', { id: 'llama3:8b', runtime: 'ollama', capabilities: ['completion'] });
  assert.deepEqual(scan.visionModels(db), ['qwen2.5vl:7b']);
  let sent = null;
  const ollama = { chatFull: async (model, messages, opts) => { sent = { model, messages, opts }; return { message: { content: '{"hairStyle":"ponytail","top":"dress","bottom":"none","child":true}' } }; } };
  const r = await scan.analyse({ store: db, dataDir, ollama }, { mediaId: rec.id, samples, metrics: { hasPose: true } });
  assert.equal(sent.model, 'qwen2.5vl:7b'); assert.equal(sent.opts.format, 'json'); assert.ok(sent.messages[0].images[0].length > 100, 'the picture goes to the local model');
  assert.equal(r.model, 'qwen2.5vl:7b'); assert.equal(r.rig.hair.style, 'ponytail'); assert.equal(r.rig.costume.top, 'dress'); assert.equal(r.pose, true);
  const bad = await scan.analyse({ store: db, dataDir, ollama: { chatFull: async () => { throw new Error('model not loaded'); } } }, { mediaId: rec.id, samples });
  assert.match(bad.note, /could not run/); assert.equal(bad.vision, null);
  const off = await scan.analyse({ store: db, dataDir, ollama }, { mediaId: rec.id, samples, useVision: false });
  assert.equal(off.vision, null);
  const aud = media.saveMedia(db, dataDir, { buffer: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(40)]), originalName: 'a.wav' });
  await assert.rejects(scan.analyse({ store: db, dataDir }, { mediaId: aud.id }), /Choose a picture/);
});

test('picture to mesh: TripoSR runs as a job, the mesh is kept with the character, failures and cancels are reported', async () => {
  const db = store(), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-mesh-'));
  const old = { ...process.env };
  try {
    delete process.env.NOVA_TRIPOSR_PYTHON; delete process.env.NOVA_TRIPOSR_DIR;
    assert.equal(scan.meshStatus(dataDir).ready, false);
    const rec = media.saveMedia(db, dataDir, { buffer: png(64, 64, FIG), originalName: 'kid.png' });
    assert.throws(() => scan.startMesh(db, dataDir, { mediaId: rec.id }), e => e.statusCode === 412);
    process.env.NOVA_TRIPOSR_PYTHON = process.execPath; process.env.NOVA_TRIPOSR_SCRIPT = path.join(__dirname, 'fixtures', 'fake-triposr.js'); process.env.NOVA_TRIPOSR_DIR = dataDir;
    assert.equal(scan.meshStatus(dataDir).ready, true);
    const { job, done } = scan.startMesh(db, dataDir, { mediaId: rec.id, resolution: 999 });
    assert.equal(job.type, 'mesh-3d'); assert.equal(job.settings.resolution, 320); assert.match(job.settings.prompt, /kid\.png/);
    const end = await done;
    assert.equal(end.status, 'done'); assert.match(end.mesh.file, /^mesh_[a-f0-9]{12}\.glb$/);
    const f = scan.meshFile(dataDir, end.mesh.file); assert.equal(fs.readFileSync(f).subarray(0, 4).toString(), 'glTF');
    assert.throws(() => scan.meshFile(dataDir, '../nova.db'), /Unknown mesh/); assert.throws(() => scan.meshFile(dataDir, 'mesh_000000000000.glb'), /gone/);
    const c = characters.create(db, { name: 'Scan', meshes: [{ ...end.mesh, name: 'kid', sourceMediaId: rec.id }, { file: '../../x.glb' }] });
    assert.equal(c.meshes.length, 1); assert.equal(c.meshes[0].name, 'kid');
    assert.equal(characters.update(db, c.id, { name: 'Scan 2' }).meshes.length, 1, 'other saves keep the meshes');
    process.env.FAKE_TRIPOSR_FAIL = '1';
    const failed = await scan.startMesh(db, dataDir, { mediaId: rec.id }).done;
    assert.equal(failed.status, 'failed'); assert.match(failed.error, /out of memory/);
    delete process.env.FAKE_TRIPOSR_FAIL; process.env.FAKE_TRIPOSR_MS = '4000';
    const slow = scan.startMesh(db, dataDir, { mediaId: rec.id });
    await new Promise(r => setTimeout(r, 300));
    db.put('generationJobs', { ...db.get('generationJobs', slow.job.id), cancelRequested: true });
    const cancelled = await slow.done;
    assert.equal(cancelled.status, 'cancelled'); assert.equal(fs.readdirSync(scan.meshesDir(dataDir)).length, 1, 'only the finished mesh is left');
    assert.ok(require('../lib/heavy-jobs').HEAVY_TYPES.has('mesh-3d'), 'one heavy job at a time');
  } finally { for (const k of ['NOVA_TRIPOSR_PYTHON', 'NOVA_TRIPOSR_SCRIPT', 'NOVA_TRIPOSR_DIR', 'FAKE_TRIPOSR_FAIL', 'FAKE_TRIPOSR_MS']) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
  assert.ok(puppet.normaliseMeshes([{ file: 'mesh_0123456789ab.glb' }]).length === 1);
});
