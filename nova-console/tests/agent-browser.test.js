'use strict';
/* Agent Browser screen: allowed websites, status, log, close-all, network rule
 * and a real page opened through the service (skipped without a browser). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const svc = require('../lib/browser-service');
const { openDb, Store } = require('../lib/db');

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test('cleanDomain accepts names and addresses, rejects junk', () => {
  assert.equal(svc.cleanDomain('Example.COM'), 'example.com');
  assert.equal(svc.cleanDomain('https://www.example.com/path?q=1'), 'www.example.com');
  assert.equal(svc.cleanDomain('*.example.com'), 'example.com');
  assert.equal(svc.cleanDomain('127.0.0.1:8080'), '127.0.0.1');
  for (const bad of ['', 'not a site!', 'exa mple.com', 'a..b']) assert.throws(() => svc.cleanDomain(bad), /not a website/);
});

test('allowed list: add, list, remove; a site covers its subdomains only', () => {
  const dir = tmp('nova-ab-');
  const { db } = openDb(dir); const store = new Store(db);
  try {
    const b = new svc.BrowserService(store, dir, null);
    assert.deepEqual(b.allowlist(), []);
    b.allowDomain('https://Example.com/', 'tester');
    b.allowDomain('127.0.0.1');
    assert.deepEqual(b.allowlist().map(a => a.domain), ['127.0.0.1', 'example.com']);
    assert.equal(b.allowlist().find(a => a.domain === 'example.com').addedBy, 'tester');
    const p = b.policy({}, 'a1');
    assert.equal(b.domainAllowed('www.example.com', p), true);
    assert.equal(b.domainAllowed('myexample.com', p), false);
    assert.equal(b.domainAllowed('example.com.evil.net', p), false);
    assert.equal(b.domainAllowed('0.0.1', p), false, 'addresses match exactly');
    b.removeDomain('example.com');
    assert.equal(b.domainAllowed('www.example.com', p), false);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('internet pages follow Allow network access; this computer\'s pages do not', () => {
  const dir = tmp('nova-ab-net-');
  const { db } = openDb(dir); const store = new Store(db);
  try {
    const b = new svc.BrowserService(store, dir, null);
    assert.throws(() => b.networkCheck('https://example.com/'), e => e.statusCode === 403 && /network access/.test(e.message));
    b.networkCheck('http://127.0.0.1:3000/');
    b.networkCheck('http://localhost/');
    store.put('preferences', { id: 'default', webAccess: true });
    b.networkCheck('https://example.com/');
    assert.equal(b.status().networkAccess, true);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('status, empty log and close-all without any page', async () => {
  const dir = tmp('nova-ab-st-');
  const { db } = openDb(dir); const store = new Store(db);
  try {
    const b = new svc.BrowserService(store, dir, null);
    const st = b.status();
    assert.equal(typeof st.available, 'boolean');
    assert.equal(st.halted, false);
    assert.deepEqual(st.openPages, []);
    assert.deepEqual(b.log(), { pages: [], actions: [], blocked: [] });
    assert.deepEqual(await b.closeAll(), { ok: true, closed: 0 });
    assert.throws(() => b.shotFile('../../nova.db'), /Unknown open browser page/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a real page: blocked until allowed, then open, read, screenshot kept in the data folder, close all', { skip: !svc.available(), timeout: 90000 }, async () => {
  const dir = tmp('nova-ab-real-');
  const { db } = openDb(dir); const store = new Store(db);
  const site = http.createServer((q, r) => { r.setHeader('Content-Type', 'text/html'); r.end('<!doctype html><title>Call sheet</title><h1>Marine Drive</h1><a id="more" href="/more">More</a><img src="https://cdn.example.net/x.png">'); }).listen(0);
  const url = `http://127.0.0.1:${site.address().port}/`;
  const b = new svc.BrowserService(store, dir, null);
  try {
    await assert.rejects(() => b.open(url, { agentId: 'a1' }), e => e.statusCode === 403);
    b.allowDomain('127.0.0.1');
    const opened = await b.open(url, { agentId: 'a1' });
    assert.equal(opened.title, 'Call sheet');
    assert.match(opened.image, /^browser_page_[\w-]+\/\d+\.png$/);
    assert.ok(fs.existsSync(b.shotFile(opened.image)));
    const read = await b.read(opened.pageId, {});
    assert.match(read.text, /Marine Drive/);
    const shot = await b.screenshot(opened.pageId, { path: '/etc/evil.png' });
    assert.ok(shot.path.startsWith(path.join(dir, 'browser-evidence') + path.sep), 'a requested path cannot leave the evidence folder');
    assert.equal(b.status().openPages.length, 1);
    const log = b.log();
    assert.ok(log.blocked.some(x => x.domain === 'cdn.example.net'), 'outside images are blocked and recorded');
    assert.ok(log.actions.some(a => a.kind === 'read' && a.agent_id === 'a1'));
    assert.deepEqual(await b.closeAll(), { ok: true, closed: 1 });
    assert.equal(b.status().openPages.length, 0);
    assert.equal(store.getGlobalHalt(), '0', 'closing pages does not halt NOVA');
  } finally { await b.shutdown(); site.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('server: Agent Browser routes', { timeout: 40000 }, async () => {
  const { spawn } = require('node:child_process');
  const dir = tmp('nova-ab-srv-');
  const child = spawn(process.execPath, ['--no-warnings', '-e', "const {server}=require('./server'); server.on('listening',()=>console.log('READY '+server.address().port));"], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0', DATA_DIR: dir, OLLAMA_HOST: 'http://127.0.0.1:9', COMFYUI_URL: 'http://127.0.0.1:9', NOVA_LIBRARY_DIR: path.join(dir, 'library') }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = ''; const t = setTimeout(() => reject(new Error('no start: ' + out)), 15000);
      child.stdout.on('data', d => { out += d; const m = /READY (\d+)/.exec(out); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
      child.stderr.on('data', d => { out += d; });
    });
    const base = `http://127.0.0.1:${port}`;
    const H = { Origin: base, 'Content-Type': 'application/json' };
    const j = async (p, o = {}) => { const r = await fetch(base + p, { headers: H, ...o }); return { status: r.status, body: await r.json() }; };
    assert.equal((await j('/browser/status')).body.halted, false);
    assert.equal((await j('/browser/allowlist', { method: 'POST', body: JSON.stringify({ domain: 'nope nope' }) })).status, 400);
    assert.deepEqual((await j('/browser/allowlist', { method: 'POST', body: JSON.stringify({ domain: 'example.com' }) })).body.allowlist.map(a => a.domain), ['example.com']);
    assert.deepEqual((await j('/browser/allowlist')).body.allowlist.map(a => a.domain), ['example.com']);
    assert.deepEqual((await j('/browser/allowlist/example.com', { method: 'DELETE' })).body.allowlist, []);
    assert.equal((await j('/browser/open', { method: 'POST', body: JSON.stringify({ agentId: 'a1', url: 'https://example.com/' }) })).status, 403, 'network access is off');
    assert.deepEqual(Object.keys((await j('/browser/log')).body).sort(), ['actions', 'blocked', 'ok', 'pages']);
    assert.equal((await j('/browser/pages')).body.ok, true);
    assert.deepEqual((await j('/browser/close-all', { method: 'POST', body: '{}' })).body, { ok: true, closed: 0 });
    assert.equal((await fetch(base + '/browser/shots/x/../../nova.png')).status, 404);
  } finally { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});
