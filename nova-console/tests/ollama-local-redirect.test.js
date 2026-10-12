'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { OllamaClient } = require('../lib/ollama');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

test('local Ollama chat rejects redirects without forwarding private prompt content', async () => {
  let redirectedRequests = 0;
  const destination = http.createServer((_req, res) => {
    redirectedRequests++;
    res.end('unexpected');
  });
  const destinationPort = await listen(destination);
  const source = http.createServer((_req, res) => {
    res.writeHead(307, { Location: `http://127.0.0.1:${destinationPort}/capture` });
    res.end();
  });
  const sourcePort = await listen(source);
  try {
    const client = new OllamaClient(`http://127.0.0.1:${sourcePort}`);
    await assert.rejects(
      () => client.chatFull('local-model', [{ role: 'user', content: 'private source code' }]),
      /redirect|fetch failed/i,
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(redirectedRequests, 0);
  } finally {
    await close(source);
    await close(destination);
  }
});
