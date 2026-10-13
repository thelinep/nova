'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createGuruReadiness } = require('../lib/guru-readiness');

const repoRoot = path.resolve(__dirname, '..', '..');

const blockedTrainerReport = {
  recipe_id: 'qwen25-coder-15b-lora-sft-proposal-v1', training_stack_status: 'blocked',
  blockers: ['python: expected 3.12.4, found 3.12.1'],
  mismatches: ['python: expected 3.12.4, found 3.12.1'],
  lock_sha256: 'e82319be2e0d2bd2a8ec2c95db1762d6f3734ce4147d15dd89e24718f8aee0b2',
  locked_package_count: 37, selected_model_compatibility: 'unverified_without_exact_artifacts',
  model_weights_loaded: false, tokenizer_loaded: false, training_started: false,
};

function runnerForTrainer(result) {
  return (_command, args) => args.includes('trainer-stack-preflight')
    ? result
    : { status: 1, stdout: '{"blockers":["missing admission audit"],"ready":false}', stderr: '' };
}

test('Guru readiness reports live c_rd blockers and checked-in D3 gates without authorizing action', () => {
  const matrix = createGuruReadiness({ repoRoot, run: runnerForTrainer({ status: 1, stdout: JSON.stringify(blockedTrainerReport), stderr: '' }) });
  assert.equal(matrix.schema, 'maataa-guru-readiness-v1');
  assert.equal(matrix.entries.find(entry => entry.id === 'corpus_admission').status, 'blocked');
  assert.deepEqual(matrix.entries.find(entry => entry.id === 'corpus_admission').blockers, ['missing admission audit']);
  assert.equal(matrix.entries.find(entry => entry.id === 'student_model').status, 'unverified');
  assert.match(matrix.entries.find(entry => entry.id === 'student_model').blockers.join(' '), /tokenizer digest is missing/);
  assert.equal(matrix.entries.find(entry => entry.id === 'training_recipe').status, 'blocked');
  assert.equal(matrix.entries.find(entry => entry.id === 'trainer_compatibility').status, 'unverified');
  assert.match(matrix.entries.find(entry => entry.id === 'trainer_compatibility').blockers.join(' '), /loader is not integrated/);
  const environment = matrix.entries.find(entry => entry.id === 'trainer_environment');
  assert.equal(environment.status, 'blocked');
  assert.deepEqual(environment.blockers, ['python: expected 3.12.4, found 3.12.1']);
  assert.match(environment.summary, /37 locked packages/);
  assert.match(environment.summary, /e82319be2e0d2bd2a8ec2c95db1762d6f3734ce4147d15dd89e24718f8aee0b2/);
  assert.match(environment.summary, /compatibility remains unverified/);
  assert.ok(environment.evidence.some(entry => entry.path.endsWith('guru/guru/training_stack_inspector.py')));
  assert.ok(environment.evidence.some(entry => entry.path.endsWith('guru/requirements-test-full.lock')));
  assert.equal(matrix.entries.find(entry => entry.id === 'evaluator').status, 'blocked');
  assert.equal(matrix.entries.find(entry => entry.id === 'compute').status, 'blocked');
  assert.equal(matrix.entries.find(entry => entry.id === 'checkpoint_qualification').status, 'blocked');
  assert.equal(matrix.action.enabled, false);
  assert.ok(matrix.entries.every(entry => entry.evidence.length > 0));
});

test('Guru readiness distinguishes unavailable Python preflight from actual D3 blockers', () => {
  const matrix = createGuruReadiness({ repoRoot, python: 'missing-python-runtime', run: () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }) });
  assert.equal(matrix.entries.find(entry => entry.id === 'corpus_admission').status, 'unavailable');
  assert.equal(matrix.entries.find(entry => entry.id === 'trainer_environment').status, 'unavailable');
  assert.match(matrix.entries.find(entry => entry.id === 'trainer_environment').blockers[0], /not installed/);
  assert.equal(matrix.entries.find(entry => entry.id === 'training_recipe').status, 'blocked');
  assert.equal(matrix.entries.find(entry => entry.id === 'checkpoint_qualification').status, 'blocked');
  assert.equal(matrix.action.enabled, false);
});

test('trainer environment reports a matching pinned stack without claiming model compatibility', () => {
  const report = { ...blockedTrainerReport, training_stack_status: 'metadata_match', blockers: [], mismatches: [] };
  const matrix = createGuruReadiness({ repoRoot, run: runnerForTrainer({ status: 0, stdout: JSON.stringify(report), stderr: '' }) });
  const environment = matrix.entries.find(entry => entry.id === 'trainer_environment');
  assert.equal(environment.status, 'ready');
  assert.deepEqual(environment.blockers, []);
  assert.match(environment.summary, /Stack metadata_match/);
  assert.match(environment.summary, /compatibility remains unverified/);
  assert.equal(matrix.action.enabled, false);
});

