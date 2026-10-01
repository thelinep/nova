'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { AgentRegistry } = require('../lib/agents');
const { AgentSupervisor, AgentSupervisorError } = require('../lib/agent-supervisor');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-asup-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  const registry = new AgentRegistry(store);
  const supervisor = new AgentSupervisor(store, { registry });
  return { dir, db, store, registry, supervisor };
}
function cleanup(env) {
  try { env.db.close(); } catch {}
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch {}
}

function triad() {
  const env = fresh();
  const top = env.registry.create({ name: 'top', role: 'supervisor' });
  const mid = env.registry.create({ name: 'mid', role: 'supervisor', supervisorId: top.id });
  const w = env.registry.create({ name: 'w', role: 'worker', supervisorId: mid.id });
  return { env, top, mid, w };
}

test('1 escalate_default_reviewer_is_supervisor', () => {
  const { env, mid, w } = triad();
  const e = env.supervisor.escalate({
    escalatorId: w.id, kind: 'uncertainty', summary: 'need guidance',
  });
  assert.ok(e.id.startsWith('esc_'));
  assert.equal(e.state, 'pending');
  assert.equal(e.reviewer_id, mid.id);
  assert.equal(e.escalator_id, w.id);
  cleanup(env);
});

test('2 escalate_explicit_reviewer', () => {
  const { env, top, w } = triad();
  const e = env.supervisor.escalate({
    escalatorId: w.id, reviewerId: top.id,
    kind: 'decision_review', summary: 'review',
  });
  assert.equal(e.reviewer_id, top.id);
  cleanup(env);
});

test('3 no_supervisor_rejected', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' }); // no supervisor
  assert.throws(
    () => env.supervisor.escalate({ escalatorId: a.id, kind: 'uncertainty', summary: 'x' }),
    (err) => err.code === 'no_reviewer'
  );
  cleanup(env);
});

test('4 unknown_kind_rejected', () => {
  const { env, w } = triad();
  assert.throws(
    () => env.supervisor.escalate({ escalatorId: w.id, kind: 'pizza', summary: 'x' }),
    (e) => e.code === 'bad_kind'
  );
  cleanup(env);
});

test('5 missing_summary_rejected', () => {
  const { env, w } = triad();
  assert.throws(
    () => env.supervisor.escalate({ escalatorId: w.id, kind: 'uncertainty' }),
    (e) => e.code === 'bad_summary'
  );
  cleanup(env);
});

test('6 self_review_rejected', () => {
  const { env, mid } = triad();
  assert.throws(
    () => env.supervisor.escalate({
      escalatorId: mid.id, reviewerId: mid.id, kind: 'uncertainty', summary: 'x',
    }),
    (e) => e.code === 'self_review'
  );
  cleanup(env);
});

test('7 approve_marks_approved', () => {
  const { env, mid, w } = triad();
  const e = env.supervisor.escalate({
    escalatorId: w.id, kind: 'tool_request',
    summary: 'need github', toolQuery: { kind: 'connector', toolId: 'gh1', operation: 'pr:create' },
  });
  const resolved = env.supervisor.approve(e.id, mid.id, 'granted temporarily');
  assert.equal(resolved.state, 'approved');
  assert.equal(resolved.decision_note, 'granted temporarily');
  assert.ok(resolved.decided_at);
  cleanup(env);
});

test('8 deny_marks_denied', () => {
  const { env, mid, w } = triad();
  const e = env.supervisor.escalate({ escalatorId: w.id, kind: 'override_request', summary: 'x' });
  const resolved = env.supervisor.deny(e.id, mid.id, 'no');
  assert.equal(resolved.state, 'denied');
  cleanup(env);
});

test('9 non_reviewer_cannot_decide', () => {
  const { env, top, mid, w } = triad();
  const e = env.supervisor.escalate({ escalatorId: w.id, kind: 'uncertainty', summary: 'x' });
  assert.throws(
    () => env.supervisor.approve(e.id, top.id, 'ok'),
    (err) => err.code === 'not_reviewer'
  );
  assert.throws(
    () => env.supervisor.deny(e.id, w.id, 'no'),
    (err) => err.code === 'not_reviewer'
  );
  cleanup(env);
});

test('10 cannot_decide_twice', () => {
  const { env, mid, w } = triad();
  const e = env.supervisor.escalate({ escalatorId: w.id, kind: 'uncertainty', summary: 'x' });
  env.supervisor.approve(e.id, mid.id, 'ok');
  assert.throws(
    () => env.supervisor.approve(e.id, mid.id, 'again'),
    (err) => err.code === 'not_pending'
  );
  cleanup(env);
});

