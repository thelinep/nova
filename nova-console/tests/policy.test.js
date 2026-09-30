'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const {
  PolicyEngine,
  PolicyDeniedError,
  PolicyError,
  SCOPES,
} = require('../lib/policy');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-policy-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  return { dir, db, store };
}

function cleanup(env) {
  try { env.db.close(); } catch { /* noop */ }
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch { /* noop */ }
}

test('1 default_deny', () => {
  const env = fresh();
  const engine = new PolicyEngine(env.store);
  const r = engine.check({ type: 'agent', id: 'a' }, { type: 'tool', id: 't' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'policy_denied');
  assert.equal(r.policyId, null);
  cleanup(env);
});

test('2 allow_exact_match', () => {
  const env = fresh();
  const engine = new PolicyEngine(env.store);
  const p = engine.grant({
    subject: { type: 'agent', id: 'a' },
    resource: { type: 'tool', id: 't' },
    effect: 'allow',
  });
  assert.ok(p.id);
  const r = engine.check({ type: 'agent', id: 'a' }, { type: 'tool', id: 't' });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'policy_allow');
  assert.equal(r.policyId, p.id);
  cleanup(env);
});

test('3 deny_wins_over_allow', () => {
  const env = fresh();
  const engine = new PolicyEngine(env.store);
  engine.grant({
    subject: { type: 'agent', id: 'a' },
    resource: { type: 'tool', id: 't' },
    effect: 'allow',
  });
  const deny = engine.grant({
    subject: { type: 'agent', id: 'a' },
    resource: { type: 'tool', id: 't' },
    effect: 'deny',
  });
  const r = engine.check({ type: 'agent', id: 'a' }, { type: 'tool', id: 't' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'policy_explicit_deny');
  assert.equal(r.policyId, deny.id);
  cleanup(env);
});

test('4 wildcard_subject', () => {
  const env = fresh();
  const engine = new PolicyEngine(env.store);
  engine.grant({
    subject: { type: '*', id: '*' },
    resource: { type: 'tool', id: 't' },
    effect: 'allow',
  });
  const r = engine.check({ type: 'agent', id: 'anyone' }, { type: 'tool', id: 't' });
  assert.equal(r.allowed, true);
  cleanup(env);
});

test('5 expired_policy_denies', () => {
  const env = fresh();
  const engine = new PolicyEngine(env.store);
  engine.grant({
    subject: { type: 'agent', id: 'a' },
    resource: { type: 'tool', id: 't' },
    effect: 'allow',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const r = engine.check({ type: 'agent', id: 'a' }, { type: 'tool', id: 't' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'policy_expired');
  cleanup(env);
});

test('6 revoked_policy_denies', () => {
  const env = fresh();
  const engine = new PolicyEngine(env.store);
  const p = engine.grant({
    subject: { type: 'agent', id: 'a' },
    resource: { type: 'tool', id: 't' },
    effect: 'allow',
  });
  engine.revoke(p.id);
  const r = engine.check({ type: 'agent', id: 'a' }, { type: 'tool', id: 't' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'policy_revoked');
  cleanup(env);
});

test('7 max_per_day_cap', () => {
  const env = fresh();
  const engine = new PolicyEngine(env.store);
  engine.grant({
    subject: { type: 'agent', id: 'a' },
    resource: { type: 'tool', id: 't' },
    effect: 'allow',
    conditions: { max_per_day: 2 },
  });
  const sub = { type: 'agent', id: 'a' };
  const res = { type: 'tool', id: 't' };
  assert.equal(engine.check(sub, res).allowed, true);
  assert.equal(engine.check(sub, res).allowed, true);
  const third = engine.check(sub, res);
  assert.equal(third.allowed, false);
  assert.equal(third.reason, 'rate_limit_exceeded');
  cleanup(env);
});

test('8 fuzz_no_bypass', () => {
  const env = fresh();
  const engine = new PolicyEngine(env.store);
  for (let i = 0; i < 5; i++) {
    engine.grant({
      subject: { type: 'agent', id: `a${i}` },
      resource: { type: 'tool', id: `t${i}` },
      effect: 'allow',
    });
  }
  const before = env.store.policyDecisionsList({}).length;
  for (let i = 0; i < 500; i++) {
    engine.check(
      { type: 'agent', id: `a${i % 10}` },
      { type: 'tool', id: `t${i % 10}` }
    );
  }
  const after = env.store.policyDecisionsList({}).length;
  assert.equal(after - before, 500);
  cleanup(env);
});

test('9 revocation_mid_run', () => {
  const env = fresh();
  const engine = new PolicyEngine(env.store);
  const p = engine.grant({
    subject: { type: 'agent', id: 'a' },
    resource: { type: 'tool', id: 't' },
    effect: 'allow',
  });
  assert.equal(
    engine.check({ type: 'agent', id: 'a' }, { type: 'tool', id: 't' }).allowed,
    true
  );
  engine.revoke(p.id);
  assert.equal(
    engine.check({ type: 'agent', id: 'a' }, { type: 'tool', id: 't' }).allowed,
    false
  );
  cleanup(env);
});

test('10 audit_chain_and_enforce', () => {
  const env = fresh();
  const engine = new PolicyEngine(env.store);
  engine.grant({
    subject: { type: 'agent', id: 'a' },
    resource: { type: 'tool', id: 't' },
    effect: 'allow',
  });

  engine.enforce({ type: 'agent', id: 'a' }, { type: 'tool', id: 't' });

  const decisions = env.store.policyDecisionsList({});
  assert.ok(decisions.length >= 1);
  const last = decisions[decisions.length - 1];
  assert.equal(last.decision, 'allow');
  assert.match(last.inputs_hash, /^[a-f0-9]{64}$/);

  let threw = false;
  try {
    engine.enforce({ type: 'agent', id: 'x' }, { type: 'tool', id: 'y' });
  } catch (e) {
    threw = true;
    assert.ok(e instanceof PolicyDeniedError);
    assert.equal(e.reason, 'policy_denied');
  }
  assert.equal(threw, true);
  cleanup(env);
});
