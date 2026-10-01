'use strict';

const crypto = require('node:crypto');

const nowIso = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID()}`;

const ROLES = [
  'worker', 'planner', 'reviewer', 'supervisor', 'researcher', 'collector',
];

const MEMORY_SCOPES = ['private', 'shared', 'supervisor-visible'];

class AgentRegistryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AgentRegistryError';
    this.code = code || 'agent_registry_error';
  }
}

/**
 * Agent registry.
 *
 * A durable agent is a named role with:
 *   - instructions        — system prompt / behavior contract
 *   - model_preference    — {provider, model, temperature?} or null
 *   - allowed_tools       — explicit list of tools this agent can invoke
 *   - memory_scope        — private | shared | supervisor-visible
 *   - supervisor_id       — optional parent agent that reviews escalations
 *
 * The registry is metadata only. Execution happens elsewhere.
 * Agents do not spawn processes; they declare capabilities.
 */
class AgentRegistry {
  constructor(store, options) {
    options = options || {};
    if (!store) throw new AgentRegistryError('store required', 'bad_store');
    this.store = store;
    this.allowedRoles = Array.isArray(options.allowedRoles)
      ? options.allowedRoles.slice()
      : ROLES.slice();
  }

  create(input) {
    input = input || {};
    if (!input.name || typeof input.name !== 'string' || !input.name.trim()) {
      throw new AgentRegistryError('name required', 'bad_name');
    }
    if (!input.role || typeof input.role !== 'string') {
      throw new AgentRegistryError('role required', 'bad_role');
    }
    if (!this.allowedRoles.includes(input.role)) {
      throw new AgentRegistryError('unknown role: ' + input.role, 'unknown_role');
    }
    if (input.instructions != null && typeof input.instructions !== 'object') {
      throw new AgentRegistryError('instructions must be an object', 'bad_instructions');
    }
    if (input.allowedTools != null && !Array.isArray(input.allowedTools)) {
      throw new AgentRegistryError('allowedTools must be an array', 'bad_tools');
    }
    if (this.store.agentRegistryFindByName(input.name.trim())) {
      throw new AgentRegistryError('name already exists', 'duplicate_name');
    }
    const memoryScope = input.memoryScope || 'private';
    if (!MEMORY_SCOPES.includes(memoryScope)) {
      throw new AgentRegistryError('unknown memoryScope: ' + memoryScope, 'bad_memory_scope');
    }
    if (input.supervisorId) {
      const sup = this.store.agentRegistryGet(input.supervisorId);
      if (!sup) throw new AgentRegistryError('supervisor not found', 'bad_supervisor');
      if (sup.revoked_at) throw new AgentRegistryError('supervisor revoked', 'supervisor_revoked');
    }

    const tools = (input.allowedTools || []).map(String);
    for (const t of tools) {
      if (!/^[a-z0-9:_.-]+$/i.test(t)) {
        throw new AgentRegistryError('invalid tool name: ' + t, 'bad_tool_name');
      }
    }

    return this.store.agentRegistryInsert({
      id: input.id || uid('agt'),
      name: input.name.trim(),
      role: input.role,
      description: input.description || null,
      instructions_json: JSON.stringify(input.instructions || {}),
      model_preference_json: input.modelPreference
        ? JSON.stringify(input.modelPreference) : null,
      allowed_tools_json: JSON.stringify(tools),
      memory_scope: memoryScope,
      supervisor_id: input.supervisorId || null,
      enabled: input.enabled !== false,
      created_at: nowIso(),
      created_by: input.createdBy || 'system',
      revoked_at: null,
    });
  }

  get(id) {
    if (!id) throw new AgentRegistryError('id required', 'bad_id');
    return this.store.agentRegistryGet(id);
  }

  getByName(name) {
    if (!name) throw new AgentRegistryError('name required', 'bad_name');
    return this.store.agentRegistryFindByName(name);
  }

  list(filter) { return this.store.agentRegistryList(filter || {}); }

  enable(id) {
    const cur = this.get(id);
    if (!cur) throw new AgentRegistryError('agent not found', 'not_found');
    if (cur.revoked_at) throw new AgentRegistryError('agent revoked', 'revoked');
    return this.store.agentRegistryUpdate(id, { enabled: 1 });
  }

  disable(id) {
    const cur = this.get(id);
    if (!cur) throw new AgentRegistryError('agent not found', 'not_found');
    return this.store.agentRegistryUpdate(id, { enabled: 0 });
  }

  revoke(id) {
    const cur = this.get(id);
    if (!cur) throw new AgentRegistryError('agent not found', 'not_found');
    if (cur.revoked_at) return cur;
    const subordinates = this.store.agentRegistryList({ supervisor_id: id, active: true });
    if (subordinates.length > 0) {
      throw new AgentRegistryError(
        'cannot revoke agent with active subordinates',
        'has_subordinates'
      );
    }
    return this.store.agentRegistryUpdate(id, { revoked_at: nowIso(), enabled: 0 });
  }

  updateInstructions(id, instructions) {
    if (!instructions || typeof instructions !== 'object') {
      throw new AgentRegistryError('instructions must be an object', 'bad_instructions');
    }
    const cur = this.get(id);
    if (!cur) throw new AgentRegistryError('agent not found', 'not_found');
    if (cur.revoked_at) throw new AgentRegistryError('agent revoked', 'revoked');
    return this.store.agentRegistryUpdate(id, {
      instructions_json: JSON.stringify(instructions),
    });
  }

  setModelPreference(id, pref) {
    if (pref != null && typeof pref !== 'object') {
      throw new AgentRegistryError('modelPreference must be an object or null', 'bad_model_preference');
    }
    const cur = this.get(id);
    if (!cur) throw new AgentRegistryError('agent not found', 'not_found');
    if (cur.revoked_at) throw new AgentRegistryError('agent revoked', 'revoked');
    return this.store.agentRegistryUpdate(id, {
      model_preference_json: pref ? JSON.stringify(pref) : null,
    });
  }

  setAllowedTools(id, tools) {
    if (!Array.isArray(tools)) {
      throw new AgentRegistryError('tools must be an array', 'bad_tools');
    }
    const cur = this.get(id);
    if (!cur) throw new AgentRegistryError('agent not found', 'not_found');
    if (cur.revoked_at) throw new AgentRegistryError('agent revoked', 'revoked');
    return this.store.agentRegistryUpdate(id, {
      allowed_tools_json: JSON.stringify(tools.map(String)),
    });
  }

  setSupervisor(id, supervisorId) {
    const cur = this.get(id);
    if (!cur) throw new AgentRegistryError('agent not found', 'not_found');
    if (cur.revoked_at) throw new AgentRegistryError('agent revoked', 'revoked');
    if (supervisorId === id) {
      throw new AgentRegistryError('agent cannot supervise itself', 'self_supervisor');
    }
    if (supervisorId) {
      const sup = this.store.agentRegistryGet(supervisorId);
      if (!sup) throw new AgentRegistryError('supervisor not found', 'bad_supervisor');
      if (sup.revoked_at) throw new AgentRegistryError('supervisor revoked', 'supervisor_revoked');
      if (this._wouldCycle(id, supervisorId)) {
        throw new AgentRegistryError('would create supervision cycle', 'supervisor_cycle');
      }
    }
    return this.store.agentRegistryUpdate(id, { supervisor_id: supervisorId || null });
  }

  isActive(id) {
    const cur = this.store.agentRegistryGet(id);
    if (!cur) return false;
    return !cur.revoked_at && cur.enabled === 1;
  }

  instructions(id) {
    const cur = this.get(id);
    if (!cur) throw new AgentRegistryError('agent not found', 'not_found');
    try { return JSON.parse(cur.instructions_json || '{}'); }
    catch { return {}; }
  }

  allowedTools(id) {
    const cur = this.get(id);
    if (!cur) throw new AgentRegistryError('agent not found', 'not_found');
    try { return JSON.parse(cur.allowed_tools_json || '[]'); }
    catch { return []; }
  }

  hasTool(id, tool) {
    if (!tool) return false;
    return this.allowedTools(id).includes(tool);
  }

  modelPreference(id) {
    const cur = this.get(id);
    if (!cur) throw new AgentRegistryError('agent not found', 'not_found');
    if (!cur.model_preference_json) return null;
    try { return JSON.parse(cur.model_preference_json); }
    catch { return null; }
  }

  subordinates(supervisorId) {
    return this.store.agentRegistryList({ supervisor_id: supervisorId, active: true });
  }

  _wouldCycle(childId, supervisorId) {
    // Walk up from supervisor; if we reach childId, it is a cycle
    let current = supervisorId;
    const seen = new Set();
    while (current) {
      if (current === childId) return true;
      if (seen.has(current)) return false; // preexisting cycle, do not extend
      seen.add(current);
      const sup = this.store.agentRegistryGet(current);
      current = sup ? sup.supervisor_id : null;
    }
    return false;
  }

  health() {
    const all = this.list({ active: true });
    const byRole = {};
    for (const a of all) byRole[a.role] = (byRole[a.role] || 0) + 1;
    return {
      total: all.length,
      enabled: all.filter((a) => a.enabled === 1).length,
      disabled: all.filter((a) => a.enabled === 0).length,
      with_supervisor: all.filter((a) => a.supervisor_id).length,
      by_role: byRole,
    };
  }
}

module.exports = { AgentRegistry, AgentRegistryError, ROLES, MEMORY_SCOPES };
