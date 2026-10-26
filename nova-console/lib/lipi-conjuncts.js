'use strict';
/**
 * Conjunct shape editor: per-pair nudges and per-letter sizes for the Maataa Lipi conjunct fonts
 * (Brahmi+, Sharada, Dives Akuru), and a rebuild that writes the edited fonts into the data folder.
 *
 * The editor draws from lib/lipi-conjunct-glyphs.json (outlines and attachment points written by
 * tools/build-lipi-conjunct-fonts.py --glyphs). Edits live in the store `lipiConjuncts` (one record,
 * id "overrides"). A rebuild runs the same tool with the edits and puts the fonts in
 * DATA_DIR/fonts/lipi, which the server then serves in place of the shipped ones.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const STORE = 'lipiConjuncts';
const CODES = { Brah: 'brahmi', Shrd: 'sharada', Diak: 'dives-akuru' };
const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'build-lipi-conjunct-fonts.py');
const SRC = path.join(ROOT, 'tools', 'fonts-src');
const LIMIT = 600;

const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const dataDir = () => process.env.DATA_DIR || path.join(ROOT, 'data');
const outDir = () => path.join(dataDir(), 'fonts', 'lipi');

let shipped = null;
function glyphs() {
  const edited = path.join(outDir(), 'lipi-conjunct-glyphs.json');
  if (fs.existsSync(edited)) return JSON.parse(fs.readFileSync(edited, 'utf8'));
  if (!shipped) shipped = JSON.parse(fs.readFileSync(path.join(__dirname, 'lipi-conjunct-glyphs.json'), 'utf8'));
  return shipped;
}

function overrides(store) {
  const r = store.get(STORE, 'overrides');
  return r ? r.scripts : {};
}

/** Everything the editor needs: outlines, attachment points, the saved edits and the font status. */
function data(store) {
  const fonts = Object.fromEntries(Object.entries(CODES).map(([c, slug]) => {
    const f = path.join(outDir(), `maataa-lipi-${slug}.woff2`);
    return [c, fs.existsSync(f) ? { edited: true, builtAt: fs.statSync(f).mtime.toISOString() } : { edited: false }];
  }));
  const rec = store.get(STORE, 'overrides');
  return { ...glyphs(), overrides: overrides(store), savedAt: rec ? rec.updatedAt : null, fonts, python: findPython().found };
}

function cleanNumber(v, lo, hi, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw error(`${label} must be a number from ${lo} to ${hi}.`);
  return Math.round(n * 1000) / 1000;
}

/** Saves the edits. body: { scripts: { Brah: { pairs: { 'क+त': { dx, dy } }, scale: { 'त': 0.8 } } } } */
function save(store, body = {}) {
  const g = glyphs().scripts;
  const input = body.scripts || {};
  const clean = {};
  for (const [code, v] of Object.entries(input)) {
    if (!CODES[code]) throw error(`The conjunct editor has no script ${code}.`);
    const letters = g[code] ? g[code].letters : {};
    const pairs = {}, scale = {};
    for (const [key, p] of Object.entries((v && v.pairs) || {})) {
      const [up, low] = String(key).split('+');
      if (!letters[up] || !letters[low]) throw error(`Unknown pair ${key} for ${code}.`);
      const dx = cleanNumber(p.dx || 0, -LIMIT, LIMIT, 'Move across'), dy = cleanNumber(p.dy || 0, -LIMIT, LIMIT, 'Move up or down');
      if (dx || dy) pairs[`${up}+${low}`] = { dx, dy };
    }
    for (const [ch, s] of Object.entries((v && v.scale) || {})) {
      if (!letters[ch]) throw error(`Unknown letter ${ch} for ${code}.`);
      const n = cleanNumber(s, 0.4, 1, 'Size');
      if (Math.abs(n - g[code].scale) > 0.0005) scale[ch] = n;
    }
    if (Object.keys(pairs).length || Object.keys(scale).length) clean[code] = { pairs, scale };
  }
  const now = new Date().toISOString();
  store.put(STORE, { id: 'overrides', scripts: clean, updatedAt: now });
  return { overrides: clean, savedAt: now };
}

/** A Python that can build fonts: NOVA_FONT_PYTHON, then ~/.maataa/fonttools, then python3. */
function findPython() {
  const candidates = [process.env.NOVA_FONT_PYTHON, path.join(os.homedir(), '.maataa', 'fonttools', 'bin', 'python'), 'python3'].filter(Boolean);
  for (const py of candidates) {
    try {
      const r = spawnSync(py, ['-c', 'import fontTools, brotli'], { timeout: 15000 });
      if (r.status === 0) return { found: true, python: py };
    } catch (_) { /* try the next one */ }
  }
  return { found: false, python: null };
}

/** Rebuilds the edited fonts into the data folder. Resolves { ok, log, fonts }. */
function rebuild(store) {
  const py = findPython();
  if (!py.found) {
    return Promise.reject(error('Font tools are not installed. Double-click "Lipi - Install font tools.command" in brahmini/launchers (about 10 MB), then rebuild.', 412));
  }
  fs.mkdirSync(outDir(), { recursive: true });
  const ovFile = path.join(os.tmpdir(), `lipi-conjuncts-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(ovFile, JSON.stringify(overrides(store)));
  const args = [TOOL, '--src', SRC, '--out', outDir(), '--overrides', ovFile, '--glyphs', path.join(outDir(), 'lipi-conjunct-glyphs.json'), ...Object.keys(CODES)];
  return new Promise((resolve, reject) => {
    let log = '';
    const child = spawn(py.python, args, { cwd: ROOT });
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, 180000);
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });
    child.on('error', e => { clearTimeout(timer); reject(error('Could not start the font build: ' + e.message, 500)); });
    child.on('close', status => {
      clearTimeout(timer);
      try { fs.unlinkSync(ovFile); } catch (_) { /* ignore */ }
      if (status !== 0) return reject(Object.assign(error('The font build failed. ' + log.trim().split('\n').slice(-3).join(' '), 500), { log }));
      resolve({ ok: true, log: log.trim(), fonts: data(store).fonts, builtAt: new Date().toISOString() });
    });
  });
}

/** Goes back to the shipped fonts: removes the edited fonts (the saved edits stay). */
function resetFonts() {
  for (const slug of Object.values(CODES)) { try { fs.unlinkSync(path.join(outDir(), `maataa-lipi-${slug}.woff2`)); } catch (_) { /* none */ } }
  try { fs.unlinkSync(path.join(outDir(), 'lipi-conjunct-glyphs.json')); } catch (_) { /* none */ }
  return { ok: true };
}

/** The edited font file for a /fonts/lipi/ path, if one was built; null otherwise. */
function editedFont(pathname) {
  const m = /^\/fonts\/lipi\/(maataa-lipi-[a-z-]+\.woff2)$/.exec(pathname);
  if (!m) return null;
  const f = path.join(outDir(), m[1]);
  return fs.existsSync(f) ? f : null;
}

module.exports = { STORE, CODES, data, save, rebuild, resetFonts, editedFont, findPython, _reset: () => { shipped = null; } };
