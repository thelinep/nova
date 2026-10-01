'use strict';

const crypto = require('node:crypto');

const nowIso = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID()}`;

const KINDS = ['observation', 'decision', 'lesson', 'fact', 'task_ref', 'note'];
const SCOPES = ['private', 'shared', 'supervisor-visible'];

class AgentMemoryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AgentMemoryError';
    this.code = code || 'agent_memory_error';
  }
}

/**
 * Durable per-agent memory.
 *
 * Each entry is typed and scoped. Scope determines who can read it:
 *
 *   private             — only the owning agent
 *   shared              — any active agent whose supervisor chain shares
 *                         the same immediate supervisor
 *   supervisor-visible  — the owner's direct supervisor, and any agent
 *                         above that supervisor in the chain
 *
 * Recall is subject-scoped. An agent never sees private memory it does
 * not own, and never sees supervisor-visible memory from agents that do
 * not report up to it.
 */
class AgentMemory {
  constructor(store, options) {
    options = options || {};
    if (!store) throw new AgentMemoryError('store required', 'bad_store');
    if (!options.registry) throw new AgentMemoryError('registry required', 'bad_registry');
    this.store = store;
    this.registry = options.registry;
    this.allowedKinds = Array.isArray(options.allowedKinds)
      ? options.allowedKinds.slice() : KINDS.slice();
    this.allowedScopes = Array.isArray(options.allowedScopes)
      ? options.allowedScopes.slice() : SCOPES.slice();
  }

  remember(agentId, input) {
    input = input || {};
    const agent = this.registry.get(agentId);
    if (!agent) throw new AgentMemoryError('agent not found', 'not_found');
    if (agent.revoked_at) throw new AgentMemoryError('agent revoked', 'revoked');
    if (!input.kind || !this.allowedKinds.includes(input.kind)) {
      throw new AgentMemoryError('unknown kind: ' + input.kind, 'bad_kind');
    }
    if (input.content === undefined) {
      throw new AgentMemoryError('content required', 'bad_content');
    }
    const scope = input.scope || agent.memory_scope || 'private';
    if (!this.allowedScopes.includes(scope)) {
      throw new AgentMemoryError('unknown scope: ' + scope, 'bad_scope');
    }
    if (input.tags != null && !Array.isArray(input.tags)) {
      throw new AgentMemoryError('tags must be an array', 'bad_tags');
    }
    if (input.confidence != null &&
        (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
      throw new AgentMemoryError('confidence must be between 0 and 1', 'bad_confidence');
    }
    if (input.expiresAt && Number.isNaN(new Date(input.expiresAt).getTime())) {
      throw new AgentMemoryError('expiresAt must be ISO-8601', 'bad_expiry');
    }

    return this.store.agentMemoryInsert({
      id: uid('mem'),
      agent_id: agentId,
      kind: input.kind,
      scope,
      content_json: JSON.stringify(input.content),
      tags_json: JSON.stringify((input.tags || []).map(String)),
      source_ref: input.sourceRef || null,
      confidence: input.confidence == null ? null : input.confidence,
      created_at: nowIso(),
      expires_at: input.expiresAt || null,
    });
  }

  forget(memoryId, ownerAgentId) {
    const row = this.store.agentMemoryGet(memoryId);
    if (!row) throw new AgentMemoryError('memory not found', 'not_found');
    if (ownerAgentId && row.agent_id !== ownerAgentId) {
      throw new AgentMemoryError('only the owning agent can forget this entry', 'not_owner');
    }
    this.store.agentMemoryDelete(memoryId);
    return { ok: true };
  }

  prune(agentId, options) {
    options = options || {};
    const agent = this.registry.get(agentId);
    if (!agent) throw new AgentMemoryError('agent not found', 'not_found');
    return this.store.agentMemoryDeleteByAgent(agentId, {
      kind: options.kind || null,
      before: options.before || null,
    });
  }

  /**
   * Recall entries visible to `viewerAgentId`.
   * Returns a merged list ordered by created_at desc, with a tag filter
   * and an optional kind filter, capped at `limit` (default 50).
   */
  recall(viewerAgentId, filter) {
    filter = filter || {};
    const viewer = this.registry.get(viewerAgentId);
    if (!viewer) throw new AgentMemoryError('viewer agent not found', 'not_found');

    const candidates = [];
    const add = (rows) => { for (const r of rows) candidates.push(r); };

    // 1. own entries (all scopes)
    add(this.store.agentMemoryList({
      agent_id: viewerAgentId, not_expired: true,
    }));

    // 2. shared entries from peers under the same immediate supervisor
    if (viewer.supervisor_id) {
      const peers = this.registry.subordinates(viewer.supervisor_id);
      for (const peer of peers) {
        if (peer.id === viewerAgentId) continue;
        add(this.store.agentMemoryList({
          agent_id: peer.id, scope: 'shared', not_expired: true,
        }));
      }
    }

    // 3. supervisor-visible entries from direct and transitive subordinates
    const descendants = this._descendants(viewerAgentId);
    for (const subId of descendants) {
      add(this.store.agentMemoryList({
        agent_id: subId, scope: 'supervisor-visible', not_expired: true,
      }));
    }

    let results = candidates;

    if (filter.kind) {
      if (!this.allowedKinds.includes(filter.kind)) {
        throw new AgentMemoryError('unknown kind: ' + filter.kind, 'bad_kind');
      }
      results = results.filter((r) => r.kind === filter.kind);
    }
    if (filter.tags && filter.tags.length > 0) {
      const wanted = new Set(filter.tags.map(String));
      results = results.filter((r) => {
        let tags = [];
        try { tags = JSON.parse(r.tags_json); } catch { tags = []; }
        for (const t of tags) if (wanted.has(t)) return true;
        return false;
      });
    }
    if (filter.minConfidence != null) {
      results = results.filter((r) =>
        r.confidence != null && r.confidence >= filter.minConfidence);
    }
    if (filter.since) {
      results = results.filter((r) => r.created_at >= filter.since);
    }

    // Deduplicate (own entries can also appear in descendants if misconfigured)
    const seen = new Set();
    const unique = [];
    for (const r of results) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      unique.push(r);
    }

    unique.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const limit = Number.isFinite(filter.limit) ? filter.limit : 50;
    return unique.slice(0, limit).map((r) => this._decorate(r));
  }

  count(agentId, filter) {
    filter = filter || {};
    const rows = this.recall(agentId, Object.assign({}, filter, { limit: 10000 }));
    return rows.length;
  }

  countsByKind(agentId) {
    const rows = this.store.agentMemoryCountByKind(agentId);
    const out = {};
    for (const r of rows) out[r.kind] = r.n;
    return out;
  }

  /**
   * Compact snapshot for injecting into an agent prompt.
   * Returns counts and the most recent N entries per kind.
   */
  summarise(agentId, options) {
    options = options || {};
    const perKind = Number.isFinite(options.perKind) ? options.perKind : 3;
    const summary = {
      agent_id: agentId,
      counts: this.countsByKind(agentId),
      recent: {},
    };
    for (const kind of this.allowedKinds) {
      const rows = this.recall(agentId, { kind, limit: perKind });
      if (rows.length) summary.recent[kind] = rows;
    }
    return summary;
  }

  _decorate(row) {
    let content = null;
    try { content = JSON.parse(row.content_json); } catch { content = row.content_json; }
    let tags = [];
    try { tags = JSON.parse(row.tags_json); } catch { tags = []; }
    return {
      id: row.id,
      agent_id: row.agent_id,
      kind: row.kind,
      scope: row.scope,
      content,
      tags,
      source_ref: row.source_ref || null,
      confidence: row.confidence,
      created_at: row.created_at,
      expires_at: row.expires_at || null,
    };
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
}

module.exports = { AgentMemory, AgentMemoryError, KINDS, SCOPES };
