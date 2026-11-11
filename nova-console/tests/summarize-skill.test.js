'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const summarize = require('../skills/summarize');
const { runSkillSandboxed } = require('../lib/skill-runner');
const { buildSkillHost, resolveLocalModel } = require('../lib/skill-host');

function store() {
  const state = new Map();
  return {
    all(name) { return [...(state.get(name)?.values() || [])]; },
    get(name, id) { return state.get(name)?.get(id) || null; },
    put(name, row) { if (!state.has(name)) state.set(name, new Map()); state.get(name).set(row.id, row); return row; },
  };
}

function skillRow(overrides = {}) {
  return {
    id: 'skl_summarize', name: 'Session Summarizer', enabled: true,
    permissions: [{ scope: 'session:read', granted: true }],
    manifest: { entrypoint: 'summarize.run(context)', inputs: ['sessionId', 'text', 'maxWords'], outputs: ['summary', 'citations'], requiredTools: [] },
    ...overrides,
  };
}

function fakeHost(replies, session) {
  const prompts = [];
  return {
    prompts,
    readSession: async () => session,
    generate: async ({ prompt }) => { prompts.push(prompt); return { text: replies.shift(), model: 'llama3:latest' }; },
  };
}

test('summarizes a session with citations that point back at the messages', async () => {
  const session = { id: 's1', title: 'Planning', messages: [
    { id: 'm1', role: 'user', content: 'We will ship the desktop build on Friday.' },
    { id: 'm2', role: 'assistant', content: 'Notarization is still blocked on the Developer ID.' },
  ] };
  const host = fakeHost(['The desktop build ships Friday [S1]. Notarization waits on the Developer ID [S2].'], session);
  const result = await summarize.run({ sessionId: 's1', maxWords: 50 }, {}, host);
  assert.equal(result.strategy, 'single');
  assert.equal(result.calls, 1);
  assert.deepEqual(result.citations.map(c => [c.id, c.messageId, c.role]), [['S1', 'm1', 'user'], ['S2', 'm2', 'assistant']]);
  assert.equal(result.uncitedSentences, 0);
  assert.equal(result.source.kind, 'session');
  assert.match(host.prompts[0], /\[S1\] \(user message 1\)/);
});

test('drops invented ids, normalizes grouped citations, and strips a preamble', () => {
  const { text, dropped } = summarize._internal.cleanCitations('Here is a summary: A fact [S1, S2]. Another [S9].', new Set(['S1', 'S2']));
  assert.equal(text, 'A fact [S1][S2]. Another.');
  assert.equal(dropped, 1);
});

test('keeps whole sentences within the word limit', () => {
  const long = Array.from({ length: 10 }, (_, i) => 'Sentence number ' + i + ' has several words in it [S1].').join(' ');
  const { text, truncated } = summarize._internal.enforceLength(long, 20);
  assert.equal(truncated, true);
  assert.ok(summarize._internal.wordCount(text) <= 20);
  assert.match(text, /\[S1\]\.$/);
});

test('long text is summarized in batches and then combined', async () => {
  const paragraph = 'This paragraph describes one part of the release plan in plenty of detail. '.repeat(12);
  const text = Array.from({ length: 30 }, () => paragraph).join('\n\n');
  const replies = [];
  for (let i = 0; i < 10; i++) replies.push('Part summary [S1].');
  const host = fakeHost(replies, null);
  host.generate = async ({ prompt }) => { host.prompts.push(prompt); return { text: host.prompts.length === 1 ? 'First part [S1].' : 'Combined summary [S1][S2].', model: 'llama3:latest' }; };
  const result = await summarize.run({ text, maxWords: 60 }, {}, host);
  assert.equal(result.strategy, 'map-reduce');
  assert.ok(result.calls >= 3);
  assert.match(host.prompts[host.prompts.length - 1], /Combine the partial summaries/);
  assert.equal(result.summary, 'Combined summary [S1][S2].');
});

test('rejects empty input, oversized input, and an empty model reply', async () => {
  await assert.rejects(() => summarize.run({}, {}, fakeHost([], null)), /requires one of/);
  await assert.rejects(() => summarize.run({ text: 'x'.repeat(210000) }, {}, fakeHost([], null)), /too large/);
  await assert.rejects(() => summarize.run({ text: 'Some text.' }, {}, fakeHost(['   '], null)), /empty summary/);
  await assert.rejects(() => summarize.run({ text: 'Some text.' }, {}, {}), /generate host method/);
});

test('host enforces session:read and refuses non-local models', async () => {
  const db = store();
  db.put('sessions', { id: 's1', messages: [{ id: 'm1', role: 'user', content: 'Hello there.' }] });
  db.put('models', { id: 'm_remote', runtime: 'API' });
  db.put('models', { id: 'llama3:latest', runtime: 'ollama' });
  const denied = buildSkillHost(db, null, skillRow({ permissions: [{ scope: 'session:read', granted: false }] }));
  await assert.rejects(() => denied.readSession({ sessionId: 's1' }), /session:read/);
  assert.throws(() => resolveLocalModel(db, ['m_remote']), /not a local Ollama model/);
  assert.equal(resolveLocalModel(db, [null]), 'llama3:latest');
  assert.deepEqual(Object.keys(buildSkillHost(db, null, { id: 'skl_codelint', manifest: {} })), []);
});

