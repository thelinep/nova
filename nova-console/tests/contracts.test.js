'use strict';
/* NOVA Everywhere, Phase 1: device identity and execution contracts. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const devices = require('../lib/device-identity');
const contracts = require('../lib/contracts');
const computer = require('../lib/computer');
const { openDb, Store } = require('../lib/db');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ctr-'));
  devices._reset();
  const { db } = openDb(dir);
  return { dir, db, store: new Store(db), done: () => { db.close(); devices._reset(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const phone = () => { const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'); return { pub: publicKey.export({ type: 'spki', format: 'pem' }), key: privateKey }; };
const signWith = (key, text) => crypto.sign(null, Buffer.from(text), key).toString('base64');
const plan = (over = {}) => ({ actor: { type: 'agent', id: 'qwen' }, intent: 'Run the tests', capability: 'process.execute', resource: { type: 'repo', id: '/code/app' }, plan: { command: 'npm test' }, risk: 'run', ...over });

test('device identity: one Ed25519 key per install, private key kept private, same id after restart', () => {
  const t = setup();
  try {
    const me = devices.ensure(t.store, t.dir);
    assert.match(me.id, /^dev_[0-9a-f]{20}$/);
    assert.equal(me.class, 'workstation');
    assert.ok(me.capabilities.includes('process.execute') && !me.capabilities.includes('robot.navigate'));
    assert.ok(!JSON.stringify(t.store.all('devices')).includes('PRIVATE KEY'), 'only the public key is stored');
    const file = path.join(t.dir, 'security', 'device.json');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    devices._reset();
    assert.equal(devices.self(t.dir).id, me.id, 'the identity survives a restart');
    const sig = devices.sign(t.dir, { a: 1, b: 2 });
    assert.ok(devices.verify(me.publicKey, { b: 2, a: 1 }, sig), 'canonical JSON: key order does not matter');
    assert.ok(!devices.verify(me.publicKey, { a: 1, b: 3 }, sig));
  } finally { t.done(); }
});

test('device classes cap authority and capabilities; a capability is not an authorization', () => {
  const t = setup();
  try {
    const p = phone();
    const d = devices.register(t.store, t.dir, { class: 'companion', name: 'Pixel', publicKey: p.pub, capabilities: ['chat', 'camera.capture', 'process.execute'], human: 'Hemant' });
    assert.deepEqual(d.capabilities, ['chat', 'camera.capture'], 'a phone cannot claim to run programs');
    assert.ok(devices.can(d, 'approve') && !devices.can(d, 'execute'));
    assert.throws(() => devices.register(t.store, t.dir, { class: 'toaster', publicKey: p.pub }), /Unknown device class/);
    assert.throws(() => contracts.open(t.store, t.dir, plan({ deviceId: d.id })), /has not declared the capability process\.execute/);
    assert.throws(() => contracts.open(t.store, t.dir, plan({ capability: 'robot.navigate' })), /has not declared/);
    // Declared, but still needs an approval before it can run.
    const c = contracts.open(t.store, t.dir, plan());
    assert.throws(() => contracts.begin(t.store, c.id), /needs an approval/);
  } finally { t.done(); }
});

test('approval: bound to the plan hash, single use, and void when the plan changes', () => {
  const t = setup();
  try {
    const c = contracts.open(t.store, t.dir, plan());
    assert.equal(c.planHash, contracts.planHash(c));
    contracts.recordPolicy(t.store, t.dir, c.id, { decision: 'ask', reason: 'run commands ask first' });
    const a = contracts.approve(t.store, t.dir, c.id, 'allow');
    assert.equal(a.status, 'approved'); assert.equal(a.approval.device.class, 'workstation');
    assert.throws(() => contracts.approve(t.store, t.dir, c.id, 'allow'), /already answered/);
    contracts.begin(t.store, c.id);
    assert.throws(() => contracts.begin(t.store, c.id), /already used|needs an approval/);
    contracts.observe(t.store, c.id, { ok: true, summary: '12 passed', output: 'ok 12' });
    contracts.verify(t.store, c.id, [{ name: 'tests pass', ok: true }]);
    const s = contracts.seal(t.store, t.dir, c.id);
    assert.equal(s.status, 'completed'); assert.equal(s.evidence.seq, 1);

    // A plan edited after approval is refused.
    const c2 = contracts.open(t.store, t.dir, plan());
    contracts.approve(t.store, t.dir, c2.id, 'allow');
    const edited = t.store.get('executionContracts', c2.id); edited.plan.command = 'rm -rf /'; t.store.put('executionContracts', edited);
    assert.throws(() => contracts.begin(t.store, c2.id), /plan changed/);

    // Read-only actions need no person, but the policy approval is still recorded.
    const r = contracts.open(t.store, t.dir, plan({ capability: 'file.read', risk: 'read', plan: { path: 'a.md' } }));
    contracts.begin(t.store, r.id); contracts.observe(t.store, r.id, { ok: true }); assert.equal(contracts.seal(t.store, t.dir, r.id).status, 'completed');

    // Expired requests cannot be approved.
    const old = contracts.open(t.store, t.dir, plan({ ttlMs: -1 }));
    assert.throws(() => contracts.approve(t.store, t.dir, old.id, 'allow'), /expired/);
    assert.equal(contracts.get(t.store, old.id).status, 'expired');
  } finally { t.done(); }
});

test('remote approval: a paired phone signs the exact plan; wrong key, wrong plan or a viewer device is refused', () => {
  const t = setup();
  try {
    const p = phone(), other = phone();
    const ph = devices.register(t.store, t.dir, { class: 'companion', name: 'Pixel', publicKey: p.pub, human: 'Hemant' });
    const web = devices.register(t.store, t.dir, { class: 'interface', name: 'Browser', publicKey: other.pub });
    const c = contracts.open(t.store, t.dir, plan());
    const ch = contracts.challenge(t.store, c.id);
    assert.throws(() => contracts.approve(t.store, t.dir, c.id, 'allow', { deviceId: web.id, planHash: ch.planHash, signature: signWith(other.key, ch.sign.allow) }), /may not approve/);
    assert.throws(() => contracts.approve(t.store, t.dir, c.id, 'allow', { deviceId: ph.id, planHash: ch.planHash, signature: signWith(other.key, ch.sign.allow) }), /signature is not valid/);
    assert.throws(() => contracts.approve(t.store, t.dir, c.id, 'allow', { deviceId: ph.id, planHash: 'f'.repeat(64), signature: signWith(p.key, ch.sign.allow) }), /different plan/);
    assert.throws(() => contracts.approve(t.store, t.dir, c.id, 'allow', { deviceId: ph.id, planHash: ch.planHash, signature: signWith(p.key, ch.sign.deny) }), /signature is not valid/, 'a signed "deny" cannot be replayed as "allow"');
    const a = contracts.approve(t.store, t.dir, c.id, 'allow', { deviceId: ph.id, planHash: ch.planHash, signature: signWith(p.key, ch.sign.allow) });
    assert.deepEqual([a.approval.by.id, a.approval.device.name, a.approval.via], ['Hemant', 'Pixel', 'companion']);
    contracts.begin(t.store, c.id); contracts.observe(t.store, c.id, { ok: true }); contracts.seal(t.store, t.dir, c.id);
    assert.equal(contracts.verifyChain(t.store, t.dir).ok, true);
    devices.revoke(t.store, t.dir, ph.id);
    const c2 = contracts.open(t.store, t.dir, plan());
    const ch2 = contracts.challenge(t.store, c2.id);
    assert.throws(() => contracts.approve(t.store, t.dir, c2.id, 'allow', { deviceId: ph.id, planHash: ch2.planHash, signature: signWith(p.key, ch2.sign.allow) }), /may not approve/);
  } finally { t.done(); }
});

test('evidence: sealed contracts form a signed chain; edits, removals and reordering are detected', () => {
  const t = setup();
  try {
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const c = contracts.open(t.store, t.dir, plan({ plan: { command: 'echo ' + i } }));
      if (i === 2) { contracts.approve(t.store, t.dir, c.id, 'deny'); ids.push(c.id); continue; }
      contracts.approve(t.store, t.dir, c.id, 'allow'); contracts.begin(t.store, c.id); contracts.observe(t.store, c.id, { ok: i !== 3, error: i === 3 ? 'exit 1' : null }); contracts.seal(t.store, t.dir, c.id); ids.push(c.id);
    }
    assert.deepEqual(ids.map(id => contracts.get(t.store, id).status), ['completed', 'completed', 'denied', 'failed']);
    const ok = contracts.verifyChain(t.store, t.dir);
    assert.deepEqual([ok.ok, ok.count], [true, 4]);

    const original = JSON.parse(JSON.stringify(contracts.get(t.store, ids[1])));
    const edit = JSON.parse(JSON.stringify(original)); edit.observation.summary = 'all good'; t.store.put('executionContracts', edit);
    assert.match(contracts.verifyChain(t.store, t.dir).reason, /changed after it was sealed/);
    t.store.put('executionContracts', original);
    assert.equal(contracts.verifyChain(t.store, t.dir).ok, true, 'restoring the original record heals the chain');
    const resigned = JSON.parse(JSON.stringify(original)); resigned.evidence.signature = devices.sign(t.dir, 'something else'); t.store.put('executionContracts', resigned);
    assert.match(contracts.verifyChain(t.store, t.dir).reason, /signature does not match/);
    t.store.put('executionContracts', original);
    t.store.delete('executionContracts', ids[1]);
    assert.match(contracts.verifyChain(t.store, t.dir).reason, /Contract 2 is missing/);
  } finally { t.done(); }
});

test('restart: contracts left open are sealed as cancelled; the chain continues', () => {
  const t = setup();
  try {
    const a = contracts.open(t.store, t.dir, plan());
    contracts.approve(t.store, t.dir, a.id, 'allow'); contracts.begin(t.store, a.id); contracts.observe(t.store, a.id, { ok: true }); contracts.seal(t.store, t.dir, a.id);
    const b = contracts.open(t.store, t.dir, plan());
    contracts._resetHeads(t.store);
    assert.equal(contracts.sweep(t.store, t.dir), 1);
    assert.equal(contracts.get(t.store, b.id).status, 'cancelled');
    assert.equal(contracts.get(t.store, b.id).evidence.seq, 2);
    assert.equal(contracts.verifyChain(t.store, t.dir).ok, true);
  } finally { t.done(); }
});

test('computer tools map to capabilities and risks', () => {
  assert.deepEqual(computer.contractFor('run_command', { command: 'ls', cwd: '/x' }), { capability: 'process.execute', risk: 'run', resource: { type: 'command', id: '/x' } });
  assert.deepEqual(computer.contractFor('read_file', { path: 'a.md' }).risk, 'read');
  assert.deepEqual(computer.contractFor('write_file', { path: 'a.md' }).capability, 'file.write');
  assert.deepEqual(computer.contractFor('screenshot', {}).capability, 'screen.capture');
  for (const t of computer.TOOLS) assert.ok(devices.CAPABILITIES[computer.contractFor(t.name, {}).capability], t.name);
});

test('server: device and contract routes; the contract stores cannot be written from outside', { timeout: 30000 }, async () => {
  const { spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ctr-srv-'));
  const child = spawn(process.execPath, ['--no-warnings', '-e', "const {server}=require('./server'); server.on('listening',()=>console.log('READY '+server.address().port));"], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0', DATA_DIR: dir, OLLAMA_HOST: 'http://127.0.0.1:9', COMFYUI_URL: 'http://127.0.0.1:9', NOVA_LIBRARY_DIR: path.join(dir, 'library') }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = ''; const t = setTimeout(() => reject(new Error('no start: ' + out)), 15000);
      child.stdout.on('data', d => { out += d; const m = /READY (\d+)/.exec(out); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
      child.stderr.on('data', d => { out += d; });
    });
    const base = `http://127.0.0.1:${port}`, H = { Origin: base, 'Content-Type': 'application/json' };
    const j = async (p, o = {}) => { const r = await fetch(base + p, { headers: H, ...o }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const dev = (await j('/api/device')).body;
    assert.equal(dev.device.class, 'workstation');
    assert.ok(!JSON.stringify(dev).includes('PRIVATE'));
    assert.ok(dev.classes.companion.authority.includes('approve'));
    assert.equal((await j('/api/devices')).body[0].self, true);
    assert.deepEqual((await j('/api/contracts/verify')).body, { ok: true, count: 0, head: null, open: 0 });
    assert.equal((await j('/api/store/executionContracts', { method: 'PUT', body: JSON.stringify({ id: 'x' }) })).status, 403);
    assert.equal((await j('/api/store/devices', { method: 'PUT', body: JSON.stringify({ id: 'dev_evil', class: 'workstation' }) })).status, 403);
    assert.equal((await j('/api/store/devices/' + dev.device.id, { method: 'DELETE' })).status, 403);
    assert.equal((await j('/api/contracts/ctr_nope/approval', { method: 'POST', body: JSON.stringify({ decision: 'allow' }) })).status, 404);

    // An approved workspace write runs as a contract and leaves sealed evidence.
    const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ctr-proj-')));
    fs.writeFileSync(path.join(proj, 'app.js'), 'const answer = 41;\n');
    const root = (await j('/api/workspace/roots', { method: 'POST', body: JSON.stringify({ path: proj }) })).body;
    const prop = (await j('/api/workspace/changes', { method: 'POST', body: JSON.stringify({ rootId: root.root ? root.root.id : root.id, relativePath: 'app.js', find: '41', replacement: '42' }) })).body;
    assert.equal((await j(`/api/workspace/changes/${prop.id}/check`, { method: 'POST' })).body.status, 'checks-passed');
    const early = await j(`/api/workspace/changes/${prop.id}/execute`, { method: 'POST' });
    assert.equal(early.status, 409, 'no write before approval');
    await j(`/api/workspace/changes/${prop.id}/approve`, { method: 'POST' });
    assert.equal((await j('/api/contracts?status=approved')).body.length, 1);
    assert.equal((await j(`/api/workspace/changes/${prop.id}/execute`, { method: 'POST' })).body.status, 'applied');
    assert.equal(fs.readFileSync(path.join(proj, 'app.js'), 'utf8'), 'const answer = 42;\n');
    const [w] = (await j('/api/contracts?capability=file.write')).body;
    assert.deepEqual([w.status, w.resource.id, w.approval.by.id, w.evidence.seq], ['completed', proj, 'local-operator', 1]);
    assert.equal((await j('/api/contracts/verify')).body.ok, true);
    fs.rmSync(proj, { recursive: true, force: true });
  } finally { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});
