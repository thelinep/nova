'use strict';
/* NOVA Automations scheduler (lib/scheduler.js) — not Guru's training
 * learning-rate scheduler. Regression: a run must not overwrite changes the
 * user made to the automation while that run was in flight. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, Store } = require('../lib/db');
const scheduler = require('../lib/scheduler');

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-scheduler-'));
  const { db } = openDb(dir);
  return { store: new Store(db), close() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// An Ollama stand-in whose reply (or failure) is released by the test.
function gatedOllama() {
  let release;
  const gate = new Promise(r => { release = r; });
  let started;
  const startedP = new Promise(r => { started = r; });
  return {
    started: startedP,
    release: outcome => release(outcome),
    async chatFull() {
      started();
      const outcome = await gate;
      if (outcome instanceof Error) throw outcome;
      return { message: { content: 'done' }, eval_count: 7, total_duration: 1e9 };
    },
  };
}

const automation = extra => ({
  id: 'auto', name: 'Brief', status: 'Enabled', modelId: 'local-model', collections: [],
  trigger: { type: 'schedule', schedule: { kind: 'interval', everyMinutes: 60 }, detail: 'Every 60 minutes' },
  nextRun: null, logs: [], ...extra,
});

let keepAlive = null;

const waitFor = async (check, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('condition not reached');
};

test('disabling and renaming during a successful run is kept when the run finishes', async () => {
  const ws = workspace();
  try {
    ws.store.put('automations', automation());
    const ollama = gatedOllama();
    const run = scheduler.runAutomation(ws.store, ollama, 'auto', { origin: 'manual' });
    await ollama.started;
    scheduler.configureAutomation(ws.store, 'auto', { status: 'Draft', name: 'Renamed brief' });
    ollama.release({});
    await run;
    const a = ws.store.get('automations', 'auto');
    assert.equal(a.status, 'Draft');
    assert.equal(a.name, 'Renamed brief');
    assert.equal(a.nextRun, null);
    assert.equal(a.lastTokens, 7, 'run results are still recorded');
    assert.ok(a.lastRun);
    assert.equal(ws.store.all('automationRuns')[0].status, 'Success');
  } finally { ws.close(); }
});

test('a trigger change during a failing run is kept and the failure is recorded', async () => {
  const ws = workspace();
  try {
    ws.store.put('automations', automation());
    const ollama = gatedOllama();
    const run = scheduler.runAutomation(ws.store, ollama, 'auto', { origin: 'schedule' });
    await ollama.started;
    scheduler.configureAutomation(ws.store, 'auto', { trigger: { type: 'schedule', schedule: { kind: 'daily', hour: 6, minute: 15 } } });
    ollama.release(new Error('model unavailable'));
    await assert.rejects(run, /model unavailable/);
    const a = ws.store.get('automations', 'auto');
    assert.deepEqual(a.trigger.schedule, { kind: 'daily', hour: 6, minute: 15 });
    assert.equal(a.trigger.detail, 'Every day at 06:15');
    assert.match(a.logs.at(-1), /Run failed \(scheduled\) — model unavailable/);
    assert.equal(ws.store.all('automationRuns')[0].status, 'Failed');
    assert.ok(ws.store.all('runtimeEvents').some(e => e.category === 'ERROR' && /scheduled run failed/.test(e.message)));
  } finally { ws.close(); }
});

test('an automation disabled while its scheduled run is in flight gets no new next run', async () => {
  const ws = workspace();
  try {
    ws.store.put('automations', automation({ nextRun: new Date(Date.now() + 30).toISOString() }));
    const ollama = gatedOllama();
    keepAlive = setInterval(() => {}, 1000); // the scheduler's own timer is unref'd
    scheduler.startScheduler(ws.store, ollama, { tickMs: 20 });
    await ollama.started; // the real tick fired it
    assert.equal(scheduler.getSchedulerStatus(ws.store).firing, 1);
    scheduler.configureAutomation(ws.store, 'auto', { status: 'Draft' });
    ollama.release({});
    await waitFor(() => scheduler.getSchedulerStatus(ws.store).firing === 0);
    const a = ws.store.get('automations', 'auto');
    assert.equal(a.status, 'Draft');
    assert.equal(a.nextRun, null);
    assert.equal(ws.store.all('automationRuns').length, 1);
  } finally {
    clearInterval(keepAlive);
    // Point the module's timer at an empty store before closing the database.
    scheduler.startScheduler({ all: () => [], put() {}, get() { return null; } }, null, { tickMs: 3600000 });
    ws.close();
  }
});

test('a still-enabled schedule is rescheduled from completion after a run', async () => {
  const ws = workspace();
  try {
    ws.store.put('automations', automation({ nextRun: new Date(Date.now() + 30).toISOString() }));
    const ollama = gatedOllama();
    keepAlive = setInterval(() => {}, 1000); // the scheduler's own timer is unref'd
    scheduler.startScheduler(ws.store, ollama, { tickMs: 20 });
    await ollama.started;
    ollama.release({});
    await waitFor(() => scheduler.getSchedulerStatus(ws.store).firing === 0 && ws.store.all('automationRuns').length === 1);
    await waitFor(() => Date.parse(ws.store.get('automations', 'auto').nextRun) > Date.now() + 50 * 60000);
    assert.equal(ws.store.all('automationRuns').length, 1, 'fired exactly once');
  } finally {
    clearInterval(keepAlive);
    scheduler.startScheduler({ all: () => [], put() {}, get() { return null; } }, null, { tickMs: 3600000 });
    ws.close();
  }
});
