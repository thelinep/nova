'use strict';
/* ===========================================================================
 * Image to code, checked in a sandbox
 *
 * From a screenshot or design, NOVA writes one self-contained HTML page, then
 * checks it: the page is rendered by a headless browser in a throwaway
 * profile with the network blocked, the render is compared with the original
 * (layout and colour on a grid, plus the recognised text), and the model gets
 * the differences and fixes them. Up to three attempts; the best one is kept.
 *
 * Nothing is written to your folders: builds live in DATA_DIR/builds/<id>/.
 * They are served back with a sandbox header so a page cannot talk to NOVA.
 * ========================================================================= */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const ocr = require('./ocr');

const MAX_ATTEMPTS = 3;
const GRID_COLS = 24;
function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function run(file, args, timeout = 90000) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) { err.message = String(stderr || err.message).trim().slice(-600) || err.message; reject(err); } else resolve(String(stdout));
  }));
}
function which(name) { for (const dir of (process.env.PATH || '').split(':').concat(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])) { const f = path.join(dir, name); try { fs.accessSync(f, fs.constants.X_OK); return f; } catch (_) {} } return null; }

/* ---------------------------------------------------------------- browser */

function findBrowser() {
  const candidates = [process.env.NOVA_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    which('google-chrome'), which('chromium'), which('chromium-browser')];
  try { for (const d of fs.readdirSync('/opt/pw-browsers')) if (/^chromium-\d+$/.test(d)) candidates.push(path.join('/opt/pw-browsers', d, 'chrome-linux', 'chrome')); } catch (_) {}
  return candidates.find(c => c && fs.existsSync(c)) || null;
}

/** Renders HTML to a PNG in a headless browser: fresh profile, network blocked, no extensions. */
async function render(htmlFile, outPng, { width = 1280, height = 800, dpr = 1 } = {}) {
  const browser = findBrowser();
  if (!browser) throw error('Checking the page needs Google Chrome, Chromium, Edge or Brave installed.', 412);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-render-'));
  const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', `--user-data-dir=${profile}`,
    '--proxy-server=127.0.0.1:9', '--proxy-bypass-list=<-loopback>', // any request to the internet fails
    `--window-size=${Math.round(width)},${Math.round(height)}`, `--force-device-scale-factor=${dpr}`,
    '--virtual-time-budget=3000', `--screenshot=${outPng}`, 'file://' + htmlFile];
  if (process.getuid && process.getuid() === 0) args.unshift('--no-sandbox');
  try { await run(browser, args, 60000); }
  finally { fs.rmSync(profile, { recursive: true, force: true }); }
  if (!fs.existsSync(outPng)) throw error('The browser did not produce a picture of the page.', 500);
  return outPng;
}

/* ------------------------------------------------------------------ PNG */

/** Minimal PNG decoder: 8-bit greyscale, RGB, RGBA, grey+alpha and palette; not interlaced. */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw error('Not a PNG file.');
  let pos = 8, width, height, depth, type, interlace, palette = null; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), kind = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === 'PLTE') palette = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace) throw error('Unsupported PNG (needs 8-bit, not interlaced).');
  const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!chans) throw error('Unsupported PNG colour type.');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * chans, out = Buffer.alloc(width * height * 3);
  let prev = Buffer.alloc(stride), p = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[p++], line = Buffer.from(raw.subarray(p, p + stride)); p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= chans ? line[i - chans] : 0, b = prev[i], c = i >= chans ? prev[i - chans] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3, s = x * chans;
      if (type === 2 || type === 6) { out[o] = line[s]; out[o + 1] = line[s + 1]; out[o + 2] = line[s + 2]; }
      else if (type === 3) { const k = line[s] * 3; out[o] = palette[k]; out[o + 1] = palette[k + 1]; out[o + 2] = palette[k + 2]; }
      else { out[o] = out[o + 1] = out[o + 2] = line[s]; }
    }
    prev = line;
  }
  return { width, height, rgb: out };
}

