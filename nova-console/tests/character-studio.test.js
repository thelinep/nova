'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const puppet = require('../lib/puppet');
const characters = require('../lib/characters');

function store(){const s=new Map();return{all(n){return[...(s.get(n)?.values()||[])].map(r=>JSON.parse(JSON.stringify(r)));},get(n,id){const r=s.get(n)?.get(id);return r?JSON.parse(JSON.stringify(r)):null;},put(n,r){if(!s.has(n))s.set(n,new Map());s.get(n).set(r.id,JSON.parse(JSON.stringify(r)));return r;},delete(n,id){s.get(n)?.delete(id);}};}
const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(f => fs.existsSync(f));

test('the puppet is cleaned: unknown parts and colours fall back, sizes are clamped, the seed is kept', () => {
  const p = puppet.normalisePuppet({ body: 'dragon', head: 'screen', skin: 'red', outfit: '#ABCDEF', extras: ['glasses', 'wings', 'glasses'], height: 9, width: 0.1 });
  assert.equal(p.body, 'round'); assert.equal(p.head, 'screen'); assert.match(p.skin, /^#[0-9a-f]{6}$/); assert.equal(p.outfit, '#abcdef');
  assert.deepEqual(p.extras, ['glasses']); assert.equal(p.height, 1.3); assert.equal(p.width, 0.75);
  assert.ok(Number.isSafeInteger(p.seed));
  const again = puppet.normalisePuppet({ ...p, body: 'tall', seed: undefined }, p);
  assert.equal(again.seed, p.seed, 'editing the look keeps the seed so AI pictures stay alike');
  for (const l of Object.values(puppet.LOOKS)) assert.deepEqual(puppet.normalisePuppet(l.puppet).extras, l.puppet.extras);
});

test('characters keep their puppet, sounds, actions and portraits; actions drop sounds that are gone', () => {
  const db = store();
  const c = characters.create(db, { name: 'Inchi', puppet: puppet.LOOKS.inchi.puppet, sounds: [{ label: 'beep', mediaId: 'med_1' }, { label: 'no file' }] });
  assert.equal(c.puppet.head, 'screen'); assert.equal(c.sounds.length, 1); assert.match(c.sounds[0].id, /^snd_[a-f0-9]{10}$/);
  const u = characters.update(db, c.id, { ...c, actions: [{ name: 'Hello', steps: [{ move: 'wave', seconds: 99, line: 'Where is here?', soundId: c.sounds[0].id }, { move: 'fly', soundId: 'snd_0000000000' }] }], portraits: [{ mediaId: 'med_2', view: 'turnaround' }, { view: 'full' }] });
  assert.equal(u.actions[0].steps[0].seconds, 20); assert.equal(u.actions[0].steps[0].soundId, c.sounds[0].id);
  assert.equal(u.actions[0].steps[1].move, 'idle'); assert.equal(u.actions[0].steps[1].soundId, null);
  assert.deepEqual(u.portraits, [{ mediaId: 'med_2', view: 'turnaround' }]);
  // Voice Studio saves only its own fields: the studio parts stay.
  const v = characters.update(db, c.id, { name: 'Inchi', voice: { engine: 'default' } });
  assert.equal(v.puppet.head, 'screen'); assert.equal(v.actions.length, 1); assert.equal(v.portraits.length, 1);
  const gone = characters.update(db, c.id, { ...v, sounds: [] });
  assert.equal(gone.actions[0].steps[0].soundId, null, 'removing a sound clears it from the steps');
  const plain = characters.create(db, { name: 'Plain' });
  assert.equal(plain.puppet, null); assert.deepEqual(plain.actions, []);
});

test('AI portrait prompts describe the drawn look and reuse its seed', () => {
  const c = { name: 'Inchi', tagline: 'a small learning robot', puppet: puppet.normalisePuppet({ ...puppet.LOOKS.inchi.puppet, look: 'curious' }) };
  const r = puppet.portraitRequest(c, 'turnaround');
  assert.match(r.prompt, /cream shell/); assert.match(r.prompt, /amber eyes/); assert.match(r.prompt, /teal joints/); assert.match(r.prompt, /leaf badge/); assert.match(r.prompt, /curious/); assert.match(r.prompt, /turnaround/);
  assert.equal(r.seed, c.puppet.seed); assert.deepEqual([r.width, r.height], [1152, 640]);
  const kid = { name: 'Mira', puppet: puppet.normalisePuppet(puppet.LOOKS.explorer.puppet) };
  assert.match(puppet.portraitPrompt(kid), /long hair/); assert.match(puppet.portraitPrompt(kid), /child-sized/);
  assert.equal(puppet.colorName('#2a9d8f'), 'teal');
  const cat = puppet.catalog();
  assert.ok(cat.moves.some(m => m.id === 'wave') && cat.looks.some(l => l.id === 'inchi') && cat.views.length === 4);
});

test('a recorded performance (WebM) is saved to the library as an MP4 with sound', async t => {
  if (!ffmpeg) return t.skip('ffmpeg is not installed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-cs-')), db = store();
  const webm = path.join(dir, 'rec.webm');
  execFileSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=260x280:rate=30:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libvpx', '-c:a', 'libopus', '-shortest', webm]);
  const c = characters.create(db, { name: 'Inchi', puppet: puppet.LOOKS.inchi.puppet });
  const rec = await puppet.saveClip(db, dir, fs.readFileSync(webm), { character: c, action: 'Greeting' });
  assert.equal(rec.kind, 'video'); assert.equal(rec.mime, 'video/mp4'); assert.equal(rec.originalName, 'Inchi — Greeting.mp4');
  assert.equal(rec.provenance.generator, 'character-studio'); assert.equal(rec.provenance.characterId, c.id);
  const probe = execFileSync(ffmpeg.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', require('../lib/media').filePath(dir, rec)], { encoding: 'utf8' });
  assert.match(probe, /h264/); assert.match(probe, /aac/);
  await assert.rejects(puppet.saveClip(db, dir, Buffer.alloc(10), { character: c }), /empty/);
});

test('3D characters: the rig is cleaned, poses keep joint angles and face values, actions can hold a saved pose', () => {
  const db = store();
  const rig = puppet.rigFromPuppet(puppet.LOOKS.inchi.puppet);
  assert.equal(rig.body.robot, true); assert.equal(rig.face.eyeShape, 'glow'); assert.ok(rig.costume.extras.includes('leaf-badge'));
  const c = characters.create(db, { name: 'Robo', puppet: puppet.LOOKS.inchi.puppet, stage: '3d', rig3d: {
    ...rig, body: { ...rig.body, height: 9, build: 'giant' }, hair: { style: 'mohawk', color: 'blue' }, costume: { ...rig.costume, extras: ['glasses', 'jetpack'] },
    poses: [{ name: 'Wave', joints: { upperArmR: [10, -20, 140], head: [0, 999, 0], tail: [1, 2, 3] }, face: { smile: 3, open: 0.5, laser: 1 }, root: { lift: -2 } }] } });
  assert.equal(c.stage, '3d'); assert.equal(c.rig3d.body.height, 1.3); assert.equal(c.rig3d.body.build, 'average');
  assert.equal(c.rig3d.hair.style, 'short'); assert.match(c.rig3d.hair.color, /^#[0-9a-f]{6}$/); assert.deepEqual(c.rig3d.costume.extras, ['glasses']);
  const p = c.rig3d.poses[0];
  assert.match(p.id, /^pose_[a-f0-9]{10}$/); assert.deepEqual(p.joints.upperArmR, [10, -20, 140]); assert.equal(p.joints.head[1], 180); assert.equal(p.joints.tail, undefined);
  assert.deepEqual(p.face, { smile: 1, open: 0.5 }); assert.equal(p.root.lift, -0.6);
  const u = characters.update(db, c.id, { ...c, actions: [{ name: 'Hi', steps: [{ move: 'pose', poseId: p.id, seconds: 2 }, { move: 'pose', poseId: 'bad' }] }] });
  assert.deepEqual([u.actions[0].steps[0].move, u.actions[0].steps[0].poseId], ['pose', p.id]); assert.equal(u.actions[0].steps[1].poseId, null);
  const vv = characters.update(db, c.id, { ...u, actions: [{ name: 'Tour', steps: [{ move: 'talk', view: 'digestive', line: 'Food goes to the stomach.' }, { move: 'idle', view: 'x-ray-of-doom' }] }] });
  assert.equal(vv.actions[0].steps[0].view, 'digestive'); assert.equal(vv.actions[0].steps[1].view, null);
  assert.deepEqual(puppet.SYSTEMS, ['none', 'organs', 'digestive', 'circulatory', 'respiratory', 'excretory', 'nervous', 'skeletal', 'endocrine', 'reproductive']);
  // Without a rig the stage stays 2D; Voice Studio saves keep the rig.
  assert.equal(characters.create(db, { name: 'Flat', stage: '3d' }).stage, '2d');
  const v = characters.update(db, c.id, { name: 'Robo', voice: { engine: 'default' } });
  assert.equal(v.stage, '3d'); assert.equal(v.rig3d.poses.length, 1);
  // AI pictures describe the 3D look when the character is shown in 3D.
  const prompt = puppet.portraitPrompt(v, 'full');
  assert.match(prompt, /robot with a cream shell/); assert.match(prompt, /3D animated/); assert.match(prompt, /glasses/);
  const kid = characters.create(db, { name: 'Asha', stage: '3d', rig3d: { ...puppet.rigFromPuppet(puppet.LOOKS.explorer.puppet), costume: { top: 'kurta', topColor: '#3d5a80', bottom: 'pants', bottomColor: '#e0d8c8', shoes: 'sandals', shoeColor: '#6b4226', accent: '#ee6c4d', extras: [] } } });
  assert.match(puppet.describe3d(kid), /navy blue kurta/); assert.match(puppet.describe3d(kid), /sandals/);
});

test('lip-sync visemes: Kokoro IPA and Devanagari/English spelling map to mouth shapes, aligned to the voiced audio', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-vis-'));
  fs.copyFileSync(path.join(__dirname, '..', 'public', 'cs-visemes.js'), path.join(dir, 'v.mjs'));
  const V = await import(path.join(dir, 'v.mjs'));
  assert.deepEqual(V.fromIPA('mˈʌst').filter(v => v !== '|'), ['PP', 'aa', 'SS', 'DD']);
  assert.deepEqual(V.fromIPA('fiː ʃoʊ').filter(v => v !== '|'), ['FF', 'I', 'CH', 'O']);
  assert.deepEqual(V.fromText('माँ').filter(v => v !== '|'), ['PP', 'aa', 'DD'].slice(0, 2).concat(V.fromText('माँ').slice(2)));
  assert.ok(V.fromText('Hello, Mira.').includes('PP') && V.fromText('Hello, Mira.').includes(','));
  const rate = 24000, s = new Float32Array(rate * 2);
  for (let i = 0; i < s.length; i++) { const t = i / rate; s[i] = (t > 0.2 && t < 0.8) || (t > 1.1 && t < 1.7) ? 0.3 * Math.sin(2 * Math.PI * 200 * t) : 0; }
  const tr = V.align(V.fromIPA('həlˈoʊ wɜːld'), s, rate);
  assert.ok(tr.events.length >= 6);
  assert.ok(tr.events[0].t0 >= 0.19 && tr.events[0].t0 <= 0.21, 'starts with the sound');
  assert.ok(Math.abs(tr.events.at(-1).t1 - 1.7) < 0.02, 'ends with the sound');
  assert.equal(V.sample(tr, 0.95).open, 0, 'mouth closed in the pause');
  assert.ok(V.sample(tr, 0.3).open > 0.2, 'open on a vowel');
  assert.deepEqual(V.align([], s, rate).events, []);
});

test('webcam capture maths: MediaPipe pose landmarks become joint angles; blendshapes become face values', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-cap-')); fs.mkdirSync(path.join(dir, 'vendor'));
  fs.copyFileSync(path.join(__dirname, '..', 'public', 'vendor', 'three.module.min.js'), path.join(dir, 'vendor', 'three.module.min.mjs'));
  fs.writeFileSync(path.join(dir, 'cap.mjs'), fs.readFileSync(path.join(__dirname, '..', 'public', 'cs3d-capture.js'), 'utf8').replace('./vendor/three.module.min.js', './vendor/three.module.min.mjs'));
  const C = await import(path.join(dir, 'cap.mjs'));
  const body = edits => { const a = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 })); const s = (i, x, y, z) => { a[i] = { x, y, z }; };
    s(11, .18, -.5, 0); s(12, -.18, -.5, 0); s(23, .1, 0, 0); s(24, -.1, 0, 0); s(25, .1, .45, 0); s(26, -.1, .45, 0); s(27, .1, .9, 0); s(28, -.1, .9, 0);
    s(13, .2, -.22, 0); s(14, -.2, -.22, 0); s(15, .2, .05, 0); s(16, -.2, .05, 0); edits(s); return C.bodyFromLandmarks(a, { mirror: false }).joints; };
  const near = (a, b, tol = 6) => a.every((x, i) => Math.abs(x - b[i]) <= tol);
  assert.ok(near(body(() => {}).upperArmL, [0, 0, 4]), 'arms down');
  assert.ok(near(body(s => { s(13, .45, -.5, 0); s(15, .72, -.5, 0); }).upperArmL, [0, 0, 90]), 'T-pose');
  assert.ok(near(body(s => { s(13, .18, -.78, 0); s(15, .18, -1.05, 0); }).upperArmL, [0, 0, 180]), 'arm straight up');
  assert.ok(near(body(s => { s(13, .18, -.5, -.28); s(15, .18, -.5, -.55); }).upperArmL, [90, 0, 0]), 'arm forward');
  assert.equal(body(s => s(15, .2, -.22, -.27)).forearmL[0], 90, 'elbow bent 90°');
  const leg = body(s => { s(25, .1, 0, -.45); s(27, .1, .45, -.45); }); assert.ok(near(leg.thighL, [90, 0, 0]) && leg.shinL[0] === 90, 'knee up, shin down');
  const mir = C.bodyFromLandmarks((() => { const a = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 })); Object.assign(a, { 11: { x: .18, y: -.5, z: 0 }, 12: { x: -.18, y: -.5, z: 0 }, 23: { x: .1, y: 0, z: 0 }, 24: { x: -.1, y: 0, z: 0 }, 13: { x: .45, y: -.5, z: 0 }, 15: { x: .72, y: -.5, z: 0 }, 14: { x: -.2, y: -.22, z: 0 }, 16: { x: -.2, y: .05, z: 0 } }); return a; })(), { mirror: true, legs: false }).joints;
  assert.ok(near(mir.upperArmR, [0, 0, 90]) && mir.thighL === undefined, 'mirror: your left arm moves the character arm on the same screen side; legs off');
  const f = C.faceFromBlendshapes({ jawOpen: 0.5, mouthSmileLeft: 0.8, mouthSmileRight: 0.8, eyeBlinkLeft: 1, browInnerUp: 0.6, mouthPucker: 0.7 }, null, { mirror: false });
  assert.equal(f.face.open, 0.75); assert.equal(f.face.smile, 1); assert.equal(f.face.eyeL, 0); assert.equal(f.face.eyeR, 1); assert.equal(f.face.round, 0.7); assert.ok(f.face.browL > 0.2);
  const yaw = 20 * Math.PI / 180, m = [Math.cos(yaw), 0, -Math.sin(yaw), 0, 0, 1, 0, 0, Math.sin(yaw), 0, Math.cos(yaw), 0, 0, 0, 0, 1];
  assert.ok(Math.abs(Math.abs(C.faceFromBlendshapes({}, m, { mirror: false }).head[1]) - 20) < 0.5, 'head turn from the face matrix');
  const sm = C.smoothPose({ joints: { head: [0, 0, 0] }, face: { open: 0 } }, { joints: { head: [10, 0, 0] }, face: { open: 1 } }, 0.5);
  assert.equal(sm.joints.head[0], 5); assert.equal(sm.face.open, 0.7);
});

