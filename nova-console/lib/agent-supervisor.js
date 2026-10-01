'use strict';

const crypto = require('node:crypto');

const nowIso = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID()}`;

const KINDS = [
  'tool_request', 'decision_review', 'uncertainty', 'override_request',
];
const STATES = ['pending', 'approved', 'denied', 'forwarded', 'withdrawn', 'expired'];
const OPEN_STATES = ['pending'];
const EVENT_KINDS = [
  'raised', 'approved', 'denied', 'forwarded', 'withdrawn', 'expired',
];

const DEFAULT_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000;

class AgentSupervisorError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AgentSupervisorError';
    this.code = code || 'agent_supervisor_error';
  }
}

/**
 * Supervisor review and escalation.
 *
 * An agent raises an escalation to its supervisor. The supervisor can
 * approve, deny, or forward to its own supervisor. Forwarding creates a
 * new escalation above the original; the original becomes 'forwarded'.
 *
 * Escalations are typed:
 *   tool_request      — "I need access to a tool I'm not permitted"
 *   decision_review   — "review this decision I made"
 *   uncertainty       — "I don't know how to proceed"
 *   override_request  — "override a policy denial for me"
 *
 * Optionally, an escalation can carry the M5 tool query that triggered
 * it (kind, tool_id, operation) for downstream auto-resolution.
 *
 * Visibility:
 *   - escalator sees everything they raised
 *   - reviewer sees everything they must decide
 *   - ancestors of the reviewer see the same (chain visibility)
 */
class AgentSupervisor {
  constructor(store, deps) {
    deps = deps || {};
    if (!store) throw new AgentSupervisorError('store required', 'bad_store');
    if (!deps.registry) throw new AgentSupervisorError('registry required', 'bad_registry');
    this.store = store;
    this.registry = deps.registry;
    this.expiryMs = Number.isFinite(deps.expiryMs) ? deps.expiryMs : DEFAULT_EXPIRY_MS;
    this.audit = typeof deps.audit === 'function' ? deps.audit : null;
  }

  // ---- raising ----

  escalate(input) {
    input = input || {};
    const escalator = this._agent(input.escalatorId, 'escalator');
    if (!KINDS.includes(input.kind)) {
      throw new AgentSupervisorError('unknown kind: ' + input.kind, 'bad_kind');
    }
    if (!input.summary || typeof input.summary !== 'string' || !input.summary.trim()) {
      throw new AgentSupervisorError('summary required', 'bad_summary');
    }
    if (input.expiresAt && Number.isNaN(new Date(input.expiresAt).getTime())) {
      throw new AgentSupervisorError('expiresAt must be ISO-8601', 'bad_expiry');
    }

    const reviewerId = input.reviewerId || escalator.supervisor_id;
    if (!reviewerId) {
      throw new AgentSupervisorError('escalator has no supervisor and no reviewerId given', 'no_reviewer');
    }
    if (reviewerId === escalator.id) {
      throw new AgentSupervisorError('escalator cannot review itself', 'self_review');
    }
    const reviewer = this.registry.get(reviewerId);
    if (!reviewer) throw new AgentSupervisorError('reviewer not found', 'reviewer_not_found');
    if (reviewer.revoked_at) throw new AgentSupervisorError('reviewer revoked', 'reviewer_revoked');
    if (reviewer.enabled !== 1) throw new AgentSupervisorError('reviewer disabled', 'reviewer_disabled');

    let parentEscalation = null;
    if (input.parentEscalationId) {
      parentEscalation = this.store.agentEscalationsGet(input.parentEscalationId);
      if (!parentEscalation) {
        throw new AgentSupervisorError('parent escalation not found', 'parent_not_found');
      }
    }

    const now = nowIso();
    const row = this.store.agentEscalationsInsert({
      id: input.id || uid('esc'),
      kind: input.kind,
      escalator_id: escalator.id,
      reviewer_id: reviewer.id,
      state: 'pending',
      summary: input.summary.trim(),
      detail_json: input.detail != null ? JSON.stringify(input.detail) : null,
      tool_kind: input.toolQuery ? input.toolQuery.kind || null : null,
      tool_id: input.toolQuery ? input.toolQuery.toolId || null : null,
      tool_operation: input.toolQuery ? input.toolQuery.operation || null : null,
      parent_escalation_id: input.parentEscalationId || null,
      created_at: now,
      updated_at: now,
      decided_at: null,
      expires_at: input.expiresAt || new Date(Date.now() + this.expiryMs).toISOString(),
      decision_note: null,
    });

    this._event(row.id, 'raised', {
      actor_id: escalator.id,
      payload: { kind: input.kind, reviewer_id: reviewer.id },
    });
    this._audit('raised', { escalation_id: row.id, escalator_id: escalator.id, reviewer_id: reviewer.id });
    return row;
  }

  // ---- deciding ----

  approve(escalationId, reviewerId, note) {
    return this._decide(escalationId, reviewerId, 'approved', note);
  }

  deny(escalationId, reviewerId, note) {
    return this._decide(escalationId, reviewerId, 'denied', note);
  }

  forward(escalationId, reviewerId, note) {
    const row = this._requireReviewer(escalationId, reviewerId);
    if (!note || typeof note !== 'string' || !note.trim()) {
      throw new AgentSupervisorError('forward reason required', 'bad_reason');
    }
    const reviewer = this.registry.get(reviewerId);
    const aboveId = reviewer.supervisor_id;
    if (!aboveId) {
      throw new AgentSupervisorError('reviewer has no supervisor to forward to', 'no_supervisor');
    }
    const above = this.registry.get(aboveId);
    if (!above) throw new AgentSupervisorError('target reviewer not found', 'target_not_found');
    if (above.revoked_at) throw new AgentSupervisorError('target reviewer revoked', 'target_revoked');
    if (above.enabled !== 1) throw new AgentSupervisorError('target reviewer disabled', 'target_disabled');

    // Close the original as forwarded
    const closed = this.store.agentEscalationsUpdate(escalationId, {
      state: 'forwarded',
      decided_at: nowIso(),
      decision_note: note.trim(),
      updated_at: nowIso(),
    });
    this._event(escalationId, 'forwarded', {
      actor_id: reviewerId,
      reason: note.trim(),
      payload: { forwarded_to: above.id },
    });

    // Raise a new escalation above
    const child = this.store.agentEscalationsInsert({
      id: uid('esc'),
      kind: row.kind,
      escalator_id: reviewerId,
      reviewer_id: above.id,
      state: 'pending',
      summary: row.summary,
      detail_json: row.detail_json,
      tool_kind: row.tool_kind,
      tool_id: row.tool_id,
      tool_operation: row.tool_operation,
      parent_escalation_id: row.id,
      created_at: nowIso(),
      updated_at: nowIso(),
      decided_at: null,
      expires_at: row.expires_at,
      decision_note: null,
    });
    this._event(child.id, 'raised', {
      actor_id: reviewerId,
      reason: 'forwarded from ' + row.id,
    });

    this._audit('forwarded', {
      escalation_id: escalationId,
      forwarded_to: above.id,
      child_id: child.id,
    });
    return { closed, child };
  }

  withdraw(escalationId, escalatorId, note) {
    const row = this._require(escalationId);
    if (row.escalator_id !== escalatorId) {
      throw new AgentSupervisorError('only the escalator can withdraw', 'not_escalator');
    }
    if (!OPEN_STATES.includes(row.state)) {
      throw new AgentSupervisorError('escalation is not open', 'not_open');
    }
    const updated = this.store.agentEscalationsUpdate(escalationId, {
      state: 'withdrawn',
      decided_at: nowIso(),
      decision_note: note || null,
      updated_at: nowIso(),
    });
    this._event(escalationId, 'withdrawn', { actor_id: escalatorId, reason: note || null });
    this._audit('withdrawn', { escalation_id: escalationId, actor_id: escalatorId });
    return updated;
  }

  // ---- reads ----

  get(id) {
    if (!id) throw new AgentSupervisorError('id required', 'bad_id');
    return this.store.agentEscalationsGet(id);
  }

  events(id) {
    if (!id) throw new AgentSupervisorError('id required', 'bad_id');
    return this.store.agentEscalationEventsList(id);
  }

  pending(reviewerId, filter) {
    filter = filter || {};
    return this.store.agentEscalationsList(Object.assign({}, filter, {
      reviewer_id: reviewerId, state: 'pending',
    }));
  }

  raised(escalatorId, filter) {
    filter = filter || {};
    return this.store.agentEscalationsList(Object.assign({}, filter, {
      escalator_id: escalatorId,
    }));
  }

  countsByState(agentId) {
    const raised = this.store.agentEscalationsList({ escalator_id: agentId });
    const review = this.store.agentEscalationsList({ reviewer_id: agentId });
    const out = { raised: {}, pending_review: 0 };
    for (const s of STATES) out.raised[s] = 0;
    for (const r of raised) out.raised[r.state] = (out.raised[r.state] || 0) + 1;
    for (const r of review) if (r.state === 'pending') out.pending_review += 1;
    return out;
  }

  // ---- internals ----

  _decide(escalationId, reviewerId, nextState, note) {
    const row = this._requireReviewer(escalationId, reviewerId);
    const updated = this.store.agentEscalationsUpdate(escalationId, {
      state: nextState,
      decided_at: nowIso(),
      decision_note: note || null,
      updated_at: nowIso(),
    });
    this._event(escalationId, nextState, { actor_id: reviewerId, reason: note || null });
    this._audit(nextState, { escalation_id: escalationId, reviewer_id: reviewerId });
    return updated;
  }

  _require(escalationId) {
    const row = this.store.agentEscalationsGet(escalationId);
    if (!row) throw new AgentSupervisorError('escalation not found', 'not_found');
    return row;
  }

  _requireReviewer(escalationId, reviewerId) {
    const row = this._require(escalationId);
    if (row.reviewer_id !== reviewerId) {
      throw new AgentSupervisorError('only the assigned reviewer can decide', 'not_reviewer');
    }
    if (row.state !== 'pending') {
      throw new AgentSupervisorError('escalation is not pending (state=' + row.state + ')', 'not_pending');
    }
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      this.store.agentEscalationsUpdate(escalationId, {
        state: 'expired',
        decided_at: nowIso(),
        updated_at: nowIso(),
      });
      throw new AgentSupervisorError('escalation expired', 'expired');
    }
    const reviewer = this.registry.get(reviewerId);
    if (!reviewer) throw new AgentSupervisorError('reviewer not found', 'reviewer_not_found');
    if (reviewer.revoked_at) throw new AgentSupervisorError('reviewer revoked', 'reviewer_revoked');
    if (reviewer.enabled !== 1) throw new AgentSupervisorError('reviewer disabled', 'reviewer_disabled');
    return row;
  }

  _agent(id, role) {
    if (!id) throw new AgentSupervisorError(role + 'Id required', 'bad_' + role + '_id');
    const a = this.registry.get(id);
    if (!a) throw new AgentSupervisorError(role + ' not found', role + '_not_found');
    if (a.revoked_at) throw new AgentSupervisorError(role + ' revoked', role + '_revoked');
    if (a.enabled !== 1) throw new AgentSupervisorError(role + ' disabled', role + '_disabled');
    return a;
  }

  _event(escalationId, kind, extra) {
    extra = extra || {};
    this.store.agentEscalationEventsInsert({
      id: uid('eevt'),
      escalation_id: escalationId,
      kind,
      actor_id: extra.actor_id || null,
      reason: extra.reason || null,
      payload_json: extra.payload != null ? JSON.stringify(extra.payload) : null,
      timestamp: nowIso(),
    });
  }

  _audit(kind, data) {
    if (!this.audit) return;
    try { this.audit({ action: 'agent_escalation.' + kind, ...data }); }
    catch { /* best-effort */ }
  }
}

module.exports = { AgentSupervisor, AgentSupervisorError, KINDS, STATES, EVENT_KINDS };
