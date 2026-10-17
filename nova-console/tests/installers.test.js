'use strict';
/* Install page: detection, blockers, one-at-a-time installs, Ollama pulls and installer scripts. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createInstallers } = require('../lib/installers');

function fakeActivity() {
  const jobs = [];
  return { jobs, start: ({ title }) => { const ac = new AbortController(); const job = { id: 'job' + jobs.length, title, steps: [], status: 'running', signal: ac.signal, abort: () => ac.abort(),
    step(t) { const s = { t, state: 'running', done() { s.state = 'done'; }, fail(m) { s.state = 'failed'; s.m = m; } }; job.steps.push(s); return s; },
    done(m) { job.status = 'done'; job.message = m; }, fail(e) { job.status = 'failed'; job.message = e.message; } }; jobs.push(job); return job; } };
}
function setup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-inst-'));
  const comfy = path.join(dir, 'ComfyUI');
  const models = [];
  const deps = {
    dataDir: dir, platform: 'darwin', freeGb: () => 50,
    store: { all: () => [{ digest: 'sha256:aaa', capabilities: { 'multi-file': { qualified: true }, clarification: { qualified: true }, timeout: { qualified: true }, cancellation: { qualified: true } } }] },
    ollama: { url: p => 'http://ollama' + p, status: async () => ({ reachable: true, models }) },
    comfyManager: { comfyDir: () => comfy, installed: () => fs.existsSync(path.join(comfy, 'main.py')), install: () => ({ jobId: 'comfyjob' }) },
    activity: fakeActivity(),
    aai: { status: async () => ({ engine: { installed: false }, install: { state: 'idle' } }), startInstall: () => ({ state: 'running' }) },
    audioGen: { kokoroStatus: () => ({ ready: false }) },
    ltx: { status: () => ({ ready: false, binary: null }) },
    transcribe: { status: () => ({ multilingual: false, models: [{ name: 'ggml-base.en.bin', multilingual: false }], binary: '/usr/bin/whisper-cli' }) },
    browserService: { engine: () => ({ available: true, library: 'playwright', browser: 'Google Chrome' }) },
    ...over,
  };
  return { dir, comfy, models, deps, inst: createInstallers(deps) };
}
const row = (l, id) => l.components.find(c => c.id === id);

test('reports what is installed, partly installed, missing and blocked', async () => {
  const s = setup();
  s.models.push({ name: 'qwen2.5:7b', digest: 'aaa' });
  const l = await s.inst.list();
  assert.equal(row(l, 'ollama').state, 'installed');
  assert.equal(row(l, 'model-qwen2-5-7b').state, 'installed');
  assert.match(row(l, 'model-qwen2-5-7b').detail, /Passed the coding checks/);
  assert.equal(row(l, 'model-qwen2-5-coder-7b').canInstall, true);
  assert.equal(row(l, 'whisper').state, 'partial', 'only an English whisper model');
  assert.deepEqual(row(l, 'upscale').blockers, ['needs ComfyUI + SDXL first']);
  assert.ok(row(l, 'agent-browser').state === 'installed' && !row(l, 'agent-browser').canInstall);
  const wan = row(l, 'wan');
  if (Math.round(os.totalmem() / 1e9) < 32) assert.ok(wan.blockers.some(b => /memory/.test(b)));
});

test('refuses when the disk is too full, and runs one install at a time', async () => {
  const s = setup({ freeGb: () => 3 });
  assert.throws(() => s.inst.install('ltx'), /needs 31 GB of free disk; 3 GB is free/);
  assert.throws(() => s.inst.install('ollama'), /download page/);
  assert.throws(() => s.inst.install('nope'), /Unknown component/);
});

test('an installer script runs as an Activity job and is checked afterwards', async () => {
  let spawned;
  const s = setup({ spawnImpl: (cmd, args, opts) => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {}; spawned = { cmd, args, opts, c }; return c; } });
  const r = s.inst.install('whisper');
  assert.equal(r.started, true);
  assert.equal(spawned.cmd, '/bin/bash');
  assert.match(spawned.args[0], /scripts\/add-whisper-model-mac\.sh$/);
  assert.equal(spawned.opts.env.NOVA_DATA_DIR, s.dir, 'the script installs into Maataa\'s own data folder');
  assert.throws(() => s.inst.install('kokoro'), /is installing/);
  spawned.c.stdout.emit('data', '\n== Downloading ggml-large-v3-turbo-q5_0.bin\nprogress\n');
  s.deps.transcribe.status = () => ({ multilingual: true, models: [{ multilingual: true }], binary: 'x' });
  spawned.c.emit('exit', 0);
  const logFile = path.join(s.dir, 'installs', 'whisper.log');
  for (let i = 0; i < 100 && !(s.deps.activity.jobs[0]?.status === 'done' && fs.existsSync(logFile) && /progress/.test(fs.readFileSync(logFile, 'utf8'))); i++) await new Promise(r => setTimeout(r, 20)); // a busy Mac flushes the log later
  const job = s.deps.activity.jobs[0];
  assert.equal(job.status, 'done');
  assert.ok(job.steps.some(st => /Downloading ggml/.test(st.t)));
  assert.match(fs.readFileSync(path.join(s.dir, 'installs', 'whisper.log'), 'utf8'), /progress/);
  const l = await s.inst.list();
  assert.equal(row(l, 'whisper').state, 'installed');
  assert.equal(l.running, null);
});

test('a failed script is reported with the end of its log', async () => {
  let child;
  const s = setup({ spawnImpl: () => { child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; return child; } });
  s.inst.install('kokoro');
  child.stderr.emit('data', 'curl: (6) Could not resolve host\n');
  child.emit('exit', 1);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(s.deps.activity.jobs[0].status, 'failed');
  assert.match(row(await s.inst.list(), 'kokoro').result.message, /stopped \(1\).*Could not resolve host/s);
});

test('an Ollama model is pulled with progress steps', async () => {
  const lines = [{ status: 'pulling manifest' }, { status: 'downloading', total: 100, completed: 50 }, { status: 'downloading', total: 100, completed: 100 }, { status: 'success' }].map(x => JSON.stringify(x) + '\n');
  let sent;
  const s = setup({ fetchImpl: async (url, o) => { sent = { url, body: JSON.parse(o.body) }; return { ok: true, body: (async function* () { for (const l of lines) yield Buffer.from(l); })() }; } });
  s.inst.install('model-qwen2-5-coder-7b');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(sent.url, 'http://ollama/api/pull');
  assert.equal(sent.body.name, 'qwen2.5-coder:7b');
  const job = s.deps.activity.jobs[0];
  assert.equal(job.status, 'done');
  assert.ok(job.steps.some(st => /downloading · 50%/.test(st.t)));
  assert.match(job.message, /Run the coding checks/);
});

test('the tensor view add-on is linked into ComfyUI', async () => {
  const s = setup();
  fs.mkdirSync(s.comfy, { recursive: true }); fs.writeFileSync(path.join(s.comfy, 'main.py'), '');
  const r = s.inst.install('tensor-view');
  assert.equal(r.done, true);
  assert.ok(fs.lstatSync(path.join(s.comfy, 'custom_nodes', 'nova_tensor_view')).isSymbolicLink());
  assert.equal(row(await s.inst.list(), 'tensor-view').state, 'installed');
});
