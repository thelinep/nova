'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { WorkspaceAutonomy, WorkspaceAutonomyError } = require('../lib/workspace-autonomy');
const { PolicyEngine } = require('../lib/policy');
const { BudgetEngine } = require('../lib/budgets');
const { KillSwitch } = require('../lib/killswitch');
const { RollbackManager } = require('../lib/rollback');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-wsauto-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  return { dir, db, store };
}

function cleanup(env) {
  try { env.db.close(); } catch { /* noop */ }
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch { /* noop */ }
}

function permissivePolicy(store) {
  const p = new PolicyEngine(store);
  p.grant({
    subject: { type: 'agent', id: 'workspace-agent' },
    resource: { type: 'domain', id: 'workspace-patches' },
    effect: 'allow',
  });
  return p;
}

function okDeps(overrides) {
  return Object.assign({
    applier: async () => ({
      applied: true, sandboxPath: '/tmp/sandbox',
      files: ['src/a.js'], diff: '@@ fake diff @@',
    }),
    tester: async () => ({ ok: true, summary: 'all green' }),
    committer: async () => ({ sha: 'abc123', branch: 'nova/auto' }),
    rooter: () => true,
  }, overrides || {});
}

test('1 happy_path_commits', async () => {
  const env = fresh();
  const ws = new WorkspaceAutonomy(env.store, okDeps({ policy: permissivePolicy(env.store) }));
  const r = await ws.runOnce({ changes: [{ path: 'src/a.js', from: 'x', to: 'y' }] });
  assert.equal(r.ok, true);
  assert.equal(r.branch, 'nova/auto');
  assert.equal(r.sha, 'abc123');
  assert.equal(r.files.length, 1);
  const rows = env.store.workspacePatchesList({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'approved');
  cleanup(env);
});

test('2 kill_switch_escalates', async () => {
  const env = fresh();
  const ks = new KillSwitch(env.store);
  ks.halt('op', 'test');
  const ws = new WorkspaceAutonomy(env.store, okDeps({ policy: permissivePolicy(env.store), killSwitch: ks }));
  const r = await ws.runOnce({ changes: [] });
  assert.equal(r.ok, false);
  assert.equal(r.escalated, true);
  assert.equal(r.reason, 'kill_switch_active');
  cleanup(env);
});

test('3 policy_denied_escalates', async () => {
  const env = fresh();
  const ws = new WorkspaceAutonomy(env.store, okDeps({ policy: new PolicyEngine(env.store) }));
  const r = await ws.runOnce({ changes: [] });
  assert.equal(r.ok, false);
  assert.equal(r.escalated, true);
  assert.equal(r.reason, 'policy_denied');
  cleanup(env);
});

test('4 budget_exceeded_escalates', async () => {
  const env = fresh();
  const budgets = new BudgetEngine(env.store);
  budgets.setBudget({ subject: { type: 'agent', id: 'workspace-agent' }, limits: { jobs: 1 } });
  budgets.charge({ type: 'agent', id: 'workspace-agent' }, 'jobs', 1);
  const ws = new WorkspaceAutonomy(env.store, okDeps({ policy: permissivePolicy(env.store), budgets }));
  const r = await ws.runOnce({});
  assert.equal(r.ok, false);
  assert.equal(r.escalated, true);
  assert.equal(r.reason, 'budget_exceeded');
  cleanup(env);
});

test('5 outside_roots_escalates', async () => {
  const env = fresh();
  const ws = new WorkspaceAutonomy(env.store, okDeps({
    policy: permissivePolicy(env.store),
    applier: async () => ({
      applied: true, sandboxPath: '/tmp/sb',
      files: ['src/a.js', '/etc/passwd'], diff: '@@ diff @@',
    }),
    rooter: (f) => f.startsWith('src/'),
  }));
  const r = await ws.runOnce({});
  assert.equal(r.ok, false);
  assert.equal(r.escalated, true);
  assert.equal(r.reason, 'outside_roots');
  assert.deepEqual(r.outside, ['/etc/passwd']);
  cleanup(env);
});

test('6 schema_migration_escalates', async () => {
  const env = fresh();
  const ws = new WorkspaceAutonomy(env.store, okDeps({
    policy: permissivePolicy(env.store),
    applier: async () => ({
      applied: true, sandboxPath: '/tmp/sb', files: ['lib/db.js'],
      diff: '+ CREATE TABLE IF NOT EXISTS new_table (id TEXT);',
    }),
  }));
  const r = await ws.runOnce({});
  assert.equal(r.ok, false);
  assert.equal(r.escalated, true);
  assert.equal(r.reason, 'schema_migration_required');
  cleanup(env);
});

test('7 test_failure_no_escalation_first', async () => {
  const env = fresh();
  const ws = new WorkspaceAutonomy(env.store, okDeps({
    policy: permissivePolicy(env.store),
    tester: async () => ({ ok: false, summary: 'one test failed' }),
  }));
  const r = await ws.runOnce({});
  assert.equal(r.ok, false);
  assert.equal(r.escalated, false);
  assert.equal(r.reason, 'tests_failed');
  cleanup(env);
});

test('8 three_consecutive_test_failures_escalate', async () => {
  const env = fresh();
  const ws = new WorkspaceAutonomy(env.store, okDeps({
    policy: permissivePolicy(env.store),
    tester: async () => ({ ok: false, summary: 'fail' }),
    maxConsecutiveFailures: 3,
  }));
  const r1 = await ws.runOnce({});
  const r2 = await ws.runOnce({});
  const r3 = await ws.runOnce({});
  assert.equal(r1.escalated, false);
  assert.equal(r2.escalated, false);
  assert.equal(r3.escalated, true);
  assert.equal(r3.reason, 'consecutive_failures');
  cleanup(env);
});

test('9 apply_failure_records_error', async () => {
  const env = fresh();
  const ws = new WorkspaceAutonomy(env.store, okDeps({
    policy: permissivePolicy(env.store),
    applier: async () => { throw new Error('patch conflict'); },
  }));
  const r = await ws.runOnce({});
  assert.equal(r.ok, false);
  assert.equal(r.phase, 'apply');
  assert.match(r.error, /patch conflict/);
  assert.equal(r.patch.status, 'apply_failed');
  cleanup(env);
});

test('10 commit_failure_records_error', async () => {
  const env = fresh();
  const ws = new WorkspaceAutonomy(env.store, okDeps({
    policy: permissivePolicy(env.store),
    committer: async () => { throw new Error('git locked'); },
  }));
  const r = await ws.runOnce({});
  assert.equal(r.ok, false);
  assert.equal(r.phase, 'commit');
  assert.match(r.error, /git locked/);
  cleanup(env);
});

test('11 rollback_green_advanced_on_success', async () => {
  const env = fresh();
  const rollback = new RollbackManager(env.store, { domains: ['workspace-patches'] });
  const ws = new WorkspaceAutonomy(env.store, okDeps({
    policy: permissivePolicy(env.store),
    rollback,
    committer: async () => ({ sha: 'green-sha-1', branch: 'nova/auto' }),
  }));
  const r = await ws.runOnce({});
  assert.equal(r.ok, true);
  const g = rollback.getGreen('workspace-patches');
  assert.equal(g.sha, 'green-sha-1');
  cleanup(env);
});

test('12 runMany_stops_on_escalation', async () => {
  const env = fresh();
  let calls = 0;
  const ws = new WorkspaceAutonomy(env.store, okDeps({
    policy: permissivePolicy(env.store),
    applier: async () => {
      calls += 1;
      return { applied: true, sandboxPath: `/tmp/sb-${calls}`, files: ['src/x.js'], diff: '@@ d @@' };
    },
    tester: async () => ({ ok: false, summary: 'fail' }),
    maxConsecutiveFailures: 3,
  }));
  const results = await ws.runMany([{}, {}, {}, {}]);
  assert.equal(results.length, 3);
  assert.equal(results[0].escalated, false);
  assert.equal(results[1].escalated, false);
  assert.equal(results[2].escalated, true);
  cleanup(env);
});
