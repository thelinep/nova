'use strict';
/* ===========================================================================
 * NOVA Runtime — edit, remove, expand and upscale images on this Mac
 *
 *  • Edit area / Remove object: you paint a mask over part of a picture;
 *    SDXL (through the local ComfyUI) repaints only that area, from your
 *    prompt or, for Remove, as clean background. The untouched pixels are
 *    composited back so the rest of the picture does not change.
 *  • Expand background (outpainting): the picture is placed on a larger
 *    canvas (a wider frame shape, or more room on every side) and SDXL
 *    fills the new area to match.
 *  • Upscale: an upscale model in ComfyUI/models/upscale_models (for
 *    example 4x-UltraSharp) when ComfyUI is running; otherwise a plain
 *    high-quality resize with ffmpeg.
 * Results are new library items; the source is never changed.
 * ========================================================================= */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const media = require('./media');
const comfy = require('./image-gen');

const { error } = comfy;
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const ASPECTS = { '16:9': 16 / 9, '2.39:1': 2.39, '4:3': 4 / 3, '1:1': 1, '4:5': 0.8, '9:16': 9 / 16 };
const EXPANDS = ['16:9', '2.39:1', '4:3', '1:1', '4:5', '9:16', 'wider', 'taller', 'all'];
const REMOVE_PROMPT = 'clean empty background, seamless natural continuation of the surrounding scene, same lighting and texture';
const REMOVE_NEGATIVE = 'person, people, figure, object, text, watermark, logo, blurry, smudge, artifacts, duplicate';

