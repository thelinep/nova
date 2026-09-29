'use strict';
/* ===========================================================================
 * Text recognition: exact text and code from images, on this Mac
 *
 * On macOS NOVA uses Apple's Vision framework (the same text recognition as
 * Live Text), run through osascript's JavaScript bridge, so nothing is
 * downloaded. Elsewhere it uses tesseract when installed. The result keeps
 * the layout: lines in reading order, and indentation rebuilt from where
 * each line starts, which matters for code.
 *
 * recognize(file, {mode}) → {engine, text, lines:[{text, conf}], confidence}
 * mode 'code' turns language correction off so symbols and names stay exact.
 * ========================================================================= */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const IS_MAC = process.platform === 'darwin';
function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function which(name) { for (const dir of (process.env.PATH || '').split(':').concat(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])) { const f = path.join(dir, name); try { fs.accessSync(f, fs.constants.X_OK); return f; } catch (_) {} } return null; }

let runner = (file, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: opts.timeout || 60000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) { err.message = String(stderr || err.message).trim().slice(-600) || err.message; reject(err); } else resolve(String(stdout));
  });
});
function setRunner(fn) { const prev = runner; runner = fn; return prev; }

// Apple Vision through JXA. Observations come back with normalised boxes, origin bottom-left.
const VISION_JXA = `
ObjC.import('Foundation'); ObjC.import('Vision');
function run(argv) {
  var url = $.NSURL.fileURLWithPath(argv[0]);
  var req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = 0;               // accurate
  req.usesLanguageCorrection = argv[1] === 'prose';
  try { req.automaticallyDetectsLanguage = true; } catch (e) {}
  var handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $({}));
  var err = Ref();
  if (!handler.performRequestsError($([req]), err)) throw new Error('Vision could not read the image');
  var out = [], res = req.results, n = res ? res.count : 0;
  for (var i = 0; i < n; i++) {
    var o = res.objectAtIndex(i), cands = o.topCandidates(1);
    if (!cands.count) continue;
    var c = cands.objectAtIndex(0), b = o.boundingBox;
    out.push({ t: ObjC.unwrap(c.string), c: c.confidence, x: b.origin.x, y: b.origin.y, w: b.size.width, h: b.size.height });
  }
  return JSON.stringify(out);
}`;

// The same request compiled from Swift: a fallback when the JavaScript bridge cannot load Vision.
const VISION_SWIFT = `import Foundation
import Vision
let args = CommandLine.arguments
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = args.count > 2 && args[2] == "prose"
if #available(macOS 13.0, *) { req.automaticallyDetectsLanguage = true }
let handler = VNImageRequestHandler(url: URL(fileURLWithPath: args[1]), options: [:])
try handler.perform([req])
var out: [[String: Any]] = []
for o in (req.results ?? []) {
  guard let c = o.topCandidates(1).first else { continue }
  let b = o.boundingBox
  out.append(["t": c.string, "c": Double(c.confidence), "x": Double(b.origin.x), "y": Double(b.origin.y), "w": Double(b.size.width), "h": Double(b.size.height)])
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: out))
`;

async function swiftHelper() {
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'NOVA');
  const bin = path.join(cache, 'nova-ocr-' + require('node:crypto').createHash('sha1').update(VISION_SWIFT).digest('hex').slice(0, 10));
  if (fs.existsSync(bin)) return bin;
  const swiftc = ['/usr/bin/swiftc', which('swiftc')].find(f => f && fs.existsSync(f));
  if (!swiftc) throw error('Swift is not installed (xcode-select --install).', 412);
  fs.mkdirSync(cache, { recursive: true });
  const src = path.join(cache, 'nova-ocr.swift');
  fs.writeFileSync(src, VISION_SWIFT);
  await runner(swiftc, ['-O', src, '-o', bin], { timeout: 180000 });
  return bin;
}

function engines() {
  const list = [];
  if (IS_MAC && fs.existsSync('/usr/bin/osascript')) list.push('apple-vision');
  if (which('tesseract')) list.push('tesseract');
  return list;
}

function median(xs) { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; }

/**
 * Turns boxes into text in reading order. Items on the same row are joined
 * with spaces; each row is indented by how far right it starts, measured in
 * the typical character width — enough to rebuild code indentation.
 * items: [{t, c, x, y, w, h}] with y measured from the bottom (Vision).
 */
