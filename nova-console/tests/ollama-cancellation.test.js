'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { OllamaClient } = require('../lib/ollama');
for (const stage of ['metadata', 'generation']) test('Ollama cancellation closes real HTTP transport during ' + stage, { timeout: 5000 }, async () => {
  let received, closed;
  const ready = new Promise(resolve => { received = resolve; });
  const disconnected = new Promise(resolve => { closed = resolve; });
  const server = http.createServer((req, res) => {
    req.resume();
    res.on('close', closed);
    received();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const control = new AbortController();
  const client = new OllamaClient('http://127.0.0.1:' + server.address().port);
  try {
    const pending = stage === 'metadata' ? client.show('fixture', control.signal) : client.chatFull('fixture', [], { signal: control.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await ready;
    control.abort();
    await rejected;
    await disconnected;
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
