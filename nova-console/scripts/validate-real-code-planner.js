'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { OllamaClient } = require('../lib/ollama');
const qualifications = require('../lib/model-qualifications');
const planner = require('../lib/code-planner');
const scanner = require('../lib/workspace-scanner');
const changes = require('../lib/workspace-changes');
function memoryStore() {
  const state = new Map();
  return {
    all(n) { return [...(state.get(n)?.values() || [])]; },
    get(n, id) { return state.get(n)?.get(id) || null; },
    put(n, row) { if (!state.has(n)) state.set(n, new Map()); state.get(n).set(row.id, row); return row; },
  };
}
const fixtures = [
  { name: 'single-file', files: { 'sample.js': 'const greeting = "hello";\n' }, request: 'Change greeting in sample.js to "hello nova". Preserve all other contents.', expected: { 'sample.js': 'const greeting = "hello nova";\n' } },
  { name: 'multi-file', files: { 'config.json': '{"enabled":false}\n', 'main.js': 'const enabled = false;\n' }, request: 'Enable the feature: change false to true in config.json and main.js. main.js must depend on config.json in dependsOn. Preserve all other contents.', expected: { 'config.json': '{"enabled":true}\n', 'main.js': 'const enabled = true;\n' }, order: ['config.json', 'main.js'] },
  { name: 'ambiguous', files: { 'sample.js': 'const greeting = "hello";\n' }, request: 'Improve this.', clarification: true },
  { name: 'large-repository', files: Object.assign(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`noise-${i}.txt`, 'irrelevant text '.repeat(2300)])), { 'target.js': 'const limit = 2;\n' }), request: 'In target.js change limit from 2 to 3. Preserve all other contents.', expected: { 'target.js': 'const limit = 3;\n' } },
];
for (const interruption of ['timeout', 'cancellation']) fixtures.push({ ...fixtures[0], name: interruption, interruption });
async function runFixture(ollama, model, fixture, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-real-plan-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-real-plan-data-'));
  const db = memoryStore();
  for (const record of options.registryRecords || []) db.put('modelQualifications', record);
  for (const [name, content] of Object.entries(fixture.files)) fs.writeFileSync(path.join(dir, name), content);
  const root = scanner.approveRoot(db, { path: dir });
  db.put('models', { id: model, name: model, runtime: 'ollama' });
  let result;
  try {
    const run = () => planner.plan(db, scanner, changes, ollama, { rootId: root.id, modelId: model, request: fixture.request }, { ...options, qualificationBypass: options.qualificationBypass !== false });
    if (fixture.interruption) {
      const inventory = await ollama.status();
      const metadata = await ollama.show(model);
      const control = new AbortController();
      let started = false;
      let timer;
      const bounded = {
        status: async () => inventory,
        show: async () => metadata,
        chatFull: (...args) => {
          started = true;
          if (fixture.interruption === 'cancellation') timer = setTimeout(() => control.abort(), 20);
          return ollama.chatFull(...args);
        },
      };
      try {
        await assert.rejects(() => planner.plan(db, scanner, changes, bounded, { rootId: root.id, modelId: model, request: fixture.request }, {
          signal: control.signal, timeoutMs: fixture.interruption === 'timeout' ? 50 : 10000, qualificationBypass: true,
        }), fixture.interruption === 'timeout' ? /timed out/ : /cancelled/);
        assert.equal(started, true, 'live generation must start before interruption');
        assert.equal(db.all('workspaceChanges').length + db.all('workspaceChangeBatches').length, 0);
      } finally { clearTimeout(timer); }
    } else if (fixture.clarification) {
      await assert.rejects(run, /Clarification required/);
      assert.equal(db.all('workspaceChanges').length + db.all('workspaceChangeBatches').length, 0);
    } else {
      result = await run();
      const edits = result.changes || [{ relativePath: result.relativePath, ...result.edit }];
      assert.deepEqual(edits.map(e => e.relativePath).sort(), Object.keys(fixture.expected).sort(), 'exact affected-file set');
      for (const edit of edits) assert.equal(fixture.files[edit.relativePath].replace(edit.find, edit.replacement), fixture.expected[edit.relativePath], 'requested final content: ' + edit.relativePath);
      if (fixture.order) assert.deepEqual(result.orderedFiles, fixture.order);
      assert.equal(result.status, 'draft');
      assert.equal(result.approval, null);
      const checked = result.type === 'workspace-change-batch'
        ? changes.checkBatch(db, scanner, dataDir, result.id)
        : changes.checkProposal(db, scanner, dataDir, result.id);
      assert.notEqual(checked.semanticValidation.status, 'failed');
      assert.equal(checked.status, 'checks-passed');
    }
    return { status: 'passed', filesPresented: result?.planner.filesPresented, capabilityCheck: result?.planner.capabilityCheck };
  } finally {
    try {
      for (const [name, content] of Object.entries(fixture.files)) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), content, 'original source must remain unchanged');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dataDir, { recursive: true, force: true }); }
  }
}
async function main() {
  const ollama = new OllamaClient();
  const inventory = await ollama.status();
  if (!inventory.reachable) throw new Error('Ollama unavailable: ' + inventory.error);
  const results = [];
  const registryDirectory = process.argv.find(value => value.startsWith('--registry-dir='))?.slice('--registry-dir='.length);
  const { openDb, Store } = require('../lib/db');
  const persistent = registryDirectory ? openDb(registryDirectory) : null;
  const registry = persistent ? new Store(persistent.db) : memoryStore();
  const interruptionOnly = process.argv.includes('--interruptions');
  const behaviorOnly = process.argv.includes('--behavior');
  const outputPath = process.argv.slice(2).find(value => !value.startsWith('--'));
  for (const model of inventory.models) for (const fixture of fixtures.filter(f => interruptionOnly ? f.interruption : behaviorOnly ? !f.interruption : true)) for (let trial = 1; trial <= qualifications.MIN_TRIALS; trial++) {
    const startedAt = new Date().toISOString();
    let outcome;
    const generationEvidence=[];
    const inspected = {
      status: () => ollama.status(),
      show: (name, signal) => ollama.show(name, signal),
      chatFull: async (...args) => {
        const response = await ollama.chatFull(...args);
        generationEvidence.push({ content: response.message?.content, doneReason: response.done_reason, promptTokens: response.prompt_eval_count, outputTokens: response.eval_count });
        return response;
      },
    };
    try { outcome = await runFixture(inspected, model.name, fixture); }
    catch (error) { outcome = { status: 'failed', error: error.message }; }
    const refreshed = await ollama.status();
    if (!refreshed.reachable || refreshed.models.find(tag => tag.name === model.name)?.digest !== model.digest) outcome = { status:'failed', error:'Model digest changed or became unavailable during trial.' };
    results.push({ trial, model: model.name, digest: model.digest, fixture: fixture.name, startedAt, completedAt: new Date().toISOString(), generationEvidence, ...outcome });
    qualifications.recordResult(registry, { ...results.at(-1), runId: startedAt + ':' + model.digest + ':' + fixture.name + ':' + trial, evidencePath: outputPath });
    console.error('trial ' + trial + ' ' + model.name + ' / ' + fixture.name + ': ' + outcome.status + (outcome.error ? ' — ' + outcome.error : ''));
    if (outputPath) fs.writeFileSync(outputPath, JSON.stringify({ complete: false, results, qualifications: registry.all('modelQualifications') }, null, 2) + '\n');
  }
  const report = { complete: true, checkedAt: new Date().toISOString(), host: inventory.host, results, qualifications: registry.all('modelQualifications') };
  const text = JSON.stringify(report, null, 2) + '\n';
  if (outputPath) fs.writeFileSync(outputPath, text);
  process.stdout.write(text);
  persistent?.db.close();
  if (!results.length || results.some(r => r.status !== 'passed')) process.exitCode = 1;
}
module.exports = { memoryStore, fixtures, runFixture };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
