'use strict';
/* ===========================================================================
 * NOVA Runtime — text to audio, on this computer
 *
 *  • Voice: macOS's built-in speech (`say`) reads text aloud in any installed
 *    voice (Hindi, English and many more). Instant, no downloads. Good for
 *    scratch VO, temp dialogue and read-throughs.
 *  • Sound effects: Stable Audio Open 1.0 through the local ComfyUI
 *    (up to 47 seconds: rain on a tin roof, crowd murmur, tank tracks).
 *  • Music and songs: ACE-Step 3.5B through the local ComfyUI (tags such as
 *    "cinematic, tabla, strings" plus lyrics; up to 4 minutes). Lyrics can be
 *    written from an idea first by lib/song-writer.js.
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
  music15: 'ACE-Step 1.5: acestep_v1.5_turbo.safetensors (diffusion_models), qwen_0.6b_ace15 and qwen_1.7b_ace15 (text_encoders), ace_1.5_vae (vae) — double-click "Add ACE-Step 1.5.command" (about 10 GB)',
};
/* ACE-Step 1.5 sings in these languages (ComfyUI's TextEncodeAceStepAudio1.5 list, trimmed to the useful ones here). */
const ACE15_LANGUAGES = ['en', 'hi', 'pa', 'ur', 'bn', 'ta', 'te', 'ne', 'sa', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ar', 'ru', 'tr', 'id', 'th', 'vi'];
const KEYSCALES = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'].flatMap(r => [r + ' major', r + ' minor']);
/** Song-writer language ids → ACE-Step 1.5 language codes. */
const LYRIC_LANG = { english: 'en', hindi: 'hi', 'hindi-roman': 'hi', hinglish: 'hi', punjabi: 'pa', urdu: 'ur' };

function which(name) { try { return execFileSync('/usr/bin/which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch (_) { return null; } }
function sayBin() { return process.env.NOVA_SAY_BIN || (process.platform === 'darwin' ? which('say') : null); }

/* Kokoro-82M (kokoro-onnx): natural offline voices, including Hindi. Installed by
   "Install Kokoro voices for NOVA.command" into ~/kokoro (a Python venv plus two model files). */
const KOKORO_LANGS = { a: ['en-us', 'English (US)'], b: ['en-gb', 'English (UK)'], h: ['hi', 'Hindi'], e: ['es', 'Spanish'], f: ['fr-fr', 'French'], i: ['it', 'Italian'], j: ['ja', 'Japanese'], p: ['pt-br', 'Portuguese (BR)'], z: ['cmn', 'Chinese'] };
const KOKORO_VOICES = ['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'af_sky', 'am_adam', 'am_michael', 'am_fenrir', 'am_puck', 'bf_emma', 'bf_isabella', 'bf_alice', 'bm_george', 'bm_fable', 'bm_lewis', 'hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi', 'ef_dora', 'em_alex', 'ff_siwis', 'if_sara', 'im_nicola', 'jf_alpha', 'jm_kumo', 'pf_dora', 'pm_alex', 'zf_xiaoxiao', 'zm_yunxi'];
function kokoroDir() { return process.env.KOKORO_DIR || path.join(os.homedir(), 'kokoro'); }
function kokoroPython() {
  const p = process.env.NOVA_KOKORO_PYTHON || path.join(kokoroDir(), '.venv', 'bin', 'python');
  try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) { return null; }
}
function kokoroStatus() {
  const python = kokoroPython(), dir = kokoroDir();
  const files = ['kokoro-v1.0.onnx', 'voices-v1.0.bin'].every(f => fs.existsSync(path.join(dir, f)));
  const ready = Boolean(python && files);
  return { ready, dir, missing: ready ? [] : ['Kokoro voices: double-click "Install Kokoro voices for NOVA.command" in the brahmini folder (about 400 MB)'],
    voices: KOKORO_VOICES.map(v => ({ name: 'kokoro:' + v, label: `${v.slice(3).replace(/^./, c => c.toUpperCase())} · ${KOKORO_LANGS[v[0]][1]} · ${v[1] === 'f' ? 'female' : 'male'}`, locale: KOKORO_LANGS[v[0]][0] })) };
}
function kokoroLang(voice) { return (KOKORO_LANGS[String(voice)[0]] || KOKORO_LANGS.a)[0]; }

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

/**
 * Renders text to an audio file in `work` and returns its path. Engine is
 * picked from the voice: "kokoro:<voice>" uses Kokoro, anything else macOS say.
 */
async function synthesize(work, text, { voice = null, rate = 175, name = 'voice' } = {}) {
  fs.writeFileSync(path.join(work, name + '.txt'), text);
  if (String(voice || '').startsWith('kokoro-mix:')) {
    // A blend of Kokoro voices, e.g. "kokoro-mix:af_heart:0.7,bf_emma:0.3" (Voice Studio characters).
    const k = kokoroStatus();
    if (!k.ready) throw error('Kokoro voices are not installed. ' + k.missing[0] + '.', 412);
    const parts = voice.slice(11).split(',').map(x => x.split(':')).filter(([v, w]) => KOKORO_VOICES.includes(v) && Number(w) > 0);
    if (!parts.length) throw error('The voice mix has no known Kokoro voices.');
    const out = path.join(work, name + '.wav');
    const script = process.env.NOVA_KOKORO_SCRIPT || path.join(__dirname, '..', 'scripts', 'kokoro-say.py');
    await run(kokoroPython(), [script, '--text-file', path.join(work, name + '.txt'), '--mix', parts.map(([v, w]) => `${v}:${Number(w)}`).join(','), '--lang', kokoroLang(parts[0][0]), '--speed', String(Math.round((rate / 175) * 100) / 100), '--out', out], 10 * 60 * 1000);
    return out;
  }
  if (String(voice || '').startsWith('kokoro:')) {
    const k = kokoroStatus();
    if (!k.ready) throw error('Kokoro voices are not installed. ' + k.missing[0] + '.', 412);
    const v = voice.slice(7), out = path.join(work, name + '.wav');
    const script = process.env.NOVA_KOKORO_SCRIPT || path.join(__dirname, '..', 'scripts', 'kokoro-say.py');
    await run(kokoroPython(), [script, '--text-file', path.join(work, name + '.txt'), '--voice', v, '--lang', kokoroLang(v), '--speed', String(Math.round((rate / 175) * 100) / 100), '--out', out], 10 * 60 * 1000);
    return out;
  }
  const bin = sayBin();
  if (!bin) throw error('Voice uses the speech built into macOS, which is not available here. Install Kokoro voices to speak on any Mac setup.', 412);
  const aiff = path.join(work, name + '.aiff');
  await run(bin, [...(voice ? ['-v', voice] : []), '-r', String(rate), '-f', path.join(work, name + '.txt'), '-o', aiff], 10 * 60 * 1000);
  return aiff;
}

/** Picks a voice for a language: Kokoro when installed, else a matching macOS voice. */
function voiceFor(locale, preferred = null) {
  if (preferred) return preferred;
  const lang = String(locale || 'en').toLowerCase().slice(0, 2);
  const k = kokoroStatus();
  if (k.ready) { const kv = k.voices.find(v => v.locale.startsWith(lang)); if (kv) return kv.name; }
  const mac = voices().find(v => v.locale.toLowerCase().startsWith(lang));
  return mac ? mac.name : null;
}

function speak(store, dataDir, input) {
  const text = String(input.text || '').trim();
  if (!text) throw error('Type the words to speak.');
  if (text.length > 20000) throw error('Voice is limited to 20,000 characters at a time.');
  const kokoro = String(input.voice || '').startsWith('kokoro:');
  const list = voices();
  if (kokoro) { const k = kokoroStatus(); if (!k.ready) throw error(k.missing[0] + '.', 412); if (!KOKORO_VOICES.includes(input.voice.slice(7))) throw error('Unknown Kokoro voice.'); }
  else if (!sayBin()) throw error('Voice uses the speech built into macOS, which is not available here. Install Kokoro voices, or use a Mac.', 412);
  const voice = kokoro ? input.voice : input.voice && list.some(v => v.name === input.voice) ? input.voice : (list.find(v => /^en[_-]/.test(v.locale)) || list[0] || {}).name || null;
  const rate = Math.round(Math.min(360, Math.max(90, Number(input.rate) || 175)));
  const settings = { engine: kokoro ? 'kokoro-82m' : 'macos-say', prompt: text.slice(0, 120), text, voice, locale: kokoro ? kokoroLang(voice.slice(7)) : (list.find(v => v.name === voice) || {}).locale || null, rate };
  const job = newJob(store, 'audio-voice', settings);
  const done = finish(store, job, async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-say-'));
    try {
      let out = await synthesize(work, text, { voice, rate });
      const afconvert = process.env.NOVA_AFCONVERT_BIN === 'none' ? null : process.platform === 'darwin' ? which('afconvert') : null;
      if (afconvert) { const m4a = path.join(work, 'voice.m4a'); await run(afconvert, ['-f', 'm4af', '-d', 'aac', out, m4a]); out = m4a; }
      return [media.saveMedia(store, dataDir, { buffer: fs.readFileSync(out), originalName: `${text.slice(0, 50)} (${(voice || 'voice').replace(/^kokoro:/, '')})${path.extname(out)}`, source: 'nova-voice', expectKind: 'audio', provenance: { generator: settings.engine, ...settings, jobId: job.id } }).id];
    } finally { try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {} }
  });
  return { job, done };
}

/* ------------------------------ ComfyUI audio ------------------------------ */

async function nodeList(node, field) {
  try { const info = (await (await comfy.call('/object_info/' + node)).json())?.[node]; if (!info) return null; const spec = info.input?.required?.[field]; return Array.isArray(spec) && (Array.isArray(spec[0]) || spec[0] === 'COMBO') ? comfy.comboOptions(spec) : true; }
  catch (e) { if (e.statusCode === 503) throw e; return null; }
}

async function comfyStatus() {
  try {
    await comfy.discover();
    await comfy.call('/system_stats');
    const [ckpts, clips, emptyAudio, emptyAce, saveMp3, unets, dualClips, vaes, emptyAce15] = await Promise.all([nodeList('CheckpointLoaderSimple', 'ckpt_name'), nodeList('CLIPLoader', 'clip_name'), nodeList('EmptyLatentAudio', 'seconds'), nodeList('EmptyAceStepLatentAudio', 'seconds'), nodeList('SaveAudioMP3', 'filename_prefix'), nodeList('UNETLoader', 'unet_name'), nodeList('DualCLIPLoader', 'clip_name1'), nodeList('VAELoader', 'vae_name'), nodeList('EmptyAceStep1.5LatentAudio', 'seconds')]);
    const list = Array.isArray(ckpts) ? ckpts : [], clipList = Array.isArray(clips) ? clips : [];
    const sfx = { checkpoint: list.find(f => /stable[-_]audio/i.test(f)) || null, encoder: clipList.find(f => /t5[-_]base/i.test(f)) || null };
    const music = { checkpoint: list.find(f => /ace[-_]step/i.test(f) && !/1[._]5/.test(f)) || null };
    const arr = x => (Array.isArray(x) ? x : []);
    const te = arr(dualClips).length ? arr(dualClips) : clipList;
    const music15 = { unet: arr(unets).find(f => /acestep_v1\.5_turbo/i.test(f)) || arr(unets).find(f => /acestep_v1\.5/i.test(f) && !/xl/i.test(f)) || null,
      clip1: te.find(f => /qwen_0\.6b_ace15/i.test(f)) || null, clip2: te.find(f => /qwen_1\.7b_ace15/i.test(f)) || te.find(f => /qwen_4b_ace15/i.test(f)) || null, vae: arr(vaes).find(f => /ace_1\.5_vae/i.test(f)) || null };
    const music15Missing = [];
    if (!emptyAce15) music15Missing.push('a newer ComfyUI with ACE-Step 1.5 nodes (update ComfyUI)');
    if (!music15.unet || !music15.clip1 || !music15.clip2 || !music15.vae) music15Missing.push(MODEL_HINTS.music15);
    const sfxMissing = [], musicMissing = [];
    if (!emptyAudio) sfxMissing.push('a newer ComfyUI with audio nodes (update ComfyUI)');
    if (!sfx.checkpoint || !sfx.encoder) sfxMissing.push(MODEL_HINTS.sfx);
    if (!emptyAce) musicMissing.push('a newer ComfyUI with ACE-Step nodes (update ComfyUI)');
    if (!music.checkpoint) musicMissing.push(MODEL_HINTS.music);
    const osBlock = musicBlockedByOs(); if (osBlock) { musicMissing.push(osBlock); music15Missing.push(osBlock); }
    return { reachable: true, url: comfy.baseUrl(), saveNode: saveMp3 ? 'SaveAudioMP3' : 'SaveAudio',
      sfx: { ready: !sfxMissing.length, missing: sfxMissing, ...sfx }, music: { ready: !musicMissing.length, missing: musicMissing, ...music }, music15: { ready: !music15Missing.length, missing: music15Missing, ...music15, languages: ACE15_LANGUAGES, keyscales: KEYSCALES } };
  } catch (e) {
    return { reachable: false, error: e.message, sfx: { ready: false, missing: [] }, music: { ready: false, missing: [] }, music15: { ready: false, missing: [], languages: ACE15_LANGUAGES, keyscales: KEYSCALES } };
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

/** ComfyUI's official ACE-Step 1.5 turbo text-to-song graph (8 steps, CFG 1, AuraFlow shift 3). */
function music15Graph(s, save) {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: s.unet, weight_dtype: 'default' } },
    '2': { class_type: 'DualCLIPLoader', inputs: { clip_name1: s.clip1, clip_name2: s.clip2, type: 'ace', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: s.vae } },
    '4': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3 } },
    '5': { class_type: 'TextEncodeAceStepAudio1.5', inputs: { clip: ['2', 0], tags: s.prompt, lyrics: s.lyrics, seed: s.seed, bpm: s.bpm, duration: s.seconds, timesignature: '4', language: s.language, keyscale: s.keyscale, generate_audio_codes: true, cfg_scale: 2, temperature: 0.85, top_p: 0.9, top_k: 0, min_p: 0 } },
    '6': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['5', 0] } },
    '7': { class_type: 'EmptyAceStep1.5LatentAudio', inputs: { seconds: s.seconds, batch_size: 1 } },
    '8': { class_type: 'KSampler', inputs: { seed: s.seed, steps: s.steps, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['4', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['7', 0] } },
    '9': { class_type: 'VAEDecodeAudio', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    '10': saveNode(save, ['9', 0]),
  };
}

