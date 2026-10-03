'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { AgentRegistry } = require('../lib/agents');
const { AgentTasks, AgentTaskError } = require('../lib/agent-tasks');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-atsk-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  const registry = new AgentRegistry(store);
  const tasks = new AgentTasks(store, { registry });
  return { dir, db, store, registry, tasks };
}
function cleanup(env) {
  try { env.db.close(); } catch {}
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch {}
}

test('1 create_queued_task_without_assignee', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'planner' });
  const t = env.tasks.create({ title: 'build X', creatorId: a.id });
  assert.ok(t.id.startsWith('tsk_'));
  assert.equal(t.state, 'queued');
  assert.equal(t.assignee_id, null);
  assert.equal(t.creator_id, a.id);
  cleanup(env);
});

test('2 create_assigned_task_with_assignee', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'planner' });
  const b = env.registry.create({ name: 'b', role: 'worker' });
  const t = env.tasks.create({ title: 'build X', creatorId: a.id, assigneeId: b.id });
  assert.equal(t.state, 'assigned');
  assert.equal(t.assignee_id, b.id);
  cleanup(env);
});

test('3 assign_queued_task', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'planner' });
  const b = env.registry.create({ name: 'b', role: 'worker' });
  const t = env.tasks.create({ title: 'x', creatorId: a.id });
  const updated = env.tasks.assign(t.id, b.id, a.id);
  assert.equal(updated.state, 'assigned');
  assert.equal(updated.assignee_id, b.id);
  cleanup(env);
});

test('4 start_requires_assignment', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'planner' });
  const t = env.tasks.create({ title: 'x', creatorId: a.id });
  assert.throws(() => env.tasks.start(t.id, a.id), (e) => e.code === 'not_assigned');
  cleanup(env);
});

test('5 full_lifecycle_to_completion', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'planner' });
  const b = env.registry.create({ name: 'b', role: 'worker' });
  const t = env.tasks.create({ title: 'x', creatorId: a.id, assigneeId: b.id });
  env.tasks.start(t.id, b.id);
  const done = env.tasks.complete(t.id, { ok: true }, b.id);
  assert.equal(done.state, 'completed');
  assert.equal(JSON.parse(done.result_json).ok, true);
  assert.ok(done.ended_at);
  cleanup(env);
});

test('5a execution_result_waits_for_explicit_local_review', () => {
  const env = fresh();
  const planner = env.registry.create({ name: 'planner', role: 'planner' });
  const worker = env.registry.create({ name: 'worker', role: 'worker' });
  const task = env.tasks.create({ title: 'propose change', creatorId: planner.id, assigneeId: worker.id });
  env.tasks.start(task.id, worker.id);

  const result = { summary: 'Draft only', changes: [{ relativePath: 'src/a.js' }] };
  const pending = env.tasks.awaitResultReview(task.id, result, worker.id);
  assert.equal(pending.state, 'awaiting_result_review');
  assert.deepEqual(JSON.parse(pending.result_json), result);
  assert.equal(pending.ended_at, null, 'a pending review has not ended the task');
  assert.equal(env.tasks.events(task.id).at(-1).kind, 'result_submitted_for_review');
  assert.equal(env.store.agentTasksList({ state: 'completed' }).length, 0);
  cleanup(env);
});

test('5b result_review_requires_actor_reason_and_terminal_decision_is_immutable', () => {
  const env = fresh();
  const planner = env.registry.create({ name: 'planner', role: 'planner' });
  const worker = env.registry.create({ name: 'worker', role: 'worker' });
  const task = env.tasks.create({ title: 'propose change', creatorId: planner.id, assigneeId: worker.id });
  env.tasks.start(task.id, worker.id);
  const pending = env.tasks.awaitResultReview(task.id, { summary: 'Draft' }, worker.id);

  assert.throws(() => env.tasks.acceptResult(task.id, '', 'looks good'), (e) => e.code === 'bad_review_actor');
  assert.throws(() => env.tasks.acceptResult(task.id, 'local-operator', '  '), (e) => e.code === 'bad_review_reason');
  assert.equal(env.tasks.get(task.id).state, 'awaiting_result_review', 'invalid decisions leave the pending result unchanged');

  const accepted = env.tasks.acceptResult(task.id, 'local-operator', 'Reviewed the proposal and checks');
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.result_json, pending.result_json, 'review preserves the exact submitted result');
  assert.ok(accepted.ended_at);
  const evidence = env.tasks.events(task.id).at(-1);
  assert.equal(evidence.kind, 'result_accepted');
  assert.equal(evidence.actor_id, 'local-operator');
  assert.equal(evidence.reason, 'Reviewed the proposal and checks');
  assert.equal(JSON.parse(evidence.payload_json).decision, 'accepted');
  assert.throws(() => env.tasks.rejectResult(task.id, 'local-operator', 'changed mind'), (e) => e.code === 'not_awaiting_result_review');
  assert.equal(env.tasks.events(task.id).filter((e) => e.kind === 'result_accepted' || e.kind === 'result_rejected').length, 1);
  assert.equal(env.store.agentTasksList({ state: 'completed' }).length, 0, 'review acceptance is distinct from execution completion');
  cleanup(env);
});

