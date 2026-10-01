'use strict';

const crypto = require('node:crypto');

const nowIso = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID()}`;
const hash = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');

class CorrectnessPipelineError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CorrectnessPipelineError';
    this.code = code || 'correctness_pipeline_error';
  }
}

/**
 * Composes the Constellation router (generate + RTV select) with the
 * Clover verifier (consistency + DafnyPro proof) into one pipeline with
 * a single lineage.
 *
 * Stages:
 *   1. generate  — router.generate(problem)
 *   2. select    — router.select(runId, candidates, judge)
 *   3. verify    — clover.verify(problem, winner.code)  [optional]
 *
 * Terminal status is one of:
 *   verified             — clover returned ok
 *   selected             — clover not configured; winner selected but not verified
 *   escalated            — constellation denied at preflight (kill/policy/budget)
 *   select_failed        — RTV failed
 *   verify_failed        — clover threw
 *   <clover terminal>    — clover returned a non-verified status (honest passthrough)
 */
class CorrectnessPipeline {
  constructor(store, deps) {
    deps = deps || {};
    if (!store) throw new CorrectnessPipelineError('store required', 'bad_store');
    if (!deps.router
        || typeof deps.router.generate !== 'function'
        || typeof deps.router.select !== 'function') {
      throw new CorrectnessPipelineError('router with generate+select required', 'bad_router');
    }
    this.store = store;
    this.router = deps.router;
    this.clover = deps.clover || null;
    this.judge = typeof deps.judge === 'function' ? deps.judge : null;
    this.audit = typeof deps.audit === 'function' ? deps.audit : null;
    this.agentId = deps.agentId || 'correctness-pipeline';
  }

  async run(problem, options) {
    options = options || {};
    if (typeof problem !== 'string' || !problem) {
      throw new CorrectnessPipelineError('problem required', 'bad_problem');
    }

    const runId = uid('cpp');
    const startedAt = nowIso();
    const problemHash = hash(problem);

    this.store.correctnessPipelineRunsInsert({
      id: runId,
      problem_hash: problemHash,
      status: 'pending',
      stage: 'generate',
      started_at: startedAt,
    });
    this._audit('started', { runId, agent_id: this.agentId });

    // --- Stage 1: generate ---
    let gen;
    try {
      gen = await this.router.generate(problem, options);
    } catch (e) {
      return this._finish(runId, 'escalated', {
        stage: 'generate',
        detail: String(e.message || e),
      });
    }

    if (!gen.ok) {
      const reason = gen.escalated ? (gen.reason || 'escalated') : 'all_failed';
      return this._finish(runId, 'escalated', {
        stage: 'generate',
        detail: reason,
        constellation_run_id: gen.runId,
      });
    }

    this.store.correctnessPipelineRunsUpdate(runId, {
      constellation_run_id: gen.runId,
      status: 'generated',
      stage: 'select',
    });
    this._audit('generated', {
      runId,
      constellation_run_id: gen.runId,
      candidate_count: gen.candidates.length,
    });

    // --- Stage 2: select ---
    const judge = options.judge || this.judge || defaultShortestJudge;
    let sel;
    try {
      sel = await this.router.select(gen.runId, gen.candidates, judge);
    } catch (e) {
      return this._finish(runId, 'select_failed', {
        stage: 'select',
        detail: String(e.message || e),
        constellation_run_id: gen.runId,
      });
    }

    if (!sel.ok || !sel.winner) {
      return this._finish(runId, 'select_failed', {
        stage: 'select',
        detail: 'no winner',
        constellation_run_id: gen.runId,
      });
    }

    this.store.correctnessPipelineRunsUpdate(runId, {
      constellation_winner_id: sel.winner.id,
      status: 'selected',
      stage: this.clover ? 'verify' : 'done',
    });
    this._audit('selected', {
      runId,
      winner_id: sel.winner.id,
      winner_provider: sel.winner.provider,
      rounds: sel.rounds,
    });

    // --- Stage 3: verify (optional) ---
    if (!this.clover) {
      return this._finish(runId, 'selected', {
        stage: 'done',
        detail: 'clover not configured',
        constellation_run_id: gen.runId,
        constellation_winner_id: sel.winner.id,
        winner: sel.winner,
      });
    }

    let ver;
    try {
      ver = await this.clover.verify(problem, sel.winner.code, options);
    } catch (e) {
      return this._finish(runId, 'verify_failed', {
        stage: 'verify',
        detail: String(e.message || e),
        constellation_run_id: gen.runId,
        constellation_winner_id: sel.winner.id,
      });
    }

    return this._finish(runId, ver.status, {
      stage: 'done',
      detail: ver.detail || null,
      constellation_run_id: gen.runId,
      constellation_winner_id: sel.winner.id,
      clover_run_id: ver.runId,
      consistency_ok: ver.consistency_ok,
      proof_ok: ver.proof_ok,
      winner: sel.winner,
      verification: ver,
    });
  }

  _finish(runId, status, extra) {
    extra = extra || {};
    const row = this.store.correctnessPipelineRunsUpdate(runId, {
      status,
      stage: extra.stage || null,
      detail: extra.detail || null,
      constellation_run_id: extra.constellation_run_id || null,
      constellation_winner_id: extra.constellation_winner_id || null,
      clover_run_id: extra.clover_run_id || null,
      consistency_ok: extra.consistency_ok == null ? null : (extra.consistency_ok ? 1 : 0),
      proof_ok: extra.proof_ok == null ? null : (extra.proof_ok ? 1 : 0),
      ended_at: nowIso(),
    });
    this._audit('finished', { runId, status, stage: extra.stage });
    const ok = status === 'verified' || status === 'selected';
    return {
      ok,
      status,
      runId,
      stage: extra.stage || null,
      detail: extra.detail || null,
      constellation_run_id: extra.constellation_run_id || null,
      constellation_winner_id: extra.constellation_winner_id || null,
      clover_run_id: extra.clover_run_id || null,
      consistency_ok: extra.consistency_ok == null ? null : !!extra.consistency_ok,
      proof_ok: extra.proof_ok == null ? null : !!extra.proof_ok,
      winner: extra.winner || null,
      verification: extra.verification || null,
      row,
    };
  }

  _audit(kind, data) {
    if (!this.audit) return;
    try { this.audit({ action: `correctness_pipeline.${kind}`, agent_id: this.agentId, ...data }); }
    catch { /* best-effort */ }
  }

  history(filter) { return this.store.correctnessPipelineRunsList(filter || {}); }
  get(id) { return this.store.correctnessPipelineRunsGet(id); }
}

function defaultShortestJudge(a, b) {
  const la = (a && a.code ? a.code : '').length;
  const lb = (b && b.code ? b.code : '').length;
  if (la < lb) return 'a';
  if (lb < la) return 'b';
  return 'tie';
}

module.exports = { CorrectnessPipeline, CorrectnessPipelineError };
