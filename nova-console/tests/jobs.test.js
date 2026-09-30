'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const { openDb, Store } = require('../lib/db');
const { JobEngine, CancelledError, TimeoutError } = require('../lib/jobs');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-jobs-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  return { dir, db, store };
}

function cleanup({ dir, db }) {
  try { db.close(); } catch { /* noop */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}

function waitFor(fn, timeoutMs = 3000, stepMs = 20) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      try {
        if (fn()) return resolve(true);
      } catch (e) {
        return reject(e);
      }
      if (Date.now() > deadline) return reject(new Error('waitFor timeout'));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

test('1 enqueue_and_complete', async () => {
  const env = fresh();
  const engine = new JobEngine(env.store, { pollMs: 20 });
  engine.register('add', async (payload) => payload.a + payload.b);
  const job = engine.enqueue('add', { a: 2, b: 3 });
  engine.start();
  await waitFor(() => env.store.jobsGet(job.id).state === 'completed');
  const final = env.store.jobsGet(job.id);
  assert.equal(JSON.parse(final.result_json), 5);
  engine.stop();
  cleanup(env);
});

test('2 cancel_queued', async () => {
  const env = fresh();
  const engine = new JobEngine(env.store, { pollMs: 5000 });
  engine.register('slow', async () => { throw new Error('should not run'); });
  const job = engine.enqueue('slow', {});
  engine.cancel(job.id);
  assert.equal(env.store.jobsGet(job.id).state, 'cancelled');
  engine.stop();
  cleanup(env);
});

test('3 cancel_running', async () => {
  const env = fresh();
  const engine = new JobEngine(env.store, { pollMs: 20 });
  engine.register('loop', async (payload, ctx) => {
    for (let i = 0; i < 100; i++) {
      if (ctx.cancelled) throw new CancelledError();
      await new Promise((r) => setTimeout(r, 20));
    }
  });
  const job = engine.enqueue('loop', {});
  engine.start();
  await waitFor(() => env.store.jobsGet(job.id).state === 'running');
  engine.cancel(job.id);
  await waitFor(() => env.store.jobsGet(job.id).state === 'cancelled');
  assert.equal(env.store.jobsGet(job.id).state, 'cancelled');
  engine.stop();
  cleanup(env);
});

test('4 timeout', async () => {
  const env = fresh();
  const engine = new JobEngine(env.store, { pollMs: 20, reaperMs: 40 });
  engine.register('slow', async (payload, ctx) => {
    for (let i = 0; i < 50; i++) {
      if (ctx.cancelled) throw new TimeoutError();
      await new Promise((r) => setTimeout(r, 20));
    }
  });
  const job = engine.enqueue('slow', {}, { timeoutMs: 120 });
  engine.start();
  await waitFor(() => env.store.jobsGet(job.id).state === 'timed_out', 4000);
  assert.equal(env.store.jobsGet(job.id).state, 'timed_out');
  engine.stop();
  cleanup(env);
});

test('5 retry_then_success', async () => {
  const env = fresh();
  const engine = new JobEngine(env.store, { pollMs: 20 });
  let count = 0;
  engine.register('flaky', async () => {
    count++;
    if (count < 3) throw new Error('not yet');
    return 'ok';
  });
  const job = engine.enqueue('flaky', {}, { maxAttempts: 5, timeoutMs: 30000 });
  engine.start();
  await waitFor(() => env.store.jobsGet(job.id).state === 'completed', 10000);
  const final = env.store.jobsGet(job.id);
  assert.equal(final.state, 'completed');
  assert.equal(final.attempts, 2);
  engine.stop();
  cleanup(env);
});

test('6 retry_exhausted', async () => {
  const env = fresh();
  const engine = new JobEngine(env.store, { pollMs: 20 });
  engine.register('bad', async () => { throw new Error('always fails'); });
  const job = engine.enqueue('bad', {}, { maxAttempts: 2 });
  engine.start();
  await waitFor(() => env.store.jobsGet(job.id).state === 'failed', 8000);
  const final = env.store.jobsGet(job.id);
  assert.equal(final.state, 'failed');
  assert.equal(final.attempts, 2);
  engine.stop();
  cleanup(env);
});

test('7 exponential_backoff', async () => {
  const env = fresh();
  const engine = new JobEngine(env.store, { pollMs: 1000 });
  engine.register('bad', async () => { throw new Error('fail'); });
  const job = engine.enqueue('bad', {}, { maxAttempts: 5 });
  // manually run once
  await engine._poll();
  await waitFor(() => {
    const j = env.store.jobsGet(job.id);
    return j.state === 'queued' && j.attempts === 1;
  });
  const t1 = new Date(env.store.jobsGet(job.id).run_at).getTime();
  const delta1 = t1 - Date.now();
  assert.ok(delta1 > 500 && delta1 < 1500, `first backoff ~1s, got ${delta1}ms`);
  // trigger second failure
  env.store.jobsUpdate(job.id, { run_at: new Date().toISOString() });
  await engine._poll();
  await waitFor(() => env.store.jobsGet(job.id).attempts === 2, 5000);
  const t2 = new Date(env.store.jobsGet(job.id).run_at).getTime();
  const delta2 = t2 - Date.now();
  assert.ok(delta2 > 1500 && delta2 < 2500, `second backoff ~2s, got ${delta2}ms`);
  engine.stop();
  cleanup(env);
});

test('8 progress_events', async () => {
  const env = fresh();
  const engine = new JobEngine(env.store, { pollMs: 20 });
  engine.register('report', async (payload, ctx) => {
    ctx.progress({ step: 1 });
    await new Promise((r) => setTimeout(r, 20));
    ctx.progress({ step: 2 });
    return 'done';
  });
  const job = engine.enqueue('report', {});
  engine.start();
  await waitFor(() => env.store.jobsGet(job.id).state === 'completed');
  const events = env.store.jobsListEvents(job.id);
  const progress = events.filter((e) => e.kind === 'progress');
  assert.equal(progress.length, 2);
  engine.stop();
  cleanup(env);
});

test('9 concurrency', async () => {
  const env = fresh();
  const engine = new JobEngine(env.store, { pollMs: 20, concurrency: 2 });
  engine.register('slow', async () => {
    await new Promise((r) => setTimeout(r, 120));
    return 'ok';
  });
  const t0 = Date.now();
  engine.enqueue('slow', { i: 1 });
  engine.enqueue('slow', { i: 2 });
  engine.start();
  await waitFor(() => env.store.jobsListByState('completed').length === 2, 3000);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 280, `expected parallel, elapsed ${elapsed}ms`);
  engine.stop();
  cleanup(env);
});

