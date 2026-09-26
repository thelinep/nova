'use strict';
/* ===========================================================================
 * NOVA Runtime — filters for images, video and audio (ffmpeg, on this Mac)
 *
 * Applies a look (black & white, warm, cool, teal & orange, vintage, high
 * contrast, faded), film grain, a vignette, a crop to a frame shape, a
 * resize, speed changes, fades, trims and loudness normalising. The source
 * is never changed: the result is a new library item whose recipe names the
 * source and every setting, so it can be redone or undone.
 * ========================================================================= */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const media = require('./media');
const videoGen = require('./video-gen');

const LOOKS = {
  none: null,
  bw: 'hue=s=0',
  warm: 'colorbalance=rs=0.08:gs=0.02:bs=-0.08:rm=0.05:bm=-0.05',
  cool: 'colorbalance=rs=-0.06:bs=0.08:rm=-0.04:bm=0.06',
  'teal-orange': 'colorbalance=rs=-0.08:bs=0.08:rh=0.08:bh=-0.08',
  vintage: 'curves=preset=vintage',
  contrast: 'eq=contrast=1.25:saturation=1.1',
  faded: "curves=all='0/0.08 1/0.92',eq=saturation=0.85",
};
const ASPECTS = { none: null, '16:9': 16 / 9, '2.39:1': 2.39, '4:3': 4 / 3, '1:1': 1, '4:5': 0.8, '9:16': 9 / 16 };
const HEIGHTS = [0, 480, 720, 1080, 2160];

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
const num = (v, min, max, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };

function normalise(record, input = {}) {
  const kind = record.kind;
  const s = { kind, sourceMediaId: record.id, sourceName: record.originalName };
  if (kind === 'image' || kind === 'video') {
    s.look = LOOKS[input.look] !== undefined ? input.look : 'none';
    s.grain = Math.round(num(input.grain, 0, 40, 0));
    s.vignette = Boolean(input.vignette);
    s.aspect = ASPECTS[input.aspect] !== undefined ? input.aspect : 'none';
    s.height = HEIGHTS.includes(Number(input.height)) ? Number(input.height) : 0;
  }
  if (kind === 'video' || kind === 'audio') {
    s.speed = num(input.speed, 0.5, 2, 1);
    s.fadeIn = num(input.fadeIn, 0, 10, 0);
    s.fadeOut = num(input.fadeOut, 0, 10, 0);
    s.trimStart = num(input.trimStart, 0, 36000, 0);
    s.trimEnd = input.trimEnd === '' || input.trimEnd == null ? null : num(input.trimEnd, 0, 36000, null);
    if (s.trimEnd != null && s.trimEnd <= s.trimStart) throw error('The end time must be after the start time.');
  }
  if (kind === 'video') s.mute = Boolean(input.mute);
  if (kind === 'audio' || kind === 'video') s.normalize = Boolean(input.normalize);
  const changed = Object.entries(s).some(([k, v]) => !['kind', 'sourceMediaId', 'sourceName'].includes(k) && v && v !== 'none' && !(k === 'speed' && v === 1));
  if (!changed) throw error('Choose at least one filter.');
  return s;
}

/** Builds the ffmpeg arguments. `info` = { duration, hasAudio } of the source. */
function buildArgs(s, input, output, info = {}, encoder = ['-c:v', 'libx264', '-crf', '18']) {
  const args = ['-nostdin', '-y', '-loglevel', 'error'];
  if (s.trimStart) args.push('-ss', String(s.trimStart));
  if (s.trimEnd != null) args.push('-to', String(s.trimEnd));
  args.push('-i', input);
  const v = [], a = [];
  let duration = info.duration || 0;
  if (duration) duration = Math.max(0, Math.min(duration, s.trimEnd ?? duration) - (s.trimStart || 0));
  if (s.speed && s.speed !== 1) duration = duration / s.speed;
  if (s.kind !== 'audio') {
    if (s.aspect && s.aspect !== 'none') { const r = ASPECTS[s.aspect]; v.push(`crop=w='min(iw\\,ih*${r.toFixed(4)})':h='min(ih\\,iw/${r.toFixed(4)})'`); }
    if (s.height) v.push(`scale=-2:${s.height}`);
    if (LOOKS[s.look]) v.push(LOOKS[s.look]);
    if (s.vignette) v.push('vignette=PI/5');
    if (s.grain) v.push(`noise=alls=${s.grain}:allf=${s.kind === 'video' ? 't+u' : 'u'}`);
    if (s.kind === 'video') {
      if (s.speed !== 1) v.push(`setpts=PTS/${s.speed}`);
      if (s.fadeIn) v.push(`fade=t=in:st=0:d=${s.fadeIn}`);
      if (s.fadeOut && duration) v.push(`fade=t=out:st=${Math.max(0, duration - s.fadeOut).toFixed(3)}:d=${s.fadeOut}`);
      v.push('format=yuv420p');
    }
  }
  if (s.kind === 'audio' || (s.kind === 'video' && info.hasAudio && !s.mute)) {
    if (s.speed && s.speed !== 1) a.push(`atempo=${s.speed}`);
    if (s.fadeIn) a.push(`afade=t=in:st=0:d=${s.fadeIn}`);
    if (s.fadeOut && duration) a.push(`afade=t=out:st=${Math.max(0, duration - s.fadeOut).toFixed(3)}:d=${s.fadeOut}`);
    if (s.normalize) a.push('loudnorm=I=-16:TP=-1.5:LRA=11');
  }
  if (v.length) args.push('-vf', v.join(','));
  if (a.length) args.push('-af', a.join(','));
  if (s.kind === 'image') args.push('-frames:v', '1', '-update', '1');
  if (s.kind === 'video') { args.push(...encoder, '-pix_fmt', 'yuv420p', '-movflags', '+faststart'); if (s.mute || !info.hasAudio) args.push('-an'); else args.push('-c:a', 'aac', '-b:a', '192k'); }
  if (s.kind === 'audio') args.push('-vn', '-c:a', 'aac', '-b:a', '192k');
  args.push(output);
  return args;
}

