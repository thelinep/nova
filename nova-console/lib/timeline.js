'use strict';
/* ===========================================================================
 * NOVA Runtime — Timeline: cut a scene from library clips and sound
 *
 * One picture track (clips and stills, played in order) and three sound
 * tracks (voice, music, effects) whose items start at a time you choose.
 * Clips can keep their own sound at a chosen level. Export renders one MP4
 * with ffmpeg on this Mac: every shot is fitted to the frame (letterboxed,
 * never stretched), sound items are trimmed, delayed to their start, levelled
 * and mixed. Timelines are saved in NOVA's database; the export is a new
 * library item whose recipe lists every shot and sound.
 * ========================================================================= */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const media = require('./media');
const actions = require('./media-actions');
const transcriber = require('./transcribe');

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
const SIZES = { '1280x720': [1280, 720], '1920x1080': [1920, 1080], '2048x858': [2048, 858], '1080x1080': [1080, 1080], '720x1280': [720, 1280], '1080x1920': [1080, 1920], '704x480': [704, 480] };
const AUDIO_TRACKS = ['voice', 'music', 'sfx'];
const num = (v, min, max, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
const itemId = () => 'ti_' + crypto.randomBytes(5).toString('hex');

/** Validates a timeline from the client; unknown media are dropped. */
function normalise(store, input = {}, existing = null) {
  const now = new Date().toISOString();
  const tl = { id: existing ? existing.id : 'tl_' + crypto.randomBytes(8).toString('hex'), type: 'timeline', name: String(input.name || existing?.name || 'Untitled scene').trim().slice(0, 120) || 'Untitled scene',
    size: SIZES[input.size] ? input.size : existing?.size || '1280x720', fps: [24, 25, 30].includes(Number(input.fps)) ? Number(input.fps) : existing?.fps || 24,
    tracks: { video: [], voice: [], music: [], sfx: [] }, createdAt: existing?.createdAt || now, updatedAt: now };
  const tracks = input.tracks || existing?.tracks || {};
  const kindOf = id => { const m = store.get('media', String(id || '')); return m ? m.kind : null; };
  for (const it of (tracks.video || []).slice(0, 300)) {
    const kind = kindOf(it.mediaId);
    if (kind !== 'image' && kind !== 'video') continue;
    const x = { id: /^ti_[a-f0-9]{10}$/.test(it.id) ? it.id : itemId(), mediaId: it.mediaId, kind };
    if (kind === 'image') x.seconds = num(it.seconds, 0.5, 60, 3);
    else { x.in = num(it.in, 0, 36000, 0); x.out = it.out == null || it.out === '' ? null : num(it.out, 0, 36000, null); if (x.out != null && x.out <= x.in + 0.1) x.out = null; x.clipVolume = num(it.clipVolume, 0, 2, 1); }
    tl.tracks.video.push(x);
  }
  for (const t of AUDIO_TRACKS) for (const it of (tracks[t] || []).slice(0, 200)) {
    const kind = kindOf(it.mediaId);
    if (kind !== 'audio' && kind !== 'video') continue;
    const x = { id: /^ti_[a-f0-9]{10}$/.test(it.id) ? it.id : itemId(), mediaId: it.mediaId, kind, start: num(it.start, 0, 36000, 0), in: num(it.in, 0, 36000, 0), out: it.out == null || it.out === '' ? null : num(it.out, 0, 36000, null), volume: num(it.volume, 0, 2, t === 'music' ? 0.6 : 1), fadeIn: num(it.fadeIn, 0, 10, 0), fadeOut: num(it.fadeOut, 0, 10, 0) };
    if (x.out != null && x.out <= x.in + 0.1) x.out = null;
    tl.tracks[t].push(x);
  }
  return tl;
}

/**
 * Builds ffmpeg arguments. `sources` maps mediaId -> { file, duration, hasAudio }.
 * Returns { args, duration, shots }.
 */
function buildArgs(tl, sources, output, encoder = ['-c:v', 'libx264', '-crf', '18', '-preset', 'medium']) {
  if (!tl.tracks.video.length) throw error('Add at least one clip or still to the picture track.');
  const [W, H] = SIZES[tl.size], F = tl.fps;
  const args = ['-nostdin', '-y', '-loglevel', 'error'], filters = [], audio = [];
  let input = 0, cursor = 0;
  const shots = [];
  for (const it of tl.tracks.video) {
    const src = sources[it.mediaId];
    if (!src) throw error('A clip on the timeline is missing from the library.', 410);
    let dur;
    if (it.kind === 'image') { dur = it.seconds; args.push('-loop', '1', '-t', dur.toFixed(3), '-i', src.file); }
    else {
      const end = it.out != null ? Math.min(it.out, src.duration || it.out) : src.duration;
      dur = Math.max(0.1, (end || 0) - it.in);
      if (!end) throw error('Could not read the length of a clip on the timeline.', 422);
      args.push('-ss', it.in.toFixed(3), '-t', dur.toFixed(3), '-i', src.file);
    }
    filters.push(`[${input}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${F},format=yuv420p,trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS[v${shots.length}]`);
    if (it.kind === 'video' && src.hasAudio && it.clipVolume > 0) {
      const ms = Math.round(cursor * 1000);
      filters.push(`[${input}:a]aresample=48000,atrim=duration=${dur.toFixed(3)},asetpts=PTS-STARTPTS,volume=${it.clipVolume},adelay=${ms}|${ms}[c${audio.length}]`);
      audio.push(`[c${audio.length}]`);
    }
    shots.push({ mediaId: it.mediaId, at: Math.round(cursor * 100) / 100, seconds: Math.round(dur * 100) / 100 });
    cursor += dur; input++;
  }
  const total = cursor;
  filters.push(`${shots.map((_, i) => `[v${i}]`).join('')}concat=n=${shots.length}:v=1:a=0[vout]`);
  for (const t of AUDIO_TRACKS) for (const it of tl.tracks[t]) {
    const src = sources[it.mediaId];
    if (!src || !src.hasAudio || it.start >= total) continue;
    const end = it.out != null ? Math.min(it.out, src.duration || it.out) : src.duration;
    const len = Math.max(0.1, Math.min((end || 0) - it.in, total - it.start));
    if (!(len > 0.1)) continue;
    args.push('-ss', it.in.toFixed(3), '-t', len.toFixed(3), '-i', src.file);
    const ms = Math.round(it.start * 1000), chain = [`aresample=48000`, `asetpts=PTS-STARTPTS`, `volume=${it.volume}`];
    if (it.fadeIn) chain.push(`afade=t=in:st=0:d=${Math.min(it.fadeIn, len)}`);
    if (it.fadeOut) chain.push(`afade=t=out:st=${Math.max(0, len - it.fadeOut).toFixed(3)}:d=${Math.min(it.fadeOut, len)}`);
    chain.push(`adelay=${ms}|${ms}`);
    filters.push(`[${input}:a]${chain.join(',')}[c${audio.length}]`);
    audio.push(`[c${audio.length}]`); input++;
  }
  if (audio.length) filters.push(`${audio.join('')}amix=inputs=${audio.length}:duration=longest:normalize=0,atrim=duration=${total.toFixed(3)},alimiter=limit=0.95[aout]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]');
  if (audio.length) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
  else args.push('-an');
  args.push(...encoder, '-pix_fmt', 'yuv420p', '-r', String(F), '-t', total.toFixed(3), '-movflags', '+faststart', output);
  return { args, duration: Math.round(total * 100) / 100, shots };
}

/** Length (seconds) and sound of a library item, cached on the record. */
async function mediaInfo(store, dataDir, ffmpeg, record) {
  if (record.kind === 'image') return { file: media.filePath(dataDir, record), duration: 0, hasAudio: false };
  if (record.durationSec == null || record.hasAudio == null) {
    const p = await actions.probe(ffmpeg, media.filePath(dataDir, record));
    const latest = store.get('media', record.id) || record; latest.durationSec = Math.round(p.duration * 100) / 100; latest.hasAudio = p.hasAudio; store.put('media', latest);
    Object.assign(record, { durationSec: latest.durationSec, hasAudio: latest.hasAudio });
  }
  return { file: media.filePath(dataDir, record), duration: record.durationSec, hasAudio: record.hasAudio };
}

function exportTimeline(store, dataDir, id) {
  const ffmpeg = transcriber.status(dataDir).ffmpeg;
  if (!ffmpeg) throw error('Export needs a working ffmpeg (brew install ffmpeg).', 412);
  const tl = store.get('timelines', id);
  if (!tl) throw error('Unknown timeline.', 404);
  if (!tl.tracks.video.length) throw error('Add at least one clip or still to the picture track.');
  const job = { id: 'gen_' + crypto.randomBytes(8).toString('hex'), type: 'timeline-export', status: 'running', settings: { engine: 'timeline', timelineId: tl.id, name: tl.name, prompt: `${tl.name} · export` }, promptId: null, mediaIds: [], error: null, progress: 'Reading clips…', cancelRequested: false, createdAt: new Date().toISOString(), finishedAt: null };
  store.put('generationJobs', job);
  const done = (async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-timeline-'));
    try {
      const sources = {};
      for (const it of [...tl.tracks.video, ...AUDIO_TRACKS.flatMap(t => tl.tracks[t])]) {
        if (sources[it.mediaId]) continue;
        const rec = store.get('media', it.mediaId);
        if (rec) sources[it.mediaId] = await mediaInfo(store, dataDir, ffmpeg, rec);
      }
      const out = path.join(work, 'scene.mp4');
      const plan = buildArgs(tl, sources, out, require('./video-gen').encoderArgs(ffmpeg));
      job.progress = `Rendering ${plan.duration}s…`; store.put('generationJobs', job);
      await new Promise((resolve, reject) => {
        const c = require('node:child_process').spawn(ffmpeg, plan.args, { stdio: ['ignore', 'ignore', 'pipe'] }); let err = '';
        c.stderr.on('data', d => { err = (err + d).slice(-6000); });
        const watch = setInterval(() => { if (store.get('generationJobs', job.id)?.cancelRequested) c.kill('SIGKILL'); }, 1000);
        c.on('error', e => { clearInterval(watch); reject(e); });
        c.on('close', code => { clearInterval(watch); if (store.get('generationJobs', job.id)?.cancelRequested) return reject(error('Cancelled.', 499)); code === 0 ? resolve() : reject(error('ffmpeg failed: ' + err.trim().split('\n').slice(-3).join(' ').slice(0, 400), 500)); });
      });
      const name = (id) => (store.get('media', id) || {}).originalName || id;
      const recipe = { generator: 'nova-timeline', engine: 'timeline', timelineId: tl.id, name: tl.name, size: tl.size, fps: tl.fps, seconds: plan.duration,
        shots: plan.shots.map(s => ({ ...s, name: name(s.mediaId) })), sound: AUDIO_TRACKS.flatMap(t => tl.tracks[t].map(it => ({ track: t, name: name(it.mediaId), start: it.start, volume: it.volume }))), jobId: job.id };
      const saved = media.saveMedia(store, dataDir, { buffer: fs.readFileSync(out), originalName: `${tl.name}.mp4`, source: 'nova-timeline', expectKind: 'video', provenance: recipe });
      job.mediaIds = [saved.id]; job.status = 'done'; job.progress = null;
    } catch (e) { job.status = e.statusCode === 499 ? 'cancelled' : 'failed'; job.error = e.message || String(e); }
    finally { job.finishedAt = new Date().toISOString(); store.put('generationJobs', job); fs.rmSync(work, { recursive: true, force: true }); }
  })();
  return { job, done };
}

module.exports = { normalise, buildArgs, exportTimeline, mediaInfo, SIZES, AUDIO_TRACKS };
