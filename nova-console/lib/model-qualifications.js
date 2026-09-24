'use strict';

const crypto = require('node:crypto');

const MIN_TRIALS = 3;
const CAPABILITIES = ['single-file', 'multi-file', 'large-context', 'clarification', 'timeout', 'cancellation'];
const FIXTURE_CAPABILITY = {
  'single-file': 'single-file',
  'multi-file': 'multi-file',
  'large-repository': 'large-context',
  clarification: 'clarification',
  ambiguous: 'clarification',
  timeout: 'timeout',
  cancellation: 'cancellation',
};

function error(message, statusCode = 412) { return Object.assign(new Error(message), { statusCode }); }
function idFor(digest) { return 'model_qualification_' + crypto.createHash('sha256').update(String(digest)).digest('hex').slice(0, 20); }
function capabilityForFixture(fixture) { return FIXTURE_CAPABILITY[fixture] || fixture; }

function recordResult(store, input) {
  const digest = String(input.digest || '').trim();
  const capability = capabilityForFixture(input.capability || input.fixture);
  if (!digest) throw error('A model digest is required.', 400);
  if (!CAPABILITIES.includes(capability)) throw error('Unknown model qualification capability: ' + capability, 400);
  const id = idFor(digest);
  const now = input.completedAt || new Date().toISOString();
  const record = store.get('modelQualifications', id) || {
    id, type: 'model-qualification', modelId: input.modelId || input.model || null,
    digest, modelCapabilities: input.modelCapabilities || [], requiredTrials: MIN_TRIALS,
    createdAt: now, updatedAt: now, capabilities: {}, runs: [],
  };
  record.modelId = input.modelId || input.model || record.modelId;
  record.modelCapabilities = input.modelCapabilities || record.modelCapabilities;
  record.updatedAt = now;
  record.runs.push({
    id: input.runId || crypto.randomUUID(), capability, trial: Number(input.trial) || null,
    status: input.status === 'passed' ? 'passed' : 'failed', startedAt: input.startedAt || null,
    completedAt: now, error: input.error || null, evidencePath: input.evidencePath || null,
  });
  record.runs = record.runs.slice(-300);
  const relevant = record.runs.filter(run => run.capability === capability);
  const passes = relevant.filter(run => run.status === 'passed').length;
  const failures = relevant.length - passes;
  record.capabilities[capability] = {
    capability, trials: relevant.length, passes, failures,
    qualified: relevant.length >= MIN_TRIALS && failures === 0,
    lastCheckedAt: now,
  };
  store.put('modelQualifications', record);
  return record;
}

function getByDigest(store, digest) { return store.get('modelQualifications', idFor(digest)); }
function isQualified(store, digest, capability) { return Boolean(getByDigest(store, digest)?.capabilities?.[capability]?.qualified); }

function assertQualified(store, digest, capability) {
  const record = getByDigest(store, digest);
  const result = record?.capabilities?.[capability];
  if (!result?.qualified) {
    const observed = result ? `${result.passes}/${result.trials} passing trials` : 'no recorded trials';
    throw error(`Model digest ${digest} is not qualified for ${capability}: ${observed}; ${MIN_TRIALS} consistent passing trials are required.`);
  }
  return result;
}

function selectModel(store, models, capability, preferredName = 'llama3:latest') {
  const qualified = models.filter(model => model.digest && isQualified(store, model.digest, capability));
  const selected = qualified.find(model => model.id === preferredName || model.name === preferredName) || qualified[0];
  if (!selected) throw error(`No installed model is qualified for ${capability}. Run the repeatability qualification suite.`);
  return { model: selected, qualification: getByDigest(store, selected.digest)?.capabilities?.[capability] };
}

function summary(store, digest) {
  const record = getByDigest(store, digest);
  return {
    digest,
    qualified: CAPABILITIES.filter(capability => record?.capabilities?.[capability]?.qualified),
    blocked: CAPABILITIES.filter(capability => !record?.capabilities?.[capability]?.qualified),
    results: record?.capabilities || {}, requiredTrials: MIN_TRIALS,
  };
}

module.exports = { MIN_TRIALS, CAPABILITIES, capabilityForFixture, recordResult, getByDigest, isQualified, assertQualified, selectModel, summary };
