'use strict';

const crypto = require('node:crypto');

const nowIso = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID()}`;

const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;

class ConnectorActionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ConnectorActionError';
    this.code = code || 'connector_action_error';
  }
}

/**
 * Wrap a connector so every operation is policy-gated.
 *
 * Flow:
 *   1. Load the profile. Refuse if not found, disabled, or revoked.
 *   2. Query the PolicyEngine:
 *        subject  = { type: 'connector', id: profileId }
 *        resource = { type: 'connector-action', id: opName }
 *      * allow                     → execute
 *      * deny  approval_required   → queue request, return {pending:true}
 *      * deny  anything else       → throw PolicyDeniedError
 *      * no policy engine          → execute (connector-level scopes still apply)
 *   3. When queued, the request sits in connector_action_requests
 *      until an operator approves or denies it.
 *   4. approve() executes the pending operation and stores the result.
 *      deny() marks it denied, no operation runs.
 *
 * The wrapped connector is injected so tests can use a fake.
 */
class ConnectorActions {
  constructor(deps) {
    deps = deps || {};
    if (!deps.store) throw new ConnectorActionError('store required', 'bad_store');
    if (!deps.registry) throw new ConnectorActionError('registry required', 'bad_registry');
    if (!deps.connector) throw new ConnectorActionError('connector required', 'bad_connector');
    this.store = deps.store;
    this.registry = deps.registry;
    this.connector = deps.connector;
    this.policy = deps.policy || null;
    this.audit = typeof deps.audit === 'function' ? deps.audit : null;
    this.expiryMs = Number.isFinite(deps.expiryMs) ? deps.expiryMs : DEFAULT_EXPIRY_MS;
    this.agentId = deps.agentId || 'connector-actions';
  }

  // ---- main entry ----

  async request(profileId, operation, args, operator) {
    if (!profileId) throw new ConnectorActionError('profileId required', 'bad_profile_id');
    if (!operation || typeof operation !== 'string') {
      throw new ConnectorActionError('operation required', 'bad_operation');
    }
    if (!operator || typeof operator !== 'string' || !operator.trim()) {
      throw new ConnectorActionError('operator required', 'bad_operator');
    }
    if (typeof this.connector[operation] !== 'function') {
      throw new ConnectorActionError('connector has no operation ' + operation, 'unknown_operation');
    }

    const profile = this.registry.get(profileId);
    if (!profile) throw new ConnectorActionError('profile not found', 'not_found');
    if (profile.revoked_at) throw new ConnectorActionError('profile revoked', 'revoked');
    if (profile.enabled !== 1) throw new ConnectorActionError('profile disabled', 'disabled');

    const decision = this._decide(profileId, operation);

    if (decision === 'deny') {
      throw new ConnectorActionError(
        'policy denied ' + operation + ' for ' + profileId,
        'policy_denied'
      );
    }

    if (decision === 'allow') {
      const result = await this._execute(profile, operation, args || []);
      return { status: 'executed', result };
    }

    // decision === 'approval_required'
    const requestId = uid('car');
    const expiresAt = new Date(Date.now() + this.expiryMs).toISOString();
    const row = this.store.connectorActionRequestsInsert({
      id: requestId,
      profile_id: profile.id,
      connector_kind: profile.kind,
      operation,
      args_json: JSON.stringify(args || []),
      status: 'pending',
      policy_id: decision.policyId || null,
      requested_at: nowIso(),
      requested_by: operator.trim(),
      expires_at: expiresAt,
    });
    this._audit('requested', { request_id: requestId, profile_id: profile.id, operation }, operator);
    return { status: 'pending', requestId, request: row };
  }

  // ---- resolution ----

  async approve(requestId, operator, note) {
    if (!operator) throw new ConnectorActionError('operator required', 'bad_operator');
    const row = this._resolve(requestId, 'approved', operator, note);
    const profile = this.registry.get(row.profile_id);
    if (!profile) {
      return this._finish(row.id, 'failed', null, 'profile_not_found');
    }
    const args = safeParse(row.args_json, []);
    try {
      const result = await this._execute(profile, row.operation, args);
      return this._finish(row.id, 'executed', result, null);
    } catch (e) {
      return this._finish(row.id, 'failed', null, String(e.message || e));
    }
  }

  deny(requestId, operator, note) {
    if (!operator) throw new ConnectorActionError('operator required', 'bad_operator');
    const row = this._resolve(requestId, 'denied', operator, note);
    this._audit('denied', { request_id: requestId, operator }, operator);
    return row;
  }

  // ---- reads ----

  list(filter) { return this.store.connectorActionRequestsList(filter || {}); }
  pending() { return this.store.connectorActionRequestsList({ status: 'pending' }); }
  get(id) { return this.store.connectorActionRequestsGet(id); }

  // ---- internals ----

  _decide(profileId, operation) {
    if (!this.policy) return 'allow';
    let r;
    try {
      r = this.policy.check(
        { type: 'connector', id: profileId },
        { type: 'connector-action', id: operation }
      );
    } catch {
      return 'deny';
    }
    if (r.allowed) return 'allow';
    if (r.reason === 'approval_required') {
      return Object.assign('approval_required', { policyId: r.policyId });
    }
    return 'deny';
  }

  async _execute(profile, operation, args) {
    const fn = this.connector[operation];
    return await fn.call(this.connector, profile.id, ...args);
  }

  _resolve(requestId, status, operator, note) {
    const cur = this.store.connectorActionRequestsGet(requestId);
    if (!cur) throw new ConnectorActionError('request not found', 'not_found');
    if (cur.status !== 'pending') {
      throw new ConnectorActionError('request already ' + cur.status, 'not_pending');
    }
    if (cur.expires_at && new Date(cur.expires_at).getTime() < Date.now()) {
      this.store.connectorActionRequestsUpdate(requestId, {
        status: 'expired', resolved_at: nowIso(),
      });
      throw new ConnectorActionError('request expired', 'expired');
    }
    return this.store.connectorActionRequestsUpdate(requestId, {
      status,
      resolved_at: nowIso(),
      resolved_by: operator,
      resolution_note: note || null,
    });
  }

  _finish(id, status, result, error) {
    const row = this.store.connectorActionRequestsUpdate(id, {
      status,
      executed_at: nowIso(),
      result_json: result == null ? null : JSON.stringify(result),
      error: error || null,
    });
    this._audit('executed', {
      request_id: id,
      status,
      error: error || null,
    }, row.resolved_by || 'system');
    return row;
  }

  _audit(kind, data, operator) {
    if (!this.audit) return;
    try {
      this.audit({ action: 'connector_action.' + kind, operator: operator || 'system', ...data });
    } catch { /* best-effort */ }
  }
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

module.exports = { ConnectorActions, ConnectorActionError };
