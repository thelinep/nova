'use strict';
/* ===========================================================================
 * ComfyUI manager
 *
 * NOVA starts ComfyUI when it is needed (or at launch, if chosen), stops it
 * when NOVA quits, restarts it if it crashes, and can stop it after a quiet
 * spell to give the memory back. ComfyUI stays where the installer put it
 * (~/ComfyUI by default) with its models; it is not copied into the app.
 *
 * An already running ComfyUI (started by hand, or the ComfyUI Desktop app)
 * is used as it is and never stopped by NOVA.
 *
 * Settings live in preferences id 'comfy':
 *   { autoStart: true, startWithNova: false, idleMinutes: 0, dir: null }
 * ========================================================================= */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 8188;
const DESKTOP_APP = '/Applications/ComfyUI.app';
const LOG_NAME = 'comfyui.log';
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const READY_TIMEOUT_MS = 180 * 1000;

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
const now = () => new Date().toISOString();

let deps = { store: null, dataDir: null, imageGen: null, activity: null, spawnImpl: spawn, fetchImpl: (...a) => fetch(...a), platform: process.platform, port: PORT, scriptsDir: path.join(__dirname, '..', 'scripts') };
let state = 'stopped';        // stopped | starting | ready | external | failed | installing
let child = null, wanted = false, lastError = null, startedAt = null, readyAt = null, lastUsed = 0;
let restarts = [], startPromise = null, idleTimer = null, installJob = null, logStream = null;

function port() { return deps.port || PORT; }
function urlBase() { return `http://127.0.0.1:${port()}`; }
function configure(input) { deps = { ...deps, ...input }; return module.exports; }
function prefs() {
  const p = (deps.store && deps.store.get('preferences', 'comfy')) || {};
  return { autoStart: p.autoStart !== false, startWithNova: Boolean(p.startWithNova), idleMinutes: Math.max(0, Number(p.idleMinutes) || 0), dir: p.dir || null };
}
function setPrefs(input = {}) {
  const cur = prefs();
  const next = { id: 'comfy', ...cur };
  if ('autoStart' in input) next.autoStart = Boolean(input.autoStart);
  if ('startWithNova' in input) next.startWithNova = Boolean(input.startWithNova);
  if ('idleMinutes' in input) { const n = Number(input.idleMinutes); if (!Number.isFinite(n) || n < 0 || n > 24 * 60) throw error('Idle minutes must be 0 (never) to 1440.'); next.idleMinutes = Math.round(n); }
  if ('dir' in input) next.dir = input.dir ? path.resolve(String(input.dir).replace(/^~(?=$|\/)/, os.homedir())) : null;
  deps.store.put('preferences', next);
  scheduleIdle();
  return status();
}
function comfyDir() { return prefs().dir || process.env.COMFY_DIR || path.join(os.homedir(), 'ComfyUI'); }
function python(dir) { return path.join(dir, '.venv', 'bin', 'python'); }
function installed(dir = comfyDir()) { return fs.existsSync(path.join(dir, 'main.py')) && fs.existsSync(python(dir)); }
function desktopApp() { return deps.platform === 'darwin' && fs.existsSync(DESKTOP_APP); }
function logFile() { return path.join(deps.dataDir || os.tmpdir(), LOG_NAME); }
function installer() { const f = path.join(deps.scriptsDir, 'install-comfyui-mac.sh'); return fs.existsSync(f) ? f : null; }

async function reachable(base) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 1500);
  try { const r = await deps.fetchImpl(base + '/system_stats', { signal: c.signal }); return r.ok; } catch (_) { return false; } finally { clearTimeout(t); }
}
/** Is any ComfyUI answering (NOVA's own, a manual one, or the Desktop app)? */
async function findRunning() {
  if (process.env.COMFYUI_URL) return (await reachable(process.env.COMFYUI_URL.replace(/\/$/, ''))) ? process.env.COMFYUI_URL : null;
  for (const base of [urlBase(), ...(port() === PORT ? ['http://127.0.0.1:8000'] : [])]) if (await reachable(base)) return base;
  return null;
}

function logTail(lines = 60) {
  try { const t = fs.readFileSync(logFile(), 'utf8'); return t.split('\n').slice(-lines).join('\n').trim(); } catch (_) { return ''; }
}
function status() {
  const p = prefs();
  return {
    state, managed: Boolean(child), pid: child ? child.pid : null, url: state === 'ready' || state === 'external' ? (process.env.COMFYUI_URL || urlBase()) : null,
    dir: comfyDir(), installed: installed(), desktopApp: desktopApp(), installer: Boolean(installer()) && deps.platform === 'darwin',
    startedAt, readyAt, lastError, restartsInWindow: restarts.length, installJobId: installJob ? installJob.id : null, ...p,
  };
}

