'use strict';
/* ===========================================================================
 * NOVA Runtime — image to video, on this computer
 *
 * Two engines, both local:
 *
 *  • Camera moves (ffmpeg). Turns one or more stills into an MP4 with a
 *    push-in, pull-out, pan or tilt on each shot and joins them in order —
 *    an animatic / moving storyboard. No AI model, seconds to render.
 *
 *  • AI motion is LTX-2 by default (lib/video-ltx.js: MLX on this Mac,
 *    with sound). Wan 2.2 through ComfyUI stays available as an option:
 *
 *  • AI motion (ComfyUI + Wan 2.2 TI2V 5B). Sends the still and a prompt to
 *    the local ComfyUI that image generation already uses, with ComfyUI's
 *    standard Wan 2.2 5B image-to-video graph, and saves the clip. Needs the
 *    three Wan 2.2 5B model files in ComfyUI; status() names what is missing.
 *
 * Continuity helpers: take the last frame of any clip as a new still (so
 * the next shot starts exactly where the last one ended) and join clips
 * into one video.
 *
 * Every clip lands in the media store with its full recipe (source images,
 * moves, prompt, models, seed, frames) so it can be reproduced.
 * ========================================================================= */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const media = require('./media');
const transcriber = require('./transcribe');
const comfy = require('./image-gen');
const ltx = require('./video-ltx');
const heavy = require('./heavy-jobs');