/** Width and height from PNG, JPEG, WebP or GIF bytes. */
function imageSize(b) {
  if (b.length > 24 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 10 && b.toString('latin1', 0, 3) === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === 'VP8L') { const bits = b.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
    if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  throw error('Could not read the size of this image.', 415);
}

const round8 = n => Math.max(64, Math.round(n / 8) * 8);

/** Scales (w, h) to about `mp` SDXL megapixels, in multiples of 8. */
function fitDims(w, h, mp = 1.0) {
  const k = Math.sqrt((mp * 1024 * 1024) / (w * h));
  return { width: round8(w * k), height: round8(h * k), scale: k };
}

/** Canvas and padding for Expand background. */
function expandPlan(w, h, target) {
  if (!EXPANDS.includes(target)) throw error('Choose how to expand: ' + EXPANDS.join(', ') + '.');
  let tw = w, th = h;
  if (ASPECTS[target]) { const r = ASPECTS[target]; if (w / h < r) tw = h * r; else th = w / r; }
  else if (target === 'wider') tw = w * 1.5;
  else if (target === 'taller') th = h * 1.5;
  else { tw = w * 1.5; th = h * 1.5; }
  if (tw / w < 1.02 && th / h < 1.02) throw error('The picture is already that shape. Choose a different frame, or "more room on every side".');
  const k = Math.sqrt((1.1 * 1024 * 1024) / (tw * th));
  const sw = round8(w * k), sh = round8(h * k), cw = Math.max(sw, round8(tw * k)), ch = Math.max(sh, round8(th * k));
  const left = Math.round((cw - sw) / 2 / 8) * 8, top = Math.round((ch - sh) / 2 / 8) * 8;
  return { sourceWidth: sw, sourceHeight: sh, width: cw, height: ch, left, top, right: cw - sw - left, bottom: ch - sh - top };
}

function seedOf(v) { return Number.isSafeInteger(Number(v)) && Number(v) >= 0 && v !== '' && v != null ? Number(v) : crypto.randomInt(0, 2 ** 31 - 1); }

function baseSettings(input, info) {
  const checkpoint = String(input.checkpoint || info.checkpoints[0] || '');
  if (!checkpoint) throw error('ComfyUI has no checkpoint models installed.', 412);
  if (!info.checkpoints.includes(checkpoint)) throw error('Unknown checkpoint: ' + checkpoint);
  const s = { checkpoint, steps: Math.round(Math.min(60, Math.max(8, Number(input.steps) || 30))), cfg: Math.min(15, Math.max(1, Number(input.cfg) || 6.5)), sampler: comfy.SAMPLERS.includes(input.sampler) ? input.sampler : 'dpmpp_2m', scheduler: 'karras', seed: seedOf(input.seed) };
  const lora = String(input.lora || '').trim();
  if (lora) { if (!(info.loras || []).includes(lora)) throw error('Unknown LoRA: ' + lora); const n = Number(input.loraStrength); s.lora = lora; s.loraStrength = Number.isFinite(n) ? Math.min(2, Math.max(-2, n)) : 0.8; }
  return s;
}

function loraNode(g, s) {
  if (!s.lora) return g;
  for (const node of Object.values(g)) for (const [k, v] of Object.entries(node.inputs)) if (Array.isArray(v) && v[0] === '4' && (v[1] === 0 || v[1] === 1)) node.inputs[k] = ['30', v[1]];
  g['30'] = { class_type: 'LoraLoader', inputs: { model: ['4', 0], clip: ['4', 1], lora_name: s.lora, strength_model: s.loraStrength, strength_clip: s.loraStrength } };
  return g;
}

/** Edit area / Remove object: repaint only the masked pixels, then composite onto the original. */
function inpaintGraph(s, imageName, maskName) {
  const g = {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: s.checkpoint } },
    '10': { class_type: 'LoadImage', inputs: { image: imageName } },
    '11': { class_type: 'ImageScale', inputs: { image: ['10', 0], upscale_method: 'lanczos', width: s.width, height: s.height, crop: 'disabled' } },
    '13': { class_type: 'LoadImage', inputs: { image: maskName } },
    '14': { class_type: 'ImageScale', inputs: { image: ['13', 0], upscale_method: 'bilinear', width: s.width, height: s.height, crop: 'disabled' } },
    '15': { class_type: 'ImageToMask', inputs: { image: ['14', 0], channel: 'red' } },
    '16': { class_type: 'GrowMask', inputs: { mask: ['15', 0], expand: s.grow, tapered_corners: true } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: s.prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: s.negative, clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '17': { class_type: 'ImageCompositeMasked', inputs: { destination: ['11', 0], source: ['8', 0], x: 0, y: 0, resize_source: false, mask: ['16', 0] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'nova-edit', images: ['17', 0] } },
  };
  if (s.mode === 'remove' || s.strength >= 0.99) {
    g['12'] = { class_type: 'VAEEncodeForInpaint', inputs: { pixels: ['11', 0], vae: ['4', 2], mask: ['16', 0], grow_mask_by: 6 } };
    g['3'] = { class_type: 'KSampler', inputs: { seed: s.seed, steps: s.steps, cfg: s.cfg, sampler_name: s.sampler, scheduler: s.scheduler, denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['12', 0] } };
  } else {
    g['18'] = { class_type: 'VAEEncode', inputs: { pixels: ['11', 0], vae: ['4', 2] } };
    g['12'] = { class_type: 'SetLatentNoiseMask', inputs: { samples: ['18', 0], mask: ['16', 0] } };
    g['3'] = { class_type: 'KSampler', inputs: { seed: s.seed, steps: s.steps, cfg: s.cfg, sampler_name: s.sampler, scheduler: s.scheduler, denoise: s.strength, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['12', 0] } };
  }
  return loraNode(g, s);
}

/** Expand background: pad the picture and fill the new area. */
function outpaintGraph(s, imageName) {
  return loraNode({
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: s.checkpoint } },
    '10': { class_type: 'LoadImage', inputs: { image: imageName } },
    '11': { class_type: 'ImageScale', inputs: { image: ['10', 0], upscale_method: 'lanczos', width: s.sourceWidth, height: s.sourceHeight, crop: 'disabled' } },
    '12': { class_type: 'ImagePadForOutpaint', inputs: { image: ['11', 0], left: s.left, top: s.top, right: s.right, bottom: s.bottom, feathering: 24 } },
    '13': { class_type: 'VAEEncodeForInpaint', inputs: { pixels: ['12', 0], vae: ['4', 2], mask: ['12', 1], grow_mask_by: 8 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: s.prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: s.negative, clip: ['4', 1] } },
    '3': { class_type: 'KSampler', inputs: { seed: s.seed, steps: s.steps, cfg: s.cfg, sampler_name: s.sampler, scheduler: s.scheduler, denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['13', 0] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'nova-expand', images: ['8', 0] } },
  }, s);
}

