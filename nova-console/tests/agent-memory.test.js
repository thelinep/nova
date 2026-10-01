'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { AgentRegistry } = require('../lib/agents');
const { AgentMemory, AgentMemoryError } = require('../lib/agent-memory');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-amem-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  const registry = new AgentRegistry(store);
  const memory = new AgentMemory(store, { registry });
  return { dir, db, store, registry, memory };
}
function cleanup(env) {
  try { env.db.close(); } catch {}
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch {}
}

test('1 remember_and_recall_own_private', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  const m = env.memory.remember(a.id, { kind: 'observation', content: { text: 'saw a bird' } });
  assert.ok(m.id.startsWith('mem_'));
  assert.equal(m.agent_id, a.id);
  assert.equal(m.kind, 'observation');
  assert.equal(m.scope, 'private');

  const rows = env.memory.recall(a.id, {});
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].content, { text: 'saw a bird' });
  cleanup(env);
});

test('2 unknown_kind_rejected', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  assert.throws(
    () => env.memory.remember(a.id, { kind: 'vision', content: 'x' }),
    (e) => e.code === 'bad_kind'
  );
  cleanup(env);
});

test('3 missing_content_rejected', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  assert.throws(
    () => env.memory.remember(a.id, { kind: 'note' }),
    (e) => e.code === 'bad_content'
  );
  cleanup(env);
});

test('4 invalid_confidence_rejected', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  assert.throws(
    () => env.memory.remember(a.id, { kind: 'note', content: 'x', confidence: 2 }),
    (e) => e.code === 'bad_confidence'
  );
  assert.throws(
    () => env.memory.remember(a.id, { kind: 'note', content: 'x', confidence: -0.1 }),
    (e) => e.code === 'bad_confidence'
  );
  cleanup(env);
});

test('5 remember_defaults_to_agent_memory_scope', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker', memoryScope: 'shared' });
  const m = env.memory.remember(a.id, { kind: 'note', content: 'x' });
  assert.equal(m.scope, 'shared');
  cleanup(env);
});

test('6 private_not_visible_to_peers', () => {
  const env = fresh();
  const sup = env.registry.create({ name: 'sup', role: 'supervisor' });
  const a = env.registry.create({ name: 'a', role: 'worker', supervisorId: sup.id });
  const b = env.registry.create({ name: 'b', role: 'worker', supervisorId: sup.id });
  env.memory.remember(a.id, { kind: 'note', content: 'secret of a', scope: 'private' });
  const rows = env.memory.recall(b.id, {});
  assert.equal(rows.length, 0);
  cleanup(env);
});

test('7 shared_visible_to_peers', () => {
  const env = fresh();
  const sup = env.registry.create({ name: 'sup', role: 'supervisor' });
  const a = env.registry.create({ name: 'a', role: 'worker', supervisorId: sup.id });
  const b = env.registry.create({ name: 'b', role: 'worker', supervisorId: sup.id });
  env.memory.remember(a.id, { kind: 'note', content: 'team info', scope: 'shared' });
  const rows = env.memory.recall(b.id, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent_id, a.id);
  cleanup(env);
});

test('8 shared_not_visible_across_supervisors', () => {
  const env = fresh();
  const s1 = env.registry.create({ name: 's1', role: 'supervisor' });
  const s2 = env.registry.create({ name: 's2', role: 'supervisor' });
  const a = env.registry.create({ name: 'a', role: 'worker', supervisorId: s1.id });
  const b = env.registry.create({ name: 'b', role: 'worker', supervisorId: s2.id });
  env.memory.remember(a.id, { kind: 'note', content: 'x', scope: 'shared' });
  const rows = env.memory.recall(b.id, {});
  assert.equal(rows.length, 0);
  cleanup(env);
});

test('9 supervisor_visible_reaches_direct_supervisor', () => {
  const env = fresh();
  const sup = env.registry.create({ name: 'sup', role: 'supervisor' });
  const w = env.registry.create({ name: 'w', role: 'worker', supervisorId: sup.id });
  env.memory.remember(w.id, { kind: 'decision', content: 'chose plan B', scope: 'supervisor-visible' });
  const rows = env.memory.recall(sup.id, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent_id, w.id);
  cleanup(env);
});

test('10 supervisor_visible_reaches_transitive_supervisor', () => {
  const env = fresh();
  const top = env.registry.create({ name: 'top', role: 'supervisor' });
  const mid = env.registry.create({ name: 'mid', role: 'supervisor', supervisorId: top.id });
  const w = env.registry.create({ name: 'w', role: 'worker', supervisorId: mid.id });
  env.memory.remember(w.id, { kind: 'lesson', content: 'learned x', scope: 'supervisor-visible' });
  const rows = env.memory.recall(top.id, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent_id, w.id);
  cleanup(env);
});

