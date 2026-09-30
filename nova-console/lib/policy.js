'use strict';

const crypto = require('node:crypto');

/**
 * Policy engine for NOVA.
 *
 * Every tool call, agent action, or store write passes through `check()`.
 * Default is deny. Explicit grants may allow. Explicit denies beat allows.
 * Every decision is written to `policy_decisions` with an input hash so
 * the audit trail is verifiable.
 *
 * Matching rules:
 *   subject_type  '*' matches anything
 *   subject_id    '*' matches anything
 *   resource_type '*' matches anything
 *   resource_id   '*' matches anything
 *   Deny beats allow at any specificity. Simpler and safer than trying to
 *   reason about specificity precedence.
 *
 * Conditions:
 *   requires_approval  boolean — denies with reason 'approval_required'
 *   max_per_day        integer — denies with reason 'rate_limit_exceeded'
 *                                after N allow decisions since UTC midnight
 *
 * Expiry: `expires_at` is ISO-8601. Expired grants are ignored and produce
 *         reason 'policy_expired' when they were the only match.
 *
 * Revocation: `revoked_at` is ISO-8601, set by `revoke()`. Revoked grants
 *             produce reason 'policy_revoked' when they were the only match.
 */

class PolicyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PolicyError';
    this.code = code || 'policy_error';
  }
}

class PolicyDeniedError extends PolicyError {
  constructor(message, reason, policyId) {
    super(message || 'Denied by policy.', 'policy_denied');
    this.name = 'PolicyDeniedError';
    this.reason = reason || 'policy_denied';
    this.policyId = policyId || null;
  }
}

const SCOPES = [
  'read_only',
  'workspace_write',
  'git_commit',
  'git_push',
  'github_pr',
  'secrets_read',
  'release_sign',
];

