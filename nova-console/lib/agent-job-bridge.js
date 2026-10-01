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
    this.memory = deps.memory || null;
    this.tools = deps.tools || null;
    this.budgets = deps.budgets || null;
    this.executor = deps.executor;
    this.audit = typeof deps.audit === 'function' ? deps.audit : null;
    this.registered = false;
  }

  register() {
    if (this.registered) return;
    this.jobEngine.register(JOB_KIND, (payload, ctx) => this._handle(payload, ctx));
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

    this.tasks.start(taskId, actorId || task.assignee_id);

    const job = this.jobEngine.enqueue(JOB_KIND, { taskId }, {
      maxAttempts: 1,
      timeoutMs: 15 * 60 * 1000,
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
    };

    let result;
    try {
      result = await this.executor(executorCtx);
    } catch (e) {
      if (ctx.cancelled) {
        this.tasks.cancel(taskId, agent.id, 'cancelled via job engine');
        this._audit('task_cancelled', { task_id: taskId, job_id: ctx.jobId });
      } else {
        const msg = String((e && e.message) || e);
        this.tasks.fail(taskId, msg, agent.id);
        this._audit('task_failed', { task_id: taskId, job_id: ctx.jobId, error: msg });
      }
      throw e;
    }

    // Charge budgets on success
    if (this.budgets && result && result.usage && typeof result.usage === 'object') {
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

    this.tasks.complete(taskId, result, agent.id);
    this._audit('task_completed', { task_id: taskId, job_id: ctx.jobId });
    return result;
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

module.exports = { AgentJobBridge, AgentJobBridgeError, JOB_KIND };
