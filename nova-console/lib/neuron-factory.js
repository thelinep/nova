'use strict';

const crypto = require('node:crypto');

const LIMITS = {
  micro: { examples: 256, epochs: 300, tensorWidth: 16, qubits: 4, layers: 3 },
  macro: { examples: 2048, epochs: 1200, tensorWidth: 64, qubits: 8, layers: 6 },
};

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function uid(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function finite(value, name) { const number = Number(value); if (!Number.isFinite(number)) throw error(`${name} must be finite.`); return number; }
function integer(value, name, min, max) { const number = Number(value); if (!Number.isInteger(number) || number < min || number > max) throw error(`${name} must be an integer from ${min} to ${max}.`); return number; }
function seeded(seed) { let state = (Number(seed) || 1) >>> 0; return () => ((state = (1664525 * state + 1013904223) >>> 0) / 4294967296); }
function matrix(rows, columns, random) { return Array.from({ length: rows }, () => Array.from({ length: columns }, () => (random() - 0.5) * 0.2)); }

function validatePurpose(value) {
  const purpose = String(value || '').trim();
  if (purpose.length < 8 || purpose.length > 500) throw error('Purpose must contain 8 to 500 characters.');
  return purpose;
}

function tensorSpec(input, limits) {
  const config = input.config || {};
  const inputSize = integer(config.inputSize, 'inputSize', 1, limits.tensorWidth);
  const hiddenSize = integer(config.hiddenSize || Math.min(8, limits.tensorWidth), 'hiddenSize', 1, limits.tensorWidth);
  const outputSize = integer(config.outputSize, 'outputSize', 1, limits.tensorWidth);
  const epochs = integer(config.epochs || 100, 'epochs', 1, limits.epochs);
  const learningRate = finite(config.learningRate ?? 0.03, 'learningRate');
  if (learningRate <= 0 || learningRate > 1) throw error('learningRate must be greater than 0 and at most 1.');
  if (!Array.isArray(input.examples) || input.examples.length < 2 || input.examples.length > limits.examples) throw error(`Tensor training requires 2 to ${limits.examples} examples.`);
  const examples = input.examples.map((example, index) => {
    if (!Array.isArray(example.input) || example.input.length !== inputSize) throw error(`Example ${index} input must contain ${inputSize} values.`);
    if (!Array.isArray(example.target) || example.target.length !== outputSize) throw error(`Example ${index} target must contain ${outputSize} values.`);
    return { input: example.input.map((v, i) => finite(v, `example ${index} input ${i}`)), target: example.target.map((v, i) => finite(v, `example ${index} target ${i}`)) };
  });
  return { config: { inputSize, hiddenSize, outputSize, epochs, learningRate, seed: integer(config.seed || 1, 'seed', 1, 2147483647) }, examples };
}

function qubitSpec(input, limits) {
  const config = input.config || {};
  const qubits = integer(config.qubits, 'qubits', 1, limits.qubits);
  const layers = integer(config.layers || 1, 'layers', 1, limits.layers);
  const epochs = integer(config.epochs || 60, 'epochs', 1, Math.min(limits.epochs, 200));
  const learningRate = finite(config.learningRate ?? 0.15, 'learningRate');
  if (learningRate <= 0 || learningRate > 1) throw error('learningRate must be greater than 0 and at most 1.');
  const states = 2 ** qubits;
  if (!Array.isArray(input.targetDistribution) || input.targetDistribution.length !== states) throw error(`targetDistribution must contain ${states} probabilities.`);
  const raw = input.targetDistribution.map((v, i) => finite(v, `target probability ${i}`));
  if (raw.some(v => v < 0)) throw error('Target probabilities cannot be negative.');
  const total = raw.reduce((sum, value) => sum + value, 0);
  if (total <= 0) throw error('Target distribution must have positive probability mass.');
  return { config: { qubits, layers, epochs, learningRate, seed: integer(config.seed || 1, 'seed', 1, 2147483647) }, targetDistribution: raw.map(value => value / total) };
}

function createBlueprint(store, input, extra = {}) {
  const kind = String(input.kind || 'tensor');
  const scale = String(input.scale || 'micro');
  if (!['tensor', 'qubit'].includes(kind)) throw error('Kind must be tensor or qubit.');
  if (!LIMITS[scale]) throw error('Scale must be micro or macro.');
  const spec = kind === 'tensor' ? tensorSpec(input, LIMITS[scale]) : qubitSpec(input, LIMITS[scale]);
  const now = new Date().toISOString();
  const blueprint = {
    id: uid('neuron'), type: 'neuron-blueprint', name: String(input.name || `${kind} factory job`).trim().slice(0, 120),
    purpose: validatePurpose(input.purpose), kind, scale, status: scale === 'macro' ? 'awaiting-approval' : 'ready',
    createdAt: now, updatedAt: now, approval: null, spec,
    truth: kind === 'qubit'
      ? 'State-vector simulation. No physical qubits are created or accessed.'
      : 'Locally trained dense tensor artifact. This does not train or modify an Ollama foundation model.',
  };
  if (extra.sutra) blueprint.sutra = extra.sutra; // set only by the sutra-neuron presets, never from the request body
  store.put('neuronBlueprints', blueprint);
  return blueprint;
}

function approveBlueprint(store, id) {
  const blueprint = store.get('neuronBlueprints', id);
  if (!blueprint) throw error('Unknown neuron blueprint.', 404);
  if (blueprint.scale !== 'macro' || blueprint.status !== 'awaiting-approval') throw error('Only an awaiting macro blueprint can be approved.', 409);
  const at = new Date().toISOString();
  blueprint.status = 'ready'; blueprint.updatedAt = at; blueprint.approval = { id: uid('approval'), approvedAt: at, consumedAt: null };
  store.put('neuronBlueprints', blueprint);
  return blueprint;
}

function tensorForward(input, w1, b1, w2, b2) {
  const hidden = b1.map((bias, j) => Math.tanh(bias + input.reduce((sum, value, i) => sum + value * w1[i][j], 0)));
  const output = b2.map((bias, k) => bias + hidden.reduce((sum, value, j) => sum + value * w2[j][k], 0));
  return { hidden, output };
}

function trainTensor(spec) {
  const { inputSize, hiddenSize, outputSize, epochs, learningRate, seed } = spec.config;
  const random = seeded(seed), w1 = matrix(inputSize, hiddenSize, random), w2 = matrix(hiddenSize, outputSize, random);
  const b1 = Array(hiddenSize).fill(0), b2 = Array(outputSize).fill(0), history = [];
  for (let epoch = 0; epoch < epochs; epoch++) {
    let loss = 0;
    for (const example of spec.examples) {
      const { hidden, output } = tensorForward(example.input, w1, b1, w2, b2);
      const delta2 = output.map((value, k) => { const d = value - example.target[k]; loss += d * d; return 2 * d / outputSize; });
      const delta1 = hidden.map((value, j) => (1 - value * value) * delta2.reduce((sum, d, k) => sum + d * w2[j][k], 0));
      for (let j = 0; j < hiddenSize; j++) for (let k = 0; k < outputSize; k++) w2[j][k] -= learningRate * hidden[j] * delta2[k];
      for (let k = 0; k < outputSize; k++) b2[k] -= learningRate * delta2[k];
      for (let i = 0; i < inputSize; i++) for (let j = 0; j < hiddenSize; j++) w1[i][j] -= learningRate * example.input[i] * delta1[j];
      for (let j = 0; j < hiddenSize; j++) b1[j] -= learningRate * delta1[j];
    }
    loss /= spec.examples.length;
    if (epoch === 0 || epoch === epochs - 1 || (epoch + 1) % Math.max(1, Math.floor(epochs / 10)) === 0) history.push({ epoch: epoch + 1, loss });
  }
  const finalLoss = spec.examples.reduce((sum, example) => { const output = tensorForward(example.input, w1, b1, w2, b2).output; return sum + output.reduce((s, value, k) => s + (value - example.target[k]) ** 2, 0) / outputSize; }, 0) / spec.examples.length;
  return { engine: 'dense-tensor-backprop-v1', tensors: { inputHidden: w1, hiddenBias: b1, hiddenOutput: w2, outputBias: b2 }, metrics: { finalLoss, examples: spec.examples.length, epochs }, history };
}

function applyRy(state, qubit, angle) {
  const half = angle / 2, c = Math.cos(half), s = Math.sin(half), step = 2 ** qubit;
  for (let base = 0; base < state.length; base += step * 2) for (let offset = 0; offset < step; offset++) {
    const a = base + offset, b = a + step, av = state[a], bv = state[b]; state[a] = c * av - s * bv; state[b] = s * av + c * bv;
  }
}
function applyCnot(state, control, target) {
  for (let index = 0; index < state.length; index++) if (((index >> control) & 1) && !((index >> target) & 1)) { const paired = index | (1 << target), value = state[index]; state[index] = state[paired]; state[paired] = value; }
}
function circuitDistribution(qubits, layers, parameters) {
  const state = Array(2 ** qubits).fill(0); state[0] = 1;
  for (let layer = 0; layer < layers; layer++) {
    for (let qubit = 0; qubit < qubits; qubit++) applyRy(state, qubit, parameters[layer * qubits + qubit]);
    if (qubits > 1) for (let qubit = 0; qubit < qubits - 1; qubit++) applyCnot(state, qubit, qubit + 1);
  }
  return state.map(amplitude => amplitude * amplitude);
}
function distributionLoss(actual, target) { return actual.reduce((sum, value, index) => sum + (value - target[index]) ** 2, 0) / actual.length; }

function trainQubit(spec) {
  const { qubits, layers, epochs, learningRate, seed } = spec.config, random = seeded(seed);
  const parameters = Array.from({ length: qubits * layers }, () => (random() - 0.5) * Math.PI), history = [], epsilon = 1e-3;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradients = parameters.map((value, index) => {
      parameters[index] = value + epsilon; const plus = distributionLoss(circuitDistribution(qubits, layers, parameters), spec.targetDistribution);
      parameters[index] = value - epsilon; const minus = distributionLoss(circuitDistribution(qubits, layers, parameters), spec.targetDistribution);
      parameters[index] = value; return (plus - minus) / (2 * epsilon);
    });
    parameters.forEach((value, index) => { parameters[index] = value - learningRate * gradients[index]; });
    if (epoch === 0 || epoch === epochs - 1 || (epoch + 1) % Math.max(1, Math.floor(epochs / 10)) === 0) history.push({ epoch: epoch + 1, loss: distributionLoss(circuitDistribution(qubits, layers, parameters), spec.targetDistribution) });
  }
  const distribution = circuitDistribution(qubits, layers, parameters);
  return { engine: 'state-vector-variational-circuit-v1', simulated: true, physicalQubitsCreated: false, circuit: { qubits, layers, gates: ['RY', 'CNOT'], parameters }, distribution, metrics: { finalLoss: distributionLoss(distribution, spec.targetDistribution), epochs }, history };
}

