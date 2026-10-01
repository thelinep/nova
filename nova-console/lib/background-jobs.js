'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { uid } = require('./exec-log');

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function now() { return new Date().toISOString(); }

function enqueueNeuronTraining(store, blueprintId) {
  const blueprint = store.get('neuronBlueprints', String(blueprintId));
  if (!blueprint) throw error('Unknown neuron blueprint.', 404);
  if (blueprint.status !== 'ready') throw error('Blueprint is not ready for training.', 409);
  if (typeof store.getGlobalHalt === 'function' && store.getGlobalHalt() === '1') throw error('NOVA is halted (Workbench kill switch). Resume it in Workbench before training.', 423);
  const job = { id: uid('job'), type: 'neuron-training', status: 'queued', blueprintId: blueprint.id, kind: blueprint.kind, scale: blueprint.scale, createdAt: now(), startedAt: null, finishedAt: null, cancelRequestedAt: null, progress: { phase: 'queued', percent: 0 }, result: null, error: null };
  blueprint.status = 'queued'; blueprint.updatedAt = now(); blueprint.jobId = job.id;
  store.put('neuronBlueprints', blueprint); store.put('backgroundJobs', job);
  return job;
}

function cancel(store, id) {
  const job = store.get('backgroundJobs', String(id));
  if (!job) throw error('Unknown background job.', 404);
  if (!['queued', 'running'].includes(job.status)) throw error('Only queued or running jobs can be cancelled.', 409);
  job.cancelRequestedAt = now(); job.progress = { phase: 'cancellation-requested', percent: job.progress?.percent || 0 }; store.put('backgroundJobs', job);
  return job;
}

function recoverInterrupted(store) {
  let recovered = 0;
  for (const job of store.all('backgroundJobs')) {
    if (job.status !== 'running') continue;
    job.status = 'interrupted'; job.finishedAt = now(); job.error = 'Runtime restarted before this worker completed.'; job.progress = { phase: 'interrupted', percent: job.progress?.percent || 0 }; store.put('backgroundJobs', job);
    const blueprint = store.get('neuronBlueprints', job.blueprintId);
    if (blueprint?.status === 'queued') { blueprint.status = 'ready'; blueprint.updatedAt = now(); store.put('neuronBlueprints', blueprint); }
    recovered++;
  }
  return recovered;
}

function startNeuronWorker(store, jobId) {
  const job = store.get('backgroundJobs', String(jobId));
  if (!job || job.status !== 'queued') return null;
  if (job.cancelRequestedAt) { job.status = 'cancelled'; job.finishedAt = now(); job.progress = { phase: 'cancelled', percent: 0 }; store.put('backgroundJobs', job); return null; }
  const blueprint = store.get('neuronBlueprints', job.blueprintId);
  if (!blueprint || blueprint.status !== 'queued') { job.status = 'failed'; job.finishedAt = now(); job.error = 'Blueprint state is no longer executable.'; store.put('backgroundJobs', job); return null; }
  job.status = 'running'; job.startedAt = now(); job.progress = { phase: 'training', percent: 5 }; store.put('backgroundJobs', job);
  const worker = new Worker(path.join(__dirname, 'neuron-job-worker.js'), { workerData: { kind: blueprint.kind, spec: blueprint.spec } });
  let settled = false;
  const finish = (message) => {
    if (settled) return; settled = true;
    const current = store.get('backgroundJobs', job.id);
    const latestBlueprint = store.get('neuronBlueprints', job.blueprintId);
    if (!current || !latestBlueprint) return;
    current.finishedAt = now();
    if (current.cancelRequestedAt) { current.status = 'cancelled'; current.progress = { phase: 'cancelled', percent: current.progress?.percent || 5 }; latestBlueprint.status = 'ready'; latestBlueprint.updatedAt = now(); store.put('neuronBlueprints', latestBlueprint); store.put('backgroundJobs', current); return; }
    if (!message?.ok) { current.status = 'failed'; current.error = message?.error || 'Worker exited without a result.'; current.progress = { phase: 'failed', percent: current.progress?.percent || 5 }; latestBlueprint.status = 'ready'; latestBlueprint.updatedAt = now(); store.put('neuronBlueprints', latestBlueprint); store.put('backgroundJobs', current); return; }
    const artifact = { id: uid('neuron_artifact'), blueprintId: latestBlueprint.id, jobId: current.id, kind: latestBlueprint.kind, scale: latestBlueprint.scale, purpose: latestBlueprint.purpose, createdAt: now(), truth: latestBlueprint.truth, config: latestBlueprint.spec.config, lifecycle: 'awaiting-evaluation', ...message.result };
    store.put('neuronArtifacts', artifact);
    latestBlueprint.status = 'trained'; latestBlueprint.updatedAt = artifact.createdAt; latestBlueprint.artifactId = artifact.id; if (latestBlueprint.approval) latestBlueprint.approval.consumedAt = artifact.createdAt;
    current.status = 'completed'; current.progress = { phase: 'completed', percent: 100 }; current.result = { artifactId: artifact.id, metrics: artifact.metrics };
    store.put('neuronBlueprints', latestBlueprint); store.put('backgroundJobs', current);
  };
  worker.once('message', finish);
  worker.once('error', cause => finish({ ok: false, error: cause.message }));
  worker.once('exit', code => { if (code !== 0) finish({ ok: false, error: `Worker exited with code ${code}.` }); });
  return job;
}

module.exports = { enqueueNeuronTraining, startNeuronWorker, cancel, recoverInterrupted };
