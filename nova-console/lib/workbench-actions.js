'use strict';

const nowIso = () => new Date().toISOString();

class WorkbenchActionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WorkbenchActionError';
    this.code = code || 'workbench_action_error';
  }
}

/**
 * Operator-initiated actions on the workbench.
 *
 * Every action:
 *   - validates its inputs,
 *   - calls exactly one existing primitive,
 *   - writes an audit record to autonomy_lineage,
 *   - returns a structured result.
 *
 * The module does not own any state. It is a thin adapter between the
 * Workbench UI and the primitives that already exist.
 */
class WorkbenchActions {
  constructor(store, deps) {
    deps = deps || {};
    if (!store) throw new WorkbenchActionError('store required', 'bad_store');
    this.store = store;
    this.rollback = deps.rollback || null;
    this.jobs = deps.jobs || null;
    this.killSwitch = deps.killSwitch || null;
    this.policy = deps.policy || null;
  }

  _audit(action, data, operator) {
    const id = `wba_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    try {
      this.store.auditAppend({
        id,
        status: 'ok',
        domain: 'workbench',
        operator: operator || 'unknown',
        workbench_action: 'workbench.' + action,
        timestamp: nowIso(),
        ...data,
      });
    } catch { /* best-effort; the action itself already succeeded */ }
    return id;
  }

  _requireOperator(operator) {
    if (typeof operator !== 'string' || operator.trim().length === 0) {
      throw new WorkbenchActionError('operator required', 'bad_operator');
    }
    return operator.trim();
  }

  // ---- Quarantine ----

  resolveQuarantine(input) {
    if (!this.rollback) throw new WorkbenchActionError('rollback manager not configured', 'no_rollback');
    input = input || {};
    const operator = this._requireOperator(input.operator);
    if (!input.id) throw new WorkbenchActionError('quarantine id required', 'bad_id');
    if (input.decision !== 'applied' && input.decision !== 'discarded') {
      throw new WorkbenchActionError('decision must be applied or discarded', 'bad_decision');
    }

    const row = this.rollback.resolveQuarantine(
      input.id,
      input.decision,
      operator,
      input.note || null
    );

    const auditId = this._audit('quarantine.resolve', {
      quarantine_id: input.id,
      decision: input.decision,
      note: input.note || null,
    }, operator);

    return { ok: true, quarantine: row, audit_id: auditId };
  }

  // ---- Jobs ----

  cancelJob(input) {
    if (!this.jobs) throw new WorkbenchActionError('job engine not configured', 'no_jobs');
    input = input || {};
    const operator = this._requireOperator(input.operator);
    if (!input.id) throw new WorkbenchActionError('job id required', 'bad_id');

    const job = this.store.jobsGet(input.id);
    if (!job) throw new WorkbenchActionError('job not found', 'not_found');
    if (job.state !== 'queued' && job.state !== 'running') {
      throw new WorkbenchActionError('job is not cancellable in state ' + job.state, 'not_cancellable');
    }

    const updated = this.jobs.cancel(input.id);

    const auditId = this._audit('job.cancel', {
      job_id: input.id,
      kind: job.kind,
      previous_state: job.state,
    }, operator);

    return { ok: true, job: updated, audit_id: auditId };
  }

  // ---- Kill switch ----

  haltRuntime(input) {
    if (!this.killSwitch) throw new WorkbenchActionError('kill switch not configured', 'no_killswitch');
    input = input || {};
    const operator = this._requireOperator(input.operator);
    const reason = (input.reason || '').trim();
    if (!reason) throw new WorkbenchActionError('reason required', 'bad_reason');

    const event = this.killSwitch.halt(operator, reason);

    const auditId = this._audit('runtime.halt', {
      kill_switch_event_id: event.id,
      reason,
    }, operator);

    return { ok: true, event, audit_id: auditId };
  }

  resumeRuntime(input) {
    if (!this.killSwitch) throw new WorkbenchActionError('kill switch not configured', 'no_killswitch');
    input = input || {};
    const operator = this._requireOperator(input.operator);
    const reason = (input.reason || '').trim();
    if (!reason) throw new WorkbenchActionError('reason required', 'bad_reason');

    const event = this.killSwitch.resume(operator, reason, input.credential);

    const auditId = this._audit('runtime.resume', {
      kill_switch_event_id: event.id,
      reason,
    }, operator);

    return { ok: true, event, audit_id: auditId };
  }

  // ---- Policies ----

  revokePolicy(input) {
    if (!this.policy) throw new WorkbenchActionError('policy engine not configured', 'no_policy');
    input = input || {};
    const operator = this._requireOperator(input.operator);
    if (!input.id) throw new WorkbenchActionError('policy id required', 'bad_id');

    const row = this.policy.revoke(input.id);

    const auditId = this._audit('policy.revoke', {
      policy_id: input.id,
    }, operator);

    return { ok: true, policy: row, audit_id: auditId };
  }
}

module.exports = { WorkbenchActions, WorkbenchActionError };
