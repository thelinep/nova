'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { AgentRegistry } = require('../lib/agents');
const { AgentTools, AgentToolError } = require('../lib/agent-tools');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-atool-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  const registry = new AgentRegistry(store);
  const tools = new AgentTools(store, { registry });
  return { dir, db, store, registry, tools };
}
function cleanup(env) {
  try { env.db.close(); } catch {}
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch {}
}

test('1 bind_and_check_allowed', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  const b = env.tools.bind(a.id, {
    kind: 'connector', toolId: 'conn_github', operations: ['pr:create'],
  });
  assert.ok(b.id.startsWith('bnd_'));
  const r = env.tools.check(a.id, { kind: 'connector', toolId: 'conn_github', operation: 'pr:create' });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'ok');
  assert.equal(r.binding.tool_id, 'conn_github');
  cleanup(env);
});

test('2 no_binding_denies', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  const r = env.tools.check(a.id, { kind: 'connector', toolId: 'conn_x', operation: 'x' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'no_binding');
  cleanup(env);
});

test('3 unknown_agent_denies_silently', () => {
  const env = fresh();
  const r = env.tools.check('nope', { kind: 'connector', toolId: 'x' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'unknown_agent');
  cleanup(env);
});

test('4 agent_disabled_denies', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  env.tools.bind(a.id, { kind: 'skill', toolId: 'lint' });
  env.registry.disable(a.id);
  const r = env.tools.check(a.id, { kind: 'skill', toolId: 'lint' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'agent_disabled');
  cleanup(env);
});

test('5 agent_revoked_denies', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  env.tools.bind(a.id, { kind: 'skill', toolId: 'lint' });
  env.registry.revoke(a.id);
  const r = env.tools.check(a.id, { kind: 'skill', toolId: 'lint' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'agent_revoked');
  cleanup(env);
});

test('6 operation_not_in_list_denies', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  env.tools.bind(a.id, {
    kind: 'connector', toolId: 'conn_github', operations: ['pr:create'],
  });
  const r = env.tools.check(a.id, { kind: 'connector', toolId: 'conn_github', operation: 'issue:delete' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'operation_not_allowed');
  cleanup(env);
});

test('7 empty_operations_allows_all', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  env.tools.bind(a.id, { kind: 'mcp', toolId: 'filesystem' });
  for (const op of ['read', 'write', 'delete', 'list']) {
    const r = env.tools.check(a.id, { kind: 'mcp', toolId: 'filesystem', operation: op });
    assert.equal(r.allowed, true, op + ' should be allowed');
  }
  cleanup(env);
});

test('8 binding_disabled_denies', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  const b = env.tools.bind(a.id, { kind: 'skill', toolId: 'lint' });
  env.tools.disable(b.id);
  const r = env.tools.check(a.id, { kind: 'skill', toolId: 'lint' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'binding_disabled');
  cleanup(env);
});

test('9 binding_revoked_denies', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  const b = env.tools.bind(a.id, { kind: 'skill', toolId: 'lint' });
  env.tools.unbind(b.id, a.id);
  const r = env.tools.check(a.id, { kind: 'skill', toolId: 'lint' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'no_binding');
  cleanup(env);
});

test('10 binding_expired_denies', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  env.tools.bind(a.id, {
    kind: 'skill', toolId: 'lint',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const r = env.tools.check(a.id, { kind: 'skill', toolId: 'lint' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'binding_expired');
  cleanup(env);
});

test('11 duplicate_binding_rejected', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  env.tools.bind(a.id, { kind: 'skill', toolId: 'lint' });
  assert.throws(
    () => env.tools.bind(a.id, { kind: 'skill', toolId: 'lint' }),
    (e) => e.code === 'duplicate'
  );
  cleanup(env);
});

test('12 set_operations_replaces', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  const b = env.tools.bind(a.id, {
    kind: 'connector', toolId: 'g',
    operations: ['pr:create'],
  });
  env.tools.setOperations(b.id, ['issue:read', 'issue:create']);
  const r1 = env.tools.check(a.id, { kind: 'connector', toolId: 'g', operation: 'issue:create' });
  const r2 = env.tools.check(a.id, { kind: 'connector', toolId: 'g', operation: 'pr:create' });
  assert.equal(r1.allowed, true);
  assert.equal(r2.allowed, false);
  cleanup(env);
});

test('13 list_and_effective_tools', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  env.tools.bind(a.id, { kind: 'skill', toolId: 'lint' });
  env.tools.bind(a.id, { kind: 'mcp', toolId: 'fs', operations: ['read'] });
  env.tools.bind(a.id, { kind: 'connector', toolId: 'gh', operations: ['pr:create'] });

  const list = env.tools.list(a.id);
  assert.equal(list.length, 3);

  const eff = env.tools.effectiveTools(a.id);
  assert.equal(eff.length, 3);
  const kinds = eff.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['connector', 'mcp', 'skill']);
  cleanup(env);
});

test('14 agents_for_tool', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  const b = env.registry.create({ name: 'b', role: 'worker' });
  const c = env.registry.create({ name: 'c', role: 'worker' });
  env.tools.bind(a.id, { kind: 'skill', toolId: 'lint' });
  env.tools.bind(b.id, { kind: 'skill', toolId: 'lint' });
  env.tools.bind(c.id, { kind: 'skill', toolId: 'other' });

  const users = env.tools.agentsFor('skill', 'lint');
  const ids = users.map((u) => u.agent.id).sort();
  assert.deepEqual(ids, [a.id, b.id].sort());
  cleanup(env);
});

test('15 constructor_and_input_validation', () => {
  assert.throws(() => new AgentTools(null, { registry: {} }),
    (e) => e instanceof AgentToolError && e.code === 'bad_store');
  const env = fresh();
  assert.throws(() => new AgentTools(env.store, {}),
    (e) => e instanceof AgentToolError && e.code === 'bad_registry');

  const a = env.registry.create({ name: 'a', role: 'worker' });
  assert.throws(() => env.tools.bind(a.id, { kind: 'magic', toolId: 'x' }),
    (e) => e.code === 'bad_kind');
  assert.throws(() => env.tools.bind(a.id, { kind: 'skill' }),
    (e) => e.code === 'bad_tool_id');
  assert.throws(() => env.tools.bind(a.id, { kind: 'skill', toolId: 'x', operations: 'no' }),
    (e) => e.code === 'bad_operations');
  assert.throws(() => env.tools.bind(a.id, { kind: 'skill', toolId: 'x', expiresAt: 'yesterday' }),
    (e) => e.code === 'bad_expiry');
  assert.throws(() => env.tools.bind('nope', { kind: 'skill', toolId: 'x' }),
    (e) => e.code === 'not_found');
  cleanup(env);
});
