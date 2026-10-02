'use strict';
/* Delivery: cues in the text, moods, the voice director (stubbed) and the
 * fallback signs; ffmpeg filters; a character speaking in several moods. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const delivery = require('../lib/delivery');
const characters = require('../lib/characters');

const HAS_FFMPEG = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch (_) { return false; } })();

test('moods: names, synonyms and the list everyone shares', () => {
  for (const m of ['shouting', 'whispering', 'singing', 'taunting', 'angry', 'sad', 'joyful', 'warm', 'calm', 'laughing', 'fearful', 'excited', 'neutral']) assert.ok(delivery.MOODS[m], m);
  assert.equal(delivery.moodName('Shout'), 'shouting');
  assert.equal(delivery.moodName('sings'), 'singing');
  assert.equal(delivery.moodName('mocking'), 'taunting');
  assert.equal(delivery.moodName('motherly'), 'warm');
  assert.equal(delivery.moodName('banana'), null);
  assert.equal(characters.MOODS, delivery.MOODS);
});

test('cues: [shout] … (sings) … [pause] split a line; unknown brackets stay as words', () => {
  const s = delivery.parseCues('Hello there. [shout] Get out! [pause] (whispers) Come back. [note] ok');
  assert.deepEqual(s, [
    { mood: null, text: 'Hello there.' },
    { mood: 'shouting', text: 'Get out!' },
    { mood: 'pause', text: '' },
    { mood: 'whispering', text: 'Come back. [note] ok' },
  ]);
  assert.equal(delivery.parseCues('No cues here (really).'), null);
});

test('plan: cues first, then a chosen mood, then the director, then the signs', async () => {
  const meera = { name: 'Meera', personality: 'Gentle and motherly.', delivery: { mood: 'neutral', auto: true } };
  assert.equal(delivery.baseMood(meera), 'warm', 'the personality sets the usual delivery');

  const cued = await delivery.plan(meera, 'Good morning. [taunt] Late again?');
  assert.deepEqual(cued.map(s => s.mood), ['warm', 'taunting']);

  const forced = await delivery.plan(meera, 'One. Two!', { mood: 'sing' });
  assert.deepEqual(forced, [{ mood: 'singing', text: 'One. Two!' }]);

  let asked = null;
  const director = async (msg) => { asked = msg; return 'Sure: {"parts":[{"delivery":"warm","text":"Come here, child."},{"delivery":"shouting","text":"STOP that right now!"}]}'; };
  const directed = await delivery.plan(meera, 'Come here, child. STOP that right now!', { director });
  assert.deepEqual(directed.map(s => s.mood), ['warm', 'shouting']);
  assert.match(asked.system, /Gentle and motherly/);
  assert.match(asked.system, /usual delivery is "warm"/);

  // A director that changes the words is ignored.
  const liar = async () => '{"parts":[{"delivery":"angry","text":"Something else entirely."}]}';
  const fallback = await delivery.plan(meera, 'Come here, child. STOP THAT RIGHT NOW!', { director: liar });
  assert.deepEqual(fallback.map(s => s.mood), ['warm', 'shouting']);

  // Auto off: no director, only the signs.
  let called = false;
  const off = await delivery.plan({ ...meera, delivery: { mood: 'calm', auto: false } }, 'Breathe in. Breathe out.', { director: async () => { called = true; return '{}'; } });
  assert.equal(called, false);
  assert.deepEqual(off, [{ mood: 'calm', text: 'Breathe in. Breathe out.' }]);
});

test('plan: a broken director falls back without failing', async () => {
  const s = await delivery.plan({ name: 'X' }, 'Wow!! That is great.', { director: async () => { throw new Error('model offline'); } });
  assert.deepEqual(s.map(p => p.mood), ['excited', 'neutral']);
});

test('filters: pitch, effect and loudness at 44.1 kHz', () => {
  assert.equal(delivery.filters('neutral', 0), 'aresample=44100');
  const shout = delivery.filters('shouting', 0);
  assert.match(shout, /asetrate=44100\*1\.1225/);
  assert.match(shout, /acompressor/);
  assert.match(shout, /volume=7dB$/);
  assert.match(delivery.filters('singing', 0), /vibrato=f=5\.5/);
  assert.match(delivery.filters('whispering', 0), /highpass=f=400/);
  assert.equal(delivery.filters('calm', 1), 'aresample=44100,lowpass=f=9000,volume=-2dB', 'character pitch +1 and calm -1 cancel out');
});

test('speak: each mood is its own take, joined into one line', { skip: !HAS_FFMPEG }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-deliv-'));
  fs.writeFileSync(path.join(dir, 'kokoro-v1.0.onnx'), 'x'); fs.writeFileSync(path.join(dir, 'voices-v1.0.bin'), 'x');
  execFileSync('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=0.5', '-ar', '24000', path.join(dir, 'tone.wav')]);
  const helper = path.join(dir, 'batch.js');
  fs.writeFileSync(helper, `const fs=require('fs');const jobs=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));fs.writeFileSync(${JSON.stringify(path.join(dir, 'jobs.json'))},JSON.stringify(jobs));for(const j of jobs)fs.copyFileSync(${JSON.stringify(path.join(dir, 'tone.wav'))},j.out);`);
  const py = path.join(dir, 'python');
  fs.writeFileSync(py, `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "--batch" ]; then "${process.execPath}" "${helper}" "$2"; fi; shift; done\necho '{"ok":true}'\n`, { mode: 0o755 });
  const prev = { p: process.env.NOVA_KOKORO_PYTHON, d: process.env.KOKORO_DIR };
  process.env.NOVA_KOKORO_PYTHON = py; process.env.KOKORO_DIR = dir;
  try {
    const c = characters.normalise({ name: 'Ravi', personality: 'Playful.', voice: { engine: 'kokoro', mix: [{ voice: 'am_adam', weight: 1 }], speed: 1 } });
    assert.deepEqual(c.delivery, { mood: 'neutral', auto: true });
    const out = await characters.speak(c, 'Hello. [shout] Over here! [pause] [sing] La la la.');
    assert.deepEqual(out.delivery, ['neutral', 'shouting', 'pause', 'singing']);
    const jobs = JSON.parse(fs.readFileSync(path.join(dir, 'jobs.json'), 'utf8'));
    assert.deepEqual(jobs.map(j => j.text), ['Hello.', 'Over here!', 'La la la.']);
    assert.equal(jobs[2].speed, 0.84, 'singing is slower');
    // Three half-second takes, their pauses and 0.7 s of silence: well over 2 seconds.
    const seconds = (out.data.length - 44) / (44100 * 2);
    assert.ok(seconds > 2.2, 'joined length ' + seconds);
    assert.equal(out.data.readUInt32LE(24), 44100);
  } finally {
    if (prev.p === undefined) delete process.env.NOVA_KOKORO_PYTHON; else process.env.NOVA_KOKORO_PYTHON = prev.p;
    if (prev.d === undefined) delete process.env.KOKORO_DIR; else process.env.KOKORO_DIR = prev.d;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