/** Any image → PNG file NOVA can read (sips on macOS, else ffmpeg). */
async function toPng(input, outPng) {
  const head = fs.readFileSync(input).subarray(0, 8);
  if (head.readUInt32BE(0) === 0x89504e47) { try { decodePng(fs.readFileSync(input)); fs.copyFileSync(input, outPng); return outPng; } catch (_) { /* interlaced/16-bit: convert */ } }
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/sips')) { await run('/usr/bin/sips', ['-s', 'format', 'png', input, '--out', outPng]); return outPng; }
  const ff = which('ffmpeg'); if (!ff) throw error('Converting this image needs ffmpeg (brew install ffmpeg).', 412);
  await run(ff, ['-y', '-loglevel', 'error', '-i', input, '-frames:v', '1', '-pix_fmt', 'rgb24', outPng]);
  return outPng;
}

/* --------------------------------------------------------------- compare */

function grid(img, cols, rows) {
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x0 = Math.floor(c * img.width / cols), x1 = Math.max(x0 + 1, Math.floor((c + 1) * img.width / cols));
    const y0 = Math.floor(r * img.height / rows), y1 = Math.max(y0 + 1, Math.floor((r + 1) * img.height / rows));
    let R = 0, G = 0, B = 0, n = 0;
    const step = Math.max(1, Math.floor((x1 - x0) / 8));
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) { const o = (y * img.width + x) * 3; R += img.rgb[o]; G += img.rgb[o + 1]; B += img.rgb[o + 2]; n++; }
    cells.push([R / n, G / n, B / n]);
  }
  return cells;
}

const REGION = (r, c, rows, cols) => `${['top', 'upper middle', 'middle', 'lower middle', 'bottom'][Math.min(4, Math.floor(r / rows * 5))]} ${['left', 'centre-left', 'centre', 'centre-right', 'right'][Math.min(4, Math.floor(c / cols * 5))]}`;

/** Compares two images on a colour grid. Returns similarity 0..1 and the regions that differ most. */
function compareImages(a, b) {
  const cols = GRID_COLS, rows = Math.max(4, Math.min(40, Math.round(cols * a.height / a.width)));
  const ga = grid(a, cols, rows), gb = grid(b, cols, rows);
  const diffs = ga.map((x, i) => (Math.abs(x[0] - gb[i][0]) + Math.abs(x[1] - gb[i][1]) + Math.abs(x[2] - gb[i][2])) / (3 * 255));
  const similarity = 1 - diffs.reduce((n, d) => n + d, 0) / diffs.length;
  const worst = diffs.map((d, i) => ({ d, r: Math.floor(i / cols), c: i % cols })).filter(x => x.d > 0.12).sort((x, y) => y.d - x.d);
  const regions = [...new Set(worst.map(w => REGION(w.r, w.c, rows, cols)))].slice(0, 5);
  const hex = v => '#' + v.map(n => Math.round(n).toString(16).padStart(2, '0')).join('');
  const colourNotes = worst.slice(0, 3).map(w => `${REGION(w.r, w.c, rows, cols)}: original ${hex(ga[w.r * cols + w.c])}, yours ${hex(gb[w.r * cols + w.c])}`);
  return { similarity: +similarity.toFixed(3), regions, colourNotes, heightRatio: +(b.height / a.height).toFixed(2) };
}

function words(t) { return String(t || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) || []; }
/** Share of the original's words that appear in the render, and the missing ones. */
function textRecall(original, rendered) {
  const want = words(original).filter(w => w.length > 1), have = new Set(words(rendered));
  if (!want.length) return { recall: null, missing: [] };
  const missing = [...new Set(want.filter(w => !have.has(w)))];
  return { recall: +(1 - want.filter(w => !have.has(w)).length / want.length).toFixed(3), missing: missing.slice(0, 25) };
}

