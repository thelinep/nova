'use strict';
/* ===========================================================================
 * Execution contracts: one governed record for every action
 *
 * NOVA Everywhere uses the same contract on every surface (desktop now;
 * mobile, web, edge and robots later). Each governed action walks it:
 *
 *   ACTOR → DEVICE → INTENT → CONTEXT → CAPABILITY → PLAN → POLICY → RISK
 *     → BUDGET → APPROVAL → EXECUTION → OBSERVATION → VERIFICATION → EVIDENCE
 *
 * Rules this module enforces:
 *  - A device must have declared the capability. A capability is not an
 *    authorization: actions above 'read' risk also need an approval.
 *  - The plan is hashed when the contract opens. An approval names that
 *    hash, carries a one-time nonce and expires; it is signed by the device
 *    that gave it (this workstation for approvals given in NOVA here, a
 *    paired phone later). If the plan changes, the approval no longer fits.
 *  - An approval is consumed when execution begins and cannot be reused.
 *  - When a contract ends it is sealed: its hash is chained to the previous
 *    sealed contract and signed by this device. verifyChain() detects an
 *    edited, removed or reordered record.
 * ========================================================================= */
const crypto = require('node:crypto');
const devices = require('./device-identity');

const STORE = 'executionContracts';
const STAGES = ['actor', 'device', 'intent', 'context', 'capability', 'plan', 'policy', 'risk', 'budget', 'approval', 'execution', 'observation', 'verification', 'evidence'];
/** Risk tiers, low to high. Anything above 'read' needs an approval (from a person or a policy rule). */
const RISKS = ['read', 'change', 'run', 'network', 'spend', 'physical'];
const APPROVAL_TTL_MS = 10 * 60 * 1000;
const FINAL = new Set(['completed', 'failed', 'denied', 'cancelled', 'expired']);

function error(message, statusCode = 400, code) { return Object.assign(new Error(message), { statusCode, code }); }
function now() { return new Date().toISOString(); }
const { canonical, sha256 } = devices;

/** What a plan commits to: the capability, the resource and the plan itself. */
function planHash(c) { return sha256(canonical({ capability: c.capability, resource: c.resource, plan: c.plan })); }
/** The exact text an approving device signs. */
function approvalPayload(c, decision) { return canonical({ contract: c.id, planHash: c.planHash, nonce: c.challenge.nonce, expiresAt: c.challenge.expiresAt, decision }); }
function needsApproval(risk) { return RISKS.indexOf(risk) > 0; }

function get(store, id) {
  const c = store.get(STORE, String(id || ''));
  if (!c) throw error('Unknown contract.', 404, 'unknown_contract');
  return c;
}
function save(store, c) { c.updatedAt = now(); store.put(STORE, c); return c; }
function clip(v, n) { return v == null ? null : String(v).slice(0, n); }

