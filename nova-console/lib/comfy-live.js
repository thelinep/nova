'use strict';
/* ===========================================================================
 * NOVA Runtime — live "tensor view" of ComfyUI jobs
 *
 * NOVA queues every ComfyUI prompt under one client id and listens on
 * ComfyUI's WebSocket for that id. ComfyUI then streams, for NOVA's jobs only:
 *   - which node is running (so NOVA knows the stage: load, encode, denoise, decode),
 *   - sampler steps (value / max) — NOVA times each step,
 *   - a small preview picture of the latent tensor after each step.
 * Previews are asked for per prompt (extra_data.preview_method = latent2rgb), so
 * ComfyUI needs no extra flag. Image latents get ComfyUI's own RGB projection;
 * audio latents have none, so NOVA's small ComfyUI add-on (comfy/nova_tensor_view)
 * draws them as a channels × time heatmap. Everything stays on 127.0.0.1.
 * Nothing is written to disk: the last few runs live in memory only.
 * ========================================================================= */

const crypto = require('node:crypto');

const CLIENT_ID = 'nova-live-' + crypto.randomBytes(6).toString('hex');
const KEEP_RUNS = 6;
const KEEP_PREVIEWS = 48;

/** What each ComfyUI node class does, in plain words, grouped into pipeline stages. */
const STAGES = [
  { id: 'load', label: 'Load weights' },
  { id: 'encode', label: 'Text → embeddings' },
  { id: 'latent', label: 'Starting latent' },
  { id: 'denoise', label: 'Denoise' },
  { id: 'decode', label: 'Decode' },
  { id: 'save', label: 'Save' },
];
const NODE_STAGE = [
  [/^(CheckpointLoader|UNETLoader|DualCLIPLoader|CLIPLoader|TripleCLIPLoader|VAELoader|LoraLoader|UpscaleModelLoader|ModelSampling|CLIPVisionLoader)/, 'load'],
  [/^(CLIPTextEncode|TextEncode|ConditioningZeroOut|CLIPVisionEncode|Conditioning)/, 'encode'],
  [/^(EmptyLatent|EmptyAceStep|EmptySD3Latent|EmptyHunyuan|EmptyLTXV|EmptyMochi|VAEEncode|SetLatentNoiseMask|ImagePadForOutpaint|LoadImage|ImageScale|WanImageToVideo|LTXVImgToVideo)/, 'latent'],
  [/^(KSampler|SamplerCustom)/, 'denoise'],
  [/^(VAEDecode|ImageUpscaleWithModel)/, 'decode'],
  [/^(Save|Preview|ImageCompositeMasked|CreateVideo)/, 'save'],
];
function stageOf(classType) { for (const [re, s] of NODE_STAGE) if (re.test(classType || '')) return s; return 'other'; }

/**
 * The tensor shapes a graph will produce, worked out from its inputs the same way ComfyUI does.
 * Returns { latent: [..], latentNote, output: [..], outputNote, kind }.
 */
function shapesFor(graph) {
  const nodes = Object.values(graph || {});
  const find = re => nodes.find(n => re.test(n.class_type || ''));
  let n;
  if ((n = find(/^EmptyAceStep1\.5LatentAudio$/))) {
    const b = n.inputs.batch_size || 1, sec = Number(n.inputs.seconds) || 30, t = Math.round(sec * 48000 / 1920);
    return { kind: 'audio', latent: [b, 64, t], latentNote: `64 channels × ${t} time frames (25 frames a second)`, output: [b, 2, Math.round(sec * 48000)], outputNote: 'stereo samples at 48 kHz' };
  }
  if ((n = find(/^EmptyAceStepLatentAudio$/))) {
    const b = n.inputs.batch_size || 1, sec = Number(n.inputs.seconds) || 30, t = Math.floor(sec * 44100 / 512 / 8);
    return { kind: 'audio', latent: [b, 8, 16, t], latentNote: `8 channels × 16 frequency bands × ${t} time frames`, output: [b, 2, Math.round(sec * 44100)], outputNote: 'stereo samples at 44.1 kHz' };
  }
  if ((n = find(/^EmptyLatentImage$/))) {
    const { width: w = 1024, height: h = 1024, batch_size: b = 1 } = n.inputs;
    return { kind: 'image', latent: [b, 4, h / 8, w / 8], latentNote: `4 channels × ${h / 8} × ${w / 8} (the picture shrunk 8× each way)`, output: [b, 3, h, w], outputNote: 'RGB pixels' };
  }
  if ((n = find(/^ImageScale$/))) {
    const { width: w = 1024, height: h = 1024 } = n.inputs;
    return { kind: 'image', latent: [1, 4, Math.round(h / 8), Math.round(w / 8)], latentNote: `4 channels × ${Math.round(h / 8)} × ${Math.round(w / 8)}`, output: [1, 3, h, w], outputNote: 'RGB pixels' };
  }
  if (find(/^(LoadImage|VAEEncode)/)) return { kind: 'image', latent: null, latentNote: 'size follows the source picture', output: null, outputNote: 'RGB pixels' };
  if (find(/Video|LTXV|Wan/)) return { kind: 'video', latent: null, latentNote: 'channels × frames × height × width', output: null, outputNote: 'video frames' };
  return { kind: 'other', latent: null, latentNote: null, output: null, outputNote: null };
}

