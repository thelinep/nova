'use strict';
/* Radheya: the board's rules, its three kinds of worker, and learning with human approval. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, Store } = require('../lib/db');
const security = require('../lib/desktop-security');
const { createRadheya } = require('../lib/radheya');
const tensor = require('../lib/radheya-tensor');
const model = require('../lib/radheya-model');

function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-radheya-'));
  const { db } = openDb(dir), store = new Store(db);
  const calls = [];
  const ollama = { chatFull: async (name, messages) => { calls.push({ name, messages }); return { message: { content: `answer from ${name}` } }; } };
  const r = createRadheya({ store, dataDir: dir, ollama, security, evolveInline: true, ...extra });
  return { dir, db, store, r, calls, close: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('a card moves through the board; Done needs a person, Review and evidence', () => {
  const s = setup();
  try {
    const c = s.r.createCard({ title: 'Find sunrise time in Delhi', body: 'Today' });
    assert.equal(c.column, 'backlog');
    s.r.move(c.id, 'ready'); s.r.move(c.id, 'doing'); s.r.move(c.id, 'review');
    assert.throws(() => s.r.move(c.id, 'done', 'agent'), /Only a person/);
    s.r.addNote(c.id, 'Looks like 06:24', 'agent:local');
    assert.throws(() => s.r.move(c.id, 'done'), /Notes are not evidence/);
    s.r.addEvidence(c.id, { kind: 'link', url: 'https://example.org/sunrise' });
    assert.equal(s.r.move(c.id, 'done').column, 'done');
    const types = s.r.events().map(e => e.type);
    assert.deepEqual(types, ['created', 'moved', 'moved', 'moved', 'note_added', 'evidence_added', 'moved']);
  } finally { s.close(); }
});

test('WIP limits are enforced on every move', () => {
  const s = setup();
  try {
    s.r.saveSettings({ wip: { doing: 1 } });
    const a = s.r.createCard({ title: 'A', column: 'ready' }), b = s.r.createCard({ title: 'B', column: 'ready' });
    s.r.move(a.id, 'doing');
    assert.throws(() => s.r.move(b.id, 'doing'), /WIP limit/);
    assert.throws(() => s.r.saveSettings({ wip: { doing: 'many' } }), /whole number/);
  } finally { s.close(); }
});

test('a local run writes a note and run evidence, then waits in Review', async () => {
  const s = setup();
  try {
    const c = s.r.createCard({ title: 'Summarise the plan', column: 'ready' });
    s.r.updateCard(c.id, { assignee: { kind: 'local', model: 'qwen2.5-coder:7b' } });
    const { run, done } = s.r.startRun(c.id);
    assert.equal(run.status, 'running');
    assert.throws(() => s.r.startRun(c.id), /already has a run/);
    await done;
    const card = s.r.view().cards[0];
    assert.equal(card.column, 'review');
    assert.equal(card.notes.at(-1).by, 'agent:local');
    assert.equal(card.evidence[0].kind, 'run');
    assert.equal(s.calls[0].name, 'qwen2.5-coder:7b');
    assert.match(s.calls[0].messages[1].content, /Summarise the plan/);
    assert.equal(s.r.getRun(run.id).status, 'passed');
    assert.deepEqual(s.r.events().filter(e => e.type.startsWith('run')).map(e => [e.type, e.result || null]), [['run_started', null], ['run_finished', 'pass']]);
  } finally { s.close(); }
});

test('the browser opens only sites the card allows, then the local model answers from the page', async () => {
  const opened = [];
  const browser = {
    domainAllowed: () => false,
    open: async (url, opts) => { opened.push({ url, opts }); return { pageId: 'p1', url, title: 'Sunrise', image: 'radheya/shot.png' }; },
    read: async () => ({ text: 'Sunrise in Delhi: 06:24 AM' }),
    close: async () => ({ ok: true }),
  };
  const s = setup({ browser });
  try {
    const c = s.r.createCard({ title: 'Sunrise in Delhi today?', column: 'ready' });
    await s.r.startRun(c.id, { kind: 'browser', query: 'Delhi sunrise time' }).done;
    assert.equal(opened.length, 0, 'nothing was opened');
    let card = s.r.view().cards[0];
    assert.match(card.notes.at(-1).text, /may not open html.duckduckgo.com/);
    s.r.updateCard(c.id, { allowedDomains: 'duckduckgo.com' });
    const { done } = s.r.startRun(c.id, { kind: 'browser', query: 'Delhi sunrise time', model: 'llama3:latest' });
    await done;
    card = s.r.view().cards[0];
    assert.equal(opened[0].url, 'https://html.duckduckgo.com/html/?q=Delhi%20sunrise%20time');
    assert.deepEqual(opened[0].opts.policy.grants, ['duckduckgo.com']);
    assert.match(s.calls[0].messages[1].content, /06:24 AM/);
    assert.deepEqual(card.evidence.map(e => e.kind), ['run', 'browser-shot']);
    assert.equal(card.column, 'review');
  } finally { s.close(); }
});

test('an online agent needs the card\'s permission, network access and a stored key; the audit holds a hash', async () => {
  const sent = [];
  const order = [];
  const fetchImpl = async (url, opts) => { order.push('fetch'); sent.push({ url, opts }); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'online answer' } }] }) }; };
  const auditSecurity = { ...security, appendAudit(dataDir, event) { order.push(event.action); return security.appendAudit(dataDir, event); } };
  const s = setup({ fetchImpl, security: auditSecurity });
  try {
    assert.throws(() => s.r.saveSettings({ online: { provider: 'openai', baseUrl: 'http://insecure.example', model: 'm', apiKey: 'k' } }), /https/);
    s.r.saveSettings({ online: { provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'gpt-x', apiKey: 'sk-test' } });
    order.length = 0; // Exclude the earlier key-storage audit from the send-order assertion.
    assert.equal(s.r.board().online.secretId, 'radheya-online-key');
    assert.equal(JSON.stringify(s.r.board()).includes('sk-test'), false, 'the key is never stored in the board');
    const c = s.r.createCard({ title: 'Draft an outline', column: 'ready' });
    await s.r.startRun(c.id, { kind: 'online' }).done;
    assert.match(s.r.view().cards[0].notes.at(-1).text, /not allowed to go to an online agent/);
    s.r.move(c.id, 'ready');
    s.r.updateCard(c.id, { allowOnline: true });
    await s.r.startRun(c.id, { kind: 'online' }).done;
    assert.match(s.r.view().cards[0].notes.at(-1).text, /network access/);
    s.store.put('preferences', { id: 'default', webAccess: true });
    s.r.move(c.id, 'ready');
    await s.r.startRun(c.id, { kind: 'online' }).done;
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://api.example.com/v1/chat/completions');
    assert.equal(sent[0].opts.headers.authorization, 'Bearer sk-test');
    assert.deepEqual(order, ['radheya.online.send_attempt', 'fetch', 'radheya.online.response'], 'persist the request hash before contacting the provider');
    assert.equal(s.r.view().cards[0].column, 'review');
    const log = security.readAudit(s.dir).map(r => r.event).find(e => e.action === 'radheya.online.send_attempt');
    assert.match(log.requestSha256, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(log).includes('Draft an outline'), false);
  } finally { s.close(); }
});

test('an online request is not sent when the pre-send audit cannot be persisted', async () => {
  let sends = 0;
  const failingSecurity = { ...security, appendAudit() { throw new Error('disk unavailable'); } };
  const s = setup({ security: failingSecurity, fetchImpl: async () => { sends++; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'should not arrive' } }] }) }; } });
  try {
    s.r.saveSettings({ online: { provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'gpt-x', apiKey: 'sk-test' } });
    const c = s.r.createCard({ title: 'Draft an outline', column: 'ready', allowOnline: true });
    s.store.put('preferences', { id: 'default', webAccess: true });
    const { run, done } = s.r.startRun(c.id, { kind: 'online' });
    await done;
    assert.equal(sends, 0);
    assert.equal(s.r.getRun(run.id).status, 'failed');
    assert.match(s.r.getRun(run.id).error, /audit logging failed.*request was not sent/i);
  } finally { s.close(); }
});

function workCards(s, n, seed = 3) {
  const rand = tensor.rng(seed);
  let t = Date.parse('2026-10-01T00:00:00Z');
  const clock = () => { t += 60000 * (1 + Math.floor(rand() * 20)); return new Date(t).toISOString(); };
  for (let i = 0; i < n; i++) {
    const kind = ['local', 'browser', 'human'][Math.floor(rand() * 3)];
    const cardId = 'card_sim_' + i;
    const put = e => s.store.put('radheyaEvents', { id: 'ev_' + i + '_' + e.type + '_' + Math.floor(rand() * 1e9), at: clock(), cardId, assigneeKind: kind, ...e });
    put({ type: 'created', to: 'backlog' }); put({ type: 'assigned' }); put({ type: 'moved', to: 'ready' }); put({ type: 'moved', to: 'doing' });
    for (let k = 0; k < 3; k++) { put({ type: 'run_started' }); const fail = rand() < (kind === 'browser' ? 0.7 : 0.2); put({ type: 'run_finished', result: fail ? 'fail' : 'pass' }); if (!fail) break; }
    put({ type: 'moved', to: 'review' }); put({ type: 'moved', to: rand() < 0.8 ? 'done' : 'doing' });
  }
}

test('learning: a proposal is only used after approval, and rollback returns to the baseline', async () => {
  const s = setup();
  try {
    assert.throws(() => s.r.startEvolution(), /at least 20 events/);
    workCards(s, 120);
    const { done } = s.r.startEvolution({ limit: 1, maxSteps: 400 });
    const p = await done;
    assert.equal(p.status, 'proposed');
    assert.ok(p.baseline.loss > 0 && p.candidates.length === 2);
    assert.equal(s.r.modelStatus().active, null, 'nothing is active before approval');
    const m = s.r.decide(p.id, 'approve', 'hemant');
    assert.equal(s.r.modelStatus().active.id, m.id);
    assert.throws(() => s.r.decide(p.id, 'approve'), /already decided/);
    const c = s.r.createCard({ title: 'new', column: 'ready' });
    const pred = s.r.predictions().cards[c.id];
    assert.ok(pred.baseline && pred.learned, 'both learners predict');
    assert.equal(s.r.rollback().rolledBack, m.id);
    assert.equal(s.r.modelStatus().active, null);
  } finally { s.close(); }
});

test('tensor gradients match numerical gradients', () => {
  const m = tensor.createTransformer(7, { d: 8, heads: 2, layers: 2, ctx: 6, ff: 2 }, 3);
  const ids = [1, 3, 2, 5, 0], tg = [3, 2, 5, 0, -1];
  const loss = () => tensor.crossEntropy(tensor.forward(m, ids), tg);
  const ps = tensor.parameters(m); for (const t of ps) t.grad = new Float64Array(t.size);
  tensor.backward(loss());
  let worst = 0;
  for (const t of ps) for (let k = 0; k < 4; k++) {
    const i = Math.floor(k * t.size / 4), o = t.data[i];
    t.data[i] = o + 1e-5; const a = loss().data[0]; t.data[i] = o - 1e-5; const b = loss().data[0]; t.data[i] = o;
    const num = (a - b) / 2e-5, an = t.grad[i];
    if (Math.abs(num) > 1e-6) worst = Math.max(worst, Math.abs(num - an) / (Math.abs(num) + Math.abs(an)));
  }
  assert.ok(worst < 1e-4, 'worst relative gradient error ' + worst);
});

test('model: mutations stay within limits and saved weights reload identically', () => {
  const muts = model.mutations({ d: 32, heads: 2, layers: 1, ctx: 16, ff: 2 }).map(m => m.change);
  assert.deepEqual(muts, ['width 32 → 64', 'width 32 → 16', 'heads 2 → 4', 'layers 1 → 2', 'context 16 → 32']);
  assert.throws(() => tensor.validConfig({ d: 30, heads: 4 }), /divisible/);
  const m = tensor.createTransformer(5, { d: 8, heads: 2, ctx: 4 }, 9), back = tensor.deserialize(tensor.serialize(m));
  const a = tensor.forward(m, [0, 1, 2]).data, b = tensor.forward(back, [0, 1, 2]).data;
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-4);
});
