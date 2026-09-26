'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const media = require('../lib/media');
const filters = require('../lib/media-filters');
const transcriber = require('../lib/transcribe');
const song = require('../lib/song-writer');

function store(){const s=new Map();return{all(n){return[...(s.get(n)?.values()||[])].map(r=>JSON.parse(JSON.stringify(r)));},get(n,id){const r=s.get(n)?.get(id);return r?JSON.parse(JSON.stringify(r)):null;},put(n,r){if(!s.has(n))s.set(n,new Map());s.get(n).set(r.id,JSON.parse(JSON.stringify(r)));return r;},delete(n,id){s.get(n)?.delete(id);}};}
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('filter settings are validated per kind and described for the new item name', () => {
  const img = { id: 'm1', kind: 'image', originalName: 'gate.png' };
  assert.throws(() => filters.normalise(img, {}), /at least one filter/);
  const s = filters.normalise(img, { look: 'teal-orange', aspect: '2.39:1', grain: 99, speed: 2 });
  assert.deepEqual([s.look, s.aspect, s.grain, s.speed], ['teal-orange', '2.39:1', 40, undefined]);
  assert.equal(filters.describe(s), 'teal-orange, 2.39:1, grain');
  const a = filters.buildArgs(s, '/in.png', '/out.png');
  assert.match(a[a.indexOf('-vf') + 1], /^crop=w='min\(iw\\,ih\*2\.3900\)'.*colorbalance.*noise=alls=40:allf=u$/);
  const v = filters.normalise({ id: 'm2', kind: 'video', originalName: 'c.mp4' }, { speed: 2, fadeOut: 1, trimStart: 1, trimEnd: 5, look: 'bw' });
  const va = filters.buildArgs(v, '/in.mp4', '/out.mp4', { duration: 10, hasAudio: true });
  assert.deepEqual(va.slice(4, 8), ['-ss', '1', '-to', '5']);
  assert.match(va[va.indexOf('-vf') + 1], /setpts=PTS\/2,fade=t=in|setpts=PTS\/2,fade=t=out:st=1\.000:d=1/);
  assert.match(va[va.indexOf('-af') + 1], /atempo=2,afade=t=out:st=1\.000:d=1/);
  assert.throws(() => filters.normalise({ id: 'x', kind: 'audio', originalName: 'a' }, { trimStart: 5, trimEnd: 2 }), /end time/);
});

test('filters make new image, video and audio items with real ffmpeg, leaving the source untouched', async t => {
  const dir = tmp('nova-flt-');
  const ffmpeg = transcriber.status(dir).ffmpeg;
  if (!ffmpeg) return t.skip('ffmpeg is not installed');
  const make = (name, args) => { const f = path.join(dir, name); execFileSync(ffmpeg, ['-loglevel', 'error', ...args, f]); return fs.readFileSync(f); };
  const db = store();
  const img = media.saveMedia(db, dir, { buffer: make('s.png', ['-f', 'lavfi', '-i', 'testsrc=size=640x360', '-frames:v', '1']), originalName: 'still.png' });
  const vid = media.saveMedia(db, dir, { buffer: make('v.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac']), originalName: 'clip.mp4' });
  const aud = media.saveMedia(db, dir, { buffer: make('a.wav', ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=3']), originalName: 'tone.wav' });
  const before = fs.readFileSync(media.filePath(dir, img));
  const runs = [
    filters.start(db, dir, img.id, { look: 'bw', aspect: '1:1', grain: 10, vignette: true }),
    filters.start(db, dir, vid.id, { look: 'warm', speed: 2, fadeIn: 0.5, fadeOut: 0.5 }),
    filters.start(db, dir, aud.id, { normalize: true, fadeIn: 1, trimEnd: 2 }),
  ];
  for (const r of runs) await r.done;
  const out = runs.map(r => { const j = db.get('generationJobs', r.job.id); assert.equal(j.status, 'done', j.error); return db.get('media', j.mediaIds[0]); });
  assert.deepEqual(out.map(o => o.kind), ['image', 'video', 'audio']);
  assert.deepEqual(out.map(o => o.source), ['nova-filter', 'nova-filter', 'nova-filter']);
  assert.equal(out[0].originalName, 'still (bw, 1:1, grain, vignette).png');
  const dims = require('node:child_process').spawnSync(ffmpeg, ['-hide_banner', '-i', media.filePath(dir, out[0])], { encoding: 'utf8' }).stderr;
  assert.match(dims, /, 360x360[, ]/, 'cropped to 1:1');
  const probe = await filters.probe(ffmpeg, media.filePath(dir, out[1]));
  assert.ok(probe.duration > 1.2 && probe.duration < 1.8, `2x speed should halve 3 s, got ${probe.duration}`);
  assert.equal(probe.hasAudio, true);
  const ap = await filters.probe(ffmpeg, media.filePath(dir, out[2]));
  assert.ok(ap.duration > 1.8 && ap.duration < 2.3, `trim to 2 s, got ${ap.duration}`);
  assert.ok(fs.readFileSync(media.filePath(dir, img)).equals(before), 'source unchanged');
  assert.equal(out[1].provenance.sourceMediaId, vid.id);
});

test('text to song: writes titled, tagged, sectioned lyrics from an idea and repairs once', async () => {
  const db = store(); db.put('models', { id: 'llama3:latest', runtime: 'ollama' });
  const calls = [];
  const replies = [
    JSON.stringify({ title: 'Baarish', style: '', lyrics: 'no sections here' }),
    JSON.stringify({ title: 'Baarish', style: 'bollywood romantic ballad, female vocals, tabla, strings, 90 bpm', lyrics: '[Verse 1]\nBaarish ki boondein\n\n\n[CHORUS]\nTum ho yahan' }),
  ];
  const ollama = { chatFull: async (model, messages, opts) => { calls.push({ model, messages, opts }); return { message: { content: replies.shift() } }; } };
  await assert.rejects(() => song.writeLyrics(db, ollama, { idea: '' }), /Describe the song/);
  const r = await song.writeLyrics(db, ollama, { idea: 'Two strangers share an umbrella on Marine Drive in the first rain', language: 'hindi-roman', length: 'medium' });
  assert.equal(r.repaired, true);
  assert.equal(r.lyrics, '[verse]\nBaarish ki boondein\n\n[chorus]\nTum ho yahan');
  assert.equal(r.seconds, 120);
  assert.match(calls[0].messages[0].content, /Hindi written in Roman letters.*two verses/);
  assert.equal(calls[0].opts.format, 'json');
  assert.match(calls[1].messages[1].content, /rejected: style is missing; lyrics need at least one \[verse\]/);
});
