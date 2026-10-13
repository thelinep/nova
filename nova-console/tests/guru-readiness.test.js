'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createGuruReadiness } = require('../lib/guru-readiness');

const repoRoot = path.resolve(__dirname, '..', '..');

function fixtureRepoWithStudentIntake({ includeIntake = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-readiness-intake-'));
  const sourceGuru = path.join(repoRoot, 'guru');
  const guruRoot = path.join(root, 'guru');
  fs.mkdirSync(path.join(guruRoot, 'data', 'coding'), { recursive: true });
  fs.mkdirSync(path.join(guruRoot, 'experiments', 'recipes'), { recursive: true });
  for (const relative of [
    'data/coding/model.json',
    'experiments/recipes/qwen25_coder_15b_lora_sft.v1.json',
    'requirements-test-full.lock',
  ]) fs.copyFileSync(path.join(sourceGuru, relative), path.join(guruRoot, relative));
  if (includeIntake) fs.writeFileSync(path.join(guruRoot, 'data/coding/student-base-intake.json'), '{}\n');
  return root;
}

const blockedTrainerReport = {
  recipe_id: 'qwen25-coder-15b-lora-sft-proposal-v1', training_stack_status: 'blocked',
  blockers: ['python: expected 3.12.4, found 3.12.1'],
  mismatches: ['python: expected 3.12.4, found 3.12.1'],
  lock_sha256: 'e82319be2e0d2bd2a8ec2c95db1762d6f3734ce4147d15dd89e24718f8aee0b2',
  locked_package_count: 37, selected_model_compatibility: 'unverified_without_exact_artifacts',
  model_weights_loaded: false, tokenizer_loaded: false, training_started: false,
};

const absentStudentIntakeReport = {
  schema: 'guru-student-intake-binding-v1', status: 'blocked',
  blockers: ['Student-base intake is unavailable: intake or recipe file is unreadable or invalid JSON.'],
  model_loading: false, tokenizer_loading: false, download_started: false, training_started: false,
};

function runnerForTrainer(result, studentReport = absentStudentIntakeReport) {
  return (_command, args) => args.includes('trainer-stack-preflight')
    ? result
    : args.includes('student-intake-preflight')
      ? { status: studentReport.status === 'matched' ? 0 : 1, stdout: JSON.stringify(studentReport), stderr: '' }
      : { status: 1, stdout: '{"blockers":["missing admission audit"],"ready":false}', stderr: '' };
}

test('Guru readiness reports live c_rd blockers and checked-in D3 gates without authorizing action', () => {
  const matrix = createGuruReadiness({ repoRoot, run: runnerForTrainer({ status: 1, stdout: JSON.stringify(blockedTrainerReport), stderr: '' }) });
  assert.equal(matrix.schema, 'maataa-guru-readiness-v1');
  assert.equal(matrix.entries.find(entry => entry.id === 'corpus_admission').status, 'blocked');
  assert.deepEqual(matrix.entries.find(entry => entry.id === 'corpus_admission').blockers, ['missing admission audit']);
  assert.equal(matrix.entries.find(entry => entry.id === 'student_model').status, 'unverified');
  assert.match(matrix.entries.find(entry => entry.id === 'student_model').blockers.join(' '), /tokenizer digest is missing/);
  assert.match(matrix.entries.find(entry => entry.id === 'student_model').blockers.join(' '), /Student-base intake is unavailable/);
  assert.ok(matrix.entries.find(entry => entry.id === 'student_model').evidence.some(entry => entry.path.endsWith('guru/data/coding/student-base-intake.json')));
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

test('student model row blocks a matching pending intake without loading or training', () => {
  const fixtureRoot = fixtureRepoWithStudentIntake();
  const report = {
    ...absentStudentIntakeReport, blockers: [
      'Student-base intake review is not approved.',
      'Student-base weight-use permission is not approved.',
      'Student-base weight-modification permission is not approved.',
    ],
  };
  const matrix = createGuruReadiness({ repoRoot: fixtureRoot, run: runnerForTrainer({ status: 1, stdout: JSON.stringify(blockedTrainerReport), stderr: '' }, report) });
  const student = matrix.entries.find(entry => entry.id === 'student_model');
  assert.equal(student.status, 'unverified');
  assert.match(student.blockers.join(' '), /review is not approved/);
  assert.equal(matrix.action.enabled, false);
  assert.deepEqual([report.model_loading, report.tokenizer_loading, report.download_started, report.training_started], [false, false, false, false]);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test('absent student intake is blocked before Python and remains absent', () => {
  const fixtureRoot = fixtureRepoWithStudentIntake({ includeIntake: false });
  let intakePreflightCalls = 0;
  const baseRunner = runnerForTrainer({ status: 1, stdout: JSON.stringify(blockedTrainerReport), stderr: '' });
  const matrix = createGuruReadiness({ repoRoot: fixtureRoot, run: (command, args, options) => {
    if (args.includes('student-intake-preflight')) intakePreflightCalls += 1;
    return baseRunner(command, args, options);
  } });
  const student = matrix.entries.find(entry => entry.id === 'student_model');
  assert.equal(student.status, 'unverified');
  assert.deepEqual(student.blockers.filter(blocker => blocker.includes('Student-base intake')), [
    'Student-base intake is unavailable: required local record file is absent.',
  ]);
  assert.equal(intakePreflightCalls, 0);
  assert.equal(fs.existsSync(path.join(fixtureRoot, 'guru', 'data', 'coding', 'student-base-intake.json')), false);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test('student model row preserves identity, revision, digest, and permission blockers from intake binding', () => {
  const fixtureRoot = fixtureRepoWithStudentIntake();
  const cases = [
    ['wrong id', ['Intake model id does not match the selected recipe.']],
    ['wrong revision', ['Intake model revision does not match the selected recipe.']],
    ['wrong digest', ['Intake model-weight digest does not match the selected recipe.', 'Intake tokenizer digest does not match the selected recipe.']],
    ['wrong recipe binding', ['Intake recipe digest does not match the selected recipe.']],
    ['insufficient permissions', ['Student-base weight-modification permission is not approved.']],
  ];
  for (const [label, blockers] of cases) {
    const report = { ...absentStudentIntakeReport, blockers };
    const matrix = createGuruReadiness({ repoRoot: fixtureRoot, run: runnerForTrainer({ status: 1, stdout: JSON.stringify(blockedTrainerReport), stderr: '' }, report) });
    const student = matrix.entries.find(entry => entry.id === 'student_model');
    assert.equal(student.status, 'unverified', label);
    for (const blocker of blockers) assert.ok(student.blockers.includes(blocker), `${label}: ${blocker}`);
    assert.equal(matrix.action.enabled, false);
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test('student model row rejects unsafe or contradictory intake preflight reports', () => {
  const fixtureRoot = fixtureRepoWithStudentIntake();
  for (const changes of [
    { download_started: true }, { model_loading: true }, { training_started: true },
    { status: 'matched', blockers: ['still blocked'] },
  ]) {
    const report = { ...absentStudentIntakeReport, status: 'matched', blockers: [], ...changes };
    const matrix = createGuruReadiness({ repoRoot: fixtureRoot, run: runnerForTrainer({ status: 0, stdout: JSON.stringify(blockedTrainerReport), stderr: '' }, report) });
    const student = matrix.entries.find(entry => entry.id === 'student_model');
    assert.equal(student.status, 'unverified');
    assert.match(student.blockers.join(' '), /malformed or incomplete safety evidence|exit status conflicts/);
    assert.equal(matrix.action.enabled, false);
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
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