const runs = new Map();       // promptId -> run
let socket = null, socketUrl = null, current = null, lastError = null;
let stats = null, statsTimer = null;

function now() { return Date.now(); }

/** Called right after ComfyUI accepts a prompt NOVA queued. */
function register(promptId, { graph, jobId = null, label = 'Generation', baseUrl }) {
  const nodes = {};
  for (const [id, node] of Object.entries(graph || {})) nodes[id] = { classType: node.class_type, stage: stageOf(node.class_type), title: node._meta?.title || node.class_type };
  const run = {
    promptId, jobId, label, nodes, shapes: shapesFor(graph), steps: Number(Object.values(graph || {}).find(x => /^KSampler/.test(x.class_type))?.inputs?.steps) || null,
    queuedAt: now(), startedAt: null, finishedAt: null, status: 'queued', error: null,
    node: null, stage: null, stageTimes: {}, cached: [],
    step: 0, max: 0, stepTimes: [], lastStepAt: null,
    previews: [], previewSeq: 0,
  };
  runs.set(promptId, run);
  while (runs.size > KEEP_RUNS) runs.delete(runs.keys().next().value);
  connect(baseUrl);
  startStats(baseUrl);
  return run;
}

function stageEnter(run, stage) {
  if (!stage || run.stage === stage) return;
  const t = now();
  if (run.stage && run.stageTimes[run.stage]) run.stageTimes[run.stage].end = t;
  run.stage = stage;
  run.stageTimes[stage] = run.stageTimes[stage] || { start: t, end: null };
}

function finish(run, status, errorText = null) {
  if (run.finishedAt) return;
  const t = now();
  if (run.stage && run.stageTimes[run.stage] && !run.stageTimes[run.stage].end) run.stageTimes[run.stage].end = t;
  run.status = status; run.error = errorText; run.finishedAt = t; run.node = null;
  if (current === run.promptId) current = null;
}

/** Handles one JSON message from ComfyUI's WebSocket. Exported for tests. */
function onJson(msg) {
  const d = msg?.data || {};
  const run = d.prompt_id ? runs.get(d.prompt_id) : null;
  switch (msg?.type) {
    case 'execution_start': if (run) { run.status = 'running'; run.startedAt = run.startedAt || now(); current = run.promptId; } break;
    case 'execution_cached': if (run) run.cached = (d.nodes || []).map(String); break;
    case 'executing':
      if (!run) break;
      if (d.node == null) { finish(run, 'done'); break; }
      run.status = 'running'; run.startedAt = run.startedAt || now(); current = run.promptId;
      run.node = String(d.node);
      stageEnter(run, run.nodes[run.node]?.stage || 'other');
      break;
    case 'progress':
      if (!run) break;
      if (d.value < run.step || (run.max && d.max !== run.max)) { run.stepTimes = []; run.lastStepAt = null; }
      { const t = now(); if (run.lastStepAt && d.value > run.step) run.stepTimes.push((t - run.lastStepAt) / 1000); run.lastStepAt = t; }
      run.step = d.value; run.max = d.max;
      if (d.node != null) { run.node = String(d.node); stageEnter(run, run.nodes[run.node]?.stage || 'other'); }
      break;
    case 'execution_success': if (run) finish(run, 'done'); break;
    case 'execution_error': if (run) finish(run, 'failed', d.exception_message || 'ComfyUI error'); break;
    case 'execution_interrupted': if (run) finish(run, 'cancelled'); break;
    default: break;
  }
}

/** Handles one binary message (a preview picture). Exported for tests. */
function onBinary(buf) {
  const b = Buffer.from(buf);
  if (b.length < 8) return;
  const event = b.readUInt32BE(0);
  let promptId = current, mime = 'image/jpeg', image = null, node = null;
  if (event === 1) { mime = b.readUInt32BE(4) === 2 ? 'image/png' : 'image/jpeg'; image = b.subarray(8); }
  else if (event === 4) {
    const len = b.readUInt32BE(4);
    try { const meta = JSON.parse(b.subarray(8, 8 + len).toString('utf8')); promptId = meta.prompt_id || promptId; mime = meta.image_type || mime; node = meta.node_id ?? meta.display_node_id ?? null; } catch (_) {}
    image = b.subarray(8 + len);
  } else return;
  const run = promptId ? runs.get(promptId) : null;
  if (!run || !image?.length) return;
  run.previewSeq++;
  run.previews.push({ seq: run.previewSeq, step: run.step, max: run.max, node: node ?? run.node, mime, at: now(), data: Buffer.from(image) });
  if (run.previews.length > KEEP_PREVIEWS) {
    // Keep the first preview (pure noise) and thin out the middle so the film strip still spans the whole run.
    run.previews.splice(1 + Math.floor(Math.random() * (run.previews.length - 2)), 1);
  }
}