const { error } = comfy;
const MOVES = ['push-in', 'pull-out', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down', 'hold'];
const MOTION_SIZES = { '1280x720': [1280, 720], '1920x1080': [1920, 1080], '720x1280': [720, 1280], '1080x1920': [1080, 1920], '1080x1080': [1080, 1080], '2048x858': [2048, 858] };
const AI_SIZES = { '832x480': [832, 480], '480x832': [480, 832], '640x640': [640, 640], '1280x704': [1280, 704], '704x1280': [704, 1280] };
const MAX_SHOTS = 60;
const MOTION_TIMEOUT_MS = 15 * 60 * 1000;
const AI_TIMEOUT_MS = 90 * 60 * 1000;
const AI_FPS = 24;
const DEFAULT_NEGATIVE = 'static, frozen, blurry, overexposed, low quality, jpeg artifacts, deformed hands, extra fingers, distorted face, watermark, text, subtitles';
const MODEL_HINTS = {
  unet: 'wan2.2_ti2v_5B_fp16.safetensors in ComfyUI/models/diffusion_models (Comfy-Org/Wan_2.2_ComfyUI_Repackaged on Hugging Face, ~10 GB)',
  clip: 'umt5_xxl_fp16.safetensors in ComfyUI/models/text_encoders (Comfy-Org/Wan_2.1_ComfyUI_repackaged, ~11 GB; the fp8 version does not run on Apple Silicon)',
  vae: 'wan2.2_vae.safetensors in ComfyUI/models/vae (Comfy-Org/Wan_2.2_ComfyUI_Repackaged)',
};

function clampNum(value, min, max, fallback) { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; }
function newJob(type, settings) { return { id: 'gen_' + crypto.randomBytes(8).toString('hex'), type, status: 'running', settings, promptId: null, mediaIds: [], error: null, cancelRequested: false, createdAt: new Date().toISOString(), finishedAt: null }; }

/* ------------------------------ camera moves ------------------------------ */

let encoderCache = null;
function encoderArgs(ffmpeg) {
  if (!encoderCache || encoderCache.ffmpeg !== ffmpeg) {
    let list = '';
    try { list = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) {}
    const args = /\blibx264\b/.test(list) ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18']
      : /\bh264_videotoolbox\b/.test(list) ? ['-c:v', 'h264_videotoolbox', '-b:v', '12M']
      : ['-c:v', 'mpeg4', '-q:v', '3'];
    encoderCache = { ffmpeg, args };
  }
  return encoderCache.args;
}

function motionStatus(dataDir) {
  const tools = transcriber.status(dataDir);
  return tools.ffmpeg
    ? { ready: true, ffmpeg: tools.ffmpeg, moves: MOVES, sizes: Object.keys(MOTION_SIZES) }
    : { ready: false, ffmpeg: null, moves: MOVES, sizes: Object.keys(MOTION_SIZES), error: 'Camera moves need a working ffmpeg (brew install ffmpeg).' };
}

/** zoompan expressions for one move over F frames. */
function moveExpr(move, frames) {
  const t = `on/${Math.max(1, frames - 1)}`;
  const cx = 'iw/2-(iw/zoom/2)', cy = 'ih/2-(ih/zoom/2)';
  switch (move) {
    case 'push-in': return { z: `1+0.2*${t}`, x: cx, y: cy };
    case 'pull-out': return { z: `1.2-0.2*${t}`, x: cx, y: cy };
    case 'pan-left': return { z: '1.2', x: `(iw-iw/zoom)*(1-${t})`, y: cy };
    case 'pan-right': return { z: '1.2', x: `(iw-iw/zoom)*${t}`, y: cy };
    case 'tilt-up': return { z: '1.2', x: cx, y: `(ih-ih/zoom)*(1-${t})` };
    case 'tilt-down': return { z: '1.2', x: cx, y: `(ih-ih/zoom)*${t}` };
    default: return { z: '1', x: '0', y: '0' };
  }
}

function normaliseMotion(store, input) {
  const shots = Array.isArray(input.shots) ? input.shots : [];
  if (!shots.length) throw error('Add at least one image.');
  if (shots.length > MAX_SHOTS) throw error(`An animatic is limited to ${MAX_SHOTS} shots.`);
  const size = MOTION_SIZES[input.size] ? input.size : '1280x720';
  const fps = [24, 25, 30].includes(Number(input.fps)) ? Number(input.fps) : 24;
  const clean = shots.map((shot, i) => {
    const record = media.getMedia(store, shot.mediaId);
    if (record.kind !== 'image') throw error(`Shot ${i + 1} (${record.originalName}) is not an image.`);
    return { mediaId: record.id, name: record.originalName, move: MOVES.includes(shot.move) ? shot.move : 'push-in', seconds: Math.round(clampNum(shot.seconds, 0.5, 30, 3) * 10) / 10 };
  });
  const total = clean.reduce((n, s) => n + s.seconds, 0);
  if (total > 600) throw error('An animatic is limited to 10 minutes.');
  return { engine: 'camera-moves', prompt: clean.length === 1 ? `${clean[0].move} · ${clean[0].name}` : `Animatic · ${clean.length} shots · ${Math.round(total)}s`, size, fps, shots: clean, seconds: total };
}

function motionArgs(settings, inputs, output, encoder) {
  const [W, H] = MOTION_SIZES[settings.size];
  const scale = Math.min(3, Math.floor(4096 / Math.max(W, H)) || 1) || 1; // oversample for smooth sub-pixel motion
  const W2 = W * Math.max(2, scale), H2 = H * Math.max(2, scale);
  const args = ['-nostdin', '-y', '-loglevel', 'error'];
  for (const file of inputs) args.push('-i', file);
  const parts = settings.shots.map((shot, i) => {
    const frames = Math.max(1, Math.round(shot.seconds * settings.fps));
    const { z, x, y } = moveExpr(shot.move, frames);
    return `[${i}:v]scale=${W2}:${H2}:force_original_aspect_ratio=increase,crop=${W2}:${H2},setsar=1,zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${W}x${H}:fps=${settings.fps},format=yuv420p[v${i}]`;
  });
  const n = settings.shots.length;
  const filter = parts.join(';') + ';' + settings.shots.map((_, i) => `[v${i}]`).join('') + `concat=n=${n}:v=1:a=0[out]`;
  args.push('-filter_complex', filter, '-map', '[out]', ...encoder, '-pix_fmt', 'yuv420p', '-r', String(settings.fps), '-movflags', '+faststart', output);
  return args;
}

function runFfmpeg(store, job, ffmpeg, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    const watch = setInterval(() => { const latest = store.get('generationJobs', job.id); if (latest?.cancelRequested) { job.cancelRequested = true; child.kill('SIGKILL'); } }, 500);
    const timer = setTimeout(() => child.kill('SIGKILL'), MOTION_TIMEOUT_MS);
    child.on('error', e => { clearInterval(watch); clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearInterval(watch); clearTimeout(timer);
      if (job.cancelRequested) return reject(error('Cancelled.', 499));
      code === 0 ? resolve() : reject(error(`ffmpeg failed (${code}): ${stderr.trim().split('\n').slice(-3).join(' ')}`, 500));
    });
  });
}

