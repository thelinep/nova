'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { AgentRegistry } = require('../lib/agents');
const { BudgetEngine } = require('../lib/budgets');
const { AgentBudgets, AgentBudgetError } = require('../lib/agent-budgets');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-abud-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  const registry = new AgentRegistry(store);
  const budgetEngine = new BudgetEngine(store);
  const agentBudgets = new AgentBudgets({ store, registry, budgetEngine });
  return { dir, db, store, registry, budgetEngine, agentBudgets };
}
function cleanup(env) {
  try { env.db.close(); } catch {}
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch {}
}

test('1 set_budget_for_agent', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  const b = env.agentBudgets.setForAgent(a.id, { tokens: 1000, jobs: 5 });
  assert.ok(b.id.startsWith('bud_'));
  assert.equal(b.subject_type, 'agent');
  assert.equal(b.subject_id, a.id);
  cleanup(env);
});

test('2 set_from_role_defaults', () => {
  const env = fresh();
  const w = env.registry.create({ name: 'w', role: 'worker' });
  const sup = env.registry.create({ name: 'sup', role: 'supervisor' });
  const bw = env.agentBudgets.setFromRoleDefaults(w.id);
  const bs = env.agentBudgets.setFromRoleDefaults(sup.id);
  const wLimits = JSON.parse(bw.limits_json);
  const sLimits = JSON.parse(bs.limits_json);
  assert.equal(wLimits.tokens, 50000);
  assert.equal(sLimits.tokens, 200000);
  cleanup(env);
});

test('3 set_from_role_defaults_with_overrides', () => {
  const env = fresh();
  const w = env.registry.create({ name: 'w', role: 'worker' });
  const b = env.agentBudgets.setFromRoleDefaults(w.id, { tokens: 999 });
  const limits = JSON.parse(b.limits_json);
  assert.equal(limits.tokens, 999);
  assert.equal(limits.jobs, 25); // unchanged from default
  cleanup(env);
});

test('4 unknown_role_rejected', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  // Override roleDefaults to remove worker
  const ab = new AgentBudgets({
    store: env.store, registry: env.registry, budgetEngine: env.budgetEngine,
    roleDefaults: { supervisor: { tokens: 1 } },
  });
  assert.throws(() => ab.setFromRoleDefaults(a.id), (e) => e.code === 'no_role_defaults');
  cleanup(env);
});

test('5 charge_single_agent', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  env.agentBudgets.setForAgent(a.id, { tokens: 1000 });
  const r = env.agentBudgets.charge(a.id, 'tokens', 100, 'ref-1');
  assert.equal(r.ok, true);
  assert.equal(r.chain.length, 1);
  assert.equal(r.chain[0].agent_id, a.id);
  cleanup(env);
});

test('6 charge_cascades_to_ancestors', () => {
  const env = fresh();
  const sup = env.registry.create({ name: 'sup', role: 'supervisor' });
  const w = env.registry.create({ name: 'w', role: 'worker', supervisorId: sup.id });
  env.agentBudgets.setForAgent(sup.id, { tokens: 10000 });
  env.agentBudgets.setForAgent(w.id, { tokens: 5000 });

  const r = env.agentBudgets.charge(w.id, 'tokens', 500, 'ref-1');
  assert.equal(r.ok, true);
  assert.equal(r.chain.length, 2);
  assert.equal(r.chain[0].agent_id, w.id);
  assert.equal(r.chain[1].agent_id, sup.id);

  const usage = env.agentBudgets.usageChain(w.id);
  const wUsed = Object.values(usage.chain[0].budgets)[0].kinds.tokens.used;
  const sUsed = Object.values(usage.chain[1].budgets)[0].kinds.tokens.used;
  assert.equal(wUsed, 500);
  assert.equal(sUsed, 500);
  cleanup(env);
});

test('7 charge_cascade_disabled', () => {
  const env = fresh();
  const sup = env.registry.create({ name: 'sup', role: 'supervisor' });
  const w = env.registry.create({ name: 'w', role: 'worker', supervisorId: sup.id });
  env.agentBudgets.setForAgent(sup.id, { tokens: 10000 });
  env.agentBudgets.setForAgent(w.id, { tokens: 5000 });

  const r = env.agentBudgets.charge(w.id, 'tokens', 500, 'ref-1', { cascade: false });
  assert.equal(r.chain.length, 1);

  const usage = env.agentBudgets.usageChain(w.id);
  const sUsed = Object.values(usage.chain[1].budgets)[0].kinds.tokens.used;
  assert.equal(sUsed, 0);
  cleanup(env);
});

