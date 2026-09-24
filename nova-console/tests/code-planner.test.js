'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const planner = require('../lib/code-planner');
const scanner = require('../lib/workspace-scanner');
const changes = require('../lib/workspace-changes');

function store() {
  const state = new Map();
  return {
    all(name) { return [...(state.get(name)?.values() || [])]; },
    get(name, id) { return state.get(name)?.get(id) || null; },
    put(name, row) { if (!state.has(name)) state.set(name, new Map()); state.get(name).set(row.id, row); return row; },
  };
}

function metadata({ capabilities = ['completion'], contextLength = 8192, template = '{{ .Messages }}' } = {}) {
  return { capabilities, template, details: { family: 'llama', parameter_size: '8B' }, model_info: { 'llama.context_length': contextLength } };
}

test('real-model planner capability-checks Ollama and creates a draft without writing files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-plan-'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'const value = 1;\n');
  const db = store();
  const root = scanner.approveRoot(db, { path: dir });
  db.put('models', { id: 'qwen:test', name: 'qwen:test', runtime: 'ollama' });
  let options;
  const ollama = {
    status: async () => ({ reachable: true, models: [{ name: 'qwen:test' }] }),
    show: async () => metadata(),
    chatFull: async (_model, _messages, inputOptions) => { options = inputOptions; return { message: { content: '{"summary":"Update value","acceptanceCriteria":[{"description":"a.js contains value 2"}],"changes":[{"relativePath":"a.js","find":"value = 1","replacement":"value = 2"}]}' } }; },
  };
  const result = await planner.plan(db, scanner, changes, ollama, { rootId: root.id, modelId: 'qwen:test', request: 'Change value in a.js to 2' });
  assert.equal(result.status, 'draft');
  assert.equal(result.planner.kind, 'ollama');
  assert.equal(result.planner.demoMode, false);
  assert.equal(result.planner.capabilityCheck.compatible, true);
  assert.equal(result.planner.capabilityCheck.contextLength, 8192);
  assert.equal(options.format, 'json');
  assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), 'const value = 1;\n');
});

test('capability report rejects models without completion, chat templates, or adequate context', () => {
  assert.deepEqual(planner.capabilityReport('ok', metadata()).reasons, []);
  assert.match(planner.capabilityReport('embed', metadata({ capabilities: ['embedding'] })).reasons.join(' '), /completion/);
  assert.match(planner.capabilityReport('raw', metadata({ template: '' })).reasons.join(' '), /chat template/);
  assert.match(planner.capabilityReport('tiny', metadata({ contextLength: 2048 })).reasons.join(' '), /4096/);
});

test('planner rejects an installed but incapable model before inference', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-plan-'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'x\n');
  const db = store();
  const root = scanner.approveRoot(db, { path: dir });
  db.put('models', { id: 'embed:test', name: 'embed:test', runtime: 'ollama' });
  const ollama = { status: async () => ({ reachable: true, models: [{ name: 'embed:test' }] }), show: async () => metadata({ capabilities: ['embedding'] }) };
  await assert.rejects(() => planner.plan(db, scanner, changes, ollama, { rootId: root.id, modelId: 'embed:test', request: 'Change x in a.js to y' }), /cannot create production code plans.*completion/);
});

test('planner rejects demo models, unavailable models, unsafe paths, and malformed output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-plan-'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'x\n');
  const db = store();
  const root = scanner.approveRoot(db, { path: dir });
  const ollama = { status: async () => ({ reachable: true, models: [] }) };
  db.put('models', { id: 'demo', runtime: 'llama.cpp' });
  await assert.rejects(() => planner.plan(db, scanner, changes, ollama, { rootId: root.id, modelId: 'demo' }), /Demo models cannot/);
  assert.throws(() => planner.validate({ changes: [{ relativePath: '../x', find: 'a', replacement: 'b' }] }), /unsafe path/);
  assert.throws(() => planner.extractJson('not json'), /did not return/);
});

test('repository context budget preserves output room and caps large-context models', () => {
  assert.equal(planner.repositoryCharacterBudget(8192, 100), 14332);
  assert.equal(planner.repositoryCharacterBudget(131072, 100), 120000);
});
