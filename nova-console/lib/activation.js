'use strict';

class ActivationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ActivationError';
    this.code = code || 'activation_error';
  }
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

/**
 * Activation ladder.
 *
 * Read-only state model that reports which step a new operator has
 * reached. Five steps, ordered. Each step answers a single question
 * with a boolean and, if done, a short human detail.
 *
 *   runtime     — server up, DB reachable
 *   model       — at least one qualified local model
 *   outcome     — one document, one completed job, or one conversation
 *   capability  — one granted policy, one enabled skill, or one MCP connection
 *   verified    — one clover proof, one correctness pipeline run, or one green commit
 *
 * No mutations. No state. Idempotent.
 */
class ActivationLadder {
  constructor(store, deps) {
    deps = deps || {};
    if (!store) throw new ActivationError('store required', 'bad_store');
    this.store = store;
    this.now = deps.now || (() => new Date().toISOString());
  }

  snapshot() {
    const steps = [
      this._runtime(),
      this._model(),
      this._outcome(),
      this._capability(),
      this._verified(),
    ];
    const completed = steps.filter((s) => s.done).length;
    const next = steps.find((s) => !s.done) || null;
    return {
      generated_at: this.now(),
      completed,
      total: steps.length,
      done: completed === steps.length,
      next_step: next
        ? { id: next.id, label: next.label, action: next.action }
        : null,
      steps,
    };
  }

  _runtime() {
    return {
      id: 'runtime',
      label: 'Local runtime ready',
      description: 'The NOVA server is running and the local database is reachable.',
      done: true,
      detail: 'loopback only',
      action: null,
    };
  }

  _model() {
    const quals = safe(() => this.store.all('modelQualifications'), []);
    const qualified = quals.filter(isQualified);
    const done = qualified.length > 0;
    let detail = 'no qualified model yet';
    if (done) {
      const name = qualified[0].model || qualified[0].modelName || qualified[0].modelId || qualified[0].id || '?';
      detail = qualified.length + ' qualified · ' + name;
    }
    return {
      id: 'model',
      label: 'One qualified model',
      description: 'Qualify at least one local Ollama model before using it.',
      done,
      detail,
      action: done ? null : { label: 'Sync and qualify', href: '/#models' },
    };
  }

  _outcome() {
    const docs = safe(() => this.store.all('knowledgeDocuments'), []);
    const completed = safe(() => this.store.jobsListByState('completed'), []);
    const sessions = safe(() => this.store.all('sessions'), []);
    const chats = sessions.filter(
      (s) => Array.isArray(s.messages) && s.messages.length > 0
    );
    const total = docs.length + completed.length + chats.length;
    const done = total > 0;
    let detail = 'no useful outcome yet';
    if (done) {
      const parts = [];
      if (docs.length > 0) parts.push(docs.length + ' documents');
      if (completed.length > 0) parts.push(completed.length + ' jobs');
      if (chats.length > 0) parts.push(chats.length + ' conversations');
      detail = parts.join(' · ');
    }
    return {
      id: 'outcome',
      label: 'One safe outcome',
      description: 'Ingest a document, run a small job, or have a conversation.',
      done,
      detail,
      action: done ? null : { label: 'Open a session', href: '/' },
    };
  }

  _capability() {
    const policies = safe(() => this.store.policiesList({ active: true }), []);
    const skills = safe(
      () => this.store.all('skills').filter((s) => s.enabled === true),
      []
    );
    const mcp = safe(
      () => this.store.all('mcpServers').filter((s) => s.status === 'connected'),
      []
    );
    const total = policies.length + skills.length + mcp.length;
    const done = total > 0;
    let detail = 'no approved capability yet';
    if (done) {
      const parts = [];
      if (policies.length > 0) parts.push(policies.length + ' policies');
      if (skills.length > 0) parts.push(skills.length + ' skills');
      if (mcp.length > 0) parts.push(mcp.length + ' MCP servers');
      detail = parts.join(' · ');
    }
    return {
      id: 'capability',
      label: 'One approved capability',
      description: 'Grant a policy, enable a skill, or connect an MCP server.',
      done,
      detail,
      action: done ? null : { label: 'Review capabilities', href: '/#skills' },
    };
  }

  _verified() {
    const correctness = safe(
      () => this.store.correctnessPipelineRunsList({ status: 'verified' }),
      []
    );
    const clover = safe(
      () => this.store.cloverVerificationsList({ status: 'verified' }),
      []
    );
    const green = safe(() => this.store.greenCommitsList(), []);
    // Changes NOVA applied to a project only after their checks passed, and
    // improve-and-test loops whose tests passed, count as verified too: they
    // are the verified outcomes most people reach from the console.
    const applied = safe(() => this.store.all('workspaceChanges').concat(this.store.all('workspaceChangeBatches')).filter((c) => c.status === 'applied'), []);
    const loops = safe(() => this.store.all('workspaceLoops').filter((l) => Array.isArray(l.attempts) && l.attempts.some((a) => a.status === 'passed')), []);
    const total = correctness.length + clover.length + green.length + applied.length + loops.length;
    const done = total > 0;
    let detail = 'no verified outcome yet';
    if (done) {
      const parts = [];
      if (correctness.length > 0) parts.push(correctness.length + ' pipeline runs');
      if (clover.length > 0) parts.push(clover.length + ' clover proofs');
      if (green.length > 0) parts.push(green.length + ' green commits');
      if (applied.length > 0) parts.push(applied.length + ' checked changes applied');
      if (loops.length > 0) parts.push(loops.length + ' loops with passing tests');
      detail = parts.join(' · ');
    }
    return {
      id: 'verified',
      label: 'One verified outcome',
      description: 'Apply a code change after its checks pass, finish an improve-and-test loop with passing tests, or run the correctness pipeline.',
      done,
      detail,
      action: done ? null : { label: 'Open Local Workspace', href: '/#workspace' },
    };
  }
}

function isQualified(q) {
  if (!q) return false;
  if (q.passed === true) return true;
  // Records written by the coding qualification suite: qualified for at
  // least one-file changes plus the three control checks, as the planner
  // requires before it will use the model.
  const caps = q.capabilities;
  if (caps && typeof caps === 'object' && ['single-file', 'clarification', 'timeout', 'cancellation'].every((c) => caps[c] && caps[c].qualified)) return true;
  const s = String(q.status || q.result || q.outcome || '').toLowerCase();
  return s === 'qualified' || s === 'pass' || s === 'passed';
}

module.exports = { ActivationLadder, ActivationError, isQualified };
