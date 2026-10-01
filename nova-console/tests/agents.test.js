'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { AgentRegistry, AgentRegistryError } = require('../lib/agents');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-agt-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  return { dir, db, store };
}
function cleanup(env) {
  try { env.db.close(); } catch {}
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch {}
}

test('1 create_worker_agent', () => {
  const env = fresh();
  const r = new AgentRegistry(env.store);
  const a = r.create({
    name: 'builder-1',
    role: 'worker',
    description: 'builds things',
    instructions: { system: 'You build.' },
    modelPreference: { model: 'llama3.2:latest', temperature: 0.2 },
    allowedTools: ['file:read', 'file:write'],
    createdBy: 'alice',
  });
  assert.ok(a.id.startsWith('agt_'));
  assert.equal(a.name, 'builder-1');
  assert.equal(a.role, 'worker');
  assert.equal(a.enabled, 1);
  assert.equal(a.memory_scope, 'private');
  assert.equal(a.created_by, 'alice');
  cleanup(env);
});

test('2 unknown_role_rejected', () => {
  const env = fresh();
  const r = new AgentRegistry(env.store);
  assert.throws(
    () => r.create({ name: 'x', role: 'wizard' }),
    (e) => e.code === 'unknown_role'
  );
  cleanup(env);
});

test('3 duplicate_name_rejected', () => {
  const env = fresh();
  const r = new AgentRegistry(env.store);
  r.create({ name: 'a', role: 'worker' });
  assert.throws(() => r.create({ name: 'a', role: 'worker' }), (e) => e.code === 'duplicate_name');
  cleanup(env);
});

test('4 instructions_round_trip', () => {
  const env = fresh();
  const r = new AgentRegistry(env.store);
  const a = r.create({
    name: 'a', role: 'worker',
    instructions: { system: 'be careful', rules: ['no secrets'] },
  });
  const inst = r.instructions(a.id);
  assert.equal(inst.system, 'be careful');
  assert.deepEqual(inst.rules, ['no secrets']);
  cleanup(env);
});

test('5 allowed_tools_round_trip_and_has', () => {
  const env = fresh();
  const r = new AgentRegistry(env.store);
  const a = r.create({
    name: 'a', role: 'worker',
    allowedTools: ['file:read', 'file:write', 'http:get'],
  });
  assert.deepEqual(r.allowedTools(a.id), ['file:read', 'file:write', 'http:get']);
  assert.equal(r.hasTool(a.id, 'file:read'), true);
  assert.equal(r.hasTool(a.id, 'shell:exec'), false);
  cleanup(env);
});

test('6 invalid_tool_name_rejected', () => {
  const env = fresh();
  const r = new AgentRegistry(env.store);
  assert.throws(
    () => r.create({ name: 'a', role: 'worker', allowedTools: ['has spaces'] }),
    (e) => e.code === 'bad_tool_name'
  );
  cleanup(env);
});

test('7 set_allowed_tools_replaces', () => {
  const env = fresh();
  const r = new AgentRegistry(env.store);
  const a = r.create({ name: 'a', role: 'worker', allowedTools: ['x'] });
  r.setAllowedTools(a.id, ['y', 'z']);
  assert.deepEqual(r.allowedTools(a.id), ['y', 'z']);
  cleanup(env);
});

test('8 model_preference_round_trip', () => {
  const env = fresh();
  const r = new AgentRegistry(env.store);
  const a = r.create({
    name: 'a', role: 'worker',
    modelPreference: { model: 'llama3.2:latest', temperature: 0.4 },
  });
  const p = r.modelPreference(a.id);
  assert.equal(p.model, 'llama3.2:latest');
  assert.equal(p.temperature, 0.4);
  r.setModelPreference(a.id, null);
  assert.equal(r.modelPreference(a.id), null);
  cleanup(env);
});

