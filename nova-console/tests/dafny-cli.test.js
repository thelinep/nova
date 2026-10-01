'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DafnyCliError, createDafnyVerifier, parseDafnyJson } = require('../lib/dafny-cli');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nova-dafny-cli-'));
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}

function fakeBinary(dir, opts) {
  opts = opts || {};
  const stdout = opts.stdout || '';
  const stderr = opts.stderr || '';
  const exitCode = opts.exitCode == null ? 0 : opts.exitCode;
  const sleepMs = opts.sleepMs || 0;
  const captureFileTo = opts.captureFileTo || null;

  const src = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const stdout = ${JSON.stringify(stdout)};
const stderr = ${JSON.stringify(stderr)};
const code = ${exitCode};
const sleepMs = ${sleepMs};
const captureFileTo = ${JSON.stringify(captureFileTo)};
if (captureFileTo) {
  const file = argv.find((a) => a.endsWith('.dfy'));
  if (file) { try { fs.copyFileSync(file, captureFileTo); } catch {} }
}
function emit() {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}
if (sleepMs > 0) setTimeout(emit, sleepMs); else emit();
`;
  const p = path.join(dir, 'fake-dafny-' + Math.random().toString(36).slice(2) + '.js');
  fs.writeFileSync(p, src, 'utf8');
  fs.chmodSync(p, 0o755);
  return p;
}

test('1 success_exit_0', async () => {
  const dir = tempDir();
  const fake = fakeBinary(dir, { stdout: '{"verified":true}\n', exitCode: 0 });
  const dafny = createDafnyVerifier({ bin: fake, tmpDir: dir });
  const r = await dafny({ code: 'method A() { }', spec: 'requires true' });
  assert.equal(r.verified, true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.exit_code, 0);
  cleanup(dir);
});

test('2 failure_exit_1_with_json', async () => {
  const dir = tempDir();
  const fake = fakeBinary(dir, {
    stdout: '{"outcome":"failed","message":"assertion may not hold"}\n',
    exitCode: 1,
  });
  const dafny = createDafnyVerifier({ bin: fake, tmpDir: dir });
  const r = await dafny({ code: 'method A() { }', spec: 'requires true' });
  assert.equal(r.verified, false);
  assert.deepEqual(r.errors, ['assertion may not hold']);
  cleanup(dir);
});

test('3 failure_exit_1_no_json', async () => {
  const dir = tempDir();
  const fake = fakeBinary(dir, { stdout: 'boom\n', exitCode: 1 });
  const dafny = createDafnyVerifier({ bin: fake, tmpDir: dir });
  const r = await dafny({ code: 'method A() { }', spec: 'requires true' });
  assert.equal(r.verified, false);
  assert.ok(r.errors.some((e) => /boom/.test(e)), 'expected "boom" in errors, got ' + JSON.stringify(r.errors));
  cleanup(dir);
});

test('4 timeout_kills_process', async () => {
  const dir = tempDir();
  const fake = fakeBinary(dir, { stdout: '', exitCode: 0, sleepMs: 5000 });
  const dafny = createDafnyVerifier({ bin: fake, tmpDir: dir, timeoutMs: 200 });
  const t0 = Date.now();
  const r = await dafny({ code: 'method A() { }', spec: 'requires true' });
  const elapsed = Date.now() - t0;
  assert.equal(r.verified, false);
  assert.equal(r.exit_code, null);
  assert.ok(r.errors.includes('dafny_timeout'));
  assert.ok(elapsed < 3000, 'expected wallclock < 3000ms, got ' + elapsed);
  cleanup(dir);
});

test('5 binary_not_found', async () => {
  const dir = tempDir();
  const dafny = createDafnyVerifier({ bin: '/nonexistent/dafny-xyz', tmpDir: dir });
  await assert.rejects(
    () => dafny({ code: 'method A() { }', spec: 'requires true' }),
    (e) => e instanceof DafnyCliError && e.code === 'spawn_failed'
  );
  cleanup(dir);
});

test('6 composed_source_written', async () => {
  const dir = tempDir();
  const captured = path.join(dir, 'captured.dfy');
  const fake = fakeBinary(dir, { stdout: '{"verified":true}\n', exitCode: 0, captureFileTo: captured });
  const dafny = createDafnyVerifier({ bin: fake, tmpDir: dir });
  await dafny({
    code: 'method Add(x: int) returns (y: int) { y := x + 1; }',
    spec: 'method Add requires x > 0 ensures y > x',
    annotations: ['ghost var witness := x;'],
  });
  const written = fs.readFileSync(captured, 'utf8');
  const specIdx = written.indexOf('requires x > 0');
  const annIdx = written.indexOf('ghost var witness');
  const codeIdx = written.indexOf('y := x + 1;');
  assert.ok(specIdx >= 0, 'spec should be present');
  assert.ok(annIdx > specIdx, 'annotations after spec');
  assert.ok(codeIdx > annIdx, 'code after annotations');
  cleanup(dir);
});

test('7 parse_single_json_object', () => {
  const r = parseDafnyJson('{"verified":true}');
  assert.equal(r.verified, true);
  assert.deepEqual(r.errors, []);
});

test('8 parse_json_lines', () => {
  const src = [
    '{"event":"start"}',
    '{"event":"progress"}',
    '{"outcome":"failed","message":"x"}',
  ].join('\n');
  const r = parseDafnyJson(src);
  assert.equal(r.verified, false);
  assert.deepEqual(r.errors, ['x']);
});

test('9 parse_garbage_returns_null_verified', () => {
  const r = parseDafnyJson('not json at all');
  assert.equal(r.verified, null);
  assert.deepEqual(r.errors, []);
});

test('10 temp_file_removed_on_success', async () => {
  const dir = tempDir();
  const fake = fakeBinary(dir, { stdout: '{"verified":true}\n', exitCode: 0 });
  const dafny = createDafnyVerifier({ bin: fake, tmpDir: dir });
  await dafny({ code: 'method A() { }', spec: 'requires true' });
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.dfy'));
  assert.deepEqual(leftovers, []);
  cleanup(dir);
});

test('11 temp_file_removed_on_failure', async () => {
  const dir = tempDir();
  const fake = fakeBinary(dir, { stdout: 'boom\n', exitCode: 1 });
  const dafny = createDafnyVerifier({ bin: fake, tmpDir: dir });
  await dafny({ code: 'method A() { }', spec: 'requires true' });
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.dfy'));
  assert.deepEqual(leftovers, []);
  cleanup(dir);
});

test('12 stderr_and_stdout_captured', async () => {
  const dir = tempDir();
  const fake = fakeBinary(dir, {
    stdout: 'STDOUT-MARKER\n',
    stderr: 'STDERR-MARKER\n',
    exitCode: 1,
  });
  const dafny = createDafnyVerifier({ bin: fake, tmpDir: dir });
  const r = await dafny({ code: 'method A() { }', spec: 'requires true' });
  assert.ok(r.raw_stdout.includes('STDOUT-MARKER'));
  assert.ok(r.raw_stderr.includes('STDERR-MARKER'));
  cleanup(dir);
});
