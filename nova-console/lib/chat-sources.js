'use strict';
/* ===========================================================================
 * Chat sources: folders, files, web pages and git repositories added to a
 * conversation
 *
 * Adding a source reads it once (as an activity job, step by step), keeps a
 * plain-text copy under DATA_DIR/chat-sources/<id>/, and splits it into
 * chunks. Each reply then gets a short overview of every source plus the
 * chunks that best match the question, within a character budget, so the
 * model answers from the real material.
 *
 * Folders are read in place (never changed). Web pages and git clones need
 * Settings > Allow network access. Nothing here runs code from a source.
 * ========================================================================= */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', '.next', 'dist', 'build', 'coverage', '.cache', '__pycache__', '.venv', 'venv', '.idea', '.DS_Store', 'Pods', 'DerivedData']);
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'rst', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'xml', 'html', 'htm', 'css', 'scss', 'less',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish',
  'sql', 'graphql', 'proto', 'lua', 'r', 'm', 'mm', 'dart', 'scala', 'ex', 'exs', 'erl', 'hs', 'clj', 'tex', 'srt', 'vtt', 'fountain', 'fdx', 'log', 'gitignore', 'dockerfile', 'makefile']);
const LIMITS = { files: 600, fileBytes: 300 * 1024, totalBytes: 12 * 1024 * 1024, urlBytes: 6 * 1024 * 1024, chunkChars: 1400, gitTimeoutMs: 240000 };
const KINDS = ['file', 'folder', 'url', 'git'];

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function now() { return new Date().toISOString(); }
function newId() { return 'src_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }
function dirFor(dataDir, id) { return path.join(dataDir, 'chat-sources', id.replace(/[^\w-]/g, '')); }
function human(bytes) { return bytes < 1024 ? bytes + ' B' : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB'; }
function home(p) { const h = os.homedir(); return h && p && p.startsWith(h) ? '~' + p.slice(h.length) : p; }
function webAccessOn(store) { const p = store.get('preferences', 'default'); return Boolean(p && p.webAccess); }
function which(name) { for (const dir of (process.env.PATH || '').split(':').concat(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])) { const f = path.join(dir, name); try { fs.accessSync(f, fs.constants.X_OK); return f; } catch (_) {} } return null; }
function run(file, args, { timeout = 60000, cwd, env, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout, cwd, env: { ...process.env, ...env }, maxBuffer: 32 * 1024 * 1024, signal }, (err, stdout, stderr) => {
      if (err) { err.message = (String(stderr || '').trim().split('\n').slice(-3).join(' ') || err.message).slice(0, 600); reject(err); } else resolve(String(stdout));
    });
    child.stdin && child.stdin.end();
  });
}

function extOf(name) { const base = path.basename(name).toLowerCase(); if (['dockerfile', 'makefile', '.gitignore'].includes(base)) return base.replace('.', ''); const i = base.lastIndexOf('.'); return i > 0 ? base.slice(i + 1) : ''; }
function looksBinary(buf) { const n = Math.min(buf.length, 4096); let odd = 0; for (let i = 0; i < n; i++) { const c = buf[i]; if (c === 0) return true; if (c < 7 || (c > 13 && c < 32)) odd++; } return n > 0 && odd / n > 0.1; }

