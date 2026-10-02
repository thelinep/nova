'use strict';
/* ===========================================================================
 * NOVA Runtime — the visible library folder, and skill-output history
 *
 * NOVA's own copies live in data/ (SQLite plus data/media). This module
 * also writes everything NOVA *makes* as ordinary files in a folder you can
 * open in Finder — by default ~/Documents/NOVA Library — one folder per day:
 *
 *   2026-09-26/
 *     1432 marine-drive-dusk (ltx).mp4
 *     1432 marine-drive-dusk (ltx).json      <- the recipe: prompt, model, seed…
 *     1510 shot list - monsoon.md
 *     1510 shot list - monsoon.json
 *
 * Generated images and videos, transcripts and skill outputs are mirrored;
 * your own uploads are not (you already have them). Writing to the library
 * never fails a job: a problem is logged and recorded on the item instead.
 * Every skill run is also kept in the `skillOutputs` store, not just the last.
 *
 * The folder comes from NOVA_LIBRARY_DIR, then the saved setting, then the
 * default. Nothing is mirrored until the server calls configure().
 * ========================================================================= */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_DIR = path.join(os.homedir(), 'Documents', 'Maataa Library');
let config = null; // { dir, enabled }

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

function configure(store) {
  const prefs = (store && store.get('preferences', 'library')) || {};
  const dir = process.env.NOVA_LIBRARY_DIR || prefs.dir || DEFAULT_DIR;
  config = { dir: path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir())), enabled: prefs.enabled !== false, source: process.env.NOVA_LIBRARY_DIR ? 'env' : prefs.dir ? 'setting' : 'default' };
  return config;
}
function reset() { config = null; }
function info() { return config ? { ...config, defaultDir: DEFAULT_DIR } : { dir: null, enabled: false, source: 'off', defaultDir: DEFAULT_DIR }; }

function setDir(store, input = {}) {
  if (process.env.NOVA_LIBRARY_DIR) throw error('The library folder is set by NOVA_LIBRARY_DIR; change it there.', 409);
  const raw = String(input.dir || '').trim().replace(/^~(?=$|\/)/, os.homedir());
  if (!raw || !path.isAbsolute(raw)) throw error('Give a full folder path, for example ~/Documents/NOVA Library.');
  const dir = path.resolve(raw);
  if (['/', os.homedir()].includes(dir)) throw error('Choose a folder of its own, not your whole home folder.');
  fs.mkdirSync(dir, { recursive: true });
  fs.accessSync(dir, fs.constants.W_OK);
  store.put('preferences', { id: 'library', dir, enabled: input.enabled !== false, updatedAt: new Date().toISOString() });
  return configure(store);
}

function slug(text, max = 60) {
  return String(text || 'untitled').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim() || 'untitled';
}
function stamp(iso) { const d = iso ? new Date(iso) : new Date(); const p = n => String(n).padStart(2, '0'); return { day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}${p(d.getMinutes())}` }; }

/** Writes one item (file + recipe .json) into the day folder. Returns the file path. */
function write({ title, tag, ext, data, recipe, createdAt }) {
  if (!config || !config.enabled) return null;
  const { day, time } = stamp(createdAt);
  const folder = path.join(config.dir, day);
  fs.mkdirSync(folder, { recursive: true });
  let base = `${time} ${slug(title)}${tag ? ` (${tag})` : ''}`;
  if (fs.existsSync(path.join(folder, base + ext))) base += ' ' + crypto.randomBytes(2).toString('hex');
  const file = path.join(folder, base + ext);
  fs.writeFileSync(file, data, { flag: 'wx' });
  if (recipe) fs.writeFileSync(path.join(folder, base + '.json'), JSON.stringify(recipe, null, 2) + '\n', { flag: 'wx' });
  return file;
}

const SOURCE_TAG = { comfyui: 'comfyui', 'nova-motion': 'camera', ltx: 'ltx', 'nova-frame': 'frame' };

/** Mirrors a generated media record. Uploads are skipped. */
function mirrorMedia(store, record, buffer) {
  if (!config || !config.enabled || !record || record.source === 'upload') return null;
  try {
    const p = record.provenance || {};
    const file = write({ title: p.prompt || record.originalName.replace(/\.[a-z0-9]+$/i, ''), tag: SOURCE_TAG[record.source] || record.source, ext: path.extname(record.fileName), data: buffer,
      recipe: { nova: 'generated-media', mediaId: record.id, kind: record.kind, mime: record.mime, sha256: record.sha256, createdAt: record.createdAt, source: record.source, provenance: p }, createdAt: record.createdAt });
    if (file) { record.libraryPath = file; store.put('media', record); }
    return file;
  } catch (e) { console.error('[nova-runtime] library: could not save media', record.id, e.message); record.libraryError = e.message; store.put('media', record); return null; }
}

function mirrorTranscript(store, record) {
  if (!config || !config.enabled || !record?.transcript?.text) return null;
  try {
    const t = record.transcript;
    const text = `# Transcript: ${record.originalName}\n\nModel: ${t.model || '?'} · language: ${t.language || 'auto'} · ${t.createdAt}\n\n${t.text}\n`;
    const file = write({ title: record.originalName.replace(/\.[a-z0-9]+$/i, '') + ' transcript', ext: '.md', data: text, recipe: { nova: 'transcript', mediaId: record.id, source: record.originalName, model: t.model, language: t.language, segments: t.segments }, createdAt: t.createdAt });
    if (file) { record.transcriptLibraryPath = file; store.put('media', record); }
    return file;
  } catch (e) { console.error('[nova-runtime] library: could not save transcript', record.id, e.message); return null; }
}

