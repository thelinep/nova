'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { markdownToHtml, printPage, cspFor } = require('../lib/print-view');

test('print view renders the Markdown the skills write: headings, tables, lists, bold', () => {
  const html = markdownToHtml('# Call sheet: Monsoon\n\n| Time | Scene |\n| --- | --- |\n| 07:00 | 1 |\n| 09:30 | 2A \\| pickup |\n\n## Notes\n\n- **Tide** at 18:40\n- Bring `ropes`\n\nLine one\nLine two\n');
  assert.match(html, /<h1>Call sheet: Monsoon<\/h1>/);
  assert.match(html, /<table><thead><tr><th>Time<\/th><th>Scene<\/th><\/tr><\/thead><tbody><tr><td>07:00<\/td><td>1<\/td><\/tr><tr><td>09:30<\/td><td>2A \| pickup<\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /<ul><li><strong>Tide<\/strong> at 18:40<\/li><li>Bring <code>ropes<\/code><\/li><\/ul>/);
  assert.match(html, /<p>Line one<br>Line two<\/p>/);
});

test('print view escapes model text, keeps Devanagari, and only its own script can run', () => {
  const page = printPage({ title: 'Shot list <Monsoon>', skillName: 'Shot List', model: 'maataa:latest', createdAt: '2026-11-11T01:02:03.000Z',
    markdown: '# दृश्य १\n\n| Shot | Description |\n| --- | --- |\n| 1A | <script>alert(1)</script> आशा <img src=x onerror=alert(2)> |\n' }, 'abc123');
  assert.match(page, /<title>Shot list &lt;Monsoon&gt;<\/title>/);
  assert.match(page, /<h1>दृश्य १<\/h1>/);
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt; आशा &lt;img src=x onerror=alert\(2\)&gt;/);
  assert.equal((page.match(/<script/g) || []).length, 1, 'the only script tag is the print button');
  assert.match(page, /<script nonce="abc123">/);
  assert.match(page, /Shot List · model maataa:latest · 2026-11-11 01:02 UTC/);
  const csp = cspFor('abc123');
  assert.match(csp, /default-src 'none'/); assert.match(csp, /script-src 'nonce-abc123'/); assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
});

test('GET /api/skill-outputs/:id/print answers 404 JSON for an unknown output', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-print-'));
  const child = spawn(process.execPath, ['--no-warnings', '-e', "const {server}=require('./server'); server.on('listening',()=>process.send(server.address()));"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0', DATA_DIR: dir, OLLAMA_HOST: 'http://127.0.0.1:9', NOVA_LIBRARY_DIR: path.join(dir, 'library') }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  try {
    const [address] = await once(child, 'message');
    const res = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: address.port, path: '/api/skill-outputs/out_missing/print', headers: { host: `127.0.0.1:${address.port}` } }, r => { let b = ''; r.on('data', d => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, type: r.headers['content-type'], body: b })); });
      req.on('error', reject);
    });
    assert.equal(res.status, 404);
    assert.match(res.type, /application\/json/);
    assert.match(res.body, /Saved output not found/);
  } finally { child.kill('SIGTERM'); await once(child, 'exit').catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); }
});