function musicSettings(input, prompt, part, engine) {
  const base = { title: String(input.title || '').trim().slice(0, 120) || null, prompt, lyrics: String(input.lyrics || '[instrumental]').slice(0, 4000) || '[instrumental]', seed: seedOf(input.seed) };
  if (engine === 'ace-step-1.5') {
    const language = ACE15_LANGUAGES.includes(input.language) ? input.language : LYRIC_LANG[input.language] || 'en';
    const bpm = Math.round(Math.min(220, Math.max(40, Number(input.bpm) || 100)));
    const keyscale = KEYSCALES.includes(input.keyscale) ? input.keyscale : 'C major';
    return { engine, ...base, language, bpm, keyscale, seconds: Math.round(Math.min(360, Math.max(10, Number(input.seconds) || 30))), steps: Math.round(Math.min(50, Math.max(4, Number(input.steps) || 8))), unet: part.unet, clip1: part.clip1, clip2: part.clip2, vae: part.vae };
  }
  return { engine: 'ace-step-v1-3.5b', ...base, seconds: Math.round(Math.min(240, Math.max(5, Number(input.seconds) || 30))), steps: Math.round(Math.min(100, Math.max(10, Number(input.steps) || 50))), checkpoint: part.checkpoint };
}

/**
 * Makes the same song with ACE-Step 1 and 1.5, one after the other (one heavy job at a time),
 * and records how long each took so they can be compared by ear side by side.
 */
