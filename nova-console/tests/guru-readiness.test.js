'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createGuruReadiness } = require('../lib/guru-readiness');

const repoRoot = path.resolve(__dirname, '..', '..');

test('Guru readiness reports live c_rd blockers and checked-in D3 gates without authorizing action', () => {
  const matrix = createGuruReadiness({ repoRoot, run: () => ({ status: 1, stdout: '{"blockers":["missing admission audit"],"ready":false}', stderr: '' }) });
  assert.equal(matrix.schema, 'maataa-guru-readiness-v1');
  assert.equal(matrix.entries.find(entry => entry.id === 'corpus_admission').status, 'blocked');
  assert.deepEqual(matrix.entries.find(entry => entry.id === 'corpus_admission').blockers, ['missing admission audit']);
  assert.equal(matrix.entries.find(entry => entry.id === 'student_model').status, 'unverified');
  assert.match(matrix.entries.find(entry => entry.id === 'student_model').blockers.join(' '), /tokenizer digest is missing/);
  assert.equal(matrix.entries.find(entry => entry.id === 'training_recipe').status, 'blocked');
  assert.equal(matrix.entries.find(entry => entry.id === 'evaluator').status, 'blocked');
  assert.equal(matrix.entries.find(entry => entry.id === 'compute').status, 'blocked');
  assert.equal(matrix.entries.find(entry => entry.id === 'checkpoint_qualification').status, 'blocked');
  assert.equal(matrix.action.enabled, false);
  assert.ok(matrix.entries.every(entry => entry.evidence.length > 0));
});

test('Guru readiness distinguishes unavailable Python preflight from actual D3 blockers', () => {
  const matrix = createGuruReadiness({ repoRoot, python: 'missing-python-runtime', run: () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }) });
  assert.equal(matrix.entries.find(entry => entry.id === 'corpus_admission').status, 'unavailable');
  assert.equal(matrix.entries.find(entry => entry.id === 'training_recipe').status, 'blocked');
  assert.equal(matrix.entries.find(entry => entry.id === 'checkpoint_qualification').status, 'blocked');
  assert.equal(matrix.action.enabled, false);
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
      'corpus_admission', 'student_model', 'training_recipe', 'evaluator', 'compute', 'checkpoint_qualification',
    ]);
    assert.ok(matrix.entries.every(entry => ['ready', 'blocked', 'unavailable', 'unverified'].includes(entry.status)));
    assert.ok(matrix.entries.every(entry => entry.evidence.length > 0));
  } finally { await app.stop(); }
});
