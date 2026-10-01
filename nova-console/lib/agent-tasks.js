'use strict';

const crypto = require('node:crypto');

const nowIso = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID()}`;

const STATES = ['queued', 'assigned', 'running', 'completed', 'failed', 'cancelled'];
const EVENT_KINDS = [
  'created', 'assigned', 'started', 'completed', 'failed',
  'cancelled', 'handed_off',
];

const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

class AgentTaskError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AgentTaskError';
    this.code = code || 'agent_task_error';
  }
}

/**
 * Shared task state across agents.
 *
 * A task has:
 *   - a creator
 *   - a current assignee (nullable)
 *   - a state from { queued, assigned, running, completed, failed, cancelled }
 *   - an append-only event log
 *
 * Handoff is a specific transition: running/assigned → assigned to a new
 * agent, with handoff_count incremented and an event logged.
 *
 * Visibility:
 *   - an agent sees tasks it created, tasks assigned to it, and tasks
 *     assigned to any of its direct and transitive subordinates
 *   - no other agent sees the task
 */
class AgentTasks {
  constructor(store, deps) {
    deps = deps || {};
    if (!store) throw new AgentTaskError('store required', 'bad_store');
    if (!deps.registry) throw new AgentTaskError('registry required', 'bad_registry');
    this.store = store;
    this.registry = deps.registry;
    this.expiryMs = Number.isFinite(deps.expiryMs) ? deps.expiryMs : DEFAULT_EXPIRY_MS;
    this.audit = typeof deps.audit === 'function' ? deps.audit : null;
  }

  // ---- lifecycle ----

  create(input) {
    input = input || {};
    if (!input.title || typeof input.title !== 'string' || !input.title.trim()) {
      throw new AgentTaskError('title required', 'bad_title');
    }
    if (!input.creatorId || typeof input.creatorId !== 'string') {
      throw new AgentTaskError('creatorId required', 'bad_creator');
    }
    const creator = this.registry.get(input.creatorId);
    if (!creator) throw new AgentTaskError('creator agent not found', 'creator_not_found');
    if (creator.revoked_at) throw new AgentTaskError('creator agent revoked', 'creator_revoked');

    let assigneeId = null;
    if (input.assigneeId != null) {
      const assignee = this.registry.get(input.assigneeId);
      if (!assignee) throw new AgentTaskError('assignee agent not found', 'assignee_not_found');
      if (assignee.revoked_at) throw new AgentTaskError('assignee agent revoked', 'assignee_revoked');
      assigneeId = assignee.id;
    }

    if (input.parentTaskId) {
      const parent = this.store.agentTasksGet(input.parentTaskId);
      if (!parent) throw new AgentTaskError('parent task not found', 'parent_not_found');
    }

    const now = nowIso();
    const row = this.store.agentTasksInsert({
      id: input.id || uid('tsk'),
      title: input.title.trim(),
      description: input.description || null,
      state: assigneeId ? 'assigned' : 'queued',
      creator_id: creator.id,
      assignee_id: assigneeId,
      parent_task_id: input.parentTaskId || null,
      handoff_count: 0,
      payload_json: input.payload != null ? JSON.stringify(input.payload) : null,
      result_json: null,
      error: null,
      created_at: now,
      updated_at: now,
      started_at: null,
      ended_at: null,
      expires_at: input.expiresAt || new Date(Date.now() + this.expiryMs).toISOString(),
    });

    this._event(row.id, 'created', {
      actor_id: creator.id,
      payload: { assigned_to: assigneeId },
    });
    if (assigneeId) {
      this._event(row.id, 'assigned', {
        actor_id: creator.id,
        from_assignee: null,
        to_assignee: assigneeId,
      });
    }
    this._audit('created', { task_id: row.id, creator_id: creator.id, assignee_id: assigneeId });
    return row;
  }

  assign(taskId, assigneeId, actorId) {
    const row = this._require(taskId);
    this._requireOpen(row);
    const assignee = this.registry.get(assigneeId);
    if (!assignee) throw new AgentTaskError('assignee agent not found', 'assignee_not_found');
    if (assignee.revoked_at) throw new AgentTaskError('assignee agent revoked', 'assignee_revoked');
    if (assignee.enabled !== 1) throw new AgentTaskError('assignee agent disabled', 'assignee_disabled');

    const from = row.assignee_id;
    if (from === assignee.id) {
      return row;
    }
    const next = this.store.agentTasksUpdate(taskId, {
      state: row.state === 'queued' ? 'assigned' : row.state,
      assignee_id: assignee.id,
      updated_at: nowIso(),
    });
    this._event(taskId, 'assigned', {
      actor_id: actorId || null,
      from_assignee: from,
      to_assignee: assignee.id,
    });
    this._audit('assigned', { task_id: taskId, from, to: assignee.id });
    return next;
  }

  start(taskId, actorId) {
    const row = this._require(taskId);
    if (row.state !== 'assigned') {
      throw new AgentTaskError('task is not assigned', 'not_assigned');
    }
    if (!row.assignee_id) {
      throw new AgentTaskError('task has no assignee', 'no_assignee');
    }
    const next = this.store.agentTasksUpdate(taskId, {
      state: 'running',
      started_at: row.started_at || nowIso(),
      updated_at: nowIso(),
    });
    this._event(taskId, 'started', { actor_id: actorId || null });
    this._audit('started', { task_id: taskId });
    return next;
  }

  complete(taskId, result, actorId) {
    const row = this._require(taskId);
    if (row.state !== 'running' && row.state !== 'assigned') {
      throw new AgentTaskError('task is not in progress', 'not_in_progress');
    }
    const next = this.store.agentTasksUpdate(taskId, {
      state: 'completed',
      result_json: result == null ? null : JSON.stringify(result),
      ended_at: nowIso(),
      updated_at: nowIso(),
    });
    this._event(taskId, 'completed', { actor_id: actorId || null });
    this._audit('completed', { task_id: taskId });
    return next;
  }

  fail(taskId, error, actorId) {
    const row = this._require(taskId);
    if (row.state === 'completed' || row.state === 'cancelled') {
      throw new AgentTaskError('task is already closed', 'closed');
    }
    const next = this.store.agentTasksUpdate(taskId, {
      state: 'failed',
      error: String(error == null ? 'failed' : error),
      ended_at: nowIso(),
      updated_at: nowIso(),
    });
    this._event(taskId, 'failed', {
      actor_id: actorId || null,
      payload: { error: String(error) },
    });
    this._audit('failed', { task_id: taskId, error: String(error) });
    return next;
  }

  cancel(taskId, actorId, reason) {
    const row = this._require(taskId);
    if (row.state === 'completed' || row.state === 'cancelled' || row.state === 'failed') {
      throw new AgentTaskError('task is already closed', 'closed');
    }
    const next = this.store.agentTasksUpdate(taskId, {
      state: 'cancelled',
      ended_at: nowIso(),
      updated_at: nowIso(),
    });
    this._event(taskId, 'cancelled', { actor_id: actorId || null, reason: reason || null });
    this._audit('cancelled', { task_id: taskId, reason: reason || null });
    return next;
  }

  // ---- handoff ----

  handoff(taskId, toAgentId, actorId, reason) {
    const row = this._require(taskId);
    if (row.state === 'completed' || row.state === 'cancelled' || row.state === 'failed') {
      throw new AgentTaskError('task is closed', 'closed');
    }
    const target = this.registry.get(toAgentId);
    if (!target) throw new AgentTaskError('target agent not found', 'target_not_found');
    if (target.revoked_at) throw new AgentTaskError('target agent revoked', 'target_revoked');
    if (target.enabled !== 1) throw new AgentTaskError('target agent disabled', 'target_disabled');
    if (row.assignee_id === target.id) {
      throw new AgentTaskError('task already assigned to that agent', 'same_assignee');
    }
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      throw new AgentTaskError('handoff reason required', 'bad_reason');
    }

    const from = row.assignee_id;
    const next = this.store.agentTasksUpdate(taskId, {
      state: 'assigned',
      assignee_id: target.id,
      handoff_count: (row.handoff_count || 0) + 1,
      started_at: null,
      updated_at: nowIso(),
    });
    this._event(taskId, 'handed_off', {
      actor_id: actorId || null,
      from_assignee: from,
      to_assignee: target.id,
      reason: reason.trim(),
    });
    this._audit('handed_off', { task_id: taskId, from, to: target.id });
    return next;
  }

  // ---- reads ----

  get(id) {
    if (!id) throw new AgentTaskError('id required', 'bad_id');
    return this.store.agentTasksGet(id);
  }

  events(taskId) {
    if (!taskId) throw new AgentTaskError('taskId required', 'bad_id');
    return this.store.agentTaskEventsList(taskId);
  }

  /**
   * All tasks visible to viewerAgentId.
   * Includes tasks the viewer created, tasks assigned to the viewer, and
   * tasks assigned to any descendant of the viewer.
   */
  visibleTo(viewerAgentId, filter) {
    filter = filter || {};
    const viewer = this.registry.get(viewerAgentId);
    if (!viewer) throw new AgentTaskError('viewer agent not found', 'not_found');

    const seen = new Set();
    const out = [];
    const add = (rows) => {
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(r);
      }
    };

    add(this.store.agentTasksList({ creator_id: viewerAgentId }));
    add(this.store.agentTasksList({ assignee_id: viewerAgentId }));
    for (const subId of this._descendants(viewerAgentId)) {
      add(this.store.agentTasksList({ assignee_id: subId }));
    }

    let results = out;
    if (filter.state) results = results.filter((r) => r.state === filter.state);
    if (filter.assignee_id) results = results.filter((r) => r.assignee_id === filter.assignee_id);
    if (filter.creator_id) results = results.filter((r) => r.creator_id === filter.creator_id);

    results.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return results;
  }

  countsByState(viewerAgentId) {
    const rows = this.visibleTo(viewerAgentId, {});
    const out = {};
    for (const s of STATES) out[s] = 0;
    for (const r of rows) out[r.state] = (out[r.state] || 0) + 1;
    return out;
  }

  /** Read-only check for whether a task has expired; does not mutate. */
  isExpired(taskId) {
    const row = this.get(taskId);
    if (!row || !row.expires_at) return false;
    return new Date(row.expires_at).getTime() < Date.now();
  }

  // ---- internals ----

  _require(id) {
    const row = this.store.agentTasksGet(id);
    if (!row) throw new AgentTaskError('task not found', 'not_found');
    return row;
  }

  _requireOpen(row) {
    if (row.state === 'completed' || row.state === 'cancelled' || row.state === 'failed') {
      throw new AgentTaskError('task is closed', 'closed');
    }
  }

  _event(taskId, kind, extra) {
    extra = extra || {};
    this.store.agentTaskEventsInsert({
      id: uid('evt'),
      task_id: taskId,
      kind,
      actor_id: extra.actor_id || null,
      from_assignee: extra.from_assignee || null,
      to_assignee: extra.to_assignee || null,
      reason: extra.reason || null,
      payload_json: extra.payload != null ? JSON.stringify(extra.payload) : null,
      timestamp: nowIso(),
    });
  }

  _descendants(rootId) {
    const out = [];
    const stack = [rootId];
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const subs = this.registry.subordinates(id);
      for (const s of subs) {
        out.push(s.id);
        stack.push(s.id);
      }
    }
    return out;
  }

  _audit(kind, data) {
    if (!this.audit) return;
    try { this.audit({ action: 'agent_task.' + kind, ...data }); }
    catch { /* best-effort */ }
  }
}

module.exports = { AgentTasks, AgentTaskError, STATES, EVENT_KINDS };
