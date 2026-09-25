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
    const checkpoints = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
    return { reachable: true, url: baseUrl(), version: stats?.system?.comfyui_version || null, device: stats?.devices?.[0]?.name || null, checkpoints, samplers: SAMPLERS };
  } catch (e) {
    return { reachable: false, url: (() => { try { return baseUrl(); } catch (_) { return null; } })(), error: e.message, checkpoints: [], samplers: SAMPLERS };
  }
}

function clampInt(value, min, max, fallback) { const n = Math.round(Number(value)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; }

/** Validates a request and returns normalised settings. */
function normalise(input, checkpoints) {
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
  };
}

function graph(s) {
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: s.checkpoint } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: s.prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: s.negative, clip: ['4', 1] } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: s.width, height: s.height, batch_size: s.batch } },
    '3': { class_type: 'KSampler', inputs: { seed: s.seed, steps: s.steps, cfg: s.cfg, sampler_name: s.sampler, scheduler: s.scheduler, denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'nova', images: ['8', 0] } },
  };
}

/** Polls ComfyUI's history until the prompt finishes, fails, times out or is cancelled. */
async function waitForOutputs(store, job, promptId, timeoutMs, label = 'Generation') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (job.cancelRequested) { await call('/interrupt', { method: 'POST' }).catch(() => {}); throw error('Cancelled.', 499); }
    const history = await (await call('/history/' + encodeURIComponent(promptId))).json();
    const entry = history[promptId];
    if (entry?.status?.status_str === 'error') throw error('ComfyUI reported an error: ' + JSON.stringify(entry.status.messages || []).slice(0, 400), 502);
    if (entry?.outputs && Object.keys(entry.outputs).length) return entry.outputs;
    await new Promise(r => setTimeout(r, POLL_MS));
    const latest = store.get('generationJobs', job.id); if (latest) job.cancelRequested = latest.cancelRequested;
  }
  throw error(label + ' timed out.', 504);
}

async function runGeneration(store, dataDir, job, settings) {
  const clientId = 'nova-' + crypto.randomBytes(6).toString('hex');
  const queued = await (await call('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graph(settings), client_id: clientId }) })).json();
  const promptId = queued.prompt_id;
  if (!promptId) throw error('ComfyUI did not accept the job: ' + JSON.stringify(queued.node_errors || queued).slice(0, 300), 502);
  job.promptId = promptId; store.put('generationJobs', job);
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
  const settings = normalise(input, info.checkpoints);
  const job = { id: 'gen_' + crypto.randomBytes(8).toString('hex'), type: 'image-generation', status: 'running', settings, promptId: null, mediaIds: [], error: null, cancelRequested: false, createdAt: new Date().toISOString(), finishedAt: null };
  store.put('generationJobs', job);
  const done = (async () => {
    try { job.mediaIds = await runGeneration(store, dataDir, job, settings); job.status = 'done'; }
    catch (e) { job.status = e.statusCode === 499 ? 'cancelled' : 'failed'; job.error = e.message || String(e); }
    finally { job.finishedAt = new Date().toISOString(); store.put('generationJobs', job); }
  })();
  return { job, done };
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

module.exports = { status, generate, cancel, normalise, graph, recoverInterrupted, baseUrl, discover, call, waitForOutputs, error, SAMPLERS };