function trainBlueprint(store, id) {
  const blueprint = store.get('neuronBlueprints', id);
  if (!blueprint) throw error('Unknown neuron blueprint.', 404);
  if (blueprint.status !== 'ready') throw error('Blueprint is not ready for training.', 409);
  const startedAt = new Date().toISOString(), run = { id: uid('neuron_run'), blueprintId: id, status: 'running', startedAt, finishedAt: null };
  store.put('neuronRuns', run);
  try {
    const trained = blueprint.kind === 'tensor' ? trainTensor(blueprint.spec) : trainQubit(blueprint.spec);
    const artifact = { id: uid('neuron_artifact'), blueprintId: id, runId: run.id, kind: blueprint.kind, scale: blueprint.scale, purpose: blueprint.purpose, createdAt: new Date().toISOString(), truth: blueprint.truth, config: blueprint.spec.config, ...trained };
    store.put('neuronArtifacts', artifact);
    run.status = 'completed'; run.finishedAt = artifact.createdAt; run.artifactId = artifact.id; run.metrics = artifact.metrics;
    blueprint.status = 'trained'; blueprint.updatedAt = artifact.createdAt; blueprint.artifactId = artifact.id;
    if (blueprint.approval) blueprint.approval.consumedAt = artifact.createdAt;
    store.put('neuronRuns', run); store.put('neuronBlueprints', blueprint);
    return { blueprint, run, artifact };
  } catch (cause) {
    run.status = 'failed'; run.finishedAt = new Date().toISOString(); run.error = cause.message; store.put('neuronRuns', run); throw cause;
  }
}

module.exports = { LIMITS, createBlueprint, approveBlueprint, trainBlueprint, trainTensor, trainQubit, circuitDistribution };
