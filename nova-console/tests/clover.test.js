'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { CloverVerifier, CloverError } = require('../lib/clover');
const { DafnyPro } = require('../lib/dafny-pro');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-clv-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  return { dir, db, store };
}
function cleanup(env) {
  try { env.db.close(); } catch {}
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch {}
}

// A DafnyPro instance that always verifies.
function passingDafnyPro(store) {
  return new DafnyPro(store, {
    llm: async ({ baseCode }) => ({ code: baseCode, annotations: ['requires x > 0'] }),
    dafny: async () => ({ verified: true, errors: [] }),
  });
}

// A DafnyPro instance that never verifies.
function failingDafnyPro(store) {
  return new DafnyPro(store, {
    llm: async ({ baseCode }) => ({ code: baseCode, annotations: ['requires x > 0'] }),
    dafny: async () => ({ verified: false, errors: ['cannot prove'] }),
    maxAttempts: 1,
  });
}

const goodGenerator = () => async () => ({
  code: 'method Add(x: int) returns (y: int) { y := x + 1; }',
  docstring: 'Add returns x plus one.',
  spec: 'method Add requires x > 0 ensures y > x',
});

test('1 happy path verified', async () => {
  const env = fresh();
  const cv = new CloverVerifier(env.store, {
    specGenerator: goodGenerator(),
    dafnyPro: passingDafnyPro(env.store),
  });
  const r = await cv.verify('sum of two numbers', 'method Add(x: int) returns (y: int) { y := x + 1; }');
  assert.equal(r.ok, true);
  assert.equal(r.status, 'verified');
  assert.equal(r.consistency_ok, true);
  assert.equal(r.proof_ok, true);
  cleanup(env);
});

test('2 missing spec', async () => {
  const env = fresh();
  const cv = new CloverVerifier(env.store, {
    specGenerator: async () => ({ code: 'method A() { }', docstring: 'a', spec: '' }),
    dafnyPro: passingDafnyPro(env.store),
  });
  const r = await cv.verify('problem', 'method A() { }');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'missing_spec');
  cleanup(env);
});

test('3 spec without requires/ensures', async () => {
  const env = fresh();
  const cv = new CloverVerifier(env.store, {
    specGenerator: async () => ({ code: 'method A() { }', docstring: 'a', spec: 'method A' }),
    dafnyPro: passingDafnyPro(env.store),
  });
  const r = await cv.verify('problem', 'method A() { }');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'inconsistent');
  assert.equal(r.consistency_ok, false);
  assert.match(r.detail, /requires or ensures/);
  cleanup(env);
});

test('4 forbidden pattern assume false', async () => {
  const env = fresh();
  const cv = new CloverVerifier(env.store, {
    specGenerator: async () => ({
      code: 'method A() { }',
      docstring: 'a',
      spec: 'method A requires x > 0 ensures y > 0 assume false',
    }),
    dafnyPro: passingDafnyPro(env.store),
  });
  const r = await cv.verify('problem', 'method A() { }');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'inconsistent');
  assert.match(r.detail, /assume_false/);
  cleanup(env);
});

test('5 no method declared', async () => {
  const env = fresh();
  const cv = new CloverVerifier(env.store, {
    specGenerator: async () => ({
      code: 'var x = 1;',
      docstring: 'no functions',
      spec: 'requires x > 0 ensures y > 0',
    }),
    dafnyPro: passingDafnyPro(env.store),
  });
  const r = await cv.verify('problem', 'var x = 1;');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'inconsistent');
  assert.match(r.detail, /no method or function/);
  cleanup(env);
});

test('6 spec does not mention function name', async () => {
  const env = fresh();
  const cv = new CloverVerifier(env.store, {
    specGenerator: async () => ({
      code: 'method Multiply(x: int) returns (y: int) { y := x * 2; }',
      docstring: 'Multiply doubles x.',
      spec: 'method Add requires x > 0 ensures y > 0',
    }),
    dafnyPro: passingDafnyPro(env.store),
  });
  const r = await cv.verify('problem', 'method Multiply(x: int) returns (y: int) { y := x * 2; }');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'inconsistent');
  assert.match(r.detail, /does not mention Multiply/);
  cleanup(env);
});

test('7 spec generator throws', async () => {
  const env = fresh();
  const cv = new CloverVerifier(env.store, {
    specGenerator: async () => { throw new Error('gen broke'); },
    dafnyPro: passingDafnyPro(env.store),
  });
  const r = await cv.verify('problem', 'method A() { }');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'generator_failed');
  cleanup(env);
});

test('8 proof failure recorded', async () => {
  const env = fresh();
  const cv = new CloverVerifier(env.store, {
    specGenerator: goodGenerator(),
    dafnyPro: failingDafnyPro(env.store),
  });
  const r = await cv.verify('sum', 'method Add(x: int) returns (y: int) { y := x + 1; }');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'proof_failed');
  assert.equal(r.consistency_ok, true);
  assert.equal(r.proof_ok, false);
  cleanup(env);
});

test('9 custom consistency checker used', async () => {
  const env = fresh();
  let called = false;
  const cv = new CloverVerifier(env.store, {
    specGenerator: goodGenerator(),
    dafnyPro: passingDafnyPro(env.store),
    consistencyChecker: async (triplet) => {
      called = true;
      assert.ok(triplet.code && triplet.spec);
      return { consistent: true, detail: null };
    },
  });
  const r = await cv.verify('p', 'method Add(x: int) returns (y: int) { y := x + 1; }');
  assert.equal(called, true);
  assert.equal(r.ok, true);
  cleanup(env);
});

test('10 history records runs', async () => {
  const env = fresh();
  const cv = new CloverVerifier(env.store, {
    specGenerator: goodGenerator(),
    dafnyPro: passingDafnyPro(env.store),
  });
  await cv.verify('p1', 'method Add(x: int) returns (y: int) { y := x + 1; }');
  await cv.verify('p2', 'method Add(x: int) returns (y: int) { y := x + 1; }');
  const rows = cv.history({});
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.status, 'verified');
    assert.equal(r.consistency_ok, 1);
    assert.equal(r.proof_ok, 1);
  }
  cleanup(env);
});

test('11 get returns specific run', async () => {
  const env = fresh();
  const cv = new CloverVerifier(env.store, {
    specGenerator: goodGenerator(),
    dafnyPro: passingDafnyPro(env.store),
  });
  const r = await cv.verify('p', 'method Add(x: int) returns (y: int) { y := x + 1; }');
  const row = cv.get(r.runId);
  assert.ok(row);
  assert.equal(row.status, 'verified');
  cleanup(env);
});

test('12 constructor and input validation', async () => {
  assert.throws(() => new CloverVerifier(null, {}),
    (e) => e instanceof CloverError && e.code === 'bad_store');
  assert.throws(() => new CloverVerifier({}, {}),
    (e) => e instanceof CloverError && e.code === 'bad_spec_generator');
  assert.throws(() => new CloverVerifier({}, { specGenerator: () => {} }),
    (e) => e instanceof CloverError && e.code === 'bad_dafny_pro');

  const env = fresh();
  const cv = new CloverVerifier(env.store, {
    specGenerator: goodGenerator(),
    dafnyPro: passingDafnyPro(env.store),
  });
  await assert.rejects(() => cv.verify('', 'method A() { }'),
    (e) => e instanceof CloverError && e.code === 'bad_problem');
  await assert.rejects(() => cv.verify('p', ''),
    (e) => e instanceof CloverError && e.code === 'bad_code');
  cleanup(env);
});
