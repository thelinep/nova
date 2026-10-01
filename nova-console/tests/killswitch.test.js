'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { KillSwitch, KillSwitchError, HaltedError } = require('../lib/killswitch');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-killswitch-'));
  const { db, dbPath } = openDb(dir);
  const store = new Store(db);
  return { dir, db, dbPath, store };
}
function cleanup(env) {
  try { env.db.close(); } catch { /* noop */ }
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch { /* noop */ }
}

test('1 halt_sets_state', () => {
  const env = fresh();
  const ks = new KillSwitch(env.store);
  assert.equal(ks.isHalted(), false);
  ks.halt('operator-1', 'emergency');
  assert.equal(ks.isHalted(), true);
  const s = ks.status();
  assert.equal(s.halted, true);
  assert.equal(s.reason, 'emergency');
  assert.equal(s.operator, 'operator-1');
  cleanup(env);
});

test('2 halt_requires_operator_and_reason', () => {
  const env = fresh();
  const ks = new KillSwitch(env.store);
  assert.throws(() => ks.halt('', 'x'), (e) => e.code === 'bad_operator');
  assert.throws(() => ks.halt('op', ''), (e) => e.code === 'bad_reason');
  cleanup(env);
});

test('3 double_halt_rejected', () => {
  const env = fresh();
  const ks = new KillSwitch(env.store);
  ks.halt('op', 'r');
  assert.throws(() => ks.halt('op', 'r'), (e) => e.code === 'already_halted');
  cleanup(env);
});

test('4 resume_requires_authfn', () => {
  const env = fresh();
  const ks = new KillSwitch(env.store);
  ks.halt('op', 'r');
  assert.throws(
    () => ks.resume('op', 'r', 'anything'),
    (e) => e.code === 'no_authfn'
  );
  cleanup(env);
});

test('5 resume_auth_failed', () => {
  const env = fresh();
  const ks = new KillSwitch(env.store, { authFn: (cred) => cred === 'correct' });
  ks.halt('op', 'r');
  assert.throws(
    () => ks.resume('op', 'r', 'wrong'),
    (e) => e.code === 'auth_failed'
  );
  assert.equal(ks.isHalted(), true);
  cleanup(env);
});

test('6 resume_with_auth_clears_state', () => {
  const env = fresh();
  const ks = new KillSwitch(env.store, { authFn: (cred, op) => cred === 'pass' && op === 'op' });
  ks.halt('op', 'r');
  ks.resume('op', 'r', 'pass');
  assert.equal(ks.isHalted(), false);
  cleanup(env);
});

test('7 resume_when_not_halted_rejected', () => {
  const env = fresh();
  const ks = new KillSwitch(env.store, { authFn: () => true });
  assert.throws(() => ks.resume('op', 'r', 'x'), (e) => e.code === 'not_halted');
  cleanup(env);
});

test('8 assert_not_halted_throws_halted_error', () => {
  const env = fresh();
  const ks = new KillSwitch(env.store);
  ks.assertNotHalted();
  ks.halt('op', 'test reason');
  assert.throws(
    () => ks.assertNotHalted(),
    (e) => e instanceof HaltedError && e.reason === 'test reason'
  );
  cleanup(env);
});

test('9 halt_survives_restart', () => {
  const env = fresh();
  const ks1 = new KillSwitch(env.store);
  ks1.halt('op', 'persist me');
  env.db.close();

  const { db: db2 } = openDb(env.dir);
  const store2 = new Store(db2);
  const ks2 = new KillSwitch(store2);
  assert.equal(ks2.isHalted(), true);
  assert.equal(ks2.status().reason, 'persist me');
  try { db2.close(); } catch { /* noop */ }
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch { /* noop */ }
});

test('10 audit_trail_halt_resume', () => {
  const env = fresh();
  const ks = new KillSwitch(env.store, { authFn: () => true });
  ks.halt('alice', 'first halt');
  ks.resume('bob', 'resolved', 'ok');

  const events = ks.history();
  assert.equal(events.length, 2);
  assert.equal(events[0].action, 'halt');
  assert.equal(events[0].operator, 'alice');
  assert.equal(events[0].reason, 'first halt');
  assert.equal(events[1].action, 'resume');
  assert.equal(events[1].operator, 'bob');
  assert.equal(events[1].reason, 'resolved');
  cleanup(env);
});

test('11 listeners_fire_on_halt_and_resume', () => {
  const env = fresh();
  const ks = new KillSwitch(env.store, { authFn: () => true });
  const halts = [];
  const resumes = [];
  ks.onHalt((e) => halts.push(e));
  ks.onResume((e) => resumes.push(e));
  ks.halt('op', 'x');
  ks.resume('op', 'y', 'ok');
  assert.equal(halts.length, 1);
  assert.equal(halts[0].action, 'halt');
  assert.equal(resumes.length, 1);
  assert.equal(resumes[0].action, 'resume');
  cleanup(env);
});

test('12 latency_under_5s', () => {
  const env = fresh();
  const ks = new KillSwitch(env.store);
  const t0 = Date.now();
  ks.halt('op', 'latency test');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000, `halt took ${elapsed}ms`);
  assert.equal(ks.isHalted(), true);
  cleanup(env);
});