async function compareMusic(store, dataDir, input) {
  await comfy.ensureReady();
  const info = await comfyStatus();
  if (!info.reachable) throw error(info.error, 503);
  if (!info.music.ready) throw error('ACE-Step 1 needs: ' + info.music.missing.join('; ') + '.', 412);
  if (!info.music15.ready) throw error('ACE-Step 1.5 needs: ' + info.music15.missing.join('; ') + '.', 412);
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw error('Describe the music style first.');
  const seed = seedOf(input.seed), group = 'cmp_' + crypto.randomBytes(5).toString('hex');
  const v1 = musicSettings({ ...input, seed }, prompt, info.music, 'ace-step-1');
  const v15 = musicSettings({ ...input, seed }, prompt, info.music15, 'ace-step-1.5');
  const settings = { engine: 'compare', prompt: `Compare ACE-Step 1 vs 1.5 · ${(v1.title || prompt).slice(0, 60)}`, group, title: v1.title, language: v15.language, seconds: v15.seconds };
  return comfy.startJob(store, 'audio-music', settings, async job => {
    const ids = [];
    for (const [label, s, g] of [['1.5', v15, music15Graph(v15, info.saveNode)], ['1', v1, musicGraph(v1, info.saveNode)]]) {
      const t0 = Date.now();
      job.progress = `Composing with ACE-Step ${label}…`; store.put('generationJobs', job);
      const got = await comfy.runGraph(store, dataDir, job, { graph: g, kind: 'audio', ext: AUDIO_EXT, name: `${(s.title || prompt).slice(0, 50)} (ACE-Step ${label})`, provenance: { ...s, compareGroup: group }, timeoutMs: 60 * 60 * 1000, label: 'ACE-Step ' + label });
      const took = Math.round((Date.now() - t0) / 1000);
      for (const id of got) { const r = store.get('media', id); if (r) { r.provenance = { ...r.provenance, secondsTaken: took }; store.put('media', r); } }
      ids.push(...got);
    }
    return ids;
  });
}

