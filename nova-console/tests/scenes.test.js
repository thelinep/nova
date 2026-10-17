'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const scenes = require('../lib/scenes');
const characters = require('../lib/characters');
const puppet = require('../lib/puppet');

function store(){const s=new Map();return{all(n){return[...(s.get(n)?.values()||[])].map(r=>JSON.parse(JSON.stringify(r)));},get(n,id){const r=s.get(n)?.get(id);return r?JSON.parse(JSON.stringify(r)):null;},put(n,r){if(!s.has(n))s.set(n,new Map());s.get(n).set(r.id,JSON.parse(JSON.stringify(r)));return r;},delete(n,id){s.get(n)?.delete(id);}};}
const which = b => ['/opt/homebrew/bin/', '/usr/local/bin/', '/usr/bin/'].map(d => d + b).find(f => fs.existsSync(f));
function cast(db) {
  const mira = characters.create(db, { name: 'Mira', cutouts: [{ name: 'run', frames: ['m0', 'm1'] }, { name: 'tap', frames: ['m2'] }, { name: 'stop', frames: ['m3'] }] });
  const bot = characters.create(db, { name: 'Robo', puppet: puppet.LOOKS.inchi.puppet });
  return { mira, bot };
}

test('scenes are repaired: beats cover the scene, every actor has a state, poses must exist, lines and shots are clamped', () => {
  const db = store(), { mira, bot } = cast(db);
  assert.deepEqual(scenes.posesFor(mira), ['run', 'tap', 'stop']);
  assert.ok(scenes.posesFor(bot).includes('wave') && scenes.posesFor(bot).includes('idle'));
  const s = scenes.create(db, { name: 'Chase', duration: 10, actors: [{ characterId: mira.id }, { characterId: bot.id, scale: 9 }, { characterId: 'char_gone' }],
    beats: [{ start: 2, end: 5, actors: { a1: { x: 5000, to: 900, pose: 'run' } } }, { start: 4, end: 7, actors: { a1: { pose: 'fly' }, a2: { pose: 'wave', x: 300 } }, effect: 'explode' }, { start: 8, end: 12 }],
    dialogue: [{ start: 1, end: 1.1, actor: 'a2', text: 'नमस्ते' }, { start: 9, end: 40, speaker: 'Mira', text: 'रुको!' }, { start: 3, actor: 'a1', text: '' }],
    shots: [{ start: 0, end: 6, zoom: 9, x: 0 }, { start: 5, end: 10, zoom: 1 }] });
  assert.equal(s.actors.length, 3); assert.equal(s.actors[1].scale, 2.5); assert.equal(s.actors[2].characterId, null, 'a missing character becomes voice-only');
  assert.deepEqual(s.beats.map(b => [b.start, b.end]), [[0, 5], [5, 8], [8, 10]], 'no gaps, no overlaps, first at 0, last at the end');
  assert.equal(s.beats[0].actors.a1.x, 1840); assert.equal(s.beats[0].actors.a1.to, 900);
  assert.equal(s.beats[1].actors.a1.pose, 'run', 'unknown pose falls back to the previous one'); assert.equal(s.beats[1].actors.a1.x, 900, 'an actor without x starts where it ended');
  assert.equal(s.beats[1].effect, 'none'); assert.ok(s.beats[2].actors.a2 && s.beats[2].actors.a3, 'every actor has a state in every beat');
  assert.deepEqual(s.dialogue.map(l => [l.start, l.end, l.actor]), [[1, 1.3, 'a2'], [9, 10, 'a1']], 'short lines grow to 0.3 s, speakers map by name, empty lines go');
  assert.equal(s.shots[0].zoom, 3.5); assert.ok(s.shots[0].x >= 960 / 3.5, 'the zoomed view stays inside the stage'); assert.equal(s.shots[1].start, 6);
  const notes = []; scenes.normaliseScene({ ...s, beats: [{ start: 0, end: 10, actors: { a1: { pose: 'dance' } } }] }, s, { charsById: { [mira.id]: mira, [bot.id]: bot }, notes });
  assert.ok(notes.some(n => /cannot "dance"/.test(n)), 'repairs are reported');
  const u = scenes.update(db, s.id, { ...s, duration: 99, profile: { height: 1080, fps: 30, aspect: '9:16', quality: 'nope' } });
  assert.equal(u.duration, 30); assert.deepEqual(u.profile, { height: 1080, fps: 30, aspect: '9:16', captions: true, quality: 'standard' });
  assert.equal(scenes.list(db).length, 1); scenes.remove(db, s.id); assert.throws(() => scenes.get(db, s.id), /Unknown scene/);
});

