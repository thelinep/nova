'use strict';

const crypto = require('node:crypto');

/**
 * RollbackManager: bounded, auditable, per-domain auto-revert.
 *
 * Each domain (workspace, neuron-factory, browser-tools, release) has one
 * "green" pointer — the last commit/snapshot known to be good. When a task
 * fails, RollbackManager:
 *   1. Captures the current state via the executor.
 *   2. Records a quarantine row with reason + diff for human review.
 *   3. Reverts to green via the executor.
 *   4. Writes a rollback_events row with the outcome.
 *
 * The executor is pluggable so tests run without touching git.
 * Production wiring supplies a real git executor later.
 */

class RollbackError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RollbackError';
    this.code = code || 'rollback_error';
  }
}

const nowIso = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID()}`;

const DEFAULT_DOMAINS = ['workspace', 'neuron-factory', 'browser-tools', 'release'];

function defaultExecutor() {
  return {
    async captureCurrent() {
      return { sha: null, diff: '', files: [] };
    },
    async revert() {
      /* noop — real executor is supplied by the caller */
    },
  };
}

class RollbackManager {
  constructor(store, options) {
    options = options || {};
    if (!store) throw new RollbackError('store required', 'bad_store');
    this.store = store;
    this.domains = Array.isArray(options.domains) && options.domains.length
      ? options.domains.slice()
      : DEFAULT_DOMAINS.slice();
    this.executor = options.executor || defaultExecutor();
    this.policy = options.policy || null;
    this.audit = typeof options.audit === 'function' ? options.audit : null;
  }

  _assertDomain(domain) {
    if (!domain || typeof domain !== 'string') {
      throw new RollbackError('domain required', 'bad_domain');
    }
    if (!this.domains.includes(domain)) {
      throw new RollbackError(`unknown domain: ${domain}`, 'unknown_domain');
    }
  }

  setGreen(domain, sha, meta, actor) {
    this._assertDomain(domain);
    if (!sha || typeof sha !== 'string') {
      throw new RollbackError('sha required', 'bad_sha');
    }
    const row = {
      domain,
      sha,
      meta_json: meta ? JSON.stringify(meta) : null,
      set_at: nowIso(),
      set_by: actor || 'system',
    };
    return this.store.greenCommitsSet(row);
  }

  getGreen(domain) {
    this._assertDomain(domain);
    return this.store.greenCommitsGet(domain);
  }

  listGreen() {
    return this.store.greenCommitsList();
  }

  clearGreen(domain) {
    this._assertDomain(domain);
    return this.store.greenCommitsClear(domain);
  }

  quarantine(domain, input) {
    this._assertDomain(domain);
    input = input || {};
    if (!input.reason) {
      throw new RollbackError('reason required', 'bad_reason');
    }
    const row = {
      id: uid('qtn'),
      domain,
      reason: String(input.reason),
      diff: input.diff || null,
      files_json: input.files ? JSON.stringify(input.files) : null,
      task_id: input.taskId || null,
      status: 'pending',
      created_at: nowIso(),
      resolved_at: null,
      resolved_by: null,
      resolution_note: null,
    };
    return this.store.quarantinesInsert(row);
  }

  listQuarantines(filter) {
    return this.store.quarantinesList(filter || {});
  }

  getQuarantine(id) {
    return this.store.quarantinesGet(id);
  }

  resolveQuarantine(id, decision, actor, note) {
    if (!['applied', 'discarded'].includes(decision)) {
      throw new RollbackError('decision must be applied or discarded', 'bad_decision');
    }
    const cur = this.store.quarantinesGet(id);
    if (!cur) throw new RollbackError('quarantine not found', 'not_found');
    if (cur.status !== 'pending') {
      throw new RollbackError(`quarantine already ${cur.status}`, 'already_resolved');
    }
    return this.store.quarantinesUpdate(id, {
      status: decision,
      resolved_at: nowIso(),
      resolved_by: actor || 'system',
      resolution_note: note || null,
    });
  }

  history(filter) {
    return this.store.rollbackEventsList(filter || {});
  }

  async attempt(domain, taskFn, options) {
    this._assertDomain(domain);
    if (typeof taskFn !== 'function') {
      throw new RollbackError('taskFn must be a function', 'bad_task');
    }
    options = options || {};

    if (this.policy) {
      this.policy.enforce(
        { type: 'agent', id: options.agentId || 'system' },
        { type: 'domain', id: domain }
      );
    }

    const before = await this.executor.captureCurrent(domain);

    let result = null;
    let error = null;
    try {
      result = await taskFn();
    } catch (e) {
      error = e;
    }

    if (!error) {
      if (options.advanceGreen !== false && result && result.sha) {
        this.setGreen(
          domain,
          result.sha,
          { source: 'attempt', taskId: options.taskId || null },
          options.actor
        );
      }
      return { ok: true, result, rolled_back: false, outcome: 'success' };
    }

    const reason = options.failureReason || String(error.message || error);
    const q = this.quarantine(domain, {
      reason,
      diff: before && before.diff ? before.diff : null,
      files: before && before.files ? before.files : null,
      taskId: options.taskId || null,
    });

    const green = this.getGreen(domain);
    let outcome = 'no_green_commit';
    let rollbackError = null;
    if (green && green.sha) {
      try {
        await this.executor.revert(domain, green.sha, before);
        outcome = 'rolled_back';
      } catch (e) {
        outcome = 'failed';
        rollbackError = String(e.message || e);
      }
    }

    const evt = {
      id: uid('rb'),
      domain,
      reason,
      from_sha: before && before.sha ? before.sha : null,
      to_sha: green && green.sha ? green.sha : null,
      task_id: options.taskId || null,
      quarantine_id: q.id,
      outcome,
      error: rollbackError,
      timestamp: nowIso(),
    };
    this.store.rollbackEventsInsert(evt);

    if (this.audit) {
      try {
        this.audit({
          action: 'rollback',
          domain,
          outcome,
          from_sha: evt.from_sha,
          to_sha: evt.to_sha,
          quarantine_id: q.id,
          task_id: evt.task_id,
        });
      } catch {
        /* audit is best-effort in P3 */
      }
    }

    return {
      ok: false,
      error,
      rolled_back: outcome === 'rolled_back',
      outcome,
      quarantine: q,
      event: evt,
    };
  }
}

module.exports = {
  RollbackManager,
  RollbackError,
  DEFAULT_DOMAINS,
};
