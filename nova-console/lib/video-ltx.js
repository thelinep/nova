'use strict';
/* ===========================================================================
 * NOVA Runtime — local AI motion with LTX-2 on Apple Silicon (MLX)
 *
 * Runs the ltx-2-mlx command-line tool (github.com/dgrauet/ltx-2-mlx) on
 * this Mac to turn a still and a motion prompt into a short MP4 with sound.
 * It replaces Wan 2.2 as NOVA's default local AI motion because its 4-bit
 * weights run on a 16 GB Mac (with --low-ram streaming) and it makes sound.
 * These are rough previews: small frames, a few seconds, fast settings.
 *
 * Nothing here uses the network except the tool's own one-time weight
 * download from Hugging Face. Set LTX_MLX_BIN to the ltx-2-mlx executable
 * and LTX_MLX_MODEL to another weights pack if you installed elsewhere.
 * ========================================================================= */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const media = require('./media');
const heavy = require('./heavy-jobs');

const DEFAULT_MODEL = 'dgrauet/ltx-2.3-mlx-q4';
const SIZES = { '704x480': [704, 480], '480x704': [480, 704], '512x512': [512, 512], '960x544': [960, 544] };
const MODES = ['distilled', 'two-stage'];
const FPS = 24;
const TIMEOUT_MS = 60 * 60 * 1000;

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
const home = () => process.env.HOME || os.homedir();

