'use strict';
/* Maataa AAI evidence records (R1): sealed, chained, signed, replayable, exportable. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const devices = require('../lib/device-identity');
const contracts = require('../lib/contracts');
const evidence = require('../lib/aai-evidence');
const aai = require('../lib/aai');
const { openDb, Store } = require('../lib/db');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-aai-ev-'));
  devices._reset();
  const { db } = openDb(dir);
  const store = new Store(db);
  contracts._resetHeads(store);
  return { dir, store, done: () => { db.close(); devices._reset(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// A model answer as lib/aai.ask returns it (no model needed for these tests).
function askResult(answer) {
  const panini = require('../lib/panini');
  const citations = panini.checkCitations(answer);
  const bad = citations.filter(c => c.status === 'unknown' || c.status === 'mismatch');
  const verdict = bad.length ? 'contradicted' : citations.some(c => c.status === 'ok') ? 'citations-verified' : 'unverified';
  return { question: 'भवति में कौन-सा सूत्र गुण करता है?', model: 'guru-maataa:test', answer, grounding: [], citations, verdict, explanation: '', proposedBy: 'model', durationMs: 1234 };
}

test('the workstation declares knowledge.verify, so AAI contracts can open', () => {
  const t = setup();
  try {
    const me = devices.ensure(t.store, t.dir);
    assert.ok(me.capabilities.includes('knowledge.verify'));
    assert.ok(devices.CLASS_CAPABILITIES.workstation.includes('knowledge.verify'));
    assert.ok(!devices.CLASS_CAPABILITIES.interface.includes('knowledge.verify'));
  } finally { t.done(); }
});

test('an Ask answer with a correct citation is sealed, signed and chained', () => {
  const t = setup();
  try {
    const r = askResult('गुण 7.3.84 सार्वधातुकार्धधातुकयोः से होता है।');
    assert.equal(r.verdict, 'citations-verified');
    const ev = evidence.record(t.store, t.dir, { kind: 'ask', request: { question: r.question, model: r.model }, result: r });
    assert.equal(ev.verdict, 'citations-verified');
    assert.equal(ev.status, 'completed');
    assert.equal(ev.seq, 1);
    const c = contracts.get(t.store, ev.contract);
    assert.equal(c.capability, 'knowledge.verify');
    assert.equal(c.risk, 'read');
    assert.equal(c.approval.by.type, 'policy');
    assert.equal(c.actor.id, 'guru-maataa:test');
    assert.ok(c.verification.ok);
    assert.equal(contracts.verifyChain(t.store, t.dir).ok, true);
    const got = evidence.get(t.store, ev.contract);
    assert.equal(got.intact, true);
    assert.equal(got.record.result.durationMs, undefined, 'timings are not part of the sealed result');
  } finally { t.done(); }
});

test('a wrong citation seals as failed: the failed check is the evidence', () => {
  const t = setup();
  try {
    const r = askResult('यहाँ 6.1.87 इको यणचि लगता है।');
    assert.equal(r.verdict, 'contradicted');
    const ev = evidence.record(t.store, t.dir, { kind: 'ask', request: {}, result: r });
    assert.equal(ev.status, 'failed');
    const c = contracts.get(t.store, ev.contract);
    assert.equal(c.verification.ok, false);
    assert.ok(c.verification.checks.some(x => x.name === 'citation 6.1.87' && !x.ok));
    assert.equal(contracts.verifyChain(t.store, t.dir).ok, true);
  } finally { t.done(); }
});

test('an exported file verifies on its own, and any edit is caught', () => {
  const t = setup();
  try {
    const r = askResult('गुण 7.3.84 सार्वधातुकार्धधातुकयोः से होता है।');
    const ev = evidence.record(t.store, t.dir, { kind: 'ask', request: {}, result: r });
    const b = JSON.parse(JSON.stringify(evidence.bundle(t.store, t.dir, ev.contract)));
    assert.equal(b.format, evidence.FORMAT);
    assert.doesNotMatch(JSON.stringify(b), /PRIVATE KEY/);
    const ok = evidence.verifyBundle(b);
    assert.equal(ok.ok, true, JSON.stringify(ok.checks));

    const editedAnswer = JSON.parse(JSON.stringify(b)); editedAnswer.result.answer += ' और 6.1.87 भी।';
    const v1 = evidence.verifyBundle(editedAnswer);
    assert.equal(v1.ok, false);
    assert.equal(v1.checks.find(x => x.name === 'result matches the sealed hash').ok, false);

    const editedVerdict = JSON.parse(JSON.stringify(b)); editedVerdict.contract.observation.summary = 'citations-verified: trust me';
    assert.equal(evidence.verifyBundle(editedVerdict).checks.find(x => x.name === 'record is unchanged since it was sealed').ok, false);

    const otherKey = JSON.parse(JSON.stringify(b));
    otherKey.device.publicKey = require('node:crypto').generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    const v3 = evidence.verifyBundle(otherKey);
    assert.equal(v3.checks.find(x => x.name === 'public key belongs to the sealing device').ok, false);
    assert.equal(v3.checks.find(x => x.name === 'signature is valid').ok, false);

    assert.equal(evidence.verifyBundle({ hello: 1 }).ok, false);
  } finally { t.done(); }
});

test('records are listed newest first, and the chain catches a removed record', () => {
  const t = setup();
  try {
    for (const a of ['7.3.84 सार्वधातुकार्धधातुकयोः', '6.1.78 एचोऽयवायावः', 'कोई सूत्र नहीं']) evidence.record(t.store, t.dir, { kind: 'ask', request: {}, result: askResult(a) });
    const rows = evidence.list(t.store, {});
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(r => r.seq).sort(), [1, 2, 3]);
    assert.ok(rows.every(r => /^Ask AAI \(guru-maataa:test\)/.test(r.intent)));
    assert.equal(rows.find(r => r.seq === 3).verdict, 'unverified');
    t.store.delete(contracts.STORE, rows.find(r => r.seq === 2).id);
    const chain = contracts.verifyChain(t.store, t.dir);
    assert.equal(chain.ok, false);
    assert.match(chain.reason, /missing|link/);
  } finally { t.done(); }
});

test('Ask replay re-checks the citations by rule without running the model', async () => {
  const t = setup();
  try {
    const ev = evidence.record(t.store, t.dir, { kind: 'ask', request: {}, result: askResult('7.3.84 सार्वधातुकार्धधातुकयोः') });
    const rp = await evidence.replay(t.store, aai, ev.contract);
    assert.equal(rp.reproduced, null);
    assert.equal(rp.citationsAgree, true);
  } finally { t.done(); }
});

test('derivations seal with their engine and replay to the same result hash', async t0 => {
  aai.configure({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'aai-ev-engine-')) });
  const st = await aai.status();
  if (!st.engine.installed) return t0.skip('Vidyut is not installed here');
  const t = setup();
  try {
    const engine = await aai.engineInfo();
    const verb = await aai.deriveVerb({ code: '01.0001', lakara: 'Lat', purusha: 'Prathama', vacana: 'Eka' });
    const ev = evidence.record(t.store, t.dir, { kind: 'derive-verb', request: verb.request, result: verb, engine });
    assert.equal(ev.verdict, 'derived');
    assert.equal(ev.status, 'completed');
    const c = contracts.get(t.store, ev.contract);
    assert.equal(c.plan.engine.version, engine.version);
    assert.match(c.plan.texts.commit, /^8da2f90/);
    assert.match(c.intent, /^Derive भू \(01\.0001\) · Lat · Prathama Eka/);
    assert.ok(c.verification.checks.every(x => x.ok));
    const rp = await evidence.replay(t.store, aai, ev.contract);
    assert.equal(rp.reproduced, true, rp.detail);

    const noun = await aai.deriveNoun({ stem: 'राम', linga: 'Pum', vibhakti: 'Trtiya', vacana: 'Eka' });
    const evn = evidence.record(t.store, t.dir, { kind: 'derive-noun', request: noun.request, result: noun, engine });
    assert.equal((await evidence.replay(t.store, aai, evn.contract)).reproduced, true);

    const chk = await aai.checkForm({ code: '01.0001', lakara: 'Lat', form: 'भवामि' });
    const evc = evidence.record(t.store, t.dir, { kind: 'check-form', request: { code: '01.0001', lakara: 'Lat', form: 'भवामि' }, result: chk, engine });
    assert.equal(evc.verdict, 'derivable');
    assert.equal((await evidence.replay(t.store, aai, evc.contract)).reproduced, true);

    const b = evidence.bundle(t.store, t.dir, ev.contract);
    const v = evidence.verifyBundle(JSON.parse(JSON.stringify(b)));
    assert.equal(v.ok, true, JSON.stringify(v.checks));
    assert.ok(v.checks.some(x => x.name === 'every cited sutra exists in this edition' && x.ok));

    // A stored result that was edited no longer replays to its sealed hash.
    const rec = t.store.get(evidence.STORE, ev.contract);
    rec.result.forms[0].text = 'भवतु';
    t.store.put(evidence.STORE, rec);
    assert.equal(evidence.get(t.store, ev.contract).intact, false);
    assert.equal(contracts.verifyChain(t.store, t.dir).ok, true, 'the contract itself is untouched');
  } finally { t.done(); }
});
