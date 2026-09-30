'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, Store } = require('../lib/db');
const jobs = require('../lib/background-jobs');
const governance = require('../lib/artifact-governance');
const security = require('../lib/desktop-security');
const release = require('../lib/release-gates');
const connectors = require('../lib/connectors');

function workspace() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-governance-')); const { db } = openDb(dir); return { dir, store: new Store(db), close() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } }; }
function blueprint(id = 'bp') { return { id, status: 'ready', kind: 'tensor', scale: 'micro', purpose: 'Train a bounded quality-gated local tensor artifact.', truth: 'Local artifact.', spec: { config: { inputSize: 1, hiddenSize: 2, outputSize: 1, epochs: 20, learningRate: 0.1, seed: 1 }, examples: [{ input: [0], target: [0] }, { input: [1], target: [1] }] } }; }

test('background training isolates execution and leaves artifacts awaiting quality evaluation', async () => {
  const ws = workspace();
  try {
    ws.store.put('neuronBlueprints', blueprint());
    const queued = jobs.enqueueNeuronTraining(ws.store, 'bp');
    assert.equal(queued.status, 'queued'); assert.equal(ws.store.get('neuronBlueprints', 'bp').status, 'queued');
    jobs.startNeuronWorker(ws.store, queued.id);
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('worker timeout')), 5000); const poll = () => { const current = ws.store.get('backgroundJobs', queued.id); if (current.status === 'completed') { clearTimeout(timer); resolve(); } else setTimeout(poll, 10); }; poll(); });
    const artifact = ws.store.all('neuronArtifacts')[0]; assert.equal(artifact.lifecycle, 'awaiting-evaluation'); assert.equal(ws.store.get('backgroundJobs', queued.id).status, 'completed');
    const evaluated = governance.evaluate(ws.store, artifact.id, { maxFinalLoss: 1 }); assert.equal(evaluated.evaluation.status, 'passed');
    assert.equal(governance.approve(ws.store, artifact.id).lifecycle, 'approved');
  } finally { ws.close(); }
});

test('encrypted secrets expose metadata only and release gate fails closed without all evidence', () => {
  const ws = workspace();
  try {
    const saved = security.putSecret(ws.store, ws.dir, { id: 'github_token', label: 'GitHub token', value: 'secret-value', connectorId: 'github' });
    assert.equal(saved.stored, true); assert.equal(security.secretMetadata(ws.store)[0].id, 'github_token');
    assert.equal(JSON.stringify(ws.store.get('secretRecords', 'github_token')).includes('secret-value'), false);
    assert.equal(security.getSecret(ws.store, ws.dir, 'github_token'), 'secret-value');
    const profile = connectors.saveProfile(ws.store, { id: 'github', provider: 'github', label: 'GitHub production', secretId: 'github_token' });
    assert.equal(profile.hasSecret, true); assert.equal(JSON.stringify(profile).includes('github_token'), false);
    assert.equal(release.check(ws.store).releaseReady, false);
    const evidence = path.join(ws.dir, 'evidence.txt'); fs.writeFileSync(evidence, 'verified');
    for (const kind of release.REQUIRED) release.record(ws.store, { kind, file: evidence, note: 'test evidence' });
    assert.equal(release.check(ws.store).releaseReady, true);
    fs.writeFileSync(evidence, 'changed'); assert.equal(release.check(ws.store).releaseReady, false);
  } finally { ws.close(); }
});