function binary() {
  const candidates = [process.env.LTX_MLX_BIN, path.join(home(), 'ltx-2-mlx', '.venv', 'bin', 'ltx-2-mlx')].filter(Boolean);
  return candidates.find(c => { try { fs.accessSync(c, fs.constants.X_OK); return true; } catch (_) { return false; } }) || null;
}
function model() { return process.env.LTX_MLX_MODEL || DEFAULT_MODEL; }
function weightsCached(name) {
  const dir = path.join(process.env.HF_HOME || path.join(home(), '.cache', 'huggingface'), 'hub', 'models--' + name.replace(/\//g, '--'));
  return fs.existsSync(path.join(dir, 'snapshots'));
}

function status() {
  const bin = binary(), m = model();
  const appleSilicon = (process.platform === 'darwin' && process.arch === 'arm64') || process.env.LTX_MLX_ANY_PLATFORM === '1'; // the override is for tests
  const missing = [];
  if (!appleSilicon) missing.push('an Apple Silicon Mac (LTX-2 runs on MLX)');
  if (!bin) missing.push('ltx-2-mlx: double-click "Install LTX-2 video for NOVA.command" in the brahmini folder (about 30 GB with weights)');
  const cached = weightsCached(m);
  const notes = [];
  if (bin && !cached) notes.push(`The ${m} weights (roughly 20 GB with the text encoder) are not downloaded yet; the first clip downloads them.`);
  notes.push('Rough previews with sound: a few seconds at small sizes. Expect several minutes per clip on a 16 GB Mac.');
  if (heavy.totalGb() <= 24) notes.push(`On this ${heavy.totalGb()} GB Mac NOVA keeps LTX-2 to 480p, 5 seconds and low-RAM mode, frees other models first, and runs one video job at a time.`);
  return { limits: heavy.ltxLimits(), engine: 'ltx-2-mlx', ready: missing.length === 0, binary: bin, model: m, weightsCached: cached, missing, notes, sizes: Object.keys(SIZES), modes: MODES };
}

/** LTX wants 8k+1 frames. */
function framesFor(seconds) { return Math.max(1, Math.round((seconds * FPS) / 8)) * 8 + 1; }

function normalise(store, input) {
  // With no image this is text to video: LTX-2 makes the whole shot from the prompt.
  const record = input.mediaId ? media.getMedia(store, input.mediaId) : null;
  if (record && record.kind !== 'image') throw error('Choose an image to animate.');
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw error('Describe the motion and sound you want, e.g. "slow push-in, waves crash, gulls call".');
  if (prompt.length > 2000) throw error('The prompt is limited to 2,000 characters.');
  const limits = heavy.ltxLimits();
  const size = SIZES[input.size] && (!limits.sizes || limits.sizes.includes(input.size)) ? input.size : '704x480';
  const secondsIn = Number(input.seconds);
  const seconds = Number.isFinite(secondsIn) ? Math.min(limits.maxSeconds, Math.max(1, secondsIn)) : 4;
  const frames = framesFor(seconds);
  const mode = MODES.includes(input.mode) ? input.mode : 'distilled';
  const seed = Number.isSafeInteger(Number(input.seed)) && Number(input.seed) >= 0 && input.seed !== '' && input.seed != null ? Number(input.seed) : crypto.randomInt(0, 2 ** 31 - 1);
  return { engine: 'ltx-2-mlx', input: record ? 'image-to-video' : 'text-to-video', mediaId: record ? record.id : null, sourceName: record ? record.originalName : null, prompt, size, width: SIZES[size][0], height: SIZES[size][1], frames, fps: FPS, seconds: Math.round(((frames - 1) / FPS) * 10) / 10, mode, seed, model: model(), lowRam: limits.lowRam || input.lowRam !== false, audio: true };
}

function args(s, imagePath, output) {
  const a = ['generate', '--prompt', s.prompt, ...(imagePath ? ['--image', imagePath] : []), '-H', String(s.height), '-W', String(s.width), '-f', String(s.frames), '--frame-rate', String(s.fps), '--seed', String(s.seed), '--model', s.model, '-o', output];
  a.push(s.mode === 'two-stage' ? '--two-stage' : '--distilled');
  if (s.lowRam) a.push('--low-ram');
  return a;
}

function start(store, dataDir, input) {
  const info = status();
  if (!info.ready) throw error('LTX-2 needs: ' + info.missing.join('; ') + '.', 412);
  const settings = normalise(store, input);
  const source = settings.mediaId ? media.getMedia(store, settings.mediaId) : null;
  const job = { id: 'gen_' + crypto.randomBytes(8).toString('hex'), type: 'video-ltx', status: 'running', settings, promptId: null, mediaIds: [], error: null, progress: null, cancelRequested: false, createdAt: new Date().toISOString(), finishedAt: null };
  store.put('generationJobs', job);
  const done = (async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ltx-'));
    try {
      const out = path.join(work, 'clip.mp4');
      await new Promise((resolve, reject) => {
        const child = spawn(info.binary, args(settings, source ? media.filePath(dataDir, source) : null, out), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
        let tail = '', lastSave = 0;
        const onData = d => {
          tail = (tail + d).slice(-4000);
          const line = tail.split(/[\r\n]/).map(x => x.trim()).filter(Boolean).pop();
          if (line && Date.now() - lastSave > 3000) { lastSave = Date.now(); job.progress = line.slice(0, 200); store.put('generationJobs', job); }
        };
        child.stdout.on('data', onData); child.stderr.on('data', onData);
        const watch = setInterval(() => { if (store.get('generationJobs', job.id)?.cancelRequested) { job.cancelRequested = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000); } }, 1000);
        const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
        child.on('error', e => { clearInterval(watch); clearTimeout(timer); reject(e); });
        child.on('close', code => {
          clearInterval(watch); clearTimeout(timer);
          if (job.cancelRequested) return reject(error('Cancelled.', 499));
          if (code !== 0) return reject(error(`ltx-2-mlx failed (${code}): ${tail.trim().split('\n').slice(-3).join(' ').slice(0, 400)}`, 500));
          resolve();
        });
      });
      if (!fs.existsSync(out)) throw error('ltx-2-mlx finished without writing a video.', 500);
      const record = media.saveMedia(store, dataDir, { buffer: fs.readFileSync(out), originalName: settings.prompt.slice(0, 60) + '.mp4', source: 'ltx', expectKind: 'video', provenance: { generator: 'ltx-2-mlx', ...settings, jobId: job.id } });
      job.mediaIds = [record.id]; job.status = 'done'; job.progress = null;
    } catch (e) { job.status = e.statusCode === 499 ? 'cancelled' : 'failed'; job.error = e.message || String(e); }
    finally { job.finishedAt = new Date().toISOString(); store.put('generationJobs', job); try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {} }
  })();
  return { job, done };
}

module.exports = { status, start, normalise, args, framesFor, SIZES, MODES, DEFAULT_MODEL };
