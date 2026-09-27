'use strict';
/* ===========================================================================
 * NOVA Runtime — local image generation through ComfyUI
 *
 * Talks to a ComfyUI server you run on this computer. With COMFYUI_URL
 * unset, NOVA looks at http://127.0.0.1:8188 (manual installs) and then
 * http://127.0.0.1:8000 (the ComfyUI Desktop app's default). Only loopback addresses are accepted, so prompts
 * and images never leave the machine. NOVA sends a standard text-to-image
 * graph (checkpoint -> prompt/negative -> sampler -> decode -> save),
 * waits for the result, and saves each image into the media store with
 * its full recipe: prompt, negative, checkpoint, seed, steps, CFG,
 * sampler, size and the ComfyUI prompt id.
 * ========================================================================= */

const crypto = require('node:crypto');
const media = require('./media');
const live = require('./comfy-live');

const DEFAULT_URLS = ['http://127.0.0.1:8188', 'http://127.0.0.1:8000'];
let discovered = null;
const TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 750;
const SAMPLERS = ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_sde', 'ddim', 'uni_pc'];

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

function checkLocal(raw) {
  let url;
  try { url = new URL(raw); } catch (_) { throw error('COMFYUI_URL is not a valid URL.', 500); }
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname) || url.protocol !== 'http:') throw error('ComfyUI must run on this computer (http://127.0.0.1). Remote image services are not used.', 403);
  return url.origin;
}

function baseUrl() { return checkLocal(process.env.COMFYUI_URL || discovered || DEFAULT_URLS[0]); }

/** Finds a running ComfyUI: the configured URL, else the known local ports. */
async function discover() {
  if (process.env.COMFYUI_URL) return checkLocal(process.env.COMFYUI_URL);
  for (const candidate of DEFAULT_URLS) {
    try {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(candidate + '/system_stats', { signal: controller.signal }).finally(() => clearTimeout(timer));
      if (res.ok && (await res.json().catch(() => null))?.system) { discovered = candidate; return candidate; }
    } catch (_) {}
  }
  discovered = null;
  return DEFAULT_URLS[0];
}

async function call(path, init = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(baseUrl() + path, { ...init, signal: controller.signal });
    if (!res.ok) throw error(`ComfyUI ${path} returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`, 502);
    return res;
  } catch (e) {
    if (e.statusCode) throw e;
    throw error(`ComfyUI is not reachable${process.env.COMFYUI_URL ? ' at ' + baseUrl() : ' on port 8188 or 8000'} (${e.name === 'AbortError' ? 'timed out' : e.message}). Start ComfyUI, then try again.`, 503);
  } finally { clearTimeout(timer); }
}

async function status() {
  try {
    await discover();
    const stats = await (await call('/system_stats')).json();
    const info = await (await call('/object_info/CheckpointLoaderSimple')).json();
    const checkpoints = comboOptions(info?.CheckpointLoaderSimple?.input?.required?.ckpt_name).filter(c => !/stable[-_]audio|ace[-_]step/i.test(c));
    const [loras, upscalers] = await Promise.all([optionList('LoraLoader', 'lora_name'), optionList('UpscaleModelLoader', 'model_name')]);
    return { reachable: true, url: baseUrl(), version: stats?.system?.comfyui_version || null, device: stats?.devices?.[0]?.name || null, checkpoints, samplers: SAMPLERS, loras, upscalers };
  } catch (e) {
    return { reachable: false, url: (() => { try { return baseUrl(); } catch (_) { return null; } })(), error: e.message, checkpoints: [], samplers: SAMPLERS, loras: [], upscalers: [] };
  }
}

/**
 * The options of a ComfyUI list input. Older ComfyUI sends [[a, b, …], {…}]; newer sends
 * ["COMBO", {options: [a, b, …]}]. Always returns an array of strings.
 */
function comboOptions(spec) {
  if (!Array.isArray(spec)) return [];
  if (Array.isArray(spec[0])) return spec[0].map(String);
  if (spec[0] === 'COMBO' && Array.isArray(spec[1]?.options)) return spec[1].options.map(String);
  return [];
}

/** The choices ComfyUI offers for one node input (e.g. the LoRA files in models/loras). */
async function optionList(node, field) {
  try { return comboOptions((await (await call('/object_info/' + node)).json())?.[node]?.input?.required?.[field]); } catch (_) { return []; }
}

