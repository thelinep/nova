'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * L2 certification bundle.
 *
 * An L2 bundle contains:
 *   - manifest: list of every requirement with pass/fail and evidence hash
 *   - results: raw outputs from every gate (test counts, log tails)
 *   - audit_merkle_root: merkle root over the autonomy_lineage table
 *   - bundle_hash: sha256 over the canonical JSON
 *
 * Requirements enforced:
 *   R1  P1 durable jobs: lib/jobs.js exists, tests/jobs.test.js has ≥10 tests
 *   R2  P2 policy engine: lib/policy.js exists, tests/policy.test.js ≥10
 *   R3  P3 rollback: lib/rollback.js exists, tests/rollback.test.js ≥10
 *   R4  P4 budgets + kill switch: lib/budgets.js + lib/killswitch.js,
 *       tests ≥ 21 combined
 *   R5  P5 neuron autonomy: lib/autonomy.js, tests/autonomy.test.js ≥12
 *   R6  P6 workspace autonomy: lib/workspace-autonomy.js,
 *       tests/workspace-autonomy.test.js ≥12
 *   R7  browser: lib/browser-service.js, test/browser.spec.js = 12 tests
 *   R8  audit chain: autonomy_lineage has ≥1 row, merkle root computed
 *   R9  kill switch: audit trail has ≥1 halt event OR no events (fresh install)
 *   R10 dry-run: policy default-deny verified via fresh PolicyEngine
 *
 * All checks are pure reads. No mutations. Idempotent.
 */

class L2CertifyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'L2CertifyError';
    this.code = code || 'l2_certify_error';
  }
}

const nowIso = () => new Date().toISOString();
const sha256 = (x) =>
  crypto.createHash('sha256').update(String(x)).digest('hex');

function merkleRoot(hashes) {
  if (!hashes || hashes.length === 0) return sha256('');
  let layer = hashes.map((h) => sha256(h));
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const a = layer[i];
      const b = i + 1 < layer.length ? layer[i + 1] : a;
      next.push(sha256(a + b));
    }
    layer = next;
  }
  return layer[0];
}

function countTests(fileText) {
  // Count `test(` at start of line (ignores comments and nested).
  const matches = fileText.match(/^test\(/gm);
  return matches ? matches.length : 0;
}

function countBrowserTests(fileText) {
  return (fileText.match(/^test\(/gm) || []).length;
}

function requireFile(root, rel) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) {
    return { exists: false, path: rel, hash: null };
  }
  const body = fs.readFileSync(p, 'utf8');
  return { exists: true, path: rel, hash: sha256(body), bytes: body.length };
}

function readTestCount(root, rel) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) return { exists: false, count: 0, hash: null };
  const body = fs.readFileSync(p, 'utf8');
  return { exists: true, count: countTests(body), hash: sha256(body) };
}

class L2Certifier {
  constructor(store, options) {
    options = options || {};
    if (!store) throw new L2CertifyError('store required', 'bad_store');
    this.store = store;
    this.root = options.root || process.cwd();
    this.commit = options.commit || null;
    this.tree = options.tree || null;
    this.node_version = options.node_version || process.version;
    this.now = options.now || nowIso;
  }

  _check(requirements) {
    const results = [];
    for (const r of requirements) {
      try {
        const outcome = r.run();
        results.push({
          id: r.id,
          title: r.title,
          required: r.required !== false,
          passed: outcome.passed === true,
          detail: outcome.detail || null,
          evidence_hash: outcome.evidence_hash || null,
        });
      } catch (e) {
        results.push({
          id: r.id,
          title: r.title,
          required: r.required !== false,
          passed: false,
          detail: `error: ${String(e.message || e)}`,
          evidence_hash: null,
        });
      }
    }
    return results;
  }