test('11 forward_creates_child_and_closes_original', () => {
  const { env, top, mid, w } = triad();
  const e = env.supervisor.escalate({ escalatorId: w.id, kind: 'override_request', summary: 'complex case' });
  const { closed, child } = env.supervisor.forward(e.id, mid.id, 'needs your call');
  assert.equal(closed.state, 'forwarded');
  assert.equal(closed.decision_note, 'needs your call');
  assert.equal(child.state, 'pending');
  assert.equal(child.reviewer_id, top.id);
  assert.equal(child.escalator_id, mid.id);
  assert.equal(child.parent_escalation_id, e.id);
  assert.equal(child.summary, e.summary);
  cleanup(env);
});

test('12 forward_without_supervisor_rejected', () => {
  const env = fresh();
  const mid = env.registry.create({ name: 'mid', role: 'supervisor' }); // no supervisor
  const w = env.registry.create({ name: 'w', role: 'worker', supervisorId: mid.id });
  const e = env.supervisor.escalate({ escalatorId: w.id, kind: 'uncertainty', summary: 'x' });
  assert.throws(
    () => env.supervisor.forward(e.id, mid.id, 'need help'),
    (err) => err.code === 'no_supervisor'
  );
  cleanup(env);
});

test('13 withdraw_by_escalator', () => {
  const { env, w } = triad();
  const e = env.supervisor.escalate({ escalatorId: w.id, kind: 'uncertainty', summary: 'x' });
  const resolved = env.supervisor.withdraw(e.id, w.id, 'solved it');
  assert.equal(resolved.state, 'withdrawn');
  cleanup(env);
});

test('14 withdraw_by_non_escalator_rejected', () => {
  const { env, mid, w } = triad();
  const e = env.supervisor.escalate({ escalatorId: w.id, kind: 'uncertainty', summary: 'x' });
  assert.throws(
    () => env.supervisor.withdraw(e.id, mid.id, 'trying to cancel'),
    (err) => err.code === 'not_escalator'
  );
  cleanup(env);
});

test('15 expired_escalation_rejects_decision', () => {
  const { env, mid, w } = triad();
  const e = env.supervisor.escalate({
    escalatorId: w.id, kind: 'uncertainty', summary: 'x',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  assert.throws(
    () => env.supervisor.approve(e.id, mid.id, 'ok'),
    (err) => err.code === 'expired'
  );
  assert.equal(env.supervisor.get(e.id).state, 'expired');
  cleanup(env);
});

test('16 pending_and_raised_lists', () => {
  const { env, mid, w } = triad();
  env.supervisor.escalate({ escalatorId: w.id, kind: 'uncertainty', summary: 'a' });
  env.supervisor.escalate({ escalatorId: w.id, kind: 'uncertainty', summary: 'b' });
  assert.equal(env.supervisor.raised(w.id).length, 2);
  assert.equal(env.supervisor.pending(mid.id).length, 2);
  assert.equal(env.supervisor.pending(w.id).length, 0);
  cleanup(env);
});

test('17 events_recorded_in_order', () => {
  const { env, top, mid, w } = triad();
  const e = env.supervisor.escalate({ escalatorId: w.id, kind: 'override_request', summary: 'x' });
  env.supervisor.forward(e.id, mid.id, 'up');
  const events = env.supervisor.events(e.id);
  assert.equal(events[0].kind, 'raised');
  assert.equal(events[events.length - 1].kind, 'forwarded');
  cleanup(env);
});

test('18 counts_by_state', () => {
  const { env, mid, w } = triad();
  const a = env.supervisor.escalate({ escalatorId: w.id, kind: 'uncertainty', summary: 'a' });
  env.supervisor.escalate({ escalatorId: w.id, kind: 'uncertainty', summary: 'b' });
  env.supervisor.approve(a.id, mid.id, 'ok');
  const c = env.supervisor.countsByState(w.id);
  assert.equal(c.raised.approved, 1);
  assert.equal(c.raised.pending, 1);
  cleanup(env);
});

test('19 constructor_and_input_validation', () => {
  assert.throws(() => new AgentSupervisor(null, { registry: {} }),
    (e) => e instanceof AgentSupervisorError && e.code === 'bad_store');
  const env = fresh();
  assert.throws(() => new AgentSupervisor(env.store, {}),
    (e) => e instanceof AgentSupervisorError && e.code === 'bad_registry');
  const a = env.registry.create({ name: 'a', role: 'worker' });
  assert.throws(
    () => env.supervisor.escalate({ kind: 'uncertainty', summary: 'x' }),
    (e) => e.code === 'bad_escalator_id'
  );
  assert.throws(
    () => env.supervisor.escalate({ escalatorId: 'nope', kind: 'uncertainty', summary: 'x' }),
    (e) => e.code === 'escalator_not_found'
  );
  assert.throws(() => env.supervisor.get(''), (e) => e.code === 'bad_id');
  cleanup(env);
});