function clampInt(value, min, max, fallback) { const n = Math.round(Number(value)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; }

/** Validates a request and returns normalised settings. */
function normalise(input, checkpoints, loras = null) {
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw error('Describe the image you want.');
  if (prompt.length > 4000) throw error('The prompt is limited to 4,000 characters.');
  const checkpoint = String(input.checkpoint || checkpoints[0] || '');
  if (!checkpoint) throw error('ComfyUI has no checkpoint models installed.', 412);
  if (checkpoints.length && !checkpoints.includes(checkpoint)) throw error('Unknown checkpoint: ' + checkpoint);
  const size = v => Math.round(clampInt(v, 256, 2048, 1024) / 8) * 8;
  const sampler = SAMPLERS.includes(input.sampler) ? input.sampler : 'euler';
  return {
    prompt, negative: String(input.negative || '').slice(0, 2000), checkpoint,
    width: size(input.width), height: size(input.height),
    steps: clampInt(input.steps, 1, 100, 25), cfg: Math.min(20, Math.max(1, Number(input.cfg) || 7)),
    seed: Number.isSafeInteger(Number(input.seed)) && Number(input.seed) >= 0 ? Number(input.seed) : crypto.randomInt(0, 2 ** 31 - 1),
    sampler, scheduler: 'normal', batch: clampInt(input.batch, 1, 4, 1),
    ...normaliseLora(input, loras),
  };
}

/** A style or character LoRA from ComfyUI/models/loras, with its strength. */
function normaliseLora(input, loras) {
  const lora = String(input.lora || '').trim();
  if (!lora) return {};
  if (Array.isArray(loras) && !loras.includes(lora)) throw error('Unknown LoRA: ' + lora + '. Put LoRA files in ComfyUI/models/loras and restart ComfyUI.');
  const n = Number(input.loraStrength);
  return { lora, loraStrength: Number.isFinite(n) ? Math.min(2, Math.max(-2, Math.round(n * 100) / 100)) : 0.8 };
}

/** Inserts a LoraLoader after the checkpoint and points every model/clip input at it. */
function withLora(g, s) {
  if (!s.lora) return g;
  for (const node of Object.values(g)) for (const [k, v] of Object.entries(node.inputs)) {
    if (Array.isArray(v) && v[0] === '4' && (v[1] === 0 || v[1] === 1)) node.inputs[k] = ['30', v[1]];
  }
  g['30'] = { class_type: 'LoraLoader', inputs: { model: ['4', 0], clip: ['4', 1], lora_name: s.lora, strength_model: s.loraStrength, strength_clip: s.loraStrength } };
  return g;
}

function graph(s) {
  return withLora({
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: s.checkpoint } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: s.prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: s.negative, clip: ['4', 1] } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: s.width, height: s.height, batch_size: s.batch } },
    '3': { class_type: 'KSampler', inputs: { seed: s.seed, steps: s.steps, cfg: s.cfg, sampler_name: s.sampler, scheduler: s.scheduler, denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'nova', images: ['8', 0] } },
  }, s);
}

/**
 * Queues a graph under NOVA's live client id (so the tensor view gets its steps and
 * previews), records the prompt id on the job and returns it.
 */
async function queuePrompt(store, job, g, label = 'Generation') {
  const queued = await (await call('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: g, client_id: live.CLIENT_ID, extra_data: live.extraData() }) })).json();
  if (!queued.prompt_id) throw error('ComfyUI did not accept the job: ' + JSON.stringify(queued.node_errors || queued).slice(0, 300), 502);
  job.promptId = queued.prompt_id; store.put('generationJobs', job);
  try { live.register(queued.prompt_id, { graph: g, jobId: job.id, label, baseUrl: baseUrl() }); } catch (_) {}
  return queued.prompt_id;
}

/** Polls ComfyUI's history until the prompt finishes, fails, times out or is cancelled. */
async function waitForOutputs(store, job, promptId, timeoutMs, label = 'Generation') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (job.cancelRequested) { await call('/interrupt', { method: 'POST' }).catch(() => {}); live.settle(promptId, 'cancelled'); throw error('Cancelled.', 499); }
    const history = await (await call('/history/' + encodeURIComponent(promptId))).json();
    const entry = history[promptId];
    if (entry?.status?.status_str === 'error') {
      const detail = JSON.stringify(entry.status.messages || []);
      live.settle(promptId, 'failed', 'ComfyUI reported an error');
      if (/Output channels > 65536 not supported at the MPS device/.test(detail)) throw error('This version of macOS cannot decode this audio on the Apple GPU (fixed in macOS 15.1). Update macOS to use music generation.', 502);
      throw error('ComfyUI reported an error: ' + detail.slice(0, 400), 502);
    }
    if (entry?.outputs && Object.keys(entry.outputs).length) { live.settle(promptId, 'done'); return entry.outputs; }
    await new Promise(r => setTimeout(r, POLL_MS));
    const latest = store.get('generationJobs', job.id); if (latest) job.cancelRequested = latest.cancelRequested;
  }
  throw error(label + ' timed out.', 504);
}

