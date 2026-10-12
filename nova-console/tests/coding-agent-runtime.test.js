'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, Store } = require('../lib/db');
const { AgentRegistry } = require('../lib/agents');
const { AgentTasks } = require('../lib/agent-tasks');
const { BudgetEngine } = require('../lib/budgets');
const { AgentBudgets } = require('../lib/agent-budgets');
const { CodingAgentRuntime, PLANNER_NAME, WORKER_NAME, JOB_KIND, LIMITS } = require('../lib/coding-agent-runtime');
const { PolicyEngine } = require('../lib/policy');

function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-coding-runtime-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  const registry = new AgentRegistry(store);
  const tasks = new AgentTasks(store, { registry });
  const budgetLedger = new AgentBudgets({ store, registry, budgetEngine: new BudgetEngine(store) });
  const policy = new PolicyEngine(store);
  const digest = 'sha256:' + 'b'.repeat(64);
  const response = { model: 'model:latest', message: { content: '{}' }, prompt_eval_count: 10, eval_count: 5 };
  const ollama = {
    host: options.ollamaHost || 'http://127.0.0.1:11434',
    status: async () => ({ reachable: true, models: [{ name: 'model:latest', digest }] }),
    show: async () => ({ capabilities: ['completion'], template: 'chat', model_info: { 'test.context_length': 8192 } }),
    chatFull: async (_model, _messages, request = {}) => {
      options.onChatStarted?.();
      if (options.chatImpl) return options.chatImpl(_model, _messages, request, response);
      if (options.cancelDuringChat) return new Promise((resolve, reject) => {
        if (request.signal?.aborted) return reject(request.signal.reason);
        request.signal?.addEventListener('abort', () => reject(request.signal.reason), { once: true });
      });
      return options.chatError ? Promise.reject(options.chatError) : response;
    },
  };
  const plan = { draft: { summary: 'Make a small change', changes: [{ operation: 'create', relativePath: 'new.txt', content: 'hello' }] }, acceptanceChecks: [], planner: { modelId: 'model:latest' } };
  const planner = {
    preview: async () => ({ ready: true, selectedModel: { id: 'model:latest', digest } }),
    plan: async (_store, _scanner, _changes, client, input, opts) => {
      assert.equal(input.modelId, 'model:latest');
      assert.equal(opts.draftOnly, true);
      await opts.modelAdapter.generate({ modelId: 'model:latest', modelDigest: digest, messages: [], signal: opts.signal, maxContextTokens: 8192, maxOutputTokens: 1024 });
      return plan;
    },
  };
  const scanner = { approvedRoot: () => ({ id: 'root_test', path: dir }) };
  const changes = {};
  const runtime = new CodingAgentRuntime({ store, registry, tasks, scanner, changes, planner, ollama, budgets: budgetLedger, policy });
  const agents = runtime.seed();
  return { dir, db, store, registry, tasks, budgetLedger, policy, digest, runtime, agents, planner };
}

test('Coding Studio Ollama adapter stays behind digest and token-budget guards', async () => {
  const seen = [];
  const env = fixture({ chatImpl: (model, _messages, generation, baseResponse) => {
    seen.push({ model, generation });
    return { ...baseResponse, prompt_eval_count: 11, eval_count: 4 };
  } });
  try {
    const ctx = { task: { id: 'tsk_adapter', payload: { codingStudio: true, rootId: 'root_test', modelId: 'model:latest', modelDigest: env.digest, request: 'Create new.txt', feedback: '' } }, agent: { id: env.agents.worker.id }, signal: new AbortController().signal };
    const result = await env.runtime._execute(ctx);
    assert.equal(result.usage.tokens, 15);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].model, 'model:latest');
    assert.equal(seen[0].generation.options.num_ctx, LIMITS.maxContextTokens);
    assert.equal(seen[0].generation.options.num_predict, LIMITS.maxOutputTokens);
    assert.equal(env.budgetLedger.effectiveLimit(env.agents.worker.id, 'tokens').used, 15);
  } finally { close(env); }
});

test('Coding Studio rejects model usage above the per-call output limit and charges the reservation', async () => {
  const env = fixture({ chatImpl: (_model, _messages, _generation, baseResponse) => ({ ...baseResponse, prompt_eval_count: 2, eval_count: 1025 }) });
  try {
    const ctx = { task: { id: 'tsk_usage_limit', payload: { codingStudio: true, rootId: 'root_test', modelId: 'model:latest', modelDigest: env.digest, request: 'Create new.txt', feedback: '' } }, agent: { id: env.agents.worker.id }, signal: new AbortController().signal };
    await assert.rejects(env.runtime._execute(ctx), error => error.code === 'per_call_usage_exceeded');
    assert.equal(env.budgetLedger.effectiveLimit(env.agents.worker.id, 'tokens').used, 8192, 'reserved context is charged when reported output exceeds its limit');
  } finally { close(env); }
});