test('director: a local model writes the scene; bad answers leave the scene alone', async () => {
  const db = store(), { mira, bot } = cast(db);
  db.put('models', { id: 'qwen3:8b', runtime: 'ollama', capabilities: ['completion', 'tools'] });
  db.put('models', { id: 'nomic-embed-text', runtime: 'ollama', capabilities: ['embedding'] });
  assert.deepEqual(scenes.chatModels(db), ['qwen3:8b']);
  const s = scenes.create(db, { name: 'Empty', actors: [{ characterId: mira.id }, { characterId: bot.id }] });
  let sent;
  const ollama = { chatFull: async (m, msgs, o) => { sent = { m, msgs, o }; return { message: { content: '```json\n' + JSON.stringify({ title: 'Bonk', duration: 6, beats: [{ start: 0, end: 1, effect: 'bonk', target: 'a2', actors: { a1: { x: 600, to: 600, pose: 'tap', facing: 1 }, a2: { x: 900, to: 900, pose: 'surprise', facing: -1 } } }, { start: 1, end: 6, effect: 'dust', actors: { a1: { x: 600, to: 1500, pose: 'run' }, a2: { x: 900, to: 1800, pose: 'walk' } } }], dialogue: [{ start: 0.5, end: 2.5, actor: 'a2', text: 'आई! आई!' }], shots: [{ start: 0, end: 6, zoom: 1.2, toZoom: 1 }] }) + '\n```' } }; } };
  const r = await scenes.direct({ store: db, ollama }, s.id, { prompt: 'Mira bonks Robo, then chases him' });
  assert.equal(sent.m, 'qwen3:8b'); assert.equal(sent.o.format, 'json');
  assert.match(sent.msgs[0].content, /"a1" = Mira: poses \["run","tap","stop"\]/); assert.match(sent.msgs[0].content, /"a2" = Robo: poses \[.*"wave"/);
  assert.equal(r.name, 'Bonk'); assert.equal(r.duration, 6); assert.equal(r.beats[0].effect, 'bonk'); assert.equal(r.beats[1].actors.a2.pose, 'walk');
  assert.equal(r.source.kind, 'director'); assert.equal(r.source.model, 'qwen3:8b'); assert.equal(scenes.get(db, s.id).name, 'Bonk', 'saved');
  const bad = { chatFull: async () => ({ message: { content: 'Sure! Here is a lovely scene about friendship.' } }) };
  await assert.rejects(scenes.direct({ store: db, ollama: bad }, s.id, { prompt: 'x' }), e => e.statusCode === 422 && /not changed/.test(e.message));
  assert.equal(scenes.get(db, s.id).name, 'Bonk', 'a bad answer changes nothing');
  await assert.rejects(scenes.direct({ store: db, ollama }, s.id, { prompt: '' }), /Write what should happen/);
  process.env.NOVA_DIRECTOR_TIMEOUT_MS = '50';
  const slow = { chatFull: (m, msgs, o) => new Promise((_, rej) => { const keep = setTimeout(() => {}, 5000); o.signal.addEventListener('abort', () => { clearTimeout(keep); rej(o.signal.reason); }); }) };
  await assert.rejects(scenes.direct({ store: db, ollama: slow }, s.id, { prompt: 'x' }), e => e.statusCode === 504 && /did not finish/.test(e.message));
  delete process.env.NOVA_DIRECTOR_TIMEOUT_MS;
  const db2 = store(); const s2 = scenes.create(db2, { actors: [{ label: 'X' }] });
  await assert.rejects(scenes.direct({ store: db2, ollama }, s2.id, { prompt: 'go' }), e => e.statusCode === 412);
});

test('scripts become scenes: speaker lines, notes, 30-second scenes, SRT timing, aliases and off-screen speakers', async () => {
  const db = store(), { mira } = cast(db);
  const txt = ['# The courtyard', 'INT. COURTYARD - DAY', 'Mira: अरे, रुक जा भाई!', 'इंची: आई! आई! लग गई, लग गई!', 'Scene 2: later', 'Narrator: And so they ran.', ...Array.from({ length: 14 }, (_, i) => `Mira: line ${i} with a few more words to say here`)].join('\n');
  const r = await scenes.importScript(db, Buffer.from(txt), { name: 'Chase.txt', aliases: { 'इंची': 'char_missing', 'मीरा': mira.id } });
  assert.equal(r.lines, 17); assert.equal(r.timed, false); assert.ok(r.scenes.length >= 2, 'long scripts split into scenes of up to 30 s');
  for (const sc of r.scenes) { assert.ok(sc.duration <= 30); assert.equal(sc.source.kind, 'script'); }
  const first = r.scenes[0];
  assert.equal(first.name, 'Chase · 1'); assert.match(first.notes, /INT\. COURTYARD/); assert.match(first.notes, /Scene 2: later/, '"Scene 2:" is a note, not a speaker');
  assert.equal(first.actors[0].characterId, mira.id); assert.equal(first.actors[1].label, 'इंची'); assert.equal(first.actors[1].characterId, null);
  assert.deepEqual(r.unmatched.sort(), ['Narrator', 'इंची'].sort());
  assert.equal(first.beats[0].actors.a1.pose, 'stop', 'drawn characters stand in a standing pose');
  const srt = '1\n00:00:01,000 --> 00:00:03,500\nMira: पहला\n\n2\n00:00:04,000 --> 00:00:05,000\nदूसरा\n\n3\n00:00:50,000 --> 00:00:52,000\nMira: बाद में\n';
  const s2 = await scenes.importScript(db, Buffer.from(srt), { name: 'subs.srt' });
  assert.equal(s2.timed, true); assert.equal(s2.scenes.length, 2, 'a long gap starts a new scene');
  assert.deepEqual(s2.scenes[0].dialogue.map(d => [d.start, d.end]), [[0.3, 2.8], [3.3, 4.3]], 'SRT times are kept relative to the scene');
  assert.equal(s2.scenes[0].dialogue[1].actor, s2.scenes[0].actors.find(a => a.label === 'Narrator').id, 'unlabelled cues are the narrator');
  await assert.rejects(scenes.importScript(db, Buffer.from('Just some prose without speakers.'), { name: 'x.txt' }), /No dialogue found/);
  await assert.rejects(scenes.importScript(db, Buffer.from('1\n00:00:05,000 --> 00:00:01,000\nMira: x\n'), { name: 'bad.srt' }), /end after they start/);
  await assert.rejects(scenes.importScript(db, Buffer.from('1\n00:00:00,000 --> 00:00:40,000\nMira: too long\n'), { name: 'long.srt' }), /longer than 29 seconds/);
  const zip = which('zip');
  if (zip && which('unzip')) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-')); fs.mkdirSync(path.join(dir, 'word'));
    fs.writeFileSync(path.join(dir, 'word', 'document.xml'), '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Mira: नमस्ते दोस्त</w:t></w:r></w:p><w:p><w:r><w:t>She waves.</w:t></w:r></w:p></w:body></w:document>');
    execFileSync(zip, ['-q', '-r', 'a.docx', 'word'], { cwd: dir });
    const dx = await scenes.importScript(db, fs.readFileSync(path.join(dir, 'a.docx')), { name: 'Play.docx' });
    assert.equal(dx.lines, 1); assert.equal(dx.scenes[0].dialogue[0].text, 'नमस्ते दोस्त'); assert.match(dx.scenes[0].notes, /She waves/);
  }
});

