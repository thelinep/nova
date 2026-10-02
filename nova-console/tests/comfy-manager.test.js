'use strict';
/* NOVA manages ComfyUI: start on demand, stop, restart after a crash, idle
 * stop, settings, and the watchdog that stops it if NOVA itself is killed.
 * A tiny Node server stands in for ComfyUI (".venv/bin/python main.py"). */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const comfy = require('../lib/comfy-manager');
const activity = require('../lib/activity');
const { openDb, Store } = require('../lib/db');

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function freePort() { return new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function up(port) { try { return (await fetch(`http://127.0.0.1:${port}/system_stats`)).ok; } catch (_) { return false; } }

/** A fake ComfyUI folder: python is a shell script running a small Node HTTP server. */
function fakeComfy(dir, { crashAfterMs = 0 } = {}) {
  fs.mkdirSync(path.join(dir, '.venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'main.py'), '# fake');
  const server = `const http=require('http');const port=+process.argv[process.argv.indexOf('--port')+1];http.createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({system:{comfyui_version:'fake'}}));}).listen(port,'127.0.0.1',()=>console.log('To see the GUI go to: http://127.0.0.1:'+port));${crashAfterMs ? `setTimeout(()=>process.exit(3),${crashAfterMs});` : ''}`;
  fs.writeFileSync(path.join(dir, 'server.js'), server);
  fs.writeFileSync(path.join(dir, '.venv', 'bin', 'python'), `#!/bin/sh\nshift\nexec "${process.execPath}" "${path.join(dir, 'server.js')}" "$@"\n`, { mode: 0o755 });
}

let store, db, dataDir;
beforeEach(() => {
  comfy._reset(); activity._reset();
  dataDir = tmp('nova-comfy-');
  ({ db } = openDb(dataDir)); store = new Store(db);
  activity.configure(store);
});

test('not installed: a clear message; autoStart off: says how to start it', async () => {
  const port = await freePort();
  comfy.configure({ store, dataDir, activity, port, platform: 'linux' });
  comfy.setPrefs({ dir: path.join(dataDir, 'nowhere') });
  await assert.rejects(() => comfy.ensure(), e => e.statusCode === 412 && /not installed/.test(e.message));
  assert.equal(comfy.status().state, 'failed');
  comfy.setPrefs({ autoStart: false });
  await assert.rejects(() => comfy.ensure(), /Settings > Image engine/);
  assert.throws(() => comfy.setPrefs({ idleMinutes: -1 }), /Idle minutes/);
  db.close();
});

test('ensure starts NOVA\'s own ComfyUI, reuses it, and stop ends it', { timeout: 30000 }, async () => {
  const port = await freePort(); const dir = path.join(dataDir, 'ComfyUI'); fakeComfy(dir);
  comfy.configure({ store, dataDir, activity, port, platform: 'linux' });
  comfy.setPrefs({ dir });
  assert.equal(comfy.installed(), true);
  const st = await comfy.ensure();
  assert.equal(st.state, 'ready'); assert.equal(st.managed, true);
  assert.ok(await up(port));
  assert.match(comfy.logTail(), /To see the GUI/);
  const again = await comfy.ensure();
  assert.equal(again.pid, st.pid, 'a running ComfyUI is reused');
  await comfy.stop();
  await sleep(300);
  assert.equal(await up(port), false);
  assert.equal(comfy.status().state, 'stopped');
  db.close();
});

test('a ComfyUI started elsewhere is used as it is and never stopped', { timeout: 20000 }, async () => {
  const port = await freePort(); const dir = path.join(dataDir, 'Other'); fakeComfy(dir);
  const outside = spawn(path.join(dir, '.venv', 'bin', 'python'), ['main.py', '--port', String(port)], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 50 && !(await up(port)); i++) await sleep(100);
    comfy.configure({ store, dataDir, activity, port, platform: 'linux' });
    comfy.setPrefs({ dir: path.join(dataDir, 'nowhere') });
    const st = await comfy.ensure();
    assert.equal(st.state, 'external'); assert.equal(st.managed, false);
    await comfy.stop();
    assert.ok(await up(port), 'NOVA left it running');
  } finally { outside.kill(); db.close(); }
});

test('restarts after a crash, but not in a loop', { timeout: 60000 }, async () => {
  const port = await freePort(); const dir = path.join(dataDir, 'Crashy'); fakeComfy(dir, { crashAfterMs: 1500 });
  comfy.configure({ store, dataDir, activity, port, platform: 'linux' });
  comfy.setPrefs({ dir });
  await comfy.ensure().catch(() => {});
  for (let i = 0; i < 300 && comfy.status().state !== 'failed'; i++) await sleep(100);
  const st = comfy.status();
  assert.equal(st.state, 'failed');
  assert.match(st.lastError, /stopped 3 times in 10 minutes/);
  assert.equal(st.restartsInWindow, 3);
  db.close();
});

test('idle stop is set in whole minutes (0 = never)', { timeout: 30000 }, async () => {
  const port = await freePort(); const dir = path.join(dataDir, 'Idle'); fakeComfy(dir);
  comfy.configure({ store, dataDir, activity, port, platform: 'linux' });
  comfy.setPrefs({ dir, idleMinutes: 0.01 }); // rounds to 0 = never
  assert.equal(comfy.prefs().idleMinutes, 0);
  db.close();
});

test('the watchdog stops ComfyUI when NOVA is killed outright', { timeout: 30000 }, async () => {
  const port = await freePort(); const dir = path.join(dataDir, 'Orphan'); fakeComfy(dir);
  // A stand-in "NOVA" process that starts the watchdog and is then killed with SIGKILL.
  const nova = spawn(process.execPath, ['-e', `require('child_process').spawn(process.execPath,[${JSON.stringify(path.join(__dirname, '..', 'lib', 'comfy-watchdog.js'))},String(process.pid),${JSON.stringify(path.join(dir, '.venv', 'bin', 'python'))},'main.py','--port','${port}'],{stdio:'ignore'});setInterval(()=>{},1000);`], { stdio: 'ignore' });
  for (let i = 0; i < 80 && !(await up(port)); i++) await sleep(100);
  assert.ok(await up(port), 'started');
  nova.kill('SIGKILL');
  for (let i = 0; i < 80 && (await up(port)); i++) await sleep(100);
  assert.equal(await up(port), false, 'ComfyUI went away with NOVA');
  db.close();
});

test('install is refused off macOS and while another install runs', () => {
  comfy.configure({ store, dataDir, activity, platform: 'linux' });
  assert.throws(() => comfy.install(), /macOS/);
  db.close();
});

test('starting a media job starts ComfyUI first (status checks never do)', { timeout: 30000 }, async () => {
  const imageGen = require('../lib/image-gen');
  const port = await freePort(); const dir = path.join(dataDir, 'Media'); fakeComfy(dir);
  comfy.configure({ store, dataDir, activity, port, platform: 'linux', imageGen: null });
  comfy.setPrefs({ dir });
  imageGen.setEnsure(() => comfy.ensure());
  try {
    assert.equal(await up(port), false);
    await imageGen.ensureReady();
    assert.ok(await up(port), 'a job start brought ComfyUI up');
    await comfy.stop();
    await imageGen.ensureReady({ optional: true }).catch(() => {});
  } finally { imageGen.setEnsure(null); await comfy.stop(); db.close(); }
});
