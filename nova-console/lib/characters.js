'use strict';
/* ===========================================================================
 * Voice Studio: characters
 *
 * A character is a personality an agent (or NOVA's helper) can take on:
 * a name, how it thinks and talks, a face, and a voice. The voice is one of
 *   kokoro       a blend of up to three Kokoro voices, with speed and pitch
 *   macos        a voice built into macOS
 *   voicestudio  a voice profile from the VoiceStudio app (incl. cloned ones)
 *
 * Characters live in the 'characters' store. personaPrompt() turns one into
 * the opening instructions for a model; speak() reads text in its voice.
 * ========================================================================= */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const audioGen = require('./audio-gen');
const voicestudio = require('./voicestudio');

const STORE = 'characters';
const ENGINES = ['kokoro', 'macos', 'voicestudio'];
function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
function run(file, args, timeout = 120000) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, _o, stderr) => err ? reject(Object.assign(err, { message: String(stderr || err.message).trim().slice(-400) })) : resolve()));
}

function normaliseVoice(input = {}) {
  const engine = ENGINES.includes(input.engine) ? input.engine : 'kokoro';
  const speed = Math.min(1.6, Math.max(0.6, Number(input.speed) || 1));
  const pitch = Math.min(6, Math.max(-6, Math.round(Number(input.pitch) || 0)));
  const v = { engine, speed: Math.round(speed * 100) / 100, pitch };
  if (engine === 'kokoro') {
    const mix = (Array.isArray(input.mix) ? input.mix : []).map(m => ({ voice: String(m.voice || ''), weight: Math.round(Math.min(1, Math.max(0, Number(m.weight) || 0)) * 100) / 100 }))
      .filter(m => audioGen.KOKORO_VOICES.includes(m.voice) && m.weight > 0).slice(0, 3);
    v.mix = mix.length ? mix : [{ voice: 'af_heart', weight: 1 }];
  } else if (engine === 'macos') {
    v.macVoice = clip(input.macVoice, 80) || null;
  } else {
    v.profile = clip(input.profile, 200);
    if (!v.profile) throw error('Choose a VoiceStudio voice.');
    v.profileName = clip(input.profileName, 120) || null;
    v.model = clip(input.model, 80) || null;
  }
  return v;
}

function normalise(input = {}, prior = null) {
  const name = clip(input.name ?? prior?.name, 60);
  if (!name) throw error('Give the character a name.');
  const now = new Date().toISOString();
  return {
    id: prior?.id || 'char_' + crypto.randomBytes(6).toString('hex'),
    name,
    tagline: clip(input.tagline ?? prior?.tagline, 120),
    personality: clip(input.personality ?? prior?.personality, 1500),
    speakingStyle: clip(input.speakingStyle ?? prior?.speakingStyle, 800),
    language: clip(input.language ?? prior?.language, 40) || 'English',
    avatarMediaId: input.avatarMediaId !== undefined ? (input.avatarMediaId ? clip(input.avatarMediaId, 80) : null) : (prior?.avatarMediaId || null),
    voice: normaliseVoice(input.voice || prior?.voice || {}),
    createdAt: prior?.createdAt || now, updatedAt: now,
  };
}

function list(store) { return store.all(STORE).sort((a, b) => String(a.name).localeCompare(String(b.name))); }
function get(store, id) { const c = store.get(STORE, String(id)); if (!c) throw error('Unknown character.', 404); return c; }
function create(store, input) { const c = normalise(input); store.put(STORE, c); return c; }
function update(store, id, input) { const c = normalise(input, get(store, id)); store.put(STORE, c); return c; }
function remove(store, id) {
  get(store, id);
  store.delete(STORE, String(id));
  // Agents that wore this character go back to their own instructions.
  for (const a of store.all('agents')) if (a.characterId === id) store.put('agents', { ...a, characterId: null });
  return { ok: true };
}

