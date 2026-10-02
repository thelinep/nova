'use strict';
/* ===========================================================================
 * Maataa AAI evidence records (roadmap R1)
 *
 * Every derivation, form check and Ask answer becomes an execution contract
 * (lib/contracts.js) with the capability 'knowledge.verify' at risk 'read':
 *
 *   PLAN         what was asked, which engine and which edition of the texts
 *   APPROVAL     the policy rule 'aai.read-only' (rule checks change nothing)
 *   OBSERVATION  the full result, kept as its SHA-256 (the result itself is
 *                stored in 'aaiEvidence', keyed by the contract id)
 *   VERIFICATION the rule checks: each step names a real sutra, each cited
 *                sutra exists and is quoted correctly
 *   EVIDENCE     sealed, chained to the previous contract, signed with this
 *                device's Ed25519 key
 *
 * A record can be:
 *   replayed   derivations and form checks are run again and must give the
 *              same result hash; for Ask the model is not run again (its
 *              answers vary), but its citations are checked again by rule;
 *   exported   as one JSON file that anyone can check without this
 *              workstation: result hash, record hash, signature, and the
 *              citation checks redone from the sutra text.
 *
 * The verdict (derived, derivable, citations-verified, contradicted …) is the
 * finding. A contradicted answer seals as 'failed' because its citations
 * failed the rule checks; the record of that failure is itself the evidence.
 * ========================================================================= */
const contracts = require('./contracts');
const devices = require('./device-identity');
const panini = require('./panini');

const STORE = 'aaiEvidence';
const FORMAT = 'maataa-aai-evidence/1';
const KINDS = ['derive-verb', 'derive-noun', 'check-form', 'ask'];
const { canonical, sha256 } = devices;

function error(message, statusCode = 400, code) { return Object.assign(new Error(message), { statusCode, code }); }

/** The result as it is hashed: no timings, no evidence block of its own. */
function stable(result) {
  const r = JSON.parse(JSON.stringify(result || {}));
  delete r.durationMs; delete r.evidence;
  return r;
}
function resultHash(result) { return sha256(canonical(stable(result))); }

function verdictOf(kind, r) {
  if (kind === 'ask') return r.verdict;
  if (kind === 'check-form') return r.derivable ? 'derivable' : 'not-derived';
  return r.forms && r.forms.length ? 'derived' : 'no-form';
}

function intentOf(kind, request, r) {
  if (kind === 'derive-verb') return `Derive ${r.dhatu?.root || request.code} (${request.code}) · ${request.lakara} · ${request.purusha} ${request.vacana}`;
  if (kind === 'derive-noun') return `Derive ${r.stem || request.stem} · ${request.linga} · ${request.vibhakti} ${request.vacana}`;
  if (kind === 'check-form') return `Check the form ${r.claim} against ${request.stem ? 'the stem ' + request.stem : 'root ' + request.code + ' ' + (request.lakara || 'Lat')}`;
  return `Ask AAI (${r.model}): ${String(r.question || '').slice(0, 160)}`;
}

/** Each Ashtadhyayi step of each form must name a sutra that exists in the edition. */
function stepChecks(forms) {
  return (forms || []).map(f => {
    const steps = f.steps || [];
    const missing = steps.filter(s => s.source === 'Ashtadhyayi' && !panini.get(s.code)).map(s => s.code);
    return { name: `${f.text}: every step names a known rule`, ok: missing.length === 0, detail: missing.length ? 'Unknown sutra: ' + missing.join(', ') : `${steps.length} steps` };
  });
}

/** A citation passes when the number exists and any quoted words are that sutra's ('number' = number only, no quote). */
function citationChecks(citations) {
  return (citations || []).map(c => ({ name: `citation ${c.id}`, ok: c.status === 'ok' || c.status === 'number', detail: c.status + (c.expected ? ' · ' + c.expected : '') }));
}

