'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { trainTensor, trainQubit } = require('./neuron-factory');

try {
  const result = workerData.kind === 'tensor' ? trainTensor(workerData.spec) : trainQubit(workerData.spec);
  parentPort.postMessage({ ok: true, result });
} catch (cause) {
  parentPort.postMessage({ ok: false, error: cause.message || String(cause) });
}
