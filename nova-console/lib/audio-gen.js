'use strict';
/* ===========================================================================
 * NOVA Runtime — text to audio, on this computer
 *
 *  • Voice: macOS's built-in speech (`say`) reads text aloud in any installed
 *    voice (Hindi, English and many more). Instant, no downloads. Good for
 *    scratch VO, temp dialogue and read-throughs.
 *  • Sound effects: Stable Audio Open 1.0 through the local ComfyUI
 *    (up to 47 seconds: rain on a tin roof, crowd murmur, tank tracks).
 *  • Music: ACE-Step 3.5B through the local ComfyUI (tags such as
 *    "cinematic, tabla, strings" plus optional lyrics; up to 4 minutes).
 *
 * Results land in the media library (and the library folder) as audio with
 * their full recipe.
 * ========================================================================= */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const media = require('./media');
const comfy = require('./image-gen');

const { error } = comfy;
const AUDIO_EXT = /\.(mp3|flac|wav|opus|ogg)$/i;
const MODEL_HINTS = {
  sfx: 'stable-audio-open-1.0.safetensors in ComfyUI/models/checkpoints and t5-base.safetensors in ComfyUI/models/text_encoders (double-click "Add audio models.command")',
  music: 'ace_step_v1_3.5b.safetensors in ComfyUI/models/checkpoints (double-click "Add audio models.command")',
};

