'use strict';
/* Oversight added with the Workbench merge: resume passphrase, kill switch on
 * computer actions, Qualify for coding, the setup checklist's verified step,
 * the optional agent browser and the support report checks. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const resume = require('../lib/resume-passphrase');
const computer = require('../lib/computer');
const suite = require('../lib/qualification-suite');
const qualifications = require('../lib/model-qualifications');
const { ActivationLadder } = require('../lib/activation');
const { buildReport } = require('../lib/support-report');
const { openDb, Store, STORE_NAMES } = require('../lib/db');

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test('resume passphrase: set once, verify, change needs the current one, stored only as a hash', () => {
  const dir = tmp('nova-resume-');
  const prev = process.env.NOVA_RESUME_CREDENTIAL; delete process.env.NOVA_RESUME_CREDENTIAL;
  try {
    assert.deepEqual(resume.status(dir), { set: false, source: null });
    assert.equal(resume.verify(dir, 'anything'), false, 'nothing set: nothing verifies');
    assert.throws(() => resume.set(dir, { passphrase: 'abc' }), /at least 6/);
    resume.set(dir, { passphrase: 'clapper-board' });
    assert.equal(resume.status(dir).set, true);
    assert.equal(resume.verify(dir, 'clapper-board'), true);
    assert.equal(resume.verify(dir, 'Clapper-board'), false);
    const raw = fs.readFileSync(path.join(dir, resume.FILE), 'utf8');
    assert.ok(!raw.includes('clapper'), 'not stored in plain text');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, resume.FILE)).mode & 0o777, 0o600);
    assert.throws(() => resume.set(dir, { passphrase: 'new-passphrase', current: 'wrong' }), /not right/);
    resume.set(dir, { passphrase: 'new-passphrase', current: 'clapper-board' });
    assert.equal(resume.verify(dir, 'new-passphrase'), true);
    process.env.NOVA_RESUME_CREDENTIAL = 'from-env';
    assert.equal(resume.verify(dir, 'from-env'), true, 'the environment credential is accepted too');
    assert.equal(resume.status(dir).source, 'environment');
  } finally {
    if (prev === undefined) delete process.env.NOVA_RESUME_CREDENTIAL; else process.env.NOVA_RESUME_CREDENTIAL = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('kill switch: computer actions are refused while NOVA is halted', async () => {
  const dir = tmp('nova-halt-');
  const { db } = openDb(dir); const store = new Store(db);
  try {
    assert.equal(computer.halted(store), false);
    store.setGlobalHalt('1');
    assert.equal(computer.halted(store), true);
    assert.throws(() => computer.checkHalt(store), /halted/);
    await assert.rejects(() => computer.execute('list_files', { path: dir }, { store, dataDir: dir, roots: [dir] }), e => e.statusCode === 423);
    store.setGlobalHalt('0');
    const r = await computer.execute('list_files', { path: dir }, { store, dataDir: dir, roots: [fs.realpathSync(dir)] });
    assert.ok(r.summary);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('qualifyModel: records every trial against the model digest and shows steps; bad answers do not qualify', { timeout: 120000 }, async () => {
  const store = suite.memoryStore();
  const digest = 'a'.repeat(64);
  const ollama = {
    status: async () => ({ reachable: true, models: [{ name: 'tiny:latest', model: 'tiny:latest', digest, details: { parameter_size: '7B' } }] }),
    show: async () => ({ capabilities: ['completion', 'tools'], details: { parameter_size: '7B' }, model_info: { 'llama.context_length': 8192 } }),
    chatFull: async () => ({ message: { content: 'not a plan' } }),
  };
  const steps = [];
  const job = { signal: new AbortController().signal, step: (label) => { const s = { label }; steps.push(s); return { done() { s.status = 'done'; }, fail(e) { s.status = 'failed'; s.error = e; } }; } };
  const r = await suite.qualifyModel(store, ollama, 'tiny:latest', { job, trials: 1 });
  assert.equal(r.passed + r.failed, suite.fixtures.length);
  assert.equal(steps.length, suite.fixtures.length);
  assert.ok(steps.every(s => s.status));
  const rec = qualifications.getByDigest(store, digest);
  assert.equal(rec.runs.length, suite.fixtures.length);
  assert.equal(qualifications.isQualified(store, digest, 'multi-file'), false, 'a model that answers nonsense is not qualified');
  await assert.rejects(() => suite.qualifyModel(store, ollama, 'missing:latest'), /no model called/);
  await assert.rejects(() => suite.qualifyModel(store, { status: async () => ({ reachable: false }) }, 'tiny:latest'), /Ollama is not running/);
});

test('setup checklist: a change applied after its checks, or a loop with passing tests, is a verified outcome', () => {
  const dir = tmp('nova-act-');
  const { db } = openDb(dir); const store = new Store(db);
  try {
    const step = () => new ActivationLadder(store).snapshot().steps.find(s => s.id === 'verified');
    assert.equal(step().done, false);
    assert.match(step().action.href, /#workspace$/);
    store.put('workspaceLoops', { id: 'loop1', status: 'ready', attempts: [{ status: 'failed' }, { status: 'passed' }] });
    assert.equal(step().done, true);
    assert.match(step().detail, /1 loops with passing tests/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agent browser loads Playwright only when needed', () => {
  const svc = require('../lib/browser-service');
  assert.equal(typeof svc.available, 'function');
  assert.equal(typeof svc.available(), 'boolean');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'browser-service.js'), 'utf8');
  assert.ok(!/^const \{ chromium \} = require\('playwright'\)/m.test(src), 'no top-level require: the app ships without Playwright');
});

test('support report: coding qualification, kill switch, jobs and optional tools', async () => {
  const dir = tmp('nova-rep-ov-');
  const { db } = openDb(dir); const store = new Store(db);
  try {
    const digest = 'b'.repeat(64);
    for (const cap of ['single-file', 'clarification', 'timeout', 'cancellation']) for (let t = 1; t <= 3; t++) qualifications.recordResult(store, { digest, model: 'coder:7b', fixture: cap === 'clarification' ? 'ambiguous' : cap, trial: t, status: 'passed', runId: cap + t });
    store.setGlobalHalt('1');
    const r = await buildReport({ store, storeNames: STORE_NAMES, dataDir: dir, ollamaStatus: () => ({ reachable: true, models: [{ name: 'coder:7b', digest }] }) });
    const c = Object.fromEntries(r.checks.map(x => [x.id, x]));
    assert.equal(c.qualified.ok, true);
    assert.match(c.qualified.detail, /coder:7b \(single-file only\)/);
    assert.equal(c.killswitch.ok, false);
    assert.match(c.killswitch.detail, /HALTED/);
    assert.equal(c.jobs.ok, true);
    assert.equal(c.agentBrowser.optional, true);
    assert.equal(c.dafny.optional, true);
    assert.equal(r.oversight.halted, true);
    assert.match(r.text, /Kill switch: NOVA is HALTED/);
    assert.match(r.text, /\[(--|ok)\] +Proof checker/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('server: resume passphrase routes, halt and resume through Workbench, and qualify validation', { timeout: 40000 }, async () => {
  const { spawn } = require('node:child_process');
  const dir = tmp('nova-ov-srv-');
  const env = { ...process.env, PORT: '0', DATA_DIR: dir, OLLAMA_HOST: 'http://127.0.0.1:9', COMFYUI_URL: 'http://127.0.0.1:9', NOVA_LIBRARY_DIR: path.join(dir, 'library') };
  delete env.NOVA_RESUME_CREDENTIAL;
  const child = spawn(process.execPath, ['--no-warnings', '-e', "const {server}=require('./server'); server.on('listening',()=>console.log('READY '+server.address().port));"], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = ''; const t = setTimeout(() => reject(new Error('no start: ' + out)), 15000);
      child.stdout.on('data', d => { out += d; const m = /READY (\d+)/.exec(out); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
      child.stderr.on('data', d => { out += d; });
    });
    const base = `http://127.0.0.1:${port}`;
    const H = { Origin: base, 'Content-Type': 'application/json' };
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body) });
    assert.equal((await (await fetch(base + '/api/workbench/resume-passphrase')).json()).set, false);
    assert.equal((await post('/api/workbench/resume-passphrase', { passphrase: 'short' })).status, 400);
    assert.equal((await post('/api/workbench/resume-passphrase', { passphrase: 'gaffer-tape' })).status, 200);
    assert.equal((await post('/api/workbench/resume-passphrase', { passphrase: 'other-one', current: 'nope' })).status, 403);
    assert.equal((await post('/api/workbench/actions/runtime/halt', { operator: 'hemant', reason: 'test' })).status, 200);
    assert.equal((await (await fetch(base + '/api/workbench/snapshot')).json()).allowed.kill_switch.halted, true);
    assert.equal((await post('/api/workbench/actions/runtime/resume', { operator: 'hemant', reason: 'ok', credential: 'wrong' })).status, 403);
    assert.equal((await post('/api/workbench/actions/runtime/resume', { operator: 'hemant', reason: 'ok', credential: 'gaffer-tape' })).status, 200);
    assert.equal((await (await fetch(base + '/api/workbench/snapshot')).json()).allowed.kill_switch.halted, false);
    assert.equal((await post('/api/models/qualify', {})).status, 400);
    const q = await post('/api/models/qualify', { model: 'x' });
    assert.equal(q.status, 202, 'starts as a job; Ollama being unreachable shows up in Activity');
    const { jobId } = await q.json();
    let job;
    for (let i = 0; i < 100; i++) { job = ((await (await fetch(base + '/api/activity')).json()).jobs || []).find(j => j.id === jobId) || job; if (job && job.status !== 'running') break; await new Promise(r => setTimeout(r, 50)); }
    assert.equal(job.status, 'failed');
  } finally { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup checklist: a model qualified by the coding suite completes step 2', () => {
  const dir = tmp('nova-act-q-');
  const { db } = openDb(dir); const store = new Store(db);
  try {
    const step = () => new ActivationLadder(store).snapshot().steps.find(s => s.id === 'model');
    assert.equal(step().done, false);
    for (const cap of ['single-file', 'clarification', 'timeout', 'cancellation']) for (let t = 1; t <= 3; t++) qualifications.recordResult(store, { digest: 'c'.repeat(64), model: 'coder:7b', fixture: cap, trial: t, status: 'passed', runId: cap + t });
    assert.equal(step().done, true);
    assert.match(step().detail, /1 qualified · coder:7b/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
