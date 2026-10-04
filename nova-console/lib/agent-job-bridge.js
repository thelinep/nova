'use strict';

class AgentJobBridgeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AgentJobBridgeError';
    this.code = code || 'agent_job_bridge_error';
  }
}

const JOB_KIND = 'agent.task';

/**
 * AgentJobBridge connects AgentTasks (M3) to JobEngine (P1).
 *
 * Flow:
 *   startTask(taskId, actorId)
 *     → tasks.start(taskId, actorId)
 *     → jobEngine.enqueue('agent.task', { taskId })
 *     → store.job_id on the task
 *
 *   When the job engine runs the job:
 *     → executor({ task, agent, instructions, memory, tools, progress,
 *                  isCancelled, jobId })
 *     → on return:  tasks.complete(taskId, result, assigneeId)
 *     → on throw:   tasks.fail(taskId, error, assigneeId)
 *     → on cancel:  tasks.cancel(taskId, assigneeId, 'cancelled')
 *
 *   reconcile() on startup:
 *     For each task in state 'running' whose job is not running
 *     (typically orphaned after a restart), mark the task failed with
 *     error 'job_orphaned'.
 *
 * Optional integrations: memory, tools, budgets. If provided, the
 * executor's context is enriched with a memory summary, effective
 * tools, and a pre-run budget check. If budgets are provided and the
 * executor returns { usage: { tokens, usd } }, the amounts are charged
 * to the assignee's budget chain on success.
 */
class AgentJobBridge {
  constructor(store, deps) {
    deps = deps || {};
    if (!store) throw new AgentJobBridgeError('store required', 'bad_store');
    if (!deps.registry) throw new AgentJobBridgeError('registry required', 'bad_registry');
    if (!deps.tasks) throw new AgentJobBridgeError('tasks required', 'bad_tasks');
    if (!deps.jobEngine) throw new AgentJobBridgeError('jobEngine required', 'bad_job_engine');
    if (typeof deps.executor !== 'function') {
      throw new AgentJobBridgeError('executor function required', 'bad_executor');
    }
    this.store = store;
    this.registry = deps.registry;
    this.tasks = deps.tasks;
    this.jobEngine = deps.jobEngine;
    this.jobKind = deps.jobKind || JOB_KIND;
    this.timeoutMs = Number.isFinite(deps.timeoutMs) ? Math.min(15 * 60 * 1000, Math.max(1000, deps.timeoutMs)) : 15 * 60 * 1000;
    this.allowDeferredBatch = deps.allowDeferredBatch === true;
    // Generic bridges own usage charging by default. Specialized runtimes may
    // opt out when they must settle bounded usage on executor failure/cancel.
    this.chargeBudgets = deps.chargeBudgets !== false;
    this.memory = deps.memory || null;
    this.tools = deps.tools || null;
    this.budgets = deps.budgets || null;
    this.executor = deps.executor;
    if (deps.resultHandler != null && typeof deps.resultHandler !== 'function') {
      throw new AgentJobBridgeError('resultHandler must be a function', 'bad_result_handler');
    }
    this.resultHandler = deps.resultHandler || null;
    if (this.resultHandler && typeof this.tasks.awaitResultReview !== 'function') {
      throw new AgentJobBridgeError('result review lifecycle is unavailable', 'review_lifecycle_unavailable');
    }
    if (deps.isHalted != null && typeof deps.isHalted !== 'function') {
      throw new AgentJobBridgeError('isHalted must be a function', 'bad_halt_check');
    }
    this.isHalted = deps.isHalted || null;
    this.audit = typeof deps.audit === 'function' ? deps.audit : null;
    this.registered = false;
  }

  register() {
    if (this.registered) return;
    this.jobEngine.register(this.jobKind, (payload, ctx) => this._handle(payload, ctx));
    this.registered = true;
  }

  async startTask(taskId, actorId) {
    if (!taskId) throw new AgentJobBridgeError('taskId required', 'bad_task_id');
    const task = this.tasks.get(taskId);
    if (!task) throw new AgentJobBridgeError('task not found', 'not_found');
    if (task.state !== 'assigned') {
      throw new AgentJobBridgeError('task is not assigned', 'not_assigned');
    }
    if (!task.assignee_id) {
      throw new AgentJobBridgeError('task has no assignee', 'no_assignee');
    }

    this._assertDispatchAllowed();
    this.tasks.start(taskId, actorId || task.assignee_id);

    const job = this.jobEngine.enqueue(this.jobKind, { taskId }, {
      maxAttempts: 1,
      timeoutMs: this.timeoutMs,
    });

    this.tasks._require; // noop guard so linting does not flag unused
    const updated = this.store.agentTasksUpdate(taskId, { job_id: job.id });

    this._audit('task_started', { task_id: taskId, job_id: job.id });
    return { task: updated, job };
  }

