'use strict';
/* ===========================================================================
 * Coding qualification suite
 *
 * The planner refuses models that have not passed these checks: one-file and
 * several-file edits, a large folder, asking back on a vague request, and
 * stopping cleanly on timeout and cancel. Each check runs MIN_TRIALS times in
 * a temporary folder with an in-memory store, so nothing of yours is touched.
 * Used by "Qualify for coding" in the Models view and by
 * scripts/validate-real-code-planner.js.
 * ========================================================================= */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { OllamaClient } = require('./ollama');
const qualifications = require('./model-qualifications');
const planner = require('./code-planner');
const scanner = require('./workspace-scanner');
const changes = require('./workspace-changes');
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

/**
 * Runs the whole suite for one installed model and records each trial in the
 * real store. job (optional) is an activity handle: steps are shown live and
 * job.signal cancels between trials.
 */
async function qualifyModel(store, ollama, modelName, { job, trials = qualifications.MIN_TRIALS } = {}) {
  const inventory = await ollama.status();
  if (!inventory.reachable) throw Object.assign(new Error('Ollama is not running. Start Ollama and try again.'), { statusCode: 503 });
  const model = inventory.models.find(m => m.name === modelName || m.model === modelName);
  if (!model) throw Object.assign(new Error('Ollama has no model called ' + modelName + '.'), { statusCode: 404 });
  if (!model.digest) throw Object.assign(new Error('Ollama did not report a digest for ' + modelName + ', so results cannot be tied to it.'), { statusCode: 412 });
  let passed = 0, failed = 0;
  for (const fixture of fixtures) for (let trial = 1; trial <= trials; trial++) {
    if (job && job.signal.aborted) throw Object.assign(new Error('Cancelled'), { statusCode: 499 });
    const step = job ? job.step(`${fixture.name} · trial ${trial} of ${trials}`, modelName) : null;
    const startedAt = new Date().toISOString();
    let outcome;
    try { outcome = await runFixture(ollama, model.name, fixture); }
    catch (error) { outcome = { status: 'failed', error: error.message }; }
    qualifications.recordResult(store, { trial, model: model.name, digest: model.digest, fixture: fixture.name, startedAt, completedAt: new Date().toISOString(), runId: startedAt + ':' + model.digest + ':' + fixture.name + ':' + trial, ...outcome });
    if (outcome.status === 'passed') { passed++; if (step) step.done('Passed'); }
    else { failed++; if (step) step.fail(outcome.error || 'Failed'); }
  }
  return { model: model.name, passed, failed, summary: qualifications.summary(store, model.digest) };
}

module.exports = { memoryStore, fixtures, runFixture, qualifyModel };
