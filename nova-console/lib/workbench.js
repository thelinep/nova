'use strict';

const nowIso = () => new Date().toISOString();

class WorkbenchError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WorkbenchError';
    this.code = code || 'workbench_error';
  }
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

class Workbench {
  constructor(store, options) {
    options = options || {};
    if (!store) throw new WorkbenchError('store required', 'bad_store');
    this.store = store;
    this.recentFailuresLimit = Number.isFinite(options.recentFailuresLimit) ? options.recentFailuresLimit : 10;
    this.recentOutcomesLimit = Number.isFinite(options.recentOutcomesLimit) ? options.recentOutcomesLimit : 10;
    this.now = options.now || nowIso;
  }

  snapshot() {
    return {
      generated_at: this.now(),
      now:      this._now(),
      allowed:  this._allowed(),
      waiting:  this._waiting(),
      failed:   this._failed(),
      created:  this._created(),
      system:   this._system(),
      approvals: this._approvals(),
      pipeline:  this._pipeline(),
      agents:    this._agents(),
    };
  }

  _now() {
    const queued = safe(() => this.store.jobsListByState('queued'), []);
    const running = safe(() => this.store.jobsListByState('running'), []);
    const nowMs = Date.now();
    const nextRunAt = queued.map((j) => new Date(j.run_at).getTime()).filter((t) => Number.isFinite(t)).sort((a, b) => a - b)[0];
    return {
      queued: queued.length,
      running: running.length,
      next_run_at: nextRunAt ? new Date(nextRunAt).toISOString() : null,
      next_run_in_ms: nextRunAt ? Math.max(0, nextRunAt - nowMs) : null,
      running_jobs: running.map((j) => ({ id: j.id, kind: j.kind, started_at: j.started_at, heartbeat_at: j.heartbeat_at, timeout_at: j.timeout_at, attempts: j.attempts })),
    };
  }

  _allowed() {
    const policies = safe(() => this.store.policiesList({}), []);
    const nowMs = Date.now();
    const active = policies.filter((p) => {
      if (p.revoked_at) return false;
      if (p.expires_at && new Date(p.expires_at).getTime() <= nowMs) return false;
      return true;
    });
    const budgets = safe(() => this.store.budgetsList({}), []);
    const budgetPosture = budgets.map((b) => {
      let limits = {};
      try { limits = JSON.parse(b.limits_json); } catch { limits = {}; }
      const since = this._startOfWindow(b.window);
      const usage = {};
      for (const kind of Object.keys(limits)) {
        usage[kind] = {
          limit: limits[kind],
          used: safe(() => this.store.budgetConsumptionSum(b.subject_type, b.subject_id, kind, since), 0),
        };
      }
      return { id: b.id, subject: { type: b.subject_type, id: b.subject_id }, window: b.window, revoked: !!b.revoked_at, usage };
    });
    let halted = false;
    let haltStatus = null;
    if (typeof this.store.getGlobalHalt === 'function') halted = this.store.getGlobalHalt() === '1';
    if (halted) haltStatus = safe(() => { const events = this.store.killSwitchEventsList({ action: 'halt' }); return events[events.length - 1] || null; }, null);
    return {
      kill_switch: { halted, reason: haltStatus ? haltStatus.reason : null, operator: haltStatus ? haltStatus.operator : null, since: haltStatus ? haltStatus.timestamp : null },
      policies: { total: policies.length, active: active.length, revoked: policies.filter((p) => !!p.revoked_at).length, expired: policies.filter((p) => p.expires_at && new Date(p.expires_at).getTime() <= nowMs && !p.revoked_at).length },
      budgets: budgetPosture,
    };
  }