test('5c rejection_records_terminal_review_without_workspace_effects', () => {
  const env = fresh();
  const planner = env.registry.create({ name: 'planner', role: 'planner' });
  const worker = env.registry.create({ name: 'worker', role: 'worker' });
  const task = env.tasks.create({ title: 'propose change', creatorId: planner.id, assigneeId: worker.id });
  env.tasks.start(task.id, worker.id);
  env.tasks.awaitResultReview(task.id, { summary: 'Draft' }, worker.id);

  const rejected = env.tasks.rejectResult(task.id, 'local-operator', 'Proposal omitted an acceptance criterion');
  assert.equal(rejected.state, 'rejected');
  const evidence = env.tasks.events(task.id).at(-1);
  assert.equal(evidence.kind, 'result_rejected');
  assert.equal(evidence.actor_id, 'local-operator');
  assert.equal(evidence.reason, 'Proposal omitted an acceptance criterion');
  assert.equal(JSON.parse(evidence.payload_json).decision, 'rejected');
  assert.throws(() => env.tasks.complete(task.id, { ok: true }, worker.id), (e) => e.code === 'not_in_progress');
  assert.equal(env.tasks.get(task.id).state, 'rejected');
  cleanup(env);
});

test('6 fail_records_error', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'planner' });
  const b = env.registry.create({ name: 'b', role: 'worker' });
  const t = env.tasks.create({ title: 'x', creatorId: a.id, assigneeId: b.id });
  env.tasks.start(t.id, b.id);
  const failed = env.tasks.fail(t.id, 'something broke', b.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error, 'something broke');
  cleanup(env);
});

test('7 cancel_open_task', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'planner' });
  const t = env.tasks.create({ title: 'x', creatorId: a.id });
  const cancelled = env.tasks.cancel(t.id, a.id, 'not needed');
  assert.equal(cancelled.state, 'cancelled');
  cleanup(env);
});

test('8 closed_task_cannot_be_cancelled', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'planner' });
  const b = env.registry.create({ name: 'b', role: 'worker' });
  const t = env.tasks.create({ title: 'x', creatorId: a.id, assigneeId: b.id });
  env.tasks.start(t.id, b.id);
  env.tasks.complete(t.id, null, b.id);
  assert.throws(() => env.tasks.cancel(t.id, a.id), (e) => e.code === 'closed');
  cleanup(env);
});

test('9 handoff_increments_count_and_records_event', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'planner' });
  const b = env.registry.create({ name: 'b', role: 'worker' });
  const c = env.registry.create({ name: 'c', role: 'worker' });
  const t = env.tasks.create({ title: 'x', creatorId: a.id, assigneeId: b.id });
  const handed = env.tasks.handoff(t.id, c.id, b.id, 'need different expertise');
  assert.equal(handed.assignee_id, c.id);
  assert.equal(handed.state, 'assigned');
  assert.equal(handed.handoff_count, 1);

  const events = env.tasks.events(t.id);
  const handoff = events.find((e) => e.kind === 'handed_off');
  assert.ok(handoff);
  assert.equal(handoff.from_assignee, b.id);
  assert.equal(handoff.to_assignee, c.id);
  assert.equal(handoff.reason, 'need different expertise');
  cleanup(env);
});

test('10 handoff_requires_reason', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'planner' });
  const b = env.registry.create({ name: 'b', role: 'worker' });
  const c = env.registry.create({ name: 'c', role: 'worker' });
  const t = env.tasks.create({ title: 'x', creatorId: a.id, assigneeId: b.id });
  assert.throws(() => env.tasks.handoff(t.id, c.id, b.id, ''), (e) => e.code === 'bad_reason');
  assert.throws(() => env.tasks.handoff(t.id, c.id, b.id), (e) => e.code === 'bad_reason');
  cleanup(env);
});

