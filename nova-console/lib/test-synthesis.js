'use strict';

const crypto = require('node:crypto');

const nowIso = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID()}`;
const hash = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');

class TestSynthesisError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TestSynthesisError';
    this.code = code || 'test_synthesis_error';
  }
}

class TestSynthesisPipeline {
  constructor(store, deps) {
    deps = deps || {};
    if (!store) throw new TestSynthesisError('store required', 'bad_store');
    if (typeof deps.planner !== 'function') throw new TestSynthesisError('planner required', 'bad_planner');
    if (typeof deps.generator !== 'function') throw new TestSynthesisError('generator required', 'bad_generator');
    if (typeof deps.executor !== 'function') throw new TestSynthesisError('executor required', 'bad_executor');
    if (typeof deps.reviewer !== 'function') throw new TestSynthesisError('reviewer required', 'bad_reviewer');
    this.store = store;
    this.planner = deps.planner;
    this.generator = deps.generator;
    this.executor = deps.executor;
    this.reviewer = deps.reviewer;
    this.maxIterations = Number.isFinite(deps.maxIterations) ? deps.maxIterations : 3;
    this.minPassing = Number.isFinite(deps.minPassing) ? deps.minPassing : 1;
  }

  async synthesize(problem, candidateCode, options) {
    options = options || {};
    if (typeof problem !== 'string' || !problem) throw new TestSynthesisError('problem required', 'bad_problem');
    if (typeof candidateCode !== 'string' || !candidateCode) throw new TestSynthesisError('candidateCode required', 'bad_code');
    const maxIter = Number.isFinite(options.maxIterations) ? options.maxIterations : this.maxIterations;
    const runId = uid('tsr');
    const startedAt = nowIso();

    this.store.testSynthesisRunsInsert({
      id: runId,
      problem_hash: hash(problem),
      candidate_hash: hash(candidateCode),
      status: 'started',
      iterations: 0,
      started_at: startedAt,
    });

    let requirements;
    try {
      requirements = await this.planner(problem, candidateCode, { runId });
      if (!Array.isArray(requirements)) requirements = [];
    } catch (e) {
      return this._finish(runId, 'planner_failed', { error: String(e.message || e) });
    }

    let lastTests = null;
    let lastExecution = null;
    for (let iter = 0; iter < maxIter; iter++) {
      let generated;
      try {
        generated = await this.generator(requirements, candidateCode, {
          runId,
          iteration: iter,
          previousTests: lastTests,
          previousExecution: lastExecution,
        });
      } catch (e) {
        return this._finish(runId, 'generator_failed', { iterations: iter, error: String(e.message || e) });
      }

      const testCode = (generated && generated.testCode) || '';
      if (!testCode) {
        return this._finish(runId, 'empty_tests', { iterations: iter + 1 });
      }

      let execution;
      try {
        execution = await this.executor(candidateCode, testCode, { runId, iteration: iter });
      } catch (e) {
        return this._finish(runId, 'executor_failed', { iterations: iter + 1, error: String(e.message || e) });
      }

      lastTests = generated;
      lastExecution = execution;

      const passed = Number(execution && execution.passed) || 0;
      const failed = Number(execution && execution.failed) || 0;

      if (failed === 0 && passed >= this.minPassing) {
        return this._finish(runId, 'passed', {
          tests: generated,
          execution,
          iterations: iter + 1,
          ok: true,
        });
      }

      let review;
      try {
        review = await this.reviewer(execution, candidateCode, { runId, iteration: iter });
      } catch (e) {
        return this._finish(runId, 'reviewer_failed', { iterations: iter + 1, error: String(e.message || e) });
      }

      if (review && review.accept === true) {
        return this._finish(runId, 'accepted_with_failures', {
          tests: generated,
          execution,
          iterations: iter + 1,
          ok: true,
          accepted_with_failures: true,
        });
      }
    }

    return this._finish(runId, 'max_iterations', {
      tests: lastTests,
      execution: lastExecution,
      iterations: maxIter,
      ok: false,
    });
  }

  _finish(runId, status, extra) {
    extra = extra || {};
    const passed = Number(extra.execution && extra.execution.passed) || 0;
    const failed = Number(extra.execution && extra.execution.failed) || 0;
    const row = this.store.testSynthesisRunsUpdate(runId, {
      status,
      iterations: extra.iterations || 0,
      passed,
      failed,
      test_code: extra.tests && extra.tests.testCode ? extra.tests.testCode : null,
      run_json: JSON.stringify({
        error: extra.error || null,
        ok: extra.ok === true,
        accepted_with_failures: extra.accepted_with_failures === true,
      }),
      ended_at: nowIso(),
    });
    return {
      ok: extra.ok === true,
      status,
      iterations: extra.iterations || 0,
      tests: extra.tests || null,
      execution: extra.execution || null,
      runId,
      row,
    };
  }

  history(filter) { return this.store.testSynthesisRunsList(filter || {}); }
}

module.exports = { TestSynthesisPipeline, TestSynthesisError };
