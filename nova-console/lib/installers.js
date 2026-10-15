'use strict';
/* ===========================================================================
 * Maataa Install page: every optional component in one place.
 *
 * For each component it reports whether it is installed (from the same files
 * and checks the rest of Maataa uses), how much it downloads, how much free
 * disk it needs, and whether this Mac can use it; and it installs on a click:
 *   - Ollama models through Ollama's own /api/pull, with progress;
 *   - ComfyUI and the AAI engine through their existing in-app installers;
 *   - everything else by running the same scripts the brahmini launchers run
 *     (nova-console/scripts/*.sh), as one Activity job with a log under
 *     DATA_DIR/installs/<id>.log.
 * One install runs at a time. Nothing is removed by this module, and nothing
 * starts without a person pressing Install.
 * ========================================================================= */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const REPO = path.join(__dirname, '..', '..');           // the brahmini checkout, when Maataa runs from it
const TENSOR_VIEW_SRC = path.join(__dirname, '..', 'comfy', 'nova_tensor_view');
const CODING_MODELS = ['qwen2.5:7b', 'qwen2.5-coder:7b'];

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
const exists = p => { try { return fs.existsSync(p); } catch (_) { return false; } };
const sizeOf = p => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
const nonEmpty = p => sizeOf(p) > 0 && !exists(p + '.part');