async function runGeneration(store, dataDir, job, settings) {
  const promptId = await queuePrompt(store, job, graph(settings), 'Image · ' + settings.prompt.slice(0, 40));
  const outputs = await waitForOutputs(store, job, promptId, TIMEOUT_MS, 'Image generation');
  const images = Object.values(outputs).flatMap(o => o.images || []);
  if (!images.length) throw error('ComfyUI finished without producing an image.', 502);
  const saved = [];
  for (const image of images) {
    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output' });
    const buffer = Buffer.from(await (await call('/view?' + query, {}, 60000)).arrayBuffer());
    const record = media.saveMedia(store, dataDir, { buffer, originalName: `${settings.prompt.slice(0, 60)}.png`, source: 'comfyui', expectKind: 'image',
      provenance: { generator: 'comfyui', comfyuiUrl: baseUrl(), promptId, ...settings, jobId: job.id, comfyFile: image.filename } });
    saved.push(record.id);
  }
  return saved;
}

/** Validates, records a job and generates in the background. */
async function generate(store, dataDir, input) {
  const info = await status();
  if (!info.reachable) throw error(info.error, 503);
  const settings = normalise(input, info.checkpoints, info.loras);
  const job = { id: 'gen_' + crypto.randomBytes(8).toString('hex'), type: 'image-generation', status: 'running', settings, promptId: null, mediaIds: [], error: null, cancelRequested: false, createdAt: new Date().toISOString(), finishedAt: null };
  store.put('generationJobs', job);
  const done = (async () => {
    try { job.mediaIds = await runGeneration(store, dataDir, job, settings); job.status = 'done'; }
    catch (e) { job.status = e.statusCode === 499 ? 'cancelled' : 'failed'; job.error = e.message || String(e); }
    finally { job.finishedAt = new Date().toISOString(); store.put('generationJobs', job); }
  })();
  return { job, done };
}

/* ------------------------- shared ComfyUI job helpers ------------------------ */

/** Uploads a media-store image to ComfyUI's input folder; returns the name LoadImage needs. */
async function uploadImage(dataDir, record) {
  const fs = require('node:fs'), path = require('node:path');
  return uploadBuffer(fs.readFileSync(media.filePath(dataDir, record)), 'nova-' + record.id + path.extname(record.fileName), record.mime);
}

/** Uploads raw image bytes (e.g. a painted mask) to ComfyUI's input folder. */
async function uploadBuffer(buffer, name, mime = 'image/png') {
  const form = new FormData();
  form.append('image', new Blob([buffer], { type: mime }), name);
  form.append('overwrite', 'true');
  const up = await (await call('/upload/image', { method: 'POST', body: form }, 60000)).json();
  return up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
}

/** Queues a graph, waits, downloads outputs of one kind and saves them with a recipe. */
async function runGraph(store, dataDir, job, { graph: g, kind, ext, name, provenance, timeoutMs = TIMEOUT_MS, label = 'Generation', source = 'comfyui', transform = null }) {
  const queued = { prompt_id: await queuePrompt(store, job, g, !name ? label : name.includes(label) ? name : `${label} · ${name}`) };
  const outputs = await waitForOutputs(store, job, queued.prompt_id, timeoutMs, label);
  const files = Object.values(outputs).flatMap(o => [...(o.images || []), ...(o.audio || []), ...(o.videos || [])]).filter(f => ext.test(f.filename || ''));
  if (!files.length) throw error(`ComfyUI finished without producing ${kind === 'audio' ? 'audio' : 'an image'}.`, 502);
  const ids = [];
  for (const f of files) {
    const query = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' });
    let buffer = Buffer.from(await (await call('/view?' + query, {}, 120000)).arrayBuffer()), fileExt = (f.filename.match(/\.[a-z0-9]+$/i) || [''])[0];
    if (transform) ({ buffer, ext: fileExt } = await transform(buffer, fileExt));
    ids.push(media.saveMedia(store, dataDir, { buffer, originalName: name + fileExt, source, expectKind: kind,
      provenance: { generator: 'comfyui', comfyuiUrl: baseUrl(), promptId: queued.prompt_id, ...provenance, jobId: job.id, comfyFile: f.filename } }).id);
  }
  return ids;
}