  _startOfWindow(window) {
    const d = new Date();
    if (window === 'hour') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())).toISOString();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
  }

  _waiting() {
    const pendingQuarantines = safe(() => this.store.quarantinesList({ status: 'pending' }), []);
    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    const recentDenials = safe(() => this.store.policyDecisionsList({}).filter((d) => d.decision === 'deny' && d.timestamp >= oneHourAgo), []);
    return {
      pending_quarantines: pendingQuarantines.length,
      quarantines: pendingQuarantines.map((q) => ({ id: q.id, domain: q.domain, reason: q.reason, task_id: q.task_id, created_at: q.created_at })),
      recent_policy_denials_1h: recentDenials.length,
      recent_denials: recentDenials.slice(-10).map((d) => ({ id: d.id, subject: { type: d.subject_type, id: d.subject_id }, resource: { type: d.resource_type, id: d.resource_id }, reason: d.reason, timestamp: d.timestamp })),
    };
  }

  _failed() {
    const failedJobs = safe(() => this.store.jobsListByState('failed'), []);
    const timedOutJobs = safe(() => this.store.jobsListByState('timed_out'), []);
    const rollbacks = safe(() => this.store.rollbackEventsList({}), []);
    const recentRollbacks = rollbacks.slice(-this.recentFailuresLimit).reverse();
    return {
      failed_jobs: failedJobs.length,
      timed_out_jobs: timedOutJobs.length,
      recent_rollbacks: recentRollbacks.map((r) => ({ id: r.id, domain: r.domain, reason: r.reason, from_sha: r.from_sha, to_sha: r.to_sha, outcome: r.outcome, quarantine_id: r.quarantine_id, timestamp: r.timestamp })),
      failed_jobs_recent: failedJobs.slice(-this.recentFailuresLimit).reverse().map((j) => ({ id: j.id, kind: j.kind, error: j.error, attempts: j.attempts, ended_at: j.ended_at })),
    };
  }

  _created() {
    const greenCommits = safe(() => this.store.greenCommitsList(), []);
    const completedJobs = safe(() => this.store.jobsListByState('completed'), []);
    const lineage = safe(() => this.store.autonomyLineageList({}), []);
    const approvedRuns = lineage.filter((r) => { try { const payload = JSON.parse(r.payload_json || '{}'); return payload.status === 'approved'; } catch { return false; } });
    return {
      green_commits: greenCommits.map((g) => ({ domain: g.domain, sha: g.sha, set_at: g.set_at, set_by: g.set_by })),
      completed_jobs: completedJobs.length,
      autonomy_runs_approved: approvedRuns.length,
      recent_completions: completedJobs.slice(-this.recentOutcomesLimit).reverse().map((j) => ({ id: j.id, kind: j.kind, ended_at: j.ended_at })),
    };
  }


  // ---- Unified approval queue ----
  _approvals() {
    const quarantines = safe(
      () => this.store.quarantinesList({ status: 'pending' }),
      []
    );
    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    const denials = safe(
      () => this.store.policyDecisionsList({}).filter(
        (d) => d.decision === 'deny' && d.timestamp >= oneHourAgo
      ),
      []
    );

    const items = [];
    for (const q of quarantines) {
      items.push({
        kind: 'quarantine',
        id: q.id,
        subject: q.domain,
        title: q.reason || '(no reason)',
        created_at: q.created_at,
        actions: ['apply', 'discard'],
        ref: { quarantine_id: q.id, task_id: q.task_id || null },
      });
    }
    for (const d of denials) {
      items.push({
        kind: 'policy_denial',
        id: d.id,
        subject: d.subject_type + ':' + d.subject_id,
        title: 'denied → ' + d.resource_type + ':' + d.resource_id,
        created_at: d.timestamp,
        actions: ['review'],
        ref: { decision_id: d.id, reason: d.reason },
      });
    }
    const connectorActions = safe(
      () => this.store.connectorActionRequestsList({ status: 'pending' }),
      []
    );
    for (const ca of connectorActions) {
      items.push({
        kind: 'connector_action',
        id: ca.id,
        subject: ca.connector_kind + ':' + String(ca.profile_id).slice(0, 8),
        title: ca.operation,
        created_at: ca.requested_at,
        actions: ['approve', 'deny'],
        ref: {
          request_id: ca.id,
          profile_id: ca.profile_id,
          operation: ca.operation,
          requested_by: ca.requested_by,
          expires_at: ca.expires_at || null,
        },
      });
    }
    items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

    return {
      total: items.length,
      items: items.slice(0, 50),
    };
  }

  // ---- Recent pipeline runs ----
  _pipeline() {
    const cap = 5;
    const correctness = safe(
      () => this.store.correctnessPipelineRunsList({})
        .slice(-cap).reverse().map((r) => ({
          id: r.id,
          status: r.status,
          stage: r.stage,
          winner_id: r.constellation_winner_id,
          consistency_ok: r.consistency_ok == null ? null : !!r.consistency_ok,
          proof_ok: r.proof_ok == null ? null : !!r.proof_ok,
          started_at: r.started_at,
          ended_at: r.ended_at,
        })),
      []
    );
    const constellations = safe(
      () => this.store.constellationRunsList({})
        .slice(-cap).reverse().map((r) => ({
          id: r.id,
          status: r.status,
          candidate_count: r.candidate_count,
          winner_id: r.winner_id,
          started_at: r.started_at,
          ended_at: r.ended_at,
        })),
      []
    );
    const clover = safe(
      () => this.store.cloverVerificationsList({})
        .slice(-cap).reverse().map((r) => ({
          id: r.id,
          status: r.status,
          consistency_ok: r.consistency_ok == null ? null : !!r.consistency_ok,
          proof_ok: r.proof_ok == null ? null : !!r.proof_ok,
          proof_attempts: r.proof_attempts,
          started_at: r.started_at,
          ended_at: r.ended_at,
        })),
      []
    );
    return {
      recent_correctness: correctness,
      recent_constellations: constellations,
      recent_clover: clover,
    };
  }


  // ---- Agents ----
  _agents() {
    const cap = 6;

    const registry = safe(
      () => this.store.agentRegistryList({ active: true }),
      []
    );
    const byRole = {};
    for (const a of registry) byRole[a.role] = (byRole[a.role] || 0) + 1;

    const tasksByState = safe(() => {
      const rows = this.store.agentTasksList({});
      const out = {};
      for (const r of rows) out[r.state] = (out[r.state] || 0) + 1;
      return out;
    }, {});

    const recentTasks = safe(
      () => this.store.agentTasksList({})
        .slice(0, cap).map((r) => ({
          id: r.id,
          title: r.title,
          state: r.state,
          creator_id: r.creator_id,
          assignee_id: r.assignee_id,
          parent_task_id: r.parent_task_id,
          handoff_count: r.handoff_count,
          created_at: r.created_at,
          updated_at: r.updated_at,
        })),
      []
    );

    const pendingEscalations = safe(
      () => this.store.agentEscalationsList({ state: 'pending' }),
      []
    );
    const escalationsByKind = {};
    for (const e of pendingEscalations) {
      escalationsByKind[e.kind] = (escalationsByKind[e.kind] || 0) + 1;
    }

    const recentEscalations = safe(
      () => this.store.agentEscalationsList({ state: 'pending' })
        .slice(0, cap).map((r) => ({
          id: r.id,
          kind: r.kind,
          summary: r.summary,
          escalator_id: r.escalator_id,
          reviewer_id: r.reviewer_id,
          tool_kind: r.tool_kind || null,
          tool_id: r.tool_id || null,
          tool_operation: r.tool_operation || null,
          created_at: r.created_at,
          expires_at: r.expires_at || null,
          parent_escalation_id: r.parent_escalation_id || null,
        })),
      []
    );

    const recentMemory = safe(
      () => this.store.agentMemoryList({ not_expired: true })
        .slice(0, cap).map((r) => ({
          id: r.id,
          agent_id: r.agent_id,
          kind: r.kind,
          scope: r.scope,
          created_at: r.created_at,
        })),
      []
    );

    return {
      registry: {
        total: registry.length,
        enabled: registry.filter((a) => a.enabled === 1).length,
        with_supervisor: registry.filter((a) => a.supervisor_id).length,
        by_role: byRole,
      },
      tasks: {
        by_state: tasksByState,
        recent: recentTasks,
      },
      escalations: {
        pending_total: pendingEscalations.length,
        by_kind: escalationsByKind,
        recent: recentEscalations,
      },
      memory: {
        recent: recentMemory,
      },
    };
  }

  _system() {
    const checks = [
      { id: 'jobs', label: 'Job engine', ok: typeof this.store.jobsListByState === 'function' },
      { id: 'policy', label: 'Policy engine', ok: typeof this.store.policiesList === 'function' },
      { id: 'budgets', label: 'Budgets', ok: typeof this.store.budgetsList === 'function' },
      { id: 'kill_switch', label: 'Kill switch', ok: typeof this.store.killSwitchEventsList === 'function' },
      { id: 'audit', label: 'Audit chain', ok: typeof this.store.autonomyLineageList === 'function' },
      { id: 'rollback', label: 'Rollback manager', ok: typeof this.store.greenCommitsList === 'function' },
    ];
    return { ok: checks.every((c) => c.ok), checks };
  }
}

module.exports = { Workbench, WorkbenchError };