function htmlToText(html) {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '';
  let t = html.replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr|section|article|pre|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ').replace(/<h([1-6])[^>]*>/gi, (_, n) => '\n' + '#'.repeat(+n) + ' ')
    .replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t).replace(/[ \t\f\v\r]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').replace(/ *\n */g, '\n').trim();
  return { title: decodeEntities(title).trim(), text: t };
}
function decodeEntities(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** Plain text from one file, or null when NOVA cannot read that kind of file. */
async function extractText(file, name = file) {
  const ext = extOf(name);
  const stat = fs.statSync(file);
  if (ext === 'pdf') {
    const bin = which('pdftotext'); if (!bin) return { text: null, note: 'PDF text needs pdftotext (brew install poppler).' };
    return { text: await run(bin, ['-layout', '-q', file, '-'], { timeout: 60000 }) };
  }
  if (ext === 'docx' || ext === 'pptx' || ext === 'xlsx') {
    const unzip = which('unzip'); if (!unzip) return { text: null, note: 'Office files need unzip.' };
    const part = ext === 'docx' ? ['word/document.xml'] : ext === 'pptx' ? ['ppt/slides/*.xml'] : ['xl/sharedStrings.xml'];
    try { const xml = await run(unzip, ['-p', file, ...part], { timeout: 30000 }); return { text: decodeEntities(xml.replace(/<\/(w:p|a:p|si)>/g, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim() }; }
    catch (e) { return { text: null, note: 'Could not read this Office file: ' + e.message }; }
  }
  if (ext === 'rtf' && which('textutil')) return { text: await run(which('textutil'), ['-convert', 'txt', '-stdout', file]) };
  if (stat.size > LIMITS.fileBytes * 4 && !TEXT_EXT.has(ext)) return { text: null, note: 'Too large to read as text.' };
  const buf = fs.readFileSync(file).subarray(0, LIMITS.fileBytes * 4);
  if (looksBinary(buf)) return { text: null, note: 'Binary file (not read).' };
  let text = buf.toString('utf8');
  if (ext === 'html' || ext === 'htm') text = htmlToText(text).text;
  return { text };
}

function chunk(pathLabel, text) {
  const out = [];
  const lines = text.split('\n');
  let buf = '', start = 1, line = 1;
  for (const l of lines) {
    if (buf.length + l.length > LIMITS.chunkChars && buf) { out.push({ path: pathLabel, line: start, text: buf }); buf = ''; start = line; }
    buf += (buf ? '\n' : '') + l.slice(0, LIMITS.chunkChars * 2); line++;
  }
  if (buf.trim()) out.push({ path: pathLabel, line: start, text: buf });
  return out;
}

/** Walks a folder: text files only, skipping build/dependency folders and hidden files. */
function walk(root, signal) {
  const files = [], skipped = []; let total = 0, truncated = false;
  const stack = [''];
  while (stack.length) {
    if (signal && signal.aborted) throw error('Cancelled', 499);
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch (_) { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) { skipped.push(r + '/'); continue; } stack.push(r); continue; }
      if (!e.isFile() || e.name.startsWith('.') && !['.env.example', '.gitignore'].includes(e.name)) continue;
      let size = 0; try { size = fs.statSync(path.join(root, r)).size; } catch (_) { continue; }
      if (files.length >= LIMITS.files || total + Math.min(size, LIMITS.fileBytes) > LIMITS.totalBytes) { truncated = true; continue; }
      files.push({ rel: r, size }); total += Math.min(size, LIMITS.fileBytes);
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files, skipped, truncated, total };
}

function tree(paths, max = 80) {
  const lines = [];
  const dirs = new Map();
  for (const p of paths) { const parts = p.split('/'); const top = parts.length > 1 ? parts[0] + '/' : parts[0]; dirs.set(top, (dirs.get(top) || 0) + 1); }
  for (const [name, n] of [...dirs].sort()) { if (lines.length >= max) { lines.push(`… and ${dirs.size - max} more`); break; } lines.push(name.endsWith('/') ? `${name} (${n} file${n === 1 ? '' : 's'})` : name); }
  return lines.join('\n');
}

function saveIndex(dataDir, source, docs) {
  const dir = dirFor(dataDir, source.id);
  fs.mkdirSync(dir, { recursive: true });
  const chunks = docs.flatMap(d => chunk(d.path, d.text));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ id: source.id, docs: docs.map(d => ({ path: d.path, chars: d.text.length })), chunks }));
  source.fileCount = docs.length; source.chunkCount = chunks.length; source.chars = docs.reduce((n, d) => n + d.text.length, 0);
  return chunks;
}

function readIndex(dataDir, id) { try { return JSON.parse(fs.readFileSync(path.join(dirFor(dataDir, id), 'index.json'), 'utf8')); } catch (_) { return null; } }

async function indexFolder(root, job, label) {
  const walkStep = job.step('Looking through ' + label);
  const w = walk(root, job.signal);
  walkStep.done(`${w.files.length} file${w.files.length === 1 ? '' : 's'}${w.truncated ? ' (limit reached; the rest were left out)' : ''}${w.skipped.length ? `, skipped ${w.skipped.slice(0, 6).join(', ')}${w.skipped.length > 6 ? '…' : ''}` : ''}`);
  const readStep = job.step('Reading files', `0 of ${w.files.length}`);
  const docs = []; const unread = [];
  for (let i = 0; i < w.files.length; i++) {
    if (job.signal.aborted) throw error('Cancelled', 499);
    const f = w.files[i];
    try {
      const { text, note } = await extractText(path.join(root, f.rel), f.rel);
      if (text && text.trim()) docs.push({ path: f.rel, text: text.slice(0, LIMITS.fileBytes) }); else unread.push(f.rel + (note ? ` (${note})` : ''));
    } catch (e) { unread.push(f.rel); }
    if (i % 25 === 0) readStep.update({ detail: `${i + 1} of ${w.files.length}: ${f.rel}` });
  }
  readStep.done(`${docs.length} read as text${unread.length ? `, ${unread.length} left out (binary or unsupported)` : ''}`);
  return { docs, paths: w.files.map(f => f.rel), truncated: w.truncated };
}

