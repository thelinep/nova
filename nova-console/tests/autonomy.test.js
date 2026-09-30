'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { AutonomyLoop, EscalationError, AutonomyError } = require('../lib/autonomy');
const { PolicyEngine } = require('../lib/policy');
const { BudgetEngine } = require('../lib/budgets');
const { KillSwitch } = require('../lib/killswitch');
const { RollbackManager } = require('../lib/rollback');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-autonomy-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  return { dir, db, store };
}

function cleanup(env) {
  try { env.db.close(); } catch { /* noop */ }
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch { /* noop */ }
}

function goodTrainer() {
  return async () => ({
    artifactId: 'art-1',
    commit: 'commit-1',
    usage: { tokens: 100, usd: 0.1 },
  });
}

function badScoreEvaluator(score) {
  return async () => ({ score });
}

function passthroughPolicy(store) {
  const p = new PolicyEngine(store);
  p.grant({
    subject: { type: 'agent', id: 'neuron-factory' },
    resource: { type: 'domain', id: 'neuron-factory' },
    effect: 'allow',
  });
  return p;
}

test('1 happy_path_auto_approves', async () => {
  const env = fresh();
  const loop = new AutonomyLoop(env.store, {
    trainer: goodTrainer(),
    evaluator: badScoreEvaluator(0.95),
    policy: passthroughPolicy(env.store),
    acceptanceThreshold: 0.85,
  });
  const r = await loop.runOnce({ blueprintId: 'bp-1' });
  assert.equal(r.ok, true);
  assert.equal(r.escalated, false);
  assert.equal(r.artifactId, 'art-1');
  assert.equal(r.score, 0.95);
  assert.equal(r.lineage.status, 'approved');
  cleanup(env);
});

test('2 below_threshold_escalates', async () => {
  const env = fresh();
  const loop = new AutonomyLoop(env.store, {
    trainer: goodTrainer(),
    evaluator: badScoreEvaluator(0.6),
    policy: passthroughPolicy(env.store),
  });
  const r = await loop.runOnce({ blueprintId: 'bp-1' });
  assert.equal(r.ok, false);
  assert.equal(r.escalated, false);
  assert.equal(r.reason, 'below_threshold');
  cleanup(env);
});

test('3 three_consecutive_failures_escalate', async () => {
  const env = fresh();
  const loop = new AutonomyLoop(env.store, {
    trainer: goodTrainer(),
    evaluator: badScoreEvaluator(0.5),
    policy: passthroughPolicy(env.store),
    maxConsecutiveFailures: 3,
  });
  const r1 = await loop.runOnce({});
  const r2 = await loop.runOnce({});
  const r3 = await loop.runOnce({});
  assert.equal(r1.escalated, false);
  assert.equal(r2.escalated, false);
  assert.equal(r3.escalated, true);
  assert.equal(r3.reason, 'consecutive_failures');
  cleanup(env);
});

test('4 kill_switch_escalates_immediately', async () => {
  const env = fresh();
  const ks = new KillSwitch(env.store);
  ks.halt('op', 'test halt');
  const loop = new AutonomyLoop(env.store, {
    trainer: goodTrainer(),
    evaluator: badScoreEvaluator(0.99),
    policy: passthroughPolicy(env.store),
    killSwitch: ks,
  });
  const r = await loop.runOnce({});
  assert.equal(r.ok, false);
  assert.equal(r.escalated, true);
  assert.equal(r.reason, 'kill_switch_active');
  cleanup(env);
});

test('5 policy_denied_escalates', async () => {
  const env = fresh();
  const policy = new PolicyEngine(env.store); // no grants — default deny
  const loop = new AutonomyLoop(env.store, {
    trainer: goodTrainer(),
    evaluator: badScoreEvaluator(0.99),
    policy,
  });
  const r = await loop.runOnce({});
  assert.equal(r.ok, false);
  assert.equal(r.escalated, true);
  assert.equal(r.reason, 'policy_denied');
  cleanup(env);
});

test('6 budget_exceeded_escalates', async () => {
  const env = fresh();
  const budgets = new BudgetEngine(env.store);
  budgets.setBudget({
    subject: { type: 'agent', id: 'neuron-factory' },
    limits: { tokens: 1 },
  });
  budgets.charge({ type: 'agent', id: 'neuron-factory' }, 'tokens', 10);
  const loop = new AutonomyLoop(env.store, {
    trainer: goodTrainer(),
    evaluator: badScoreEvaluator(0.99),
    policy: passthroughPolicy(env.store),
    budgets,
  });
  const r = await loop.runOnce({});
  assert.equal(r.ok, false);
  assert.equal(r.escalated, true);
  assert.equal(r.reason, 'budget_exceeded');
  cleanup(env);
});