function run(file, args, timeoutMs = 20 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err = (err + d).slice(-6000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(err) : reject(error(`ffmpeg failed: ${err.trim().split('\n').slice(-3).join(' ').slice(0, 300)}`, 500)); });
  });
}

/** Duration and whether there is a sound track, read from ffmpeg's own report. */
async function probe(ffmpeg, file) {
  const out = await new Promise(resolve => { const c = spawn(ffmpeg, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] }); let e = ''; c.stderr.on('data', d => { e += d; }); c.on('close', () => resolve(e)); c.on('error', () => resolve('')); });
  const m = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return { duration: m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0, hasAudio: /Stream #.*Audio:/.test(out) };
}

function describe(s) {
  const parts = [];
  if (s.look && s.look !== 'none') parts.push(s.look);
  if (s.aspect && s.aspect !== 'none') parts.push(s.aspect);
  if (s.height) parts.push(s.height + 'p');
  if (s.grain) parts.push('grain');
  if (s.vignette) parts.push('vignette');
  if (s.speed && s.speed !== 1) parts.push(s.speed + 'x');
  if (s.trimStart || s.trimEnd != null) parts.push('trim');
  if (s.fadeIn || s.fadeOut) parts.push('fade');
  if (s.normalize) parts.push('normalised');
  if (s.mute) parts.push('muted');
  return parts.join(', ');
}

function start(store, dataDir, id, input = {}) {
  const ffmpeg = videoGen.motionStatus(dataDir).ffmpeg;
  if (!ffmpeg) throw error('Filters need a working ffmpeg (brew install ffmpeg).', 412);
  const record = media.getMedia(store, id);
  const settings = normalise(record, input);
  const label = describe(settings);
  const job = { id: 'gen_' + crypto.randomBytes(8).toString('hex'), type: 'media-filter', status: 'running', settings: { ...settings, prompt: `${record.originalName} · ${label}` }, promptId: null, mediaIds: [], error: null, cancelRequested: false, createdAt: new Date().toISOString(), finishedAt: null };
  store.put('generationJobs', job);
  const done = (async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-filter-'));
    try {
      const src = media.filePath(dataDir, record);
      const ext = record.kind === 'image' ? '.png' : record.kind === 'video' ? '.mp4' : '.m4a';
      const out = path.join(work, 'out' + ext);
      const info = record.kind === 'image' ? {} : await probe(ffmpeg, src);
      await run(ffmpeg, buildArgs(settings, src, out, info, videoGen.encoderArgs ? videoGen.encoderArgs(ffmpeg) : undefined));
      const base = record.originalName.replace(/\.[a-z0-9]+$/i, '');
      const saved = media.saveMedia(store, dataDir, { buffer: fs.readFileSync(out), originalName: `${base} (${label})${ext}`, source: 'nova-filter', expectKind: record.kind, provenance: { generator: 'ffmpeg-filter', ...settings, jobId: job.id } });
      job.mediaIds = [saved.id]; job.status = 'done';
    } catch (e) { job.status = 'failed'; job.error = e.message || String(e); }
    finally { job.finishedAt = new Date().toISOString(); store.put('generationJobs', job); try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {} }
  })();
  return { job, done };
}

module.exports = { start, normalise, buildArgs, probe, describe, LOOKS, ASPECTS, HEIGHTS };
