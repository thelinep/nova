'use strict';
/* Model registry sync: measured memory, GPU share and context from Ollama; example rows marked and removable. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

test('server: sync measures loaded models and marks the example models', { timeout: 30000 }, async () => {
  const ollama = http.createServer((req, res) => {
    const send = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/tags') return send({ models: [
      { name: 'qwen2.5-coder:7b', size: 4.7e9, digest: 'a'.repeat(64), details: { parameter_size: '7.6B', quantization_level: 'Q4_K_M', family: 'qwen2' } },
      { name: 'llama3.2:latest', size: 2.0e9, digest: 'b'.repeat(64), details: { parameter_size: '3.2B', quantization_level: 'Q4_K_M', family: 'llama' } } ] });
    if (req.url === '/api/ps') return send({ models: [{ name: 'qwen2.5-coder:7b', size: 6.0e9, size_vram: 6.0e9, context_length: 8192, expires_at: new Date(Date.now() + 240000).toISOString() }] });
    if (req.url === '/api/show') return send({ model_info: { 'qwen2.context_length': 32768 }, capabilities: ['completion', 'tools'], template: '{{ .Prompt }}' });
    res.writeHead(404); res.end('{}');
  });
  await new Promise(r => ollama.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-models-'));
  const child = spawn(process.execPath, ['--no-warnings', '-e', "const {server}=require('./server'); server.on('listening',()=>console.log('READY '+server.address().port));"], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0', DATA_DIR: dir, OLLAMA_HOST: 'http://127.0.0.1:' + ollama.address().port, COMFYUI_URL: 'http://127.0.0.1:9', NOVA_LIBRARY_DIR: path.join(dir, 'library') }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = ''; const t = setTimeout(() => reject(new Error('no start: ' + out)), 15000);
      child.stdout.on('data', d => { out += d; const m = /READY (\d+)/.exec(out); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
      child.stderr.on('data', d => { out += d; });
    });
    const base = `http://127.0.0.1:${port}`, H = { Origin: base, 'Content-Type': 'application/json' };
    const j = async (p, o = {}) => { const r = await fetch(base + p, { headers: H, ...o }); return { status: r.status, body: await r.json().catch(() => null) }; };
    await j('/api/store/models', { method: 'PUT', body: JSON.stringify({ id: 'm_qwen', name: 'Qwen2.5 Coder 7B', runtime: 'llama.cpp', loaded: true, ramGb: 6.8 }) });
    await j('/api/store/modelProfiles', { method: 'PUT', body: JSON.stringify({ id: 'mp_x', name: 'Example profile', modelId: 'm_qwen' }) });
    const synced = (await j('/api/models/sync', { method: 'POST' })).body.models;
    const q = synced.find(m => m.id === 'qwen2.5-coder:7b'), l = synced.find(m => m.id === 'llama3.2:latest');
    assert.deepEqual([q.loaded, q.ramMeasured, q.ramGb, q.gpuLayers, q.ctx, q.ctxMax], [true, true, 6, '100% on GPU', 8, 32]);
    assert.ok(q.expiresAt);
    assert.deepEqual([l.loaded, l.ramMeasured, l.ramGb, l.gpuLayers], [false, false, 2.7, '—'], 'idle models get an estimate from the file size');
    const all = (await j('/api/store/models')).body;
    const ex = all.find(m => m.id === 'm_qwen');
    assert.deepEqual([ex.example, ex.loaded], [true, false], 'the example row is marked and never shown as loaded');
    assert.equal((await j('/api/models/examples/remove', { method: 'POST' })).body.removed, 1);
    assert.equal((await j('/api/store/models')).body.some(m => m.id === 'm_qwen'), false);
    assert.equal((await j('/api/store/modelProfiles')).body.some(p => p.id === 'mp_x'), false);
  } finally { child.kill(); ollama.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('server: a model renamed in Ollama keeps its chats, agents and profiles', { timeout: 30000 }, async () => {
  let names = ['maataa:latest'];
  const ollama = http.createServer((req, res) => {
    const send = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/tags') return send({ models: names.map(n => ({ name: n, size: 2e9, digest: 'c'.repeat(64), details: { parameter_size: '3.2B' } })) });
    if (req.url === '/api/ps') return send({ models: [] });
    if (req.url === '/api/show') return send({ model_info: {}, capabilities: ['completion'] });
    res.writeHead(404); res.end('{}');
  });
  await new Promise(r => ollama.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-rename-'));
  const child = spawn(process.execPath, ['--no-warnings', '-e', "const {server}=require('./server'); server.on('listening',()=>console.log('READY '+server.address().port));"], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0', DATA_DIR: dir, OLLAMA_HOST: 'http://127.0.0.1:' + ollama.address().port, COMFYUI_URL: 'http://127.0.0.1:9', NOVA_LIBRARY_DIR: path.join(dir, 'library') }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = ''; const t = setTimeout(() => reject(new Error('no start: ' + out)), 15000);
      child.stdout.on('data', d => { out += d; const m = /READY (\d+)/.exec(out); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
      child.stderr.on('data', d => { out += d; });
    });
    const base = `http://127.0.0.1:${port}`, H = { Origin: base, 'Content-Type': 'application/json' };
    const j = async (p, o = {}) => { const r = await fetch(base + p, { headers: H, ...o }); return { status: r.status, body: await r.json().catch(() => null) }; };
    await j('/api/models/sync', { method: 'POST' });
    await j('/api/store/sessions', { method: 'PUT', body: JSON.stringify({ id: 's1', title: 'Chat', modelId: 'maataa:latest', messages: [] }) });
    await j('/api/store/agents', { method: 'PUT', body: JSON.stringify({ id: 'a1', name: 'Planner', modelId: 'maataa:latest' }) });
    names = ['guru-maataa:latest']; // ollama cp maataa:latest guru-maataa:latest && ollama rm maataa:latest
    const r = (await j('/api/models/sync', { method: 'POST' })).body;
    assert.deepEqual(r.renamed, { 'maataa:latest': 'guru-maataa:latest' });
    assert.equal((await j('/api/store/sessions')).body.find(x => x.id === 's1').modelId, 'guru-maataa:latest');
    assert.equal((await j('/api/store/agents')).body.find(x => x.id === 'a1').modelId, 'guru-maataa:latest');
    assert.deepEqual((await j('/api/store/models')).body.filter(m => m.runtime === 'ollama').map(m => m.id), ['guru-maataa:latest']);
  } finally { child.kill(); ollama.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