test('7 trainer_failure_no_escalation', async () => {
  const env = fresh();
  const loop = new AutonomyLoop(env.store, {
    trainer: async () => { throw new Error('oom'); },
    evaluator: badScoreEvaluator(0.99),
    policy: passthroughPolicy(env.store),
  });
  const r = await loop.runOnce({});
  assert.equal(r.ok, false);
  assert.equal(r.escalated, false);
  assert.equal(r.phase, 'train');
  assert.match(r.error, /oom/);
  cleanup(env);
});

test('8 external_approver_required_when_configured', async () => {
  const env = fresh();
  let approverCalled = false;
  const loop = new AutonomyLoop(env.store, {
    trainer: goodTrainer(),
    evaluator: badScoreEvaluator(0.95),
    policy: passthroughPolicy(env.store),
    approver: async () => { approverCalled = true; return { approved: false }; },
  });
  const r = await loop.runOnce({});
  assert.equal(approverCalled, true);
  assert.equal(r.ok, false);
  assert.equal(r.escalated, true);
  assert.equal(r.reason, 'approval_denied');
  cleanup(env);
});

test('9 lineage_records_full_run', async () => {
  const env = fresh();
  const loop = new AutonomyLoop(env.store, {
    trainer: goodTrainer(),
    evaluator: badScoreEvaluator(0.9),
    policy: passthroughPolicy(env.store),
  });
  const r = await loop.runOnce({ blueprintId: 'bp-lineage' });
  const rows = env.store.autonomyLineageList({ run_id: r.lineage.run_id });
  assert.ok(rows.length >= 2);
  const statuses = rows.map((x) => x.status);
  assert.ok(statuses.includes('started'));
  assert.ok(statuses.includes('approved'));
  const last = rows[rows.length - 1];
  const payload = JSON.parse(last.payload_json);
  assert.equal(payload.blueprint_id, 'bp-lineage');
  assert.equal(payload.threshold, 0.85);
  cleanup(env);
});

test('10 budget_charged_after_training', async () => {
  const env = fresh();
  const budgets = new BudgetEngine(env.store);
  budgets.setBudget({
    subject: { type: 'agent', id: 'neuron-factory' },
    limits: { tokens: 10000, usd: 100, jobs: 10 },
  });
  const loop = new AutonomyLoop(env.store, {
    trainer: goodTrainer(),
    evaluator: badScoreEvaluator(0.9),
    policy: passthroughPolicy(env.store),
    budgets,
  });
  await loop.runOnce({});
  const usage = budgets.usage({ type: 'agent', id: 'neuron-factory' });
  const budgetId = Object.keys(usage)[0];
  assert.equal(usage[budgetId].kinds.tokens.used, 100);
  assert.equal(usage[budgetId].kinds.usd.used, 0.1);
  assert.equal(usage[budgetId].kinds.jobs.used, 1);
  cleanup(env);
});

test('11 runMany_stops_on_escalation', async () => {
  const env = fresh();
  let calls = 0;
  const loop = new AutonomyLoop(env.store, {
    trainer: async () => { calls += 1; return { artifactId: `a-${calls}`, commit: `c-${calls}` }; },
    evaluator: async () => ({ score: 0.5 }),
    policy: passthroughPolicy(env.store),
    maxConsecutiveFailures: 3,
  });
  const results = await loop.runMany([{}, {}, {}, {}, {}]);
  // First 2 below threshold (not escalated); 3rd escalates; loop breaks after 3
  assert.equal(results.length, 3);
  assert.equal(results[0].escalated, false);
  assert.equal(results[1].escalated, false);
  assert.equal(results[2].escalated, true);
  cleanup(env);
});

test('12 success_resets_failure_counter', async () => {
  const env = fresh();
  let call = 0;
  const loop = new AutonomyLoop(env.store, {
    trainer: goodTrainer(),
    evaluator: async () => {
      call += 1;
      return { score: call === 3 ? 0.95 : 0.5 };
    },
    policy: passthroughPolicy(env.store),
    maxConsecutiveFailures: 3,
  });
  await loop.runOnce({});
  await loop.runOnce({});
  const r = await loop.runOnce({});
  assert.equal(r.ok, true);
  const s = loop.summary();
  assert.equal(s.consecutiveFailures, 0);
  cleanup(env);
});