function createInstallers(deps) {
  const { dataDir, ollama, comfyManager, activity, aai, audioGen, ltx, transcribe, browserService, store } = deps;
  const spawnImpl = deps.spawnImpl || spawn;
  const fetchImpl = deps.fetchImpl || ((url, o) => globalThis.fetch(url, { ...o, redirect: 'error' }));
  const platform = deps.platform || process.platform;
  const freeGb = deps.freeGb || (() => { try { const s = fs.statfsSync(os.homedir()); return Math.floor(s.bavail * s.bsize / 1e9); } catch (_) { return null; } });
  const totalGb = () => Math.round(os.totalmem() / 1e9);
  let running = null;               // { id, jobId, child?, controller? }
  const results = {};               // id -> { at, ok, message }

  const comfyDir = () => comfyManager.comfyDir();
  const model = (...p) => path.join(comfyDir(), 'models', ...p);
  const qualificationFor = async name => {
    try {
      const st = await ollama.status();
      const tag = (st.models || []).find(m => m.name === name);
      if (!tag) return { installed: false };
      const rec = store.all('modelQualifications').find(r => String(r.digest || '').replace(/^sha256:/, '') === String(tag.digest || '').replace(/^sha256:/, ''));
      const caps = rec ? Object.entries(rec.capabilities || {}).filter(([, v]) => v && v.qualified).map(([k]) => k) : [];
      return { installed: true, qualified: caps, ready: ['multi-file', 'clarification', 'timeout', 'cancellation'].every(c => caps.includes(c)) };
    } catch (_) { return { installed: false }; }
  };

  /** The catalogue. `check` returns { state: installed|partial|missing|unavailable, detail } */
  const COMPONENTS = [
    { id: 'ollama', group: 'Core', label: 'Ollama', what: 'Runs the local language models.', sizeGb: 0.5, needGb: 1,
      install: { kind: 'link', url: 'https://ollama.com/download' },
      check: async () => { const s = await ollama.status(); return s.reachable ? { state: 'installed', detail: `${(s.models || []).length} model(s)` } : { state: exists('/Applications/Ollama.app') ? 'partial' : 'missing', detail: exists('/Applications/Ollama.app') ? 'Installed but not running: open the Ollama app.' : 'Not installed.' }; } },
    ...CODING_MODELS.map(name => ({ id: 'model-' + name.replace(/[^a-z0-9]+/gi, '-'), group: 'Core', label: name, what: name === 'qwen2.5:7b' ? 'General local model; can also plan code once it passes the coding checks.' : 'Coding model (Apache-2.0). Must pass the coding checks before it writes code.', sizeGb: 4.7, needGb: 7, requires: 'ollama',
      install: { kind: 'pull', model: name },
      check: async () => { const q = await qualificationFor(name); if (!q.installed) return { state: 'missing', detail: 'Not downloaded.' }; return { state: 'installed', detail: q.ready ? 'Passed the coding checks for multi-file work.' : q.qualified.length ? `Coding checks passed: ${q.qualified.join(', ')}.` : 'Coding checks not run yet.', qualify: !q.ready }; } })),
    { id: 'comfyui', group: 'Images', label: 'ComfyUI + SDXL', what: 'The image engine and its base image model.', sizeGb: 13, needGb: 15,
      install: { kind: 'comfy' },
      check: async () => { if (!comfyManager.installed()) return { state: 'missing', detail: 'Not installed (' + comfyDir() + ').' }; return sizeOf(model('checkpoints', 'sd_xl_base_1.0.safetensors')) >= 6e9 ? { state: 'installed', detail: comfyDir() } : { state: 'partial', detail: 'ComfyUI is installed; the SDXL model is missing. Install again to finish.' }; } },
    { id: 'upscale', group: 'Images', label: 'Upscale model (Real-ESRGAN x4)', what: 'For the Upscale action on images.', sizeGb: 0.07, needGb: 1, requires: 'comfyui',
      install: { kind: 'script', script: 'add-upscale-model-mac.sh' },
      check: async () => (nonEmpty(model('upscale_models', 'RealESRGAN_x4plus.pth')) ? { state: 'installed' } : { state: 'missing' }) },
    { id: 'tensor-view', group: 'Images', label: 'Tensor view add-on', what: 'Shows ComfyUI\'s live latents (also for audio) in Maataa.', sizeGb: 0, needGb: 0, requires: 'comfyui',
      install: { kind: 'symlink' },
      check: async () => { const dest = path.join(comfyDir(), 'custom_nodes', 'nova_tensor_view'); return exists(path.join(dest, '__init__.py')) ? { state: 'installed', detail: 'Restart ComfyUI once after installing.' } : { state: exists(TENSOR_VIEW_SRC) ? 'missing' : 'unavailable', detail: exists(TENSOR_VIEW_SRC) ? '' : 'The add-on is not included in this copy of Maataa.' }; } },
    { id: 'audio-models', group: 'Sound', label: 'Sound effects + music (Stable Audio, ACE-Step 1)', what: 'Text to sound effects and instrumental music.', sizeGb: 13, needGb: 16, requires: 'comfyui',
      install: { kind: 'script', script: 'install-comfyui-mac.sh', args: ['--models-only', '--no-sdxl', '--no-wan', '--audio'] },
      check: async () => { const sfx = sizeOf(model('checkpoints', 'stable-audio-open-1.0.safetensors')) >= 4e9 && sizeOf(model('text_encoders', 't5-base.safetensors')) >= 1e8, music = sizeOf(model('checkpoints', 'ace_step_v1_3.5b.safetensors')) >= 7e9; return { state: sfx && music ? 'installed' : sfx || music ? 'partial' : 'missing', detail: `effects ${sfx ? 'yes' : 'no'} · music ${music ? 'yes' : 'no'}` }; } },
    { id: 'acestep15', group: 'Sound', label: 'Singing (ACE-Step 1.5)', what: 'Songs with vocals, including Hindi.', sizeGb: 10, needGb: 13, requires: 'comfyui',
      install: { kind: 'script', script: 'add-acestep15-mac.sh' },
      check: async () => { const files = [model('diffusion_models', 'acestep_v1.5_turbo.safetensors'), model('text_encoders', 'qwen_0.6b_ace15.safetensors'), model('text_encoders', 'qwen_1.7b_ace15.safetensors'), model('vae', 'ace_1.5_vae.safetensors')]; const n = files.filter(nonEmpty).length; return { state: n === 4 ? 'installed' : n ? 'partial' : 'missing' }; } },
    { id: 'kokoro', group: 'Sound', label: 'Kokoro voices', what: 'Natural offline voices, including Hindi.', sizeGb: 0.4, needGb: 1,
      install: { kind: 'script', script: 'install-kokoro-mac.sh' },
      check: async () => (audioGen.kokoroStatus().ready ? { state: 'installed' } : { state: 'missing' }) },
    { id: 'whisper', group: 'Sound', label: 'Multilingual speech model (whisper)', what: 'Transcribe and translate Hindi and other languages.', sizeGb: 0.6, needGb: 2,
      install: { kind: 'script', script: 'add-whisper-model-mac.sh', env: () => ({ NOVA_DATA_DIR: dataDir }) },
      check: async () => { const st = transcribe.status(dataDir); return { state: st.multilingual ? 'installed' : (st.models || []).length ? 'partial' : 'missing', detail: st.multilingual ? '' : (st.models || []).length ? 'Only an English model is installed.' : '', note: st.binary ? null : 'whisper.cpp itself: brew install whisper-cpp' }; } },
    { id: 'ltx', group: 'Video', label: 'LTX-2 video with sound', what: 'Short clips with sound from a picture and a prompt (Apple Silicon).', sizeGb: 28, needGb: 31,
      install: { kind: 'script', script: 'install-ltx-mac.sh' },
      check: async () => { const s = ltx.status(); return s.ready ? { state: 'installed' } : { state: s.binary ? 'partial' : 'missing', detail: s.binary ? 'Weights missing.' : '' }; } },
    { id: 'wan', group: 'Video', label: 'Wan 2.2 AI motion', what: 'AI motion through ComfyUI.', sizeGb: 25, needGb: 25, requires: 'comfyui', minRamGb: 32,
      install: { kind: 'script', script: 'install-comfyui-mac.sh', args: ['--models-only', '--no-sdxl'] },
      check: async () => { const files = [model('vae', 'wan2.2_vae.safetensors'), model('diffusion_models', 'wan2.2_ti2v_5B_fp16.safetensors'), model('text_encoders', 'umt5_xxl_fp16.safetensors')]; const n = files.filter(f => sizeOf(f) > 5e8).length; return { state: n === 3 ? 'installed' : n ? 'partial' : 'missing' }; } },
    { id: 'aai', group: 'Maataa AAI', label: 'Paninian derivation engine (Vidyut)', what: 'Rule-based Sanskrit derivations for Maataa AAI.', sizeGb: 0.01, needGb: 1,
      install: { kind: 'aai' },
      check: async () => { const s = await aai.status(); return s.engine.installed ? { state: 'installed', detail: 'Vidyut ' + (s.engine.version || '') } : { state: s.install && s.install.state === 'running' ? 'partial' : 'missing' }; } },
    { id: 'agent-browser', group: 'Agents', label: 'Agent browser', what: 'The observable browser Radheya and agents use (Playwright with your Chrome).', sizeGb: 0, needGb: 0,
      install: { kind: 'none', hint: 'Comes with Maataa. It needs Google Chrome (or Edge, Brave, Chromium) on this Mac.' },
      check: async () => { const e = browserService.engine(); return e.available ? { state: 'installed', detail: `${e.library} · ${e.browser}` } : { state: 'missing', detail: e.library ? 'Install Google Chrome.' : 'Playwright is missing from this copy of Maataa.' }; } },
    { id: 'guru-env', group: 'Guru', label: 'Guru Python environment', what: 'PyTorch for Guru on the Apple GPU (only when Maataa runs from the brahmini folder).', sizeGb: 1, needGb: 3, checkoutOnly: true,
      install: { kind: 'script', file: () => path.join(REPO, 'launchers', 'Guru 0 - Fix PyTorch.command') },
      check: async () => (exists(path.join(REPO, 'guru', '.venv', 'bin', 'python')) ? { state: 'installed', detail: 'guru/.venv' } : { state: 'missing' }) },
  ];

  const byId = id => { const c = COMPONENTS.find(x => x.id === id); if (!c) throw error('Unknown component.', 404); return c; };
  const available = c => !(c.checkoutOnly && !exists(path.join(REPO, 'guru')));

  async function list() {
    const free = freeGb(), ram = totalGb();
    const states = {};
    const rows = [];
    for (const c of COMPONENTS.filter(available)) {
      let st;
      try { st = await c.check(); } catch (e) { st = { state: 'unknown', detail: e.message }; }
      states[c.id] = st.state;
      rows.push({ id: c.id, group: c.group, label: c.label, what: c.what, sizeGb: c.sizeGb, needGb: c.needGb, requires: c.requires || null, installKind: c.install.kind, url: c.install.url || null, hint: c.install.hint || null, ...st, result: results[c.id] || null });
    }
    for (const r of rows) {
      const c = byId(r.id), blockers = [];
      if (c.requires && states[c.requires] !== 'installed') blockers.push(`needs ${byId(c.requires).label} first`);
      if (c.minRamGb && ram < c.minRamGb) blockers.push(`needs ${c.minRamGb} GB of memory; this Mac has ${ram} GB`);
      if (free != null && c.needGb && free < c.needGb && r.state !== 'installed') blockers.push(`needs ${c.needGb} GB free; ${free} GB is free`);
      if (platform !== 'darwin' && ['script', 'comfy', 'symlink'].includes(c.install.kind)) blockers.push('this installer is for macOS');
      r.blockers = blockers;
      r.canInstall = ['pull', 'comfy', 'aai', 'script', 'symlink'].includes(c.install.kind) && !blockers.length && r.state !== 'installed' && r.state !== 'unavailable';
    }
    return { freeGb: free, memoryGb: ram, platform, running: running ? { id: running.id, jobId: running.jobId } : null, components: rows };
  }

  function logFile(id) { const dir = path.join(dataDir, 'installs'); fs.mkdirSync(dir, { recursive: true }); return path.join(dir, id.replace(/[^a-z0-9-]/gi, '_') + '.log'); }
  function logTail(id, lines = 40) { try { return fs.readFileSync(logFile(id), 'utf8').split('\n').slice(-lines).join('\n'); } catch (_) { return ''; } }

  function finish(id, ok, message) { results[id] = { at: new Date().toISOString(), ok, message }; running = null; }

  function runScript(c, job) {
    const file = c.install.file ? c.install.file() : path.join(SCRIPTS, c.install.script);
    if (!exists(file)) throw error('This installer is not included in this copy of Maataa.', 500);
    const log = fs.createWriteStream(logFile(c.id), { flags: 'a' });
    log.write(`\n== ${new Date().toISOString()} ${c.label}\n`);
    const env = { ...process.env, COMFY_DIR: comfyDir(), ...(c.install.env ? c.install.env() : {}) };
    const child = spawnImpl('/bin/bash', [file, ...(c.install.args || [])], { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: path.dirname(file) });
    let step = job.step('Starting', c.label);
    let tail = '';
    const onData = d => {
      log.write(d); tail = (tail + String(d)).slice(-4000);
      for (const line of String(d).split('\n')) {
        const m = /==\s*(.+?)\s*$/.exec(line.replace(/\x1b\[[0-9;]*m/g, ''));
        if (m && /^\S/.test(m[1])) { step.done(); step = job.step(m[1]); }
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    job.signal.addEventListener('abort', () => { try { child.kill('SIGTERM'); } catch (_) {} });
    child.on('exit', async code => {
      log.end();
      let st = { state: 'unknown' }; try { st = await c.check(); } catch (_) {}
      if (code === 0 && st.state === 'installed') { step.done(); job.done(c.label + ' is installed.'); finish(c.id, true, 'Installed.'); }
      else { const msg = `The installer stopped (${code}). ${tail.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-6).join('\n')}`.slice(0, 900); step.fail(msg); job.fail(new Error(msg)); finish(c.id, false, msg); }
    });
    running.child = child;
  }

  async function runPull(c, job) {
    const controller = new AbortController(); running.controller = controller;
    job.signal.addEventListener('abort', () => controller.abort());
    let step = job.step('Downloading ' + c.install.model);
    try {
      const res = await fetchImpl(ollama.url('/api/pull'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: c.install.model, stream: true }), signal: controller.signal });
      if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
      let buf = '', lastPct = -1, lastStatus = '';
      const handle = line => {
        if (!line.trim()) return; const m = JSON.parse(line);
        if (m.error) throw new Error(m.error);
        const pct = m.total ? Math.floor(m.completed / m.total * 100) : null;
        if (m.status !== lastStatus || (pct != null && pct >= lastPct + 10)) { lastStatus = m.status; if (pct != null) lastPct = pct; step.done(); step = job.step(`${m.status}${pct != null ? ' · ' + pct + '%' : ''}`); }
      };
      for await (const chunk of res.body) { buf += Buffer.from(chunk).toString(); const lines = buf.split('\n'); buf = lines.pop(); lines.forEach(handle); }
      handle(buf);
      step.done(); job.done(c.install.model + ' is downloaded. Run the coding checks before it writes code.'); finish(c.id, true, 'Downloaded.');
    } catch (e) { step.fail(e.message); job.fail(e); finish(c.id, false, e.message); }
  }

  function install(id) {
    const c = byId(id);
    if (!available(c)) throw error('This component is only available when Maataa runs from the brahmini folder.', 409);
    if (running) throw error(`${byId(running.id).label} is installing. Wait for it to finish (see Activity).`, 409);
    if (c.install.kind === 'link' || c.install.kind === 'none') throw error(c.install.hint || 'Install this one from its own download page.', 409);
    if (c.minRamGb && totalGb() < c.minRamGb) throw error(`${c.label} needs ${c.minRamGb} GB of memory; this Mac has ${totalGb()} GB.`, 409);
    const free = freeGb();
    if (free != null && c.needGb && free < c.needGb) throw error(`${c.label} needs ${c.needGb} GB of free disk; ${free} GB is free. Free some space first.`, 409);
    if (c.install.kind === 'comfy') { const r = comfyManager.install({}); finish(c.id, true, 'Started the ComfyUI installer.'); return { started: true, jobId: r.jobId }; }
    if (c.install.kind === 'aai') { aai.startInstall({ killSwitch: deps.killSwitch }); finish(c.id, true, 'Started the AAI engine install.'); return { started: true }; }
    if (c.install.kind === 'symlink') {
      const dest = path.join(comfyDir(), 'custom_nodes', 'nova_tensor_view');
      if (!exists(TENSOR_VIEW_SRC)) throw error('The tensor view add-on is not included in this copy of Maataa.', 500);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!exists(dest)) fs.symlinkSync(TENSOR_VIEW_SRC, dest, 'dir');
      finish(c.id, true, 'Linked. Restart ComfyUI to load it.');
      return { started: false, done: true };
    }
    const job = activity.start({ kind: 'install', title: 'Installing ' + c.label });
    running = { id: c.id, jobId: job.id };
    try { if (c.install.kind === 'pull') runPull(c, job); else runScript(c, job); }
    catch (e) { job.fail(e); finish(c.id, false, e.message); throw e; }
    return { started: true, jobId: job.id };
  }

  function cancel() { if (!running) throw error('Nothing is installing.', 409); const r = running; try { r.child && r.child.kill('SIGTERM'); } catch (_) {} try { r.controller && r.controller.abort(); } catch (_) {} return { ok: true, id: r.id }; }

  return { list, install, cancel, logTail, COMPONENTS, CODING_MODELS };
}

module.exports = { createInstallers };