function startMotion(store, dataDir, input) {
  const tools = motionStatus(dataDir);
  if (!tools.ready) throw error(tools.error, 412);
  const settings = normaliseMotion(store, input);
  const inputs = settings.shots.map(s => media.filePath(dataDir, media.getMedia(store, s.mediaId)));
  const job = newJob('video-camera-moves', settings);
  store.put('generationJobs', job);
  const done = (async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-motion-'));
    try {
      const out = path.join(work, 'out.mp4');
      await runFfmpeg(store, job, tools.ffmpeg, motionArgs(settings, inputs, out, encoderArgs(tools.ffmpeg)));
      const record = media.saveMedia(store, dataDir, { buffer: fs.readFileSync(out), originalName: settings.prompt.slice(0, 80) + '.mp4', source: 'nova-motion', expectKind: 'video',
        provenance: { generator: 'ffmpeg-camera-moves', ...settings, jobId: job.id } });
      job.mediaIds = [record.id]; job.status = 'done';
    } catch (e) { job.status = e.statusCode === 499 ? 'cancelled' : 'failed'; job.error = e.message || String(e); }
    finally { job.finishedAt = new Date().toISOString(); store.put('generationJobs', job); try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {} }
  })();
  return { job, done };
}

/* ------------------------------ continuity -------------------------------- */

function requireFfmpeg(dataDir) {
  const tools = motionStatus(dataDir);
  if (!tools.ready) throw error(tools.error, 412);
  return tools.ffmpeg;
}

function runOnce(ffmpeg, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(error(`ffmpeg failed (${code}): ${stderr.trim().split('\n').slice(-3).join(' ')}`, 500)); });
  });
}

