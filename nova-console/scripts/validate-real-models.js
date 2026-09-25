'use strict';
/* ===========================================================================
 * NOVA Runtime — real-model checks for the development loop and text skills
 *
 * Everything else in the test suite uses scripted model replies. This runs
 * the same code against your local Ollama so you can see whether a model
 * actually does the job:
 *
 *   npm run test:real-models                 # uses llama3:latest, or the first model
 *   npm run test:real-models -- qwen2.5-coder:14b --out report.json
 *   npm run test:real-models -- --only loop  # loop | summarize | translate | slides | shotlist
 *
 * Nothing touches your projects or data: each check works in a temporary
 * folder and an in-memory store. Exit code 1 if any check fails.
 * ========================================================================= */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { OllamaClient } = require('../lib/ollama');
const scanner = require('../lib/workspace-scanner');
const changes = require('../lib/workspace-changes');
const runner = require('../lib/workspace-runner');
const planner = require('../lib/code-planner');
const devLoop = require('../lib/dev-loop');
const { runSkillSandboxed } = require('../lib/skill-runner');
const { buildSkillHost } = require('../lib/skill-host');
const firstParty = require('../lib/first-party-skills');

function memoryStore() { const s = new Map(); return { all(n) { return [...(s.get(n)?.values() || [])].map(r => JSON.parse(JSON.stringify(r))); }, get(n, id) { const r = s.get(n)?.get(id); return r ? JSON.parse(JSON.stringify(r)) : null; }, put(n, r) { if (!s.has(n)) s.set(n, new Map()); s.get(n).set(r.id, JSON.parse(JSON.stringify(r))); return r; }, delete(n, id) { s.get(n)?.delete(id); } }; }
const ok = (cond, message) => { if (!cond) throw new Error(message); };

const LOOP_FIXTURES = [
  { name: 'loop: fix a failing function', request: 'Fix src/math.js so that add returns the sum of both numbers and the tests in test/math.test.js pass.',
    files: { 'package.json': JSON.stringify({ name: 'real-loop', private: true, scripts: { test: 'node --test' } }), 'src/math.js': 'exports.add = (a, b) => a - b;\n', 'test/math.test.js': "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst { add } = require('../src/math');\ntest('adds', () => assert.equal(add(2, 3), 5));\n" } },
  { name: 'loop: add a missing function', request: 'Add an exported function slugify(title) to src/slug.js that lowercases the title and replaces spaces with dashes, so test/slug.test.js passes.',
    files: { 'package.json': JSON.stringify({ name: 'real-loop-2', private: true, scripts: { test: 'node --test' } }), 'src/slug.js': "exports.version = 1;\n", 'test/slug.test.js': "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst { slugify } = require('../src/slug');\ntest('slugify', () => assert.equal(slugify('Marine Drive Night'), 'marine-drive-night'));\n" } },
];

async function checkLoop(ollama, model, fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-real-loop-')), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-real-loop-data-'));
  try {
    for (const [rel, content] of Object.entries(fixture.files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), content); }
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const store = memoryStore(), root = scanner.approveRoot(store, { path: dir });
    runner.allowRepository(store, scanner, root.id, ['test']);
    store.put('models', { id: model, name: model, runtime: 'ollama' });
    // Qualification records live in NOVA's real database; this check is the qualification, so bypass it.
    const realPlanner = { ...planner, plan: (s, sc, ch, ol, input, opts) => planner.plan(s, sc, ch, ol, input, { ...opts, qualificationBypass: true }) };
    const { loop, done } = devLoop.startLoop(store, { scanner, changes, runner, planner: realPlanner, ollama, dataDir }, { rootId: root.id, modelId: model, request: fixture.request, maxAttempts: 3 });
    await done;
    const result = store.get('workspaceLoops', loop.id);
    const detail = `${result.attempts.length} attempt(s): ${result.attempts.map(a => a.status + (a.applyError ? ' (' + a.applyError.slice(0, 80) + ')' : '')).join(', ')}`;
    ok(result.status === 'ready', `loop ${result.status}: ${result.error || detail}`);
    for (const [rel, content] of Object.entries(fixture.files)) ok(fs.readFileSync(path.join(dir, rel), 'utf8') === content, 'the project must be unchanged until you approve');
    return detail + '; batch ' + result.batchId;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dataDir, { recursive: true, force: true }); }
}

const BRIEF = `Monsoon is a feature about Asha, a Mumbai lifeguard, during the first storm of the season.
Scene 1: EXT. MARINE DRIVE - DUSK. Asha watches the sea as the city lights come on. Her brother Ravi calls; he is stuck in Bandra.
Scene 2: INT. LIFEGUARD HUT - NIGHT. Rain hammers the tin roof. Asha checks the rescue ropes. The radio warns of a high tide at 11:40 pm.
We shoot Day 3 at Juhu beach, general call 06:30, sunset around 18:45. Budget and insurance are still open.`;

