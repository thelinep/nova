'use strict';

const crypto = require('node:crypto');

/**
 * Workspace-patch autonomy loop.
 *
 * Extends the P5 pattern to the second domain: safe, bounded, auto-commit
 * of file patches to a scratch branch (nova/auto). Never pushes to remote.
 *
 * Dependencies are injected:
 *   applier    async ({runId, patch}) => { applied, sandboxPath, files, diff }
 *   tester     async ({runId, sandboxPath, files}) => { ok, summary }
 *   committer  async ({runId, files, diff, branch}) => { sha, branch }
 *   rooter     function(filePath) => boolean — true if allowed to modify
 *
 * Escalation triggers (any one → stop, record, return escalated: true):
 *   - kill switch active
 *   - policy deny
 *   - budget exceeded
 *   - patch touches a file outside approved roots
 *   - schema migration required (conservative detector)
 *   - three consecutive failures
 *
 * On success: sets green commit for the domain via rollback manager (if set).
 */

const DOMAIN = 'workspace-patches';
const AUTO_BRANCH = 'nova/auto';
const MIGRATION_MARKER = 'CREATE TABLE IF NOT EXISTS';

class WorkspaceAutonomyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WorkspaceAutonomyError';
    this.code = code || 'workspace_autonomy_error';
  }
}

class WorkspaceEscalationError extends WorkspaceAutonomyError {
  constructor(reason, detail) {
    super(`Escalated: ${reason}`, 'escalated');
    this.name = 'WorkspaceEscalationError';
    this.escalation_reason = reason;
    this.detail = detail || null;
  }
}