test('10 restart_recovery', async () => {
  const env = fresh();
  const childScript = path.join(env.dir, 'child.js');
  const libAbs = path.resolve(__dirname, '..', 'lib');
  const code = `
    'use strict';
    const path = require('path');
    const { openDb, Store } = require(path.join(${JSON.stringify(libAbs)}, 'db'));
    const { JobEngine } = require(path.join(${JSON.stringify(libAbs)}, 'jobs'));
    const dir = process.argv[2];
    const { db } = openDb(dir);
    const store = new Store(db);
    const engine = new JobEngine(store, { pollMs: 30 });
    engine.register('sleep', async () => {
      for (let i = 0; i < 1000; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
    });
    engine.enqueue('sleep', {});
    engine.start();
    setInterval(() => {}, 1000);
  `;
  fs.writeFileSync(childScript, code);

  const child = fork(childScript, [env.dir], { stdio: 'ignore' });
  await waitFor(() => env.store.jobsListByState('running').length === 1, 5000);
  child.kill('SIGKILL');
  await new Promise((r) => child.on('exit', r));

  const runningAfter = env.store.jobsListByState('running');
  assert.equal(runningAfter.length, 1, 'orphan should still be running in DB');

  const freshEngine = new JobEngine(env.store);
  const recovered = freshEngine.recover();
  assert.equal(recovered, 1);
  const failed = env.store.jobsListByState('failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].error, 'restart_interrupted');

  cleanup(env);
});