test('late adapter completion after cancellation cannot change the next execution usage', async () => {
  let resolveFirst;
  let callCount = 0;
  let startedFirst;
  const firstStarted = new Promise(resolve => { startedFirst = resolve; });
  const env = fixture({ chatImpl: (_model, _messages, _generation, baseResponse) => {
      callCount += 1;
      if (callCount === 1) {
        startedFirst();
        return new Promise(resolve => { resolveFirst = () => resolve(baseResponse); });
      }
      return Promise.resolve({ ...baseResponse, prompt_eval_count: 10, eval_count: 5 });
  } });
  let plannerCalls = 0;
  const syntheticPlan = { draft: { summary: 'Make a small change', changes: [{ operation: 'create', relativePath: 'new.txt', content: 'hello' }] }, acceptanceChecks: [], planner: { modelId: 'model:latest' } };
  env.planner.plan = async (_store, _scanner, _changes, _client, input, opts) => {
    plannerCalls += 1;
    const request = { modelId: input.modelId, modelDigest: env.digest, messages: [], signal: opts.signal, maxContextTokens: 8192, maxOutputTokens: 1024 };
    const generation = opts.modelAdapter.generate(request);
    if (plannerCalls === 1) {
      await new Promise(resolve => opts.signal.addEventListener('abort', resolve, { once: true }));
      return syntheticPlan;
    }
    await generation;
    return syntheticPlan;
  };
  try {
    const firstController = new AbortController();
    const firstCtx = { task: { id: 'tsk_late_first', payload: { codingStudio: true, rootId: 'root_test', modelId: 'model:latest', modelDigest: env.digest, request: 'Create new.txt', feedback: '' } }, agent: { id: env.agents.worker.id }, signal: firstController.signal };
    const firstExecution = env.runtime._execute(firstCtx);
    await firstStarted;
    firstController.abort(new Error('cancelled'));
    await assert.rejects(firstExecution, /cancelled/);

    const secondCtx = { task: { id: 'tsk_late_second', payload: { codingStudio: true, rootId: 'root_test', modelId: 'model:latest', modelDigest: env.digest, request: 'Create new.txt', feedback: '' } }, agent: { id: env.agents.worker.id }, signal: new AbortController().signal };
    const second = await env.runtime._execute(secondCtx);
    assert.equal(second.usage.tokens, 15);
    resolveFirst();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(env.budgetLedger.effectiveLimit(env.agents.worker.id, 'tokens').used, 8192 + 15);
    assert.equal(env.runtime._usage.tokens, 0);
  } finally { close(env); }
});

test('Coding Studio rejects a remotely configured Ollama endpoint before preview or task creation', async () => {
  let previewed = false;
  const env = fixture({ ollamaHost: 'http://ollama.internal:11434' });
  env.planner.preview = async () => { previewed = true; return { ready: true }; };
  try {
    await assert.rejects(() => env.runtime.createTask({ rootId: 'root_test', modelId: 'model:latest', request: 'Create new.txt' }), error => error.statusCode === 503 && error.code === 'external_transmission_denied');
    assert.equal(previewed, false);
    assert.equal(env.store.agentTasksList({}).filter(task => JSON.parse(task.payload_json || '{}').codingStudio).length, 0);
  } finally { close(env); }
});
function close(env) { try { env.runtime.stop(); env.db.close(); } catch {} fs.rmSync(env.dir, { recursive: true, force: true }); }
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for Coding Studio task state.');
}

for (const outcome of ['success', 'failure']) {
  test(`Coding Studio ${outcome} settles bounded token usage exactly once`, async () => {
    const env = fixture({ chatError: outcome === 'failure' ? new Error('local model failure') : null });
    try {
      const ctx = { task: { id: 'tsk_usage', payload: { codingStudio: true, rootId: 'root_test', modelId: 'model:latest', modelDigest: env.digest, request: 'Create new.txt', feedback: '' } }, agent: { id: env.agents.worker.id }, signal: new AbortController().signal };
      if (outcome === 'success') {
        const result = await env.runtime._execute(ctx);
        assert.equal(result.usage.tokens, 15);
        assert.equal(env.budgetLedger.effectiveLimit(env.agents.worker.id, 'tokens').used, 15);
      } else {
        await assert.rejects(env.runtime._execute(ctx), /local model failure/);
        assert.equal(env.budgetLedger.effectiveLimit(env.agents.worker.id, 'tokens').used, LIMITS.maxContextTokens, 'failed request is charged its reserved context');
      }
      assert.equal(env.budgetLedger.effectiveLimit(env.agents.worker.id, 'tokens').used <= LIMITS.maxTotalTokens, true);
    } finally { close(env); }
  });
}

