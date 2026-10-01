'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { ConnectorRegistry } = require('../lib/connectors');
const { PolicyEngine } = require('../lib/policy');
const { ConnectorActions, ConnectorActionError } = require('../lib/connector-actions');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ca-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  return { dir, db, store };
}
function cleanup(env) {
  try { env.db.close(); } catch {}
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch {}
}

function fakeConnector(behaviour) {
  behaviour = behaviour || {};
  return {
    calls: [],
    async whoami(profileId) { this.calls.push(['whoami', profileId]); return behaviour.whoami || { login: 'x' }; },
    async createIssue(profileId, owner, repo, input) {
      this.calls.push(['createIssue', profileId, owner, repo, input]);
      if (behaviour.createIssueThrows) throw new Error(behaviour.createIssueThrows);
      return behaviour.createIssue || { number: 1, title: input && input.title };
    },
    async createPullRequest(profileId, owner, repo, input) {
      this.calls.push(['createPullRequest', profileId, owner, repo, input]);
      return behaviour.createPullRequest || { number: 2 };
    },
  };
}

function setup(opts) {
  opts = opts || {};
  const env = fresh();
  const registry = new ConnectorRegistry(env.store);
  const profile = registry.create({ kind: 'github', name: 'g' });

  const policy = new PolicyEngine(env.store);
  if (opts.grants) {
    for (const g of opts.grants) policy.grant(g);
  }

  const connector = fakeConnector(opts.behaviour);
  const events = [];
  const actions = new ConnectorActions({
    store: env.store,
    registry,
    connector,
    policy: opts.usePolicy === false ? null : policy,
    audit: (e) => events.push(e),
    expiryMs: opts.expiryMs,
  });

  return { env, registry, profile, policy, connector, actions, events };
}

function allowGrant(profileId, op) {
  return {
    subject: { type: 'connector', id: profileId },
    resource: { type: 'connector-action', id: op },
    effect: 'allow',
  };
}
function approvalGrant(profileId, op) {
  return {
    subject: { type: 'connector', id: profileId },
    resource: { type: 'connector-action', id: op },
    effect: 'allow',
    conditions: { requires_approval: true },
  };
}

test('1 allow_policy_executes_immediately', async () => {
  const env = fresh();
  const registry = new ConnectorRegistry(env.store);
  const profile = registry.create({ kind: 'github', name: 'g' });
  const policy = new PolicyEngine(env.store);
  policy.grant(allowGrant(profile.id, 'whoami'));
  const connector = fakeConnector();
  const actions = new ConnectorActions({ store: env.store, registry, connector, policy });
  const r = await actions.request(profile.id, 'whoami', [], 'alice');
  assert.equal(r.status, 'executed');
  assert.equal(connector.calls.length, 1);
  cleanup(env);
});

test('2_no_policy_engine_executes', async () => {
  const env = fresh();
  const registry = new ConnectorRegistry(env.store);
  const profile = registry.create({ kind: 'github', name: 'g' });
  const connector = fakeConnector();
  const actions = new ConnectorActions({ store: env.store, registry, connector });
  const r = await actions.request(profile.id, 'whoami', [], 'alice');
  assert.equal(r.status, 'executed');
  cleanup(env);
});

test('3_deny_policy_rejects', async () => {
  const env = fresh();
  const registry = new ConnectorRegistry(env.store);
  const profile = registry.create({ kind: 'github', name: 'g' });
  const policy = new PolicyEngine(env.store); // no grants → default deny
  const connector = fakeConnector();
  const actions = new ConnectorActions({ store: env.store, registry, connector, policy });
  await assert.rejects(
    () => actions.request(profile.id, 'createIssue', ['o', 'r', { title: 'x' }], 'alice'),
    (e) => e.code === 'policy_denied'
  );
  assert.equal(connector.calls.length, 0);
  cleanup(env);
});

