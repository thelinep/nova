'use strict';

const crypto = require('node:crypto');

/**
 * Bounded self-improvement loop for the Neuron Factory domain.
 *
 * Given a proposal generator and a training/eval pipeline, this module:
 *   1. Checks the kill switch (fail-closed)
 *   2. Checks policy (default-deny unless granted)
 *   3. Checks budget (tokens/usd/jobs)
 *   4. Trains via the supplied trainer
 *   5. Evaluates via the supplied evaluator
 *   6. Applies the acceptance threshold
 *   7. Auto-approves if all conditions met, otherwise quarantines
 *   8. Records full lineage for every outcome
 *
 * All side effects go through the injected dependencies so the loop can be
 * tested without a real trainer or filesystem.
 *
 * Domains: this module only operates on 'neuron-factory'. Cross-domain
 * autonomy lands in P6.
 */

const DOMAIN = 'neuron-factory';

class AutonomyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AutonomyError';
    this.code = code || 'autonomy_error';
  }
}

class EscalationError extends AutonomyError {
  constructor(reason, detail) {
    super(`Escalated: ${reason}`, 'escalated');
    this.name = 'EscalationError';
    this.escalation_reason = reason;
    this.detail = detail || null;
  }
}

const nowIso = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID()}`;

class AutonomyLoop {
  constructor(store, deps) {
    deps = deps || {};
    if (!store) throw new AutonomyError('store required', 'bad_store');
    if (typeof deps.trainer !== 'function') {
      throw new AutonomyError('trainer required', 'bad_trainer');
    }
    if (typeof deps.evaluator !== 'function') {
      throw new AutonomyError('evaluator required', 'bad_evaluator');
    }
    this.store = store;
    this.trainer = deps.trainer;
    this.evaluator = deps.evaluator;
    this.approver = typeof deps.approver === 'function' ? deps.approver : null;
    this.policy = deps.policy || null;
    this.budgets = deps.budgets || null;
    this.killSwitch = deps.killSwitch || null;
    this.rollback = deps.rollback || null;
    this.audit = typeof deps.audit === 'function' ? deps.audit : null;
    this.agentId = deps.agentId || 'neuron-factory';
    this.subject = { type: 'agent', id: this.agentId };
    this.resource = { type: 'domain', id: DOMAIN };
    this.defaults = {
      acceptanceThreshold: Number.isFinite(deps.acceptanceThreshold)
        ? deps.acceptanceThreshold
        : 0.85,
      maxConsecutiveFailures: Number.isFinite(deps.maxConsecutiveFailures)
        ? deps.maxConsecutiveFailures
        : 3,
    };
    this.consecutiveFailures = 0;
  }

  setThreshold(value) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new AutonomyError('threshold must be 0..1', 'bad_threshold');
    }
    this.defaults.acceptanceThreshold = value;
  }

  _preflight() {
    if (this.killSwitch && this.killSwitch.isHalted()) {
      throw new EscalationError('kill_switch_active', this.killSwitch.status());
    }
    if (this.policy) {
      try {
        this.policy.enforce(this.subject, this.resource);
      } catch (e) {
        throw new EscalationError('policy_denied', { reason: e.reason || e.message });
      }
    }
    if (this.budgets) {
      const r = this.budgets.check(this.subject);
      if (!r.ok) {
        throw new EscalationError('budget_exceeded', r.exceeded);
      }
    }
  }

  _recordLineage(row) {
    const id = uid('lin');
    this.store.auditAppend({
      id,
      action: 'autonomy.lineage',
      ...row,
      timestamp: nowIso(),
    });
    return id;
  }

  async runOnce(proposal) {
    if (!proposal || typeof proposal !== 'object') {
      throw new AutonomyError('proposal object required', 'bad_proposal');
    }
    const threshold = Number.isFinite(proposal.acceptanceThreshold)
      ? proposal.acceptanceThreshold
      : this.defaults.acceptanceThreshold;

    const runId = uid('auto');
    const startedAt = nowIso();
    const lineage = {
      run_id: runId,
      domain: DOMAIN,
      agent_id: this.agentId,
      started_at: startedAt,
      threshold,
      blueprint_id: proposal.blueprintId || null,
      status: 'started',
    };
    this._recordLineage(lineage);

    try {
      this._preflight();
    } catch (e) {
      lineage.status = 'escalated';
      lineage.ended_at = nowIso();
      lineage.reason = e.escalation_reason || e.code || 'preflight_failed';
      lineage.detail = e.detail || null;
      this._recordLineage(lineage);
      this.consecutiveFailures += 1;
      return { ok: false, escalated: true, reason: lineage.reason, lineage };
    }

    let trained = null;
    try {
      trained = await this.trainer(proposal, { runId, domain: DOMAIN });
    } catch (e) {
      lineage.status = 'train_failed';
      lineage.ended_at = nowIso();
      lineage.error = String(e.message || e);
      this._recordLineage(lineage);
      this.consecutiveFailures += 1;
      return { ok: false, escalated: false, phase: 'train', error: lineage.error, lineage };
    }
    lineage.trained = trained && trained.artifactId ? { artifact_id: trained.artifactId, commit: trained.commit || null } : null;

    if (this.budgets && trained && trained.usage) {
      try {
        if (Number.isFinite(trained.usage.tokens)) {
          this.budgets.charge(this.subject, 'tokens', trained.usage.tokens, trained.artifactId);
        }
        if (Number.isFinite(trained.usage.usd)) {
          this.budgets.charge(this.subject, 'usd', trained.usage.usd, trained.artifactId);
        }
        this.budgets.charge(this.subject, 'jobs', 1, trained.artifactId);
      } catch (e) {
        lineage.status = 'budget_charge_failed';
        lineage.ended_at = nowIso();
        lineage.error = String(e.message || e);
        this._recordLineage(lineage);
        return { ok: false, escalated: true, phase: 'budget', error: lineage.error, lineage };
      }
    }

    let evaluation = null;
    try {
      evaluation = await this.evaluator(trained, proposal, { runId, domain: DOMAIN });
    } catch (e) {
      lineage.status = 'eval_failed';
      lineage.ended_at = nowIso();
      lineage.error = String(e.message || e);
      this._recordLineage(lineage);
      this.consecutiveFailures += 1;
      return { ok: false, escalated: false, phase: 'eval', error: lineage.error, lineage };
    }
    lineage.evaluation = { score: evaluation.score, passed: evaluation.score >= threshold };

    if (evaluation.score < threshold) {
      lineage.status = 'below_threshold';
      lineage.ended_at = nowIso();
      this._recordLineage(lineage);
      this.consecutiveFailures += 1;
      const escalate = this.consecutiveFailures >= this.defaults.maxConsecutiveFailures;
      if (escalate) {
        lineage.escalated_reason = 'consecutive_failures';
        this._recordLineage({ ...lineage, status: 'escalated' });
      }
      return {
        ok: false,
        escalated: escalate,
        phase: 'eval',
        reason: escalate ? 'consecutive_failures' : 'below_threshold',
        score: evaluation.score,
        threshold,
        lineage,
      };
    }

    // Optional external approver (human-in-the-loop). If present, it must
    // return { approved: true } to proceed. Otherwise, treat as an escalation.
    if (this.approver) {
      let appr;
      try {
        appr = await this.approver(trained, evaluation, proposal, { runId });
      } catch (e) {
        lineage.status = 'approval_failed';
        lineage.ended_at = nowIso();
        lineage.error = String(e.message || e);
        this._recordLineage(lineage);
        return { ok: false, escalated: true, phase: 'approval', error: lineage.error, lineage };
      }
      if (!appr || appr.approved !== true) {
        lineage.status = 'approval_denied';
        lineage.ended_at = nowIso();
        lineage.approval = appr || null;
        this._recordLineage(lineage);
        return { ok: false, escalated: true, phase: 'approval', reason: 'approval_denied', lineage };
      }
      lineage.approval = { approved: true, by: appr.by || 'system' };
    }

    lineage.status = 'approved';
    lineage.ended_at = nowIso();
    this._recordLineage(lineage);
    this.consecutiveFailures = 0;

    if (this.rollback && trained && trained.commit) {
      try {
        this.rollback.setGreen(DOMAIN, trained.commit, {
          source: 'autonomy',
          runId,
          artifactId: trained.artifactId,
        }, this.agentId);
      } catch {
        /* rollback bookkeeping is best-effort */
      }
    }

    if (this.audit) {
      try {
        this.audit({
          action: 'autonomy.approved',
          run_id: runId,
          artifact_id: trained.artifactId,
          score: evaluation.score,
        });
      } catch { /* swallow */ }
    }

    return {
      ok: true,
      escalated: false,
      artifactId: trained && trained.artifactId,
      score: evaluation.score,
      threshold,
      lineage,
    };
  }

  async runMany(proposals) {
    if (!Array.isArray(proposals)) {
      throw new AutonomyError('proposals array required', 'bad_proposals');
    }
    const results = [];
    for (const p of proposals) {
      const r = await this.runOnce(p);
      results.push(r);
      if (r.escalated) break;
    }
    return results;
  }

  summary() {
    return {
      domain: DOMAIN,
      agent_id: this.agentId,
      threshold: this.defaults.acceptanceThreshold,
      consecutiveFailures: this.consecutiveFailures,
      maxConsecutiveFailures: this.defaults.maxConsecutiveFailures,
    };
  }
}

module.exports = { AutonomyLoop, AutonomyError, EscalationError, DOMAIN };
