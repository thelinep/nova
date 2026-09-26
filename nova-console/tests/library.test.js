'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const library = require('../lib/library');
const media = require('../lib/media');

function store(){const s=new Map();return{all(n){return[...(s.get(n)?.values()||[])].map(r=>JSON.parse(JSON.stringify(r)));},get(n,id){const r=s.get(n)?.get(id);return r?JSON.parse(JSON.stringify(r)):null;},put(n,r){if(!s.has(n))s.set(n,new Map());s.get(n).set(r.id,JSON.parse(JSON.stringify(r)));return r;},delete(n,id){s.get(n)?.delete(id);}};}
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const walk = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter(f => fs.statSync(path.join(dir, f)).isFile()).sort() : [];

test('nothing is mirrored until the server configures the library', () => {
  library.reset();
  const db = store(), dir = tmp('nova-lib-data-');
  const r = media.saveMedia(db, dir, { buffer: PNG, originalName: 'x.png', source: 'comfyui', provenance: { prompt: 'rain' } });
  assert.equal(r.libraryPath, undefined);
  assert.equal(library.info().enabled, false);
});

test('generated media, transcripts and every skill output land in the day folder with a recipe', () => {
  const libDir = tmp('nova-lib-'), dir = tmp('nova-lib-data-'), db = store();
  const saved = process.env.NOVA_LIBRARY_DIR;
  process.env.NOVA_LIBRARY_DIR = libDir;
  try {
    assert.equal(library.configure(db).dir, fs.realpathSync(libDir) === libDir ? libDir : path.resolve(libDir));
    const gen = media.saveMedia(db, dir, { buffer: PNG, originalName: 'x.png', source: 'comfyui', provenance: { prompt: 'Rain-soaked Mumbai street: dusk / neon', seed: 42 } });
    const up = media.saveMedia(db, dir, { buffer: PNG, originalName: 'mine.png', source: 'upload' });
    assert.ok(gen.libraryPath && fs.existsSync(gen.libraryPath), 'generated image is in the library');
    assert.equal(db.get('media', gen.id).libraryPath, gen.libraryPath, 'the record remembers where');
    assert.equal(up.libraryPath, undefined, 'your own uploads are not copied');
    assert.match(path.basename(gen.libraryPath), /^\d{4} Rain-soaked Mumbai street dusk neon \(comfyui\)\.png$/);
    const recipe = JSON.parse(fs.readFileSync(gen.libraryPath.replace(/\.png$/, '.json'), 'utf8'));
    assert.deepEqual([recipe.mediaId, recipe.provenance.seed], [gen.id, 42]);
    assert.ok(fs.readFileSync(gen.libraryPath).equals(PNG));
    assert.match(path.basename(path.dirname(gen.libraryPath)), /^\d{4}-\d{2}-\d{2}$/);

    const audio = db.get('media', up.id);
    audio.originalName = 'take4.wav'; audio.transcript = { text: '[00:00:00] Rolling.', model: 'ggml-base.en.bin', language: 'en', createdAt: new Date().toISOString(), segments: [] };
    db.put('media', audio);
    const t = library.mirrorTranscript(db, audio);
    assert.match(fs.readFileSync(t, 'utf8'), /# Transcript: take4\.wav[\s\S]*Rolling\./);

    const skill = { id: 'skl_shotlist', name: 'Shot List', version: '1.0.0' };
    const a = library.recordSkillOutput(db, skill, { text: 'Scene 1...' }, { kind: 'shotlist', markdown: '# Shot list: Monsoon\n', data: { title: 'Monsoon' }, model: 'llama3:latest' }, { finishedAt: '2026-09-26T10:00:00.000Z' });
    const b = library.recordSkillOutput(db, skill, {}, { kind: 'shotlist', markdown: '# Shot list: Monsoon v2\n', data: { title: 'Monsoon' } }, { finishedAt: '2026-09-26T11:00:00.000Z' });
    assert.equal(a.title, 'Shot List - Monsoon');
    assert.deepEqual(library.listSkillOutputs(db, 'skl_shotlist').map(o => o.id), [b.id, a.id], 'every run kept, newest first');
    assert.equal(fs.readFileSync(a.libraryPath, 'utf8'), '# Shot list: Monsoon\n');
    assert.notEqual(a.libraryPath, b.libraryPath);
    assert.equal(library.recordSkillOutput(db, skill, {}, { matches: [] }), null, 'non-text results are not kept');
  } finally { if (saved === undefined) delete process.env.NOVA_LIBRARY_DIR; else process.env.NOVA_LIBRARY_DIR = saved; library.reset(); }
});

test('library folder setting and copying earlier items', () => {
  const db = store(), dir = tmp('nova-lib-data-');
  delete process.env.NOVA_LIBRARY_DIR;
  // Items made while the library was off.
  library.reset();
  const early = media.saveMedia(db, dir, { buffer: PNG, originalName: 'early.png', source: 'ltx', provenance: { prompt: 'waves' } });
  db.put('skills', { id: 'skl_treatment', name: 'Treatment Writer', lastOutput: { at: '2026-09-25T09:00:00.000Z', markdown: '# Monsoon\n' } });
  assert.throws(() => library.setDir(db, { dir: 'relative/path' }), /full folder path/);
  assert.throws(() => library.setDir(db, { dir: os.homedir() }), /folder of its own/);
  const libDir = path.join(tmp('nova-lib-parent-'), 'NOVA Library');
  assert.equal(library.setDir(db, { dir: libDir }).dir, libDir);
  assert.equal(db.get('preferences', 'library').dir, libDir);
  assert.equal(library.configure(db).source, 'setting', 'the saved folder is used after a restart');
  const result = library.backfill(db, dir);
  assert.deepEqual([result.media, result.skillOutputs], [1, 1]);
  assert.ok(fs.existsSync(db.get('media', early.id).libraryPath));
  assert.equal(walk(libDir).filter(f => f.endsWith('.md')).length, 1);
  assert.deepEqual(library.backfill(db, dir).media, 0, 'running it again copies nothing twice');
  library.reset();
});