/* ------------------------------------------------------------------ adding */

function canonicalDir(p) {
  const raw = String(p || '').trim().replace(/^~(?=$|\/)/, os.homedir());
  if (!raw || !path.isAbsolute(raw)) throw error('Give the full folder path, for example ~/Documents/Scripts.');
  const real = fs.realpathSync.native(raw);
  if (!fs.statSync(real).isDirectory()) throw error('That is a file, not a folder. Use Add file for single files.');
  if ([path.parse(real).root, os.homedir()].includes(real)) throw error('Choose a project folder, not your whole disk or home folder.');
  return real;
}

function normaliseUrl(u) {
  let url;
  try { url = new URL(String(u || '').trim()); } catch (_) { throw error('That does not look like a web address. Start it with https://'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw error('Only http:// and https:// addresses can be added.');
  return url;
}

function gitTarget(u) {
  const s = String(u || '').trim();
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(s)) return { remote: true, url: s, name: s.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop() || 'repo' };
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return { remote: true, url: `https://github.com/${s}.git`, name: s.split('/')[1] }; // owner/repo shorthand
  const local = s.replace(/^~(?=$|\/)/, os.homedir());
  if (path.isAbsolute(local) && fs.existsSync(path.join(local, '.git'))) return { remote: false, url: fs.realpathSync.native(local), name: path.basename(local) };
  throw error('Give a git address (https://github.com/owner/repo, git@…, or owner/repo) or the full path of a local repository.');
}

/**
 * Starts adding a source. Returns the saved record at once (status "reading");
 * the work continues as an activity job and updates the record when done.
 * input: {sessionId, kind, path?, url?, name?, file? (Buffer)}
 */
function add(store, dataDir, activity, input) {
  const kind = String(input.kind || '');
  if (!KINDS.includes(kind)) throw error('Unknown source kind. Use file, folder, url or git.');
  if (!input.sessionId) throw error('Open a conversation first.');
  const id = newId();
  let label, origin;
  if (kind === 'folder') { origin = canonicalDir(input.path); label = path.basename(origin); }
  else if (kind === 'url') { const u = normaliseUrl(input.url); origin = u.href; label = u.hostname + (u.pathname.length > 1 ? u.pathname.replace(/\/$/, '') : ''); if (!webAccessOn(store)) throw error('Reading web pages needs network access. Turn on Settings > Privacy > Allow network access, then try again.', 403); }
  else if (kind === 'git') { const g = gitTarget(input.url || input.path); origin = g.url; label = g.name; if (g.remote && !webAccessOn(store)) throw error('Cloning a repository needs network access. Turn on Settings > Privacy > Allow network access, then try again.', 403); }
  else { if (!Buffer.isBuffer(input.file) || !input.file.length) throw error('The file was empty.'); label = path.basename(String(input.name || 'file')).slice(0, 160); origin = label; if (input.file.length > 60 * 1024 * 1024) throw error('Files over 60 MB cannot be added to a conversation.', 413); }
  const source = { id, sessionId: String(input.sessionId), kind, label: label.slice(0, 160), origin, status: 'reading', createdAt: now(), fileCount: 0, chunkCount: 0, chars: 0, summary: '', error: null, jobId: null };
  const verb = { file: 'Reading ' + label, folder: 'Reading the folder ' + label, url: 'Reading ' + label, git: 'Cloning ' + label }[kind];
  const job = activity.start({ kind: 'source', title: verb, sessionId: source.sessionId });
  source.jobId = job.id;
  store.put('chatSources', source);
  const finish = (fields) => { const cur = store.get('chatSources', id); if (!cur) return; store.put('chatSources', { ...cur, ...fields, updatedAt: now() }); };
  (async () => {
    try {
      let docs = [], paths = [], extra = '';
      if (kind === 'file') {
        const dir = dirFor(dataDir, id); fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'original' + (path.extname(label) || ''));
        fs.writeFileSync(file, input.file);
        const s = job.step('Reading ' + label, human(input.file.length));
        const { text, note } = await extractText(file, label);
        if (!text || !text.trim()) throw error(note || 'No readable text in this file.');
        docs = [{ path: label, text: text.slice(0, LIMITS.fileBytes * 4) }]; paths = [label];
        s.done(`${text.length.toLocaleString()} characters`);
      } else if (kind === 'folder') {
        ({ docs, paths } = await indexFolder(origin, job, label));
        if (!docs.length) throw error('No readable text files in this folder.');
        extra = home(origin);
      } else if (kind === 'url') {
        const s = job.step('Fetching ' + origin);
        const res = await fetch(origin, { signal: AbortSignal.any([job.signal, AbortSignal.timeout(25000)]), redirect: 'follow', headers: { 'User-Agent': 'NOVA-Runtime/1.0 (local assistant)', Accept: 'text/html,text/plain,application/pdf,*/*;q=0.5' } });
        if (!res.ok) throw error(`The site answered ${res.status} ${res.statusText}.`);
        const type = String(res.headers.get('content-type') || '');
        const buf = Buffer.from(await res.arrayBuffer()).subarray(0, LIMITS.urlBytes);
        s.done(`${human(buf.length)} · ${type.split(';')[0] || 'unknown type'}`);
        const r = job.step('Pulling out the readable text');
        let text, title = '';
        if (type.includes('pdf') || /\.pdf($|\?)/i.test(origin)) {
          const dir = dirFor(dataDir, id); fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, 'page.pdf'); fs.writeFileSync(f, buf);
          ({ text } = await extractText(f, 'page.pdf'));
        } else if (type.includes('html') || /^\s*</.test(buf.subarray(0, 200).toString())) { ({ title, text } = htmlToText(buf.toString('utf8'))); }
        else text = buf.toString('utf8');
        if (!text || !text.trim()) throw error('No readable text on that page (it may need JavaScript or a sign-in).');
        if (title) source.label = title.slice(0, 160);
        docs = [{ path: origin, text }]; paths = [origin];
        r.done(`${text.length.toLocaleString()} characters${title ? ` · “${title.slice(0, 80)}”` : ''}`);
      } else if (kind === 'git') {
        const git = which('git'); if (!git) throw error('git is not installed.');
        const g = gitTarget(origin);
        let repo = origin;
        if (g.remote) {
          const s = job.step('Cloning ' + origin, 'latest commit only');
          repo = path.join(dirFor(dataDir, id), 'repo'); fs.mkdirSync(path.dirname(repo), { recursive: true });
          await run(git, ['clone', '--depth', '1', '--single-branch', '--no-tags', origin, repo], { timeout: LIMITS.gitTimeoutMs, env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' }, signal: job.signal });
          s.done('Cloned');
        }
        const info = job.step('Reading the history');
        const log = await run(git, ['-C', repo, 'log', '-8', '--date=short', '--pretty=%h %ad %an: %s'], { timeout: 15000 }).catch(() => '');
        const branch = (await run(git, ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 8000 }).catch(() => '')).trim();
        info.done(branch ? 'Branch ' + branch : '');
        ({ docs, paths } = await indexFolder(repo, job, g.name));
        if (!docs.length) throw error('No readable text files in this repository.');
        extra = `${g.remote ? origin : home(origin)}${branch ? ' · branch ' + branch : ''}\nRecent commits:\n${log.trim()}`;
        if (g.remote) source.localPath = repo;
      }
      const idx = job.step('Getting it ready to use in answers');
      saveIndex(dataDir, source, docs);
      const exts = {};
      for (const p of paths) { const e = extOf(p) || 'other'; exts[e] = (exts[e] || 0) + 1; }
      const topExt = Object.entries(exts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([e, n]) => `${n} .${e}`).join(', ');
      source.summary = [extra, paths.length > 1 ? `${docs.length} files read (${topExt}).\n${tree(paths)}` : ''].filter(Boolean).join('\n');
      idx.done(`${source.chunkCount} passage${source.chunkCount === 1 ? '' : 's'}`);
      finish({ status: 'ready', label: source.label, summary: source.summary, fileCount: source.fileCount, chunkCount: source.chunkCount, chars: source.chars, localPath: source.localPath || null });
      job.done({ sourceId: id });
    } catch (e) {
      finish({ status: job.signal.aborted ? 'cancelled' : 'failed', error: job.signal.aborted ? 'Cancelled' : e.message });
      job.fail(e);
    }
  })();
  return source;
}

