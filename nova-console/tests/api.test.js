'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

function request(base, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + pathname, { method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Request timed out')));
    req.end(body);
  });
}
async function start(dir, ollamaHost) {
  const child = spawn(process.execPath, ['--no-warnings', '-e', "const {server}=require('./server'); server.on('listening',()=>process.send(server.address()));"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0', DATA_DIR: dir, OLLAMA_HOST: ollamaHost }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const address = once(child, 'message').then(([value]) => value);
  let output = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Startup timeout: ' + output)); }, 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited ' + code + ': ' + output)); });
    child.stderr.on('data', data => { output += data; });
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  return { base, address: await address, async stop() {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited; clearTimeout(timer);
  } };
}

test('real HTTP boundary, persisted CRUD, restart, validation and loopback-only listener', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-api-'));
  // Only a local stub is used: no actual Ollama models, agents or operator data.
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [] }));
  });
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
  let app;
  try {
    const ollamaHost = `http://127.0.0.1:${upstream.address().port}`;
    app = await start(dir, ollamaHost);
    assert.equal(app.address.address, '127.0.0.1');
    assert.equal(app.address.family, 'IPv4');
    const health = await request(app.base, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.text).dataDir, dir);
    assert.match((await request(app.base, '/')).text, /NOVA/);
    const record = { id: 'phase12-session', title: 'Persistence check', messages: [] };
    const mutation = { method: 'PUT', headers: { Origin: app.base, 'Content-Type': 'application/json' }, body: JSON.stringify(record) };
    assert.equal((await request(app.base, '/api/store/sessions', mutation)).status, 200);
    assert.equal((await request(app.base, '/api/store/modelQualifications', mutation)).status, 403);
    assert.equal((await request(app.base, '/api/store/modelQualifications/fake', { method:'DELETE', headers:mutation.headers })).status, 403);
    for (const origin of [undefined, 'null', 'https://evil.example', app.base.replace('127.0.0.1', 'localhost')]) {
      const blocked = await request(app.base, '/api/store/_clear-all', { method: 'POST', headers: origin ? { Origin: origin } : {} });
      assert.equal(blocked.status, 403);
    }
    assert.equal((await request(app.base, '/api/mcp/approvals/fake/approve', { method: 'POST' })).status, 403);
    assert.equal((await request(app.base, '/api/store/sessions', { headers: { Host: 'attacker.example' } })).status, 403);
    assert.equal((await request(app.base, '/api/store/sessions', { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request(app.base, '/api/store/sessions', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await request(app.base, '/api/store/sessions', { ...mutation, body: '{' })).status, 400);
    assert.equal((await request(app.base, '/api/store/sessions', { ...mutation, body: '{}' })).status, 400);
    assert.equal((await request(app.base, '/api/store/not-a-store')).status, 404);
    assert.equal((await request(app.base, '/%ZZ')).status, 400);
    assert.equal((await request(app.base, '/api/health')).status, 200);
    const page = JSON.parse((await request(app.base, '/api/store/sessions/page?limit=1')).text);
    assert.equal(page.total, 1); assert.deepEqual(page.rows, [record]);
    // The selected ephemeral port must not listen on any non-loopback IPv4 interface.
    const addresses = Object.values(os.networkInterfaces()).flat().filter(a => a && !a.internal && a.family === 'IPv4');
    for (const { address } of addresses) {
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host: address, port: Number(new URL(app.base).port) });
        socket.once('connect', () => { socket.destroy(); reject(new Error('NOVA reachable on non-loopback ' + address)); });
        socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
        // A local firewall can drop rather than refuse these connections. The
        // kernel-reported listener address above independently proves the bind.
        socket.setTimeout(1000, () => { socket.destroy(); resolve(); });
      });
    }
    await app.stop(); app = await start(dir, ollamaHost);
    assert.deepEqual(JSON.parse((await request(app.base, '/api/store/sessions')).text), [record]);
    assert.equal((await request(app.base, '/api/store/sessions/phase12-session', { method: 'DELETE', headers: { Origin: app.base } })).status, 200);
    assert.deepEqual(JSON.parse((await request(app.base, '/api/store/sessions')).text), []);
  } finally {
    if (app) await app.stop();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
