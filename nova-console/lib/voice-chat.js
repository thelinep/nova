'use strict';
/* ===========================================================================
 * Voice chat: talk to NOVA and hear it answer
 *
 * transcribeClip() turns a short recording from the microphone into text with
 * whisper.cpp (the same engine as Media > Transcribe). speakText() reads a
 * reply aloud with Kokoro when installed, else the macOS voice, and returns
 * a WAV/M4A file the console plays. Both run on this computer.
 * ========================================================================= */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const transcriber = require('./transcribe');
const audioGen = require('./audio-gen');

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function run(file, args, timeout = 120000) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) { err.message = String(stderr || err.message).trim().slice(-600) || err.message; reject(err); } else resolve(String(stdout));
  }));
}
const EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac' };

async function transcribeClip(dataDir, buffer, mime = 'audio/webm', language = 'auto') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 800) throw error('The recording was too short. Hold the mic button while you speak.');
  if (buffer.length > 25 * 1024 * 1024) throw error('Recordings for chat are limited to about 10 minutes.', 413);
  const tools = transcriber.status(dataDir);
  if (!tools.binary) throw error('Speaking to NOVA needs whisper.cpp: brew install whisper-cpp, then add a speech model (Help > Audio).', 412);
  const model = transcriber.pickModel(dataDir, language) || transcriber.pickModel(dataDir, 'en');
  if (!model) throw error('No whisper speech model is installed yet. Double-click "Add multilingual speech model.command" in the brahmini folder.', 412);
  const type = String(mime).split(';')[0];
  const ext = EXT[type] || 'webm';
  if (!tools.ffmpeg && !['wav', 'm4a', 'mp3', 'aac'].includes(ext)) throw error('This recording format needs ffmpeg (brew install ffmpeg).', 412);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-voice-'));
  try {
    const input = path.join(work, 'clip.' + ext), wav = path.join(work, 'clip.wav');
    fs.writeFileSync(input, buffer);
    if (tools.ffmpeg) await run(tools.ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-i', input, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    else await run(tools.afconvert, ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', input, wav]);
    const multi = transcriber.isMultilingual(model);
    await run(tools.binary, ['-m', model, '-f', wav, '-oj', '-of', path.join(work, 'out'), '-np', '-l', multi ? language : 'en'], 5 * 60 * 1000);
    const result = transcriber.parseWhisperJson(JSON.parse(fs.readFileSync(path.join(work, 'out.json'), 'utf8')));
    const text = result.segments.map(s => s.text).join(' ').replace(/\s+/g, ' ').replace(/\[(BLANK_AUDIO|MUSIC|NOISE)\]/gi, '').trim();
    if (!text) throw error('I did not catch any words. Try again a little closer to the mic.', 422);
    return { text, language: result.language || (multi ? language : 'en') };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

/** Removes Markdown so replies sound natural when read aloud. */
function speakable(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' (code shown on screen) ')
    .replace(/`([^`]+)`/g, '$1').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s*[-*•]\s+/gm, '').replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/\|/g, ', ').replace(/https?:\/\/\S+/g, 'the link')
    .replace(/\s+/g, ' ').trim().slice(0, 6000);
}

async function speakText(dataDir, text, { voice = null, rate = 185 } = {}) {
  const words = speakable(text);
  if (!words) throw error('Nothing to read aloud.');
  const k = audioGen.kokoroStatus();
  const chosen = voice || (k.ready ? audioGen.voiceFor('en') : null);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-say-'));
  const out = await audioGen.synthesize(work, words, { voice: chosen, rate, name: 'reply' });
  // Chromium cannot play AIFF: hand back WAV.
  let file = out, type = out.endsWith('.wav') ? 'audio/wav' : 'audio/aiff';
  if (out.endsWith('.aiff')) {
    const wav = path.join(work, 'reply.wav');
    try { await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16', out, wav], 60000); file = wav; type = 'audio/wav'; } catch (_) { /* Safari/WebKit plays AIFF */ }
  }
  const data = fs.readFileSync(file);
  fs.rmSync(work, { recursive: true, force: true });
  return { data, type, voice: chosen || 'macOS default' };
}

module.exports = { transcribeClip, speakText, speakable };