test('runs end to end in the sandboxed worker through host calls', async () => {
  const db = store();
  db.put('models', { id: 'llama3:latest', runtime: 'ollama' });
  db.put('sessions', { id: 's1', title: 'Chat', modelId: 'llama3:latest', messages: [
    { id: 'm1', role: 'user', content: 'The API binds to loopback only.' },
    { id: 'm2', role: 'system', content: 'hidden system prompt' },
  ] });
  const calls = [];
  const ollama = { chatFull: async (model, messages, opts) => { calls.push({ model, messages, opts }); return { message: { content: 'The API only binds to loopback [S1].' }, done_reason: 'stop' }; } };
  const skill = skillRow();
  const result = await runSkillSandboxed(skill, { sessionId: 's1', maxWords: 40 }, async () => { throw new Error('no tools'); }, buildSkillHost(db, ollama, skill));
  assert.equal(result.summary, 'The API only binds to loopback [S1].');
  assert.equal(result.model, 'llama3:latest');
  assert.equal(result.source.segments, 1, 'system messages are not summarized');
  assert.equal(calls[0].opts.options.temperature, 0.2);
  assert.doesNotMatch(calls[0].messages[1].content, /hidden system prompt/);
});

test('a workflow skill node summarizes the previous node output for real', async () => {
  const engine = require('../lib/workflow-engine');
  const db = store();
  db.put('models', { id: 'llama3:latest', runtime: 'ollama' });
  db.put('skills', skillRow());
  db.put('workflows', { id: 'wf_t', name: 'Digest', nodes: [{ id: 'n1', type: 'skill', ref: 'skl_summarize', label: 'Write digest', next: [] }] });
  const ollama = { chatFull: async (model, messages) => ({ message: { content: 'Release notes are ready [S1].' }, done_reason: 'stop' }) };
  const run = engine.startRun(db, 'wf_t');
  run.lastOutput = 'The release notes were drafted and reviewed by the team.';
  db.put('workflowRuns', run);
  const done = await engine.advanceRun(db, ollama, run.id);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.lastOutput, 'Release notes are ready [S1].');
});

test('a summary with no valid citations is asked for once more, with the allowed ids', async () => {
  const host = fakeHost(['Asha guards the beach.', 'Asha guards the beach [S1].']);
  const result = await summarize.run({ text: 'Asha is a lifeguard on Marine Drive.' }, null, host);
  assert.equal(host.prompts.length, 2);
  assert.match(host.prompts[1], /no valid source ids[\s\S]*Use only these ids: S1/);
  assert.equal(result.citationRepair, true);
  assert.equal(result.citations.length, 1);
  assert.match(result.summary, /\[S1\]/);
});

test('citations stay empty, not invented, when the repair also has none', async () => {
  const host = fakeHost(['Asha guards the beach.', 'Asha still guards the beach.']);
  const result = await summarize.run({ text: 'Asha is a lifeguard on Marine Drive.' }, null, host);
  assert.equal(result.citations.length, 0);
  assert.equal(result.summary, 'Asha guards the beach.');
});

test('a reasoning model that only thought is asked again with light reasoning and a larger budget', async () => {
  const db = store(); db.put('models', { id: 'gpt-oss:20b', runtime: 'ollama' });
  const calls = [];
  const ollama = { chatFull: async (model, messages, opts) => { calls.push(opts); return calls.length === 1 ? { message: { content: '', thinking: 'Let me plan the summary...' }, done_reason: 'length' } : { message: { content: 'Asha guards the beach [S1].' } }; } };
  const host = buildSkillHost(db, ollama, skillRow());
  const result = await summarize.run({ text: 'Asha is a lifeguard on Marine Drive.', maxWords: 80 }, null, host);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].think, undefined, 'ordinary models are never sent a think option');
  assert.equal(calls[1].think, 'low');
  assert.ok(calls[1].options.num_predict >= calls[0].options.num_predict + 1024);
  assert.match(result.summary, /Asha guards the beach \[S1\]/);

  const plain = []; const quiet = { chatFull: async (m, msgs, opts) => { plain.push(opts); return { message: { content: '' } }; } };
  await assert.rejects(() => summarize.run({ text: 'x y z.' }, null, buildSkillHost(db, quiet, skillRow())), /empty summary/);
  assert.equal(plain.length, 1, 'an empty reply without thinking is not retried here');
});

test('a reasoning model that ignores the level is asked with thinking off', async () => {
  const db = store(); db.put('models', { id: 'gemma4:12b', runtime: 'ollama' });
  const calls = [];
  const ollama = { chatFull: async (model, messages, opts) => { calls.push(opts.think); if (opts.think === 'low') throw new Error('invalid think value'); return opts.think === false ? { message: { content: 'Asha guards the beach [S1].' } } : { message: { content: '', thinking: 'hmm' } }; } };
  const result = await summarize.run({ text: 'Asha is a lifeguard on Marine Drive.' }, null, buildSkillHost(db, ollama, skillRow()));
  assert.deepEqual(calls, [undefined, 'low', false]);
  assert.match(result.summary, /\[S1\]/);
});
