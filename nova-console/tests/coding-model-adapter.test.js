'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertCodingModelAdapter, guardCodingModelAdapter, isLoopbackHost, ollamaCodingModelAdapter } = require('../lib/coding-model-adapter');

test('coding adapter contract requires local-only generation capability', () => {
  assert.throws(() => assertCodingModelAdapter({ localOnly: true, resolveModel() {} }), /implement resolveModel.*generate/);
  assert.throws(() => assertCodingModelAdapter({ localOnly: true, generate() {} }), /implement resolveModel/);
  assert.throws(() => assertCodingModelAdapter({ resolveModel() {}, generate() {} }), /local-only/);
  assert.throws(() => assertCodingModelAdapter({ localOnly: true, resolveModel() {}, generate() {} }), error => error.code === 'unapproved_coding_model_adapter');
  assert.throws(() => guardCodingModelAdapter({ localOnly: true, resolveModel() {}, generate() {} }, { resolveModel() {}, generate() {} }), error => error.code === 'unapproved_coding_model_adapter');
  const adapter = ollamaCodingModelAdapter({ host: 'http://127.0.0.1:11434', status: async () => ({ reachable: true, models: [] }), chatFull: async () => ({}) });
  assert.equal(assertCodingModelAdapter(adapter), adapter);
});

test('loopback endpoint parser accepts only numeric loopback HTTP endpoints', () => {
  assert.equal(isLoopbackHost('http://127.0.0.1:11434'), true);
  assert.equal(isLoopbackHost('http://127.44.9.2:11434'), true);
  assert.equal(isLoopbackHost('http://localhost:11434'), false);
  assert.equal(isLoopbackHost('http://[::1]:11434'), true);
  assert.equal(isLoopbackHost('https://localhost:11434'), false);
  assert.equal(isLoopbackHost('http://ollama.internal:11434'), false);
  assert.equal(isLoopbackHost('not a url'), false);
});

test('Ollama adapter maps the stable request and normalizes response and usage', async () => {
  let call;
  const signal = new AbortController().signal;
  const adapter = ollamaCodingModelAdapter({
    host: 'http://127.0.0.1:11434',
    async status() { return { reachable: true, models: [{ name: 'guru-candidate:q4', digest: 'f'.repeat(64) }] }; },
    async chatFull(...args) { call = args; return { model: 'guru-candidate:q4', message: { content: '{"ok":true}' }, done_reason: 'stop', prompt_eval_count: 17, eval_count: 8 }; },
  });
  const result = await adapter.generate({ modelId: 'guru-candidate:q4', modelDigest: 'f'.repeat(64), messages: [{ role: 'user', content: 'hello' }], signal, responseFormat: 'json', temperature: 0, maxOutputTokens: 512, maxContextTokens: 4096 });
  assert.equal(adapter.localOnly, true);
  assert.equal(call[0], 'guru-candidate:q4');
  assert.deepEqual(call[1], [{ role: 'user', content: 'hello' }]);
  assert.equal(call[2].signal, signal);
  assert.deepEqual(call[2].options, { temperature: 0, num_predict: 512, num_ctx: 4096 });
  assert.deepEqual(result, { text: '{"ok":true}', finishReason: 'stop', usage: { inputTokens: 17, outputTokens: 8 } });
});

test('Ollama coding adapter rejects a mismatched model digest before generation', async () => {
  let generated = false;
  const adapter = ollamaCodingModelAdapter({
    host: 'http://127.0.0.1:11434',
    async status() { return { reachable: true, models: [{ name: 'guru-candidate:q4', digest: 'a'.repeat(64) }] }; },
    async chatFull() { generated = true; },
  });
  await assert.rejects(() => adapter.generate({ modelId: 'guru-candidate:q4', modelDigest: 'b'.repeat(64), messages: [] }), error => error.code === 'model_digest_changed');
  assert.equal(generated, false);
});

test('Ollama coding adapter fails closed for a configured remote endpoint', async () => {
  let generated = false;
  const adapter = ollamaCodingModelAdapter({ host: 'http://ollama.internal:11434', async status() { return { reachable: true, models: [] }; }, async chatFull() { generated = true; } });
  assert.equal(adapter.localOnly, false);
  assert.throws(() => assertCodingModelAdapter(adapter), /local-only/);
  await assert.rejects(() => adapter.generate({ modelId: 'm', messages: [] }), error => error.code === 'external_transmission_denied');
  assert.equal(generated, false);
});

test('Ollama coding adapter rejects a digest change observed during inference', async () => {
  let statusCalls = 0;
  const adapter = ollamaCodingModelAdapter({
    host: 'http://127.0.0.1:11434',
    async status() {
      statusCalls += 1;
      const digest = statusCalls === 1 ? 'a'.repeat(64) : 'b'.repeat(64);
      return { reachable: true, models: [{ name: 'guru-candidate:q4', digest }] };
    },
    async chatFull() { return { model: 'guru-candidate:q4', message: { content: 'private output' }, prompt_eval_count: 1, eval_count: 1 }; },
  });
  await assert.rejects(() => adapter.generate({ modelId: 'guru-candidate:q4', modelDigest: 'a'.repeat(64), messages: [] }), error => error.code === 'model_digest_changed' && /changed during coding inference/.test(error.message));
  assert.equal(statusCalls, 2);
});