function layout(items) {
  const obs = items.filter(o => o && String(o.t || '').trim()).map(o => ({ ...o, top: 1 - (o.y + o.h), mid: 1 - (o.y + o.h / 2) }));
  if (!obs.length) return { text: '', lines: [], confidence: 0 };
  obs.sort((a, b) => a.top - b.top || a.x - b.x);
  const rows = [];
  const hMed = median(obs.map(o => o.h)) || 0.02;
  for (const o of obs) {
    const row = rows.find(r => Math.abs(r.mid - o.mid) < hMed * 0.5);
    if (row) { row.items.push(o); row.mid = (row.mid * (row.items.length - 1) + o.mid) / row.items.length; } else rows.push({ mid: o.mid, items: [o] });
  }
  rows.sort((a, b) => a.mid - b.mid);
  const charW = median(obs.filter(o => o.t.length >= 3).map(o => o.w / o.t.length)) || median(obs.map(o => o.w / Math.max(1, o.t.length))) || 0.01;
  const minX = Math.min(...obs.map(o => o.x));
  const lines = []; let prevMid = null;
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    // A gap of more than about 1.8 line heights is a blank line in the original.
    if (prevMid != null && r.mid - prevMid > hMed * 2.3) lines.push({ text: '', conf: 1 });
    prevMid = r.mid;
    let text = ' '.repeat(Math.max(0, Math.round((r.items[0].x - minX) / charW)));
    let end = r.items[0].x;
    r.items.forEach((o, i) => {
      if (i) text += ' '.repeat(Math.max(1, Math.round((o.x - end) / charW)));
      text += o.t; end = o.x + o.w;
    });
    lines.push({ text: text.replace(/\s+$/, ''), conf: r.items.reduce((n, o) => n + (o.c || 0), 0) / r.items.length });
  }
  const scored = lines.filter(l => l.text);
  return { text: lines.map(l => l.text).join('\n'), lines, confidence: scored.length ? +(scored.reduce((n, l) => n + l.conf, 0) / scored.length).toFixed(3) : 0 };
}

async function appleVision(file, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ocr-'));
  try {
    const script = path.join(dir, 'ocr.js');
    fs.writeFileSync(script, VISION_JXA);
    const m = mode === 'code' ? 'code' : 'prose';
    let out;
    try { out = await runner('/usr/bin/osascript', ['-l', 'JavaScript', script, file, m], { timeout: 60000 }); JSON.parse(out.trim() || '[]'); }
    catch (jxaError) {
      try { out = await runner(await swiftHelper(), [file, m], { timeout: 60000 }); }
      catch (_) { throw jxaError; }
    }
    return layout(JSON.parse(out.trim() || '[]'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function tesseract(file) {
  const bin = which('tesseract');
  // --psm 6: one uniform block, which keeps code lines and their spacing.
  const out = await runner(bin, [file, 'stdout', '--psm', '6', '-c', 'preserve_interword_spaces=1'], { timeout: 90000 });
  const text = out.replace(/\f/g, '').replace(/\s+$/, '');
  return { text, lines: text.split('\n').map(t => ({ text: t, conf: null })), confidence: null };
}

/** Reads the text in an image file. Throws with a clear message when no engine is available. */
async function recognize(file, { mode = 'prose' } = {}) {
  if (!file || !fs.existsSync(file)) throw error('Image not found.', 404);
  const list = engines();
  if (!list.length) throw error('Text recognition needs macOS (built in) or tesseract (brew install tesseract).', 412);
  let lastErr;
  for (const engine of list) {
    try {
      const r = engine === 'apple-vision' ? await appleVision(file, mode) : await tesseract(file);
      return { engine, ...r };
    } catch (e) { lastErr = e; }
  }
  throw error('Could not read text in the image: ' + (lastErr && lastErr.message), 500);
}

/** A rough guess whether recognised text is code (for choosing a code fence and exact mode). */
function looksLikeCode(text) {
  const t = String(text || '');
  if (t.length < 20) return false;
  const sym = (t.match(/[{}();=<>[\]]|=>|::|\bfunction\b|\bconst\b|\bdef\b|\bimport\b|\breturn\b|<\/?\w+/g) || []).length;
  return sym / Math.max(1, t.split('\n').length) > 0.6;
}

module.exports = { recognize, layout, engines, looksLikeCode, setRunner, VISION_JXA };