test('SRT export, the Mira & Inchi starter and the scene recorder', async () => {
  const db = store(), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenes-'));
  const r = scenes.addStarter(db, dataDir);
  assert.deepEqual(r.characters.map(c => c.name), ['Mira', 'Inchi']);
  assert.deepEqual(r.characters[0].cutouts.map(c => [c.name, c.frames.length]), [['run', 2], ['tap', 1], ['stop', 1]]);
  assert.equal(r.characters[1].voice.engine, 'kokoro'); assert.ok(r.characters[1].voice.mix.some(m => m.voice === 'hm_psi'));
  assert.equal(db.all('media').length, 8, 'the drawings are in the Library');
  const sc = r.scene; assert.equal(sc.duration, 16); assert.equal(sc.background.asset, 'courtyard'); assert.equal(sc.beats[1].effect, 'bonk'); assert.equal(sc.shots.length, 3);
  const again = scenes.addStarter(db, dataDir);
  assert.equal(characters.list(db).filter(c => c.name === 'Mira').length, 1, 'adding again reuses the characters'); assert.equal(again.characters[0].cutouts.length, 3);
  const srt = scenes.toSrt(sc, { speakers: true });
  assert.match(srt, /^1\n00:00:01,500 --> 00:00:04,500\nInchi: आई! आई! लग गई, लग गई!\n/); assert.equal(srt.split('-->').length - 1, sc.dialogue.length);
  assert.doesNotMatch(scenes.toSrt(sc), /Inchi:/);
  const ffmpeg = which('ffmpeg');
  if (ffmpeg) {
    const webm = path.join(dataDir, 'r.webm');
    execFileSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libvpx', '-c:a', 'libopus', '-shortest', webm]);
    const portrait = scenes.update(db, sc.id, { ...sc, profile: { height: 720, aspect: '9:16', fps: 24 } });
    const m = await scenes.saveRecording(db, dataDir, fs.readFileSync(webm), portrait);
    assert.equal(m.kind, 'video'); assert.equal(m.provenance.sceneId, sc.id);
    const dims = execFileSync(which('ffprobe') || ffmpeg.replace('ffmpeg', 'ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', require('../lib/media').filePath(dataDir, m)]).toString().trim();
    assert.equal(dims, '720,1280', '9:16 at 720p');
  }
  await assert.rejects(scenes.saveRecording(db, dataDir, Buffer.alloc(10), sc), /empty/);
});