test('11 handoff_to_same_assignee_rejected', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'planner' });
  const b = env.registry.create({ name: 'b', role: 'worker' });
  const t = env.tasks.create({ title: 'x', creatorId: a.id, assigneeId: b.id });
  assert.throws(() => env.tasks.handoff(t.id, b.id, a.id, 'same'), (e) => e.code === 'same_assignee');
  cleanup(env);
});

test('12 closed_task_cannot_be_handed_off', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'planner' });
  const b = env.registry.create({ name: 'b', role: 'worker' });
  const c = env.registry.create({ name: 'c', role: 'worker' });
  const t = env.tasks.create({ title: 'x', creatorId: a.id, assigneeId: b.id });
  env.tasks.start(t.id, b.id);
  env.tasks.complete(t.id, null, b.id);
  assert.throws(() => env.tasks.handoff(t.id, c.id, a.id, 'too late'), (e) => e.code === 'closed');
  cleanup(env);
});

test('13 visible_to_creator_assignee_supervisor', () => {
  const env = fresh();
  const sup = env.registry.create({ name: 'sup', role: 'supervisor' });
  const a = env.registry.create({ name: 'a', role: 'planner', supervisorId: sup.id });
  const b = env.registry.create({ name: 'b', role: 'worker', supervisorId: sup.id });
  const c = env.registry.create({ name: 'c', role: 'worker' });
  const t = env.tasks.create({ title: 'x', creatorId: a.id, assigneeId: b.id });

  assert.equal(env.tasks.visibleTo(a.id, {}).length, 1, 'creator sees it');
  assert.equal(env.tasks.visibleTo(b.id, {}).length, 1, 'assignee sees it');
  assert.equal(env.tasks.visibleTo(sup.id, {}).length, 1, 'supervisor sees it');
  assert.equal(env.tasks.visibleTo(c.id, {}).length, 0, 'unrelated agent sees nothing');
  cleanup(env);
});

test('14 counts_by_state', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'planner' });
  const b = env.registry.create({ name: 'b', role: 'worker' });
  env.tasks.create({ title: 'q', creatorId: a.id });
  env.tasks.create({ title: 'as', creatorId: a.id, assigneeId: b.id });
  const t3 = env.tasks.create({ title: 'run', creatorId: a.id, assigneeId: b.id });
  env.tasks.start(t3.id, b.id);
  const c = env.tasks.countsByState(a.id);
  assert.equal(c.queued, 1);
  assert.equal(c.assigned, 1);
  assert.equal(c.running, 1);
  assert.equal(c.completed, 0);
  cleanup(env);
});

test('15 parent_child_link', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'planner' });
  const parent = env.tasks.create({ title: 'parent', creatorId: a.id });
  const child = env.tasks.create({
    title: 'child', creatorId: a.id, parentTaskId: parent.id,
  });
  assert.equal(child.parent_task_id, parent.id);
  assert.throws(() => env.tasks.create({
    title: 'orphan', creatorId: a.id, parentTaskId: 'tsk_nope',
  }), (e) => e.code === 'parent_not_found');
  cleanup(env);
});

test('16 is_expired_reflects_expires_at', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'planner' });
  const t = env.tasks.create({
    title: 'x', creatorId: a.id,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal(env.tasks.isExpired(t.id), true);
  const t2 = env.tasks.create({
    title: 'y', creatorId: a.id,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  assert.equal(env.tasks.isExpired(t2.id), false);
  cleanup(env);
});

test('17 constructor_and_input_validation', () => {
  assert.throws(() => new AgentTasks(null, { registry: {} }),
    (e) => e instanceof AgentTaskError && e.code === 'bad_store');
  const env = fresh();
  assert.throws(() => new AgentTasks(env.store, {}),
    (e) => e instanceof AgentTaskError && e.code === 'bad_registry');

  const a = env.registry.create({ name: 'a', role: 'planner' });
  assert.throws(() => env.tasks.create({}), (e) => e.code === 'bad_title');
  assert.throws(() => env.tasks.create({ title: 'x' }), (e) => e.code === 'bad_creator');
  assert.throws(
    () => env.tasks.create({ title: 'x', creatorId: 'nope' }),
    (e) => e.code === 'creator_not_found'
  );
  assert.throws(() => env.tasks.get(''), (e) => e.code === 'bad_id');
  cleanup(env);
});