/** ACTOR … RISK: opens a contract. Throws when the device has not declared the capability. */
function open(store, dataDir, input = {}) {
  const me = devices.ensure(store, dataDir);
  const device = devices.get(store, dataDir, input.deviceId || me.id);
  const capability = String(input.capability || '');
  if (!devices.CAPABILITIES[capability]) throw error('Unknown capability: ' + capability, 400, 'unknown_capability');
  if (device.status === 'revoked') throw error('This device has been revoked.', 403, 'device_revoked');
  if (!(device.capabilities || []).includes(capability)) throw error(`${device.name} has not declared the capability ${capability}.`, 403, 'capability_not_declared');
  const risk = RISKS.includes(input.risk) ? input.risk : 'change';
  const actor = { type: ['human', 'agent', 'automation', 'system'].includes(input.actor?.type) ? input.actor.type : 'agent', id: clip(input.actor?.id || 'nova', 120), label: clip(input.actor?.label || input.actor?.id || 'Maataa', 120) };
  if (input.actor?.onBehalfOf) actor.onBehalfOf = clip(input.actor.onBehalfOf, 120);
  const c = {
    id: 'ctr_' + Date.now().toString(36) + crypto.randomBytes(5).toString('hex'), v: 1, surface: clip(input.surface || 'desktop', 20), status: 'planned',
    createdAt: now(), updatedAt: null,
    actor, device: { id: device.id, class: device.class, name: device.name },
    intent: clip(input.intent || '', 500), context: input.context && typeof input.context === 'object' ? JSON.parse(JSON.stringify(input.context)) : {},
    capability, resource: { type: clip(input.resource?.type || 'none', 40), id: clip(input.resource?.id || '', 500) },
    plan: input.plan && typeof input.plan === 'object' ? JSON.parse(JSON.stringify(input.plan)) : { summary: clip(input.plan || '', 2000) },
    planHash: null, policy: null, risk, budget: input.budget ? JSON.parse(JSON.stringify(input.budget)) : null,
    challenge: { nonce: crypto.randomBytes(16).toString('hex'), expiresAt: new Date(Date.now() + (input.ttlMs || APPROVAL_TTL_MS)).toISOString() },
    approval: null, execution: null, observation: null, verification: null, evidence: null, links: input.links ? { ...input.links } : {},
  };
  c.planHash = planHash(c);
  return save(store, c);
}

/** POLICY: the rule that decided. 'deny' ends the contract. */
function recordPolicy(store, dataDir, id, { decision = 'ask', reason = '', rule = null } = {}) {
  const c = get(store, id);
  if (FINAL.has(c.status)) throw error('This contract has ended.', 409);
  c.policy = { decision: ['allow', 'deny', 'ask'].includes(decision) ? decision : 'ask', reason: clip(reason, 300), rule: clip(rule, 120), at: now() };
  if (c.policy.decision === 'deny') { c.status = 'denied'; save(store, c); return seal(store, dataDir, c.id, 'denied'); }
  if (c.policy.decision === 'ask') c.status = 'awaiting-approval';
  return save(store, c);
}

/** What a device needs in order to approve: the plan, its hash, the nonce and the deadline. */
function challenge(store, id) {
  const c = get(store, id);
  return { contract: c.id, status: c.status, intent: c.intent, capability: c.capability, resource: c.resource, plan: c.plan, risk: c.risk, planHash: c.planHash, nonce: c.challenge.nonce, expiresAt: c.challenge.expiresAt, sign: { allow: approvalPayload(c, 'allow'), deny: approvalPayload(c, 'deny') } };
}

/**
 * APPROVAL. by: { deviceId, human, signature, planHash, via }.
 * Without deviceId (or with this device's id) the approval was given in NOVA on this
 * workstation and is signed here. Any other device must be registered, have the
 * 'approve' authority, name the same plan hash and sign approvalPayload().
 */
function approve(store, dataDir, id, decision, by = {}) {
  const c = get(store, id);
  const d = decision === 'allow' || decision === 'approve' ? 'allow' : 'deny';
  if (FINAL.has(c.status) || c.approval) throw error('This request was already answered.', 409, 'already_answered');
  if (Date.parse(c.challenge.expiresAt) < Date.now()) { c.status = 'expired'; save(store, c); seal(store, dataDir, c.id, 'expired'); throw error('This request has expired.', 410, 'expired'); }
  if (planHash(c) !== c.planHash) throw error('The plan changed after it was proposed.', 409, 'plan_changed');
  const me = devices.self(dataDir);
  const device = devices.get(store, dataDir, by.deviceId || me.id);
  if (!devices.can(device, 'approve')) throw error(`${device.name} may not approve actions.`, 403, 'not_an_approver');
  let signature;
  if (device.id === me.id) signature = devices.sign(dataDir, approvalPayload(c, d));
  else {
    if (by.planHash !== c.planHash) throw error('The approval is for a different plan.', 409, 'plan_mismatch');
    if (!devices.verify(device.publicKey, approvalPayload(c, d), by.signature)) throw error('The approval signature is not valid.', 403, 'bad_signature');
    signature = String(by.signature);
  }
  c.approval = { decision: d, by: { type: 'human', id: clip(by.human || (device.id === me.id ? 'local-operator' : device.human || 'unknown'), 120) }, device: { id: device.id, class: device.class, name: device.name }, via: clip(by.via || (device.id === me.id ? 'nova-desktop' : device.class), 40), planHash: c.planHash, nonce: c.challenge.nonce, signature, at: now(), consumedAt: null };
  c.status = d === 'allow' ? 'approved' : 'denied';
  save(store, c);
  if (d === 'deny') return seal(store, dataDir, c.id, 'denied');
  return c;
}

