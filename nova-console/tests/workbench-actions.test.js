'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { WorkbenchActions, WorkbenchActionError } = require('../lib/workbench-actions');
const { RollbackManager } = require('../lib/rollback');
const { KillSwitch } = require('../lib/killswitch');
const { PolicyEngine } = require('../lib/policy');
const { JobEngine } = require('../lib/jobs');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-wba-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  return { dir, db, store };
}
function cleanup(env) {
  try { env.db.close(); } catch {}
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch {}
}

function wire(env) {
  const rollback = new RollbackManager(env.store, { domains: ['workspace'] });
  const killSwitch = new KillSwitch(env.store, { authFn: (c) => c === 'ok' });
  const policy = new PolicyEngine(env.store);
  const jobs = new JobEngine(env.store, { pollMs: 5000 });
  jobs.register('noop', async () => 'done');
  const actions = new WorkbenchActions(env.store, { rollback, killSwitch, policy, jobs });
  return { rollback, killSwitch, policy, jobs, actions };
}

test('1 resolve_quarantine_applied', () => {
  const env = fresh();
  const { rollback, actions } = wire(env);
  const q = rollback.quarantine('workspace', { reason: 'lint failed' });
  const r = actions.resolveQuarantine({ id: q.id, decision: 'applied', operator: 'alice', note: 'kept' });
  assert.equal(r.ok, true);
  assert.equal(r.quarantine.status, 'applied');
  assert.equal(r.quarantine.resolved_by, 'alice');
  assert.equal(r.quarantine.resolution_note, 'kept');
  assert.ok(r.audit_id);
  cleanup(env);
});

test('2 resolve_quarantine_discarded', () => {
  const env = fresh();
  const { rollback, actions } = wire(env);
  const q = rollback.quarantine('workspace', { reason: 'noise' });
  const r = actions.resolveQuarantine({ id: q.id, decision: 'discarded', operator: 'bob' });
  assert.equal(r.quarantine.status, 'discarded');
  cleanup(env);
});

test('3 resolve_quarantine_audit_recorded', () => {
  const env = fresh();
  const { rollback, actions } = wire(env);
  const q = rollback.quarantine('workspace', { reason: 'x' });
  actions.resolveQuarantine({ id: q.id, decision: 'applied', operator: 'carol' });
  const lineage = env.store.autonomyLineageList({});
  const hit = lineage.find((r) => JSON.parse(r.payload_json).quarantine_id === q.id);
  assert.ok(hit);
  assert.equal(hit.status, 'ok');
  cleanup(env);
});

test('4 resolve_quarantine_requires_operator', () => {
  const env = fresh();
  const { rollback, actions } = wire(env);
  const q = rollback.quarantine('workspace', { reason: 'x' });
  assert.throws(
    () => actions.resolveQuarantine({ id: q.id, decision: 'applied' }),
    (e) => e instanceof WorkbenchActionError && e.code === 'bad_operator'
  );
  assert.throws(
    () => actions.resolveQuarantine({ id: q.id, decision: 'applied', operator: '   ' }),
    (e) => e instanceof WorkbenchActionError && e.code === 'bad_operator'
  );
  cleanup(env);
});

test('5 cancel_queued_job', () => {
  const env = fresh();
  const { jobs, actions } = wire(env);
  const job = jobs.enqueue('noop', {});
  const r = actions.cancelJob({ id: job.id, operator: 'alice' });
  assert.equal(r.ok, true);
  assert.equal(env.store.jobsGet(job.id).state, 'cancelled');
  cleanup(env);
});

test('6 cancel_finished_job_rejected', () => {
  const env = fresh();
  const { actions } = wire(env);
  env.store.jobsInsert({
    id: 'job_done', kind: 'noop', state: 'completed',
    payload_json: '{}', run_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    timeout_ms: 1000, attempts: 1, max_attempts: 1,
  });
  assert.throws(
    () => actions.cancelJob({ id: 'job_done', operator: 'alice' }),
    (e) => e instanceof WorkbenchActionError && e.code === 'not_cancellable'
  );
  cleanup(env);
});

test('7 cancel_missing_job_rejected', () => {
  const env = fresh();
  const { actions } = wire(env);
  assert.throws(
    () => actions.cancelJob({ id: 'nope', operator: 'alice' }),
    (e) => e instanceof WorkbenchActionError && e.code === 'not_found'
  );
  cleanup(env);
});