function titleFor(skill, result) {
  const d = result && result.data;
  return [skill.name, d && (d.title || d.production), result && result.targetLang && 'to ' + result.targetLang].filter(Boolean).join(' - ');
}

/** Keeps every skill run and mirrors text results into the library. */
function recordSkillOutput(store, skill, inputs, result, { startedAt, finishedAt } = {}) {
  const markdown = typeof result?.markdown === 'string' ? result.markdown : typeof result?.summary === 'string' ? result.summary : null;
  if (!markdown) return null;
  const entry = {
    id: 'out_' + crypto.randomBytes(8).toString('hex'), type: 'skill-output', skillId: skill.id, skillName: skill.name, title: titleFor(skill, result),
    kind: result.kind || null, markdown: markdown.slice(0, 200000), data: result.data || null, model: result.model || null,
    inputs: { sessionId: inputs?.sessionId || null, textPreview: inputs?.text ? String(inputs.text).slice(0, 300) : null, targetLang: inputs?.targetLang || null },
    startedAt: startedAt || null, createdAt: finishedAt || new Date().toISOString(), libraryPath: null,
  };
  try {
    entry.libraryPath = write({ title: entry.title, ext: '.md', data: markdown, recipe: { nova: 'skill-output', outputId: entry.id, skillId: skill.id, skillVersion: skill.version, model: entry.model, inputs: entry.inputs, data: entry.data, createdAt: entry.createdAt }, createdAt: entry.createdAt });
  } catch (e) { console.error('[nova-runtime] library: could not save skill output', e.message); entry.libraryError = e.message; }
  store.put('skillOutputs', entry);
  return entry;
}

function listSkillOutputs(store, skillId, limit = 50) {
  return store.all('skillOutputs').filter(o => !skillId || o.skillId === skillId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit);
}

/** Copies generated items made before the library existed (or while it was off). */
function backfill(store, dataDir) {
  if (!config || !config.enabled) throw error('The library folder is off.', 409);
  const media = require('./media');
  let mediaCount = 0, outputCount = 0, transcriptCount = 0;
  for (const record of store.all('media')) {
    if (record.source !== 'upload' && !record.libraryPath) { try { if (mirrorMedia(store, record, fs.readFileSync(media.filePath(dataDir, record)))) mediaCount++; } catch (_) {} }
    const fresh = store.get('media', record.id);
    if (fresh?.transcript && !fresh.transcriptLibraryPath && mirrorTranscript(store, fresh)) transcriptCount++;
  }
  for (const out of store.all('skillOutputs')) {
    if (out.libraryPath) continue;
    try { out.libraryPath = write({ title: out.title, ext: '.md', data: out.markdown, recipe: { nova: 'skill-output', outputId: out.id, skillId: out.skillId, model: out.model, inputs: out.inputs, data: out.data, createdAt: out.createdAt }, createdAt: out.createdAt }); if (out.libraryPath) { store.put('skillOutputs', out); outputCount++; } } catch (_) {}
  }
  // Skills that only ever kept their last output: keep that one in history too.
  for (const skill of store.all('skills')) {
    if (!skill.lastOutput?.markdown || store.all('skillOutputs').some(o => o.skillId === skill.id)) continue;
    if (recordSkillOutput(store, skill, {}, { markdown: skill.lastOutput.markdown, targetLang: skill.lastOutput.targetLang }, { finishedAt: skill.lastOutput.at })) outputCount++;
  }
  return { media: mediaCount, transcripts: transcriptCount, skillOutputs: outputCount, dir: config.dir };
}

module.exports = { configure, reset, info, setDir, write, mirrorMedia, mirrorTranscript, recordSkillOutput, listSkillOutputs, backfill, slug, DEFAULT_DIR };
