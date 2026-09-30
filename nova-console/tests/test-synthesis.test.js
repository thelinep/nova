'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { TestSynthesisPipeline, TestSynthesisError } = require('../lib/test-synthesis');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ts-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  return { dir, db, store };
}
function cleanup(env) {
  try { env.db.close(); } catch {}
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch {}
}

const plannerOk = () => async () => ['edge1', 'edge2'];
const generatorOk = (code) => async () => ({ testCode: code || 'test-body' });
const executorAllPass = () => async () => ({ passed: 3, failed: 0, output: 'ok' });
const executorSomeFail = () => async () => ({ passed: 2, failed: 1, output: 'one fail' });
const reviewerAccept = () => async () => ({ accept: true, reason: 'flaky' });
const reviewerReject = () => async () => ({ accept: false, reason: 'real' });

test('1 happy path passes', async () => {
  const env = fresh();
  const p = new TestSynthesisPipeline(env.store, {
    planner: plannerOk(),
    generator: generatorOk(),
    executor: executorAllPass(),
    reviewer: reviewerReject(),
  });
  const r = await p.synthesize('problem', 'code');
  assert.equal(r.ok, true);
  assert.equal(r.status, 'passed');
  assert.equal(r.iterations, 1);
  assert.equal(r.execution.passed, 3);
  assert.equal(r.execution.failed, 0);
  cleanup(env);
});

test('2 planner fails', async () => {
  const env = fresh();
  const p = new TestSynthesisPipeline(env.store, {
    planner: async () => { throw new Error('planner broke'); },
    generator: generatorOk(),
    executor: executorAllPass(),
    reviewer: reviewerReject(),
  });
  const r = await p.synthesize('problem', 'code');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'planner_failed');
  cleanup(env);
});

test('3 generator fails', async () => {
  const env = fresh();
  const p = new TestSynthesisPipeline(env.store, {
    planner: plannerOk(),
    generator: async () => { throw new Error('generator broke'); },
    executor: executorAllPass(),
    reviewer: reviewerReject(),
  });
  const r = await p.synthesize('problem', 'code');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'generator_failed');
  cleanup(env);
});

test('4 empty tests', async () => {
  const env = fresh();
  const p = new TestSynthesisPipeline(env.store, {
    planner: plannerOk(),
    generator: async () => ({ testCode: '' }),
    executor: executorAllPass(),
    reviewer: reviewerReject(),
  });
  const r = await p.synthesize('problem', 'code');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'empty_tests');
  cleanup(env);
});

test('5 executor fails', async () => {
  const env = fresh();
  const p = new TestSynthesisPipeline(env.store, {
    planner: plannerOk(),
    generator: generatorOk(),
    executor: async () => { throw new Error('executor broke'); },
    reviewer: reviewerReject(),
  });
  const r = await p.synthesize('problem', 'code');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'executor_failed');
  cleanup(env);
});

test('6 reviewer accepts despite failures', async () => {
  const env = fresh();
  const p = new TestSynthesisPipeline(env.store, {
    planner: plannerOk(),
    generator: generatorOk(),
    executor: executorSomeFail(),
    reviewer: reviewerAccept(),
  });
  const r = await p.synthesize('problem', 'code');
  assert.equal(r.ok, true);
  assert.equal(r.status, 'accepted_with_failures');
  assert.equal(r.iterations, 1);
  cleanup(env);
});

test('7 retries until tests pass', async () => {
  const env = fresh();
  let execCalls = 0;
  const p = new TestSynthesisPipeline(env.store, {
    planner: plannerOk(),
    generator: generatorOk(),
    executor: async () => {
      execCalls++;
      return execCalls >= 2 ? { passed: 3, failed: 0 } : { passed: 0, failed: 2 };
    },
    reviewer: reviewerReject(),
    maxIterations: 5,
  });
  const r = await p.synthesize('problem', 'code');
  assert.equal(r.ok, true);
  assert.equal(r.status, 'passed');
  assert.equal(r.iterations, 2);
  assert.equal(execCalls, 2);
  cleanup(env);
});

test('8 max iterations exhausted', async () => {
  const env = fresh();
  const p = new TestSynthesisPipeline(env.store, {
    planner: plannerOk(),
    generator: generatorOk(),
    executor: executorSomeFail(),
    reviewer: reviewerReject(),
    maxIterations: 3,
  });
  const r = await p.synthesize('problem', 'code');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'max_iterations');
  assert.equal(r.iterations, 3);
  cleanup(env);
});

test('9 reviewer fails', async () => {
  const env = fresh();
  const p = new TestSynthesisPipeline(env.store, {
    planner: plannerOk(),
    generator: generatorOk(),
    executor: executorSomeFail(),
    reviewer: async () => { throw new Error('reviewer broke'); },
  });
  const r = await p.synthesize('problem', 'code');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'reviewer_failed');
  cleanup(env);
});

test('10 constructor validates inputs', () => {
  assert.throws(() => new TestSynthesisPipeline(null, {}),
    (e) => e instanceof TestSynthesisError && e.code === 'bad_store');
  assert.throws(() => new TestSynthesisPipeline({}, {}),
    (e) => e instanceof TestSynthesisError && e.code === 'bad_planner');
  assert.throws(() => new TestSynthesisPipeline({}, { planner: () => {} }),
    (e) => e instanceof TestSynthesisError && e.code === 'bad_generator');
  assert.throws(() => new TestSynthesisPipeline({}, { planner: () => {}, generator: () => {} }),
    (e) => e instanceof TestSynthesisError && e.code === 'bad_executor');
  assert.throws(
    () => new TestSynthesisPipeline({}, { planner: () => {}, generator: () => {}, executor: () => {} }),
    (e) => e instanceof TestSynthesisError && e.code === 'bad_reviewer');
});

test('11 history records runs', async () => {
  const env = fresh();
  const p = new TestSynthesisPipeline(env.store, {
    planner: plannerOk(),
    generator: generatorOk(),
    executor: executorAllPass(),
    reviewer: reviewerReject(),
  });
  await p.synthesize('p1', 'c1');
  await p.synthesize('p2', 'c2');
  await p.synthesize('p3', 'c3');
  const rows = p.history({});
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.ok(r.problem_hash);
    assert.ok(r.candidate_hash);
    assert.equal(r.status, 'passed');
  }
  cleanup(env);
});

test('12 bad inputs rejected', async () => {
  const env = fresh();
  const p = new TestSynthesisPipeline(env.store, {
    planner: plannerOk(),
    generator: generatorOk(),
    executor: executorAllPass(),
    reviewer: reviewerReject(),
  });
  await assert.rejects(() => p.synthesize('', 'code'),
    (e) => e instanceof TestSynthesisError && e.code === 'bad_problem');
  await assert.rejects(() => p.synthesize('problem', ''),
    (e) => e instanceof TestSynthesisError && e.code === 'bad_code');
  cleanup(env);
});