test('4_approval_required_queues_request', async () => {
  const env = fresh();
  const registry = new ConnectorRegistry(env.store);
  const profile = registry.create({ kind: 'github', name: 'g' });
  const policy = new PolicyEngine(env.store);
  policy.grant(approvalGrant(profile.id, 'createIssue'));
  const connector = fakeConnector();
  const actions = new ConnectorActions({ store: env.store, registry, connector, policy });

  const r = await actions.request(profile.id, 'createIssue', ['o', 'r', { title: 'x' }], 'alice');
  assert.equal(r.status, 'pending');
  assert.ok(r.requestId.startsWith('car_'));
  assert.equal(r.request.operation, 'createIssue');
  assert.equal(r.request.status, 'pending');
  assert.equal(r.request.requested_by, 'alice');
  assert.equal(connector.calls.length, 0);
  cleanup(env);
});

test('5_approve_executes_pending', async () => {
  const env = fresh();
  const registry = new ConnectorRegistry(env.store);
  const profile = registry.create({ kind: 'github', name: 'g' });
  const policy = new PolicyEngine(env.store);
  policy.grant(approvalGrant(profile.id, 'createIssue'));
  const connector = fakeConnector();
  const actions = new ConnectorActions({ store: env.store, registry, connector, policy });

  const req = await actions.request(profile.id, 'createIssue', ['o', 'r', { title: 'x' }], 'alice');
  const res = await actions.approve(req.requestId, 'bob', 'looks good');
  assert.equal(res.status, 'executed');
  assert.ok(res.result_json);
  assert.equal(res.resolved_by, 'bob');
  assert.equal(res.resolution_note, 'looks good');
  assert.equal(connector.calls.length, 1);
  assert.equal(connector.calls[0][0], 'createIssue');
  cleanup(env);
});

test('6_deny_marks_denied_no_execution', async () => {
  const env = fresh();
  const registry = new ConnectorRegistry(env.store);
  const profile = registry.create({ kind: 'github', name: 'g' });
  const policy = new PolicyEngine(env.store);
  policy.grant(approvalGrant(profile.id, 'createIssue'));
  const connector = fakeConnector();
  const actions = new ConnectorActions({ store: env.store, registry, connector, policy });

  const req = await actions.request(profile.id, 'createIssue', ['o', 'r', { title: 'x' }], 'alice');
  const res = actions.deny(req.requestId, 'bob', 'not now');
  assert.equal(res.status, 'denied');
  assert.equal(res.resolved_by, 'bob');
  assert.equal(res.resolution_note, 'not now');
  assert.equal(connector.calls.length, 0);
  cleanup(env);
});

test('7_cannot_resolve_twice', async () => {
  const env = fresh();
  const registry = new ConnectorRegistry(env.store);
  const profile = registry.create({ kind: 'github', name: 'g' });
  const policy = new PolicyEngine(env.store);
  policy.grant(approvalGrant(profile.id, 'createIssue'));
  const connector = fakeConnector();
  const actions = new ConnectorActions({ store: env.store, registry, connector, policy });

  const req = await actions.request(profile.id, 'createIssue', ['o', 'r', { title: 'x' }], 'alice');
  await actions.approve(req.requestId, 'bob');
  await assert.rejects(
    () => actions.approve(req.requestId, 'bob'),
    (e) => e.code === 'not_pending'
  );
  assert.throws(
    () => actions.deny(req.requestId, 'bob'),
    (e) => e.code === 'not_pending'
  );
  cleanup(env);
});

test('8_expired_request_rejects_resolution', async () => {
  const env = fresh();
  const registry = new ConnectorRegistry(env.store);
  const profile = registry.create({ kind: 'github', name: 'g' });
  const policy = new PolicyEngine(env.store);
  policy.grant(approvalGrant(profile.id, 'createIssue'));
  const connector = fakeConnector();
  const actions = new ConnectorActions({
    store: env.store, registry, connector, policy,
    expiryMs: -1000, // already expired
  });

  const req = await actions.request(profile.id, 'createIssue', ['o', 'r', { title: 'x' }], 'alice');
  await assert.rejects(
    () => actions.approve(req.requestId, 'bob'),
    (e) => e.code === 'expired'
  );
  const row = actions.get(req.requestId);
  assert.equal(row.status, 'expired');
  cleanup(env);
});

