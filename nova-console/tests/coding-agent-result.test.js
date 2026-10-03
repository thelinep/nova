'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA, VERSION, LIMITS, CodingAgentResultError,
  parseCodingAgentResult, toWorkspaceBatchInput,
} = require('../lib/coding-agent-result');

function changeSet(changes, extra) {
  return {
    schema: SCHEMA,
    version: VERSION,
    summary: 'Fix the application setting',
    changes: changes || [{ operation: 'edit', relativePath: 'src/app.js', find: 'false', replacement: 'true' }],
    ...(extra || {}),
  };
}

function assertContractError(fn, code) {
  assert.throws(fn, error => {
    assert.ok(error instanceof CodingAgentResultError);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

test('accepts a strict JSON change set and maps operations to workspace batch input', () => {
  const raw = JSON.stringify(changeSet([
    { operation: 'edit', relativePath: 'src/app.js', find: 'false', replacement: 'true', impact: 'Enable feature' },
    { operation: 'create', relativePath: 'src/new.js', content: 'module.exports = 1;\n', dependsOn: ['src/app.js'] },
    { operation: 'rename', relativePath: 'src/old.js', toPath: 'src/new-name.js' },
  ]));
  const parsed = parseCodingAgentResult(raw);
  assert.equal(parsed.schema, SCHEMA);
  assert.equal(parsed.version, 1);
  const input = toWorkspaceBatchInput(parsed, 'root_abc');
  assert.deepEqual(input, {
    rootId: 'root_abc',
    summary: 'Fix the application setting',
    changes: parsed.changes,
  });
});
test('accepts overwrite and delete using only fields supported by workspace batches', () => {
  const parsed = parseCodingAgentResult(changeSet([
    { operation: 'overwrite', relativePath: 'config/app.json', content: '{"enabled":true}\n' },
    { operation: 'delete', relativePath: 'tmp/obsolete.txt' },
  ]));
  assert.deepEqual(parsed.changes.map(change => change.operation), ['overwrite', 'delete']);
});

test('rejects plain text, fenced JSON, and JSON surrounded by prose', () => {
  const valid = JSON.stringify(changeSet());
  assertContractError(() => parseCodingAgentResult('Here is the change: ' + valid), 'invalid_json');
  assertContractError(() => parseCodingAgentResult('```json\n' + valid + '\n```'), 'invalid_json');
  assertContractError(() => parseCodingAgentResult('I would update src/app.js.'), 'invalid_json');
});

test('requires the exact object schema, version, and top-level fields', () => {
  assertContractError(() => parseCodingAgentResult({ output: 'patch' }), 'unknown_field');
  assertContractError(() => parseCodingAgentResult({ ...changeSet(), schema: 'other.schema' }), 'bad_schema');
  assertContractError(() => parseCodingAgentResult({ ...changeSet(), version: 2 }), 'bad_version');
  assertContractError(() => parseCodingAgentResult({ ...changeSet(), surprise: true }), 'unknown_field');
  assertContractError(() => parseCodingAgentResult({ ...changeSet(), changes: 'edit this file' }), 'bad_changes');
  assertContractError(() => parseCodingAgentResult('[]'), 'bad_result');
});

test('rejects unknown fields and malformed per-operation shapes', () => {
  assertContractError(() => parseCodingAgentResult(changeSet([
    { operation: 'edit', relativePath: 'src/app.js', find: 'x', replacement: 'y', shell: 'rm -rf' },
  ])), 'unknown_field');
  assertContractError(() => parseCodingAgentResult(changeSet([
    { operation: 'edit', relativePath: 'src/app.js', find: '', replacement: 'y' },
  ])), 'empty_field');
  assertContractError(() => parseCodingAgentResult(changeSet([
    { operation: 'create', relativePath: 'src/new.js' },
  ])), 'bad_field_type');
  assertContractError(() => parseCodingAgentResult(changeSet([
    { operation: 'rename', relativePath: 'src/a.js', toPath: 'src/b.js', content: 'ignored' },
  ])), 'unknown_field');
  assertContractError(() => parseCodingAgentResult(changeSet([
    { operation: 'chmod', relativePath: 'src/app.js' },
  ])), 'bad_operation');
});

test('rejects paths that are absolute, escaping, ambiguous, protected, or non-portable', () => {
  for (const relativePath of ['/etc/passwd', '../outside.js', 'src/../../outside.js', './src/app.js', 'src//app.js', 'C:/temp/a.js', 'src\\app.js', '.git/config', 'vendor/node_modules/pkg.js']) {
    assertContractError(() => parseCodingAgentResult(changeSet([
      { operation: 'delete', relativePath },
    ])), 'unsafe_path');
  }
  assertContractError(() => parseCodingAgentResult(changeSet([
    { operation: 'rename', relativePath: 'src/a.js', toPath: 'src/a.js' },
  ])), 'bad_change');
});

test('rejects overlapping paths across changes and rename endpoints', () => {
  assertContractError(() => parseCodingAgentResult(changeSet([
    { operation: 'delete', relativePath: 'src/a.js' },
    { operation: 'create', relativePath: 'src/a.js', content: 'x' },
  ])), 'duplicate_path');
  assertContractError(() => parseCodingAgentResult(changeSet([
    { operation: 'rename', relativePath: 'src/a.js', toPath: 'src/b.js' },
    { operation: 'create', relativePath: 'src/b.js', content: 'x' },
  ])), 'duplicate_path');
});

test('enforces operation count, UTF-8 byte limits, dependencies and root id', () => {
  assertContractError(() => parseCodingAgentResult(changeSet([])), 'bad_changes');
  assertContractError(() => parseCodingAgentResult(changeSet(Array.from({ length: LIMITS.changes + 1 }, (_, i) => ({ operation: 'delete', relativePath: `file-${i}.txt` })))), 'bad_changes');
  assertContractError(() => parseCodingAgentResult(changeSet([{ operation: 'create', relativePath: 'src/a.js', content: 'é'.repeat(Math.floor(LIMITS.contentBytes / 2) + 1) }])), 'size_limit');
  assertContractError(() => parseCodingAgentResult(JSON.stringify(changeSet()).padEnd(LIMITS.outputBytes + 1, ' ')), 'size_limit');
  assertContractError(() => parseCodingAgentResult(changeSet([{ operation: 'create', relativePath: 'src/a.js', content: 'x', dependsOn: 'src/b.js' }])), 'bad_dependencies');
  assertContractError(() => toWorkspaceBatchInput(changeSet(), ' '), 'bad_root_id');
});