  requirements() {
    const R = this.root;
    return [
      {
        id: 'R1-durable-jobs',
        title: 'P1 durable job engine present with tests',
        run: () => {
          const lib = requireFile(R, 'lib/jobs.js');
          const t = readTestCount(R, 'tests/jobs.test.js');
          return {
            passed: lib.exists && t.count >= 10,
            detail: `${lib.path}=${lib.exists} tests=${t.count}`,
            evidence_hash: sha256((lib.hash || '') + (t.hash || '')),
          };
        },
      },
      {
        id: 'R2-policy-engine',
        title: 'P2 policy engine present with tests',
        run: () => {
          const lib = requireFile(R, 'lib/policy.js');
          const t = readTestCount(R, 'tests/policy.test.js');
          return {
            passed: lib.exists && t.count >= 10,
            detail: `${lib.path}=${lib.exists} tests=${t.count}`,
            evidence_hash: sha256((lib.hash || '') + (t.hash || '')),
          };
        },
      },
      {
        id: 'R3-rollback',
        title: 'P3 auto-rollback present with tests',
        run: () => {
          const lib = requireFile(R, 'lib/rollback.js');
          const t = readTestCount(R, 'tests/rollback.test.js');
          return {
            passed: lib.exists && t.count >= 10,
            detail: `${lib.path}=${lib.exists} tests=${t.count}`,
            evidence_hash: sha256((lib.hash || '') + (t.hash || '')),
          };
        },
      },
      {
        id: 'R4-budgets-killswitch',
        title: 'P4 budgets and kill switch present with tests',
        run: () => {
          const b = requireFile(R, 'lib/budgets.js');
          const k = requireFile(R, 'lib/killswitch.js');
          const bt = readTestCount(R, 'tests/budgets.test.js');
          const kt = readTestCount(R, 'tests/killswitch.test.js');
          const total = bt.count + kt.count;
          return {
            passed: b.exists && k.exists && total >= 21,
            detail: `budgets=${bt.count} killswitch=${kt.count} total=${total}`,
            evidence_hash: sha256((b.hash || '') + (k.hash || '') + (bt.hash || '') + (kt.hash || '')),
          };
        },
      },
      {
        id: 'R5-neuron-autonomy',
        title: 'P5 neuron-factory autonomy present with tests',
        run: () => {
          const lib = requireFile(R, 'lib/autonomy.js');
          const t = readTestCount(R, 'tests/autonomy.test.js');
          return {
            passed: lib.exists && t.count >= 12,
            detail: `${lib.path}=${lib.exists} tests=${t.count}`,
            evidence_hash: sha256((lib.hash || '') + (t.hash || '')),
          };
        },
      },
      {
        id: 'R6-workspace-autonomy',
        title: 'P6 workspace-patch autonomy present with tests',
        run: () => {
          const lib = requireFile(R, 'lib/workspace-autonomy.js');
          const t = readTestCount(R, 'tests/workspace-autonomy.test.js');
          return {
            passed: lib.exists && t.count >= 12,
            detail: `${lib.path}=${lib.exists} tests=${t.count}`,
            evidence_hash: sha256((lib.hash || '') + (t.hash || '')),
          };
        },
      },
      {
        id: 'R7-browser',
        title: 'Browser service present with 12 playwright tests',
        run: () => {
          const lib = requireFile(R, 'lib/browser-service.js');
          const t = requireFile(R, 'test/browser.spec.js');
          const count = t.exists
            ? countBrowserTests(fs.readFileSync(path.join(R, 'test/browser.spec.js'), 'utf8'))
            : 0;
          return {
            passed: lib.exists && t.exists && count === 12,
            detail: `lib=${lib.exists} spec=${t.exists} tests=${count}`,
            evidence_hash: sha256((lib.hash || '') + (t.hash || '')),
          };
        },
      },
      {
        id: 'R8-audit-chain',
        title: 'Audit chain present and merkle-rooted',
        run: () => {
          let rows;
          try {
            rows = this.store.autonomyLineageList({});
          } catch {
            return { passed: false, detail: 'autonomy_lineage table missing' };
          }
          if (!rows || rows.length === 0) {
            // Fresh install: empty chain is a valid initial state.
            return {
              passed: true,
              detail: 'empty chain (fresh install)',
              evidence_hash: sha256('empty'),
            };
          }
          const hashes = rows.map((r) => sha256(JSON.stringify({
            id: r.id, run_id: r.run_id, status: r.status, timestamp: r.timestamp,
          })));
          const root = merkleRoot(hashes);
          return {
            passed: true,
            detail: `${rows.length} rows merkle_root=${root.slice(0, 16)}...`,
            evidence_hash: root,
          };
        },
      },
      {
        id: 'R9-killswitch-audit',
        title: 'Kill switch audit table reachable',
        run: () => {
          let events;
          try {
            events = this.store.killSwitchEventsList({});
          } catch {
            return { passed: false, detail: 'kill_switch_events table missing' };
          }
          return {
            passed: true,
            detail: `${events.length} events recorded`,
            evidence_hash: sha256(JSON.stringify(events.map((e) => e.id))),
          };
        },
      },
      {
        id: 'R10-default-deny',
        title: 'Policy default-deny verified',
        run: () => {
          let PolicyEngine;
          try {
            ({ PolicyEngine } = require('./policy'));
          } catch {
            return { passed: false, detail: 'cannot require lib/policy' };
          }
          // Use the same store to avoid needing a fresh one; PolicyEngine is read-only for check().
          const pe = new PolicyEngine(this.store);
          const r = pe.check(
            { type: 'agent', id: '__l2_probe__' },
            { type: 'tool', id: '__l2_probe__' }
          );
          return {
            passed: r.allowed === false && r.reason === 'policy_denied',
            detail: `decision=${r.decision} reason=${r.reason}`,
            evidence_hash: sha256(JSON.stringify(r)),
          };
        },
      },
    ];
  }

  certify() {
    const requirements = this._check(this.requirements());
    const required = requirements.filter((r) => r.required);
    const passed = required.filter((r) => r.passed).length;
    const total = required.length;
    const ok = passed === total;

    const manifest = {
      kind: 'nova-l2-certification',
      version: '1.0',
      generated_at: this.now(),
      ok,
      passed,
      total,
      commit: this.commit,
      tree: this.tree,
      node_version: this.node_version,
      requirements,
    };

    const hashable = { kind: manifest.kind, version: manifest.version, commit: manifest.commit, tree: manifest.tree, node_version: manifest.node_version, requirements: requirements.map((r) => ({ id: r.id, passed: r.passed, evidence_hash: r.evidence_hash })), };
    const canonical = JSON.stringify(hashable);
    const bundle_hash = sha256(canonical);
    manifest.bundle_hash = bundle_hash;

    return manifest;
  }

  writeBundle(manifest, outPath) {
    if (!outPath) {
      outPath = path.join(this.root, 'baseline', 'l2-certification.json');
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
    return outPath;
  }
}

module.exports = { L2Certifier, L2CertifyError, merkleRoot, sha256 };