test('9 supervisor_relations', () => {
  const env = fresh();
  const r = new AgentRegistry(env.store);
  const sup = r.create({ name: 'sup', role: 'supervisor' });
  const w1 = r.create({ name: 'w1', role: 'worker', supervisorId: sup.id });
  const w2 = r.create({ name: 'w2', role: 'worker', supervisorId: sup.id });
  assert.equal(r.get(w1.id).supervisor_id, sup.id);
  assert.equal(r.get(w2.id).supervisor_id, sup.id);
  const subs = r.subordinates(sup.id);
  assert.equal(subs.length, 2);
  cleanup(env);
});

test('10 self_supervisor_rejected', () => {
  const env = fresh();
  const r = new AgentRegistry(env.store);
  const a = r.create({ name: 'a', role: 'worker' });
  assert.throws(() => r.setSupervisor(a.id, a.id), (e) => e.code === 'self_supervisor');
  cleanup(env);
});

test('11 supervisor_cycle_rejected', () => {
  const env = fresh();
  const r = new AgentRegistry(env.store);
  const a = r.create({ name: 'a', role: 'worker' });
  const b = r.create({ name: 'b', role: 'supervisor', supervisorId: a.id });
  assert.throws(() => r.setSupervisor(a.id, b.id), (e) => e.code === 'supervisor_cycle');
  cleanup(env);
});

test('12 enable_disable_revoke', () => {
  const env = fresh();
  const r = new AgentRegistry(env.store);
  const a = r.create({ name: 'a', role: 'worker' });
  assert.equal(r.isActive(a.id), true);
  r.disable(a.id);
  assert.equal(r.isActive(a.id), false);
  r.enable(a.id);
  assert.equal(r.isActive(a.id), true);
  const rev = r.revoke(a.id);
  assert.ok(rev.revoked_at);
  assert.equal(r.isActive(a.id), false);
  cleanup(env);
});

test('13 cannot_revoke_with_subordinates', () => {
  const env = fresh();
  const r = new AgentRegistry(env.store);
  const sup = r.create({ name: 'sup', role: 'supervisor' });
  r.create({ name: 'w', role: 'worker', supervisorId: sup.id });
  assert.throws(() => r.revoke(sup.id), (e) => e.code === 'has_subordinates');
  cleanup(env);
});

test('14 list_filters_and_health', () => {
  const env = fresh();
  const r = new AgentRegistry(env.store);
  r.create({ name: 'w1', role: 'worker' });
  r.create({ name: 'w2', role: 'worker' });
  const sup = r.create({ name: 'sup', role: 'supervisor' });
  const disabled = r.create({ name: 'w3', role: 'worker', supervisorId: sup.id });
  r.disable(disabled.id);

  assert.equal(r.list({}).length, 4);
  assert.equal(r.list({ role: 'worker' }).length, 3);
  assert.equal(r.list({ enabled: true }).length, 3);
  assert.equal(r.list({ supervisor_id: sup.id }).length, 1);

  const h = r.health();
  assert.equal(h.total, 4);
  assert.equal(h.enabled, 3);
  assert.equal(h.disabled, 1);
  assert.equal(h.with_supervisor, 1);
  assert.equal(h.by_role.worker, 3);
  cleanup(env);
});

test('15 constructor_and_input_validation', () => {
  assert.throws(() => new AgentRegistry(null),
    (e) => e instanceof AgentRegistryError && e.code === 'bad_store');

  const env = fresh();
  const r = new AgentRegistry(env.store);
  assert.throws(() => r.create({}), (e) => e.code === 'bad_name');
  assert.throws(() => r.create({ name: 'a' }), (e) => e.code === 'bad_role');
  assert.throws(() => r.create({ name: 'a', role: 'worker', instructions: 'no' }),
    (e) => e.code === 'bad_instructions');
  assert.throws(() => r.create({ name: 'a', role: 'worker', allowedTools: 'x' }),
    (e) => e.code === 'bad_tools');
  assert.throws(() => r.create({ name: 'a', role: 'worker', memoryScope: 'wizard' }),
    (e) => e.code === 'bad_memory_scope');
  assert.throws(() => r.get(''), (e) => e.code === 'bad_id');
  cleanup(env);
});
