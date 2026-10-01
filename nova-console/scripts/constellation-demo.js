#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { openDb, Store } = require('../lib/db');
const { OllamaClient } = require('../lib/ollama');
const { ConstellationRouter } = require('../lib/constellation-router');
const { multiOllamaProviders, fromOllamaClient } = require('../lib/ollama-provider');
const { PolicyEngine } = require('../lib/policy');
const { KillSwitch } = require('../lib/killswitch');
const { BudgetEngine } = require('../lib/budgets');

const DEFAULT_PROBLEM =
  'Write a single JavaScript function add(a, b) that returns a + b. Reply with code only, no explanation.';

const MODELS = (process.env.NOVA_CONSTELLATION_MODELS ||
  'llama3.1:8b,llama3.1:8b').split(',').map((m, i) => ({
    id: `ollama:${m}:${i}`,
    model: m.trim(),
    temperature: i === 0 ? 0.3 : 0.9,
  }));

async function main() {
  const problem = process.argv.slice(2).join(' ').trim() || DEFAULT_PROBLEM;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-cn-demo-'));
  const { db } = openDb(dir);
  const store = new Store(db);

  const policy = new PolicyEngine(store);
  policy.grant({
    subject: { type: 'agent', id: 'constellation' },
    resource: { type: 'tool', id: 'constellation.generate' },
    effect: 'allow',
  });

  const budgets = new BudgetEngine(store);
  budgets.setBudget({
    subject: { type: 'agent', id: 'constellation' },
    limits: { jobs: 100 },
  });

  const killSwitch = new KillSwitch(store);

  const ollama = new OllamaClient(process.env.OLLAMA_HOST || 'http://127.0.0.1:11434');

  const providers = multiOllamaProviders({
    chat: fromOllamaClient(ollama),
    models: MODELS,
  });

  const router = new ConstellationRouter(store, {
    providers,
    policy,
    budgets,
    killSwitch,
    agentId: 'constellation',
    timeoutMs: 90000,
  });

  console.log('problem:   ' + problem);
  console.log('providers: ' + providers.map((p) => p.id).join(', '));
  console.log('running...');
  const t0 = Date.now();

  const gen = await router.generate(problem);
  const elapsedGen = Date.now() - t0;

  console.log('generate:  ok=' + gen.ok + '  status=' + gen.status +
              '  candidates=' + gen.candidates.length + '  (' + elapsedGen + 'ms)');

  if (!gen.ok || gen.candidates.length === 0) {
    console.log('no candidates — check Ollama is running and models exist');
    console.log('');
    console.log('candidate errors:');
    for (const row of store.constellationCandidatesList(gen.runId)) {
      console.log('  ' + row.provider_id + ': ' + (row.error || '(no error)'));
    }
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }

  // Demo judge: prefer the shorter answer (a weak heuristic, but honest).
  const judge = async (a, b) => {
    const la = (a.code || '').trim().length;
    const lb = (b.code || '').trim().length;
    if (la < lb) return 'a';
    if (lb < la) return 'b';
    return 'tie';
  };

  const sel = await router.select(gen.runId, gen.candidates, judge);

  console.log('winner:    ' + sel.winner.provider + '  rounds=' + sel.rounds);
  console.log('');

  console.log('--- winner code ---');
  console.log(sel.winner.code.trim());
  console.log('--- end ---');
  console.log('');

  console.log('--- sqlite audit ---');
  console.log('runs:       ' + store.constellationRunsList({}).length);
  console.log('candidates: ' + store.constellationCandidatesList(gen.runId).length);
  console.log('rounds:     ' + store.constellationRoundsList(gen.runId).length);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

if (require.main === module) {
  main().catch((e) => {
    console.error('demo failed:', e);
    process.exit(1);
  });
}

module.exports = { main };
