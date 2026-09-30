'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { L2Certifier, merkleRoot, sha256 } = require('../lib/l2-certify');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-l2-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  return { dir, db, store };
}

function cleanup(env) {
  try { env.db.close(); } catch { /* noop */ }
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch { /* noop */ }
}

test('1 merkle_root_empty', () => {
  assert.equal(merkleRoot([]), sha256(''));
});

test('2 merkle_root_single', () => {
  assert.equal(merkleRoot(['a']), sha256('a'));
  assert.match(merkleRoot(['a']), /^[a-f0-9]{64}$/);
});

test('3 merkle_root_deterministic', () => {
  const r1 = merkleRoot(['a', 'b', 'c', 'd']);
  const r2 = merkleRoot(['a', 'b', 'c', 'd']);
  assert.equal(r1, r2);
});

test('4 merkle_root_changes_with_input', () => {
  const r1 = merkleRoot(['a', 'b']);
  const r2 = merkleRoot(['a', 'c']);
  assert.notEqual(r1, r2);
});

test('5 certifier_ok_on_this_repo', () => {
  const env = fresh();
  const certifier = new L2Certifier(env.store, { root: process.cwd() });
  const manifest = certifier.certify();
  assert.equal(manifest.ok, true, `expected L2 ok, got: ${JSON.stringify(manifest.requirements.filter(r=>!r.passed))}`);
  assert.equal(manifest.kind, 'nova-l2-certification');
  assert.equal(manifest.version, '1.0');
  assert.ok(manifest.passed >= 10);
  assert.match(manifest.bundle_hash, /^[a-f0-9]{64}$/);
  cleanup(env);
});

test('6 bundle_hash_deterministic', () => {
  const env = fresh();
  const certifier = new L2Certifier(env.store, { root: process.cwd(), now: () => '2026-01-01T00:00:00Z' });
  const m1 = certifier.certify();
  const m2 = certifier.certify();
  assert.equal(m1.bundle_hash, m2.bundle_hash);
  cleanup(env);
});

test('7 bundle_hash_changes_when_requirement_fails', () => {
  const env = fresh();
  // Point root at a temp dir with no lib files
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-empty-'));
  const certifier = new L2Certifier(env.store, { root: emptyDir, now: () => '2026-01-01T00:00:00Z' });
  const manifest = certifier.certify();
  assert.equal(manifest.ok, false);
  assert.ok(manifest.passed < manifest.total);
  fs.rmSync(emptyDir, { recursive: true, force: true });
  cleanup(env);
});

test('8 write_bundle_to_disk', () => {
  const env = fresh();
  const certifier = new L2Certifier(env.store, { root: process.cwd() });
  const manifest = certifier.certify();
  const outPath = path.join(env.dir, 'l2.json');
  certifier.writeBundle(manifest, outPath);
  assert.ok(fs.existsSync(outPath));
  const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(parsed.bundle_hash, manifest.bundle_hash);
  assert.ok(Array.isArray(parsed.requirements));
  cleanup(env);
});

test('9 all_requirements_have_evidence_hash', () => {
  const env = fresh();
  const certifier = new L2Certifier(env.store, { root: process.cwd() });
  const manifest = certifier.certify();
  for (const r of manifest.requirements) {
    assert.ok(typeof r.id === 'string' && r.id.length > 0, `requirement ${r.id} missing id`);
    assert.ok(typeof r.passed === 'boolean');
    if (r.passed) {
      assert.ok(r.evidence_hash, `${r.id} passed but no evidence_hash`);
      assert.match(r.evidence_hash, /^[a-f0-9]{64}$/, `${r.id} bad evidence_hash format`);
    }
  }
  cleanup(env);
});

test('10 audit_merkle_root_matches_store', () => {
  const env = fresh();
  // Insert a lineage row
  env.store.auditAppend({
    id: 'lin_test_1',
    action: 'autonomy.lineage',
    run_id: 'run_test_1',
    domain: 'neuron-factory',
    agent_id: 'test',
    status: 'approved',
    timestamp: '2026-01-01T00:00:00Z',
  });

  const certifier = new L2Certifier(env.store, { root: process.cwd() });
  const manifest = certifier.certify();
  const r8 = manifest.requirements.find((r) => r.id === 'R8-audit-chain');
  assert.equal(r8.passed, true);
  assert.match(r8.evidence_hash, /^[a-f0-9]{64}$/);
  cleanup(env);
});

test('11 default_deny_probe_runs', () => {
  const env = fresh();
  const certifier = new L2Certifier(env.store, { root: process.cwd() });
  const manifest = certifier.certify();
  const r10 = manifest.requirements.find((r) => r.id === 'R10-default-deny');
  assert.equal(r10.passed, true);
  cleanup(env);
});

test('12 certifier_requires_store', () => {
  assert.throws(
    () => new L2Certifier(null),
    (e) => e.code === 'bad_store'
  );
});