function connect(baseUrl) {
  if (typeof WebSocket !== 'function' || !baseUrl) { lastError = typeof WebSocket !== 'function' ? 'This Node.js has no WebSocket client (Node 22 or later needed) — live steps and previews are off.' : null; return; }
  const url = baseUrl.replace(/^http/, 'ws') + '/ws?clientId=' + CLIENT_ID;
  if (socket && socketUrl === url && socket.readyState <= 1) return;
  try { socket?.close(); } catch (_) {}
  socketUrl = url;
  try {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = ev => { if (typeof ev.data === 'string') { try { onJson(JSON.parse(ev.data)); } catch (_) {} } else onBinary(ev.data); };
    ws.onerror = () => { lastError = 'Could not open ComfyUI\'s live connection.'; };
    ws.onopen = () => { lastError = null; };
    ws.onclose = () => { if (socket === ws) socket = null; };
    socket = ws;
  } catch (e) { lastError = e.message; socket = null; }
}

function busy() { return [...runs.values()].some(r => !r.finishedAt); }

function startStats(baseUrl) {
  if (statsTimer || !baseUrl) return;
  const tick = async () => {
    try {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 1500);
      const s = await (await fetch(baseUrl + '/system_stats', { signal: c.signal }).finally(() => clearTimeout(t))).json();
      const dev = s?.devices?.[0] || {};
      stats = { at: now(), ramTotal: s?.system?.ram_total ?? null, ramFree: s?.system?.ram_free ?? null, device: dev.name || null, vramTotal: dev.vram_total ?? null, vramFree: dev.vram_free ?? null, torchVramTotal: dev.torch_vram_total ?? null, torchVramFree: dev.torch_vram_free ?? null };
    } catch (_) {}
    if (!busy()) { clearInterval(statsTimer); statsTimer = null; }
  };
  tick(); statsTimer = setInterval(tick, 2000);
  statsTimer.unref?.();
}

/** Marks a run finished when NOVA's own polling saw the end (in case a socket message was missed). */
function settle(promptId, status, errorText = null) { const run = runs.get(promptId); if (run) finish(run, status, errorText); }

function summary(run) {
  if (!run) return null;
  const t = now();
  const stages = STAGES.map(s => {
    const st = run.stageTimes[s.id];
    const present = Object.values(run.nodes).some(n => n.stage === s.id);
    return { ...s, present, state: !st ? 'waiting' : st.end ? 'done' : 'active', seconds: st ? Math.round(((st.end || t) - st.start) / 100) / 10 : null, label: s.id === 'denoise' && (run.max || run.steps) ? `Denoise × ${run.max || run.steps}` : s.label };
  }).filter(s => s.present);
  const active = run.node ? run.nodes[run.node] : null;
  const avg = run.stepTimes.length ? run.stepTimes.reduce((a, b) => a + b, 0) / run.stepTimes.length : null;
  return {
    promptId: run.promptId, jobId: run.jobId, label: run.label, status: run.status, error: run.error,
    elapsed: Math.round(((run.finishedAt || t) - (run.startedAt || run.queuedAt)) / 1000),
    node: run.node, nodeClass: active?.classType || null, stage: run.stage, stages,
    step: run.step, max: run.max || run.steps || 0, stepTimes: run.stepTimes.slice(-60).map(x => Math.round(x * 100) / 100),
    secondsPerStep: avg == null ? null : Math.round(avg * 100) / 100,
    etaSeconds: avg != null && run.max && !run.finishedAt ? Math.round(avg * (run.max - run.step)) : null,
    shapes: run.shapes,
    previews: run.previews.map(p => ({ seq: p.seq, step: p.step, max: p.max })),
    previewSeq: run.previewSeq, cached: run.cached.length,
  };
}

/** What the tensor view shows: the running (or latest) ComfyUI run, plus machine memory. */
function snapshot() {
  const list = [...runs.values()];
  const active = list.filter(r => !r.finishedAt).sort((a, b) => b.queuedAt - a.queuedAt)[0];
  const latest = active || list.sort((a, b) => (b.finishedAt || b.queuedAt) - (a.finishedAt || a.queuedAt))[0];
  return {
    live: typeof WebSocket === 'function', connected: !!socket && socket.readyState === 1, error: lastError,
    active: !!active, run: summary(latest), stats,
    recent: [...runs.values()].reverse().map(r => ({ promptId: r.promptId, label: r.label, status: r.status, previews: r.previews.length })),
  };
}

function preview(promptId, seq) {
  const run = runs.get(promptId);
  if (!run || !run.previews.length) return null;
  if (seq === 'latest' || seq == null) return run.previews[run.previews.length - 1];
  return run.previews.find(p => p.seq === Number(seq)) || null;
}

function extraData() { return { preview_method: 'latent2rgb' }; }

function reset() { runs.clear(); current = null; try { socket?.close(); } catch (_) {} socket = null; }

module.exports = { CLIENT_ID, STAGES, stageOf, shapesFor, register, onJson, onBinary, settle, snapshot, preview, extraData, reset };