function list(store, sessionId) { return store.all('chatSources').filter(s => !sessionId || s.sessionId === sessionId).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))); }

function remove(store, dataDir, id) {
  const s = store.get('chatSources', id);
  if (!s) throw error('Unknown source.', 404);
  store.delete('chatSources', id);
  fs.rmSync(dirFor(dataDir, id), { recursive: true, force: true }); // only NOVA's own copy; a folder source is never touched
  return { ok: true };
}

function files(dataDir, id) { const idx = readIndex(dataDir, id); return idx ? idx.docs : []; }

/* --------------------------------------------------------------- selecting */

function terms(q) { return [...new Set(String(q || '').toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) || [])].filter(t => !STOP.has(t)).slice(0, 30); }
const STOP = new Set(['the', 'and', 'for', 'are', 'with', 'this', 'that', 'what', 'how', 'can', 'you', 'your', 'from', 'about', 'into', 'have', 'has', 'was', 'were', 'will', 'would', 'should', 'could', 'please', 'tell', 'show', 'give', 'make', 'does', 'did', 'there', 'their', 'them', 'they', 'which', 'when', 'where', 'why', 'who', 'all', 'any', 'some', 'our', 'out', 'use', 'using']);

/**
 * Context for one reply: an overview of every ready source in the session and
 * the passages that best match the question, within `budget` characters.
 * Returns {text, used:[{sourceId,label,path,line}], sources}.
 */
