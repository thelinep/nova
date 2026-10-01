'use strict';
/* Runs the coding qualification suite against every model in Ollama.
 *   npm run test:ollama-planner [report.json] [--registry-dir=<data folder>] [--interruptions|--behavior]
 * The checks themselves live in lib/qualification-suite.js. */
const fs = require('node:fs');
const { OllamaClient } = require('../lib/ollama');
const qualifications = require('../lib/model-qualifications');
const { memoryStore, fixtures, runFixture } = require('../lib/qualification-suite');
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
