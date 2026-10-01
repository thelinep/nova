'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { SecretVault, SecretError, SecretNotFoundError, SecretRevokedError, SecretDecryptError, loadMasterKey } = require('../lib/secrets');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-sec-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  return { dir, db, store };
}
function cleanup(env) {
  try { env.db.close(); } catch {}
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch {}
}

test('1 put_returns_metadata_only', () => {
  const env = fresh();
  const v = new SecretVault(env.store, { dataDir: env.dir });
  const m = v.put({ name: 'gh-token', kind: 'github-token', value: 'ghp_secret_123', createdBy: 'alice' });
  assert.ok(m.id.startsWith('sec_'));
  assert.equal(m.name, 'gh-token');
  assert.equal(m.kind, 'github-token');
  assert.equal(m.created_by, 'alice');
  assert.equal(m.active, true);
  assert.equal(m.value, undefined);
  cleanup(env);
});

test('2 get_returns_metadata_only', () => {
  const env = fresh();
  const v = new SecretVault(env.store, { dataDir: env.dir });
  const p = v.put({ name: 'n', kind: 'github-token', value: 'x' });
  const m = v.get(p.id);
  assert.equal(m.id, p.id);
  assert.equal(m.value, undefined);
  assert.equal(m.ciphertext_b64, undefined);
  cleanup(env);
});

test('3 list_returns_metadata_only', () => {
  const env = fresh();
  const v = new SecretVault(env.store, { dataDir: env.dir });
  v.put({ name: 'a', kind: 'github-token', value: '1' });
  v.put({ name: 'b', kind: 'slack-token', value: '2' });
  const rows = v.list();
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.value, undefined);
    assert.equal(r.ciphertext_b64, undefined);
  }
  cleanup(env);
});

test('4 plaintext_not_stored_at_rest', () => {
  const env = fresh();
  const v = new SecretVault(env.store, { dataDir: env.dir });
  const secret = 'ghp_SHOULD_NOT_APPEAR_IN_DB_12345';
  v.put({ name: 'x', kind: 'github-token', value: secret });
  const row = env.store.secretRecordsGet(v.list()[0].id);
  assert.ok(!row.ciphertext_b64.includes(secret), 'plaintext leaked into ciphertext');
  assert.ok(!row.iv_b64.includes(secret));
  assert.ok(!row.tag_b64.includes(secret));
  cleanup(env);
});

test('5 use_decrypts_and_invokes', async () => {
  const env = fresh();
  const v = new SecretVault(env.store, { dataDir: env.dir });
  const p = v.put({ name: 'n', kind: 'github-token', value: 'ghp_real' });
  let seen = null;
  const out = await v.use(p.id, (value) => { seen = value; return 'ok'; });
  assert.equal(seen, 'ghp_real');
  assert.equal(out, 'ok');
  cleanup(env);
});

test('6 use_returns_null_never_plaintext', async () => {
  const env = fresh();
  const v = new SecretVault(env.store, { dataDir: env.dir });
  const p = v.put({ name: 'n', kind: 'github-token', value: 'ghp_real' });
  const out = await v.use(p.id, () => undefined);
  assert.equal(out, undefined);
  cleanup(env);
});

test('7 use_on_missing_throws_not_found', async () => {
  const env = fresh();
  const v = new SecretVault(env.store, { dataDir: env.dir });
  await assert.rejects(
    () => v.use('nope', () => 'x'),
    (e) => e instanceof SecretNotFoundError
  );
  cleanup(env);
});

test('8 use_on_revoked_throws_revoked', async () => {
  const env = fresh();
  const v = new SecretVault(env.store, { dataDir: env.dir });
  const p = v.put({ name: 'n', kind: 'github-token', value: 'x' });
  v.revoke(p.id, 'alice');
  await assert.rejects(
    () => v.use(p.id, () => 'x'),
    (e) => e instanceof SecretRevokedError
  );
  cleanup(env);
});

test('9 rotate_replaces_value', async () => {
  const env = fresh();
  const v = new SecretVault(env.store, { dataDir: env.dir });
  const p = v.put({ name: 'n', kind: 'github-token', value: 'old' });
  await v.use(p.id, (val) => { assert.equal(val, 'old'); });
  v.rotate(p.id, 'new', 'bob');
  await v.use(p.id, (val) => { assert.equal(val, 'new'); });
  const m = v.get(p.id);
  assert.ok(m.rotated_at);
  cleanup(env);
});

test('10 rotate_preserves_name_and_kind', () => {
  const env = fresh();
  const v = new SecretVault(env.store, { dataDir: env.dir });
  const p = v.put({ name: 'keep-me', kind: 'github-token', value: 'a' });
  const rotated = v.rotate(p.id, 'b');
  assert.equal(rotated.name, 'keep-me');
  assert.equal(rotated.kind, 'github-token');
  cleanup(env);
});

test('11 revoke_marks_and_filters', () => {
  const env = fresh();
  const v = new SecretVault(env.store, { dataDir: env.dir });
  const p = v.put({ name: 'n', kind: 'k', value: 'x' });
  v.revoke(p.id, 'op');
  assert.equal(v.list().length, 1);
  assert.equal(v.list({ active: true }).length, 0);
  const m = v.get(p.id);
  assert.ok(m.revoked_at);
  assert.equal(m.active, false);
  cleanup(env);
});

test('12 wrong_master_key_fails_decrypt', async () => {
  const env = fresh();
  const v1 = new SecretVault(env.store, { dataDir: env.dir });
  const p = v1.put({ name: 'n', kind: 'github-token', value: 'x' });

  // Corrupt the ciphertext (simulates wrong key at a lower level)
  const row = env.store.secretRecordsGet(p.id);
  const bad = Object.assign({}, row, { ciphertext_b64: Buffer.from('garbage').toString('base64') });
  env.store.secretRecordsUpdate(p.id, {
    ciphertext_b64: bad.ciphertext_b64,
    iv_b64: bad.iv_b64,
    tag_b64: bad.tag_b64,
  });

  await assert.rejects(
    () => v1.use(p.id, () => 'x'),
    (e) => e instanceof SecretDecryptError
  );
  cleanup(env);
});

test('13 audit_written_on_use', async () => {
  const env = fresh();
  const events = [];
  const v = new SecretVault(env.store, {
    dataDir: env.dir,
    audit: (e) => events.push(e),
  });
  const p = v.put({ name: 'n', kind: 'github-token', value: 'x' });
  await v.use(p.id, () => 'ok', 'alice');
  const used = events.filter((e) => e.action === 'secret.used');
  assert.equal(used.length, 1);
  assert.equal(used[0].secret_id, p.id);
  assert.equal(used[0].operator, 'alice');
  cleanup(env);
});

test('14 constructor_and_input_validation', () => {
  assert.throws(() => new SecretVault(null, { dataDir: '/tmp' }),
    (e) => e instanceof SecretError && e.code === 'bad_store');
  const env = fresh();
  assert.throws(() => new SecretVault(env.store, {}),
    (e) => e instanceof SecretError && e.code === 'bad_data_dir');
  const v = new SecretVault(env.store, { dataDir: env.dir });
  assert.throws(() => v.put({}), (e) => e.code === 'bad_name');
  assert.throws(() => v.put({ name: 'n' }), (e) => e.code === 'bad_kind');
  assert.throws(() => v.put({ name: 'n', kind: 'k' }), (e) => e.code === 'bad_value');
  assert.throws(() => v.put({ name: 'n', kind: 'k', value: '' }), (e) => e.code === 'bad_value');
  cleanup(env);
});