/** APPROVAL by a policy rule (read-only actions, "always allow in this chat"). Recorded, never signed by a person. */
function autoApprove(store, dataDir, id, reason, rule = null) {
  const c = get(store, id);
  if (FINAL.has(c.status) || c.approval) throw error('This request was already answered.', 409, 'already_answered');
  c.policy = c.policy || { decision: 'allow', reason: clip(reason, 300), rule: clip(rule, 120), at: now() };
  c.approval = { decision: 'allow', by: { type: 'policy', id: clip(rule || 'policy', 120) }, reason: clip(reason, 300), planHash: c.planHash, nonce: c.challenge.nonce, at: now(), consumedAt: null };
  c.status = 'approved';
  return save(store, c);
}

/** EXECUTION begins: the plan must be unchanged and the approval unused (when the risk needs one). */
function begin(store, id, info = {}) {
  const c = get(store, id);
  if (planHash(c) !== c.planHash) throw error('The plan changed after approval. Stopped.', 409, 'plan_changed');
  if (needsApproval(c.risk)) {
    if (!c.approval || c.approval.decision !== 'allow' || c.status !== 'approved') throw error('This action needs an approval first.', 403, 'approval_required');
    if (c.approval.consumedAt) throw error('This approval was already used.', 409, 'approval_used');
    if (c.approval.planHash !== c.planHash || c.approval.nonce !== c.challenge.nonce) throw error('The approval does not match this plan.', 409, 'plan_mismatch');
  } else if (FINAL.has(c.status)) throw error('This contract has ended.', 409);
  if (c.approval) c.approval.consumedAt = now();
  c.execution = { adapter: clip(info.adapter || 'desktop.process', 60), startedAt: now(), finishedAt: null };
  c.status = 'executing';
  return save(store, c);
}

/** OBSERVATION: what happened. Output is kept as a hash and a short excerpt. */
function observe(store, id, { ok = true, summary = '', output = '', error: err = null } = {}) {
  const c = get(store, id);
  if (c.execution && !c.execution.finishedAt) c.execution.finishedAt = now();
  const text = String(output || '');
  c.observation = { ok: !!ok, summary: clip(summary, 500), outputSha256: text ? sha256(text) : null, excerpt: text ? text.slice(0, 600) : null, error: err ? clip(err, 500) : null, at: now() };
  return save(store, c);
}

/** VERIFICATION: checks that the outcome is what the plan promised. */
function verify(store, id, checks = []) {
  const c = get(store, id);
  const list = (Array.isArray(checks) ? checks : []).slice(0, 30).map(x => ({ name: clip(x.name, 120), ok: !!x.ok, detail: clip(x.detail || '', 300) }));
  c.verification = { ok: list.every(x => x.ok), checks: list, at: now() };
  return save(store, c);
}

// The chain head per store, worked out once from the sealed contracts.
const heads = new WeakMap();
function head(store) {
  if (!heads.has(store)) {
    let top = { seq: 0, hash: null };
    for (const c of store.all(STORE)) if (c.evidence && c.evidence.seq > top.seq) top = { seq: c.evidence.seq, hash: c.evidence.recordHash };
    heads.set(store, top);
  }
  return heads.get(store);
}
function body(c) { const { evidence, updatedAt, ...rest } = c; return rest; }