test('8 check_passes_under_limits', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  env.agentBudgets.setForAgent(a.id, { tokens: 1000 });
  env.agentBudgets.charge(a.id, 'tokens', 100, 'ref');
  const r = env.agentBudgets.check(a.id);
  assert.equal(r.ok, true);
  cleanup(env);
});

test('9 check_fails_when_self_over_limit', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  env.agentBudgets.setForAgent(a.id, { tokens: 100 });
  env.agentBudgets.charge(a.id, 'tokens', 150, 'ref');
  const r = env.agentBudgets.check(a.id);
  assert.equal(r.ok, false);
  assert.equal(r.exceeded[0].agent_id, a.id);
  assert.equal(r.exceeded[0].kind, 'tokens');
  cleanup(env);
});

test('10 check_fails_when_ancestor_over_limit', () => {
  const env = fresh();
  const sup = env.registry.create({ name: 'sup', role: 'supervisor' });
  const w = env.registry.create({ name: 'w', role: 'worker', supervisorId: sup.id });
  env.agentBudgets.setForAgent(sup.id, { tokens: 200 });
  env.agentBudgets.setForAgent(w.id, { tokens: 1000 });

  env.agentBudgets.charge(w.id, 'tokens', 250, 'ref');
  const r = env.agentBudgets.check(w.id);
  assert.equal(r.ok, false);
  assert.ok(r.exceeded.some((e) => e.agent_id === sup.id));
  cleanup(env);
});

test('11 effective_limit_is_minimum_across_chain', () => {
  const env = fresh();
  const sup = env.registry.create({ name: 'sup', role: 'supervisor' });
  const w = env.registry.create({ name: 'w', role: 'worker', supervisorId: sup.id });
  env.agentBudgets.setForAgent(sup.id, { tokens: 100 });
  env.agentBudgets.setForAgent(w.id, { tokens: 200 });
  env.agentBudgets.charge(sup.id, 'tokens', 90, 'ref1');
  env.agentBudgets.charge(w.id, 'tokens', 50, 'ref2', { cascade: false });

  const eff = env.agentBudgets.effectiveLimit(w.id, 'tokens');
  assert.equal(eff.remaining, 10); // supervisor is the tightest
  assert.equal(eff.agent_id, sup.id);
  cleanup(env);
});

test('12 effective_limit_infinity_when_no_budget', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  const eff = env.agentBudgets.effectiveLimit(a.id, 'tokens');
  assert.equal(eff.remaining, Infinity);
  assert.equal(eff.limit, null);
  cleanup(env);
});

test('13 usage_chain_reports_all_links', () => {
  const env = fresh();
  const top = env.registry.create({ name: 'top', role: 'supervisor' });
  const mid = env.registry.create({ name: 'mid', role: 'supervisor', supervisorId: top.id });
  const w = env.registry.create({ name: 'w', role: 'worker', supervisorId: mid.id });
  env.agentBudgets.setForAgent(top.id, { tokens: 100000 });
  env.agentBudgets.setForAgent(mid.id, { tokens: 50000 });
  env.agentBudgets.setForAgent(w.id, { tokens: 10000 });

  const u = env.agentBudgets.usageChain(w.id);
  assert.equal(u.chain.length, 3);
  assert.equal(u.chain[0].agent_id, w.id);
  assert.equal(u.chain[1].agent_id, mid.id);
  assert.equal(u.chain[2].agent_id, top.id);
  cleanup(env);
});

test('14 revoked_agent_rejected', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  env.registry.revoke(a.id);
  assert.throws(() => env.agentBudgets.setForAgent(a.id, { tokens: 1 }),
    (e) => e.code === 'revoked');
  assert.throws(() => env.agentBudgets.charge(a.id, 'tokens', 1, 'ref'),
    (e) => e.code === 'revoked');
  cleanup(env);
});

test('15 constructor_and_input_validation', () => {
  assert.throws(() => new AgentBudgets({}),
    (e) => e instanceof AgentBudgetError && e.code === 'bad_store');
  const env = fresh();
  assert.throws(() => new AgentBudgets({ store: env.store }),
    (e) => e.code === 'bad_registry');
  assert.throws(() => new AgentBudgets({ store: env.store, registry: env.registry }),
    (e) => e.code === 'bad_budget_engine');

  const a = env.registry.create({ name: 'a', role: 'worker' });
  assert.throws(() => env.agentBudgets.setForAgent(a.id, {}),
    (e) => e.code === 'bad_limits');
  assert.throws(() => env.agentBudgets.charge('', 'tokens', 1, 'ref'),
    (e) => e.code === 'bad_agent_id');
  assert.throws(() => env.agentBudgets.effectiveLimit(a.id, ''),
    (e) => e.code === 'bad_kind');
  cleanup(env);
});
