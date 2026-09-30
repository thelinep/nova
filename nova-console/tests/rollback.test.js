'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { RollbackManager, RollbackError } = require('../lib/rollback');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-rollback-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  return { dir, db, store };
}

function cleanup(env) {
  try { env.db.close(); } catch { /* noop */ }
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch { /* noop */ }
}

function fakeExecutor(initial) {
  let sha = (initial && initial.sha) || null;
  let diff = (initial && initial.diff) || '';
  const calls = { capture: 0, revert: [] };
  return {
    calls,
    async captureCurrent() {
      calls.capture++;
      return { sha, diff, files: [] };
    },
    async revert(domain, target) {
      calls.revert.push({ domain, target });
      sha = target;
      diff = '';
    },
    _setSha(s) { sha = s; },
    _setDiff(d) { diff = d; },
  };
}

test('1 set_get_green', () => {
  const env = fresh();
  const rm = new RollbackManager(env.store);
  rm.setGreen('workspace', 'abc123', { note: 'initial' }, 'tester');
  const g = rm.getGreen('workspace');
  assert.equal(g.sha, 'abc123');
  assert.equal(g.set_by, 'tester');
  assert.equal(JSON.parse(g.meta_json).note, 'initial');
  cleanup(env);
});

test('2 set_green_replaces', () => {
  const env = fresh();
  const rm = new RollbackManager(env.store);
  rm.setGreen('workspace', 'first');
  rm.setGreen('workspace', 'second');
  assert.equal(rm.getGreen('workspace').sha, 'second');
  assert.equal(rm.listGreen().length, 1);
  cleanup(env);
});

test('3 clear_green', () => {
  const env = fresh();
  const rm = new RollbackManager(env.store);
  rm.setGreen('workspace', 'abc');
  rm.clearGreen('workspace');
  assert.equal(rm.getGreen('workspace'), null);
  cleanup(env);
});

test('4 unknown_domain_rejected', () => {
  const env = fresh();
  const rm = new RollbackManager(env.store, { domains: ['workspace'] });
  assert.throws(() => rm.setGreen('unknown', 'abc'), (e) => e instanceof RollbackError);
  assert.throws(() => rm.getGreen('unknown'), (e) => e instanceof RollbackError);
  cleanup(env);
});

test('5 rollback_on_failure', async () => {
  const env = fresh();
  const exec = fakeExecutor({ sha: 'old', diff: 'bad change' });
  const rm = new RollbackManager(env.store, { executor: exec });
  rm.setGreen('workspace', 'green-sha');

  const r = await rm.attempt('workspace', async () => {
    throw new Error('compile failed');
  }, { taskId: 'task-1' });

  assert.equal(r.ok, false);
  assert.equal(r.rolled_back, true);
  assert.equal(r.outcome, 'rolled_back');
  assert.equal(exec.calls.revert.length, 1);
  assert.equal(exec.calls.revert[0].target, 'green-sha');

  const hist = rm.history({ domain: 'workspace' });
  assert.equal(hist.length, 1);
  assert.equal(hist[0].outcome, 'rolled_back');
  assert.equal(hist[0].from_sha, 'old');
  assert.equal(hist[0].to_sha, 'green-sha');
  assert.equal(hist[0].task_id, 'task-1');
  cleanup(env);
});

test('6 no_green_no_rollback', async () => {
  const env = fresh();
  const exec = fakeExecutor({ sha: 'old' });
  const rm = new RollbackManager(env.store, { executor: exec });

  const r = await rm.attempt('workspace', async () => {
    throw new Error('first ever failure');
  });

  assert.equal(r.ok, false);
  assert.equal(r.rolled_back, false);
  assert.equal(r.outcome, 'no_green_commit');
  assert.equal(exec.calls.revert.length, 0);
  cleanup(env);
});

test('7 quarantine_recorded', async () => {
  const env = fresh();
  const exec = fakeExecutor({ sha: 'old', diff: 'diff-content-here' });
  const rm = new RollbackManager(env.store, { executor: exec });
  rm.setGreen('workspace', 'green');

  const r = await rm.attempt('workspace', async () => {
    throw new Error('lint failed');
  }, { taskId: 'task-q' });

  assert.ok(r.quarantine);
  assert.equal(r.quarantine.status, 'pending');
  assert.equal(r.quarantine.reason, 'lint failed');
  assert.equal(r.quarantine.task_id, 'task-q');

  const list = rm.listQuarantines({ domain: 'workspace', status: 'pending' });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, r.quarantine.id);
  cleanup(env);
});

test('8 resolve_quarantine', () => {
  const env = fresh();
  const rm = new RollbackManager(env.store);
  const q = rm.quarantine('workspace', { reason: 'test reason' });

  const applied = rm.resolveQuarantine(q.id, 'applied', 'tester', 'kept the fix');
  assert.equal(applied.status, 'applied');
  assert.equal(applied.resolved_by, 'tester');

  assert.throws(
    () => rm.resolveQuarantine(q.id, 'discarded'),
    (e) => e instanceof RollbackError && e.code === 'already_resolved'
  );
  assert.throws(
    () => rm.resolveQuarantine(q.id, 'nonsense'),
    (e) => e instanceof RollbackError && e.code === 'bad_decision'
  );
  cleanup(env);
});

test('9 success_advances_green', async () => {
  const env = fresh();
  const exec = fakeExecutor({ sha: 'old' });
  const rm = new RollbackManager(env.store, { executor: exec });

  const r = await rm.attempt('workspace', async () => {
    return { sha: 'new-good-sha' };
  });

  assert.equal(r.ok, true);
  assert.equal(r.rolled_back, false);
  assert.equal(r.outcome, 'success');
  assert.equal(rm.getGreen('workspace').sha, 'new-good-sha');
  assert.equal(rm.history({ domain: 'workspace' }).length, 0);
  cleanup(env);
});

test('10 rollback_of_rollback', async () => {
  const env = fresh();
  const exec = fakeExecutor({ sha: 's0' });
  const rm = new RollbackManager(env.store, { executor: exec });
  rm.setGreen('workspace', 'g0');

  // 1st failure: rollback from s0 to g0
  const r1 = await rm.attempt('workspace', async () => { throw new Error('boom1'); });
  assert.equal(r1.outcome, 'rolled_back');
  assert.equal(r1.event.from_sha, 's0');
  assert.equal(r1.event.to_sha, 'g0');

  // Simulate the executor's state now being g0
  // Next failure: from g0 to g0 (same green)
  exec._setSha('g0');
  const r2 = await rm.attempt('workspace', async () => { throw new Error('boom2'); });
  assert.equal(r2.outcome, 'rolled_back');
  assert.equal(r2.event.from_sha, 'g0');
  assert.equal(r2.event.to_sha, 'g0');

  // History is ordered and deterministic
  const hist = rm.history({ domain: 'workspace' });
  assert.equal(hist.length, 2);
  assert.equal(hist[0].reason, 'boom1');
  assert.equal(hist[1].reason, 'boom2');

  // Both quarantines exist and are distinct
  const qs = rm.listQuarantines({ domain: 'workspace' });
  assert.equal(qs.length, 2);
  assert.notEqual(qs[0].id, qs[1].id);
  cleanup(env);
});