const nowIso = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID()}`;
const hash = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');

class WorkspaceAutonomy {
  constructor(store, deps) {
    deps = deps || {};
    if (!store) throw new WorkspaceAutonomyError('store required', 'bad_store');
    if (typeof deps.applier !== 'function') throw new WorkspaceAutonomyError('applier required', 'bad_applier');
    if (typeof deps.tester !== 'function') throw new WorkspaceAutonomyError('tester required', 'bad_tester');
    if (typeof deps.committer !== 'function') throw new WorkspaceAutonomyError('committer required', 'bad_committer');
    if (typeof deps.rooter !== 'function') throw new WorkspaceAutonomyError('rooter required', 'bad_rooter');
    this.store = store;
    this.applier = deps.applier;
    this.tester = deps.tester;
    this.committer = deps.committer;
    this.rooter = deps.rooter;
    this.policy = deps.policy || null;
    this.budgets = deps.budgets || null;
    this.killSwitch = deps.killSwitch || null;
    this.rollback = deps.rollback || null;
    this.audit = typeof deps.audit === 'function' ? deps.audit : null;
    this.agentId = deps.agentId || 'workspace-agent';
    this.subject = { type: 'agent', id: this.agentId };
    this.resource = { type: 'domain', id: DOMAIN };
    this.branch = deps.branch || AUTO_BRANCH;
    this.maxConsecutiveFailures = Number.isFinite(deps.maxConsecutiveFailures)
      ? deps.maxConsecutiveFailures
      : 3;
    this.consecutiveFailures = 0;
  }

  _preflight() {
    if (this.killSwitch && this.killSwitch.isHalted()) {
      throw new WorkspaceEscalationError('kill_switch_active', this.killSwitch.status());
    }
    if (this.policy) {
      try { this.policy.enforce(this.subject, this.resource); }
      catch (e) { throw new WorkspaceEscalationError('policy_denied', { reason: e.reason || e.message }); }
    }
    if (this.budgets) {
      const r = this.budgets.check(this.subject);
      if (!r.ok) throw new WorkspaceEscalationError('budget_exceeded', r.exceeded);
    }
  }

  _filesOutsideRoots(files) {
    if (!Array.isArray(files)) return [];
    return files.filter((f) => !this.rooter(f));
  }

  _containsSchemaMigration(diff) {
    if (!diff || typeof diff !== 'string') return false;
    return diff.includes(MIGRATION_MARKER);
  }

  async runOnce(patch) {
    if (!patch || typeof patch !== 'object') {
      throw new WorkspaceAutonomyError('patch object required', 'bad_patch');
    }
    const runId = uid('wsauto');
    const patchId = uid('wsp');
    const startedAt = nowIso();

    this.store.workspacePatchesInsert({
      id: patchId, run_id: runId, domain: DOMAIN, status: 'started',
      branch: this.branch, created_at: startedAt,
    });

    try {
      this._preflight();
    } catch (e) {
      const row = this.store.workspacePatchesUpdate(patchId, {
        status: 'escalated', reason: e.escalation_reason || e.code, ended_at: nowIso(),
      });
      this.consecutiveFailures += 1;
      return { ok: false, escalated: true, reason: row.reason, patch: row };
    }

    let applied;
    try {
      applied = await this.applier({ runId, patch });
    } catch (e) {
      const row = this.store.workspacePatchesUpdate(patchId, {
        status: 'apply_failed', error: String(e.message || e), ended_at: nowIso(),
      });
      this.consecutiveFailures += 1;
      return { ok: false, escalated: false, phase: 'apply', error: row.error, patch: row };
    }

    const files = (applied && applied.files) || [];
    const diff = (applied && applied.diff) || '';
    const outside = this._filesOutsideRoots(files);
    if (outside.length > 0) {
      const row = this.store.workspacePatchesUpdate(patchId, {
        status: 'escalated', reason: 'outside_roots',
        files_json: JSON.stringify(files), diff_hash: hash(diff),
        sandbox_path: applied.sandboxPath || null, ended_at: nowIso(),
      });
      this.consecutiveFailures += 1;
      return { ok: false, escalated: true, reason: 'outside_roots', outside, patch: row };
    }

    if (this._containsSchemaMigration(diff)) {
      const row = this.store.workspacePatchesUpdate(patchId, {
        status: 'escalated', reason: 'schema_migration_required',
        files_json: JSON.stringify(files), diff_hash: hash(diff),
        sandbox_path: applied.sandboxPath || null, ended_at: nowIso(),
      });
      this.consecutiveFailures += 1;
      return { ok: false, escalated: true, reason: 'schema_migration_required', patch: row };
    }

    let testResult;
    try {
      testResult = await this.tester({ runId, sandboxPath: applied.sandboxPath, files });
    } catch (e) {
      const row = this.store.workspacePatchesUpdate(patchId, {
        status: 'test_failed', error: String(e.message || e),
        files_json: JSON.stringify(files), diff_hash: hash(diff),
        sandbox_path: applied.sandboxPath || null, ended_at: nowIso(),
      });
      this.consecutiveFailures += 1;
      return { ok: false, escalated: false, phase: 'test', error: row.error, patch: row };
    }

    this.store.workspacePatchesUpdate(patchId, {
      files_json: JSON.stringify(files),
      diff_hash: hash(diff),
      sandbox_path: applied.sandboxPath || null,
      test_summary_json: JSON.stringify(testResult || {}),
    });

    if (!testResult || testResult.ok !== true) {
      const row = this.store.workspacePatchesUpdate(patchId, {
        status: 'below_quality', reason: 'tests_failed', ended_at: nowIso(),
      });
      this.consecutiveFailures += 1;
      const escalate = this.consecutiveFailures >= this.maxConsecutiveFailures;
      return {
        ok: false,
        escalated: escalate,
        reason: escalate ? 'consecutive_failures' : 'tests_failed',
        patch: row,
      };
    }

    if (this.budgets) {
      try { this.budgets.charge(this.subject, 'jobs', 1, patchId); }
      catch (e) {
        const row = this.store.workspacePatchesUpdate(patchId, {
          status: 'budget_charge_failed', error: String(e.message || e), ended_at: nowIso(),
        });
        return { ok: false, escalated: true, phase: 'budget', error: row.error, patch: row };
      }
    }

    let committed;
    try {
      committed = await this.committer({ runId, files, diff, branch: this.branch });
    } catch (e) {
      const row = this.store.workspacePatchesUpdate(patchId, {
        status: 'commit_failed', error: String(e.message || e), ended_at: nowIso(),
      });
      this.consecutiveFailures += 1;
      return { ok: false, escalated: false, phase: 'commit', error: row.error, patch: row };
    }

    const row = this.store.workspacePatchesUpdate(patchId, {
      status: 'approved',
      branch: (committed && committed.branch) || this.branch,
      ended_at: nowIso(),
    });
    this.consecutiveFailures = 0;

    if (this.rollback && committed && committed.sha) {
      try {
        this.rollback.setGreen(DOMAIN, committed.sha, {
          source: 'workspace-autonomy', runId, patchId,
        }, this.agentId);
      } catch { /* best-effort */ }
    }

    if (this.audit) {
      try {
        this.audit({
          action: 'workspace_autonomy.approved',
          run_id: runId, patch_id: patchId,
          branch: this.branch, sha: committed && committed.sha,
        });
      } catch { /* swallow */ }
    }

    return {
      ok: true, escalated: false,
      branch: row.branch,
      sha: committed && committed.sha,
      files, patch: row,
    };
  }

  async runMany(patches) {
    if (!Array.isArray(patches)) {
      throw new WorkspaceAutonomyError('patches array required', 'bad_patches');
    }
    const results = [];
    for (const p of patches) {
      const r = await this.runOnce(p);
      results.push(r);
      if (r.escalated) break;
    }
    return results;
  }

  summary() {
    return {
      domain: DOMAIN, agent_id: this.agentId, branch: this.branch,
      consecutiveFailures: this.consecutiveFailures,
      maxConsecutiveFailures: this.maxConsecutiveFailures,
    };
  }
}

module.exports = {
  WorkspaceAutonomy,
  WorkspaceAutonomyError,
  WorkspaceEscalationError,
  DOMAIN,
  AUTO_BRANCH,
};
