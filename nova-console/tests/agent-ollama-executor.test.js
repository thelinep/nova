'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  agentOllamaExecutor,
  AgentOllamaExecutorError,
  composeSystem,
  composeUser,
  extractContent,
  extractUsage,
} = require('../lib/agent-ollama-executor');

function ctxOf(overrides) {
  return Object.assign({
    task: { id: 'tsk_1', title: 'Add two numbers', description: 'Return a + b.', payload: { a: 1, b: 2 } },
    agent: {
      id: 'agt_1',
      name: 'worker',
      role: 'worker',
      instructions: { system: 'You are careful.', rules: ['do not leak secrets'] },
      model_preference: { model: 'llama3.2:latest', temperature: 0.2 },
    },
    memory: {
      agent_id: 'agt_1',
      counts: { lesson: 1 },
      recent: { lesson: [{ content: { learned: 'no force-push' } }] },
    },
    tools: [{ kind: 'skill', tool_id: 'lint', operations: ['run'] }],
    jobId: 'job_1',
    attempts: 1,
    progress: () => {},
    isCancelled: () => false,
  }, overrides || {});
}

const echo = (out) => async () => out;
const capture = (captured) => async (params) => { captured.push(params); return { content: 'ok' }; };

test('1 returns output and usage on happy path', async () => {
  const exec = agentOllamaExecutor({
    chat: echo({ message: { content: 'result text' }, eval_count: 10, prompt_eval_count: 5 }),
  });
  const r = await exec(ctxOf());
  assert.equal(r.output, 'result text');
  assert.equal(r.usage.tokens, 15);
  assert.equal(r.meta.model, 'llama3.2:latest');
  assert.equal(r.meta.temperature, 0.2);
});

test('2 default model used when no preference', async () => {
  const exec = agentOllamaExecutor({
    chat: echo({ content: 'x' }),
    defaultModel: 'llama3:latest',
  });
  const r = await exec(ctxOf({ agent: { id: 'a', instructions: {} } }));
  assert.equal(r.meta.model, 'llama3:latest');
});

test('3 no_model_throws', async () => {
  const exec = agentOllamaExecutor({ chat: echo('x') });
  await assert.rejects(() => exec(ctxOf({ agent: { id: 'a' } })),
    (e) => e.code === 'no_model');
});

test('4 system_prompt_includes_instructions', async () => {
  const captured = [];
  const exec = agentOllamaExecutor({ chat: capture(captured) });
  await exec(ctxOf());
  const sys = captured[0].messages.find((m) => m.role === 'system').content;
  assert.match(sys, /You are careful\./);
  assert.match(sys, /do not leak secrets/);
});

test('5 system_prompt_includes_memory_when_provided', async () => {
  const captured = [];
  const exec = agentOllamaExecutor({ chat: capture(captured) });
  await exec(ctxOf());
  const sys = captured[0].messages.find((m) => m.role === 'system').content;
  assert.match(sys, /Recent memory/);
  assert.match(sys, /no force-push/);
});

test('6 system_prompt_omits_memory_when_disabled', async () => {
  const captured = [];
  const exec = agentOllamaExecutor({ chat: capture(captured), includeMemoryInSystem: false });
  await exec(ctxOf());
  const sys = captured[0].messages.find((m) => m.role === 'system').content;
  assert.ok(!/Recent memory/.test(sys));
});

test('7 system_prompt_includes_tools', async () => {
  const captured = [];
  const exec = agentOllamaExecutor({ chat: capture(captured) });
  await exec(ctxOf());
  const sys = captured[0].messages.find((m) => m.role === 'system').content;
  assert.match(sys, /skill:lint/);
  assert.match(sys, /run/);
});

test('8 user_prompt_includes_task_detail', async () => {
  const captured = [];
  const exec = agentOllamaExecutor({ chat: capture(captured) });
  await exec(ctxOf());
  const user = captured[0].messages.find((m) => m.role === 'user').content;
  assert.match(user, /Add two numbers/);
  assert.match(user, /Return a \+ b\./);
  assert.match(user, /"a":1/);
});

test('9 cancellation_before_dispatch_throws', async () => {
  const exec = agentOllamaExecutor({ chat: echo('x') });
  await assert.rejects(() => exec(ctxOf({ isCancelled: () => true })),
    (e) => e.code === 'cancelled');
});

test('10 chat_error_wrapped', async () => {
  const exec = agentOllamaExecutor({ chat: async () => { throw new Error('connection refused'); } });
  await assert.rejects(() => exec(ctxOf()),
    (e) => e.code === 'chat_failed' && /connection refused/.test(e.message));
});

test('11 cancellation_signal_from_chat', async () => {
  const exec = agentOllamaExecutor({ chat: async () => { throw new Error('request cancelled by host'); } });
  await assert.rejects(() => exec(ctxOf()), (e) => e.code === 'cancelled');
});

test('12 bad_response_shape_throws', async () => {
  const exec = agentOllamaExecutor({ chat: echo({ weird: true }) });
  await assert.rejects(() => exec(ctxOf()),
    (e) => e instanceof AgentOllamaExecutorError && e.code === 'bad_response');
});

test('13 token_estimate_when_usage_missing', async () => {
  const exec = agentOllamaExecutor({ chat: echo({ content: 'a'.repeat(400) }) });
  const r = await exec(ctxOf());
  assert.equal(r.usage.estimated, true);
  assert.ok(r.usage.tokens >= 100);
});

test('14 progress_events_emitted', async () => {
  const events = [];
  const exec = agentOllamaExecutor({ chat: echo({ content: 'ok' }) });
  await exec(ctxOf({ progress: (p) => events.push(p) }));
  assert.equal(events.length, 2);
  assert.equal(events[0].phase, 'requested');
  assert.equal(events[1].phase, 'completed');
});

test('15 constructor_and_compose_helpers', () => {
  assert.throws(() => agentOllamaExecutor({}),
    (e) => e instanceof AgentOllamaExecutorError && e.code === 'bad_chat');

  assert.equal(composeUser({}), '(no task detail provided)');

  const sys = composeSystem({ instructions: { system: 'be careful' } });
  assert.equal(sys, 'be careful');

  assert.equal(extractContent('str'), 'str');
  assert.equal(extractContent({ content: 'c' }), 'c');
  assert.equal(extractContent({ message: { content: 'm' } }), 'm');
  assert.equal(extractContent({ response: 'r' }), 'r');
  assert.throws(() => extractContent({}), (e) => e.code === 'bad_response');

  const u1 = extractUsage({ eval_count: 10, prompt_eval_count: 5 }, 'x');
  assert.equal(u1.tokens, 15);
  const u2 = extractUsage({}, 'abcd');
  assert.equal(u2.tokens, 1);
  assert.equal(u2.estimated, true);
});
