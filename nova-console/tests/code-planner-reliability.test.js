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
const { memoryStore, fixtures, runFixture } = require('../scripts/validate-real-code-planner');
const metadata = { capabilities: ['completion'], template: 'chat', model_info: { 'llama.context_length': 8192 } };
function client(chatFull) { return { status: async () => ({ reachable: true, models: [{ name: 'test' }] }), show: async () => metadata, chatFull }; }
function response(changes, acceptanceCriteria = [{ description: 'Requested file has the intended exact replacement.' }]) { return { message: { content: JSON.stringify({ acceptanceCriteria, changes }) } }; }
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-reliability-'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'const x = 1;\n');
  const db = memoryStore();
  const root = scanner.approveRoot(db, { path: dir });
  db.put('models', { id: 'test', runtime: 'ollama' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { db, input: { rootId: root.id, modelId: 'test', request: 'Change x in a.js to 2' }, dir };
}
for (const [name, output, expected] of [
  ['malformed JSON', { message: { content: '{bad' } }, /JSON/],
  ['wrong schema', response('invalid'), /remained invalid/],
  ['empty changes', response([]), /remained invalid/],
  ['truncated output', { ...response([{ relativePath: 'a.js', find: '1', replacement: '2' }]), done_reason: 'length' }, /cut off at 2048 tokens/],
  ['missing match', response([{ relativePath: 'a.js', find: 'missing', replacement: '2' }]), /exactly once/],
  ['no effect', response([{ relativePath: 'a.js', find: '1', replacement: '1' }]), /no effect/],
  ['unpresented file', response([{ relativePath: 'hidden.js', find: '1', replacement: '2' }]), /outside the presented/],
]) test('rejects ' + name + ' without persisting a draft', async t => {
  const { db, input, dir } = setup(t);
  await assert.rejects(() => planner.plan(db, scanner, changes, client(async () => output), input), expected);
  assert.equal(db.all('workspaceChanges').length + db.all('workspaceChangeBatches').length, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), 'const x = 1;\n');
});
for (const kind of ['timeout', 'cancellation']) test(kind + ' aborts inference and rejects late results', async t => {
  const { db, input } = setup(t);
  const control = new AbortController();
  let finish;
  let observedSignal;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const ollama = client(async (_model, _messages, options) => {
    observedSignal = options.signal;
    started();
    return new Promise(resolve => { finish = resolve; });
  });
  const pending = planner.plan(db, scanner, changes, ollama, input, { timeoutMs: kind === 'timeout' ? 30 : 1000, signal: control.signal });
  const rejected = assert.rejects(pending, kind === 'timeout' ? /timed out/ : /cancelled/);
  await ready;
  if (kind === 'cancellation') control.abort();
  await rejected;
  assert.equal(observedSignal.aborted, true);
  finish(response([{ relativePath: 'a.js', find: '1', replacement: '2' }]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(db.all('workspaceChanges').length, 0);
});
test('already cancelled request never calls Ollama', async t => {
  const { db, input } = setup(t);
  const control = new AbortController(); control.abort();
  await assert.rejects(() => planner.plan(db, scanner, changes, {}, input, { signal: control.signal }), /cancelled/);
});
test('large repository skips oversized noise and presents the requested file', async () => {
  const fixture = fixtures.find(f => f.name === 'large-repository');
  await runFixture(client(async (_model, messages, opts) => {
    assert.ok(messages[1].content.includes('--- target.js'));
    assert.ok(messages[1].content.length < 18000);
    assert.equal(opts.options.num_ctx, 8192);
    return response([{ relativePath: 'target.js', find: '2', replacement: '3' }]);
  }), 'test', fixture);
});
test('semantic oracle rejects a valid draft that fails the request', async () => {
  await assert.rejects(() => runFixture(client(async () => response([{ relativePath: 'sample.js', find: 'hello', replacement: 'wrong' }])), 'test', fixtures[0]), /requested final content/);
});
test('multi-file oracle checks all changes and dependency order', async () => {
  await runFixture(client(async () => response([
    { relativePath: 'main.js', find: 'false', replacement: 'true', dependsOn: ['config.json'] },
    { relativePath: 'config.json', find: 'false', replacement: 'true' },
  ])), 'test', fixtures[1]);
});
test('ambiguous fixture requires clarification and no draft', async () => {
  let called=false;
  await runFixture(client(async () => {called=true;}), 'test', fixtures[2]);
  assert.equal(called,false);
});

test('large context prioritizes requested files and records omitted scope', async t => {
  const { db, input, dir } = setup(t);
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(dir, `noise-${i}.txt`), 'noise '.repeat(350));
  fs.writeFileSync(path.join(dir, 'z-target.js'), 'const limit = 2;\n');
  input.request = 'Change limit to 3 in z-target.js';
  const result = await planner.plan(db, scanner, changes, client(async (_model, messages) => {
    assert.ok(messages[1].content.indexOf('--- z-target.js') < messages[1].content.indexOf('--- noise-'));
    assert.ok(messages[1].content.length < 15000);
    return response([{ relativePath: 'z-target.js', find: '2', replacement: '3' }]);
  }), input);
  assert.equal(result.planner.contextPartial, true);
  assert.ok(result.planner.filesOmitted > 0);
});

test('timeout during metadata prevents any later inference', async t => {
  const { db, input } = setup(t);
  let resolveMetadata;
  let called = false;
  const ollama = client(async () => { called = true; });
  ollama.show = () => new Promise(resolve => { resolveMetadata = resolve; });
  await assert.rejects(() => planner.plan(db, scanner, changes, ollama, input, { timeoutMs: 20 }), /timed out/);
  resolveMetadata(metadata);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(called, false);
});

test('model output cannot override the approved root', async t => {
  const { db, input } = setup(t);
  const result = await planner.plan(db, scanner, changes, client(async () => response([{ relativePath: 'a.js', find: '1', replacement: '2', rootId: 'unapproved-root' }])), input);
  assert.equal(result.rootId, input.rootId);
});

test('ambiguity gate rejects vague requests before any Ollama call', async t => {
  const { db, input } = setup(t);
  input.request='Improve this.';
  let calls=0;
  const ollama={status:async()=>{calls++;},show:async()=>{calls++;},chatFull:async()=>{calls++;}};
  await assert.rejects(()=>planner.plan(db,scanner,changes,ollama,input),/Clarification required.*target filename.*intended behavior/);
  assert.equal(calls,0);
  assert.equal(db.all('workspacePlanningAttempts').length,0);
});

test('one bounded repair converts malformed fields and preserves both responses', async t => {
  const { db, input }=setup(t);
  let calls=0;
  const ollama=client(async()=>{
    calls++;
    if(calls===1)return {message:{content:'{"summary":"change","changes":[{"relativePath":"a.js","find":"1"}]}'}};
    return response([{relativePath:'a.js',find:'1',replacement:'2',dependsOn:[],impact:'Updates x.'}]);
  });
  const result=await planner.plan(db,scanner,changes,ollama,input);
  assert.equal(calls,2);
  assert.equal(result.planner.repairAttempted,true);
  const attempt=db.get('workspacePlanningAttempts',result.planner.planningAttemptId);
  assert.equal(attempt.status,'repaired');
  assert.match(attempt.originalResponse.content,/"find":"1"/);
  assert.match(attempt.repairResponse.content,/"replacement":"2"/);
});

test('failed repair preserves evidence and creates no proposal', async t => {
  const { db, input }=setup(t);
  await assert.rejects(()=>planner.plan(db,scanner,changes,client(async()=>({message:{content:'not json'}})),input),/remained invalid/);
  const [attempt]=db.all('workspacePlanningAttempts');
  assert.equal(attempt.status,'failed');
  assert.equal(attempt.originalResponse.content,'not json');
  assert.equal(attempt.repairResponse.content,'not json');
  assert.equal(db.all('workspaceChanges').length,0);
});

test('plan output cap: 2048 by default, NOVA_PLAN_MAX_TOKENS or an option can raise it, clamped to 256-8192', () => {
  const planner = require('../lib/code-planner');
  const saved = process.env.NOVA_PLAN_MAX_TOKENS;
  try {
    delete process.env.NOVA_PLAN_MAX_TOKENS;
    assert.equal(planner.planOutputTokens(), 2048);
    process.env.NOVA_PLAN_MAX_TOKENS = '4096'; assert.equal(planner.planOutputTokens(), 4096);
    assert.equal(planner.planOutputTokens({ maxOutputTokens: 99999 }), 8192);
    process.env.NOVA_PLAN_MAX_TOKENS = '10'; assert.equal(planner.planOutputTokens(), 256);
    assert.ok(planner.repositoryCharacterBudget(8192, 100, 4096) < planner.repositoryCharacterBudget(8192, 100), 'a bigger output cap leaves less room for files');
  } finally { if (saved === undefined) delete process.env.NOVA_PLAN_MAX_TOKENS; else process.env.NOVA_PLAN_MAX_TOKENS = saved; }
});
