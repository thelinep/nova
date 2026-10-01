'use strict';

const ROLE_DEFAULTS = {
  supervisor: { tokens: 200000, usd: 10, jobs: 100, wallclock_ms: 3600000 },
  planner:    { tokens: 100000, usd: 5,  jobs: 50,  wallclock_ms: 1800000 },
  worker:     { tokens: 50000,  usd: 2,  jobs: 25,  wallclock_ms: 900000 },
  reviewer:   { tokens: 30000,  usd: 1,  jobs: 15,  wallclock_ms: 600000 },
  researcher: { tokens: 80000,  usd: 4,  jobs: 40,  wallclock_ms: 1200000 },
  collector:  { tokens: 60000,  usd: 3,  jobs: 30,  wallclock_ms: 900000 },
};

const DEFAULT_WINDOW = 'day';

class AgentBudgetError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AgentBudgetError';
    this.code = code || 'agent_budget_error';
  }
}

class AgentBudgets {
  constructor(deps) {
    deps = deps || {};
    if (!deps.store) throw new AgentBudgetError('store required', 'bad_store');
    if (!deps.registry) throw new AgentBudgetError('registry required', 'bad_registry');
    if (!deps.budgetEngine) throw new AgentBudgetError('budgetEngine required', 'bad_budget_engine');
    this.store = deps.store;
    this.registry = deps.registry;
    this.budgets = deps.budgetEngine;
    this.roleDefaults = deps.roleDefaults || ROLE_DEFAULTS;
    this.defaultWindow = deps.window || DEFAULT_WINDOW;
  }

  setForAgent(agentId, limits, options) {
    options = options || {};
    const agent = this._agent(agentId);
    if (!limits || typeof limits !== 'object' || Object.keys(limits).length === 0) {
      throw new AgentBudgetError('limits must be a non-empty object', 'bad_limits');
    }
    return this.budgets.setBudget({
      subject: { type: 'agent', id: agent.id },
      limits,
      window: options.window || this.defaultWindow,
      createdBy: options.createdBy || 'system',
    });
  }

  setFromRoleDefaults(agentId, overrides, options) {
    overrides = overrides || {};
    options = options || {};
    const agent = this._agent(agentId);
    const defaults = this.roleDefaults[agent.role];
    if (!defaults) {
      throw new AgentBudgetError('no defaults for role ' + agent.role, 'no_role_defaults');
    }
    const merged = Object.assign({}, defaults, overrides);
    return this.setForAgent(agentId, merged, options);
  }

  revoke(budgetId) {
    if (!budgetId) throw new AgentBudgetError('budgetId required', 'bad_budget_id');
    return this.budgets.revokeBudget(budgetId);
  }

  charge(agentId, kind, amount, refId, options) {
    options = options || {};
    const agent = this._agent(agentId);
    const cascade = options.cascade !== false;
    const chain = cascade ? this._chain(agent.id) : [agent.id];

    const results = [];
    const exceeded = [];

    for (const id of chain) {
      const r = this.budgets.charge({ type: 'agent', id }, kind, amount, refId);
      results.push({
        agent_id: id,
        ok: r.ok,
        entry_id: r.entry ? r.entry.id : null,
        budget_id: r.entry ? r.entry.budget_id : null,
      });
      if (!r.ok) {
        for (const e of r.exceeded) exceeded.push(Object.assign({ agent_id: id }, e));
      }
    }

    return { ok: exceeded.length === 0, chain: results, exceeded };
  }

  check(agentId, options) {
    options = options || {};
    const agent = this._agent(agentId);
    const cascade = options.cascade !== false;
    const chain = cascade ? this._chain(agent.id) : [agent.id];

    const results = [];
    const exceeded = [];

    for (const id of chain) {
      const r = this.budgets.check({ type: 'agent', id });
      results.push({ agent_id: id, ok: r.ok, exceeded: r.exceeded });
      if (!r.ok) {
        for (const e of r.exceeded) exceeded.push(Object.assign({ agent_id: id }, e));
      }
    }

    return { ok: exceeded.length === 0, chain: results, exceeded };
  }

  effectiveLimit(agentId, kind) {
    const agent = this._agent(agentId);
    if (!kind) throw new AgentBudgetError('kind required', 'bad_kind');
    const chain = this._chain(agent.id);

    let tightest = { agent_id: null, budget_id: null, limit: null, used: 0, remaining: Infinity };

    for (const id of chain) {
      const usage = this.budgets.usage({ type: 'agent', id });
      for (const budgetId of Object.keys(usage)) {
        const bucket = usage[budgetId];
        const k = bucket.kinds[kind];
        if (!k) continue;
        const remaining = Math.max(0, k.limit - k.used);
        if (remaining < tightest.remaining) {
          tightest = {
            agent_id: id,
            budget_id: budgetId,
            limit: k.limit,
            used: k.used,
            remaining,
          };
        }
      }
    }
    return tightest;
  }

  usageChain(agentId) {
    const agent = this._agent(agentId);
    const chain = this._chain(agent.id);
    const out = [];
    for (const id of chain) {
      out.push({ agent_id: id, budgets: this.budgets.usage({ type: 'agent', id }) });
    }
    return { agent_id: agent.id, chain: out };
  }

  _agent(id) {
    if (!id) throw new AgentBudgetError('agentId required', 'bad_agent_id');
    const agent = this.registry.get(id);
    if (!agent) throw new AgentBudgetError('agent not found', 'not_found');
    if (agent.revoked_at) throw new AgentBudgetError('agent revoked', 'revoked');
    return agent;
  }

  _chain(rootId) {
    const chain = [rootId];
    const seen = new Set([rootId]);
    let current = rootId;
    while (true) {
      const agent = this.registry.get(current);
      if (!agent || !agent.supervisor_id) break;
      if (seen.has(agent.supervisor_id)) break;
      seen.add(agent.supervisor_id);
      chain.push(agent.supervisor_id);
      current = agent.supervisor_id;
    }
    return chain;
  }
}

module.exports = { AgentBudgets, AgentBudgetError, ROLE_DEFAULTS };