test('Coding Studio success charges one job and one measured token amount across runtime and bridge', async () => {
  const env = fixture();
  try {
    env.runtime.start();
    const { task } = await env.runtime.createTask({ rootId: 'root_test', modelId: 'model:latest', request: 'Create new.txt' });
    await waitFor(() => env.tasks.get(task.id).state === 'awaiting_result_review');
    assert.equal(env.budgetLedger.effectiveLimit(env.agents.worker.id, 'tokens').used, 15);
    assert.equal(env.budgetLedger.effectiveLimit(env.agents.worker.id, 'jobs').used, 1);
  } finally { close(env); }
});

test('Coding Studio cancellation charges one bounded reserved-token amount and one dispatched job', async () => {
  let chatStarted = false;
  const env = fixture({ cancelDuringChat: true, onChatStarted: () => { chatStarted = true; } });
  try {
    env.runtime.start();
    const { task } = await env.runtime.createTask({ rootId: 'root_test', modelId: 'model:latest', request: 'Create new.txt' });
    await waitFor(() => chatStarted);
    await env.runtime.cancelTask(task.id);
    await waitFor(() => env.tasks.get(task.id).state === 'cancelled');
    assert.equal(env.budgetLedger.effectiveLimit(env.agents.worker.id, 'tokens').used, LIMITS.maxContextTokens);
    assert.equal(env.budgetLedger.effectiveLimit(env.agents.worker.id, 'jobs').used, 1);
  } finally { close(env); }
});

test('coding-only bridge refuses an enqueue failure without leaving a task or job', async () => {
  const env = fixture();
  try {
    env.runtime.stop();
    // Replace just the engine enqueue behavior after bridge registration.
    env.runtime.engine.enqueue = () => { throw new Error('synthetic enqueue failure'); };
    await assert.rejects(env.runtime.createTask({ rootId: 'root_test', modelId: 'model:latest', request: 'Create new.txt' }), /synthetic enqueue failure/);
    assert.equal(env.store.agentTasksList({}).filter(task => JSON.parse(task.payload_json || '{}').codingStudio).length, 0);
    assert.equal(env.store.jobsListByKindAndState(JOB_KIND, 'queued').length, 0);
    assert.equal(env.store.jobsListByKindAndState(JOB_KIND, 'running').length, 0);
  } finally { close(env); }
});

test('Coding Studio honors an explicit deny for the internal worker and approved root', () => {
  const env = fixture();
  try {
    env.policy.grant({ subject: { type: 'agent', id: env.agents.worker.id }, resource: { type: 'workspace', id: 'root_test' }, effect: 'deny', scope: 'read_only' });
    assert.throws(() => env.runtime._assertPolicy(env.agents.worker.id, 'root_test'), /policy denied/i);
  } finally { close(env); }
});

test('failed Coding Studio tasks retry with fresh feedback after all dispatch gates pass', async () => {
  const env = fixture();
  try {
    env.runtime.start();
    const row = env.tasks.create({ creatorId: env.agents.planner.id, assigneeId: env.agents.worker.id, title: 'Coding Studio proposal', payload: { codingStudio: true, rootId: 'root_test', modelId: 'model:latest', modelDigest: env.digest, request: 'Create new.txt', brahmiComments: false, feedback: 'Earlier attempt feedback.' } });
    env.tasks.start(row.id, env.agents.worker.id);
    env.tasks.fail(row.id, 'synthetic model failure', env.agents.worker.id);

    assert.equal(env.runtime.detail(row.id).controls.retry_available, true);
    await assert.rejects(env.runtime.retryTask(row.id, { feedback: '  ' }), error => error.code === 'bad_feedback');
    await assert.rejects(env.runtime.retryTask(row.id, { feedback: ' Earlier attempt feedback. ' }), error => error.code === 'unchanged_feedback');
    env.planner.preview = async () => ({ ready: true, selectedModel: { id: 'model:latest', digest: 'sha256:' + 'c'.repeat(64) } });
    await assert.rejects(env.runtime.retryTask(row.id, { feedback: 'Explain the correction.' }), error => error.code === 'model_digest_changed');
    assert.equal(env.tasks.get(row.id).state, 'failed', 'a stale model cannot restart the failed task');
    env.planner.preview = async () => ({ ready: true, selectedModel: { id: 'model:latest', digest: env.digest } });

    const retried = await env.runtime.retryTask(row.id, { feedback: 'Use the requested project scope and explain the correction.' });
    assert.equal(retried.task.state, 'running');
    assert.equal(JSON.parse(env.tasks.get(row.id).payload_json).feedback, 'Use the requested project scope and explain the correction.');
    await waitFor(() => env.tasks.get(row.id).state === 'awaiting_result_review');
    assert.equal(env.runtime.detail(row.id).controls.retry_available, false);
    assert.equal(env.budgetLedger.effectiveLimit(env.agents.worker.id, 'jobs').used, 1);
  } finally { close(env); }
});