async function generate(store, dataDir, kind, input) {
  await comfy.ensureReady();
  const info = await comfyStatus();
  if (!info.reachable) throw error(info.error, 503);
  // Songs use ACE-Step 1.5 when it is installed (unless engine 'ace-step-1' is asked for), else ACE-Step 1.
  const engine = kind === 'music' ? (input.engine === 'ace-step-1' ? 'ace-step-1' : input.engine === 'ace-step-1.5' ? 'ace-step-1.5' : info.music15.ready ? 'ace-step-1.5' : 'ace-step-1') : null;
  const part = engine === 'ace-step-1.5' ? info.music15 : info[kind];
  if (!part.ready) throw error(`${kind === 'sfx' ? 'Sound effects need' : engine === 'ace-step-1.5' ? 'ACE-Step 1.5 needs' : 'Music needs'}: ${part.missing.join('; ')}.`, 412);
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw error(kind === 'sfx' ? 'Describe the sound, e.g. "heavy monsoon rain on a tin roof, distant thunder".' : 'Describe the music, e.g. "cinematic, tabla, strings, slow build".');
  if (prompt.length > 1000) throw error('The description is limited to 1,000 characters.');
  const settings = kind === 'sfx'
    ? { engine: 'stable-audio-open-1.0', prompt, negative: String(input.negative || 'low quality, distorted').slice(0, 500), seconds: Math.round(Math.min(47, Math.max(1, Number(input.seconds) || 10)) * 10) / 10, steps: Math.round(Math.min(100, Math.max(10, Number(input.steps) || 50))), cfg: 5, seed: seedOf(input.seed), checkpoint: part.checkpoint, encoder: part.encoder }
    : musicSettings(input, prompt, part, engine);
  const g = kind === 'sfx' ? sfxGraph(settings, info.saveNode) : engine === 'ace-step-1.5' ? music15Graph(settings, info.saveNode) : musicGraph(settings, info.saveNode);
  return comfy.startJob(store, kind === 'sfx' ? 'audio-sfx' : 'audio-music', settings, job => comfy.runGraph(store, dataDir, job, { graph: g, kind: 'audio', ext: AUDIO_EXT, name: (settings.title || prompt).slice(0, 60), provenance: settings, timeoutMs: 60 * 60 * 1000, label: kind === 'sfx' ? 'Sound effect' : 'Music' }));
}