test('trainer environment distinguishes preflight timeout', () => {
  const matrix = createGuruReadiness({ repoRoot, run: runnerForTrainer({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }) });
  const environment = matrix.entries.find(entry => entry.id === 'trainer_environment');
  assert.equal(environment.status, 'unavailable');
  assert.match(environment.blockers[0], /timed out/);
});

test('trainer environment reports a missing Guru runtime dependency as unavailable', () => {
  const matrix = createGuruReadiness({ repoRoot, run: runnerForTrainer({
    status: 1, stdout: '', stderr: "ModuleNotFoundError: No module named 'pydantic'",
  }) });
  const environment = matrix.entries.find(entry => entry.id === 'trainer_environment');
  assert.equal(environment.status, 'unavailable');
  assert.match(environment.summary, /required module 'pydantic' is missing/);
  assert.match(environment.blockers[0], /pydantic/);
});

test('trainer environment distinguishes malformed JSON', () => {
  const matrix = createGuruReadiness({ repoRoot, run: runnerForTrainer({ status: 1, stdout: '{not-json', stderr: '' }) });
  const environment = matrix.entries.find(entry => entry.id === 'trainer_environment');
  assert.equal(environment.status, 'unavailable');
  assert.match(environment.blockers[0], /malformed JSON/);
});

test('trainer environment distinguishes unexpected process status', () => {
  const matrix = createGuruReadiness({ repoRoot, run: runnerForTrainer({ status: 2, stdout: JSON.stringify(blockedTrainerReport), stderr: '' }) });
  const environment = matrix.entries.find(entry => entry.id === 'trainer_environment');
  assert.equal(environment.status, 'unavailable');
  assert.match(environment.blockers[0], /unexpectedly with status 2/);
});

test('trainer environment rejects contradictory or incomplete metadata-match reports', () => {
  const invalidReports = [
    { ...blockedTrainerReport, training_stack_status: 'metadata_match', mismatches: [] },
    { ...blockedTrainerReport, training_stack_status: 'metadata_match', blockers: [], mismatches: [], lock_sha256: null },
    { ...blockedTrainerReport, training_stack_status: 'metadata_match', blockers: [], mismatches: [], locked_package_count: 0 },
    { ...blockedTrainerReport, training_stack_status: 'metadata_match', blockers: [], mismatches: ['python drift'] },
    { ...blockedTrainerReport, blockers: [], mismatches: [] },
  ];
  for (const report of invalidReports) {
    const matrix = createGuruReadiness({ repoRoot, run: runnerForTrainer({ status: 0, stdout: JSON.stringify(report), stderr: '' }) });
    const environment = matrix.entries.find(entry => entry.id === 'trainer_environment');
    assert.equal(environment.status, 'unavailable');
    assert.match(environment.blockers[0], /malformed or incomplete JSON/);
    assert.equal(matrix.action.enabled, false);
  }
});

function request(base, route) {
  return new Promise((resolve, reject) => {
    http.get(base + route, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

async function start() {
  const child = spawn(process.execPath, ['--no-warnings', '-e', "const {server}=require('./server'); server.on('listening',()=>process.send(server.address()));"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '0', DATA_DIR: path.join(require('node:os').tmpdir(), `guru-readiness-api-${process.pid}`), OLLAMA_HOST: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const addressPromise = once(child, 'message').then(([value]) => value);
  const address = await Promise.race([addressPromise, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timeout')), 10000);
    child.once('exit', code => reject(new Error(`server exited during startup (${code})`)));
    addressPromise.finally(() => clearTimeout(timer));
  })]);
  return { base: `http://127.0.0.1:${address.port}`, async stop() {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await exited; clearTimeout(timer);
  } };
}

test('GET /api/guru/readiness serves a read-only matrix with evidence and disabled action', { timeout: 30000 }, async () => {
  const app = await start();
  try {
    const response = await request(app.base, '/api/guru/readiness');
    assert.equal(response.status, 200);
    const matrix = JSON.parse(response.body);
    assert.equal(matrix.schema, 'maataa-guru-readiness-v1');
    assert.equal(matrix.action.enabled, false);
    assert.deepEqual(matrix.entries.map(entry => entry.id), [
      'corpus_admission', 'trainer_environment', 'student_model', 'training_recipe', 'trainer_compatibility',
      'evaluator', 'compute', 'checkpoint_qualification',
    ]);
    assert.ok(matrix.entries.every(entry => ['ready', 'blocked', 'unavailable', 'unverified'].includes(entry.status)));
    assert.ok(matrix.entries.every(entry => entry.evidence.length > 0));
  } finally { await app.stop(); }
});