  /**
   * Called on process startup, after jobEngine.recover() has been run.
   * Marks any task in state 'running' whose job is not running as failed.
   */
  reconcile() {
    const runningTasks = this.store.agentTasksList({ state: 'running' });
    let reconciled = 0;
    for (const task of runningTasks) {
      if (!task.job_id) {
        this.tasks.fail(task.id, 'job_orphaned', task.assignee_id);
        reconciled++;
        continue;
      }
      

      const job = this.store.jobsGet(task.job_id);
      const liveJob = job && (job.state === 'running' || job.state === 'queued');
      if (!liveJob) {
        this.tasks.fail(task.id, 'job_orphaned', task.assignee_id);
        reconciled++;
      }
    }
    if (reconciled > 0) {
      this._audit('reconciled', { count: reconciled });
    }
    return { reconciled };
  }

  // ---- internals ----

  async _handle(payload, ctx) {
    const taskId = payload && payload.taskId;
    if (!taskId) throw new AgentJobBridgeError('job payload missing taskId', 'bad_payload');

    const task = this.tasks.get(taskId);
    if (!task) throw new AgentJobBridgeError('task not found', 'not_found');
    if (task.state !== 'running') {
      throw new AgentJobBridgeError('task not running', 'not_running');
    }

    const agent = this.registry.get(task.assignee_id);
    if (!agent) throw new AgentJobBridgeError('assignee not found', 'assignee_not_found');

    // Budget pre-check
    if (this.budgets) {
      const check = this.budgets.check(agent.id);
      if (!check.ok) {
        this.tasks.fail(taskId, 'budget_exceeded', agent.id);
        throw new AgentJobBridgeError('budget exceeded', 'budget_exceeded');
      }
    }

    const cancellation = makeSignal(ctx, () => this.isHalted ? this.isHalted() : false);
    const executorCtx = {
      task: {
        id: task.id,
        title: task.title,
        description: task.description,
        payload: safeParse(task.payload_json),
      },
      agent: {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        instructions: this.registry.instructions(agent.id),
        model_preference: this.registry.modelPreference(agent.id),
      },
      memory: this.memory ? this.memory.summarise(agent.id) : null,
      tools: this.tools ? this.tools.effectiveTools(agent.id) : null,
      jobId: ctx.jobId,
      attempts: ctx.attempts,
      progress: (p) => ctx.progress(p),
      isCancelled: () => ctx.cancelled === true,
      signal: cancellation.signal,
    };

    let result;
    let reviewProposal = null;
    try {
      // Check again after dequeue, immediately before dispatch. A runtime may
      // be halted after startTask enqueues the job.
      this._assertDispatchAllowed();
      result = await this.executor(executorCtx);
      this._assertNotCancelled(ctx);
      this._assertDispatchAllowed();
      if (this.resultHandler) {
        const proposal = await this.resultHandler(result, {
          task: executorCtx.task,
          agent: executorCtx.agent,
          jobId: ctx.jobId,
        });
        reviewProposal = validateReviewProposal(proposal, result, { allowDeferredBatch: this.allowDeferredBatch });
        this._assertNotCancelled(ctx);
        this._assertDispatchAllowed();
      }
    } catch (e) {
      cancellation.cleanup();
      if (ctx.cancelled && ctx.cancelReason !== 'timeout') {
        this.tasks.cancel(taskId, agent.id, 'cancelled via job engine');
        this._audit('task_cancelled', { task_id: taskId, job_id: ctx.jobId });
      } else {
        const msg = String((e && e.message) || e);
        this.tasks.fail(taskId, msg, agent.id);
        this._audit('task_failed', { task_id: taskId, job_id: ctx.jobId, error: msg });
      }
      throw e;
    }
    cancellation.cleanup();

    // Charge budgets on success
    if (this.chargeBudgets && this.budgets && result && result.usage && typeof result.usage === 'object') {
      try {
        if (Number.isFinite(result.usage.tokens)) {
          this.budgets.charge(agent.id, 'tokens', result.usage.tokens, task.id);
        }
        if (Number.isFinite(result.usage.usd)) {
          this.budgets.charge(agent.id, 'usd', result.usage.usd, task.id);
        }
        this.budgets.charge(agent.id, 'jobs', 1, task.id);
      } catch { /* budget over-charge does not abort the task */ }
    }

    if (this.resultHandler) {
      // Completion is deliberately replaced with a pending human-review
      // state. The proposal carries the validated workspace batch reference;
      // the original executor response and usage remain attached for review
      // and budget/audit traceability.
      try {
        this.tasks.awaitResultReview(taskId, reviewProposal, agent.id);
      } catch (e) {
        // If the review transition itself failed before changing state, close
        // the running task as failed. Never fall through to generic complete.
        try {
          if (this.tasks.get(taskId)?.state === 'running') {
            this.tasks.fail(taskId, 'result_review_transition_failed: ' + String(e.message || e), agent.id);
          }
        } catch { /* preserve the original transition failure */ }
        this._audit('task_result_review_failed', {
          task_id: taskId,
          job_id: ctx.jobId,
          batch_id: reviewProposal.batchId,
          error: String(e.message || e),
        });
        throw new AgentJobBridgeError('Could not submit the coding result for human review.', 'review_transition_failed');
      }
      this._audit('task_result_review_requested', {
        task_id: taskId,
        job_id: ctx.jobId,
        batch_id: reviewProposal.batchId,
      });
      return reviewProposal;
    }

    this.tasks.complete(taskId, result, agent.id);
    this._audit('task_completed', { task_id: taskId, job_id: ctx.jobId });
    return result;
  }