function contextFor(store, dataDir, { sessionId, query, budget = 12000, sourceIds = null }) {
  const sources = list(store, sessionId).filter(s => s.status === 'ready' && (!sourceIds || sourceIds.includes(s.id)));
  if (!sources.length) return { text: '', used: [], sources: [] };
  const parts = []; const used = [];
  let left = budget;
  const overview = sources.map(s => `[${s.kind}] ${s.label}${s.kind === 'url' ? ' — ' + s.origin : ''}\n${(s.summary || '').slice(0, 900)}`).join('\n\n');
  parts.push('Sources added to this conversation:\n' + overview.slice(0, Math.floor(budget * 0.3)));
  left -= parts[0].length;
  const all = [];
  for (const s of sources) { const idx = readIndex(dataDir, s.id); if (idx) for (const c of idx.chunks) all.push({ ...c, sourceId: s.id, label: s.label }); }
  const totalChars = all.reduce((n, c) => n + c.text.length, 0);
  let picked;
  if (totalChars <= left) picked = all;
  else {
    const t = terms(query);
    const df = new Map();
    for (const w of t) df.set(w, all.filter(c => (c.path + ' ' + c.text).toLowerCase().includes(w)).length);
    const scored = all.map((c, i) => {
      const hay = (c.path + ' ' + c.text).toLowerCase();
      let score = 0;
      for (const w of t) { const n = hay.split(w).length - 1; if (n) score += (1 + Math.log(n)) * Math.log(1 + all.length / (df.get(w) || 1)) * (c.path.toLowerCase().includes(w) ? 2 : 1); }
      if (/readme|overview|index|main|summary/i.test(c.path) && c.line === 1) score += 0.5; // a good default when the question is general
      return { c, score, i };
    }).sort((a, b) => b.score - a.score || a.i - b.i);
    picked = [];
    for (const { c } of scored) { if (c.text.length + 80 > left) continue; picked.push(c); left -= c.text.length + 80; if (left < 400) break; }
  }
  if (picked.length) {
    parts.push('Passages from those sources (cite them by file path):\n' + picked.map(c => `--- ${c.label}: ${c.path}${c.line > 1 ? ' (from line ' + c.line + ')' : ''}\n${c.text}`).join('\n'));
    for (const c of picked) used.push({ sourceId: c.sourceId, label: c.label, path: c.path, line: c.line });
  }
  return { text: parts.join('\n\n'), used, sources };
}

/** Folders the conversation has added: computer tools may work inside them. */
function folderRoots(store, sessionId) {
  return list(store, sessionId).filter(s => (s.kind === 'folder' || (s.kind === 'git' && !s.localPath)) && s.status !== 'failed').map(s => s.origin)
    .concat(list(store, sessionId).filter(s => s.kind === 'git' && s.localPath).map(s => s.localPath));
}

module.exports = { add, list, remove, files, contextFor, folderRoots, extractText, htmlToText, walk, chunk, terms, gitTarget, LIMITS, KINDS };