function openLog() {
  try { fs.mkdirSync(path.dirname(logFile()), { recursive: true }); } catch (_) {}
  if (logStream) { try { logStream.end(); } catch (_) {} }
  logStream = fs.createWriteStream(logFile(), { flags: 'a' });
  logStream.write(`\n==== ${now()} Maataa starts ComfyUI ====\n`);
  return logStream;
}

/** Starts ComfyUI if nothing is answering; resolves when it is ready. */
async function start({ reason = 'requested' } = {}) {
  if (startPromise) return startPromise;
  startPromise = (async () => {
    const running = await findRunning();
    if (running) {
      if (!child) { state = 'external'; readyAt = readyAt || now(); }
      else state = 'ready';
      lastError = null; touch(); return status();
    }
    if (process.env.NOVA_COMFY_AUTOSTART === '0') { lastError = 'Starting ComfyUI is turned off for this Maataa (NOVA_COMFY_AUTOSTART=0).'; throw error(lastError, 503); }
    if (process.env.COMFYUI_URL) { let p = null; try { p = Number(new URL(process.env.COMFYUI_URL).port || 80); } catch (_) {} if (p !== port()) { lastError = `COMFYUI_URL points to ${process.env.COMFYUI_URL}, so Maataa does not start its own ComfyUI. Start that one, or remove COMFYUI_URL.`; throw error(lastError, 503); } }
    const dir = comfyDir();
    if (!installed(dir)) {
      if (desktopApp()) return startDesktop();
      state = 'failed'; lastError = `ComfyUI is not installed in ${dir}. Install it from Settings > Image engine, or choose its folder.`;
      throw error(lastError, 412);
    }
    wanted = true; state = 'starting'; startedAt = now(); readyAt = null; lastError = null;
    const log = openLog(); log.write(`reason: ${reason}\nfolder: ${dir}\n`);
    const args = [path.join(__dirname, 'comfy-watchdog.js'), String(process.pid), python(dir), 'main.py', '--listen', '127.0.0.1', '--port', String(port())];
    child = deps.spawnImpl(process.execPath, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    const mine = child;
    if (child.stdout) child.stdout.on('data', d => log.write(d));
    if (child.stderr) child.stderr.on('data', d => log.write(d));
    child.on('exit', (code, signal) => onExit(mine, code, signal));
    child.on('error', e => { log.write('could not start: ' + e.message + '\n'); });
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child !== mine) throw error(lastError || 'ComfyUI stopped while starting. See its log in Settings > Image engine.', 503);
      if (await reachable(urlBase())) { state = 'ready'; readyAt = now(); touch(); if (deps.imageGen && deps.imageGen.discover) await deps.imageGen.discover().catch(() => {}); return status(); }
      await new Promise(r => setTimeout(r, 400));
    }
    lastError = 'ComfyUI did not answer within 3 minutes. See its log in Settings > Image engine.';
    await stop({ reason: 'did not start' }); state = 'failed';
    throw error(lastError, 504);
  })().finally(() => { startPromise = null; });
  return startPromise;
}

async function startDesktop() {
  state = 'starting'; startedAt = now();
  await new Promise(resolve => { const p = deps.spawnImpl('/usr/bin/open', ['-g', '-a', DESKTOP_APP], { stdio: 'ignore' }); p.on('exit', resolve); p.on('error', resolve); });
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await findRunning()) { state = 'external'; readyAt = now(); touch(); if (deps.imageGen && deps.imageGen.discover) await deps.imageGen.discover().catch(() => {}); return status(); }
    await new Promise(r => setTimeout(r, 1500));
  }
  state = 'failed'; lastError = 'The ComfyUI app did not finish starting within 3 minutes.';
  throw error(lastError, 504);
}

function onExit(which, code, signal) {
  if (which !== child) return;
  child = null;
  if (logStream) logStream.write(`\n==== ${now()} ComfyUI exited (${signal || code}) ====\n`);
  if (!wanted) { state = 'stopped'; return; }
  // It stopped without being asked: restart it, but not in a loop.
  const t = Date.now(); restarts = restarts.filter(x => t - x < RESTART_WINDOW_MS);
  const tail = logTail(8);
  if (restarts.length >= MAX_RESTARTS) { wanted = false; state = 'failed'; lastError = `ComfyUI stopped ${MAX_RESTARTS} times in 10 minutes, so Maataa stopped restarting it.` + (tail ? ' Last lines of its log:\n' + tail : ''); return; }
  restarts.push(t);
  state = 'starting'; lastError = 'ComfyUI stopped unexpectedly; restarting.';
  setTimeout(() => { if (wanted && !child) start({ reason: 'restart after crash' }).catch(() => {}); }, 2000);
}

