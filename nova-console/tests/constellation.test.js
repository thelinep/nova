'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { ConstellationRouter, ConstellationError } = require('../lib/constellation-router');
const { PolicyEngine } = require('../lib/policy');
const { BudgetEngine } = require('../lib/budgets');
const { KillSwitch } = require('../lib/killswitch');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-constellation-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  return { dir, db, store };
}

function cleanup(env) {
  try { env.db.close(); } catch {}
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch {}
}

function permissivePolicy(store) {
  const p = new PolicyEngine(store);
  p.grant({ subject: { type: 'agent', id: 'constellation' }, resource: { type: 'tool', id: 'constellation.generate' }, effect: 'allow' });
  return p;
}

function okProvider(id, code) { return { id, generate: async () => code || ('code-from-' + id) }; }
function failProvider(id, err) { return { id, generate: async () => { throw new Error(err || 'provider_failed'); } }; }

test('1 single_provider_returns_one_candidate', async () => {
  const env = fresh();
  const router = new ConstellationRouter(env.store, { providers: [okProvider('a')], policy: permissivePolicy(env.store) });
  const r = await router.generate('write a function');
  assert.equal(r.ok, true);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].provider, 'a');
  assert.equal(r.candidates[0].code, 'code-from-a');
  cleanup(env);
});

test('2 three_providers_return_three_candidates', async () => {
  const env = fresh();
  const router = new ConstellationRouter(env.store, { providers: [okProvider('a'), okProvider('b'), okProvider('c')], policy: permissivePolicy(env.store) });
  const r = await router.generate('problem');
  assert.equal(r.candidates.length, 3);
  assert.deepEqual(r.candidates.map(c => c.provider).sort(), ['a', 'b', 'c']);
  cleanup(env);
});

test('3 provider_failure_recorded_not_aborted', async () => {
  const env = fresh();
  const router = new ConstellationRouter(env.store, { providers: [okProvider('a'), failProvider('b', 'oops'), okProvider('c')], policy: permissivePolicy(env.store) });
  const r = await router.generate('problem');
  assert.equal(r.ok, true);
  assert.equal(r.candidates.length, 2);
  const stored = router.candidates(r.runId);
  assert.equal(stored.length, 3);
  assert.match(stored.find(s => s.provider_id === 'b').error, /oops/);
  cleanup(env);
});

test('4 all_providers_fail_run_status_all_failed', async () => {
  const env = fresh();
  const router = new ConstellationRouter(env.store, { providers: [failProvider('a'), failProvider('b')], policy: permissivePolicy(env.store) });
  const r = await router.generate('problem');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'all_failed');
  assert.equal(r.candidates.length, 0);
  cleanup(env);
});

test('5 policy_denied_blocks_run', async () => {
  const env = fresh();
  const router = new ConstellationRouter(env.store, { providers: [okProvider('a')], policy: new PolicyEngine(env.store) });
  const r = await router.generate('problem');
  assert.equal(r.ok, false);
  assert.equal(r.escalated, true);
  assert.equal(r.reason, 'policy_denied');
  cleanup(env);
});

test('6 kill_switch_blocks_run', async () => {
  const env = fresh();
  const ks = new KillSwitch(env.store);
  ks.halt('op', 'test');
  const router = new ConstellationRouter(env.store, { providers: [okProvider('a')], policy: permissivePolicy(env.store), killSwitch: ks });
  const r = await router.generate('problem');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'kill_switch_active');
  cleanup(env);
});

test('7 budget_exceeded_blocks_run', async () => {
  const env = fresh();
  const budgets = new BudgetEngine(env.store);
  budgets.setBudget({ subject: { type: 'agent', id: 'constellation' }, limits: { jobs: 1 } });
  budgets.charge({ type: 'agent', id: 'constellation' }, 'jobs', 1);
  const router = new ConstellationRouter(env.store, { providers: [okProvider('a')], policy: permissivePolicy(env.store), budgets });
  const r = await router.generate('problem');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'budget_exceeded');
  cleanup(env);
});

test('8 rtv_selects_winner', async () => {
  const env = fresh();
  const router = new ConstellationRouter(env.store, { providers: [okProvider('a','aaa'), okProvider('b','bbb'), okProvider('c','ccc')], policy: permissivePolicy(env.store) });
  const r = await router.generate('problem');
  const judge = async (a, b) => { if (a.code === 'ccc') return 'a'; if (b.code === 'ccc') return 'b'; return 'tie'; };
  const sel = await router.select(r.runId, r.candidates, judge);
  assert.equal(sel.ok, true);
  assert.equal(sel.winner.code, 'ccc');
  assert.ok(sel.rounds >= 1);
  cleanup(env);
});

test('9 rtv_records_rounds', async () => {
  const env = fresh();
  const router = new ConstellationRouter(env.store, { providers: [okProvider('a'), okProvider('b'), okProvider('c'), okProvider('d'), okProvider('e')], policy: permissivePolicy(env.store) });
  const r = await router.generate('problem');
  await router.select(r.runId, r.candidates, async () => 'a');
  const rounds = router.rounds(r.runId);
  assert.ok(rounds.length >= 1);
  for (const rd of rounds) {
    assert.ok(Array.isArray(JSON.parse(rd.entrants_json)));
    assert.ok(rd.winner_id);
    assert.ok(Array.isArray(JSON.parse(rd.votes_json)));
  }
  cleanup(env);
});

test('10 rtv_deterministic_tiebreak', async () => {
  const env = fresh();
  const router = new ConstellationRouter(env.store, { providers: [okProvider('a'), okProvider('b')], policy: permissivePolicy(env.store) });
  const r = await router.generate('problem');
  const judgeTie = async () => 'tie';
  const s1 = await router.select(r.runId, r.candidates, judgeTie);
  const s2 = await router.select(r.runId, r.candidates, judgeTie);
  assert.equal(s1.winner.id, s2.winner.id);
  cleanup(env);
});

test('11 run_id_unique', async () => {
  const env = fresh();
  const router = new ConstellationRouter(env.store, { providers: [okProvider('a')], policy: permissivePolicy(env.store) });
  const r1 = await router.generate('p1');
  const r2 = await router.generate('p2');
  assert.notEqual(r1.runId, r2.runId);
  assert.equal(router.history({}).length, 2);
  cleanup(env);
});

test('12 constructor_validates_inputs', () => {
  assert.throws(() => new ConstellationRouter(null, { providers: [] }), e => e instanceof ConstellationError && e.code === 'bad_store');
  assert.throws(() => new ConstellationRouter({}, {}), e => e instanceof ConstellationError && e.code === 'bad_providers');
  assert.throws(() => new ConstellationRouter({}, { providers: [{}] }), e => e instanceof ConstellationError && e.code === 'bad_provider');
});
