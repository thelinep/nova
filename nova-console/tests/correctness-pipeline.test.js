'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { CorrectnessPipeline, CorrectnessPipelineError } = require('../lib/correctness-pipeline');
const { ConstellationRouter } = require('../lib/constellation-router');
const { PolicyEngine } = require('../lib/policy');
const { KillSwitch } = require('../lib/killswitch');
const { BudgetEngine } = require('../lib/budgets');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-cp-'));
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
  p.grant({
    subject: { type: 'agent', id: 'constellation' },
    resource: { type: 'tool', id: 'constellation.generate' },
    effect: 'allow',
  });
  return p;
}

function okProvider(id, code) {
  return { id, generate: async () => code || ('code-from-' + id) };
}
function failProvider(id) {
  return { id, generate: async () => { throw new Error('provider_failed'); } };
}

function makeRouter(store, providers, extras) {
  return new ConstellationRouter(store, Object.assign({
    providers,
    policy: permissivePolicy(store),
    agentId: 'constellation',
  }, extras || {}));
}

function fakeClover(status, extra) {
  extra = extra || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(extra, k);
  return {
    async verify(problem, code) {
      return {
        ok: status === 'verified',
        status,
        runId: 'clv_test_' + status,
        consistency_ok: has('consistency_ok') ? extra.consistency_ok : (status === 'verified'),
        proof_ok: has('proof_ok') ? extra.proof_ok : (status === 'verified'),
        proof_attempts: has('proof_attempts') ? extra.proof_attempts : 1,
        detail: has('detail') ? extra.detail : null,
      };
    },
  };
}

test('1 happy_path_all_stages_verified', async () => {
  const env = fresh();
  const router = makeRouter(env.store, [okProvider('a', 'aaa'), okProvider('b', 'bb')]);
  const pipeline = new CorrectnessPipeline(env.store, {
    router,
    clover: fakeClover('verified'),
  });
  const r = await pipeline.run('problem');
  assert.equal(r.ok, true);
  assert.equal(r.status, 'verified');
  assert.equal(r.stage, 'done');
  assert.ok(r.constellation_run_id);
  assert.ok(r.constellation_winner_id);
  assert.ok(r.clover_run_id);
  assert.equal(r.consistency_ok, true);
  assert.equal(r.proof_ok, true);
  assert.equal(r.winner.code, 'bb');
  cleanup(env);
});

test('2 policy_denied_escalates', async () => {
  const env = fresh();
  const router = new ConstellationRouter(env.store, {
    providers: [okProvider('a')],
    policy: new PolicyEngine(env.store),
    agentId: 'constellation',
  });
  const pipeline = new CorrectnessPipeline(env.store, { router, clover: fakeClover('verified') });
  const r = await pipeline.run('problem');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'escalated');
  assert.equal(r.stage, 'generate');
  assert.match(r.detail, /policy_denied/);
  assert.equal(r.clover_run_id, null);
  cleanup(env);
});

test('3 kill_switch_escalates', async () => {
  const env = fresh();
  const ks = new KillSwitch(env.store);
  ks.halt('op', 'test');
  const router = new ConstellationRouter(env.store, {
    providers: [okProvider('a')],
    policy: permissivePolicy(env.store),
    killSwitch: ks,
    agentId: 'constellation',
  });
  const pipeline = new CorrectnessPipeline(env.store, { router, clover: fakeClover('verified') });
  const r = await pipeline.run('problem');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'escalated');
  assert.match(r.detail, /kill_switch/);
  cleanup(env);
});

test('4 all_providers_failed_escalates', async () => {
  const env = fresh();
  const router = makeRouter(env.store, [failProvider('a'), failProvider('b')]);
  const pipeline = new CorrectnessPipeline(env.store, { router, clover: fakeClover('verified') });
  const r = await pipeline.run('problem');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'escalated');
  assert.equal(r.detail, 'all_failed');
  cleanup(env);
});

test('5 winner_code_flows_to_clover', async () => {
  const env = fresh();
  const router = makeRouter(env.store, [okProvider('a', 'aaa'), okProvider('b', 'chosen-code')]);
  let receivedCode = null;
  const clover = {
    async verify(problem, code) {
      receivedCode = code;
      return { ok: true, status: 'verified', runId: 'clv_x', consistency_ok: true, proof_ok: true, proof_attempts: 1, detail: null };
    },
  };
  const pipeline = new CorrectnessPipeline(env.store, { router, clover });
  const judge = async (a, b) => (a.provider === 'b' ? 'a' : 'b');
  const r = await pipeline.run('problem', { judge });
  assert.equal(receivedCode, 'chosen-code');
  assert.equal(r.winner.code, 'chosen-code');
  cleanup(env);
});