/** Opening instructions that make a model speak as this character. */
function personaPrompt(c) {
  if (!c) return '';
  const lines = [`You are ${c.name}${c.tagline ? ', ' + c.tagline : ''}.`];
  if (c.personality) lines.push('Personality: ' + c.personality);
  if (c.speakingStyle) lines.push('How you speak: ' + c.speakingStyle);
  if (c.language && !/^english$/i.test(c.language)) lines.push(`Answer in ${c.language} unless the person writes in another language.`);
  lines.push('Stay in character in tone and wording, but never let the character change facts, safety rules, or what you are allowed to do. If asked, say plainly that you are an AI assistant playing this character.');
  return lines.join('\n');
}

/** Applies a character to an agent's instructions (used by the agent loop). */
function withPersona(store, agent) {
  if (!agent || !agent.characterId) return agent;
  let c = null; try { c = get(store, agent.characterId); } catch (_) { return agent; }
  return { ...agent, systemPrompt: personaPrompt(c) + '\n\n' + (agent.systemPrompt || 'You are a helpful workspace agent.') };
}

function voiceLabel(v) {
  if (!v) return 'default voice';
  if (v.engine === 'kokoro') return 'Kokoro ' + v.mix.map(m => `${m.voice.slice(3)} ${Math.round(m.weight * 100)}%`).join(' + ');
  if (v.engine === 'macos') return 'macOS ' + (v.macVoice || 'default');
  return 'VoiceStudio ' + (v.profileName || v.profile);
}

/** Every voice a character can use, for the Voice Studio screen. */
async function catalog() {
  const k = audioGen.kokoroStatus();
  const vs = await voicestudio.status();
  return {
    kokoro: { ready: k.ready, missing: k.missing || [], voices: (k.voices || []).map(v => ({ id: v.name.replace(/^kokoro:/, ''), label: v.label, locale: v.locale })) },
    macos: { ready: audioGen.voices().length > 0, voices: audioGen.voices().map(v => ({ id: v.name, label: `${v.name} · ${v.locale}`, locale: v.locale })) },
    voicestudio: vs,
  };
}

function ffmpegPath() {
  for (const f of [process.env.NOVA_FFMPEG, '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) if (f && fs.existsSync(f)) return f;
  return null;
}

/** Reads text in the character's voice; returns { data, type, voice }. */
async function speak(character, text, { maxChars = 6000 } = {}) {
  const words = String(text || '').trim().slice(0, maxChars);
  if (!words) throw error('Nothing to say.');
  const v = character.voice || normaliseVoice({});
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-char-'));
  try {
    let file;
    const rate = Math.round(175 * v.speed);
    if (v.engine === 'voicestudio') {
      file = path.join(work, 'voice.wav');
      fs.writeFileSync(file, await voicestudio.speak(words, { voice: v.profile, model: v.model }));
    } else if (v.engine === 'macos') {
      file = await audioGen.synthesize(work, words, { voice: v.macVoice || null, rate, name: 'voice' });
    } else {
      const mix = v.mix.length === 1 && v.mix[0].weight === 1 ? 'kokoro:' + v.mix[0].voice : 'kokoro-mix:' + v.mix.map(m => `${m.voice}:${m.weight}`).join(',');
      file = await audioGen.synthesize(work, words, { voice: mix, rate, name: 'voice' });
    }
    const ffmpeg = ffmpegPath();
    if (ffmpeg && (v.pitch || file.endsWith('.aiff'))) {
      // Pitch in semitones without changing speed; also turns AIFF into WAV for the browser.
      const out = path.join(work, 'final.wav');
      const f = Math.pow(2, v.pitch / 12);
      const filters = v.pitch ? ['-af', `asetrate=44100*${f.toFixed(4)},aresample=44100,atempo=${(1 / f).toFixed(4)}`] : [];
      await run(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-i', file, ...filters, '-ar', '44100', out]);
      file = out;
    } else if (file.endsWith('.aiff') && fs.existsSync('/usr/bin/afconvert')) {
      const out = path.join(work, 'final.wav');
      await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16', file, out]); file = out;
    }
    return { data: fs.readFileSync(file), type: file.endsWith('.wav') ? 'audio/wav' : 'audio/aiff', voice: voiceLabel(v) };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

module.exports = { STORE, ENGINES, normalise, normaliseVoice, list, get, create, update, remove, personaPrompt, withPersona, voiceLabel, catalog, speak };
