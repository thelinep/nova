'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { SemanticVoter, SemanticVoteError, ALL_CRASH } = require('../lib/semantic-vote');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-sv-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  return { dir, db, store };
}
function cleanup(env) {
  try { env.db.close(); } catch {}
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch {}
}

// executor(code, input) → value. Code can pattern-match on `code` or `input`.
const fixedExecutor = (out) => async () => out;
const codeAwareExecutor = (map) => async (code) => {
  if (Object.prototype.hasOwnProperty.call(map, code)) return map[code];
  throw new Error('unknown code');
};

test('1 single candidate single cluster', async () => {
  const env = fresh();
  const v = new SemanticVoter(env.store, { executor: fixedExecutor('result') });
  const r = await v.vote([{ id: 'a', code: 'xxx' }], [1, 2]);
  assert.equal(r.ok, true);
  assert.equal(r.winner_id, 'a');
  assert.equal(r.clusters.length, 1);
  assert.equal(r.clusters[0].members.length, 1);
  cleanup(env);
});

test('2 identical behavior one cluster', async () => {
  const env = fresh();
  const v = new SemanticVoter(env.store, { executor: fixedExecutor('same') });
  const r = await v.vote(
    [{ id: 'a', code: 'x1' }, { id: 'b', code: 'x2' }, { id: 'c', code: 'x3' }],
    [1, 2]
  );
  assert.equal(r.ok, true);
  assert.equal(r.clusters.length, 1);
  assert.equal(r.clusters[0].members.length, 3);
  cleanup(env);
});

test('3 largest cluster wins', async () => {
  const env = fresh();
  const exec = codeAwareExecutor({ good: 'A', good2: 'A', bad: 'B' });
  const v = new SemanticVoter(env.store, { executor: exec });
  const r = await v.vote(
    [{ id: 'a', code: 'good' }, { id: 'b', code: 'good2' }, { id: 'c', code: 'bad' }],
    [1]
  );
  assert.equal(r.ok, true);
  assert.ok(r.clusters.length === 2);
  assert.ok(r.clusters[0].members.includes('a'));
  assert.ok(r.clusters[0].members.includes('b'));
  assert.ok(['a', 'b'].includes(r.winner_id));
  cleanup(env);
});

test('4 all crash no clusters', async () => {
  const env = fresh();
  const v = new SemanticVoter(env.store, {
    executor: async () => { throw new Error('boom'); },
  });
  const r = await v.vote(
    [{ id: 'a', code: 'x' }, { id: 'b', code: 'y' }],
    [1, 2]
  );
  assert.equal(r.ok, false);
  assert.equal(r.winner_id, null);
  assert.equal(r.clusters.length, 0);
  cleanup(env);
});

test('5 some crash excluded', async () => {
  const env = fresh();
  const exec = codeAwareExecutor({ good: 'A' });
  const v = new SemanticVoter(env.store, { executor: exec });
  const r = await v.vote(
    [{ id: 'a', code: 'good' }, { id: 'b', code: 'unknown' }],
    [1]
  );
  assert.equal(r.ok, true);
  assert.equal(r.winner_id, 'a');
  assert.equal(r.clusters.length, 1);
  assert.equal(r.clusters[0].members.length, 1);
  cleanup(env);
});

test('6 deterministic', async () => {
  const env = fresh();
  const exec = codeAwareExecutor({ x: 'out', y: 'out', z: 'different' });
  const v = new SemanticVoter(env.store, { executor: exec });
  const candidates = [{ id: 'a', code: 'x' }, { id: 'b', code: 'y' }, { id: 'c', code: 'z' }];
  const r1 = await v.vote(candidates, [1]);
  const r2 = await v.vote(candidates, [1]);
  assert.equal(r1.winner_id, r2.winner_id);
  assert.deepEqual(
    r1.clusters.map((c) => c.members.slice().sort()).sort(),
    r2.clusters.map((c) => c.members.slice().sort()).sort()
  );
  cleanup(env);
});

test('7 timeout excludes slow executor', async () => {
  const env = fresh();
  const exec = async (code) => {
    if (code === 'slow') {
      await new Promise((r) => setTimeout(r, 500));
      return 'x';
    }
    return 'y';
  };
  const v = new SemanticVoter(env.store, { executor: exec, timeoutMs: 100 });
  const r = await v.vote(
    [{ id: 'a', code: 'fast' }, { id: 'b', code: 'slow' }],
    [1]
  );
  assert.equal(r.ok, true);
  assert.equal(r.winner_id, 'a');
  cleanup(env);
});

test('8 constructor validates', () => {
  assert.throws(() => new SemanticVoter(null, {}),
    (e) => e instanceof SemanticVoteError && e.code === 'bad_store');
  assert.throws(() => new SemanticVoter({}, {}),
    (e) => e instanceof SemanticVoteError && e.code === 'bad_executor');
});

test('9 empty candidates rejected', async () => {
  const env = fresh();
  const v = new SemanticVoter(env.store, { executor: fixedExecutor('x') });
  await assert.rejects(() => v.vote([], [1]),
    (e) => e instanceof SemanticVoteError && e.code === 'bad_candidates');
  cleanup(env);
});

test('10 empty inputs rejected', async () => {
  const env = fresh();
  const v = new SemanticVoter(env.store, { executor: fixedExecutor('x') });
  await assert.rejects(() => v.vote([{ id: 'a', code: 'c' }], []),
    (e) => e instanceof SemanticVoteError && e.code === 'bad_inputs');
  cleanup(env);
});

test('11 history records runs', async () => {
  const env = fresh();
  const v = new SemanticVoter(env.store, { executor: fixedExecutor('x') });
  await v.vote([{ id: 'a', code: 'x' }], [1]);
  await v.vote([{ id: 'b', code: 'y' }], [1]);
  const rows = v.history({});
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.ok(r.winner_id);
    assert.equal(r.candidate_count, 1);
  }
  cleanup(env);
});

test('12 cluster sizes match members', async () => {
  const env = fresh();
  const exec = codeAwareExecutor({ one: 'A', two: 'A', three: 'A', four: 'B' });
  const v = new SemanticVoter(env.store, { executor: exec });
  const r = await v.vote(
    [{ id: 'w', code: 'one' }, { id: 'x', code: 'two' }, { id: 'y', code: 'three' }, { id: 'z', code: 'four' }],
    [1]
  );
  assert.equal(r.ok, true);
  for (const cl of r.clusters) {
    assert.equal(cl.size, cl.members.length);
  }
  const sizes = r.clusters.map((c) => c.size).sort((a, b) => b - a);
  assert.deepEqual(sizes, [3, 1]);
  cleanup(env);
});
