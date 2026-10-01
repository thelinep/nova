'use strict';
/* ===========================================================================
 * Support report
 *
 * Gathers what someone helping with a NOVA problem needs — versions, engine
 * status, record counts and recent failures — without private content: no
 * chats, documents, prompts, media or credentials. The home folder is shown
 * as ~ and anything that looks like a token is masked. The server log tail is
 * only included when asked for.
 *
 * Every dependency is passed in, so tests can build a report from a temporary
 * data folder and fake engines.
 * ========================================================================= */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOG_NAME = 'nova-runtime-server.log';

function redact(text) {
  const home = os.homedir();
  let out = String(text == null ? '' : text);
  if (home && home.length > 1) out = out.split(home).join('~');
  return out
    .replace(/\b(sk|pk|rk|ghp|gho|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\b(Bearer|token|api[_-]?key|password|secret)(["'\s:=]+)[^\s"',;]{6,}/gi, '$1$2[redacted]');
}

function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve().then(() => promise).catch(e => ({ ...fallback, error: e.message })),
    new Promise(resolve => { timer = setTimeout(() => resolve({ ...fallback, error: `no answer within ${ms / 1000} s` }), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function fileSize(file) { try { return fs.statSync(file).size; } catch (_) { return null; } }

function human(bytes) {
  if (bytes == null) return 'unknown';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function macVersion() {
  if (process.platform !== 'darwin') return null;
  try { return require('node:child_process').execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 2000 }).trim(); } catch (_) { return null; }
}

function logTail(dataDir, lines = 80) {
  const file = path.join(dataDir, LOG_NAME);
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return redact(buf.toString('utf8').split('\n').slice(-lines).join('\n').trim());
  } catch (_) { return null; }
}

/**
 * deps: { store, storeNames, dataDir, version, ollamaStatus, imageStatus, audioStatus, transcribeStatus, libraryInfo }
 * The *Status entries are functions (sync or async); each gets 4 seconds.
 */
async function buildReport(deps, options = {}) {
  const { store, storeNames = [], dataDir } = deps;
  const counts = {};
  for (const name of storeNames) { try { counts[name] = store.all(name).length; } catch (_) { counts[name] = null; } }

  const [ollama, image, audio, transcribe] = await Promise.all([
    withTimeout(deps.ollamaStatus ? deps.ollamaStatus() : { reachable: false }, 4000, { reachable: false }),
    withTimeout(deps.imageStatus ? deps.imageStatus() : { reachable: false }, 4000, { reachable: false }),
    withTimeout(deps.audioStatus ? deps.audioStatus() : {}, 4000, {}),
    withTimeout(deps.transcribeStatus ? deps.transcribeStatus() : { ready: false }, 4000, { ready: false }),
  ]);

  let mcp = [];
  try { mcp = store.all('mcpServers').map(s => ({ name: s.name || s.id, status: s.status || 'unknown' })); } catch (_) {}

  let failures = [];
  try {
    failures = store.all('executions')
      .filter(e => ['failed', 'error', 'rejected', 'blocked'].includes(String(e.status || '').toLowerCase()))
      .sort((a, b) => String(b.finishedAt || b.startedAt || '').localeCompare(String(a.finishedAt || a.startedAt || '')))
      .slice(0, 10)
      .map(e => ({ type: e.type || 'run', label: redact(String(e.label || '').slice(0, 80)), status: e.status, at: e.finishedAt || e.startedAt || null, error: redact(String(e.detail || '').slice(0, 300)) }));
  } catch (_) {}

  // Oversight: kill switch, coding qualification, background jobs, optional developer tools.
  const halted = (() => { try { return typeof store.getGlobalHalt === 'function' && store.getGlobalHalt() === '1'; } catch (_) { return false; } })();
  const resume = (() => { try { return require('./resume-passphrase').status(dataDir); } catch (_) { return { set: false }; } })();
  const qualified = (() => {
    try {
      const recs = store.all('modelQualifications');
      const installed = new Map((ollama.models || []).filter(m => m && m.digest).map(m => [m.digest, m.name || m.model]));
      return recs.filter(r => r.capabilities && Object.values(r.capabilities).length && ['single-file', 'clarification', 'timeout', 'cancellation'].every(c => r.capabilities[c] && r.capabilities[c].qualified))
        .map(r => ({ model: installed.get(r.digest) || r.modelId || 'model no longer installed', installed: installed.has(r.digest), full: Object.keys(r.capabilities).filter(c => r.capabilities[c].qualified).length === 6 }));
    } catch (_) { return []; }
  })();
  const jobs = (() => {
    const by = st => { try { return store.jobsListByState(st).length; } catch (_) { return null; } };
    return { queued: by('queued'), running: by('running'), failed: by('failed'), timedOut: by('timed_out') };
  })();
  const agentBrowser = (() => { try { return process.env.NOVA_BROWSER === '0' ? 'off' : require('./browser-service').available() ? 'ready' : 'missing'; } catch (_) { return 'missing'; } })();
  const dafny = (() => {
    const bin = process.env.NOVA_DAFNY_BIN || 'dafny';
    if (bin.includes('/')) return fs.existsSync(bin);
    for (const dir of (process.env.PATH || '').split(':').concat(['/opt/homebrew/bin', '/usr/local/bin'])) { try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return true; } catch (_) {} }
    return false;
  })();

  const library = (() => { try { return deps.libraryInfo ? deps.libraryInfo() : null; } catch (_) { return null; } })();
  const dbBytes = fileSize(path.join(dataDir, 'nova.db'));

  const checks = [
    { id: 'backend', label: 'NOVA Runtime backend', ok: true, detail: 'Answering on this computer', help: 'monitoring' },
    { id: 'ollama', label: 'Ollama', ok: Boolean(ollama.reachable), detail: ollama.reachable ? `${(ollama.models || []).length} model(s) installed` : 'Not reachable' + (ollama.error ? ' (' + ollama.error + ')' : '') + '. Start Ollama.', help: 'models' },
    { id: 'comfy', label: 'ComfyUI (images, songs, sound effects)', ok: Boolean(image.reachable), detail: image.reachable ? `${(image.checkpoints || []).length} image model(s)${image.device ? ' on ' + image.device : ''}` : 'Not running. Start ComfyUI for NOVA.', help: 'media-images' },
    { id: 'voice', label: 'Voice', ok: Boolean(audio.voice && audio.voice.ready), detail: audio.voice ? (audio.voice.kokoro && audio.voice.kokoro.ready ? 'Kokoro voices' : audio.voice.ready ? 'macOS voices' : 'No voice engine') : (audio.error || 'Unknown'), help: 'media-audio' },
    { id: 'transcribe', label: 'Transcription', ok: Boolean(transcribe.ready), detail: transcribe.ready ? (transcribe.modelName || 'Ready') : ((transcribe.missing || []).join('; ') || transcribe.error || 'Not set up'), help: 'media-audio' },
    { id: 'tools', label: 'Tool servers', ok: mcp.some(s => s.status === 'connected'), detail: mcp.length ? mcp.filter(s => s.status === 'connected').length + ' of ' + mcp.length + ' connected' : 'None configured', help: 'tools-approvals' },
    { id: 'qualified', label: 'Models qualified for coding', ok: qualified.some(q => q.installed), detail: qualified.filter(q => q.installed).length ? qualified.filter(q => q.installed).map(q => q.model + (q.full ? '' : ' (single-file only)')).join(', ') : 'None yet. Code plans need one: Models → Qualify for coding.', help: 'models' },
    { id: 'killswitch', label: 'Kill switch', ok: !halted, detail: halted ? 'NOVA is HALTED. Resume it in Workbench' + (resume.set ? '.' : ' (you will be asked to choose a resume passphrase).') : 'Clear' + (resume.set ? ', resume passphrase set' : ''), help: 'workbench' },
    { id: 'jobs', label: 'Background jobs', ok: !(jobs.failed || jobs.timedOut), detail: [jobs.queued + ' queued', jobs.running + ' running', jobs.failed + ' failed', jobs.timedOut + ' timed out'].join(', '), help: 'workbench' },
    { id: 'agentBrowser', label: 'Agent browser (optional)', ok: agentBrowser === 'ready', optional: true, detail: agentBrowser === 'ready' ? 'Playwright available' : agentBrowser === 'off' ? 'Turned off (NOVA_BROWSER=0)' : 'Not included in this copy of NOVA; only agents need it', help: 'agent-browser' },
    { id: 'dafny', label: 'Proof checker (optional)', ok: dafny, optional: true, detail: dafny ? 'Dafny installed' : 'Dafny not installed; only the correctness pipeline needs it', help: 'developer-preview' },
    (() => { const e = require('./ocr').engines(); return { id: 'ocr', label: 'Text in images', ok: e.length > 0, detail: e.length ? (e[0] === 'apple-vision' ? 'macOS text recognition' : e[0]) : 'Needs macOS or tesseract', help: 'conversation' }; })(),
    (() => { const b = require('./image-to-code').findBrowser(); return { id: 'browser', label: 'Page checking browser', ok: Boolean(b), detail: b ? require('node:path').basename(b) : 'Install Google Chrome to check pages built from images', help: 'conversation' }; })(),
  ].map(c => ({ ...c, detail: redact(c.detail) }));

  const report = {
    generatedAt: new Date().toISOString(),
    nova: { version: deps.version || 'unknown', mode: process.env.NOVA_DESKTOP ? 'desktop app' : 'server', pid: process.pid, uptimeSeconds: Math.round(process.uptime()) },
    system: { platform: process.platform, arch: process.arch, macOS: macVersion(), node: process.version, cpus: os.cpus().length, memoryGB: Math.round(os.totalmem() / 1073741824), freeMemoryGB: +(os.freemem() / 1073741824).toFixed(1) },
    data: { dataDir: redact(dataDir), databaseSize: human(dbBytes), libraryDir: library && library.dir ? redact(library.dir) : null, counts },
    engines: {
      ollama: { reachable: Boolean(ollama.reachable), models: (ollama.models || []).map(m => m.name || m.model || String(m)).slice(0, 30), error: ollama.reachable ? null : redact(ollama.error || '') },
      comfyui: { reachable: Boolean(image.reachable), version: image.version || null, device: image.device || null, imageModels: (image.checkpoints || []).length },
      voice: audio.voice ? { ready: Boolean(audio.voice.ready), kokoro: Boolean(audio.voice.kokoro && audio.voice.kokoro.ready) } : null,
      transcription: { ready: Boolean(transcribe.ready), model: transcribe.modelName || null, multilingual: Boolean(transcribe.multilingual), ffmpeg: Boolean(transcribe.ffmpeg), missing: (transcribe.missing || []).map(redact) },
      toolServers: mcp,
    },
    oversight: { halted, resumePassphraseSet: Boolean(resume.set), qualifiedModels: qualified, jobs, agentBrowser, dafny },
    checks,
    recentFailures: failures,
    logTail: options.includeLog ? logTail(dataDir) : null,
  };
  report.text = toText(report);
  return report;
}

function toText(r) {
  const L = [];
  L.push('NOVA support report', `Made ${r.generatedAt}`, '');
  L.push(`NOVA ${r.nova.version} (${r.nova.mode}), up ${Math.round(r.nova.uptimeSeconds / 60)} min`);
  L.push(`${r.system.macOS ? 'macOS ' + r.system.macOS : r.system.platform} ${r.system.arch}, Node ${r.system.node}, ${r.system.cpus} CPUs, ${r.system.memoryGB} GB memory (${r.system.freeMemoryGB} GB free)`);
  L.push(`Data: ${r.data.dataDir} (database ${r.data.databaseSize})${r.data.libraryDir ? ', library ' + r.data.libraryDir : ''}`, '');
  L.push('Checks');
  for (const c of r.checks) L.push(`  ${c.ok ? '[ok]  ' : c.optional ? '[--]  ' : '[fail]'} ${c.label}: ${c.detail}`);
  L.push('', 'Engines');
  L.push(`  Ollama models: ${r.engines.ollama.models.join(', ') || 'none'}`);
  L.push(`  ComfyUI: ${r.engines.comfyui.reachable ? `version ${r.engines.comfyui.version || '?'}, ${r.engines.comfyui.imageModels} image models` : 'not running'}`);
  L.push(`  Transcription: ${r.engines.transcription.ready ? r.engines.transcription.model + (r.engines.transcription.multilingual ? ' (multilingual)' : '') : 'missing ' + r.engines.transcription.missing.join('; ')}`);
  L.push(`  Tool servers: ${r.engines.toolServers.map(s => `${s.name} (${s.status})`).join(', ') || 'none'}`);
  L.push('', 'Records (counts only)');
  L.push('  ' + (Object.entries(r.data.counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'));
  L.push('', 'Recent failures');
  if (!r.recentFailures.length) L.push('  none');
  for (const f of r.recentFailures) L.push(`  ${f.at || '?'}  ${f.type}  ${f.label}${f.error ? ' — ' + f.error : ''}`);
  if (r.logTail) L.push('', 'Server log (last lines)', r.logTail);
  L.push('', 'What happened (fill in): ', 'What I expected: ', 'Steps to repeat: ');
  return L.join('\n');
}

/** Writes the report as a .txt file into <dir>/support and returns its path. */
function saveReport(report, dir) {
  const target = path.join(dir, 'support');
  fs.mkdirSync(target, { recursive: true });
  const stamp = report.generatedAt.replace(/[:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const file = path.join(target, `nova-support-${stamp}.txt`);
  fs.writeFileSync(file, report.text);
  return file;
}

module.exports = { buildReport, saveReport, redact, toText, logTail, LOG_NAME };
