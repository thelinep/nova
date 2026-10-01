'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { AgentRegistry } = require('../lib/agents');
const { AgentTasks } = require('../lib/agent-tasks');
const { AgentMemory } = require('../lib/agent-memory');
const { AgentTools } = require('../lib/agent-tools');
const { AgentJobBridge, AgentJobBridgeError } = require('../lib/agent-job-bridge');
const { JobEngine } = require('../lib/jobs');
const { BudgetEngine } = require('../lib/budgets');
const { AgentBudgets } = require('../lib/agent-budgets');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ajb-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  const registry = new AgentRegistry(store);
  const tasks = new AgentTasks(store, { registry });
  const jobEngine = new JobEngine(store, { pollMs: 20 });
  return { dir, db, store, registry, tasks, jobEngine };
}
function cleanup(env) {
  try { env.jobEngine.stop(); } catch {}
  try { env.db.close(); } catch {}
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch {}
}

function waitFor(fn, timeoutMs, stepMs) {
  timeoutMs = timeoutMs || 3000;
  stepMs = stepMs || 15;
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      try { if (fn()) return resolve(); }
      catch (e) { return reject(e); }
      if (Date.now() > deadline) return reject(new Error('waitFor timeout'));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

function setup(opts) {
  opts = opts || {};
  const env = fresh();
  const sup = env.registry.create({ name: 'sup', role: 'supervisor' });
  const worker = env.registry.create({
    name: 'worker', role: 'worker', supervisorId: sup.id,
  });
  const planner = env.registry.create({ name: 'planner', role: 'planner' });

  const task = env.tasks.create({
    title: 'job bridge task',
    creatorId: planner.id,
    assigneeId: worker.id,
  });

  const bridge = new AgentJobBridge(env.store, {
    registry: env.registry,
    tasks: env.tasks,
    jobEngine: env.jobEngine,
    executor: opts.executor || (async () => ({ ok: true })),
    memory: opts.memory || null,
    tools: opts.tools || null,
    budgets: opts.budgets || null,
    audit: opts.audit || null,
  });
  bridge.register();

  return { env, sup, worker, planner, task, bridge };
}

test('1 register_installs_handler', () => {
  const s = setup();
  assert.equal(s.env.jobEngine.handlers.has('agent.task'), true);
  cleanup(s.env);
});

test('2 start_task_transitions_to_running', async () => {
  const s = setup();
  const { task, job } = await s.bridge.startTask(s.task.id, s.worker.id);
  assert.equal(task.state, 'running');
  assert.ok(task.job_id);
  assert.equal(task.job_id, job.id);
  cleanup(s.env);
});

test('3 not_assigned_task_rejected', async () => {
  const env = fresh();
  const planner = env.registry.create({ name: 'p', role: 'planner' });
  const t = env.tasks.create({ title: 'x', creatorId: planner.id });
  const bridge = new AgentJobBridge(env.store, {
    registry: env.registry, tasks: env.tasks, jobEngine: env.jobEngine,
    executor: async () => ({}),
  });
  await assert.rejects(() => bridge.startTask(t.id, planner.id),
    (e) => e.code === 'not_assigned');
  cleanup(env);
});

test('4 unknown_task_rejected', async () => {
  const s = setup();
  await assert.rejects(() => s.bridge.startTask('tsk_nope', s.worker.id),
    (e) => e.code === 'not_found');
  cleanup(s.env);
});

test('5 executor_receives_context', async () => {
  let seen = null;
  const s = setup({
    executor: async (ctx) => { seen = ctx; return { ok: true }; },
  });
  await s.bridge.startTask(s.task.id, s.worker.id);
  s.env.jobEngine.start();
  await waitFor(() => s.env.tasks.get(s.task.id).state === 'completed', 3000);
  assert.ok(seen);
  assert.equal(seen.task.id, s.task.id);
  assert.equal(seen.task.title, 'job bridge task');
  assert.equal(seen.agent.id, s.worker.id);
  assert.equal(seen.agent.role, 'worker');
  assert.ok(seen.agent.instructions);
  assert.ok(typeof seen.progress === 'function');
  assert.ok(typeof seen.isCancelled === 'function');
  cleanup(s.env);
});

test('6 task_completes_when_executor_returns', async () => {
  const s = setup({ executor: async () => ({ value: 42 }) });
  await s.bridge.startTask(s.task.id, s.worker.id);
  s.env.jobEngine.start();
  await waitFor(() => s.env.tasks.get(s.task.id).state === 'completed', 3000);
  const row = s.env.tasks.get(s.task.id);
  assert.equal(JSON.parse(row.result_json).value, 42);
  cleanup(s.env);
});

test('7 task_fails_when_executor_throws', async () => {
  const s = setup({ executor: async () => { throw new Error('executor broke'); } });
  await s.bridge.startTask(s.task.id, s.worker.id);
  s.env.jobEngine.start();
  await waitFor(() => s.env.tasks.get(s.task.id).state === 'failed', 3000);
  const row = s.env.tasks.get(s.task.id);
  assert.match(row.error, /executor broke/);
  cleanup(s.env);
});

test('8 memory_summary_passed_to_executor', async () => {
  const env = fresh();
  const registry = env.registry;
  const tasks = env.tasks;
  const memory = new AgentMemory(env.store, { registry });
  const worker = registry.create({ name: 'w', role: 'worker' });
  const planner = registry.create({ name: 'p', role: 'planner' });
  memory.remember(worker.id, { kind: 'note', content: 'remember this' });
  const task = tasks.create({ title: 't', creatorId: planner.id, assigneeId: worker.id });

  let seen = null;
  const bridge = new AgentJobBridge(env.store, {
    registry, tasks, jobEngine: env.jobEngine, memory,
    executor: async (ctx) => { seen = ctx.memory; return {}; },
  });
  bridge.register();
  await bridge.startTask(task.id, worker.id);
  env.jobEngine.start();
  await waitFor(() => tasks.get(task.id).state === 'completed', 3000);
  assert.ok(seen);
  assert.equal(seen.agent_id, worker.id);
  assert.ok(seen.counts);
  cleanup(env);
});

test('9 tools_list_passed_to_executor', async () => {
  const env = fresh();
  const registry = env.registry;
  const tasks = env.tasks;
  const tools = new AgentTools(env.store, { registry });
  const worker = registry.create({ name: 'w', role: 'worker' });
  const planner = registry.create({ name: 'p', role: 'planner' });
  tools.bind(worker.id, { kind: 'skill', toolId: 'lint', operations: ['run'] });
  const task = tasks.create({ title: 't', creatorId: planner.id, assigneeId: worker.id });

  let seen = null;
  const bridge = new AgentJobBridge(env.store, {
    registry, tasks, jobEngine: env.jobEngine, tools,
    executor: async (ctx) => { seen = ctx.tools; return {}; },
  });
  bridge.register();
  await bridge.startTask(task.id, worker.id);
  env.jobEngine.start();
  await waitFor(() => tasks.get(task.id).state === 'completed', 3000);
  assert.ok(Array.isArray(seen));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'skill');
  assert.equal(seen[0].tool_id, 'lint');
  cleanup(env);
});

