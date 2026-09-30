'use strict';

/**
 * CLI: verify L2 certification.
 *
 * Usage: node scripts/l2-check.js [--out path/to/bundle.json]
 *
 * Exits 0 if certified, 1 otherwise. Prints a per-requirement report.
 */

const path = require('node:path');
const { execSync } = require('node:child_process');
const { openDb, Store } = require('../lib/db');
const { L2Certifier } = require('../lib/l2-certify');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = argv[++i];
  }
  return out;
}

function getGitInfo() {
  try {
    const commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    const tree = execSync('git rev-parse HEAD^{tree}', { encoding: 'utf8' }).trim();
    return { commit, tree };
  } catch {
    return { commit: null, tree: null };
  }
}

function main() {
  const args = parseArgs(process.argv);
  const root = path.resolve(__dirname, '..');
  const dataDir = path.join(root, '.l2-check-data');
  require('node:fs').mkdirSync(dataDir, { recursive: true });

  const { db } = openDb(dataDir);
  const store = new Store(db);
  const git = getGitInfo();

  const certifier = new L2Certifier(store, {
    root,
    commit: git.commit,
    tree: git.tree,
  });

  const manifest = certifier.certify();
  const outPath = certifier.writeBundle(manifest, args.out);

  for (const r of manifest.requirements) {
    const mark = r.passed ? '✔' : '✖';
    const tag = r.required ? '' : ' (optional)';
    console.log(`${mark} ${r.id}${tag}  ${r.title}`);
    if (r.detail) console.log(`    ${r.detail}`);
  }

  console.log('');
  console.log(`passed: ${manifest.passed}/${manifest.total}`);
  console.log(`bundle_hash: ${manifest.bundle_hash}`);
  console.log(`written:     ${outPath}`);
  console.log(`commit:      ${manifest.commit || 'unknown'}`);

  try { db.close(); } catch { /* noop */ }
  try { require('node:fs').rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ }

  process.exit(manifest.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { main };
