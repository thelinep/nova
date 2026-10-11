'use strict';
/* Worker thread for one Radheya training round, so the server keeps answering while it trains. */
const { parentPort, workerData } = require('node:worker_threads');
const model = require('./radheya-model');

try { parentPort.postMessage({ result: model.evolve(workerData.events, workerData.options) }); }
catch (e) { parentPort.postMessage({ error: e.message || String(e) }); }