test('10 budget_precheck_fails_task', async () => {
  const env = fresh();
  const registry = env.registry;
  const tasks = env.tasks;
  const budgetEngine = new BudgetEngine(env.store);
  const budgets = new AgentBudgets({ store: env.store, registry, budgetEngine });

  const worker = registry.create({ name: 'w', role: 'worker' });
  const planner = registry.create({ name: 'p', role: 'planner' });
  budgets.setForAgent(worker.id, { tokens: 100 });
  budgetEngine.charge({ type: 'agent', id: worker.id }, 'tokens', 150, 'pre');

  const task = tasks.create({ title: 't', creatorId: planner.id, assigneeId: worker.id });

  let executorRan = false;
  const bridge = new AgentJobBridge(env.store, {
    registry, tasks, jobEngine: env.jobEngine, budgets,
    executor: async () => { executorRan = true; return {}; },
  });
  bridge.register();
  await bridge.startTask(task.id, worker.id);
  env.jobEngine.start();
  await waitFor(() => tasks.get(task.id).state === 'failed', 3000);
  assert.equal(executorRan, false);
  assert.match(tasks.get(task.id).error, /budget/);
  cleanup(env);
});

test('11 budget_charged_on_success', async () => {
  const env = fresh();
  const registry = env.registry;
  const tasks = env.tasks;
  const budgetEngine = new BudgetEngine(env.store);
  const budgets = new AgentBudgets({ store: env.store, registry, budgetEngine });

  const worker = registry.create({ name: 'w', role: 'worker' });
  const planner = registry.create({ name: 'p', role: 'planner' });
  budgets.setForAgent(worker.id, { tokens: 1000, usd: 10, jobs: 5 });

  const task = tasks.create({ title: 't', creatorId: planner.id, assigneeId: worker.id });

  const bridge = new AgentJobBridge(env.store, {
    registry, tasks, jobEngine: env.jobEngine, budgets,
    executor: async () => ({ usage: { tokens: 250, usd: 0.5 } }),
  });
  bridge.register();
  await bridge.startTask(task.id, worker.id);
  env.jobEngine.start();
  await waitFor(() => tasks.get(task.id).state === 'completed', 3000);

  const usage = budgetEngine.usage({ type: 'agent', id: worker.id });
  const bucket = Object.values(usage)[0];
  assert.equal(bucket.kinds.tokens.used, 250);
  assert.equal(bucket.kinds.usd.used, 0.5);
  assert.equal(bucket.kinds.jobs.used, 1);
  cleanup(env);
});

