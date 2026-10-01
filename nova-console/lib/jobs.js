'use strict';

const crypto = require('node:crypto');

const STATES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out'];

class JobError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'JobError';
    this.code = code || 'job_error';
  }
}

class CancelledError extends JobError {
  constructor(message) {
    super(message || 'Job cancelled.', 'cancelled');
    this.name = 'CancelledError';
  }
}

class TimeoutError extends JobError {
  constructor(message) {
    super(message || 'Job timed out.', 'timeout');
    this.name = 'TimeoutError';
  }
}

const nowIso = () => new Date().toISOString();
const uid = (prefix) => `${prefix}_${crypto.randomUUID()}`;

class JobEngine {
  constructor(store, options) {
    options = options || {};
    this.store = store;
    this.concurrency = Number.isFinite(options.concurrency) ? options.concurrency : 2;
    this.pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 500;
    this.heartbeatMs = Number.isFinite(options.heartbeatMs) ? options.heartbeatMs : 5000;
    this.reaperMs = Number.isFinite(options.reaperMs) ? options.reaperMs : 5000;
    this.defaultTimeoutMs = Number.isFinite(options.defaultTimeoutMs)
      ? options.defaultTimeoutMs
      : 300000;
    this.handlers = new Map();
    this.active = new Map();
    this.timers = { poll: null, heartbeat: null, reaper: null };
    this.started = false;
  }

  register(kind, handler) {
    if (typeof handler !== 'function') {
      throw new JobError('handler must be a function', 'bad_handler');
    }
    this.handlers.set(kind, handler);
  }

  enqueue(kind, payload, options) {
    options = options || {};
    const id = uid('job');
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? options.timeoutMs
      : this.defaultTimeoutMs;
    const row = {
      id,
      kind,
      state: 'queued',
      payload_json: JSON.stringify(payload === undefined ? {} : payload),
      result_json: null,
      created_at: nowIso(),
      started_at: null,
      heartbeat_at: null,
      timeout_at: null,
      run_at: options.runAt || nowIso(),
      timeout_ms: timeoutMs,
      attempts: 0,
      max_attempts: Number.isFinite(options.maxAttempts) ? options.maxAttempts : 1,
      parent_id: options.parentId || null,
      error: null,
      ended_at: null,
    };
    const inserted = this.store.jobsInsert(row);
    this._event(id, 'enqueued', null);
    return inserted;
  }

  cancel(jobId) {
    const job = this.store.jobsGet(jobId);
    if (!job) throw new JobError('job not found', 'not_found');
    if (job.state === 'queued') {
      const updated = this.store.jobsUpdate(jobId, {
        state: 'cancelled',
        ended_at: nowIso(),
      });
      this._event(jobId, 'cancelled', { reason: 'user' });
      return updated;
    }
    if (job.state === 'running') {
      const active = this.active.get(jobId);
      if (active) {
        active.cancelRequested = true;
        active.cancelReason = 'user';
      }
      this._event(jobId, 'cancel_requested', { reason: 'user' });
      return this.store.jobsGet(jobId);
    }
    return job;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.recover();
    this.timers.poll = setInterval(() => {
      this._poll().catch((e) => this._log('poll', e));
    }, this.pollMs);
    this.timers.heartbeat = setInterval(() => {
      this._heartbeat().catch((e) => this._log('heartbeat', e));
    }, this.heartbeatMs);
    this.timers.reaper = setInterval(() => {
      this._reap().catch((e) => this._log('reaper', e));
    }, this.reaperMs);
    for (const t of Object.values(this.timers)) {
      if (t && typeof t.unref === 'function') t.unref();
    }
  }

  stop() {
    this.started = false;
    for (const key of ['poll', 'heartbeat', 'reaper']) {
      if (this.timers[key]) clearInterval(this.timers[key]);
      this.timers[key] = null;
    }
  }

  recover() {
    const running = this.store.jobsListByState('running');
    for (const job of running) {
      this.store.jobsUpdate(job.id, {
        state: 'failed',
        error: 'restart_interrupted',
        ended_at: nowIso(),
      });
      this._event(job.id, 'recovered', { reason: 'restart_interrupted' });
    }
    return running.length;
  }

  stats() {
    return {
      queued: this.store.jobsListByState('queued').length,
      running: this.store.jobsListByState('running').length,
      active: this.active.size,
      handlers: this.handlers.size,
    };
  }