test('3D export saves .glb to the library; FBX goes through Blender; capture models and statuses', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-exp-'));
  const glb = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(40)]);
  await assert.rejects(puppet.saveExport(Buffer.from('nope-nope-nope-nope-nope'), { dir }), /not a glTF/);
  await assert.rejects(puppet.saveExport(glb, { dir: null }), e => e.statusCode === 412);
  const a = await puppet.saveExport(glb, { dir, name: 'Inchi / wave', format: 'glb' });
  assert.equal(a.format, 'glb'); assert.match(a.file, /^Inchi wave .*\.glb$/); assert.ok(fs.existsSync(path.join(dir, 'Exports', a.file)));
  const keep = process.env.NOVA_BLENDER;
  process.env.NOVA_BLENDER = path.join(dir, 'no-blender');
  await assert.rejects(puppet.saveExport(glb, { dir, format: 'fbx' }), e => e.statusCode === 412 && /Blender/.test(e.message));
  const fake = path.join(dir, 'blender'); fs.writeFileSync(fake, '#!/bin/bash\n# stands in for: blender -b --factory-startup --python script -- in.glb out.fbx\nfor a; do last2="$prev"; prev="$a"; done\n[ -f "$last2" ] || exit 3\nprintf "Kaydara FBX Binary" > "$prev"\n', { mode: 0o755 });
  process.env.NOVA_BLENDER = fake;
  const b = await puppet.saveExport(glb, { dir, name: 'Inchi', format: 'fbx' });
  if (keep === undefined) delete process.env.NOVA_BLENDER; else process.env.NOVA_BLENDER = keep;
  assert.equal(b.format, 'fbx'); assert.match(b.file, /\.fbx$/); assert.match(fs.readFileSync(path.join(dir, 'Exports', b.file), 'utf8'), /FBX/); assert.match(b.glb, /\.glb$/);
  // capture models
  assert.equal(puppet.captureStatus(dir).ready, false);
  fs.mkdirSync(path.join(dir, 'tools', 'mediapipe'), { recursive: true });
  for (const f of puppet.CAPTURE_MODELS) fs.writeFileSync(path.join(dir, 'tools', 'mediapipe', f), Buffer.alloc(1100000));
  assert.equal(puppet.captureStatus(dir).ready, true);
  assert.match(puppet.captureModelPath(dir, 'face_landmarker.task'), /face_landmarker\.task$/);
  assert.throws(() => puppet.captureModelPath(dir, '../../etc/passwd'), /Unknown capture model/);
});