test('12 reconcile_marks_orphaned_running_tasks_failed', () => {
  const env = fresh();
  const registry = env.registry;
  const tasks = env.tasks;
  const worker = registry.create({ name: 'w', role: 'worker' });
  const planner = registry.create({ name: 'p', role: 'planner' });
  const t = tasks.create({ title: 't', creatorId: planner.id, assigneeId: worker.id });
  tasks.start(t.id, worker.id);
  // Simulate an orphaned running task with no job row.
  const bridge = new AgentJobBridge(env.store, {
    registry, tasks, jobEngine: env.jobEngine, executor: async () => ({}),
  });
  const r = bridge.reconcile();
  assert.equal(r.reconciled, 1);
  assert.equal(tasks.get(t.id).state, 'failed');
  assert.match(tasks.get(t.id).error, /job_orphaned/);
  cleanup(env);
});

test('13 reconcile_leaves_active_tasks_alone', async () => {
  const s = setup({ executor: async () => { await new Promise((r) => setTimeout(r, 500)); return {}; } });
  await s.bridge.startTask(s.task.id, s.worker.id);
  s.env.jobEngine.start();
  await waitFor(() => s.env.tasks.get(s.task.id).state === 'running', 1000);
  const r = s.bridge.reconcile();
  assert.equal(r.reconciled, 0);
  assert.equal(s.env.tasks.get(s.task.id).state, 'running');
  cleanup(s.env);
});

test('14 constructor_and_input_validation', () => {
  assert.throws(() => new AgentJobBridge(null, {}),
    (e) => e instanceof AgentJobBridgeError && e.code === 'bad_store');
  const env = fresh();
  assert.throws(() => new AgentJobBridge(env.store, {}),
    (e) => e.code === 'bad_registry');
  assert.throws(() => new AgentJobBridge(env.store, { registry: env.registry }),
    (e) => e.code === 'bad_tasks');
  assert.throws(() => new AgentJobBridge(env.store, { registry: env.registry, tasks: env.tasks }),
    (e) => e.code === 'bad_job_engine');
  assert.throws(() => new AgentJobBridge(env.store, {
    registry: env.registry, tasks: env.tasks, jobEngine: env.jobEngine,
  }), (e) => e.code === 'bad_executor');
  cleanup(env);
});

test('15 audit_events_written', async () => {
  const events = [];
  const s = setup({
    executor: async () => ({ ok: true }),
    audit: (e) => events.push(e),
  });
  await s.bridge.startTask(s.task.id, s.worker.id);
  s.env.jobEngine.start();
  await waitFor(() => s.env.tasks.get(s.task.id).state === 'completed', 3000);
  const actions = events.map((e) => e.action);
  assert.ok(actions.includes('agent_job.task_started'));
  assert.ok(actions.includes('agent_job.task_completed'));
  cleanup(s.env);
});
