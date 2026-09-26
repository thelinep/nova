'use strict';
/* ===========================================================================
 * NOVA Runtime — guard rails for GPU-heavy generation on this Mac
 *
 * Image and video models share the Mac's unified memory with everything
 * else. Running two at once, or leaving a chat model and ComfyUI's models
 * loaded while LTX-2 starts, can push a 16 GB Mac so hard that macOS stops
 * responding and restarts (a "watchdog timeout" kernel panic). So:
 *   - only one heavy job runs at a time;
 *   - before a job starts, Ollama chat models are unloaded and, for LTX-2,
 *     ComfyUI is asked to free its models;
 *   - Wan 2.2 (about 21 GB of weights) is refused on Macs with less than
 *     32 GB unless NOVA_ALLOW_WAN_LOW_RAM=1;
 *   - LTX-2 on Macs with 24 GB or less (e.g. 16 or 18 GB) is held to
 *     low-RAM mode, 480p and 5 seconds.
 * ========================================================================= */

const os = require('node:os');

const HEAVY_TYPES = new Set(['image-generation', 'image-edit', 'image-upscale', 'video-ai', 'video-ltx', 'audio-sfx', 'audio-music']);
const GB = 1024 ** 3;

function error(message, statusCode) { return Object.assign(new Error(message), { statusCode }); }
function totalGb() { return Number(process.env.NOVA_TOTAL_RAM_GB) || Math.round(os.totalmem() / GB); }

function running(store) { return store.all('generationJobs').find(j => j.status === 'running' && HEAVY_TYPES.has(j.type)) || null; }

/** Throws if another heavy job is running or the engine is unsafe on this Mac. */
function check(store, engine) {
  const busy = running(store);
  if (busy) throw error(`Another image or video job is still running (${busy.settings?.prompt?.slice(0, 60) || busy.id}). Wait for it or cancel it first: two at once can freeze this Mac.`, 409);
  if (engine === 'wan' && totalGb() < 32 && process.env.NOVA_ALLOW_WAN_LOW_RAM !== '1') {
    throw error(`Wan 2.2 needs about 21 GB of model weights in memory, and this Mac has ${totalGb()} GB. Running it can freeze and restart the Mac, so NOVA does not start it. Use LTX-2 instead (set NOVA_ALLOW_WAN_LOW_RAM=1 to override).`, 412);
  }
}

/** Limits applied to LTX-2 settings on small Macs. */
function ltxLimits() {
  return totalGb() <= 24 ? { lowRam: true, maxSeconds: 5, sizes: ['704x480', '480x704', '512x512'] } : { lowRam: null, maxSeconds: 8, sizes: null };
}

/** Frees memory held by other local models. Best effort; never throws. */
async function freeMemory({ ollama, comfyUrl } = {}) {
  const freed = [];
  try {
    const status = ollama ? await ollama.status() : null;
    for (const name of (status && status.runningModelNames) || []) { try { await ollama.unload(name); freed.push('ollama:' + name); } catch (_) {} }
  } catch (_) {}
  if (comfyUrl) {
    try {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(comfyUrl + '/free', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }), signal: controller.signal }).finally(() => clearTimeout(timer));
      if (res.ok) freed.push('comfyui');
    } catch (_) {}
  }
  return freed;
}

module.exports = { check, freeMemory, ltxLimits, running, totalGb, HEAVY_TYPES };