/* ----------------------------------------------------------------- build */

function extractHtml(text) {
  const t = String(text || '');
  const fence = /```(?:html)?\s*\n([\s\S]*?)```/i.exec(t);
  const body = (fence ? fence[1] : t).trim();
  const start = body.search(/<!doctype html|<html[\s>]/i);
  if (start < 0) return null;
  return body.slice(start);
}

const SYSTEM = [
  'You turn a screenshot or design into one self-contained HTML file that looks the same.',
  'Rules: a single file with inline <style> (and inline <script> only if needed); no external links, fonts, CDNs or images — use CSS shapes, gradients, emoji or inline SVG for icons and pictures.',
  'Match the layout, sizes, spacing, colours, fonts (use system fonts that look closest) and every piece of visible text exactly.',
  'Make the page exactly the width given and do not add content that is not in the image.',
  'Reply with only the HTML in one ```html code block.',
].join('\n');

/**
 * deps: {ollama, dataDir}; input: {model, imageFile, request, canSee, signal}
 * job: an activity handle (step/done). Returns the build record.
 */
async function buildFromImage(deps, input, job) {
  const { ollama, dataDir } = deps;
  const id = 'build_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const dir = path.join(dataDir, 'builds', id);
  fs.mkdirSync(dir, { recursive: true });
  const original = await toPng(input.imageFile, path.join(dir, 'original.png'));
  const orig = decodePng(fs.readFileSync(original));
  const dpr = orig.width >= 1800 ? 2 : 1; // Retina screenshots are twice the CSS size
  const cssW = Math.round(orig.width / dpr), cssH = Math.round(orig.height / dpr);

  let text = input.ocrText;
  if (text == null) {
    const st = job.step('Reading the text in the image');
    try { const r = await ocr.recognize(original, { mode: 'prose' }); text = r.text; st.done(`${r.engine} · ${text.split('\n').filter(Boolean).length} lines`); }
    catch (e) { text = ''; st.fail(e); }
  }
  const imageB64 = fs.readFileSync(original).toString('base64');
  const base = [{ role: 'system', content: SYSTEM }, {
    role: 'user',
    content: `${input.request || 'Recreate this as a web page.'}\nThe page must be ${cssW} px wide and about ${cssH} px tall.` + (text ? `\n\nExact text in the image (from text recognition, keep it word for word):\n${text.slice(0, 8000)}` : ''),
    ...(input.canSee ? { images: [imageB64] } : {}),
  }];
  let messages = base.slice();
  const attempts = [];
  let best = null;
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    if (input.signal && input.signal.aborted) throw error('Cancelled', 499);
    const w = job.step(n === 1 ? 'Writing the page' : `Fixing it (attempt ${n} of ${MAX_ATTEMPTS})`);
    const res = await ollama.chatFull(input.model, messages, { options: { temperature: 0.2, num_predict: 8000 }, signal: input.signal });
    const html = extractHtml(res.message && res.message.content);
    if (!html) { w.fail('The model did not return an HTML page'); messages = [...messages, { role: 'assistant', content: String(res.message && res.message.content || '').slice(0, 4000) }, { role: 'user', content: 'Reply with the complete page as one ```html code block.' }]; continue; }
    w.done(`${html.length.toLocaleString()} characters`);
    const file = path.join(dir, `attempt-${n}.html`); fs.writeFileSync(file, html);
    const c = job.step('Checking it in a sandboxed browser', 'offline, fresh profile');
    let shot, cmp, recall = { recall: null, missing: [] };
    try {
      shot = await render(file, path.join(dir, `attempt-${n}.png`), { width: cssW, height: cssH, dpr });
      const img = decodePng(fs.readFileSync(shot));
      cmp = compareImages(orig, img);
      if (text) { try { const r = await ocr.recognize(shot, { mode: 'prose' }); recall = textRecall(text, r.text); } catch (_) {} }
      c.done(`Looks ${Math.round(cmp.similarity * 100)}% alike${recall.recall != null ? ` · ${Math.round(recall.recall * 100)}% of the text` : ''}`);
    } catch (e) { c.fail(e); cmp = null; }
    const a = { n, html: file, png: shot ? path.basename(shot) : null, similarity: cmp ? cmp.similarity : null, recall: recall.recall };
    attempts.push(a);
    const score = (a.similarity ?? 0) * 0.7 + (a.recall ?? a.similarity ?? 0) * 0.3;
    if (!best || score > best.score) best = { ...a, score };
    if (!cmp) break; // no browser: nothing to compare against
    if (cmp.similarity >= 0.95 && (recall.recall == null || recall.recall >= 0.95)) break;
    if (n === MAX_ATTEMPTS) break;
    const feedback = [
      `I rendered your page at ${cssW} px wide and compared it with the original.`,
      `It looks ${Math.round(cmp.similarity * 100)}% alike.` + (cmp.regions.length ? ` The biggest differences are in the ${cmp.regions.join('; ')}.` : ''),
      cmp.colourNotes.length ? 'Colour differences: ' + cmp.colourNotes.join('; ') + '.' : '',
      cmp.heightRatio < 0.9 || cmp.heightRatio > 1.1 ? `Your page is ${Math.round(cmp.heightRatio * 100)}% of the original height.` : '',
      recall.missing.length ? `Text missing or different: ${recall.missing.join(', ')}.` : '',
      'Fix these and reply with the whole corrected page in one ```html code block.',
    ].filter(Boolean).join('\n');
    const renderB64 = fs.readFileSync(shot).toString('base64');
    messages = [...base, { role: 'assistant', content: '```html\n' + html + '\n```' }, { role: 'user', content: feedback + (input.canSee ? '\nThe first image is the original, the second is your render.' : ''), ...(input.canSee ? { images: [imageB64, renderB64] } : {}) }];
  }
  if (!best) throw error('The model could not produce a page from this image. Try a vision model such as qwen2.5-vl or llama3.2-vision.', 502);
  fs.copyFileSync(best.html, path.join(dir, 'index.html'));
  if (best.png) fs.copyFileSync(path.join(dir, best.png), path.join(dir, 'preview.png'));
  const record = { id, createdAt: new Date().toISOString(), width: cssW, height: cssH, attempts: attempts.map(({ html, ...x }) => x), best: best.n, similarity: best.similarity, recall: best.recall, htmlUrl: `/api/builds/${id}/index.html`, previewUrl: best.png ? `/api/builds/${id}/preview.png` : null, originalUrl: `/api/builds/${id}/original.png`, chars: fs.statSync(path.join(dir, 'index.html')).size };
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify(record, null, 2));
  return { ...record, html: fs.readFileSync(path.join(dir, 'index.html'), 'utf8') };
}

function buildFile(dataDir, id, name) {
  if (!/^build_[\w]+$/.test(id) || !/^(index\.html|preview\.png|original\.png|attempt-\d\.(html|png))$/.test(name)) throw error('Not found', 404);
  const f = path.join(dataDir, 'builds', id, name);
  if (!fs.existsSync(f)) throw error('Not found', 404);
  return f;
}

/** Does this message ask to turn an attached image into a page or code? */
function wantsBuild(text) {
  const t = String(text || '');
  return /^\/build\b/i.test(t.trim()) || (/\b(build|make|create|recreate|replicate|clone|convert|turn|generate|code|implement|write|develop)\b/i.test(t) && /\b(html|css|web ?page|webpage|landing|website|site|ui|component|react|tailwind|layout|front-?end|screen|page)\b/i.test(t));
}

module.exports = { buildFromImage, render, decodePng, toPng, compareImages, textRecall, extractHtml, findBrowser, buildFile, wantsBuild, MAX_ATTEMPTS };