test('6 clover_consistency_failed_recorded', async () => {
  const env = fresh();
  const router = makeRouter(env.store, [okProvider('a')]);
  const pipeline = new CorrectnessPipeline(env.store, {
    router,
    clover: fakeClover('inconsistent', { consistency_ok: false, proof_ok: null, detail: 'spec missing name' }),
  });
  const r = await pipeline.run('problem');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'inconsistent');
  assert.equal(r.consistency_ok, false);
  assert.equal(r.proof_ok, null);
  assert.ok(r.constellation_winner_id);
  assert.ok(r.clover_run_id);
  cleanup(env);
});

test('7 clover_proof_failed_recorded', async () => {
  const env = fresh();
  const router = makeRouter(env.store, [okProvider('a')]);
  const pipeline = new CorrectnessPipeline(env.store, {
    router,
    clover: fakeClover('proof_failed', { consistency_ok: true, proof_ok: false, proof_attempts: 3 }),
  });
  const r = await pipeline.run('problem');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'proof_failed');
  assert.equal(r.consistency_ok, true);
  assert.equal(r.proof_ok, false);
  cleanup(env);
});

test('8 clover_not_configured_selected', async () => {
  const env = fresh();
  const router = makeRouter(env.store, [okProvider('a')]);
  const pipeline = new CorrectnessPipeline(env.store, { router });
  const r = await pipeline.run('problem');
  assert.equal(r.ok, true);
  assert.equal(r.status, 'selected');
  assert.equal(r.stage, 'done');
  assert.equal(r.clover_run_id, null);
  assert.equal(r.winner.provider, 'a');
  cleanup(env);
});

test('9 lineage_links_all_runs', async () => {
  const env = fresh();
  const router = makeRouter(env.store, [okProvider('a'), okProvider('b')]);
  const pipeline = new CorrectnessPipeline(env.store, { router, clover: fakeClover('verified') });
  const r = await pipeline.run('problem');

  const row = pipeline.get(r.runId);
  assert.ok(row);
  assert.ok(row.constellation_run_id);
  assert.ok(row.constellation_winner_id);
  assert.ok(row.clover_run_id);
  assert.equal(row.status, 'verified');

  const constellationRuns = env.store.constellationRunsList({});
  assert.equal(constellationRuns.length, 1);
  assert.equal(constellationRuns[0].id, row.constellation_run_id);

  const candidates = env.store.constellationCandidatesList(row.constellation_run_id);
  assert.equal(candidates.length, 2);

  const rounds = env.store.constellationRoundsList(row.constellation_run_id);
  assert.ok(rounds.length >= 1);
  cleanup(env);
});

test('10 custom_judge_used', async () => {
  const env = fresh();
  const router = makeRouter(env.store, [okProvider('a', 'aaa'), okProvider('b', 'bb')]);
  const pipeline = new CorrectnessPipeline(env.store, { router, clover: fakeClover('verified') });
  // Custom judge prefers 'a' explicitly, overriding the shortest-code heuristic.
  const judge = async (a, b) => (a.provider === 'a' ? 'a' : 'b');
  const r = await pipeline.run('problem', { judge });
  assert.equal(r.winner.provider, 'a');
  assert.equal(r.winner.code, 'aaa');
  cleanup(env);
});

test('11 run_id_unique', async () => {
  const env = fresh();
  const router = makeRouter(env.store, [okProvider('a')]);
  const pipeline = new CorrectnessPipeline(env.store, { router, clover: fakeClover('verified') });
  const r1 = await pipeline.run('p1');
  const r2 = await pipeline.run('p2');
  assert.notEqual(r1.runId, r2.runId);
  assert.equal(pipeline.history({}).length, 2);
  cleanup(env);
});

test('12 constructor_and_input_validation', async () => {
  assert.throws(() => new CorrectnessPipeline(null, {}),
    (e) => e instanceof CorrectnessPipelineError && e.code === 'bad_store');
  assert.throws(() => new CorrectnessPipeline({}, {}),
    (e) => e instanceof CorrectnessPipelineError && e.code === 'bad_router');
  assert.throws(() => new CorrectnessPipeline({}, { router: { generate: () => {} } }),
    (e) => e instanceof CorrectnessPipelineError && e.code === 'bad_router');

  const env = fresh();
  const router = makeRouter(env.store, [okProvider('a')]);
  const pipeline = new CorrectnessPipeline(env.store, { router });
  await assert.rejects(() => pipeline.run(''),
    (e) => e instanceof CorrectnessPipelineError && e.code === 'bad_problem');
  cleanup(env);
});