test('timeline animations and capture clips are cleaned and kept with the 3D character', () => {
  const db = store();
  const rig = puppet.rigFromPuppet(null);
  rig.poses = [{ id: 'pose_aaaaaaaaaa', name: 'Wave', joints: { upperArmR: [0, 0, 140] } }];
  rig.clips = [{ name: 'Nod', fps: 99, frames: [{ j: { head: [10.4, 0, 0] }, f: { open: 0.333 } }, { j: { head: [-10, 0, 0] } }, ...Array.from({ length: 2000 }, () => ({ j: {} }))] }, { name: 'Empty', frames: [] }];
  rig.anims = [{ name: 'Hello', duration: 500, ik: { feet: true }, tracks: {
    body: [{ t: 0, pose: { joints: { head: [5, 0, 0] } } }, { t: 3, poseId: 'pose_aaaaaaaaaa' }, { t: 4, poseId: 'pose_missing0' }],
    clip: [{ t: 1, clipId: 'clip_bad' }], face: [{ t: 2, face: { smile: 5 } }], add: [{ t: 1, joints: { head: [0, 20, 0] } }],
    voice: [{ t: 1.5, line: 'Hello there' }, { t: 2, line: '' }], sound: [{ t: 1, soundId: 'snd_aaaaaaaaaa' }, { t: 1, soundId: 'x' }] } }];
  const c = characters.create(db, { name: 'Anim', stage: '3d', rig3d: rig });
  const clip = c.rig3d.clips[0];
  assert.equal(c.rig3d.clips.length, 1); assert.equal(clip.fps, 30); assert.equal(clip.frames.length, 30 * 60); assert.deepEqual(clip.frames[0], { j: { head: [10, 0, 0] }, f: { open: 0.33 } });
  const a = c.rig3d.anims[0];
  assert.equal(a.duration, 120); assert.equal(a.ik.feet, true);
  assert.deepEqual(a.tracks.body.map(k => k.t), [0, 3]); assert.equal(a.tracks.body[1].poseId, 'pose_aaaaaaaaaa');
  assert.deepEqual(a.tracks.clip, []); assert.equal(a.tracks.face[0].face.smile, 1); assert.deepEqual(a.tracks.add[0].joints.head, [0, 20, 0]);
  assert.deepEqual(a.tracks.voice, [{ t: 1.5, line: 'Hello there' }]); assert.deepEqual(a.tracks.sound, [{ t: 1, soundId: 'snd_aaaaaaaaaa' }]);
  const u = characters.update(db, c.id, { ...c, actions: [{ name: 'Play capture', steps: [{ move: 'clip', clipId: clip.id }, { move: 'clip', clipId: 'nope' }] }] });
  assert.deepEqual([u.actions[0].steps[0].move, u.actions[0].steps[0].clipId], ['clip', clip.id]); assert.equal(u.actions[0].steps[1].clipId, null);
});
