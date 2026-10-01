'use strict';

const crypto = require('node:crypto');

class BudgetError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BudgetError';
    this.code = code || 'budget_error';
  }
}

class BudgetExceededError extends BudgetError {
  constructor(message, exceeded) {
    super(message || 'Budget exceeded.', 'budget_exceeded');
    this.name = 'BudgetExceededError';
    this.exceeded = exceeded || [];
  }
}

const nowIso = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID()}`;
const BUDGET_KINDS = ['tokens', 'usd', 'wallclock_ms', 'jobs', 'prs'];

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function startOfWindow(window, ms) {
  const d = new Date(ms);
  if (window === 'hour') {
    return new Date(Date.UTC(
      d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()
    )).toISOString();
  }
  return new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()
  )).toISOString();
}

class BudgetEngine {
  constructor(store, options) {
    options = options || {};
    if (!store) throw new BudgetError('store required', 'bad_store');
    this.store = store;
  }

  setBudget(input) {
    if (!input || !input.subject || !input.limits) {
      throw new BudgetError('subject and limits required', 'bad_input');
    }
    const { type, id } = input.subject;
    if (!type || !id) throw new BudgetError('subject.type and subject.id required', 'bad_subject');
    const window = input.window || 'day';
    if (window !== 'day' && window !== 'hour') {
      throw new BudgetError('window must be day or hour', 'bad_window');
    }
    for (const k of Object.keys(input.limits)) {
      if (!BUDGET_KINDS.includes(k)) {
        throw new BudgetError(`unknown budget kind: ${k}`, 'bad_kind');
      }
      if (!Number.isFinite(input.limits[k]) || input.limits[k] <= 0) {
        throw new BudgetError(`limit for ${k} must be positive`, 'bad_limit');
      }
    }
    const row = {
      id: input.id || uid('bud'),
      subject_type: type,
      subject_id: id,
      window,
      limits_json: JSON.stringify(input.limits),
      created_at: nowIso(),
      created_by: input.createdBy || 'system',
      revoked_at: null,
    };
    return this.store.budgetsInsert(row);
  }

  getBudget(id) { return this.store.budgetsGet(id); }
  listBudgets(filter) { return this.store.budgetsList(filter || {}); }
  revokeBudget(id) { return this.store.budgetsRevoke(id); }

  usage(subject) {
    const { type, id } = subject;
    if (!type || !id) throw new BudgetError('subject.type and subject.id required', 'bad_subject');
    const budgets = this.store.budgetsList({ subject_type: type, subject_id: id, active: true });
    const out = {};
    for (const b of budgets) {
      const since = startOfWindow(b.window, Date.now());
      const limits = safeParse(b.limits_json) || {};
      out[b.id] = { window: b.window, since, kinds: {} };
      for (const kind of Object.keys(limits)) {
        out[b.id].kinds[kind] = {
          limit: limits[kind],
          used: this.store.budgetConsumptionSum(type, id, kind, since),
        };
      }
    }
    return out;
  }

  check(subject) {
    const { type, id } = subject;
    if (!type || !id) throw new BudgetError('subject.type and subject.id required', 'bad_subject');
    const budgets = this.store.budgetsList({ subject_type: type, subject_id: id, active: true });
    const exceeded = [];
    for (const b of budgets) {
      const since = startOfWindow(b.window, Date.now());
      const limits = safeParse(b.limits_json) || {};
      for (const kind of Object.keys(limits)) {
        const used = this.store.budgetConsumptionSum(type, id, kind, since);
        if (used >= limits[kind]) {
          exceeded.push({ budgetId: b.id, kind, limit: limits[kind], used, window: b.window });
        }
      }
    }
    return { ok: exceeded.length === 0, exceeded };
  }

  charge(subject, kind, amount, refId) {
    if (!BUDGET_KINDS.includes(kind)) {
      throw new BudgetError(`unknown kind: ${kind}`, 'bad_kind');
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BudgetError('amount must be positive', 'bad_amount');
    }
    const { type, id } = subject;
    if (!type || !id) throw new BudgetError('subject.type and subject.id required', 'bad_subject');

    // Attribute to first matching active budget (or null if none).
    const budgets = this.store.budgetsList({ subject_type: type, subject_id: id, active: true });
    const bucket = budgets.find((b) => {
      const limits = safeParse(b.limits_json) || {};
      return Object.prototype.hasOwnProperty.call(limits, kind);
    });

    const row = {
      id: uid('bc'),
      budget_id: bucket ? bucket.id : null,
      subject_type: type,
      subject_id: id,
      kind,
      amount,
      ref_id: refId || null,
      timestamp: nowIso(),
    };
    this.store.budgetConsumptionInsert(row);

    const result = this.check(subject);
    return { ok: result.ok, exceeded: result.exceeded, entry: row };
  }

  guard(subject) {
    const result = this.check(subject);
    if (!result.ok) {
      throw new BudgetExceededError('Budget exceeded.', result.exceeded);
    }
    return result;
  }

  snapshot() {
    return {
      budgets: this.store.budgetsList({}),
      generated_at: nowIso(),
    };
  }
}

module.exports = { BudgetEngine, BudgetError, BudgetExceededError, BUDGET_KINDS };
