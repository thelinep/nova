#!/usr/bin/env node
'use strict';
/* ===========================================================================
 * NOVA — run every media feature once on this Mac and report what works.
 *
 * Needs NOVA running (npm start) and, for the SDXL/audio checks, ComfyUI
 * ("Start ComfyUI for NOVA.command"). Each check calls NOVA's own API, waits
 * for the job and records ok / failed / skipped (with the reason) and how
 * long it took. Items it makes are named "NOVA check · …" in the library.
 * The report is printed and saved to data/checks/report-<time>.md and .json.
 *
 *   node scripts/check-on-mac.js            # everything (LTX-2 and music take several minutes)
 *   node scripts/check-on-mac.js --quick    # skip text to video and music
 *   NOVA_URL=http://127.0.0.1:8787 node scripts/check-on-mac.js
 * ========================================================================= */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BASE = process.env.NOVA_URL || 'http://127.0.0.1:8787';
const QUICK = process.argv.includes('--quick');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const results = [];
const made = {};

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Origin: BASE }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return data;
}
async function upload(name, buffer) {
  const res = await fetch(BASE + '/api/media', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), Origin: BASE }, body: buffer });
  const data = await res.json(); if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`); return data;
}
async function waitJob(job, minutes) {
  const end = Date.now() + minutes * 60000; let last = '';
  for (;;) {
    const j = await api('GET', '/api/images/jobs/' + encodeURIComponent(job.id));
    if (j.status === 'done') return j;
    if (j.status !== 'running') throw new Error(j.error || j.status);
    if (j.progress && j.progress !== last) { last = j.progress; process.stdout.write(`      ${String(j.progress).slice(0, 100)}\n`); }
    if (Date.now() > end) { await api('POST', '/api/images/jobs/' + encodeURIComponent(job.id) + '/cancel').catch(() => {}); throw new Error(`still running after ${minutes} min (cancelled)`); }
    await sleep(2000);
  }
}
async function waitIdle(minutes = 30) { // the heavy-job guard allows one at a time
  const end = Date.now() + minutes * 60000;
  while (Date.now() < end) { const jobs = await api('GET', '/api/images/jobs'); if (!jobs.some(j => j.status === 'running')) return; await sleep(3000); }
}
class Skip extends Error {}
async function check(key, name, fn) {
  if (ONLY.length && !ONLY.includes(key)) return;
  const t0 = Date.now();
  process.stdout.write(`\n▶ ${name}\n`);
  try {
    await waitIdle();
    const note = await fn();
    results.push({ key, name, status: 'ok', seconds: Math.round((Date.now() - t0) / 1000), note: note || '' });
    process.stdout.write(`  ✓ works (${Math.round((Date.now() - t0) / 1000)} s)${note ? ' — ' + note : ''}\n`);
  } catch (e) {
    const skip = e instanceof Skip;
    results.push({ key, name, status: skip ? 'skipped' : 'failed', seconds: Math.round((Date.now() - t0) / 1000), note: e.message });
    process.stdout.write(`  ${skip ? '– skipped' : '✗ FAILED'}: ${e.message}\n`);
  }
}
async function mediaItem(id) { return api('GET', '/api/media/' + encodeURIComponent(id)); }

/* A tiny PNG encoder (grayscale) for the painted mask. */
function png(width, height, pixel) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width + 1)] = 0; for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = pixel(x, y); }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  try { await api('GET', '/api/health'); } catch (_) { console.error(`NOVA is not running at ${BASE}. Start it (npm start in nova-console) and run this again.`); process.exit(1); }
  const [img, aud, vid, stt] = await Promise.all([api('GET', '/api/images/status'), api('GET', '/api/audio/status'), api('GET', '/api/video/status'), api('GET', '/api/transcribe/status')]);
  console.log(`NOVA ${BASE} · ComfyUI ${img.reachable ? 'running' : 'NOT running'} · checkpoints ${img.checkpoints.length} · LoRAs ${(img.loras || []).length} · upscale models ${(img.upscalers || []).length}`);
  console.log(`Voice: macOS ${aud.voice.voices.length} voices · Kokoro ${aud.voice.kokoro && aud.voice.kokoro.ready ? 'installed' : 'not installed'} · whisper ${stt.ready ? stt.modelName + (stt.multilingual ? ' (multilingual)' : ' (English only)') : 'not ready'} · LTX-2 ${vid.ltx.ready ? 'ready' : 'not ready'}`);
  const needComfy = () => { if (!img.reachable) throw new Skip('ComfyUI is not running'); if (!img.checkpoints.length) throw new Skip('no SDXL checkpoint'); };

  await check('image', 'Text to image (base for the image checks)', async () => {
    needComfy();
    const j = await waitJob(await api('POST', '/api/images/generate', { prompt: 'NOVA check · a red vintage scooter parked by a sea wall at Marine Drive, dusk, cinematic film still', width: 1024, height: 768, steps: 20 }), 10);
    made.image = j.mediaIds[0];
  });
  const needImage = () => { if (!made.image) throw new Skip('no base image (text to image did not run)'); };

  await check('img2img', 'Image to image', async () => {
    needComfy(); needImage();
    await waitJob(await api('POST', '/api/images/img2img', { mediaId: made.image, prompt: 'NOVA check · same scene in heavy monsoon rain, wet reflections', strength: 0.55, steps: 20 }), 10);
  });
  await check('lora', 'Style / character LoRA', async () => {
    needComfy(); if (!(img.loras || []).length) throw new Skip('no LoRA files in ComfyUI/models/loras');
    await waitJob(await api('POST', '/api/images/generate', { prompt: 'NOVA check · portrait of a woman on a rooftop at dusk', width: 832, height: 1216, steps: 20, lora: img.loras[0], loraStrength: 0.8 }), 10);
    return 'used ' + img.loras[0];
  });
  const mask = () => 'data:image/png;base64,' + png(1024, 768, (x, y) => (x > 380 && x < 700 && y > 330 && y < 620 ? 255 : 0)).toString('base64');
  await check('remove', 'Remove object (mask brush)', async () => {
    needComfy(); needImage();
    await waitJob(await api('POST', '/api/images/edit', { mediaId: made.image, mode: 'remove', mask: mask(), steps: 25 }), 10);
    return 'open the result and check the centre was filled cleanly';
  });
  await check('edit', 'Edit area from a prompt', async () => {
    needComfy(); needImage();
    await waitJob(await api('POST', '/api/images/edit', { mediaId: made.image, mode: 'edit', prompt: 'a yellow taxi', strength: 0.9, mask: mask(), steps: 25 }), 10);
  });
  await check('expand', 'Expand background to 2.39:1', async () => {
    needComfy(); needImage();
    await waitJob(await api('POST', '/api/images/expand', { mediaId: made.image, target: '2.39:1', steps: 25 }), 10);
  });
  await check('upscale', 'Upscale 2x', async () => {
    needImage();
    const j = await waitJob(await api('POST', '/api/images/upscale', { mediaId: made.image, factor: 2 }), 10);
    const m = await mediaItem(j.mediaIds[0]);
    return m.provenance.engine === 'upscale-model' ? 'with ' + m.provenance.model : 'plain ffmpeg resize (no upscale model installed)';
  });

  await check('voice', 'Voice (macOS)', async () => {
    if (!aud.voice.voices.length) throw new Skip('no macOS voices');
    const en = aud.voice.voices.find(v => /^en[_-]/.test(v.locale));
    const j = await waitJob(await api('POST', '/api/audio/voice', { text: 'NOVA check. The storm is coming. Close the windows, and bring the boats in before dark.', voice: en && en.name }), 3);
    made.voice = j.mediaIds[0];
  });
  await check('kokoro', 'Kokoro voices (English and Hindi)', async () => {
    if (!(aud.voice.kokoro && aud.voice.kokoro.ready)) throw new Skip('Kokoro not installed (Install Kokoro voices for NOVA.command)');
    const a = await waitJob(await api('POST', '/api/audio/voice', { text: 'NOVA check. Kokoro speaks naturally, offline, on this Mac.', voice: 'kokoro:af_heart' }), 5);
    await waitJob(await api('POST', '/api/audio/voice', { text: 'तूफ़ान आ रहा है। खिड़कियाँ बंद कर दो।', voice: 'kokoro:hf_alpha' }), 5);
    made.voice = made.voice || a.mediaIds[0];
    return 'listen to both clips for quality';
  });
  await check('enhance', 'Enhance speech', async () => {
    if (!made.voice) throw new Skip('no voice clip to clean');
    await waitJob(await api('POST', '/api/media/' + made.voice + '/enhance', { strength: 'strong' }), 5);
  });
  await check('transcribe', 'Transcribe (English)', async () => {
    if (!made.voice) throw new Skip('no voice clip');
    if (!stt.ready) throw new Skip('whisper not ready: ' + stt.missing.join('; '));
    await api('POST', '/api/media/' + made.voice + '/transcribe', { language: 'en' });
    for (let i = 0; i < 150; i++) { const m = await mediaItem(made.voice); if (m.transcription?.status === 'done') return JSON.stringify(m.transcript.text.slice(0, 80)); if (m.transcription?.status === 'failed') throw new Error(m.transcription.error); await sleep(2000); }
    throw new Error('timed out');
  });
  await check('translate-dub', 'Translate: English voice → Hindi dub', async () => {
    if (!made.voice) throw new Skip('no voice clip');
    const j = await waitJob(await api('POST', '/api/media/' + made.voice + '/translate', { from: 'en', language: 'hi', mode: 'dub' }), 15);
    const m = await mediaItem(j.mediaIds[0]);
    return `voice ${m.provenance.voice}; first line: ${JSON.stringify((m.provenance.srt.split('\n')[2] || '').slice(0, 60))} — check the Hindi`;
  });
  await check('translate-hi', 'Translate: Hindi speech → English (multilingual model)', async () => {
    if (!stt.multilingual) throw new Skip('no multilingual speech model (Add multilingual speech model.command)');
    const hiVoice = (aud.voice.kokoro && aud.voice.kokoro.ready) ? 'kokoro:hf_alpha' : (aud.voice.voices.find(v => /^hi[_-]/.test(v.locale)) || {}).name;
    if (!hiVoice) throw new Skip('no Hindi voice to make a test clip');
    const hi = await waitJob(await api('POST', '/api/audio/voice', { text: 'तूफ़ान आ रहा है। खिड़कियाँ बंद कर दो और अंधेरा होने से पहले नावें वापस ले आओ।', voice: hiVoice }), 5);
    const j = await waitJob(await api('POST', '/api/media/' + hi.mediaIds[0] + '/translate', { from: 'hi', language: 'en', mode: 'dub' }), 15);
    const m = await mediaItem(j.mediaIds[0]);
    return `heard as: ${JSON.stringify((await mediaItem(hi.mediaIds[0])).transcript?.text?.slice(0, 80))}; English: ${JSON.stringify((m.provenance.srt.split('\n')[2] || '').slice(0, 80))}`;
  });

  await check('timeline', 'Timeline export (still + voice)', async () => {
    if (!made.image || !made.voice) throw new Skip('needs the image and voice from earlier checks');
    const tl = await api('POST', '/api/timelines', { name: 'NOVA check · scene', size: '1280x720', tracks: { video: [{ mediaId: made.image, seconds: 6 }], voice: [{ mediaId: made.voice, start: 0.5 }] } });
    const j = await waitJob(await api('POST', '/api/timelines/' + tl.id + '/export'), 10);
    made.scene = j.mediaIds[0];
  });
  await check('subtitles', 'Translate: burned-in Hindi subtitles', async () => {
    if (!made.scene) throw new Skip('no scene video (timeline check did not run)');
    const j = await waitJob(await api('POST', '/api/media/' + made.scene + '/translate', { from: 'en', language: 'hi', mode: 'subtitles' }), 15);
    return 'open the clip and check the Devanagari renders (not boxes)';
  });
  await check('board', 'Boards (save and reload)', async () => {
    const b = await api('POST', '/api/boards', { name: 'NOVA check · board', items: [{ type: 'note', text: 'check' }, ...(made.image ? [{ type: 'media', mediaId: made.image }] : [])] });
    const again = await api('GET', '/api/boards/' + b.id);
    if (again.items.length !== b.items.length) throw new Error('items were not saved');
  });

  await check('sfx', 'Sound effect (Stable Audio Open)', async () => {
    if (!aud.comfy.reachable) throw new Skip('ComfyUI is not running');
    if (!aud.comfy.sfx.ready) throw new Skip('needs: ' + aud.comfy.sfx.missing.join('; '));
    await waitJob(await api('POST', '/api/audio/sfx', { prompt: 'NOVA check · heavy monsoon rain on a tin roof, distant thunder', seconds: 6 }), 15);
  });
  await check('music', 'Instrumental music (ACE-Step)', async () => {
    if (QUICK) throw new Skip('--quick');
    if (!aud.comfy.reachable) throw new Skip('ComfyUI is not running');
    if (!aud.comfy.music.ready) throw new Skip('needs: ' + aud.comfy.music.missing.join('; '));
    await waitJob(await api('POST', '/api/audio/music', { prompt: 'cinematic, tabla, strings, slow build, hopeful', lyrics: '[instrumental]', seconds: 15, title: 'NOVA check · theme' }), 30);
  });
  await check('t2v', 'Text to video (LTX-2, no still)', async () => {
    if (QUICK) throw new Skip('--quick');
    if (!vid.ltx.ready) throw new Skip('LTX-2 needs: ' + vid.ltx.missing.join('; '));
    await waitJob(await api('POST', '/api/video/animate', { engine: 'ltx', prompt: 'NOVA check · waves crash against a sea wall at dusk, gulls call, slow push-in', size: '704x480', seconds: 2, mode: 'distilled' }), 40);
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(__dirname, '..', 'data', 'checks'); fs.mkdirSync(dir, { recursive: true });
  const icon = { ok: '✅', failed: '❌', skipped: '⏭️' };
  const md = `# NOVA checks on this Mac · ${new Date().toLocaleString()}\n\n| | Check | Time | Notes |\n|---|---|---|---|\n` + results.map(r => `| ${icon[r.status]} | ${r.name} | ${r.seconds} s | ${String(r.note).replace(/\|/g, '/').replace(/\n/g, ' ')} |`).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, `report-${stamp}.md`), md);
  fs.writeFileSync(path.join(dir, `report-${stamp}.json`), JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 2));
  fs.writeFileSync(path.join(dir, 'latest.md'), md);
  console.log('\n' + md + `\nSaved: ${path.join(dir, 'report-' + stamp + '.md')}`);
  console.log(`Works: ${results.filter(r => r.status === 'ok').length} · Failed: ${results.filter(r => r.status === 'failed').length} · Skipped: ${results.filter(r => r.status === 'skipped').length}`);
})().catch(e => { console.error(e); process.exit(1); });