function skillRow(id) {
  if (id === 'skl_summarize') return { id, name: 'Session Summarizer', enabled: true, permissions: [{ scope: 'session:read', granted: true }], manifest: { entrypoint: 'summarize.run(context)', inputs: ['sessionId', 'text', 'maxWords'], outputs: ['summary', 'citations'], requiredTools: [], requiredHost: ['readSession', 'generate'] } };
  const def = [...firstParty.SKILLS, ...firstParty.UPGRADES].find(s => s.id === id);
  return firstParty.record(def);
}

async function runSkill(ollama, model, id, inputs) {
  const store = memoryStore(); store.put('models', { id: model, name: model, runtime: 'ollama' });
  const skill = skillRow(id);
  return runSkillSandboxed(skill, { ...inputs, modelId: model }, null, buildSkillHost(store, ollama, skill, { modelId: model }));
}

const SKILL_CHECKS = [
  { name: 'summarize', run: async (o, m) => { const r = await runSkill(o, m, 'skl_summarize', { text: BRIEF, maxWords: 80 }); ok(r.summary && r.summary.length > 40, 'summary is empty'); ok(/Asha/.test(r.summary), 'summary does not mention Asha'); return `${r.summary.split(/\s+/).length} words, ${(r.citations || []).length} citation(s)`; } },
  { name: 'translate', run: async (o, m) => { const r = await runSkill(o, m, 'skl_translate', { text: 'EXT. MARINE DRIVE - DUSK\n\nAsha watches the sea as the city lights come on.', targetLang: 'Hindi' }); ok(/[ऀ-ॿ]/.test(r.text), 'no Devanagari in the Hindi translation'); ok(/Asha|आशा/.test(r.text), 'the name Asha was lost'); return r.text.split('\n').pop().slice(0, 80); } },
  { name: 'slides', run: async (o, m) => { const r = await runSkill(o, m, 'skl_pptx', { text: BRIEF, slideCount: 5, audience: 'investors' }); const n = (r.markdown.match(/\n## /g) || []).length; ok(n >= 3, `only ${n} slides`); return `${n} slides`; } },
  { name: 'shotlist', run: async (o, m) => { const r = await runSkill(o, m, 'skl_shotlist', { text: BRIEF }); const shots = r.data.scenes.reduce((n, s) => n + s.shots.length, 0); ok(r.data.scenes.length >= 2, 'expected both scenes'); return `${r.data.scenes.length} scenes, ${shots} shots${r.repaired ? ' (after one repair)' : ''}`; } },
];

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out'), out = outIdx >= 0 ? args[outIdx + 1] : null;
  const onlyIdx = args.indexOf('--only'), only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
  const ollama = new OllamaClient();
  const status = await ollama.status();
  if (!status.reachable) throw new Error('Ollama is not running: ' + status.error);
  const named = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out' && args[i - 1] !== '--only');
  const model = named || (status.models.find(m => m.name === 'llama3:latest') || status.models[0] || {}).name;
  if (!model || !status.models.some(m => m.name === model)) throw new Error(`Model "${model}" is not in Ollama. Pull it first: ollama pull ${model}`);
  console.error(`Checking ${model}${only ? ' (' + only + ' only)' : ''}. Each check can take a few minutes.\n`);
  const checks = [...LOOP_FIXTURES.map(f => ({ name: f.name, group: 'loop', run: (o, m) => checkLoop(o, m, f) })), ...SKILL_CHECKS.map(c => ({ ...c, group: c.name }))].filter(c => !only || c.group === only);
  const results = [];
  for (const check of checks) {
    const started = Date.now();
    let outcome;
    try { outcome = { status: 'passed', detail: await check.run(ollama, model) }; }
    catch (e) { outcome = { status: 'failed', detail: e.message }; }
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    results.push({ check: check.name, seconds, ...outcome });
    console.error(`${outcome.status === 'passed' ? 'PASS' : 'FAIL'}  ${check.name}  (${seconds}s)  ${outcome.detail}`);
  }
  const report = { model, checkedAt: new Date().toISOString(), passed: results.filter(r => r.status === 'passed').length, total: results.length, results };
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.error(`\n${report.passed}/${report.total} passed for ${model}.`);
  if (report.passed !== report.total) process.exitCode = 1;
}

if (require.main === module) main().catch(e => { console.error(e.message || e); process.exitCode = 1; });
module.exports = { LOOP_FIXTURES, SKILL_CHECKS };