/** Stops ComfyUI if NOVA started it. A ComfyUI started elsewhere is left alone. */
async function stop({ reason = 'requested' } = {}) {
  wanted = false;
  clearTimeout(idleTimer);
  const c = child;
  if (!c) { if (state !== 'external') state = 'stopped'; return status(); }
  if (logStream) logStream.write(`\n==== ${now()} Maataa stops ComfyUI (${reason}) ====\n`);
  await new Promise(resolve => {
    const done = setTimeout(() => { try { c.kill('SIGKILL'); } catch (_) {} resolve(); }, 10000);
    c.once('exit', () => { clearTimeout(done); resolve(); });
    try { c.kill('SIGTERM'); } catch (_) { clearTimeout(done); resolve(); }
  });
  child = null; state = 'stopped'; readyAt = null;
  return status();
}

async function restart() { await stop({ reason: 'restart' }); return start({ reason: 'restart' }); }

/** Records use, so an idle timer can stop NOVA's own ComfyUI after a quiet spell. */
function touch() { lastUsed = Date.now(); scheduleIdle(); }
function scheduleIdle() {
  clearTimeout(idleTimer);
  const mins = prefs().idleMinutes;
  if (!mins || !child) return;
  idleTimer = setTimeout(() => {
    if (child && Date.now() - lastUsed >= mins * 60000 && !busy()) stop({ reason: `idle for ${mins} min` }).catch(() => {});
    else scheduleIdle();
  }, mins * 60000);
  if (idleTimer.unref) idleTimer.unref();
}
function busy() { try { return (deps.store.all('generationJobs') || []).some(j => j.status === 'running' || j.status === 'queued'); } catch (_) { return false; } }

/** Called before a media job: starts ComfyUI when allowed, otherwise explains. */
async function ensure() {
  if (await findRunning()) { if (!child && state !== 'external') { state = 'external'; readyAt = readyAt || now(); } touch(); return status(); }
  if (!prefs().autoStart) throw error('ComfyUI is not running. Start it in Settings > Image engine, or turn on "Start ComfyUI when needed".', 503);
  return start({ reason: 'a media job needs it' });
}

/** Runs the installer as an Activity job; the log streams into the job's steps. */
function install({ withVideo = false } = {}) {
  if (deps.platform !== 'darwin') throw error('The ComfyUI installer is for macOS on Apple Silicon.', 501);
  const script = installer(); if (!script) throw error('The installer is missing from this copy of Maataa.', 500);
  if (installJob) throw error('ComfyUI is already being installed. Follow it in Activity.', 409);
  const job = deps.activity.start({ kind: 'install', title: 'Installing ComfyUI for Maataa' });
  installJob = job; state = 'installing'; lastError = null;
  const log = openLog(); log.write('installing\n');
  const p = deps.spawnImpl('/bin/bash', [script, ...(withVideo ? [] : ['--no-wan'])], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, COMFY_DIR: comfyDir() } });
  let step = job.step('Preparing', comfyDir());
  const onData = d => {
    log.write(d);
    for (const line of String(d).split('\n')) {
      const m = /==\s*(.+?)\s*(\x1b\[0m)?$/.exec(line.replace(/\x1b\[1m/g, ''));
      if (m && /^\S/.test(m[1])) { step.done(); step = job.step(m[1].replace(/\x1b\[[0-9;]*m/g, '')); }
    }
  };
  p.stdout.on('data', onData); p.stderr.on('data', onData);
  job.signal.addEventListener('abort', () => { try { p.kill('SIGTERM'); } catch (_) {} });
  p.on('exit', code => {
    installJob = null;
    if (code === 0 && installed()) { step.done(); state = 'stopped'; job.done('ComfyUI is installed in ' + comfyDir()); }
    else { state = 'failed'; lastError = 'The installer stopped (' + code + '). ' + logTail(6); step.fail(lastError); job.fail(new Error(lastError)); }
  });
  return { jobId: job.id };
}

async function boot() {
  // Adopt a ComfyUI that is already running; otherwise start one if asked to.
  if (await findRunning()) { state = 'external'; readyAt = now(); return; }
  if (prefs().startWithNova && (installed() || desktopApp())) start({ reason: 'start with Maataa' }).catch(() => {});
}

async function shutdown() { await stop({ reason: 'Maataa is quitting' }); if (logStream) { try { logStream.end(); } catch (_) {} } }
function _reset() { state = 'stopped'; child = null; wanted = false; lastError = null; restarts = []; startPromise = null; installJob = null; clearTimeout(idleTimer); }

module.exports = { configure, prefs, setPrefs, status, start, stop, restart, ensure, install, boot, shutdown, touch, logTail, findRunning, installed, comfyDir, _reset, PORT };