/** Records a job and runs it in the background. */
function startJob(store, type, settings, run) {
  const job = { id: 'gen_' + crypto.randomBytes(8).toString('hex'), type, status: 'running', settings, promptId: null, mediaIds: [], error: null, cancelRequested: false, createdAt: new Date().toISOString(), finishedAt: null };
  store.put('generationJobs', job);
  const done = (async () => {
    try { job.mediaIds = await run(job); job.status = 'done'; }
    catch (e) { job.status = e.statusCode === 499 ? 'cancelled' : 'failed'; job.error = e.message || String(e); }
    finally { job.finishedAt = new Date().toISOString(); store.put('generationJobs', job); }
  })();
  return { job, done };
}

/* ------------------------------- image to image ------------------------------ */

function normaliseImg2Img(store, input, checkpoints, loras = null, dataDir = null) {
  const record = media.getMedia(store, input.mediaId);
  if (record.kind !== 'image') throw error('Choose an image to start from.');
  const base = normalise({ ...input, width: 1024, height: 1024, batch: 1 }, checkpoints, loras);
  const strength = Math.min(0.95, Math.max(0.1, Number(input.strength) || 0.55));
  let dims = { width: 1024, height: 1024 };
  if (dataDir) { try { const ie = require('./image-edit'); const sz = ie.imageSize(require('node:fs').readFileSync(media.filePath(dataDir, record))); dims = ie.fitDims(sz.width, sz.height, 1.0); } catch (_) {} }
  return { ...base, mode: 'img2img', sourceMediaId: record.id, sourceName: record.originalName, strength, megapixels: 1.0, scaleWidth: dims.width, scaleHeight: dims.height, width: undefined, height: undefined, batch: undefined };
}

/** Standard SDXL image-to-image: the source is scaled to about 1 megapixel, encoded and partly re-noised (denoise = strength). */
function img2imgGraph(s, imageName) {
  return withLora({
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: s.checkpoint } },
    '10': { class_type: 'LoadImage', inputs: { image: imageName } },
    // ImageScale with explicit sizes: ImageScaleToTotalPixels gained a required input in newer ComfyUI.
    '11': { class_type: 'ImageScale', inputs: { image: ['10', 0], upscale_method: 'lanczos', width: s.scaleWidth || 1024, height: s.scaleHeight || 1024, crop: 'disabled' } },
    '12': { class_type: 'VAEEncode', inputs: { pixels: ['11', 0], vae: ['4', 2] } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: s.prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: s.negative, clip: ['4', 1] } },
    '3': { class_type: 'KSampler', inputs: { seed: s.seed, steps: s.steps, cfg: s.cfg, sampler_name: s.sampler, scheduler: s.scheduler, denoise: s.strength, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['12', 0] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'nova-img2img', images: ['8', 0] } },
  }, s);
}

async function generateFromImage(store, dataDir, input) {
  const info = await status();
  if (!info.reachable) throw error(info.error, 503);
  const settings = normaliseImg2Img(store, input, info.checkpoints, info.loras, dataDir);
  const source = media.getMedia(store, settings.sourceMediaId);
  return startJob(store, 'image-generation', settings, async job => {
    const name = await uploadImage(dataDir, source);
    return runGraph(store, dataDir, job, { graph: img2imgGraph(settings, name), kind: 'image', ext: /\.(png|jpe?g|webp)$/i, name: settings.prompt.slice(0, 60), provenance: settings, label: 'Image to image' });
  });
}

function cancel(store, id) {
  const job = store.get('generationJobs', id);
  if (!job) throw error('Unknown generation job.', 404);
  if (job.status !== 'running') throw error('Only a running job can be cancelled.', 409);
  job.cancelRequested = true; store.put('generationJobs', job);
  return job;
}

function recoverInterrupted(store) {
  let count = 0;
  for (const job of store.all('generationJobs')) if (job.status === 'running') { job.status = 'failed'; job.error = 'NOVA restarted during generation.'; store.put('generationJobs', job); count++; }
  return count;
}

module.exports = { comboOptions, status, generate, generateFromImage, normaliseImg2Img, img2imgGraph, uploadImage, uploadBuffer, withLora, normaliseLora, optionList, runGraph, startJob, cancel, normalise, graph, recoverInterrupted, baseUrl, discover, call, waitForOutputs, queuePrompt, error, SAMPLERS };
