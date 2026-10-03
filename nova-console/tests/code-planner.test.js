'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const productionPlanner = require('../lib/code-planner');
const planner = { ...productionPlanner, plan: (...args) => productionPlanner.plan(...args.slice(0, 5), { ...args[5], qualificationBypass: true }) };
const scanner = require('../lib/workspace-scanner');
const changes = require('../lib/workspace-changes');
const qualifications = require('../lib/model-qualifications');

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
  await assert.rejects(() => planner.plan(db, scanner, changes, ollama, { rootId: root.id, modelId: 'demo', request: 'Change x in a.js to y' }), /Demo models cannot/);
  assert.throws(() => planner.validate({ changes: [{ relativePath: '../x', find: 'a', replacement: 'b' }] }), /unsafe path/);
  assert.throws(() => planner.extractJson('not json'), /did not return/);
});

test('explicit planner model is the model used and an unqualified choice never falls back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-plan-explicit-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), 'const value = 1;\n');
    const db = store();
    const root = scanner.approveRoot(db, { path: dir });
    const chosenDigest = 'd'.repeat(64);
    const fallbackDigest = 'e'.repeat(64);
    db.put('models', { id: 'chosen:latest', name: 'chosen:latest', runtime: 'ollama' });
    db.put('models', { id: 'fallback:latest', name: 'fallback:latest', runtime: 'ollama' });
    for (const capability of qualifications.CAPABILITIES) {
      for (let trial = 1; trial <= 3; trial++) {
        qualifications.recordResult(db, { digest: fallbackDigest, capability, trial, runId: `${capability}-fallback-${trial}`, status: 'passed' });
      }
    }
    let calls = [];
    const ollama = {
      status: async () => ({ reachable: true, models: [
        { name: 'chosen:latest', digest: chosenDigest, details: { parameter_size: '8B' } },
        { name: 'fallback:latest', digest: fallbackDigest, details: { parameter_size: '8B' } },
      ] }),
      show: async model => { calls.push(['show', model]); return metadata(); },
      chatFull: async model => { calls.push(['chat', model]); return { message: { content: '{"summary":"Update value","acceptanceCriteria":[{"description":"a.js contains value 2"}],"changes":[{"relativePath":"a.js","find":"value = 1","replacement":"value = 2"}]}' } }; },
    };

    const preview = await productionPlanner.preview(db, scanner, ollama, { rootId: root.id, modelId: 'chosen:latest', request: 'Change value in a.js to 2' });
    assert.equal(preview.ready, false);
    assert.match(preview.blocker, /chosen:latest.*not qualified.*single-file/i);
    assert.equal(calls.length, 0, 'preview does not inspect an unqualified chosen model');

    for (const capability of qualifications.CAPABILITIES) {
      for (let trial = 1; trial <= 3; trial++) {
        qualifications.recordResult(db, { digest: chosenDigest, capability, trial, runId: `${capability}-chosen-${trial}`, status: 'passed' });
      }
    }
    const result = await productionPlanner.plan(db, scanner, changes, ollama, { rootId: root.id, modelId: 'chosen:latest', request: 'Change value in a.js to 2' });
    assert.equal(result.planner.modelId, 'chosen:latest');
    assert.deepEqual(calls, [['show', 'chosen:latest'], ['chat', 'chosen:latest']]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repository context budget preserves output room and caps large-context models', () => {
  assert.equal(planner.repositoryCharacterBudget(8192, 100), 14332);
  assert.equal(planner.repositoryCharacterBudget(131072, 100), 120000);
});