function which(name) { try { return execFileSync('/usr/bin/which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch (_) { return null; } }
function sayBin() { return process.env.NOVA_SAY_BIN || (process.platform === 'darwin' ? which('say') : null); }

let voiceCache = null;
/** Parses `say -v ?` lines like "Lekha               hi_IN    # नमस्ते, मेरा नाम लेखा है।" */
function parseVoices(text) {
  return String(text).split('\n').map(line => line.match(/^(.+?)\s{2,}([a-z]{2,3}[_-][A-Za-z0-9]+)\s+#\s?(.*)$/)).filter(Boolean).map(m => ({ name: m[1].trim(), locale: m[2], sample: m[3].trim() }));
}
function voices() {
  const bin = sayBin();
  if (!bin) return [];
  if (!voiceCache) { try { voiceCache = parseVoices(execFileSync(bin, ['-v', '?'], { encoding: 'utf8', timeout: 8000 })); } catch (_) { voiceCache = []; } }
  return voiceCache;
}

function run(file, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout: timeoutMs }, (e, _out, err) => e ? reject(error(`${path.basename(file)} failed: ${String(err || e.message).trim().slice(0, 300)}`, 500)) : resolve()));
}

function newJob(store, type, settings) {
  const job = { id: 'gen_' + crypto.randomBytes(8).toString('hex'), type, status: 'running', settings, promptId: null, mediaIds: [], error: null, cancelRequested: false, createdAt: new Date().toISOString(), finishedAt: null };
  store.put('generationJobs', job);
  return job;
}
function finish(store, job, promise) {
  return (async () => {
    try { job.mediaIds = await promise(); job.status = 'done'; }
    catch (e) { job.status = e.statusCode === 499 ? 'cancelled' : 'failed'; job.error = e.message || String(e); }
    finally { job.finishedAt = new Date().toISOString(); store.put('generationJobs', job); }
  })();
}

/* ---------------------------------- voice ---------------------------------- */

function speak(store, dataDir, input) {
  const bin = sayBin();
  if (!bin) throw error('Voice uses the speech built into macOS, which is not available here.', 412);
  const text = String(input.text || '').trim();
  if (!text) throw error('Type the words to speak.');
  if (text.length > 20000) throw error('Voice is limited to 20,000 characters at a time.');
  const list = voices();
  const voice = input.voice && list.some(v => v.name === input.voice) ? input.voice : (list.find(v => /^en[_-]/.test(v.locale)) || list[0] || {}).name || null;
  const rate = Math.round(Math.min(360, Math.max(90, Number(input.rate) || 175)));
  const settings = { engine: 'macos-say', prompt: text.slice(0, 120), text, voice, locale: (list.find(v => v.name === voice) || {}).locale || null, rate };
  const job = newJob(store, 'audio-voice', settings);
  const done = finish(store, job, async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-say-'));
    try {
      fs.writeFileSync(path.join(work, 'text.txt'), text);
      const aiff = path.join(work, 'voice.aiff');
      await run(bin, [...(voice ? ['-v', voice] : []), '-r', String(rate), '-f', path.join(work, 'text.txt'), '-o', aiff], 10 * 60 * 1000);
      let out = aiff;
      const afconvert = process.env.NOVA_AFCONVERT_BIN === 'none' ? null : process.platform === 'darwin' ? which('afconvert') : null;
      if (afconvert) { out = path.join(work, 'voice.m4a'); await run(afconvert, ['-f', 'm4af', '-d', 'aac', aiff, out]); }
      return [media.saveMedia(store, dataDir, { buffer: fs.readFileSync(out), originalName: `${text.slice(0, 50)} (${voice || 'voice'})${path.extname(out)}`, source: 'nova-voice', expectKind: 'audio', provenance: { generator: 'macos-say', ...settings, jobId: job.id } }).id];
    } finally { try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {} }
  });
  return { job, done };
}

/* ------------------------------ ComfyUI audio ------------------------------ */

async function nodeList(node, field) {
  try { const info = (await (await comfy.call('/object_info/' + node)).json())?.[node]; return info ? (info.input?.required?.[field]?.[0] || true) : null; }
  catch (e) { if (e.statusCode === 503) throw e; return null; }
}

async function comfyStatus() {
  try {
    await comfy.discover();
    await comfy.call('/system_stats');
    const [ckpts, clips, emptyAudio, emptyAce, saveMp3] = await Promise.all([nodeList('CheckpointLoaderSimple', 'ckpt_name'), nodeList('CLIPLoader', 'clip_name'), nodeList('EmptyLatentAudio', 'seconds'), nodeList('EmptyAceStepLatentAudio', 'seconds'), nodeList('SaveAudioMP3', 'filename_prefix')]);
    const list = Array.isArray(ckpts) ? ckpts : [], clipList = Array.isArray(clips) ? clips : [];
    const sfx = { checkpoint: list.find(f => /stable[-_]audio/i.test(f)) || null, encoder: clipList.find(f => /t5[-_]base/i.test(f)) || null };
    const music = { checkpoint: list.find(f => /ace[-_]step/i.test(f)) || null };
    const sfxMissing = [], musicMissing = [];
    if (!emptyAudio) sfxMissing.push('a newer ComfyUI with audio nodes (update ComfyUI)');
    if (!sfx.checkpoint || !sfx.encoder) sfxMissing.push(MODEL_HINTS.sfx);
    if (!emptyAce) musicMissing.push('a newer ComfyUI with ACE-Step nodes (update ComfyUI)');
    if (!music.checkpoint) musicMissing.push(MODEL_HINTS.music);
    return { reachable: true, url: comfy.baseUrl(), saveNode: saveMp3 ? 'SaveAudioMP3' : 'SaveAudio',
      sfx: { ready: !sfxMissing.length, missing: sfxMissing, ...sfx }, music: { ready: !musicMissing.length, missing: musicMissing, ...music } };
  } catch (e) {
    return { reachable: false, error: e.message, sfx: { ready: false, missing: [] }, music: { ready: false, missing: [] } };
  }
}

function saveNode(nodeName, audioRef) {
  return nodeName === 'SaveAudioMP3' ? { class_type: 'SaveAudioMP3', inputs: { audio: audioRef, filename_prefix: 'audio/nova', quality: 'V0' } } : { class_type: 'SaveAudio', inputs: { audio: audioRef, filename_prefix: 'audio/nova' } };
}
const seedOf = v => Number.isSafeInteger(Number(v)) && Number(v) >= 0 && v !== '' && v != null ? Number(v) : crypto.randomInt(0, 2 ** 31 - 1);

/** ComfyUI's Stable Audio Open example graph. */
function sfxGraph(s, save) {
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: s.checkpoint } },
    '10': { class_type: 'CLIPLoader', inputs: { clip_name: s.encoder, type: 'stable_audio' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: s.prompt, clip: ['10', 0] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: s.negative, clip: ['10', 0] } },
    '11': { class_type: 'EmptyLatentAudio', inputs: { seconds: s.seconds, batch_size: 1 } },
    '3': { class_type: 'KSampler', inputs: { seed: s.seed, steps: s.steps, cfg: s.cfg, sampler_name: 'dpmpp_3m_sde', scheduler: 'exponential', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['11', 0] } },
    '12': { class_type: 'VAEDecodeAudio', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '19': saveNode(save, ['12', 0]),
  };
}