  async _poll() {
    const slots = this.concurrency - this.active.size;
    if (slots <= 0) return;
    const claimed = this.store.jobsClaimNext(slots);
    for (const job of claimed) {
      this._run(job).catch((e) => this._log('run', e));
    }
  }

  async _run(job) {
    const handler = this.handlers.get(job.kind);
    if (!handler) {
      this.store.jobsUpdate(job.id, {
        state: 'failed',
        error: 'no_handler',
        ended_at: nowIso(),
      });
      this._event(job.id, 'failed', { reason: 'no_handler' });
      return;
    }
    const active = { cancelRequested: false, cancelReason: null, ctx: null };
    const ctx = {
      jobId: job.id,
      attempts: job.attempts + 1,
      progress: (payload) => this._event(job.id, 'progress', payload === undefined ? null : payload),
    };
    Object.defineProperty(ctx, 'cancelled', {
      get() {
        return active.cancelRequested;
      },
    });
    active.ctx = ctx;
    this.active.set(job.id, active);

    const startedAt = nowIso();
    const timeoutAt = job.timeout_ms
      ? new Date(Date.now() + job.timeout_ms).toISOString()
      : null;
    this.store.jobsUpdate(job.id, {
      started_at: startedAt,
      heartbeat_at: startedAt,
      timeout_at: timeoutAt,
    });
    this._event(job.id, 'started', { attempt: ctx.attempts });

    let payload = {};
    try {
      payload = JSON.parse(job.payload_json || '{}');
    } catch {
      payload = {};
    }

    try {
      const result = await handler(payload, ctx);
      this.store.jobsUpdate(job.id, {
        state: 'completed',
        result_json: JSON.stringify(result === undefined ? null : result),
        ended_at: nowIso(),
      });
      this._event(job.id, 'completed', null);
    } catch (err) {
      const attempts = job.attempts + 1;
      const isTimeout =
        err instanceof TimeoutError ||
        err.name === 'TimeoutError' ||
        err.code === 'timeout' ||
        active.cancelReason === 'timeout';
      const isCancelled =
        !isTimeout &&
        (err instanceof CancelledError ||
          err.name === 'CancelledError' ||
          err.code === 'cancelled');

      if (isTimeout) {
        this.store.jobsUpdate(job.id, {
          state: 'timed_out',
          attempts,
          error: 'timeout',
          ended_at: nowIso(),
        });
        this._event(job.id, 'timed_out', null);
      } else if (isCancelled) {
        this.store.jobsUpdate(job.id, {
          state: 'cancelled',
          attempts,
          error: 'cancelled',
          ended_at: nowIso(),
        });
        this._event(job.id, 'cancelled', { reason: active.cancelReason || 'user' });
      } else if (attempts < job.max_attempts) {
        const delay = Math.min(60000, 1000 * Math.pow(2, attempts - 1));
        const runAt = new Date(Date.now() + delay).toISOString();
        this.store.jobsUpdate(job.id, {
          state: 'queued',
          attempts,
          run_at: runAt,
          error: String((err && err.message) || err),
          started_at: null,
          heartbeat_at: null,
          timeout_at: null,
        });
        this._event(job.id, 'retry_scheduled', { attempt: attempts, delay, runAt });
      } else {
        this.store.jobsUpdate(job.id, {
          state: 'failed',
          attempts,
          error: String((err && err.message) || err),
          ended_at: nowIso(),
        });
        this._event(job.id, 'failed', { attempt: attempts });
      }
    } finally {
      this.active.delete(job.id);
    }
  }

  async _heartbeat() {
    const t = nowIso();
    for (const jobId of this.active.keys()) {
      this.store.jobsUpdate(jobId, { heartbeat_at: t });
    }
  }

  async _reap() {
    const timedOut = this.store.jobsFindTimedOut();
    for (const job of timedOut) {
      const active = this.active.get(job.id);
      if (active && !active.cancelRequested) {
        active.cancelRequested = true;
        active.cancelReason = 'timeout';
      }
    }
  }

  _event(jobId, kind, payload) {
    this.store.jobsInsertEvent({
      id: uid('jevt'),
      job_id: jobId,
      kind,
      payload_json: payload === undefined || payload === null ? null : JSON.stringify(payload),
      timestamp: nowIso(),
    });
  }

  _log(where, err) {
    if (process.env.NOVA_JOBS_DEBUG) {
      console.error(`[jobs.${where}]`, (err && err.message) || err);
    }
  }
}

module.exports = { JobEngine, JobError, CancelledError, TimeoutError, STATES };
