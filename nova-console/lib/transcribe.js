'use strict';
/* ===========================================================================
 * NOVA Runtime — local speech-to-text with whisper.cpp
 *
 * Uses a whisper.cpp binary and model already on this computer; nothing is
 * downloaded and no audio leaves the machine.
 *   binary  WHISPER_BIN, else `whisper-cli` / `whisper-cpp` / `whisper` on PATH
 *   model   WHISPER_MODEL, else the first ggml-*.bin in <DATA_DIR>/models/whisper
 *   ffmpeg  FFMPEG_BIN, else `ffmpeg` on PATH; converts any accepted audio to
 *           the 16 kHz mono WAV whisper.cpp expects. If ffmpeg is missing or
 *           will not start (for example after a failed Homebrew upgrade),
 *           macOS's built-in `afconvert` is used instead for WAV, AIFF, MP3,
 *           M4A and FLAC.
 * Transcription runs in the background. The result (full text plus
 * timestamped segments) is stored on the media record and, when a
 * collection is chosen, added to Knowledge so it can be searched, cited
 * and summarized.
 * ========================================================================= */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const media = require('./media');

const TIMEOUT_MS = 60 * 60 * 1000;
const running = new Map();

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

function which(names) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).concat(['/opt/homebrew/bin', '/usr/local/bin']);
  for (const name of names) for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch (_) {}
  }
  return null;
}

function findModel(dataDir) {
  if (process.env.WHISPER_MODEL) return fs.existsSync(process.env.WHISPER_MODEL) ? process.env.WHISPER_MODEL : null;
  const dir = path.join(dataDir, 'models', 'whisper');
  try { const file = fs.readdirSync(dir).filter(f => /^ggml-.*\.bin$/.test(f)).sort()[0]; return file ? path.join(dir, file) : null; }
  catch (_) { return null; }
}

const AFCONVERT_MIMES = new Set(['audio/wav', 'audio/aiff', 'audio/mpeg', 'audio/mp4', 'audio/flac']);

/** True when the program starts and exits cleanly with the given args. */
function runs(file, args) {
  try { execFileSync(file, args, { stdio: 'ignore', timeout: 8000 }); return true; } catch (_) { return false; }
}

function status(dataDir) {
  const binary = process.env.WHISPER_BIN && fs.existsSync(process.env.WHISPER_BIN) ? process.env.WHISPER_BIN : which(['whisper-cli', 'whisper-cpp', 'whisper']);
  const ffmpegPath = process.env.FFMPEG_BIN && fs.existsSync(process.env.FFMPEG_BIN) ? process.env.FFMPEG_BIN : which(['ffmpeg']);
  const ffmpeg = ffmpegPath && runs(ffmpegPath, ['-version']) ? ffmpegPath : null;
  const afconvert = process.env.AFCONVERT_BIN && fs.existsSync(process.env.AFCONVERT_BIN) ? process.env.AFCONVERT_BIN : which(['afconvert']);
  const converter = ffmpeg ? 'ffmpeg' : afconvert ? 'afconvert' : null;
  const model = findModel(dataDir);
  const missing = [];
  if (!binary) missing.push('whisper.cpp (brew install whisper-cpp)');
  if (!converter) missing.push(ffmpegPath ? 'a working ffmpeg (the installed one does not start; reinstall with brew reinstall ffmpeg)' : 'ffmpeg (brew install ffmpeg)');
  if (!model) missing.push(`a whisper model file, e.g. ggml-base.en.bin, in ${path.join(dataDir, 'models', 'whisper')} (or set WHISPER_MODEL)`);
  const notes = [];
  if (ffmpegPath && !ffmpeg) notes.push(afconvert ? 'The installed ffmpeg does not start, so macOS afconvert is used: WAV, AIFF, MP3, M4A and FLAC work; OGG and WebM need a working ffmpeg.' : 'The installed ffmpeg does not start.');
  else if (!ffmpeg && afconvert) notes.push('Using macOS afconvert: WAV, AIFF, MP3, M4A and FLAC work; OGG and WebM need ffmpeg.');
  return { ready: missing.length === 0, binary, ffmpeg, afconvert, converter, model, modelName: model ? path.basename(model) : null, missing, notes };
}

