'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { BudgetEngine, BudgetError, BudgetExceededError } = require('../lib/budgets');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-budgets-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  return { dir, db, store };
}
function cleanup(env) {
  try { env.db.close(); } catch { /* noop */ }
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch { /* noop */ }
}

test('1 set_and_get_budget', () => {
  const env = fresh();
  const b = new BudgetEngine(env.store);
  const row = b.setBudget({
    subject: { type: 'agent', id: 'neuron' },
    limits: { tokens: 1000, usd: 5, jobs: 10 },
    window: 'day',
  });
  assert.ok(row.id);
  assert.equal(row.subject_type, 'agent');
  const stored = b.getBudget(row.id);
  assert.equal(JSON.parse(stored.limits_json).tokens, 1000);
  cleanup(env);
});

test('2 check_under_limit', () => {
  const env = fresh();
  const b = new BudgetEngine(env.store);
  b.setBudget({ subject: { type: 'agent', id: 'a' }, limits: { tokens: 100 } });
  const r = b.check({ type: 'agent', id: 'a' });
  assert.equal(r.ok, true);
  assert.equal(r.exceeded.length, 0);
  cleanup(env);
});

test('3 charge_and_exceed_tokens', () => {
  const env = fresh();
  const b = new BudgetEngine(env.store);
  b.setBudget({ subject: { type: 'agent', id: 'a' }, limits: { tokens: 100 } });
  b.charge({ type: 'agent', id: 'a' }, 'tokens', 50);
  assert.equal(b.check({ type: 'agent', id: 'a' }).ok, true);
  b.charge({ type: 'agent', id: 'a' }, 'tokens', 50);
  const r = b.check({ type: 'agent', id: 'a' });
  assert.equal(r.ok, false);
  assert.equal(r.exceeded[0].kind, 'tokens');
  assert.equal(r.exceeded[0].limit, 100);
  assert.equal(r.exceeded[0].used, 100);
  cleanup(env);
});


test('4 usd_accounting', () => {
  const env = fresh();
  const b = new BudgetEngine(env.store);
  b.setBudget({ subject: { type: 'agent', id: 'a' }, limits: { usd: 4 } });
  b.charge({ type: 'agent', id: 'a' }, 'usd', 2.5);
  b.charge({ type: 'agent', id: 'a' }, 'usd', 1.25);   // 3.75 < 4
  assert.equal(b.check({ type: 'agent', id: 'a' }).ok, true);
  b.charge({ type: 'agent', id: 'a' }, 'usd', 0.5);    // 4.25 >= 4
  const r = b.check({ type: 'agent', id: 'a' });
  assert.equal(r.ok, false);
  assert.equal(r.exceeded[0].used, 4.25);
  cleanup(env);
});

test('5 revoke_budget', () => {
  const env = fresh();
  const b = new BudgetEngine(env.store);
  const row = b.setBudget({ subject: { type: 'agent', id: 'a' }, limits: { tokens: 1 } });
  b.charge({ type: 'agent', id: 'a' }, 'tokens', 100);
  assert.equal(b.check({ type: 'agent', id: 'a' }).ok, false);
  b.revokeBudget(row.id);
  assert.equal(b.check({ type: 'agent', id: 'a' }).ok, true);
  cleanup(env);
});

test('6 daily_window_ignores_yesterday', () => {
  const env = fresh();
  const b = new BudgetEngine(env.store);
  b.setBudget({ subject: { type: 'agent', id: 'a' }, limits: { tokens: 100 } });
  // Manually insert consumption from 2 days ago
  const oldTs = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  env.store.budgetConsumptionInsert({
    id: 'old', budget_id: null, subject_type: 'agent', subject_id: 'a',
    kind: 'tokens', amount: 999, ref_id: null, timestamp: oldTs,
  });
  const r = b.check({ type: 'agent', id: 'a' });
  assert.equal(r.ok, true);
  cleanup(env);
});

test('7 guard_throws_when_exceeded', () => {
  const env = fresh();
  const b = new BudgetEngine(env.store);
  b.setBudget({ subject: { type: 'agent', id: 'a' }, limits: { jobs: 1 } });
  b.charge({ type: 'agent', id: 'a' }, 'jobs', 1);
  assert.throws(
    () => b.guard({ type: 'agent', id: 'a' }),
    (e) => e instanceof BudgetExceededError && e.exceeded.length === 1
  );
  cleanup(env);
});

test('8 unknown_kind_rejected', () => {
  const env = fresh();
  const b = new BudgetEngine(env.store);
  assert.throws(
    () => b.setBudget({ subject: { type: 'agent', id: 'a' }, limits: { unknown_thing: 5 } }),
    (e) => e instanceof BudgetError && e.code === 'bad_kind'
  );
  assert.throws(
    () => b.charge({ type: 'agent', id: 'a' }, 'wat', 1),
    (e) => e instanceof BudgetError && e.code === 'bad_kind'
  );
  cleanup(env);
});

test('9 zero_or_negative_amount_rejected', () => {
  const env = fresh();
  const b = new BudgetEngine(env.store);
  assert.throws(
    () => b.charge({ type: 'agent', id: 'a' }, 'tokens', 0),
    (e) => e instanceof BudgetError && e.code === 'bad_amount'
  );
  assert.throws(
    () => b.charge({ type: 'agent', id: 'a' }, 'tokens', -5),
    (e) => e instanceof BudgetError && e.code === 'bad_amount'
  );
  cleanup(env);
});

test('10 multi_kind_enforcement', () => {
  const env = fresh();
  const b = new BudgetEngine(env.store);
  b.setBudget({
    subject: { type: 'agent', id: 'a' },
    limits: { tokens: 1000, usd: 1, jobs: 5 },
  });
  b.charge({ type: 'agent', id: 'a' }, 'tokens', 500);
  b.charge({ type: 'agent', id: 'a' }, 'jobs', 3);
  assert.equal(b.check({ type: 'agent', id: 'a' }).ok, true);
  b.charge({ type: 'agent', id: 'a' }, 'usd', 1);
  const r = b.check({ type: 'agent', id: 'a' });
  assert.equal(r.ok, false);
  assert.equal(r.exceeded.length, 1);
  assert.equal(r.exceeded[0].kind, 'usd');
  cleanup(env);
});