function checksFor(kind, r) {
  if (kind === 'ask') return citationChecks(r.citations);
  if (kind === 'check-form') {
    const cells = (r.table?.grid || []).reduce((n, row) => n + row.reduce((m, cell) => m + cell.length, 0), 0);
    return [{ name: 'the rules derived the full table', ok: cells > 0, detail: `${cells} forms` }];
  }
  const list = stepChecks(r.forms);
  return list.length ? list : [{ name: 'the rule engine answered', ok: true, detail: 'no form for this choice' }];
}

function summaryOf(kind, r, verdict) {
  if (kind === 'ask') return `${verdict}: ${(r.citations || []).length} citation(s) checked`;
  if (kind === 'check-form') return `${verdict}: ${r.claim}`;
  return `${verdict}: ${(r.forms || []).map(f => f.text).join(', ') || '—'}`;
}

/**
 * Seals one AAI result as an evidence record. engine = aai.engineInfo() (null for Ask).
 * Returns { contract, seq, recordHash, resultSha256, verdict, status }.
 */
function record(store, dataDir, { kind, request = {}, result, engine = null }) {
  if (!KINDS.includes(kind)) throw error('Unknown evidence kind: ' + kind);
  const r = stable(result);
  const verdict = verdictOf(kind, r);
  const src = panini.info().source;
  const c = contracts.open(store, dataDir, {
    actor: kind === 'ask' ? { type: 'agent', id: r.model, label: r.model } : { type: 'system', id: 'aai-rules', label: 'Maataa AAI rules' },
    surface: 'desktop', intent: intentOf(kind, request, r), context: { aai: kind },
    capability: 'knowledge.verify', resource: { type: 'aai', id: kind },
    plan: { kind, request: JSON.parse(JSON.stringify(request)), engine: engine ? { ...engine } : null, texts: { edition: src.name, commit: src.commit, sutrapathaSha256: src.sutrapatha_sha256 } },
    risk: 'read',
  });
  contracts.autoApprove(store, dataDir, c.id, 'AAI rule checks only read; they change nothing.', 'aai.read-only');
  contracts.begin(store, c.id, { adapter: kind === 'ask' ? 'aai.model+rules' : 'aai.vidyut' });
  const text = canonical(r);
  contracts.observe(store, c.id, { ok: true, summary: summaryOf(kind, r, verdict), output: text });
  contracts.verify(store, c.id, checksFor(kind, r));
  const sealed = contracts.seal(store, dataDir, c.id);
  store.put(STORE, { id: c.id, kind, verdict, createdAt: sealed.createdAt, result: r });
  return { contract: c.id, seq: sealed.evidence.seq, recordHash: sealed.evidence.recordHash, resultSha256: sha256(text), verdict, status: sealed.status };
}

function payload(store, id) {
  const rec = store.get(STORE, String(id || ''));
  if (!rec) throw error('Unknown evidence record.', 404, 'unknown_evidence');
  return rec;
}

function list(store, { limit = 50, kind = null } = {}) {
  return store.all(STORE)
    .filter(r => !kind || r.kind === kind)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 50)))
    .map(r => {
      let c = null; try { c = contracts.get(store, r.id); } catch (_) {}
      return { id: r.id, kind: r.kind, verdict: r.verdict, createdAt: r.createdAt, intent: c?.intent || null, status: c?.status || 'missing', seq: c?.evidence?.seq || null, recordHash: c?.evidence?.recordHash || null };
    });
}

/** One record with its contract; intact = the stored result still has the sealed hash. */
function get(store, id) {
  const rec = payload(store, id), c = contracts.get(store, id);
  return { record: rec, contract: c, intact: !!c.observation && resultHash(rec.result) === c.observation.outputSha256 };
}

/** A self-contained file: contract, result and the signing device's public key. */
function bundle(store, dataDir, id) {
  const { record: rec, contract: c } = get(store, id);
  if (!c.evidence) throw error('This record has not been sealed.', 409);
  const dev = devices.get(store, dataDir, c.evidence.device);
  return { format: FORMAT, exportedAt: new Date().toISOString(), contract: c, result: rec.result, device: { id: dev.id, name: dev.name, class: dev.class, algorithm: 'ed25519', publicKey: dev.publicKey },
    howToVerify: 'sha256(canonical(result)) must equal contract.observation.outputSha256; sha256(canonical({seq, prevHash, sealedAt, contract without evidence and updatedAt})) must equal contract.evidence.recordHash; the Ed25519 signature over recordHash must verify with device.publicKey, whose fingerprint is contract.evidence.device. canonical = JSON with sorted keys.' };
}