test('scene engine: positions, poses, camera, captions, effects and output sizes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-js-'));
  fs.copyFileSync(path.join(__dirname, '..', 'public', 'cs-scene.js'), path.join(dir, 'e.mjs'));
  const E = await import(path.join(dir, 'e.mjs'));
  const db = store(), { mira, bot } = cast(db);
  const s = scenes.create(db, { duration: 4, actors: [{ characterId: mira.id }, { characterId: bot.id }],
    beats: [{ start: 0, end: 2, effect: 'bonk', target: 'a2', actors: { a1: { x: 400, to: 1200, pose: 'run', facing: 1 }, a2: { x: 1500, to: 1500, pose: 'idle', facing: -1 } } }, { start: 2, end: 4, effect: 'dust', actors: { a1: { x: 1200, to: 400, pose: 'run', facing: -1 }, a2: { x: 1500, to: 1500, pose: 'wave' } } }],
    dialogue: [{ start: 1, end: 3, actor: 'a2', text: 'नमस्ते' }], shots: [{ start: 0, end: 2, zoom: 1, toZoom: 2, x: 960, y: 540, toX: 1500, toY: 700, easing: 'linear', transition: 'fade', transitionDuration: 0.5 }, { start: 2, end: 4, zoom: 1 }] });
  const a1 = s.actors[0], a2 = s.actors[1];
  assert.equal(Math.round(E.actorState(s, a1, 1).x), 800, 'runners move at an even speed'); assert.ok(E.actorState(s, a1, 1).y < 1000, 'and bounce');
  assert.equal(E.actorState(s, a1, 3).facing, -1); assert.equal(E.actorState(s, a2, 1.5).talking, true); assert.equal(E.actorState(s, a2, 3.5).talking, false);
  assert.equal(E.actorState(s, a2, 3).pose, 'wave');
  const c0 = E.cameraAt(s, 0), c1 = E.cameraAt(s, 1.999);
  assert.equal(c0.fade, 1); assert.equal(E.cameraAt(s, 0.5).fade, 0); assert.ok(c1.zoom > 1.99);
  assert.ok(c1.x <= 1920 - 960 / c1.zoom + 0.01, 'the camera never shows outside the stage');
  assert.equal(E.captionsAt(s, 2).length, 1); assert.equal(E.captionsAt(s, 3.5).length, 0);
  assert.equal(E.effectsAt(s, 0.2)[0].kind, 'bonk'); assert.equal(E.effectsAt(s, 1).length, 0, 'a bonk lasts 0.6 s');
  assert.ok(E.effectsAt(s, 2.5).every(e => e.kind === 'dust') && E.effectsAt(s, 2.5).length === 3, 'dust behind the runner only');
  assert.deepEqual(E.outputSize({ height: 1080 }), { w: 1920, h: 1080 }); assert.deepEqual(E.outputSize({ height: 720, aspect: '9:16' }), { w: 720, h: 1280 });
  const f = E.frameState(s, 1); assert.equal(f.actors.length, 2); assert.equal(f.captions[0].text, 'नमस्ते');
});