/** EVIDENCE: ends the contract, chains it to the previous one and signs it with this device's key. */
function seal(store, dataDir, id, status) {
  const c = get(store, id);
  if (c.evidence) return c;
  c.status = FINAL.has(status) ? status : (c.observation ? (c.observation.ok && (!c.verification || c.verification.ok) ? 'completed' : 'failed') : 'cancelled');
  if (c.execution && !c.execution.finishedAt) c.execution.finishedAt = now();
  const h = head(store), me = devices.self(dataDir);
  const seq = h.seq + 1, sealedAt = now();
  const recordHash = sha256(canonical({ seq, prevHash: h.hash, sealedAt, contract: body(c) }));
  c.evidence = { seq, prevHash: h.hash, recordHash, sealedAt, device: me.id, signature: devices.sign(dataDir, recordHash) };
  heads.set(store, { seq, hash: recordHash });
  return save(store, c);
}

/** Checks every sealed contract: hash, link to the one before, and the signing device's signature. */
function verifyChain(store, dataDir) {
  const sealed = store.all(STORE).filter(c => c.evidence).sort((a, b) => a.evidence.seq - b.evidence.seq);
  let prev = null, expectSeq = 1;
  for (const c of sealed) {
    const e = c.evidence;
    const fail = reason => ({ ok: false, count: sealed.length, brokenAt: { seq: e.seq, contract: c.id }, reason });
    if (e.seq !== expectSeq) return fail(e.seq > expectSeq ? `Contract ${expectSeq} is missing.` : 'Contracts are numbered twice.');
    if (e.prevHash !== prev) return fail('The link to the previous contract is broken.');
    if (sha256(canonical({ seq: e.seq, prevHash: e.prevHash, sealedAt: e.sealedAt, contract: body(c) })) !== e.recordHash) return fail('The record was changed after it was sealed.');
    let dev; try { dev = devices.get(store, dataDir, e.device); } catch (_) { return fail('The signing device is unknown.'); }
    if (!devices.verify(dev.publicKey, e.recordHash, e.signature)) return fail('The signature does not match.');
    if (c.approval && c.approval.signature && c.approval.device) {
      let ad; try { ad = devices.get(store, dataDir, c.approval.device.id); } catch (_) { return fail('The approving device is unknown.'); }
      const payload = canonical({ contract: c.id, planHash: c.approval.planHash, nonce: c.approval.nonce, expiresAt: c.challenge.expiresAt, decision: c.approval.decision });
      if (!devices.verify(ad.publicKey, payload, c.approval.signature)) return fail('The approval signature does not match.');
    }
    prev = e.recordHash; expectSeq++;
  }
  return { ok: true, count: sealed.length, head: prev, open: store.all(STORE).filter(c => !c.evidence).length };
}

/** Links a contract to the request it governs (for example a pending approval in chat). Not part of the plan hash. */
function link(store, id, links) { const c = get(store, id); c.links = { ...(c.links || {}), ...links }; return save(store, c); }

function list(store, { status = null, limit = 100, capability = null, sessionId = null } = {}) {
  return store.all(STORE)
    .filter(c => (!status || c.status === status) && (!capability || c.capability === capability) && (!sessionId || c.context?.sessionId === sessionId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
}

/** Contracts left open by a restart (approval never answered, execution interrupted) are sealed as cancelled. */
function sweep(store, dataDir) {
  let n = 0;
  for (const c of store.all(STORE)) if (!c.evidence) { seal(store, dataDir, c.id, 'cancelled'); n++; }
  return n;
}

module.exports = { STORE, STAGES, RISKS, open, link, recordPolicy, challenge, approve, autoApprove, begin, observe, verify, seal, verifyChain, list, get, sweep, planHash, approvalPayload, needsApproval, _resetHeads: s => heads.delete(s) };