/** ComfyUI's ACE-Step text-to-song example graph. */
function musicGraph(s, save) {
  return {
    '40': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: s.checkpoint } },
    '51': { class_type: 'ModelSamplingSD3', inputs: { model: ['40', 0], shift: 5 } },
    '50': { class_type: 'LatentOperationTonemapReinhard', inputs: { multiplier: 1 } },
    '49': { class_type: 'LatentApplyOperationCFG', inputs: { model: ['51', 0], operation: ['50', 0] } },
    '14': { class_type: 'TextEncodeAceStepAudio', inputs: { clip: ['40', 1], tags: s.prompt, lyrics: s.lyrics, lyrics_strength: 0.99 } },
    '44': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['14', 0] } },
    '17': { class_type: 'EmptyAceStepLatentAudio', inputs: { seconds: s.seconds, batch_size: 1 } },
    '52': { class_type: 'KSampler', inputs: { seed: s.seed, steps: s.steps, cfg: 5, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['49', 0], positive: ['14', 0], negative: ['44', 0], latent_image: ['17', 0] } },
    '18': { class_type: 'VAEDecodeAudio', inputs: { samples: ['52', 0], vae: ['40', 2] } },
    '59': saveNode(save, ['18', 0]),
  };
}

async function generate(store, dataDir, kind, input) {
  const info = await comfyStatus();
  if (!info.reachable) throw error(info.error, 503);
  const part = info[kind];
  if (!part.ready) throw error(`${kind === 'sfx' ? 'Sound effects need' : 'Music needs'}: ${part.missing.join('; ')}.`, 412);
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw error(kind === 'sfx' ? 'Describe the sound, e.g. "heavy monsoon rain on a tin roof, distant thunder".' : 'Describe the music, e.g. "cinematic, tabla, strings, slow build".');
  if (prompt.length > 1000) throw error('The description is limited to 1,000 characters.');
  const settings = kind === 'sfx'
    ? { engine: 'stable-audio-open-1.0', prompt, negative: String(input.negative || 'low quality, distorted').slice(0, 500), seconds: Math.round(Math.min(47, Math.max(1, Number(input.seconds) || 10)) * 10) / 10, steps: Math.round(Math.min(100, Math.max(10, Number(input.steps) || 50))), cfg: 5, seed: seedOf(input.seed), checkpoint: part.checkpoint, encoder: part.encoder }
    : { engine: 'ace-step-v1-3.5b', prompt, lyrics: String(input.lyrics || '[instrumental]').slice(0, 4000) || '[instrumental]', seconds: Math.round(Math.min(240, Math.max(5, Number(input.seconds) || 30))), steps: Math.round(Math.min(100, Math.max(10, Number(input.steps) || 50))), seed: seedOf(input.seed), checkpoint: part.checkpoint };
  const g = kind === 'sfx' ? sfxGraph(settings, info.saveNode) : musicGraph(settings, info.saveNode);
  return comfy.startJob(store, kind === 'sfx' ? 'audio-sfx' : 'audio-music', settings, job => comfy.runGraph(store, dataDir, job, { graph: g, kind: 'audio', ext: AUDIO_EXT, name: prompt.slice(0, 60), provenance: settings, timeoutMs: 60 * 60 * 1000, label: kind === 'sfx' ? 'Sound effect' : 'Music' }));
}

async function status() {
  const v = voices();
  return { voice: { ready: Boolean(sayBin()), voices: v, error: sayBin() ? null : 'Voice uses the speech built into macOS.' }, comfy: await comfyStatus() };
}

module.exports = { status, speak, generate, parseVoices, sfxGraph, musicGraph, comfyStatus, _resetVoices: () => { voiceCache = null; } };
