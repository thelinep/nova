'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { OllamaClient } = require('../lib/ollama');

test('chatFull retries as plain text when a runner has no structured output, and only then', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
      const body = JSON.parse(raw); seen.push(body);
      if (body.model === 'broken') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"error":"boom"}'); }
      if (body.format) { res.writeHead(501, { 'Content-Type': 'application/json' }); return res.end('{"error":"structured output is unavailable"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ model: body.model, message: { content: '{"ok":true}' } }));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const client = new OllamaClient(`http://127.0.0.1:${server.address().port}`);
    const r = await client.chatFull('gemma4:12b', [{ role: 'user', content: 'Return JSON.' }], { format: 'json', options: { num_predict: 10 } });
    assert.equal(r.message.content, '{"ok":true}');
    assert.equal(r.structuredOutputUnavailable, true);
    assert.deepEqual(seen.map(b => b.format), ['json', undefined]);
    assert.deepEqual(seen[1].options, { num_predict: 10 }, 'everything but format is sent again unchanged');
    await assert.rejects(() => client.chatFull('broken', [{ role: 'user', content: 'x' }], { format: 'json' }), /Ollama chat failed: 500/);
    assert.equal(seen.length, 3, 'other errors are not retried');
  } finally { server.close(); }
});