test('8 halt_and_resume', () => {
  const env = fresh();
  const { actions } = wire(env);
  const h = actions.haltRuntime({ operator: 'alice', reason: 'emergency' });
  assert.equal(h.ok, true);
  assert.equal(h.event.action, 'halt');
  const rs = actions.resumeRuntime({ operator: 'bob', reason: 'resolved', credential: 'ok' });
  assert.equal(rs.ok, true);
  assert.equal(rs.event.action, 'resume');
  cleanup(env);
});

test('9 resume_requires_valid_credential', () => {
  const env = fresh();
  const { actions } = wire(env);
  actions.haltRuntime({ operator: 'alice', reason: 'x' });
  assert.throws(
    () => actions.resumeRuntime({ operator: 'bob', reason: 'x', credential: 'wrong' }),
    (e) => e.code === 'auth_failed'
  );
  cleanup(env);
});

test('10 revoke_policy', () => {
  const env = fresh();
  const { policy, actions } = wire(env);
  const p = policy.grant({
    subject: { type: 'agent', id: 'a' },
    resource: { type: 'tool', id: 't' },
    effect: 'allow',
  });
  const r = actions.revokePolicy({ id: p.id, operator: 'alice' });
  assert.equal(r.ok, true);
  assert.equal(r.policy.revoked_at != null, true);
  const decision = policy.check({ type: 'agent', id: 'a' }, { type: 'tool', id: 't' });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'policy_revoked');
  cleanup(env);
});

test('11 every_action_writes_audit', () => {
  const env = fresh();
  const { rollback, policy, actions } = wire(env);
  const q = rollback.quarantine('workspace', { reason: 'x' });
  const p = policy.grant({
    subject: { type: 'agent', id: 'a' },
    resource: { type: 'tool', id: 't' },
    effect: 'allow',
  });

  actions.resolveQuarantine({ id: q.id, decision: 'applied', operator: 'op1' });
  actions.haltRuntime({ operator: 'op2', reason: 'r' });
  actions.revokePolicy({ id: p.id, operator: 'op3' });

  const lineage = env.store.autonomyLineageList({});
  const actionsSeen = lineage.map((r) => r.status);
  assert.ok(actionsSeen.includes('ok'));

    const payloads = lineage.map((r) => JSON.parse(r.payload_json));
  const tags = payloads.map((p) => p.workbench_action).filter(Boolean);
  assert.ok(tags.some((t) => /workbench\.quarantine\.resolve/.test(t)),
    'expected workbench.quarantine.resolve in audit payloads, got ' + JSON.stringify(tags));
  assert.ok(tags.some((t) => /workbench\.runtime\.halt/.test(t)),
    'expected workbench.runtime.halt in audit payloads, got ' + JSON.stringify(tags));
  assert.ok(tags.some((t) => /workbench\.policy\.revoke/.test(t)),
    'expected workbench.policy.revoke in audit payloads, got ' + JSON.stringify(tags));
  cleanup(env);
});

test('12 constructor_and_input_validation', () => {
  assert.throws(() => new WorkbenchActions(null),
    (e) => e instanceof WorkbenchActionError && e.code === 'bad_store');

  const env = fresh();
  const { actions } = wire(env);
  assert.throws(
    () => actions.resolveQuarantine({ id: 'x', decision: 'applied', operator: 'a' }),
    (e) => e.code === 'not_found' || e.code === 'bad_id'
  );

  const env2 = fresh();
  const bare = new WorkbenchActions(env2.store, {});
  assert.throws(
    () => bare.resolveQuarantine({ id: 'x', decision: 'applied', operator: 'a' }),
    (e) => e.code === 'no_rollback'
  );
  assert.throws(
    () => bare.cancelJob({ id: 'x', operator: 'a' }),
    (e) => e.code === 'no_jobs'
  );
  assert.throws(
    () => bare.haltRuntime({ operator: 'a', reason: 'r' }),
    (e) => e.code === 'no_killswitch'
  );
  assert.throws(
    () => bare.revokePolicy({ id: 'x', operator: 'a' }),
    (e) => e.code === 'no_policy'
  );
  cleanup(env);
  cleanup(env2);
});