/** Saves the final frame of a video as a PNG still, ready to animate as the next shot. */
async function lastFrame(store, dataDir, videoId) {
  const ffmpeg = requireFfmpeg(dataDir);
  const video = media.getMedia(store, videoId);
  if (video.kind !== 'video') throw error('Choose a video clip.');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-frame-'));
  try {
    const out = path.join(work, 'last.png');
    // Seek near the end, then keep overwriting one image: what remains is the last decoded frame.
    await runOnce(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-sseof', '-1', '-i', media.filePath(dataDir, video), '-update', '1', '-an', out]);
    if (!fs.existsSync(out)) await runOnce(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-i', media.filePath(dataDir, video), '-update', '1', '-an', out]);
    const base = video.originalName.replace(/\.[a-z0-9]+$/i, '');
    return media.saveMedia(store, dataDir, { buffer: fs.readFileSync(out), originalName: `${base} (last frame).png`, source: 'nova-frame', expectKind: 'image',
      provenance: { generator: 'last-frame', videoId: video.id, videoName: video.originalName, character: video.provenance?.character || null } });
  } finally { try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {} }
}

/** Joins clips in order into one MP4, fitting each into the first clip's frame. */
function startJoin(store, dataDir, input) {
  const ffmpeg = requireFfmpeg(dataDir);
  const ids = Array.isArray(input.mediaIds) ? input.mediaIds.map(String) : [];
  if (ids.length < 2) throw error('Choose at least two clips to join.');
  if (ids.length > MAX_SHOTS) throw error(`Join up to ${MAX_SHOTS} clips at a time.`);
  const clips = ids.map(id => { const r = media.getMedia(store, id); if (r.kind !== 'video') throw error(`${r.originalName} is not a video.`); return r; });
  const size = MOTION_SIZES[input.size] ? input.size : '1280x720';
  const fps = [24, 25, 30].includes(Number(input.fps)) ? Number(input.fps) : 24;
  const settings = { engine: 'join', prompt: `Joined · ${clips.length} clips`, size, fps, clips: clips.map(c => ({ mediaId: c.id, name: c.originalName })) };
  const job = newJob('video-join', settings);
  store.put('generationJobs', job);
  const [W, H] = MOTION_SIZES[size];
  const done = (async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-join-'));
    try {
      const out = path.join(work, 'joined.mp4');
      const args = ['-nostdin', '-y', '-loglevel', 'error'];
      for (const c of clips) args.push('-i', media.filePath(dataDir, c));
      const parts = clips.map((_, i) => `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p[v${i}]`);
      args.push('-filter_complex', parts.join(';') + ';' + clips.map((_, i) => `[v${i}]`).join('') + `concat=n=${clips.length}:v=1:a=0[out]`, '-map', '[out]', ...encoderArgs(ffmpeg), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out);
      await runFfmpeg(store, job, ffmpeg, args);
      const record = media.saveMedia(store, dataDir, { buffer: fs.readFileSync(out), originalName: settings.prompt + '.mp4', source: 'nova-motion', expectKind: 'video', provenance: { generator: 'ffmpeg-join', ...settings, jobId: job.id } });
      job.mediaIds = [record.id]; job.status = 'done';
    } catch (e) { job.status = e.statusCode === 499 ? 'cancelled' : 'failed'; job.error = e.message || String(e); }
    finally { job.finishedAt = new Date().toISOString(); store.put('generationJobs', job); try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {} }
  })();
  return { job, done };
}

/* ------------------------------- AI motion -------------------------------- */

async function nodeInfo(name) {
  try { return (await (await comfy.call('/object_info/' + name)).json())?.[name] || null; } catch (e) { if (e.statusCode === 503) throw e; return null; }
}
const choices = (info, field) => require('./image-gen').comboOptions(info?.input?.required?.[field]);
const pick = (list, re, avoid) => list.filter(f => re.test(f)).sort((a, b) => (avoid && avoid.test(a)) - (avoid && avoid.test(b)))[0] || null;

async function aiStatus() {
  try {
    await comfy.discover();
    const stats = await (await comfy.call('/system_stats')).json();
    const [latent, unetInfo, clipInfo, vaeInfo] = await Promise.all(['Wan22ImageToVideoLatent', 'UNETLoader', 'CLIPLoader', 'VAELoader'].map(nodeInfo));
    const device = stats?.devices?.[0]?.name || null;
    const apple = /mps/i.test(String(device || '')) || stats?.system?.os === 'darwin';
    const models = {
      unet: pick(choices(unetInfo, 'unet_name'), /wan2\.2_ti2v_5b/i),
      clip: pick(choices(clipInfo, 'clip_name'), /umt5/i, apple ? /fp8/i : null),
      vae: pick(choices(vaeInfo, 'vae_name'), /wan2\.2_vae/i),
    };
    const missing = [];
    if (!latent) missing.push('a newer ComfyUI with the Wan 2.2 nodes (update ComfyUI)');
    for (const key of ['unet', 'clip', 'vae']) if (!models[key]) missing.push(MODEL_HINTS[key]);
    if (heavy.totalGb() < 32 && process.env.NOVA_ALLOW_WAN_LOW_RAM !== '1') missing.push(`a Mac with 32 GB or more of memory (this one has ${heavy.totalGb()} GB; Wan 2.2 can freeze and restart it)`);
    const notes = [];
    if (apple && models.clip && /fp8/i.test(models.clip)) notes.push('Only the fp8 text encoder is installed; it does not run on Apple Silicon. Add umt5_xxl_fp16.safetensors.');
    if (apple) notes.push('On a Mac, expect several minutes per second of video at 832×480. Start short.');
    return { reachable: true, ready: missing.length === 0, url: comfy.baseUrl(), device, models, missing, notes, sizes: Object.keys(AI_SIZES) };
  } catch (e) {
    return { reachable: false, ready: false, error: e.message, models: {}, missing: [], notes: [], sizes: Object.keys(AI_SIZES) };
  }
}

function normaliseAi(store, input, models) {
  const record = media.getMedia(store, input.mediaId);
  if (record.kind !== 'image') throw error('Choose an image to animate.');
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw error('Describe the motion you want, e.g. "slow push-in, her hair moves in the wind".');
  if (prompt.length > 2000) throw error('The prompt is limited to 2,000 characters.');
  const size = AI_SIZES[input.size] ? input.size : '832x480';
  const seconds = clampNum(input.seconds, 1, 5, 2);
  const frames = Math.round((seconds * AI_FPS) / 4) * 4 + 1; // Wan wants 4n+1 frames
  return {
    engine: 'comfyui-wan2.2-ti2v-5b', mediaId: record.id, sourceName: record.originalName, prompt,
    negative: input.negative == null ? DEFAULT_NEGATIVE : String(input.negative).slice(0, 2000),
    size, width: AI_SIZES[size][0], height: AI_SIZES[size][1], frames, fps: AI_FPS, seconds: Math.round((frames - 1) / AI_FPS * 10) / 10,
    steps: Math.round(clampNum(input.steps, 4, 50, 20)), cfg: clampNum(input.cfg, 1, 10, 5), shift: 8, sampler: 'uni_pc', scheduler: 'simple',
    seed: Number.isSafeInteger(Number(input.seed)) && Number(input.seed) >= 0 && input.seed !== '' && input.seed != null ? Number(input.seed) : crypto.randomInt(0, 2 ** 31 - 1),
    models: { ...models },
  };
}

/** ComfyUI's standard Wan 2.2 TI2V 5B image-to-video graph (API format). */
function aiGraph(s, imageName) {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: s.models.unet, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: s.models.clip, type: 'wan' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: s.models.vae } },
    '4': { class_type: 'LoadImage', inputs: { image: imageName } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: s.prompt, clip: ['2', 0] } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: s.negative, clip: ['2', 0] } },
    '7': { class_type: 'Wan22ImageToVideoLatent', inputs: { vae: ['3', 0], width: s.width, height: s.height, length: s.frames, batch_size: 1, start_image: ['4', 0] } },
    '8': { class_type: 'ModelSamplingSD3', inputs: { shift: s.shift, model: ['1', 0] } },
    '9': { class_type: 'KSampler', inputs: { seed: s.seed, steps: s.steps, cfg: s.cfg, sampler_name: s.sampler, scheduler: s.scheduler, denoise: 1, model: ['8', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['7', 0] } },
    '10': { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: ['3', 0] } },
    '11': { class_type: 'CreateVideo', inputs: { images: ['10', 0], fps: s.fps } },
    '12': { class_type: 'SaveVideo', inputs: { video: ['11', 0], filename_prefix: 'video/nova', format: 'mp4', codec: 'h264' } },
  };
}