const nowIso = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID()}`;
const hash = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function startOfUtcDay(ms) {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

function matchField(patternValue, actual) {
  if (patternValue === '*') return true;
  return String(patternValue) === String(actual);
}

function matchPolicy(policy, subject, resource) {
  if (!matchField(policy.subject_type, subject.type)) return false;
  if (!matchField(policy.subject_id, subject.id)) return false;
  if (!matchField(policy.resource_type, resource.type)) return false;
  if (!matchField(policy.resource_id, resource.id)) return false;
  return true;
}

function isExpired(policy, nowMs) {
  if (!policy.expires_at) return false;
  return new Date(policy.expires_at).getTime() <= nowMs;
}

function isRevoked(policy) {
  return !!policy.revoked_at;
}

class PolicyEngine {
  constructor(store, options) {
    options = options || {};
    if (!store) throw new PolicyError('store required', 'bad_store');
    this.store = store;
    this.defaultEffect = options.defaultEffect === 'allow' ? 'allow' : 'deny';
  }

  grant(input) {
    if (!input || !input.subject || !input.resource) {
      throw new PolicyError('grant requires subject and resource', 'bad_input');
    }
    if (input.effect && input.effect !== 'allow' && input.effect !== 'deny') {
      throw new PolicyError('effect must be allow or deny', 'bad_effect');
    }
    if (input.scope && !SCOPES.includes(input.scope)) {
      throw new PolicyError(`unknown scope: ${input.scope}`, 'bad_scope');
    }
    const row = {
      id: input.id || uid('pol'),
      subject_type: input.subject.type || '*',
      subject_id: input.subject.id || '*',
      resource_type: input.resource.type || '*',
      resource_id: input.resource.id || '*',
      effect: input.effect || 'allow',
      scope: input.scope || null,
      conditions_json: input.conditions ? JSON.stringify(input.conditions) : null,
      expires_at: input.expiresAt || null,
      revoked_at: null,
      created_at: nowIso(),
      created_by: input.createdBy || 'system',
    };
    return this.store.policiesInsert(row);
  }

  grantMany(inputs) {
    if (!Array.isArray(inputs)) {
      throw new PolicyError('grantMany expects an array', 'bad_input');
    }
    return inputs.map((i) => this.grant(i));
  }

  revoke(policyId) {
    const cur = this.store.policiesGet(policyId);
    if (!cur) throw new PolicyError('policy not found', 'not_found');
    if (cur.revoked_at) return cur;
    return this.store.policiesUpdate(policyId, { revoked_at: nowIso() });
  }

  list(filter) {
    return this.store.policiesList(filter || {});
  }

  explain(subject, resource) {
    if (!subject || !subject.type || !subject.id) {
      throw new PolicyError('subject.type and subject.id required', 'bad_subject');
    }
    if (!resource || !resource.type || !resource.id) {
      throw new PolicyError('resource.type and resource.id required', 'bad_resource');
    }
    const nowMs = Date.now();
    const candidates = this.store.policiesList({});
    const matching = candidates.filter((p) => matchPolicy(p, subject, resource));
    return matching.map((p) => ({
      id: p.id,
      effect: p.effect,
      scope: p.scope,
      expired: isExpired(p, nowMs),
      revoked: isRevoked(p),
      active: !isExpired(p, nowMs) && !isRevoked(p),
      conditions: p.conditions_json ? safeParse(p.conditions_json) : null,
      expires_at: p.expires_at,
    }));
  }

  dailyUsage(policyId) {
    const since = startOfUtcDay(Date.now());
    return this.store.policyDecisionsCountSince(policyId, since);
  }

  snapshot() {
    return {
      policies: this.store.policiesList({}),
      generated_at: nowIso(),
    };
  }

  check(subject, resource, context) {
    context = context || {};
    if (!subject || !subject.type || !subject.id) {
      throw new PolicyError('subject.type and subject.id required', 'bad_subject');
    }
    if (!resource || !resource.type || !resource.id) {
      throw new PolicyError('resource.type and resource.id required', 'bad_resource');
    }

    const nowMs = Date.now();
    const candidates = this.store.policiesList({});
    const matching = candidates.filter((p) => matchPolicy(p, subject, resource));
    const active = matching.filter((p) => !isRevoked(p) && !isExpired(p, nowMs));

    let decision = 'deny';
    let reason = 'policy_denied';
    let policyId = null;

    const denyHit = active.find((p) => p.effect === 'deny');
    if (denyHit) {
      decision = 'deny';
      reason = 'policy_explicit_deny';
      policyId = denyHit.id;
    } else {
      const allowHit = active.find((p) => p.effect === 'allow');
      if (allowHit) {
        const cond = allowHit.conditions_json ? safeParse(allowHit.conditions_json) : null;
        if (cond && cond.requires_approval === true) {
          decision = 'deny';
          reason = 'approval_required';
          policyId = allowHit.id;
        } else if (cond && Number.isFinite(cond.max_per_day) && cond.max_per_day > 0) {
          const used = this.store.policyDecisionsCountSince(
            allowHit.id,
            startOfUtcDay(nowMs)
          );
          if (used >= cond.max_per_day) {
            decision = 'deny';
            reason = 'rate_limit_exceeded';
            policyId = allowHit.id;
          } else {
            decision = 'allow';
            reason = 'policy_allow';
            policyId = allowHit.id;
          }
        } else {
          decision = 'allow';
          reason = 'policy_allow';
          policyId = allowHit.id;
        }
      } else if (matching.length > 0) {
        const anyRevoked = matching.some((p) => isRevoked(p));
        const anyExpired = matching.some((p) => isExpired(p, nowMs));
        if (anyRevoked) {
          reason = 'policy_revoked';
        } else if (anyExpired) {
          reason = 'policy_expired';
        }
      }
    }

    const inputsHash = hash(JSON.stringify({
      subject,
      resource,
      context,
      bucket: Math.floor(nowMs / 1000),
    }));

    this.store.policyDecisionsInsert({
      id: uid('pd'),
      policy_id: policyId,
      subject_type: subject.type,
      subject_id: subject.id,
      resource_type: resource.type,
      resource_id: resource.id,
      decision,
      reason,
      inputs_hash: inputsHash,
      timestamp: nowIso(),
    });

    return { allowed: decision === 'allow', decision, reason, policyId };
  }

  enforce(subject, resource, context) {
    const result = this.check(subject, resource, context);
    if (!result.allowed) {
      throw new PolicyDeniedError(
        `Policy denied: ${result.reason}`,
        result.reason,
        result.policyId
      );
    }
    return result;
  }
}

module.exports = {
  PolicyEngine,
  PolicyError,
  PolicyDeniedError,
  SCOPES,
};
