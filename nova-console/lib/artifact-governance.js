'use strict';

const { uid } = require('./exec-log');
function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function now() { return new Date().toISOString(); }

function evaluate(store, artifactId, input = {}) {
  const artifact = store.get('neuronArtifacts', String(artifactId));
  if (!artifact) throw error('Unknown neuron artifact.', 404);
  if (artifact.lifecycle === 'approved') throw error('Approved artifacts are immutable.', 409);
  const maximum = Number(input.maxFinalLoss ?? (artifact.kind === 'qubit' ? 0.05 : 0.08));
  if (!Number.isFinite(maximum) || maximum <= 0 || maximum > 1) throw error('maxFinalLoss must be greater than 0 and at most 1.');
  const finalLoss = Number(artifact.metrics?.finalLoss);
  const passed = Number.isFinite(finalLoss) && finalLoss <= maximum;
  const evaluation = { id: uid('artifact_eval'), artifactId: artifact.id, kind: artifact.kind, status: passed ? 'passed' : 'failed', criterion: { metric: 'finalLoss', maximum }, measured: { finalLoss, engine: artifact.engine, epochs: artifact.metrics?.epochs ?? null }, evaluatedAt: now() };
  artifact.lifecycle = passed ? 'awaiting-approval' : 'evaluation-failed'; artifact.lastEvaluationId = evaluation.id; artifact.updatedAt = evaluation.evaluatedAt;
  store.put('artifactEvaluations', evaluation); store.put('neuronArtifacts', artifact);
  return { artifact, evaluation };
}

function approve(store, artifactId) {
  const artifact = store.get('neuronArtifacts', String(artifactId));
  if (!artifact) throw error('Unknown neuron artifact.', 404);
  const evaluation = artifact.lastEvaluationId && store.get('artifactEvaluations', artifact.lastEvaluationId);
  if (artifact.lifecycle !== 'awaiting-approval' || !evaluation || evaluation.status !== 'passed') throw error('A passing, current evaluation is required before artifact approval.', 409);
  artifact.lifecycle = 'approved'; artifact.approval = { id: uid('artifact_approval'), approvedAt: now(), evaluationId: evaluation.id, criterion: evaluation.criterion }; artifact.updatedAt = artifact.approval.approvedAt;
  store.put('neuronArtifacts', artifact); return artifact;
}

module.exports = { evaluate, approve };