async function runAi(store, dataDir, job, settings) {
  const record = media.getMedia(store, settings.mediaId);
  const form = new FormData();
  form.append('image', new Blob([fs.readFileSync(media.filePath(dataDir, record))], { type: record.mime }), 'nova-' + record.id + path.extname(record.fileName));
  form.append('overwrite', 'true');
  const uploaded = await (await comfy.call('/upload/image', { method: 'POST', body: form }, 60000)).json();
  const imageName = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
  const queued = { prompt_id: await comfy.queuePrompt(store, job, aiGraph(settings, imageName), 'Video · ' + settings.prompt.slice(0, 40)) };
  const outputs = await comfy.waitForOutputs(store, job, queued.prompt_id, AI_TIMEOUT_MS, 'Video generation');
  const files = Object.values(outputs).flatMap(o => [...(o.videos || []), ...(o.images || []), ...(o.gifs || [])]).filter(f => /\.(mp4|mov|webm)$/i.test(f.filename || ''));
  if (!files.length) throw error('ComfyUI finished without producing a video.', 502);
  const ids = [];
  for (const file of files) {
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
    const buffer = Buffer.from(await (await comfy.call('/view?' + query, {}, 120000)).arrayBuffer());
    const saved = media.saveMedia(store, dataDir, { buffer, originalName: settings.prompt.slice(0, 60) + '.mp4', source: 'comfyui', expectKind: 'video',
      provenance: { generator: 'comfyui', comfyuiUrl: comfy.baseUrl(), promptId: queued.prompt_id, ...settings, jobId: job.id, comfyFile: file.filename } });
    ids.push(saved.id);
  }
  return ids;
}

async function startAi(store, dataDir, input) {
  const info = await aiStatus();
  if (!info.reachable) throw error(info.error, 503);
  if (!info.ready) throw error('AI video needs: ' + info.missing.join('; ') + '.', 412);
  const settings = normaliseAi(store, input, info.models);
  const job = newJob('video-ai', settings);
  store.put('generationJobs', job);
  const done = (async () => {
    try { job.mediaIds = await runAi(store, dataDir, job, settings); job.status = 'done'; }
    catch (e) { job.status = e.statusCode === 499 ? 'cancelled' : 'failed'; job.error = e.message || String(e); }
    finally { job.finishedAt = new Date().toISOString(); store.put('generationJobs', job); }
  })();
  return { job, done };
}

async function status(dataDir) { return { cameraMoves: motionStatus(dataDir), ltx: ltx.status(), ai: await aiStatus() }; }

module.exports = { encoderArgs, status, motionStatus, aiStatus, startMotion, startAi, lastFrame, startJoin, normaliseMotion, normaliseAi, motionArgs, moveExpr, aiGraph, MOVES, MOTION_SIZES, AI_SIZES, DEFAULT_NEGATIVE };
