'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  ollamaProvider,
  multiOllamaProviders,
  fromOllamaClient,
  extractContent,
  OllamaProviderError,
} = require('../lib/ollama-provider');

const echoString = () => async () => 'plain-string';
const echoContent = () => async () => ({ content: 'content-shape' });
const echoMessageContent = () => async () => ({ message: { content: 'message-shape' } });
const echoResponse = () => async () => ({ response: 'response-shape' });

test('1 provider has id and generate', () => {
  const p = ollamaProvider({ id: 'x', model: 'm', chat: echoString() });
  assert.equal(p.id, 'x');
  assert.equal(typeof p.generate, 'function');
});

test('2 calls chat with model and messages', async () => {
  let captured = null;
  const chat = async (params) => { captured = params; return 'ok'; };
  const p = ollamaProvider({ id: 'x', model: 'llama3.1:8b', chat });
  const out = await p.generate('say hi', {});
  assert.equal(out, 'ok');
  assert.equal(captured.model, 'llama3.1:8b');
  assert.equal(captured.stream, false);
  assert.equal(captured.messages.length, 1);
  assert.equal(captured.messages[0].role, 'user');
  assert.equal(captured.messages[0].content, 'say hi');
});

test('3 includes system prompt when given', async () => {
  let captured = null;
  const chat = async (params) => { captured = params; return 'ok'; };
  const p = ollamaProvider({
    id: 'x', model: 'm', chat,
    systemPrompt: 'You are careful.',
  });
  await p.generate('problem', {});
  assert.equal(captured.messages.length, 2);
  assert.equal(captured.messages[0].role, 'system');
  assert.equal(captured.messages[0].content, 'You are careful.');
  assert.equal(captured.messages[1].role, 'user');
});

test('4 temperature default 0.8', async () => {
  let captured = null;
  const chat = async (params) => { captured = params; return 'ok'; };
  const p = ollamaProvider({ id: 'x', model: 'm', chat });
  await p.generate('q', {});
  assert.equal(captured.temperature, 0.8);
});

test('5 custom temperature and max_tokens pass through', async () => {
  let captured = null;
  const chat = async (params) => { captured = params; return 'ok'; };
  const p = ollamaProvider({
    id: 'x', model: 'm', chat,
    temperature: 0.2, maxTokens: 512,
  });
  await p.generate('q', {});
  assert.equal(captured.temperature, 0.2);
  assert.equal(captured.max_tokens, 512);
});

test('6 all four response shapes', async () => {
  const p1 = ollamaProvider({ id: '1', model: 'm', chat: echoString() });
  assert.equal(await p1.generate('q', {}), 'plain-string');

  const p2 = ollamaProvider({ id: '2', model: 'm', chat: echoContent() });
  assert.equal(await p2.generate('q', {}), 'content-shape');

  const p3 = ollamaProvider({ id: '3', model: 'm', chat: echoMessageContent() });
  assert.equal(await p3.generate('q', {}), 'message-shape');

  const p4 = ollamaProvider({ id: '4', model: 'm', chat: echoResponse() });
  assert.equal(await p4.generate('q', {}), 'response-shape');
});

test('7 unexpected shape throws bad_response', async () => {
  const p = ollamaProvider({
    id: 'x', model: 'm',
    chat: async () => ({ weird: 'shape' }),
  });
  await assert.rejects(() => p.generate('q', {}),
    (e) => e instanceof OllamaProviderError && e.code === 'bad_response');
});

test('8 chat failure wraps as chat_failed', async () => {
  const p = ollamaProvider({
    id: 'x', model: 'm',
    chat: async () => { throw new Error('connection refused'); },
  });
  await assert.rejects(() => p.generate('q', {}),
    (e) => e instanceof OllamaProviderError
      && e.code === 'chat_failed'
      && /connection refused/.test(e.message));
});

test('9 multiOllamaProviders builds multiple', async () => {
  const providers = multiOllamaProviders({
    chat: echoString(),
    models: [
      { id: 'ollama:a', model: 'llama3.1:8b' },
      { id: 'ollama:b', model: 'qwen2.5:7b', temperature: 0.5 },
    ],
    systemPrompt: 'shared',
  });
  assert.equal(providers.length, 2);
  assert.equal(providers[0].id, 'ollama:a');
  assert.equal(providers[1].id, 'ollama:b');
  const out = await providers[0].generate('q', {});
  assert.equal(out, 'plain-string');
});

test('10 constructor validation', () => {
  assert.throws(() => ollamaProvider({}),
    (e) => e instanceof OllamaProviderError && e.code === 'bad_id');
  assert.throws(() => ollamaProvider({ id: 'x' }),
    (e) => e instanceof OllamaProviderError && e.code === 'bad_model');
  assert.throws(() => ollamaProvider({ id: 'x', model: 'm' }),
    (e) => e instanceof OllamaProviderError && e.code === 'bad_chat');
  assert.throws(() => multiOllamaProviders({}),
    (e) => e instanceof OllamaProviderError && e.code === 'bad_chat');
  assert.throws(() => multiOllamaProviders({ chat: () => {} }),
    (e) => e instanceof OllamaProviderError && e.code === 'bad_models');
});

test('11 fromOllamaClient builds a chat adapter', async () => {
  const calls = [];
  const client = {
    async chatFull(model, messages, opts) {
      calls.push({ model, messages, opts });
      return { message: { content: 'from-client' } };
    },
  };
  const adapter = fromOllamaClient(client);
  const out = await adapter({
    model: 'llama3.1:8b',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.3,
    max_tokens: 128,
  });
  assert.equal(out.message.content, 'from-client');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'llama3.1:8b');
  assert.equal(calls[0].opts.temperature, 0.3);
  assert.equal(calls[0].opts.num_predict, 128);
});

test('12 fromOllamaClient prefers chatFull over chat', async () => {
  const used = [];
  const client = {
    async chatFull() { used.push('chatFull'); return 'a'; },
    async chat()     { used.push('chat');     return 'b'; },
  };
  const adapter = fromOllamaClient(client);
  await adapter({ model: 'm', messages: [] });
  assert.deepEqual(used, ['chatFull']);
});

test('13 fromOllamaClient falls back to chat', async () => {
  const used = [];
  const client = {
    async chat(model, messages, opts) {
      used.push('chat');
      return 'ok';
    },
  };
  const adapter = fromOllamaClient(client);
  const out = await adapter({ model: 'm', messages: [] });
  assert.equal(out, 'ok');
  assert.deepEqual(used, ['chat']);
});

test('14 fromOllamaClient validates client', () => {
  assert.throws(() => fromOllamaClient(null),
    (e) => e instanceof OllamaProviderError && e.code === 'bad_client');
  assert.throws(() => fromOllamaClient({}),
    (e) => e instanceof OllamaProviderError && e.code === 'bad_client_method');
});