/** macOS before 15.1 (Darwin < 24.1) cannot run ACE-Step's vocoder on the GPU, and the CPU fallback runs out of memory. */
function musicBlockedByOs() {
  if (process.env.NOVA_ALLOW_MUSIC_OLD_MACOS === '1' || process.platform !== 'darwin') return null;
  const [maj, min] = os.release().split('.').map(Number);
  return maj < 24 || (maj === 24 && min < 1) ? 'macOS 15.1 or later (older macOS cannot decode ACE-Step music on the Apple GPU)' : null;
}

async function status() {
  const v = voices();
  const kokoro = kokoroStatus();
  return { voice: { ready: Boolean(sayBin()) || kokoro.ready, voices: v, kokoro, error: sayBin() || kokoro.ready ? null : 'Voice uses the speech built into macOS, or Kokoro voices.' }, comfy: await comfyStatus() };
}

module.exports = { KOKORO_VOICES, KOKORO_LANGS, compareMusic, music15Graph, musicSettings, ACE15_LANGUAGES, KEYSCALES, LYRIC_LANG, status, speak, synthesize, voiceFor, voices, kokoroStatus, kokoroLang, generate, parseVoices, sfxGraph, musicGraph, comfyStatus, _resetVoices: () => { voiceCache = null; } };