/** Upscale with a model in ComfyUI/models/upscale_models; `factor` 2 halves a 4x model's result. */
function upscaleGraph(s, imageName) {
  const g = {
    '10': { class_type: 'LoadImage', inputs: { image: imageName } },
    '20': { class_type: 'UpscaleModelLoader', inputs: { model_name: s.model } },
    '21': { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['20', 0], image: ['10', 0] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'nova-upscale', images: ['21', 0] } },
  };
  if (s.factor !== s.modelScale) { g['22'] = { class_type: 'ImageScaleBy', inputs: { image: ['21', 0], upscale_method: 'lanczos', scale_by: s.factor / s.modelScale } }; g['9'].inputs.images = ['22', 0]; }
  return g;
}

function modelScale(name) { const m = String(name).match(/(?:^|[^0-9])([248])x|x([248])(?:[^0-9]|$)/i); return m ? Number(m[1] || m[2]) : 4; }

function sourceImage(store, dataDir, id) {
  const record = media.getMedia(store, id);
  if (record.kind !== 'image') throw error('Choose an image.');
  const buffer = fs.readFileSync(media.filePath(dataDir, record));
  return { record, buffer, size: imageSize(buffer) };
}

function decodeMask(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw error('Paint over the area to change first.');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 20 * 1024 * 1024) throw error('The mask is too large.', 413);
  if (media.sniff(buf)?.mime !== 'image/png') throw error('The mask must be a PNG.');
  return buf;
}

async function comfyInfo() {
  const info = await comfy.status();
  if (!info.reachable) throw error(info.error || 'ComfyUI is not running. Start it with "Start ComfyUI for NOVA.command".', 503);
  return info;
}

/** Edit area (mode 'edit', from a prompt) or Remove object (mode 'remove'). */
async function inpaint(store, dataDir, input) {
  const info = await comfyInfo();
  const { record, size } = sourceImage(store, dataDir, input.mediaId);
  const mask = decodeMask(input.mask);
  const mode = input.mode === 'remove' ? 'remove' : 'edit';
  const prompt = String(input.prompt || '').trim().slice(0, 2000);
  if (mode === 'edit' && !prompt) throw error('Describe what should appear in the painted area.');
  const dims = fitDims(size.width, size.height, 1.0);
  const settings = { ...baseSettings(input, info), mode, engine: 'sdxl-inpaint', sourceMediaId: record.id, sourceName: record.originalName,
    prompt: mode === 'remove' ? (prompt ? prompt + ', ' + REMOVE_PROMPT : REMOVE_PROMPT) : prompt,
    negative: [String(input.negative || '').slice(0, 1000), mode === 'remove' ? REMOVE_NEGATIVE : ''].filter(Boolean).join(', '),
    strength: mode === 'remove' ? 1 : Math.min(1, Math.max(0.3, Number(input.strength) || 0.85)), grow: Math.round(Math.min(64, Math.max(0, Number(input.grow ?? 8)))), width: dims.width, height: dims.height };
  return comfy.startJob(store, 'image-edit', settings, async job => {
    const src = await comfy.uploadImage(dataDir, record);
    const maskName = await comfy.uploadBuffer(mask, 'nova-mask-' + job.id + '.png');
    return comfy.runGraph(store, dataDir, job, { graph: inpaintGraph(settings, src, maskName), kind: 'image', ext: IMAGE_EXT, name: `${record.originalName.replace(/\.[a-z0-9]+$/i, '')} (${mode === 'remove' ? 'object removed' : 'edited'})`, provenance: settings, label: mode === 'remove' ? 'Remove object' : 'Edit area' });
  });
}

async function outpaint(store, dataDir, input) {
  const info = await comfyInfo();
  const { record, size } = sourceImage(store, dataDir, input.mediaId);
  const plan = expandPlan(size.width, size.height, input.target || '16:9');
  const prompt = String(input.prompt || '').trim().slice(0, 2000);
  const settings = { ...baseSettings(input, info), mode: 'expand', engine: 'sdxl-outpaint', target: input.target || '16:9', sourceMediaId: record.id, sourceName: record.originalName,
    prompt: prompt ? prompt + ', seamless continuation of the scene' : 'seamless natural continuation of the scene, same lighting, same style, same perspective',
    negative: String(input.negative || 'frame, border, text, watermark, seam, blurry').slice(0, 1000), ...plan };
  return comfy.startJob(store, 'image-edit', settings, async job => {
    const src = await comfy.uploadImage(dataDir, record);
    return comfy.runGraph(store, dataDir, job, { graph: outpaintGraph(settings, src), kind: 'image', ext: IMAGE_EXT, name: `${record.originalName.replace(/\.[a-z0-9]+$/i, '')} (expanded ${settings.target})`, provenance: settings, label: 'Expand background' });
  });
}

