'use strict';

const crypto = require('node:crypto');

const nowIso = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID()}`;

const KINDS = ['connector', 'skill', 'mcp', 'internal'];

class AgentToolError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AgentToolError';
    this.code = code || 'agent_tool_error';
  }
}

/**
 * Scoped tool bindings.
 *
 * Each binding gives one agent access to one concrete tool of one kind
 * with an explicit list of allowed operations. Operations empty means
 * "all operations of that tool".
 *
 * M1's `allowed_tools` on the agent is a coarse advisory label (e.g.
 * 'github:*'). M5's bindings are the actual enforcement table. The two
 * are deliberately separate: the registry is easy to read, the
 * binding table is what decides.
 *
 * `check(agentId, {kind, toolId, operation})` is the dispatch-time gate.
 * It never throws on denial — it returns { allowed, reason, binding }.
 * It throws only for programmer errors (bad arguments, unknown agent).
 */
class AgentTools {
  constructor(store, deps) {
    deps = deps || {};
    if (!store) throw new AgentToolError('store required', 'bad_store');
    if (!deps.registry) throw new AgentToolError('registry required', 'bad_registry');
    this.store = store;
    this.registry = deps.registry;
    this.allowedKinds = Array.isArray(deps.allowedKinds)
      ? deps.allowedKinds.slice() : KINDS.slice();
  }

  bind(agentId, input) {
    input = input || {};
    const agent = this._agent(agentId);
    if (!this.allowedKinds.includes(input.kind)) {
      throw new AgentToolError('unknown kind: ' + input.kind, 'bad_kind');
    }
    if (!input.toolId || typeof input.toolId !== 'string') {
      throw new AgentToolError('toolId required', 'bad_tool_id');
    }
    if (input.operations != null && !Array.isArray(input.operations)) {
      throw new AgentToolError('operations must be an array', 'bad_operations');
    }
    if (input.expiresAt && Number.isNaN(new Date(input.expiresAt).getTime())) {
      throw new AgentToolError('expiresAt must be ISO-8601', 'bad_expiry');
    }
    const existing = this.store.agentToolBindingsFind(agent.id, input.kind, input.toolId);
    if (existing) {
      throw new AgentToolError('binding already exists', 'duplicate');
    }

    const operations = (input.operations || []).map(String);
    for (const op of operations) {
      if (!/^[a-z0-9:_-]+$/i.test(op)) {
        throw new AgentToolError('invalid operation: ' + op, 'bad_operation_name');
      }
    }

    return this.store.agentToolBindingsInsert({
      id: input.id || uid('bnd'),
      agent_id: agent.id,
      kind: input.kind,
      tool_id: input.toolId.trim(),
      operations_json: JSON.stringify(operations),
      enabled: input.enabled !== false,
      created_at: nowIso(),
      created_by: input.createdBy || 'system',
      expires_at: input.expiresAt || null,
      revoked_at: null,
    });
  }

  unbind(bindingId, actorId) {
    const cur = this.store.agentToolBindingsGet(bindingId);
    if (!cur) throw new AgentToolError('binding not found', 'not_found');
    if (cur.revoked_at) return cur;
    return this.store.agentToolBindingsUpdate(bindingId, {
      revoked_at: nowIso(),
      enabled: 0,
    });
  }

  enable(bindingId) {
    const cur = this.store.agentToolBindingsGet(bindingId);
    if (!cur) throw new AgentToolError('binding not found', 'not_found');
    if (cur.revoked_at) throw new AgentToolError('binding revoked', 'revoked');
    return this.store.agentToolBindingsUpdate(bindingId, { enabled: 1 });
  }

  disable(bindingId) {
    const cur = this.store.agentToolBindingsGet(bindingId);
    if (!cur) throw new AgentToolError('binding not found', 'not_found');
    return this.store.agentToolBindingsUpdate(bindingId, { enabled: 0 });
  }

  setOperations(bindingId, operations) {
    if (!Array.isArray(operations)) {
      throw new AgentToolError('operations must be an array', 'bad_operations');
    }
    const cur = this.store.agentToolBindingsGet(bindingId);
    if (!cur) throw new AgentToolError('binding not found', 'not_found');
    if (cur.revoked_at) throw new AgentToolError('binding revoked', 'revoked');
    return this.store.agentToolBindingsUpdate(bindingId, {
      operations_json: JSON.stringify(operations.map(String)),
    });
  }

  /**
   * The dispatch-time gate. Returns { allowed, reason, binding? }.
   * Denial reasons: unknown_agent, agent_revoked, agent_disabled,
   * no_binding, binding_disabled, binding_revoked, binding_expired,
   * operation_not_allowed.
   */
  check(agentId, query) {
    query = query || {};
    const agent = this.registry.get(agentId);
    if (!agent) return { allowed: false, reason: 'unknown_agent' };
    if (agent.revoked_at) return { allowed: false, reason: 'agent_revoked' };
    if (agent.enabled !== 1) return { allowed: false, reason: 'agent_disabled' };

    if (!this.allowedKinds.includes(query.kind)) {
      throw new AgentToolError('unknown kind: ' + query.kind, 'bad_kind');
    }
    if (!query.toolId) throw new AgentToolError('toolId required', 'bad_tool_id');

    const binding = this.store.agentToolBindingsFind(agent.id, query.kind, query.toolId);
    if (!binding) return { allowed: false, reason: 'no_binding' };
    if (binding.revoked_at) return { allowed: false, reason: 'binding_revoked', binding };
    if (binding.enabled !== 1) return { allowed: false, reason: 'binding_disabled', binding };
    if (binding.expires_at && new Date(binding.expires_at).getTime() < Date.now()) {
      return { allowed: false, reason: 'binding_expired', binding };
    }

    const operations = safeArray(binding.operations_json);
    if (operations.length > 0 && query.operation) {
      if (!operations.includes(query.operation)) {
        return { allowed: false, reason: 'operation_not_allowed', binding };
      }
    }

    return {
      allowed: true,
      reason: 'ok',
      binding: this._decorate(binding),
    };
  }

  list(agentId, options) {
    options = options || {};
    const filter = { agent_id: agentId };
    if (options.kind) filter.kind = options.kind;
    if (options.active !== false) filter.active = true;
    return this.store.agentToolBindingsList(filter).map((r) => this._decorate(r));
  }

  /** List concrete tools (id only) this agent can currently invoke. */
  effectiveTools(agentId, options) {
    options = options || {};
    const bindings = this.list(agentId, options);
    return bindings
      .filter((b) => b.enabled && !b.expired)
      .map((b) => ({ kind: b.kind, tool_id: b.tool_id, operations: b.operations }));
  }

  /** Who can invoke a given (kind, toolId)? */
  agentsFor(kind, toolId) {
    const rows = this.store.agentToolBindingsList({
      kind, tool_id: toolId, active: true, enabled: true,
    });
    const out = [];
    for (const r of rows) {
      if (r.expires_at && new Date(r.expires_at).getTime() < Date.now()) continue;
      const agent = this.registry.get(r.agent_id);
      if (!agent || agent.revoked_at || agent.enabled !== 1) continue;
      out.push({ agent, binding: this._decorate(r) });
    }
    return out;
  }

  _agent(id) {
    if (!id) throw new AgentToolError('agentId required', 'bad_agent_id');
    const agent = this.registry.get(id);
    if (!agent) throw new AgentToolError('agent not found', 'not_found');
    if (agent.revoked_at) throw new AgentToolError('agent revoked', 'revoked');
    return agent;
  }

  _decorate(row) {
    const operations = safeArray(row.operations_json);
    const expired = row.expires_at
      ? new Date(row.expires_at).getTime() < Date.now()
      : false;
    return {
      id: row.id,
      agent_id: row.agent_id,
      kind: row.kind,
      tool_id: row.tool_id,
      operations,
      enabled: row.enabled === 1,
      expired,
      created_at: row.created_at,
      created_by: row.created_by,
      expires_at: row.expires_at || null,
      revoked_at: row.revoked_at || null,
    };
  }
}

function safeArray(s) {
  try { return JSON.parse(s || '[]'); } catch { return []; }
}

module.exports = { AgentTools, AgentToolError, KINDS };
