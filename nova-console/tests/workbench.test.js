'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { Workbench, WorkbenchError } = require('../lib/workbench');
const { PolicyEngine } = require('../lib/policy');
const { BudgetEngine } = require('../lib/budgets');
const { KillSwitch } = require('../lib/killswitch');
const { RollbackManager } = require('../lib/rollback');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-workbench-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  return { dir, db, store };
}

function cleanup(env) {
  try { env.db.close(); } catch { /* noop */ }
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch { /* noop */ }
}

test('1 empty_snapshot_shape', () => {
  const env = fresh();
  const wb = new Workbench(env.store);
  const s = wb.snapshot();
  assert.ok(s.generated_at);
  assert.ok(s.now && typeof s.now.queued === 'number');
  assert.ok(s.allowed && typeof s.allowed.kill_switch.halted === 'boolean');
  assert.ok(s.waiting && typeof s.waiting.pending_quarantines === 'number');
  assert.ok(s.failed && typeof s.failed.failed_jobs === 'number');
  assert.ok(s.created && Array.isArray(s.created.green_commits));
  assert.ok(s.system && s.system.ok === true);
  cleanup(env);
});

test('2 jobs_visible_in_now', () => {
  const env = fresh();
  const now = new Date().toISOString();
  env.store.jobsInsert({ id: 'job-1', kind: 'test', state: 'queued', payload_json: '{}', run_at: now, created_at: now, timeout_ms: 1000, attempts: 0, max_attempts: 1 });
  env.store.jobsInsert({ id: 'job-2', kind: 'test', state: 'running', payload_json: '{}', run_at: now, created_at: now, timeout_ms: 1000, attempts: 0, max_attempts: 1, started_at: now });

  const wb = new Workbench(env.store);
  const s = wb.snapshot();
  assert.equal(s.now.queued, 1);
  assert.equal(s.now.running, 1);
  assert.equal(s.now.running_jobs[0].id, 'job-2');
  cleanup(env);
});

test('3 kill_switch_halted_visible', () => {
  const env = fresh();
  const ks = new KillSwitch(env.store);
  ks.halt('alice', 'testing halt');
  const wb = new Workbench(env.store);
  const s = wb.snapshot();
  assert.equal(s.allowed.kill_switch.halted, true);
  assert.equal(s.allowed.kill_switch.reason, 'testing halt');
  assert.equal(s.allowed.kill_switch.operator, 'alice');
  cleanup(env);
});

test('4 policies_and_budgets_visible', () => {
  const env = fresh();
  const policy = new PolicyEngine(env.store);
  policy.grant({ subject: { type: 'agent', id: 'a' }, resource: { type: 'tool', id: 't' }, effect: 'allow' });
  const budgets = new BudgetEngine(env.store);
  budgets.setBudget({ subject: { type: 'agent', id: 'a' }, limits: { tokens: 1000 } });
  budgets.charge({ type: 'agent', id: 'a' }, 'tokens', 250);
  const wb = new Workbench(env.store);
  const s = wb.snapshot();
  assert.equal(s.allowed.policies.total, 1);
  assert.equal(s.allowed.policies.active, 1);
  assert.equal(s.allowed.budgets.length, 1);
  assert.equal(s.allowed.budgets[0].usage.tokens.used, 250);
  assert.equal(s.allowed.budgets[0].usage.tokens.limit, 1000);
  cleanup(env);
});

test('5 pending_quarantines_surface', () => {
  const env = fresh();
  const rb = new RollbackManager(env.store, { domains: ['workspace'] });
  rb.quarantine('workspace', { reason: 'test failed', taskId: 'task-1' });
  rb.quarantine('workspace', { reason: 'compile failed', taskId: 'task-2' });
  const wb = new Workbench(env.store);
  const s = wb.snapshot();
  assert.equal(s.waiting.pending_quarantines, 2);
  const reasons = s.waiting.quarantines.map((q) => q.reason).sort();
  assert.deepEqual(reasons, ['compile failed', 'test failed']);
  cleanup(env);
});

test('6 failed_jobs_and_rollbacks_surface', () => {
  const env = fresh();
  const now = new Date().toISOString();

  env.store.jobsInsert({ id: 'job-f', kind: 'test', state: 'failed', payload_json: '{}', run_at: now, created_at: now, timeout_ms: 1000, attempts: 2, max_attempts: 2, error: 'train failed', ended_at: now }); 
env.store.rollbackEventsInsert({ id: 'rb-1', domain: 'workspace', reason: 'lint failed', from_sha: 'old', to_sha: 'green', outcome: 'rolled_back', timestamp: new Date().toISOString() });
 const wb = new Workbench(env.store);
  const s = wb.snapshot();
  assert.equal(s.failed.failed_jobs, 1);
  assert.equal(s.failed.recent_rollbacks.length, 1);
  assert.equal(s.failed.recent_rollbacks[0].reason, 'lint failed');
  cleanup(env);
});

test('7 created_surface_green_commits', () => {
  const env = fresh();
  const rb = new RollbackManager(env.store, { domains: ['workspace'] });
  rb.setGreen('workspace', 'abc123', { note: 'first green' }, 'tester');
  const wb = new Workbench(env.store);
  const s = wb.snapshot();
  assert.equal(s.created.green_commits.length, 1);
  assert.equal(s.created.green_commits[0].sha, 'abc123');
  assert.equal(s.created.green_commits[0].set_by, 'tester');
  cleanup(env);
});

test('8 system_readiness_all_green', () => {
  const env = fresh();
  const wb = new Workbench(env.store);
  const s = wb.snapshot();
  assert.equal(s.system.ok, true);
  assert.equal(s.system.checks.length, 6);
  for (const c of s.system.checks) assert.equal(c.ok, true, `check ${c.id} should pass`);
  cleanup(env);
});

test('9 snapshot_is_idempotent', () => {
  const env = fresh();
  const wb = new Workbench(env.store, { now: () => '2026-01-01T00:00:00Z' });
  const a = wb.snapshot();
  const b = wb.snapshot();
  assert.deepEqual(a, b);
  cleanup(env);
});

test('10 snapshot_does_not_mutate', () => {
  const env = fresh();
  const beforeJobs = env.store.jobsListByState('queued').length;
  const beforePolicies = env.store.policiesList({}).length;
  const beforeLineage = env.store.autonomyLineageList({}).length;
  const wb = new Workbench(env.store);
  wb.snapshot();
  const afterJobs = env.store.jobsListByState('queued').length;
  const afterPolicies = env.store.policiesList({}).length;
  const afterLineage = env.store.autonomyLineageList({}).length;
  assert.equal(afterJobs, beforeJobs);
  assert.equal(afterPolicies, beforePolicies);
  assert.equal(afterLineage, beforeLineage);
  cleanup(env);
});

test('11 recent_denials_surface', () => {
  const env = fresh();
  const policy = new PolicyEngine(env.store);
  policy.check({ type: 'agent', id: 'a' }, { type: 'tool', id: 't' });
  const wb = new Workbench(env.store);
  const s = wb.snapshot();
  assert.equal(s.waiting.recent_policy_denials_1h, 1);
  assert.equal(s.waiting.recent_denials[0].reason, 'policy_denied');
  cleanup(env);
});

test('12 workbench_requires_store', () => {
  assert.throws(() => new Workbench(null), (e) => e instanceof WorkbenchError && e.code === 'bad_store');
});
