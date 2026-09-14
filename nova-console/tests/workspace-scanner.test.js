'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { approveRoot, scanWorkspace, searchWorkspace, createStructuredReport } = require('../lib/workspace-scanner');

function memoryStore() {
  const stores = new Map();
  return {
    get(name, id) { return stores.get(name)?.get(id) || null; },
    put(name, row) { if (!stores.has(name)) stores.set(name, new Map()); stores.get(name).set(row.id, row); return row; },
  };
}

test('approved workspace scan reports languages, dependencies, files and citations', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-workspace-'));
  fs.mkdirSync(path.join(base, 'src'));
  fs.writeFileSync(path.join(base, 'package.json'), '{"dependencies":{"alpha":"1.0.0"}}');
  fs.writeFileSync(path.join(base, 'src', 'main.js'), 'const greeting = "hello NOVA";\n');
  const store = memoryStore();
  const root = approveRoot(store, { path: base, label: 'Fixture' });
  const report = scanWorkspace(store, { rootId: root.id });
  assert.equal(report.readOnly, true);
  assert.equal(report.summary.files, 2);
  assert.deepEqual(report.summary.languages.map(x => x.language).sort(), ['JSON', 'JavaScript']);
  assert.equal(report.summary.dependencyFiles[0].citation, path.join(root.path, 'package.json') + ':1');
  const search = searchWorkspace(store, { rootId: root.id, query: 'hello nova' });
  assert.equal(search.matches[0].citation, path.join(root.path, 'src', 'main.js') + ':1');
  assert.equal(search.matches[0].kind, 'content');
});

test('workspace scanner rejects unapproved roots and does not follow symlinks', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-workspace-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
  fs.symlinkSync(outside, path.join(base, 'linked'));
  const store = memoryStore();
  assert.throws(() => scanWorkspace(store, { rootId: 'missing' }), /approved local root/);
  const root = approveRoot(store, { path: base });
  const report = scanWorkspace(store, { rootId: root.id });
  assert.equal(report.files.length, 0);
  assert.equal(report.skipped.some(item => item.reason === 'symlink'), true);
});

test('structured report runs reusable profiles with timestamp, scope and redacted citations', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-structured-'));
  fs.mkdirSync(path.join(base, 'src'));
  fs.mkdirSync(path.join(base, 'tests'));
  fs.writeFileSync(path.join(base, 'README.md'), '# Fixture\n');
  fs.writeFileSync(path.join(base, 'package.json'), '{"scripts":{"test":"node --test"}}');
  fs.writeFileSync(path.join(base, 'src', 'main.js'), '// TODO: split this module\nconst apiKey = "redacted-example-value";\n');
  fs.writeFileSync(path.join(base, 'src', 'copy.js'), 'same content\n');
  fs.writeFileSync(path.join(base, 'src', 'copy-2.js'), 'same content\n');
  fs.writeFileSync(path.join(base, 'tests', 'main.test.js'), 'test("works", () => {});\n');
  const store = memoryStore();
  const root = approveRoot(store, { path: base });
  const profiles = ['code-health','security-signals','test-status','documentation-gaps','duplicate-files','repository-changes'];
  const report = createStructuredReport(store, { rootId: root.id, profiles });
  assert.equal(report.type, 'workspace-structured');
  assert.equal(report.readOnly, true);
  assert.deepEqual(report.scope.profiles, profiles);
  assert.ok(report.startedAt);
  assert.ok(report.completedAt);
  assert.equal(report.sections.length, 6);
  const security = report.sections.find(section => section.id === 'security-signals');
  assert.equal(security.findings.length, 1);
  assert.equal(JSON.stringify(security).includes('redacted-example-value'), false);
  assert.match(security.findings[0].citation, /main\.js:2$/);
  assert.equal(report.sections.find(section => section.id === 'duplicate-files').groups.length, 1);
  assert.equal(report.sections.find(section => section.id === 'test-status').status, 'configured');
});
