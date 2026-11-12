'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, Store } = require('../lib/db');
const activity = require('../lib/activity');
const chatTurn = require('../lib/chat-turn');

function stream(lines) { return { body: (async function* () { for (const l of lines) yield Buffer.from(JSON.stringify(l) + '\n'); })() }; }

async function turn(model, caps, think, ollamaExtra = {}) {
  activity._reset();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-think-'));
  const { db } = openDb(dataDir); const store = new Store(db);
  try {
    activity.configure(store);
    store.put('models', { id: model, name: model, runtime: 'ollama', capabilities: caps });
    const sent = [];
    const ollama = { show: async () => ({ capabilities: caps }), async chatStream(m, msgs, opts, signal, extra) { sent.push(extra); if (ollamaExtra.refuse && extra && extra.think !== undefined) throw new Error('Ollama chat failed: 400 {"error":"think value not supported"}'); return stream([{ message: { thinking: 'Let me think about the sky. '.repeat(4), content: '' } }, { message: { content: 'नीला।' } }, { done: true, eval_count: 3 }]); }, ...ollamaExtra.client };
    const events = [];
    await chatTurn.runTurn({ store, dataDir, ollama }, { sessionId: 's1', model, think, followups: false, memory: false, messages: [{ role: 'user', content: 'आसमान का रंग?' }] }, e => events.push(e));
    const steps = (events.filter(e => e.type === 'steps').pop() || { steps: [] }).steps;
    return { sent, events, steps };
  } finally { activity._reset(); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
}

test('a thinking model is asked not to think unless Think is on', async () => {
  assert.deepEqual((await turn('qwen3.5:9b-q4_K_M', ['completion', 'thinking'], false)).sent, [{ think: false }]);
  const on = await turn('qwen3.5:9b-q4_K_M', ['completion', 'thinking'], true);
  assert.deepEqual(on.sent, [{ think: true }]);
  assert.ok(on.steps.some(s => /reasoned about \d+ words/.test(s.detail || '')), JSON.stringify(on.steps));
  assert.match(on.events.filter(e => e.type === 'token').map(e => e.text).join(''), /नीला/);
});

test('gpt-oss gets a level; an ordinary model gets nothing and a note when Think is on', async () => {
  assert.deepEqual((await turn('gpt-oss:20b', ['completion', 'thinking'], false)).sent, [{ think: 'low' }]);
  assert.deepEqual((await turn('gpt-oss:20b', ['completion', 'thinking'], true)).sent, [{ think: 'medium' }]);
  const plain = await turn('llama3.2', ['completion'], true);
  assert.deepEqual(plain.sent, [undefined]);
  assert.ok(plain.steps.some(s => /does not think step by step/.test(s.label || '')), JSON.stringify(plain.steps));
});

test('an Ollama build that refuses the think option still answers', async () => {
  const r = await turn('qwen3.5:9b-q4_K_M', ['completion', 'thinking'], false, { refuse: true });
  assert.deepEqual(r.sent, [{ think: false }, undefined]);
  assert.match(r.events.filter(e => e.type === 'token').map(e => e.text).join(''), /नीला/);
});
