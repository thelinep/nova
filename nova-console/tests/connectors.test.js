'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { ConnectorRegistry, ConnectorError, KNOWN_KINDS } = require('../lib/connectors');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-conn-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  return { dir, db, store };
}
function cleanup(env) {
  try { env.db.close(); } catch {}
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch {}
}

test('1 create_github_profile', () => {
  const env = fresh();
  const r = new ConnectorRegistry(env.store);
  const p = r.create({
    kind: 'github',
    name: 'work-github',
    config: { api_base_url: 'https://api.github.com' },
    scopes: ['pr:read', 'pr:create'],
    createdBy: 'alice',
  });
  assert.ok(p.id.startsWith('conn_'));
  assert.equal(p.kind, 'github');
  assert.equal(p.name, 'work-github');
  assert.equal(p.enabled, 1);
  assert.equal(p.created_by, 'alice');
  assert.equal(p.revoked_at, null);
  cleanup(env);
});

test('2 unknown_kind_rejected', () => {
  const env = fresh();
  const r = new ConnectorRegistry(env.store);
  assert.throws(
    () => r.create({ kind: 'gopher', name: 'x' }),
    (e) => e instanceof ConnectorError && e.code === 'unknown_kind'
  );
  cleanup(env);
});

test('3 duplicate_name_same_kind_rejected', () => {
  const env = fresh();
  const r = new ConnectorRegistry(env.store);
  r.create({ kind: 'github', name: 'work' });
  assert.throws(
    () => r.create({ kind: 'github', name: 'work' }),
    (e) => e.code === 'duplicate_name'
  );
  // Same name, different kind is fine
  const p = r.create({ kind: 'slack', name: 'work' });
  assert.ok(p.id);
  cleanup(env);
});

test('4 missing_kind_or_name', () => {
  const env = fresh();
  const r = new ConnectorRegistry(env.store);
  assert.throws(() => r.create({}), (e) => e.code === 'bad_kind');
  assert.throws(() => r.create({ kind: 'github' }), (e) => e.code === 'bad_name');
  assert.throws(() => r.create({ kind: 'github', name: '   ' }), (e) => e.code === 'bad_name');
  cleanup(env);
});

test('5 config_and_scopes_round_trip', () => {
  const env = fresh();
  const r = new ConnectorRegistry(env.store);
  const p = r.create({
    kind: 'github',
    name: 'g',
    config: { api_base_url: 'https://ghe.example.com', owner: 'acme' },
    scopes: ['pr:read'],
  });
  assert.deepEqual(r.config(p.id), { api_base_url: 'https://ghe.example.com', owner: 'acme' });
  assert.deepEqual(r.scopes(p.id), ['pr:read']);
  assert.equal(r.hasScope(p.id, 'pr:read'), true);
  assert.equal(r.hasScope(p.id, 'pr:create'), false);
  cleanup(env);
});

test('6 invalid_scope_rejected', () => {
  const env = fresh();
  const r = new ConnectorRegistry(env.store);
  assert.throws(
    () => r.create({ kind: 'github', name: 'g', scopes: ['has spaces'] }),
    (e) => e.code === 'bad_scope'
  );
  cleanup(env);
});

test('7 enable_disable', () => {
  const env = fresh();
  const r = new ConnectorRegistry(env.store);
  const p = r.create({ kind: 'github', name: 'g' });
  assert.equal(r.isActive(p.id), true);
  r.disable(p.id);
  assert.equal(r.isActive(p.id), false);
  r.enable(p.id);
  assert.equal(r.isActive(p.id), true);
  cleanup(env);
});

test('8 revoke_is_soft', () => {
  const env = fresh();
  const r = new ConnectorRegistry(env.store);
  const p = r.create({ kind: 'github', name: 'g' });
  const revoked = r.revoke(p.id);
  assert.ok(revoked.revoked_at);
  assert.equal(revoked.enabled, 0);
  assert.equal(r.isActive(p.id), false);
  // Row still exists
  assert.ok(r.get(p.id));
  cleanup(env);
});

test('9 revoked_profile_cannot_be_updated', () => {
  const env = fresh();
  const r = new ConnectorRegistry(env.store);
  const p = r.create({ kind: 'github', name: 'g' });
  r.revoke(p.id);
  assert.throws(() => r.setScopes(p.id, ['x']), (e) => e.code === 'revoked');
  assert.throws(() => r.updateConfig(p.id, { a: 1 }), (e) => e.code === 'revoked');
  assert.throws(() => r.enable(p.id), (e) => e.code === 'revoked');
  cleanup(env);
});

test('10 attach_and_get_secret_ref', () => {
  const env = fresh();
  const r = new ConnectorRegistry(env.store);
  const p = r.create({ kind: 'github', name: 'g' });
  r.attachSecret(p.id, 'token', 'sec_abc123');
  assert.equal(r.secretRef(p.id, 'token'), 'sec_abc123');
  assert.equal(r.secretRef(p.id, 'missing'), null);
  r.attachSecret(p.id, 'webhook', 'sec_xyz');
  assert.equal(r.secretRef(p.id, 'token'), 'sec_abc123');
  assert.equal(r.secretRef(p.id, 'webhook'), 'sec_xyz');
  cleanup(env);
});

test('11 list_filters', () => {
  const env = fresh();
  const r = new ConnectorRegistry(env.store);
  r.create({ kind: 'github', name: 'g1' });
  r.create({ kind: 'github', name: 'g2' });
  r.create({ kind: 'slack', name: 's1' });
  const p3 = r.create({ kind: 'slack', name: 's2' });
  r.disable(p3.id);

  assert.equal(r.list({}).length, 4);
  assert.equal(r.list({ kind: 'github' }).length, 2);
  assert.equal(r.list({ kind: 'slack', enabled: true }).length, 1);
  assert.equal(r.list({ active: true }).length, 4);

  r.revoke(p3.id);
  assert.equal(r.list({ active: true }).length, 3);
  cleanup(env);
});

test('12 health_summary', () => {
  const env = fresh();
  const r = new ConnectorRegistry(env.store);
  r.create({ kind: 'github', name: 'g1' });
  const p2 = r.create({ kind: 'github', name: 'g2' });
  r.disable(p2.id);
  r.create({ kind: 'slack', name: 's1' });

  const h = r.health();
  assert.equal(h.total, 3);
  assert.equal(h.enabled, 2);
  assert.equal(h.disabled, 1);
  assert.deepEqual(h.by_kind, { github: 2, slack: 1 });
  cleanup(env);
});

test('13 constructor_and_input_validation', () => {
  assert.throws(
    () => new ConnectorRegistry(null),
    (e) => e instanceof ConnectorError && e.code === 'bad_store'
  );
  const env = fresh();
  const r = new ConnectorRegistry(env.store);
  assert.throws(() => r.get(''), (e) => e.code === 'bad_id');
  assert.equal(r.get('nope'), null);
  assert.throws(() => r.create({ kind: 'github', name: 'g', config: 'not-an-object' }),
    (e) => e.code === 'bad_config');
  assert.throws(() => r.create({ kind: 'github', name: 'g2', scopes: 'not-an-array' }),
    (e) => e.code === 'bad_scopes');
  cleanup(env);
});
