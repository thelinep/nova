'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { ActivationLadder, ActivationError } = require('../lib/activation');
const { PolicyEngine } = require('../lib/policy');
const { RollbackManager } = require('../lib/rollback');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-activation-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  return { dir, db, store };
}
function cleanup(env) {
  try { env.db.close(); } catch {}
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch {}
}

test('1 fresh_install_only_runtime_done', () => {
  const env = fresh();
  const ladder = new ActivationLadder(env.store);
  const s = ladder.snapshot();
  assert.equal(s.total, 5);
  assert.equal(s.completed, 1);
  assert.equal(s.done, false);
  assert.equal(s.steps[0].id, 'runtime');
  assert.equal(s.steps[0].done, true);
  for (let i = 1; i < 5; i++) {
    assert.equal(s.steps[i].done, false, s.steps[i].id + ' should be undone');
  }
  assert.equal(s.next_step.id, 'model');
  cleanup(env);
});

test('2 qualified_model_advances', () => {
  const env = fresh();
  env.store.put('modelQualifications', {
    id: 'q1', model: 'llama3.2:latest', status: 'qualified',
  });
  const ladder = new ActivationLadder(env.store);
  const s = ladder.snapshot();
  const model = s.steps.find((x) => x.id === 'model');
  assert.equal(model.done, true);
  assert.match(model.detail, /qualified/);
  assert.equal(s.next_step.id, 'outcome');
  cleanup(env);
});

test('3 passed_true_also_counts', () => {
  const env = fresh();
  env.store.put('modelQualifications', {
    id: 'q1', model: 'm', passed: true,
  });
  const ladder = new ActivationLadder(env.store);
  const s = ladder.snapshot();
  assert.equal(s.steps.find((x) => x.id === 'model').done, true);
  cleanup(env);
});

test('4 outcome_via_document', () => {
  const env = fresh();
  env.store.put('knowledgeDocuments', { id: 'd1', title: 'note' });
  const ladder = new ActivationLadder(env.store);
  const s = ladder.snapshot();
  const outcome = s.steps.find((x) => x.id === 'outcome');
  assert.equal(outcome.done, true);
  assert.match(outcome.detail, /documents/);
  cleanup(env);
});

test('5 outcome_via_completed_job', () => {
  const env = fresh();
  env.store.jobsInsert({
    id: 'j1', kind: 'x', state: 'completed',
    payload_json: '{}', run_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    timeout_ms: 1000, attempts: 1, max_attempts: 1,
  });
  const ladder = new ActivationLadder(env.store);
  const s = ladder.snapshot();
  const outcome = s.steps.find((x) => x.id === 'outcome');
  assert.equal(outcome.done, true);
  assert.match(outcome.detail, /jobs/);
  cleanup(env);
});

test('6 outcome_via_conversation', () => {
  const env = fresh();
  env.store.put('sessions', {
    id: 's1', title: 'chat',
    messages: [{ role: 'user', content: 'hi' }],
  });
  const ladder = new ActivationLadder(env.store);
  const s = ladder.snapshot();
  assert.equal(s.steps.find((x) => x.id === 'outcome').done, true);
  cleanup(env);
});

test('7 capability_via_policy', () => {
  const env = fresh();
  const p = new PolicyEngine(env.store);
  p.grant({
    subject: { type: 'agent', id: 'a' },
    resource: { type: 'tool', id: 't' },
    effect: 'allow',
  });
  const ladder = new ActivationLadder(env.store);
  const s = ladder.snapshot();
  const cap = s.steps.find((x) => x.id === 'capability');
  assert.equal(cap.done, true);
  assert.match(cap.detail, /policies/);
  cleanup(env);
});

test('8 capability_via_skill', () => {
  const env = fresh();
  env.store.put('skills', { id: 'sk1', enabled: true });
  const ladder = new ActivationLadder(env.store);
  const s = ladder.snapshot();
  assert.equal(s.steps.find((x) => x.id === 'capability').done, true);
  cleanup(env);
});

test('9 capability_via_mcp', () => {
  const env = fresh();
  env.store.put('mcpServers', { id: 'm1', status: 'connected' });
  const ladder = new ActivationLadder(env.store);
  const s = ladder.snapshot();
  assert.equal(s.steps.find((x) => x.id === 'capability').done, true);
  cleanup(env);
});

test('10 verified_via_correctness_run', () => {
  const env = fresh();
  env.store.correctnessPipelineRunsInsert({
    id: 'cpp_1', problem_hash: 'x', status: 'verified', stage: 'done',
    started_at: '2026-10-01T00:00:00Z',
  });
  const ladder = new ActivationLadder(env.store);
  const s = ladder.snapshot();
  const v = s.steps.find((x) => x.id === 'verified');
  assert.equal(v.done, true);
  assert.match(v.detail, /pipeline runs/);
  cleanup(env);
});

test('11 verified_via_green_commit', () => {
  const env = fresh();
  const rb = new RollbackManager(env.store, { domains: ['workspace'] });
  rb.setGreen('workspace', 'abc123', null, 'tester');
  const ladder = new ActivationLadder(env.store);
  const s = ladder.snapshot();
  assert.equal(s.steps.find((x) => x.id === 'verified').done, true);
  cleanup(env);
});

test('12 complete_ladder', () => {
  const env = fresh();
  env.store.put('modelQualifications', { id: 'q1', model: 'm', status: 'qualified' });
  env.store.put('sessions', { id: 's1', messages: [{ role: 'user', content: 'hi' }] });
  env.store.put('skills', { id: 'sk1', enabled: true });
  const rb = new RollbackManager(env.store, { domains: ['workspace'] });
  rb.setGreen('workspace', 'abc123');
  const ladder = new ActivationLadder(env.store);
  const s = ladder.snapshot();
  assert.equal(s.completed, 5);
  assert.equal(s.done, true);
  assert.equal(s.next_step, null);
  cleanup(env);
});

test('13 snapshot_is_idempotent', () => {
  const env = fresh();
  const ladder = new ActivationLadder(env.store, { now: () => '2026-01-01T00:00:00Z' });
  const a = ladder.snapshot();
  const b = ladder.snapshot();
  assert.deepEqual(a, b);
  cleanup(env);
});

test('14 snapshot_does_not_mutate', () => {
  const env = fresh();
  const before = env.store.all('skills').length;
  new ActivationLadder(env.store).snapshot();
  const after = env.store.all('skills').length;
  assert.equal(after, before);
  cleanup(env);
});

test('15 constructor_validates', () => {
  assert.throws(
    () => new ActivationLadder(null),
    (e) => e instanceof ActivationError && e.code === 'bad_store'
  );
});
