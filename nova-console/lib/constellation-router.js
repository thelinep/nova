'use strict';

const crypto = require('node:crypto');

const nowIso = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID()}`;
const hash = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');

class ConstellationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ConstellationError';
    this.code = code || 'constellation_error';
  }
}

class ConstellationEscalationError extends ConstellationError {
  constructor(reason, detail) {
    super(`Escalated: ${reason}`, 'escalated');
    this.name = 'ConstellationEscalationError';
    this.escalation_reason = reason;
    this.detail = detail || null;
  }
}

class ConstellationRouter {
  constructor(store, deps) {
    deps = deps || {};
    if (!store) throw new ConstellationError('store required', 'bad_store');
    if (!Array.isArray(deps.providers) || deps.providers.length === 0) {
      throw new ConstellationError('providers array required', 'bad_providers');
    }
    for (const p of deps.providers) {
      if (!p || typeof p.id !== 'string' || typeof p.generate !== 'function') {
        throw new ConstellationError('each provider needs {id, generate}', 'bad_provider');
      }
    }
    this.store = store;
    this.providers = deps.providers.slice();
    this.policy = deps.policy || null;
    this.budgets = deps.budgets || null;
    this.killSwitch = deps.killSwitch || null;
    this.audit = typeof deps.audit === 'function' ? deps.audit : null;
    this.agentId = deps.agentId || 'constellation';
    this.subject = { type: 'agent', id: this.agentId };
    this.resource = { type: 'tool', id: 'constellation.generate' };
    this.defaultTimeoutMs = deps.timeoutMs || 60000;
    this.groupSize = deps.groupSize || 5;
    this.votesPerPair = deps.votesPerPair || 3;
    this.chargePerProvider = deps.chargePerProvider || 1;
  }

  _preflight() {
    if (this.killSwitch && this.killSwitch.isHalted()) {
      throw new ConstellationEscalationError('kill_switch_active', this.killSwitch.status());
    }
    if (this.policy) {
      try { this.policy.enforce(this.subject, this.resource); }
      catch (e) { throw new ConstellationEscalationError('policy_denied', { reason: e.reason || e.message }); }
    }
    if (this.budgets) {
      const r = this.budgets.check(this.subject);
      if (!r.ok) throw new ConstellationEscalationError('budget_exceeded', r.exceeded);
    }
  }

  async _runProvider(provider, problem, context) {
    const startedAt = Date.now();
    try {
      const code = await Promise.race([
        provider.generate(problem, context),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('provider_timeout')), context.timeoutMs || this.defaultTimeoutMs)),
      ]);
      return { ok: true, provider: provider.id, code, elapsed_ms: Date.now() - startedAt };
    } catch (e) {
      return { ok: false, provider: provider.id, error: String(e.message || e), elapsed_ms: Date.now() - startedAt };
    }
  }

  async generate(problem, options) {
    options = options || {};
    if (typeof problem !== 'string' || problem.length === 0) {
      throw new ConstellationError('problem must be a non-empty string', 'bad_problem');
    }

    const runId = uid('cnr');
    const problemHash = hash(problem);
    const startedAt = nowIso();

    this.store.constellationRunsInsert({
      id: runId,
      problem_hash: problemHash,
      provider_count: this.providers.length,
      candidate_count: 0,
      status: 'started',
      started_at: startedAt,
    });

    try {
      this._preflight();
    } catch (e) {
      this.store.constellationRunsUpdate(runId, { status: 'escalated', ended_at: nowIso() });
      this._audit('escalated', { runId, reason: e.escalation_reason || e.code });
      return { ok: false, escalated: true, reason: e.escalation_reason || e.code, runId, candidates: [] };
    }

    const context = {
      runId,
      timeoutMs: options.timeoutMs || this.defaultTimeoutMs,
      agentId: this.agentId,
    };

    const results = await Promise.all(
      this.providers.map((p) => this._runProvider(p, problem, context))
    );

    const candidates = [];
    for (const r of results) {
      const candidateId = uid('cand');
      this.store.constellationCandidatesInsert({
        id: candidateId,
        run_id: runId,
        provider_id: r.provider,
        code: r.ok ? r.code : null,
        error: r.ok ? null : r.error,
        created_at: nowIso(),
      });
      if (r.ok) {
        candidates.push({ id: candidateId, provider: r.provider, code: r.code, elapsed_ms: r.elapsed_ms });
      }
    }

    if (this.budgets) {
      try {
        for (let i = 0; i < this.providers.length; i++) {
          this.budgets.charge(this.subject, 'jobs', this.chargePerProvider, runId);
        }
      } catch { /* charge failures do not abort */ }
    }

    const status = candidates.length > 0 ? 'completed' : 'all_failed';
    this.store.constellationRunsUpdate(runId, {
      candidate_count: candidates.length,
      status,
      ended_at: nowIso(),
    });

    this._audit('generate', {
      runId,
      provider_count: this.providers.length,
      candidate_count: candidates.length,
      status,
    });

    return { ok: candidates.length > 0, escalated: false, runId, candidates, status };
  }

  async select(runId, candidates, judge) {
    if (!runId) throw new ConstellationError('runId required', 'bad_run_id');
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new ConstellationError('candidates array required', 'bad_candidates');
    }
    if (typeof judge !== 'function') {
      throw new ConstellationError('judge function required', 'bad_judge');
    }
    if (candidates.length === 1) return { ok: true, winner: candidates[0], rounds: 0 };

    let population = candidates.slice();
    let round = 0;
    while (population.length > 1) {
      round++;
      const groups = this._partition(population, this.groupSize);
      const winners = [];
      for (let gi = 0; gi < groups.length; gi++) {
        const winner = await this._runGroup(runId, round, gi, groups[gi], judge);
        winners.push(winner);
      }
      population = winners;
    }

    const winner = population[0];
    this.store.constellationRunsUpdate(runId, { winner_id: winner.id });
    this._audit('select', { runId, winner_id: winner.id, rounds: round });

    return { ok: true, winner, rounds: round };
  }

  async _runGroup(runId, round, groupIndex, group, judge) {
    const entrants = group.map((c) => c.id);
    if (group.length === 1) {
      this.store.constellationRoundsInsert({
        id: uid('cnrd'), run_id: runId, round, group_index: groupIndex,
        entrants_json: JSON.stringify(entrants),
        winner_id: group[0].id,
        votes_json: JSON.stringify([]),
        created_at: nowIso(),
      });
      return group[0];
    }

    let contenders = group.slice();
    const allVotes = [];
    while (contenders.length > 1) {
      const next = [];
      for (let i = 0; i < contenders.length; i += 2) {
        if (i + 1 >= contenders.length) { next.push(contenders[i]); continue; }
        const a = contenders[i], b = contenders[i + 1];
        const votes = [];
        for (let v = 0; v < this.votesPerPair; v++) {
          let verdict;
          try { verdict = await judge(a, b, { runId, round }); }
          catch { verdict = 'tie'; }
          votes.push(verdict);
        }
        allVotes.push({ a: a.id, b: b.id, votes });
        next.push(this._pickWinner(a, b, votes));
      }
      contenders = next;
    }

    const winnerId = contenders[0].id;
    this.store.constellationRoundsInsert({
      id: uid('cnrd'), run_id: runId, round, group_index: groupIndex,
      entrants_json: JSON.stringify(entrants),
      winner_id: winnerId,
      votes_json: JSON.stringify(allVotes),
      created_at: nowIso(),
    });
    return contenders[0];
  }

  _pickWinner(a, b, votes) {
    let va = 0, vb = 0;
    for (const v of votes) {
      if (v === 'a') va++;
      else if (v === 'b') vb++;
    }
    if (va > vb) return a;
    if (vb > va) return b;
    return a.id < b.id ? a : b;
  }

  _partition(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  _audit(kind, data) {
    if (!this.audit) return;
    try { this.audit({ action: `constellation.${kind}`, agent_id: this.agentId, ...data }); }
    catch { /* best-effort */ }
  }

  history(filter) { return this.store.constellationRunsList(filter || {}); }
  candidates(runId) { return this.store.constellationCandidatesList(runId); }
  rounds(runId) { return this.store.constellationRoundsList(runId); }
}

module.exports = { ConstellationRouter, ConstellationError, ConstellationEscalationError };