test('9_disabled_profile_rejected', async () => {
  const env = fresh();
  const registry = new ConnectorRegistry(env.store);
  const profile = registry.create({ kind: 'github', name: 'g' });
  registry.disable(profile.id);
  const connector = fakeConnector();
  const actions = new ConnectorActions({ store: env.store, registry, connector });
  await assert.rejects(
    () => actions.request(profile.id, 'whoami', [], 'alice'),
    (e) => e.code === 'disabled'
  );
  cleanup(env);
});

test('10_revoked_profile_rejected', async () => {
  const env = fresh();
  const registry = new ConnectorRegistry(env.store);
  const profile = registry.create({ kind: 'github', name: 'g' });
  registry.revoke(profile.id);
  const connector = fakeConnector();
  const actions = new ConnectorActions({ store: env.store, registry, connector });
  await assert.rejects(
    () => actions.request(profile.id, 'whoami', [], 'alice'),
    (e) => e.code === 'revoked'
  );
  cleanup(env);
});

test('11_unknown_operation_rejected', async () => {
  const env = fresh();
  const registry = new ConnectorRegistry(env.store);
  const profile = registry.create({ kind: 'github', name: 'g' });
  const actions = new ConnectorActions({ store: env.store, registry, connector: fakeConnector() });
  await assert.rejects(
    () => actions.request(profile.id, 'launchRockets', [], 'alice'),
    (e) => e.code === 'unknown_operation'
  );
  cleanup(env);
});

test('12_execution_failure_recorded', async () => {
  const env = fresh();
  const registry = new ConnectorRegistry(env.store);
  const profile = registry.create({ kind: 'github', name: 'g' });
  const policy = new PolicyEngine(env.store);
  policy.grant(approvalGrant(profile.id, 'createIssue'));
  const connector = fakeConnector({ createIssueThrows: 'boom' });
  const actions = new ConnectorActions({ store: env.store, registry, connector, policy });

  const req = await actions.request(profile.id, 'createIssue', ['o', 'r', { title: 'x' }], 'alice');
  const res = await actions.approve(req.requestId, 'bob');
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'boom');
  cleanup(env);
});

test('13_pending_list_and_audit', async () => {
  const env = fresh();
  const registry = new ConnectorRegistry(env.store);
  const profile = registry.create({ kind: 'github', name: 'g' });
  const policy = new PolicyEngine(env.store);
  policy.grant(approvalGrant(profile.id, 'createIssue'));
  const policyAllow = new PolicyEngine(env.store);
  policyAllow.grant(allowGrant(profile.id, 'whoami'));
  const connector = fakeConnector();
  const events = [];
  const actions = new ConnectorActions({
    store: env.store, registry, connector, policy,
    audit: (e) => events.push(e),
  });

  await actions.request(profile.id, 'createIssue', ['o', 'r', { title: 'a' }], 'alice');
  await actions.request(profile.id, 'createIssue', ['o', 'r', { title: 'b' }], 'alice');
  assert.equal(actions.pending().length, 2);
  assert.ok(events.some((e) => e.action === 'connector_action.requested'));
  cleanup(env);
});

test('14_constructor_and_validation', async () => {
  assert.throws(() => new ConnectorActions({}), (e) => e.code === 'bad_store');
  const env = fresh();
  const registry = new ConnectorRegistry(env.store);
  assert.throws(() => new ConnectorActions({ store: env.store }), (e) => e.code === 'bad_registry');
  assert.throws(() => new ConnectorActions({ store: env.store, registry }), (e) => e.code === 'bad_connector');

  const actions = new ConnectorActions({
    store: env.store, registry, connector: fakeConnector(),
  });
  await assert.rejects(() => actions.request('', 'whoami', [], 'a'), (e) => e.code === 'bad_profile_id');
  await assert.rejects(() => actions.request('p', '', [], 'a'), (e) => e.code === 'bad_operation');
  await assert.rejects(() => actions.request('p', 'whoami', [], ''), (e) => e.code === 'bad_operator');
  cleanup(env);
});
