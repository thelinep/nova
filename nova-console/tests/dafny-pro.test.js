'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { DafnyPro, DafnyProError, stripAnnotations, isAnnotationLine } = require('../lib/dafny-pro');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-dp-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  return { dir, db, store };
}
function cleanup(env) {
  try { env.db.close(); } catch {}
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch {}
}

const llmEcho = () => async ({ baseCode, previousErrors }) => ({
  code: baseCode,
  annotations: previousErrors.length ? ['requires x > 0', 'ensures y > 0'] : ['requires x > 0'],
});

const llmAlwaysVerified = () => async ({ baseCode }) => ({
  code: baseCode,
  annotations: ['requires x > 0', 'ensures result > 0'],
});

const llmModifiesLogic = () => async ({ baseCode }) => ({
  code: baseCode + '\ny := 999;',
  annotations: [],
});

const dafnyPass = () => async () => ({ verified: true, errors: [] });
const dafnyFail = (errors) => async () => ({ verified: false, errors: errors || ['assertion may not hold'] });

test('1 happy path verified first attempt', async () => {
  const env = fresh();
  const dp = new DafnyPro(env.store, { llm: llmAlwaysVerified(), dafny: dafnyPass() });
  const r = await dp.verify(
    'method Add(x: int) returns (y: int) { y := x + 1; }',
    'requires x > 0; ensures y > x;'
  );
  assert.equal(r.ok, true);
  assert.equal(r.status, 'verified');
  assert.equal(r.attempts, 1);
  assert.ok(Array.isArray(r.annotations));
  cleanup(env);
});

test('2 diff check rejects modified base logic', async () => {
  const env = fresh();
  const dp = new DafnyPro(env.store, {
    llm: llmModifiesLogic(),
    dafny: dafnyPass(),
    maxAttempts: 2,
  });
  const r = await dp.verify(
    'method A() { }',
    'requires true;'
  );
  assert.equal(r.ok, false);
  assert.equal(r.status, 'exhausted');
  const attempts = dp.attemptsFor(r.runId);
  assert.ok(attempts.length >= 2);
  for (const a of attempts) {
    assert.match(a.rejected_reason || '', /diff_not_clean/);
  }
  cleanup(env);
});

test('3 exhausts attempts then fails', async () => {
  const env = fresh();
  const dp = new DafnyPro(env.store, {
    llm: llmEcho(),
    dafny: dafnyFail(['cannot prove']),
    maxAttempts: 3,
  });
  const r = await dp.verify('method B() { }', 'requires true;');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'exhausted');
  assert.equal(r.attempts, 3);
  cleanup(env);
});

test('4 succeeds on later attempt', async () => {
  const env = fresh();
  let calls = 0;
  const dafny = async () => {
    calls++;
    return calls >= 2 ? { verified: true, errors: [] } : { verified: false, errors: ['try again'] };
  };
  const dp = new DafnyPro(env.store, { llm: llmEcho(), dafny, maxAttempts: 5 });
  const r = await dp.verify('method C() { }', 'requires true;');
  assert.equal(r.ok, true);
  assert.equal(r.status, 'verified');
  assert.equal(r.attempts, 2);
  cleanup(env);
});

test('5 llm failure reported', async () => {
  const env = fresh();
  const dp = new DafnyPro(env.store, {
    llm: async () => { throw new Error('llm down'); },
    dafny: dafnyPass(),
  });
  const r = await dp.verify('method D() { }', 'requires true;');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'llm_failed');
  cleanup(env);
});

test('6 dafny failure reported', async () => {
  const env = fresh();
  const dp = new DafnyPro(env.store, {
    llm: llmEcho(),
    dafny: async () => { throw new Error('dafny binary missing'); },
  });
  const r = await dp.verify('method E() { }', 'requires true;');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'dafny_failed');
  cleanup(env);
});

test('7 annotation lines recognized', () => {
  assert.equal(isAnnotationLine('requires x > 0'), true);
  assert.equal(isAnnotationLine('ensures y > 0'), true);
  assert.equal(isAnnotationLine('invariant n >= 0'), true);
  assert.equal(isAnnotationLine('// comment'), true);
  assert.equal(isAnnotationLine('var x := 5;'), false);
  assert.equal(isAnnotationLine('if (x > 0) {'), false);
});

test('8 stripAnnotations preserves base logic', () => {
  const code = [
    'method Add(x: int) returns (y: int)',
    '  requires x > 0',
    '  ensures y > x',
    '{',
    '  y := x + 1;',
    '}',
  ].join('\n');
  const stripped = stripAnnotations(code);
  assert.ok(stripped.includes('method Add'));
  assert.ok(stripped.includes('y := x + 1;'));
  assert.ok(!stripped.includes('requires'));
  assert.ok(!stripped.includes('ensures'));
});

test('9 diff accepts annotation-only change', async () => {
  const env = fresh();
  let diffRejected = false;
  const dp = new DafnyPro(env.store, {
    llm: async ({ baseCode }) => ({ code: baseCode, annotations: ['requires x > 0'] }),
    dafny: async () => { diffRejected = false; return { verified: true, errors: [] }; },
  });
  const base = 'method F(x: int) { }';
  const r = await dp.verify(base, 'requires x > 0;');
  assert.equal(r.ok, true);
  assert.equal(diffRejected, false);
  cleanup(env);
});

test('10 history records runs', async () => {
  const env = fresh();
  const dp = new DafnyPro(env.store, { llm: llmAlwaysVerified(), dafny: dafnyPass() });
  await dp.verify('method G() { }', 'requires true;');
  await dp.verify('method H() { }', 'requires true;');
  const rows = dp.history({});
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.status, 'verified');
    assert.ok(r.spec_hash);
  }
  cleanup(env);
});

test('11 attempts recorded per run', async () => {
  const env = fresh();
  let calls = 0;
  const dafny = async () => {
    calls++;
    return calls === 1 ? { verified: false, errors: ['first fail'] } : { verified: true, errors: [] };
  };
  const dp = new DafnyPro(env.store, { llm: llmEcho(), dafny, maxAttempts: 3 });
  const r = await dp.verify('method I() { }', 'requires true;');
  const attempts = dp.attemptsFor(r.runId);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].verified, 0);
  assert.equal(attempts[1].verified, 1);
  cleanup(env);
});

test('12 constructor and input validation', async () => {
  assert.throws(() => new DafnyPro(null, {}),
    (e) => e instanceof DafnyProError && e.code === 'bad_store');
  assert.throws(() => new DafnyPro({}, {}),
    (e) => e instanceof DafnyProError && e.code === 'bad_llm');
  assert.throws(() => new DafnyPro({}, { llm: () => {} }),
    (e) => e instanceof DafnyProError && e.code === 'bad_dafny');
  const env = fresh();
  const dp = new DafnyPro(env.store, { llm: llmEcho(), dafny: dafnyPass() });
  await assert.rejects(() => dp.verify('', 'requires true;'),
    (e) => e instanceof DafnyProError && e.code === 'bad_code');
  await assert.rejects(() => dp.verify('method A() { }', ''),
    (e) => e instanceof DafnyProError && e.code === 'bad_spec');
  cleanup(env);
});