function runFfmpeg(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] }); let err = '';
    c.stderr.on('data', d => { err = (err + d).slice(-4000); });
    c.on('error', reject);
    c.on('close', code => code === 0 ? resolve() : reject(error('ffmpeg failed: ' + err.trim().split('\n').slice(-2).join(' ').slice(0, 300), 500)));
  });
}

/** Keeps very large results under the library's image limit by re-encoding as high-quality JPEG. */
async function fitLimit(ffmpeg, buffer, ext = '.png') {
  if (buffer.length <= media.LIMITS.image || !ffmpeg) return { buffer, ext };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-fit-'));
  try {
    fs.writeFileSync(path.join(work, 'in.png'), buffer);
    await runFfmpeg(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-i', path.join(work, 'in.png'), '-q:v', '2', path.join(work, 'out.jpg')]);
    return { buffer: fs.readFileSync(path.join(work, 'out.jpg')), ext: '.jpg' };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

/**
 * Upscale 2x or 4x. Uses a ComfyUI upscale model when one is installed and
 * ComfyUI is running (engine 'model'); otherwise ffmpeg's Lanczos resize.
 */
async function upscale(store, dataDir, input, { ffmpeg } = {}) {
  const { record, size } = sourceImage(store, dataDir, input.mediaId);
  const factor = Number(input.factor) === 4 ? 4 : 2;
  if (Math.max(size.width, size.height) * factor > 8192) throw error(`That would be ${size.width * factor}×${size.height * factor}; NOVA keeps upscales to 8192 pixels on the long side. Try 2x.`);
  let info = null;
  try { info = await comfy.status(); } catch (_) {}
  const models = (info && info.reachable && info.upscalers) || [];
  const wanted = input.model && models.includes(input.model) ? input.model : models.find(m => /ultrasharp/i.test(m)) || models[0] || null;
  const base = record.originalName.replace(/\.[a-z0-9]+$/i, '');
  const settings = { engine: wanted ? 'upscale-model' : 'ffmpeg-lanczos', model: wanted, modelScale: wanted ? modelScale(wanted) : null, factor, sourceMediaId: record.id, sourceName: record.originalName, width: size.width * factor, height: size.height * factor, prompt: `${record.originalName} · upscale ${factor}x` };
  if (!wanted && !ffmpeg) throw error('Upscaling needs ComfyUI with an upscale model (double-click "Add upscale model.command") or ffmpeg (brew install ffmpeg).', 412);
  return comfy.startJob(store, 'image-upscale', settings, async job => {
    if (wanted) {
      const src = await comfy.uploadImage(dataDir, record);
      return comfy.runGraph(store, dataDir, job, { graph: upscaleGraph(settings, src), kind: 'image', ext: IMAGE_EXT, name: `${base} (upscaled ${factor}x)`, provenance: settings, label: 'Upscale', source: 'nova-upscale', transform: b => fitLimit(ffmpeg, b) });
    }
    let buffer;
    {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-upscale-'));
      try {
        const out = path.join(work, 'out.png');
        await runFfmpeg(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-i', media.filePath(dataDir, record), '-vf', `scale=iw*${factor}:ih*${factor}:flags=lanczos,unsharp=5:5:0.6:5:5:0`, '-frames:v', '1', '-update', '1', out]);
        buffer = fs.readFileSync(out);
      } finally { fs.rmSync(work, { recursive: true, force: true }); }
    }
    const fit = await fitLimit(ffmpeg, buffer);
    return [media.saveMedia(store, dataDir, { buffer: fit.buffer, originalName: `${base} (upscaled ${factor}x)${fit.ext}`, source: 'nova-upscale', expectKind: 'image', provenance: { generator: settings.engine, ...settings, jobId: job.id } }).id];
  });
}

module.exports = { imageSize, fitDims, expandPlan, inpaintGraph, outpaintGraph, upscaleGraph, modelScale, inpaint, outpaint, upscale, EXPANDS, REMOVE_PROMPT };