  _assertDispatchAllowed() {
    if (!this.isHalted) return;
    let halted;
    try { halted = this.isHalted(); }
    catch (cause) {
      throw new AgentJobBridgeError('global halt state could not be verified; dispatch blocked', 'halt_check_unavailable');
    }
    if (typeof halted !== 'boolean') {
      throw new AgentJobBridgeError('global halt check returned an invalid state; dispatch blocked', 'bad_halt_state');
    }
    if (halted) throw new AgentJobBridgeError('runtime is halted; agent dispatch blocked', 'runtime_halted');
  }

  _assertNotCancelled(ctx) {
    if (ctx.cancelled) {
      const timeout = ctx.cancelReason === 'timeout';
      throw Object.assign(new Error(timeout ? 'Agent job timed out.' : 'Agent job cancelled.'), {
        name: timeout ? 'TimeoutError' : 'CancelledError', code: timeout ? 'timeout' : 'cancelled',
      });
    }
  }

  _audit(action, data) {
    if (!this.audit) return;
    try { this.audit({ action: 'agent_job.' + action, ...data }); }
    catch { /* best-effort */ }
  }
}

function safeParse(s) {
  try { return JSON.parse(s || 'null'); } catch { return null; }
}

function validateReviewProposal(proposal, executorResult, options = {}) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new AgentJobBridgeError('result handler must return a structured proposal object', 'bad_review_proposal');
  }
  const deferred = options.allowDeferredBatch === true && proposal.batchId === null;
  if (!deferred && (typeof proposal.batchId !== 'string' || !proposal.batchId.trim())) {
    throw new AgentJobBridgeError('result handler proposal must include a batchId', 'bad_review_proposal');
  }
  let serialized;
  try {
    serialized = JSON.stringify({
      ...proposal,
      batchId: deferred ? null : proposal.batchId.trim(),
      executorResult,
      usage: executorResult && typeof executorResult === 'object' ? executorResult.usage : undefined,
    });
  } catch {
    throw new AgentJobBridgeError('result handler proposal and executor result must be serializable', 'bad_review_proposal');
  }
  if (typeof serialized !== 'string') {
    throw new AgentJobBridgeError('result handler proposal and executor result must be serializable', 'bad_review_proposal');
  }
  try { return JSON.parse(serialized); }
  catch { throw new AgentJobBridgeError('result handler proposal could not be normalized', 'bad_review_proposal'); }
}

function makeSignal(ctx, isHalted) {
  const controller = new AbortController();
  const timer = setInterval(() => {
    if (controller.signal.aborted) return;
    const cancelled = ctx.cancelled;
    let halted = false;
    try { halted = isHalted(); } catch { halted = true; }
    if (!cancelled && !halted) return;
    const timeout = cancelled && ctx.cancelReason === 'timeout';
    const code = halted ? 'runtime_halted' : timeout ? 'timeout' : 'cancelled';
    const message = halted ? 'Maataa runtime halted during agent execution.' : timeout ? 'Agent job timed out.' : 'Agent job cancelled.';
    controller.abort(Object.assign(new Error(message), { name: timeout ? 'TimeoutError' : 'AbortError', code }));
  }, 20);
  if (timer.unref) timer.unref();
  return { signal: controller.signal, cleanup: () => clearInterval(timer) };
}

module.exports = { AgentJobBridge, AgentJobBridgeError, JOB_KIND };