function run(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    child.stdout.on('data', () => {});
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(error('Transcription timed out.', 504)); }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(error(`${path.basename(file)} exited with code ${code}: ${stderr.trim().split('\n').slice(-3).join(' ')}`, 500)); });
  });
}

function clock(ms) {
  const t = Math.max(0, Math.round(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}

/** Turns whisper.cpp's -oj output into {text, segments[]}. */
function parseWhisperJson(json) {
  const items = Array.isArray(json.transcription) ? json.transcription : [];
  const segments = items.map(item => ({ fromMs: Number(item.offsets?.from) || 0, toMs: Number(item.offsets?.to) || 0, text: String(item.text || '').trim() })).filter(s => s.text);
  return { segments, text: segments.map(s => `[${clock(s.fromMs)}] ${s.text}`).join('\n') };
}

async function transcribeNow(store, dataDir, deps, record, options) {
  const tools = status(dataDir);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-whisper-'));
  try {
    const wav = path.join(work, 'input.wav');
    const input = media.filePath(dataDir, record);
    if (tools.converter === 'ffmpeg') await run(tools.ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], 20 * 60 * 1000);
    else await run(tools.afconvert, ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', input, wav], 20 * 60 * 1000);
    const args = ['-m', tools.model, '-f', wav, '-oj', '-of', path.join(work, 'out'), '-np'];
    if (options.language) args.push('-l', options.language);
    await run(tools.binary, args, TIMEOUT_MS);
    const result = parseWhisperJson(JSON.parse(fs.readFileSync(path.join(work, 'out.json'), 'utf8')));
    if (!result.segments.length) throw error('No speech was recognized in this audio.', 422);
    return { ...result, model: tools.modelName, language: options.language || 'auto' };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
  }
}

/** Starts a background transcription and returns the updated record. */
function start(store, dataDir, deps, id, options = {}) {
  const record = media.getMedia(store, id);
  if (record.kind !== 'audio') throw error('Only audio files can be transcribed.');
  if (running.has(record.id)) throw error('This file is already being transcribed.', 409);
  const tools = status(dataDir);
  if (!tools.ready) throw error('Transcription needs ' + tools.missing.join(', ') + '.', 412);
  if (tools.converter === 'afconvert' && !AFCONVERT_MIMES.has(record.mime)) throw error(`${record.originalName} is ${record.mime.replace('audio/', '').toUpperCase()}, which needs a working ffmpeg. Convert it to WAV, MP3 or M4A, or reinstall ffmpeg.`, 415);
  if (options.collectionId && !store.get('knowledgeCollections', options.collectionId)) throw error('Unknown knowledge collection.', 404);
  const language = options.language && /^[a-z]{2}$/.test(options.language) ? options.language : null;
  record.transcription = { status: 'running', startedAt: new Date().toISOString(), collectionId: options.collectionId || null, language, error: null };
  store.put('media', record);
  const job = (async () => {
    try {
      const result = await transcribeNow(store, dataDir, deps, record, { language });
      const latest = store.get('media', record.id) || record;
      latest.transcript = { text: result.text, segments: result.segments, model: result.model, language: result.language, createdAt: new Date().toISOString() };
      latest.transcription = { ...latest.transcription, status: 'done', finishedAt: new Date().toISOString() };
      if (options.collectionId && deps.ingestDocument) {
        const doc = await deps.ingestDocument(store, deps.ollama, { collectionId: options.collectionId, name: latest.originalName + ' (transcript)', text: result.text });
        latest.transcription.knowledgeDocumentId = doc && (doc.document?.id || doc.id || null);
      }
      store.put('media', latest);
    } catch (e) {
      const latest = store.get('media', record.id) || record;
      latest.transcription = { ...latest.transcription, status: 'failed', finishedAt: new Date().toISOString(), error: e.message || String(e) };
      store.put('media', latest);
    } finally { running.delete(record.id); }
  })();
  running.set(record.id, job);
  return { record: store.get('media', record.id), done: job };
}

function recoverInterrupted(store) {
  let count = 0;
  for (const record of store.all('media')) if (record.transcription?.status === 'running') { record.transcription = { ...record.transcription, status: 'failed', error: 'NOVA restarted during transcription.' }; store.put('media', record); count++; }
  return count;
}

module.exports = { status, start, parseWhisperJson, recoverInterrupted, clock };