test('11 supervisor_visible_not_seen_by_peers', () => {
  const env = fresh();
  const sup = env.registry.create({ name: 'sup', role: 'supervisor' });
  const a = env.registry.create({ name: 'a', role: 'worker', supervisorId: sup.id });
  const b = env.registry.create({ name: 'b', role: 'worker', supervisorId: sup.id });
  env.memory.remember(a.id, { kind: 'note', content: 'reports up', scope: 'supervisor-visible' });
  const rows = env.memory.recall(b.id, {});
  assert.equal(rows.length, 0);
  cleanup(env);
});

test('12 tag_filter', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  env.memory.remember(a.id, { kind: 'note', content: 'x', tags: ['alpha', 'beta'] });
  env.memory.remember(a.id, { kind: 'note', content: 'y', tags: ['beta'] });
  env.memory.remember(a.id, { kind: 'note', content: 'z', tags: ['gamma'] });
  assert.equal(env.memory.recall(a.id, { tags: ['alpha'] }).length, 1);
  assert.equal(env.memory.recall(a.id, { tags: ['beta'] }).length, 2);
  assert.equal(env.memory.recall(a.id, { tags: ['alpha', 'gamma'] }).length, 2);
  cleanup(env);
});

test('13 kind_filter', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  env.memory.remember(a.id, { kind: 'observation', content: 'x' });
  env.memory.remember(a.id, { kind: 'decision', content: 'y' });
  env.memory.remember(a.id, { kind: 'observation', content: 'z' });
  assert.equal(env.memory.recall(a.id, { kind: 'observation' }).length, 2);
  assert.equal(env.memory.recall(a.id, { kind: 'decision' }).length, 1);
  cleanup(env);
});

test('14 forget_only_by_owner', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  const b = env.registry.create({ name: 'b', role: 'worker' });
  const m = env.memory.remember(a.id, { kind: 'note', content: 'x' });
  assert.throws(() => env.memory.forget(m.id, b.id), (e) => e.code === 'not_owner');
  env.memory.forget(m.id, a.id);
  assert.equal(env.memory.recall(a.id, {}).length, 0);
  cleanup(env);
});

test('15 prune_by_kind_and_before', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  env.memory.remember(a.id, { kind: 'observation', content: 'x' });
  env.memory.remember(a.id, { kind: 'note', content: 'y' });
  env.memory.remember(a.id, { kind: 'note', content: 'z' });
  const r = env.memory.prune(a.id, { kind: 'note' });
  assert.equal(r.deleted, 2);
  assert.equal(env.memory.recall(a.id, {}).length, 1);
  cleanup(env);
});

test('16 counts_and_summary', () => {
  const env = fresh();
  const a = env.registry.create({ name: 'a', role: 'worker' });
  env.memory.remember(a.id, { kind: 'observation', content: '1' });
  env.memory.remember(a.id, { kind: 'observation', content: '2' });
  env.memory.remember(a.id, { kind: 'decision', content: '3' });
  const counts = env.memory.countsByKind(a.id);
  assert.equal(counts.observation, 2);
  assert.equal(counts.decision, 1);
  const s = env.memory.summarise(a.id, { perKind: 1 });
  assert.equal(s.agent_id, a.id);
  assert.ok(s.recent.observation);
  assert.ok(s.recent.decision);
  assert.equal(s.recent.observation.length, 1);
  cleanup(env);
});

test('17 constructor_and_input_validation', () => {
  assert.throws(() => new AgentMemory(null, { registry: {} }),
    (e) => e instanceof AgentMemoryError && e.code === 'bad_store');
  const env = fresh();
  assert.throws(() => new AgentMemory(env.store, {}),
    (e) => e instanceof AgentMemoryError && e.code === 'bad_registry');
  assert.throws(
    () => env.memory.remember('nope', { kind: 'note', content: 'x' }),
    (e) => e.code === 'not_found'
  );
  assert.throws(
    () => env.memory.remember(env.registry.create({ name: 'a', role: 'worker' }).id,
      { kind: 'note', content: 'x', scope: 'wizard' }),
    (e) => e.code === 'bad_scope'
  );
  assert.throws(
    () => env.memory.remember(env.registry.create({ name: 'b', role: 'worker' }).id,
      { kind: 'note', content: 'x', tags: 'not-array' }),
    (e) => e.code === 'bad_tags'
  );
  cleanup(env);
});
