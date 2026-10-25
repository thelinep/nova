'use strict';
/**
 * Lipi OCR: reads Brahmi from images with a small model trained on synthetic lines
 * (tools/lipi-ocr). Everything runs on this computer with ONNX Runtime; nothing is uploaded.
 *
 * - Readings of the Brahmi gallery images are made in advance (lib/lipi-brahmi-ocr.json).
 * - Reading a new image needs Python with onnxruntime, opencv and numpy:
 *   launchers/"Lipi - Install OCR.command" sets that up in ~/.maataa/lipi-ocr.
 * - A model retrained on this computer (launchers/"Lipi - Train OCR.command") is written to
 *   DATA_DIR/models/lipi-ocr and used in place of the shipped one.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const scripts = require('./lipi-scripts');
const gallery = require('./lipi-gallery');

const ROOT = path.join(__dirname, '..');
const READER = path.join(ROOT, 'tools', 'lipi-ocr', 'read.py');
const SHIPPED = path.join(__dirname, 'lipi-ocr', 'lipi-brahmi-ocr.onnx');
const MAX_IMAGE = 15 * 1024 * 1024;
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const dataDir = () => process.env.DATA_DIR || path.join(ROOT, 'data');

function model() {
  const own = path.join(dataDir(), 'models', 'lipi-ocr', 'lipi-brahmi-ocr.onnx');
  const file = fs.existsSync(own) ? own : SHIPPED;
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(file.replace(/\.onnx$/, '.json'), 'utf8')); } catch (_) { /* none */ }
  return { file, custom: file !== SHIPPED, valCER: meta.valCER, trainedOn: meta.trainedOn, created: meta.created };
}

let pyCache = null;
function findPython() {
  if (pyCache && Date.now() - pyCache.at < 60000) return pyCache.result;
  const candidates = [process.env.NOVA_OCR_PYTHON, path.join(os.homedir(), '.maataa', 'lipi-ocr', 'bin', 'python'), 'python3'].filter(Boolean);
  let result = { found: false, python: null };
  for (const py of candidates) {
    try {
      const r = spawnSync(py, ['-c', 'import onnxruntime, cv2, numpy'], { timeout: 20000 });
      if (r.status === 0) { result = { found: true, python: py }; break; }
    } catch (_) { /* next */ }
  }
  pyCache = { at: Date.now(), result };
  return result;
}

/** Adds the Devanagari transliteration of each line (for people who read Devanagari, not Brahmi). */
function withDeva(reading) {
  const lines = (reading.lines || []).map(l => ({ ...l, deva: scripts.toDeva(l.text, 'Brah') }));
  return { ...reading, lines };
}

let readingsCache = null;
function readings() {
  if (!readingsCache) {
    const f = path.join(__dirname, 'lipi-brahmi-ocr.json');
    readingsCache = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { items: {} };
  }
  return readingsCache;
}

function status() {
  const r = readings();
  const items = Object.fromEntries(Object.entries(r.items || {}).map(([id, v]) => [id, withDeva(v)]));
  return { model: model(), python: findPython().found, readings: items, summary: r.summary || null, evaluation: r.evaluation || null, threshold: r.threshold || 0.8, createdAt: r.createdAt || null };
}

function run(file) {
  const py = findPython();
  if (!py.found) return Promise.reject(error('Reading new images needs the OCR tools. Double-click "Lipi - Install OCR.command" in brahmini/launchers (about 80 MB), then try again.', 412));
  const m = model();
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    const child = spawn(py.python, [READER, m.file, file], { cwd: ROOT });
    const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(error('Could not start the OCR: ' + e.message, 500)); });
    child.on('close', code => {
      clearTimeout(timer);
      const line = out.trim().split('\n').pop();
      let res = null;
      try { res = JSON.parse(line); } catch (_) { /* below */ }
      if (code !== 0 || !res || res.error) return reject(error('The OCR failed. ' + ((res && res.error) || err.trim().split('\n').slice(-2).join(' ')), 500));
      delete res.file;
      resolve(withDeva({ ...res, model: { custom: m.custom, valCER: m.valCER } }));
    });
  });
}

/** body: { gallery: id } or { image: 'data:image/...;base64,...' } */
async function read(body = {}) {
  if (body.gallery) {
    const it = gallery.item(String(body.gallery));
    return run(path.join(ROOT, 'public', it.image));
  }
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/s.exec(String(body.image || ''));
  if (!m) throw error('Send a gallery id or a PNG, JPEG or WebP image.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_IMAGE) throw error('The image is larger than 15 MB.', 413);
  const tmp = path.join(os.tmpdir(), `lipi-ocr-${process.pid}-${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
  fs.writeFileSync(tmp, buf);
  try { return await run(tmp); } finally { try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ } }
}

module.exports = { status, read, readings, model, findPython, withDeva, _reset: () => { readingsCache = null; pyCache = null; } };
