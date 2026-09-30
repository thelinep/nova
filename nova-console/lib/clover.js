'use strict';

const crypto = require('node:crypto');

const nowIso = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID()}`;
const hash = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');

class CloverError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CloverError';
    this.code = code || 'clover_error';
  }
}

const FORBIDDEN_PATTERNS = [
  { pattern: /\bassume\s+false\b/, reason: 'assume_false' },
  { pattern: /\bassume\s+true\b/, reason: 'assume_true' },
];

const REQUIRES_OR_ENSURES = /\b(requires|ensures)\b/;

class CloverVerifier {
  constructor(store, deps) {
    deps = deps || {};
    if (!store) throw new CloverError('store required', 'bad_store');
    if (typeof deps.specGenerator !== 'function') throw new CloverError('specGenerator required', 'bad_spec_generator');
    if (typeof deps.dafnyPro === 'undefined' || deps.dafnyPro === null) {
      throw new CloverError('dafnyPro instance required', 'bad_dafny_pro');
    }
    this.store = store;
    this.specGenerator = deps.specGenerator;
    this.dafnyPro = deps.dafnyPro;
    this.consistencyChecker = typeof deps.consistencyChecker === 'function'
      ? deps.consistencyChecker
      : this._defaultConsistencyChecker.bind(this);
  }

  async verify(problem, candidateCode, options) {
    options = options || {};
    if (typeof problem !== 'string' || !problem) throw new CloverError('problem required', 'bad_problem');
    if (typeof candidateCode !== 'string' || !candidateCode) throw new CloverError('candidateCode required', 'bad_code');

    const runId = uid('clv');
    const startedAt = nowIso();

    this.store.cloverVerificationsInsert({
      id: runId,
      problem_hash: hash(problem),
      candidate_hash: hash(candidateCode),
      status: 'started',
      phase: 'generation',
      consistency_ok: null,
      proof_ok: null,
      proof_attempts: null,
      detail: null,
      started_at: startedAt,
    });

    let annotated;
    try {
      annotated = await this.specGenerator(problem, candidateCode, { runId });
    } catch (e) {
      return this._finish(runId, 'generator_failed', {
        phase: 'generation',
        detail: String(e.message || e),
      });
    }

    const triplet = {
      code: (annotated && annotated.code) || candidateCode,
      docstring: (annotated && annotated.docstring) || '',
      spec: (annotated && annotated.spec) || '',
    };

    if (!triplet.spec) {
      return this._finish(runId, 'missing_spec', {
        phase: 'generation',
        detail: 'specGenerator returned no spec',
      });
    }

    let consistency;
    try {
      consistency = await this.consistencyChecker(triplet, { runId });
    } catch (e) {
      return this._finish(runId, 'consistency_failed', {
        phase: 'consistency',
        detail: String(e.message || e),
      });
    }

    if (!consistency || consistency.consistent !== true) {
      return this._finish(runId, 'inconsistent', {
        phase: 'consistency',
        consistency_ok: 0,
        detail: (consistency && consistency.detail) || 'consistency check failed',
      });
    }

    let proof;
    try {
      proof = await this.dafnyPro.verify(triplet.code, triplet.spec, options);
    } catch (e) {
      return this._finish(runId, 'proof_error', {
        phase: 'proof',
        consistency_ok: 1,
        detail: String(e.message || e),
      });
    }

    const ok = proof && proof.ok === true;
    return this._finish(runId, ok ? 'verified' : 'proof_failed', {
      phase: 'proof',
      consistency_ok: 1,
      proof_ok: ok ? 1 : 0,
      proof_attempts: proof ? proof.attempts : 0,
      detail: ok ? null : 'dafny proof did not succeed',
      triplet,
      proof,
    });
  }

  _defaultConsistencyChecker(triplet) {
    const { code, docstring, spec } = triplet;
    if (!spec) return { consistent: false, detail: 'empty spec' };
    if (!REQUIRES_OR_ENSURES.test(spec)) {
      return { consistent: false, detail: 'spec has no requires or ensures' };
    }
    for (const fp of FORBIDDEN_PATTERNS) {
      if (fp.pattern.test(spec)) {
        return { consistent: false, detail: 'forbidden pattern: ' + fp.reason };
      }
      if (fp.pattern.test(code)) {
        return { consistent: false, detail: 'forbidden pattern in code: ' + fp.reason };
      }
    }
    const fnNames = (code.match(/\b(method|function)\s+([A-Za-z_][A-Za-z0-9_]*)/g) || [])
      .map((m) => m.replace(/^(method|function)\s+/, ''));
    if (fnNames.length === 0) {
      return { consistent: false, detail: 'code declares no method or function' };
    }
    for (const name of fnNames) {
      if (!spec.includes(name)) {
        return { consistent: false, detail: 'spec does not mention ' + name };
      }
    }
    if (docstring && !fnNames.some((n) => docstring.includes(n))) {
      return { consistent: false, detail: 'docstring does not mention any declared function' };
    }
    return { consistent: true, detail: null };
  }

  _finish(runId, status, extra) {
    extra = extra || {};
    const row = this.store.cloverVerificationsUpdate(runId, {
      status,
      phase: extra.phase || null,
      consistency_ok: extra.consistency_ok == null ? null : extra.consistency_ok,
      proof_ok: extra.proof_ok == null ? null : extra.proof_ok,
      proof_attempts: extra.proof_attempts == null ? null : extra.proof_attempts,
      detail: extra.detail || null,
      ended_at: nowIso(),
    });
    return {
      ok: status === 'verified',
      status,
      runId,
      phase: extra.phase || null,
      consistency_ok: extra.consistency_ok == null ? null : !!extra.consistency_ok,
      proof_ok: extra.proof_ok == null ? null : !!extra.proof_ok,
      proof_attempts: extra.proof_attempts || 0,
      detail: extra.detail || null,
      row,
    };
  }

  history(filter) { return this.store.cloverVerificationsList(filter || {}); }
  get(runId) { return this.store.cloverVerificationsGet(runId); }
}

module.exports = { CloverVerifier, CloverError };