/** Checks an exported file on its own. Position in the chain can only be checked on the device that sealed it. */
function verifyBundle(b) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
  if (!b || b.format !== FORMAT || !b.contract || !b.contract.evidence) { add('format', false, 'Not a Maataa AAI evidence file.'); return { ok: false, checks }; }
  const c = b.contract, e = c.evidence;
  add('format', true, FORMAT);
  add('result matches the sealed hash', !!c.observation && resultHash(b.result) === c.observation.outputSha256);
  const { evidence, updatedAt, ...rest } = c;
  add('record is unchanged since it was sealed', sha256(canonical({ seq: e.seq, prevHash: e.prevHash, sealedAt: e.sealedAt, contract: rest })) === e.recordHash);
  let fp = null; try { fp = devices.fingerprint(b.device?.publicKey); } catch (_) {}
  add('public key belongs to the sealing device', fp && fp === e.device, fp || 'no valid key');
  add('signature is valid', fp && devices.verify(b.device.publicKey, e.recordHash, e.signature));
  const kind = c.plan?.kind;
  if (kind === 'ask') {
    const again = panini.checkCitations(String(b.result?.answer || ''));
    const same = canonical(again.map(x => [x.id, x.status])) === canonical((b.result?.citations || []).map(x => [x.id, x.status]));
    add('citations checked again by rule give the same result', same, `${again.length} citation(s)`);
  } else if (kind === 'derive-verb' || kind === 'derive-noun') {
    const bad = stepChecks(b.result?.forms).filter(x => !x.ok);
    add('every cited sutra exists in this edition', bad.length === 0, bad.map(x => x.detail).join('; '));
  }
  if (c.plan?.texts?.commit && panini.info().source.commit !== c.plan.texts.commit) add('same edition of the texts', false, `sealed with ${c.plan.texts.commit}, checked with ${panini.info().source.commit}`);
  return { ok: checks.every(x => x.ok), checks, contract: c.id, seq: e.seq, verdict: c.observation?.summary || null };
}

/** Runs a record again. aai = lib/aai. Derivations must reproduce the same result hash. */
async function replay(store, aai, id) {
  const { record: rec, contract: c } = get(store, id);
  const req = c.plan.request || {};
  const engineThen = c.plan.engine || null;
  if (rec.kind === 'ask') {
    const again = panini.checkCitations(String(rec.result.answer || ''));
    const agree = canonical(again.map(x => [x.id, x.status])) === canonical((rec.result.citations || []).map(x => [x.id, x.status]));
    return { id, kind: rec.kind, reproduced: null, citationsAgree: agree, detail: agree ? 'The model is not run again (its answers vary). Its citations, checked again by rule, give the same result.' : 'The citations, checked again by rule, now give a different result.' };
  }
  const fresh = rec.kind === 'derive-verb' ? await aai.deriveVerb(req) : rec.kind === 'derive-noun' ? await aai.deriveNoun(req) : await aai.checkForm(req);
  const engineNow = await aai.engineInfo().catch(() => null);
  const reproduced = resultHash(fresh) === c.observation.outputSha256;
  return { id, kind: rec.kind, reproduced, engineThen, engineNow, verdictThen: rec.verdict, verdictNow: verdictOf(rec.kind, fresh),
    detail: reproduced ? 'Run again, the rules give exactly the same result.' : (engineThen?.version !== engineNow?.version ? `The result differs; the engine changed from ${engineThen?.version} to ${engineNow?.version}.` : 'The result differs from the sealed one.') };
}

module.exports = { STORE, FORMAT, KINDS, record, list, get, bundle, verifyBundle, replay, resultHash };
