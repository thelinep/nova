'use strict';

const crypto = require('node:crypto');
const { JobEngine } = require('./jobs');
const { AgentJobBridge } = require('./agent-job-bridge');
const codingResult = require('./coding-agent-result');

const JOB_KIND = 'agent.coding_task';
const PLANNER_NAME = 'Maataa Coding Studio Planner';
const WORKER_NAME = 'Maataa Coding Studio Worker';
const OPERATOR = 'local-operator';
const LIMITS = Object.freeze({ requestBytes: 4000, feedbackBytes: 1500, timeoutMs: 120000, maxOutputTokens: 1024, maxContextTokens: 8192, maxTotalTokens: 16384, dailyTokens: 65536, changes: 50 });
const ACTIVE = new Set(['assigned', 'running', 'awaiting_result_review', 'revision_requested']);

function problem(message, statusCode = 400, code = 'coding_studio_error') {
  return Object.assign(new Error(message), { statusCode, code });
}
function parseJson(value) { try { return JSON.parse(value || 'null'); } catch { return null; } }

class CodingAgentRuntime {
  constructor(deps) {
    deps = deps || {};
    for (const name of ['store', 'registry', 'tasks', 'scanner', 'changes', 'planner', 'ollama', 'policy']) {
      if (!deps[name]) throw problem(`${name} dependency required`, 500, 'bad_runtime');
    }
    this.store = deps.store; this.registry = deps.registry; this.tasks = deps.tasks;
    this.scanner = deps.scanner; this.changes = deps.changes; this.planner = deps.planner; this.ollama = deps.ollama; this.policy = deps.policy;
    this.audit = typeof deps.audit === 'function' ? deps.audit : () => {};
    this.budgets = deps.budgets || null;
    if (!this.budgets) throw problem('Coding Studio requires its bounded daily budget ledger.', 503, 'budget_unavailable');
    this.engine = deps.jobEngine || new JobEngine(this.store, { allowedKinds: [JOB_KIND], concurrency: 1, pollMs: 100, defaultTimeoutMs: LIMITS.timeoutMs });
    this.dispatching = false;
    this.started = false;
    this.bridge = new AgentJobBridge(this.store, {
      registry: this.registry, tasks: this.tasks, jobEngine: this.engine,
      jobKind: JOB_KIND, allowDeferredBatch: true, timeoutMs: LIMITS.timeoutMs,
      isHalted: () => this.isHalted(), chargeBudgets: false,
      executor: ctx => this._execute(ctx),
      resultHandler: (result, ctx) => this._reviewProposal(result, ctx),
      audit: event => this._audit(event.action, event),
    });
    this.bridge.register();
  }

  seed() {
    const revokedNamed = this.registry.list({}).find(agent => (agent.name === PLANNER_NAME || agent.name === WORKER_NAME) && agent.revoked_at);
    let planner = this.registry.getByName(PLANNER_NAME);
    if (!planner && revokedNamed?.revoked_at) throw problem('A revoked internal Coding Studio agent exists; an operator must resolve it before dispatch.', 503, 'coding_agent_revoked');
    if (!planner) planner = this.registry.create({ name: PLANNER_NAME, role: 'planner', description: 'Internal Coding Studio task owner.', instructions: { policy: 'Create bounded reviewable code proposals only.' }, allowedTools: [], memoryScope: 'private', createdBy: 'system' });
    let worker = this.registry.getByName(WORKER_NAME);
    if (!worker && revokedNamed?.name === WORKER_NAME && revokedNamed.revoked_at) throw problem('The internal Coding Studio worker was revoked; dispatch is blocked.', 503, 'coding_agent_revoked');
    if (!worker) worker = this.registry.create({ name: WORKER_NAME, role: 'worker', description: 'Internal no-tools coding draft worker.', instructions: { policy: 'Return a validated change proposal only; do not claim to write files.' }, allowedTools: [], memoryScope: 'private', supervisorId: planner.id, createdBy: 'system' });
    // Always enforce the safety properties on pre-existing named rows too.
    planner = this.store.agentRegistryUpdate(planner.id, { allowed_tools_json: '[]', supervisor_id: null });
    worker = this.store.agentRegistryUpdate(worker.id, { allowed_tools_json: '[]', supervisor_id: planner.id });
    if (this.budgets) {
      const active = this.store.budgetsList({ subject_type: 'agent', subject_id: worker.id, active: true });
      if (!active.length) this.budgets.setForAgent(worker.id, { tokens: LIMITS.dailyTokens, jobs: 4, wallclock_ms: LIMITS.timeoutMs * 4 }, { createdBy: 'system' });
    }
    return { planner, worker };
  }

  start() {
    if (this.started) return;
    this.seed();
    this.engine.recover(); // this engine can see coding jobs only
    this._reconcileCodingTasks();
    this.engine.start();
    this.started = true;
  }
  stop() { this.engine.stop(); this.started = false; }
  isHalted() {
    if (typeof this.store.getGlobalHalt !== 'function') throw problem('Global halt state is unavailable; coding dispatch is blocked.', 503, 'halt_unavailable');
    return this.store.getGlobalHalt() === '1';
  }
  _assertDispatchAllowed() { if (this.isHalted()) throw problem('Maataa runtime is halted; coding dispatch is blocked.', 409, 'runtime_halted'); }

  async createTask(input) {
    input = input || {};
    if (this.dispatching) throw problem('A Coding Studio task is already being prepared.', 409, 'task_busy');
    if (this.isHalted()) throw problem('Maataa runtime is halted; coding dispatch is blocked.', 409, 'runtime_halted');
    const { rootId, modelId, request } = input;
    if (typeof rootId !== 'string' || !rootId.trim()) throw problem('Approved rootId is required.', 400, 'bad_root');
    if (typeof modelId !== 'string' || !modelId.trim()) throw problem('Choose an exact installed Ollama model.', 400, 'bad_model');
    if (typeof request !== 'string' || !request.trim() || Buffer.byteLength(request) > LIMITS.requestBytes) throw problem(`Request must be non-empty and at most ${LIMITS.requestBytes} bytes.`, 400, 'bad_request');
    if (input.brahmiComments != null && typeof input.brahmiComments !== 'boolean') throw problem('brahmiComments must be a boolean.', 400, 'bad_brahmi_comments');
    const normalized = { rootId: rootId.trim(), modelId: modelId.trim(), request: request.trim(), brahmiComments: input.brahmiComments === true };
    this._assertNoActiveTask();
    this.dispatching = true;
    try {
      this.scanner.approvedRoot(this.store, normalized.rootId);
      const { planner, worker } = this.seed();
      this._agent(planner.id); this._agent(worker.id);
      this._assertPolicy(worker.id, normalized.rootId);
      const preview = await this.planner.preview(this.store, this.scanner, this.ollama, normalized, { timeoutMs: LIMITS.timeoutMs });
      if (this.isHalted()) throw problem('Maataa runtime was halted while the task was being checked.', 409, 'runtime_halted');
      if (!preview || preview.ready !== true || !preview.selectedModel?.digest || preview.selectedModel.id !== normalized.modelId) {
        throw problem(preview?.blocker || preview?.clarification || 'Selected model is not ready for this coding workflow.', 412, 'coding_not_ready');
      }
      this._assertBudget(preview.selectedModel.digest);
      this.budgets.charge(worker.id, 'jobs', 1, 'coding-dispatch:' + crypto.randomUUID());
      let task; let started;
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        task = this.tasks.create({ creatorId: planner.id, assigneeId: worker.id, title: 'Coding Studio proposal', description: 'Bounded model-generated proposal pending human review.', payload: { codingStudio: true, rootId: normalized.rootId, modelId: normalized.modelId, modelDigest: preview.selectedModel.digest, request: normalized.request, brahmiComments: normalized.brahmiComments, feedback: '' } });
        started = await this.bridge.startTask(task.id, planner.id);
        this.store.db.exec('COMMIT');
      } catch (error) { try { this.store.db.exec('ROLLBACK'); } catch {} throw error; }
      this._audit('coding_task_created', { taskId: task.id, owner: OPERATOR, plannerId: planner.id, workerId: worker.id, rootId: normalized.rootId, modelId: normalized.modelId, modelDigest: preview.selectedModel.digest });
      return { task: this.serializeTask(started.task) };
    } finally { this.dispatching = false; }
  }

  async reviewTask(id, input) {
    const task = this._codingTask(id);
    input = input || {};
    const decision = input.decision;
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (Object.keys(input).some(key => !['decision', 'reason'].includes(key))) throw problem('Review accepts only decision and reason.', 400, 'bad_review_body');
    if (!['accept', 'reject', 'revise'].includes(decision)) throw problem('decision must be accept, reject, or revise.', 400, 'bad_decision');
    if (!reason || Buffer.byteLength(reason) > 1500) throw problem('A review reason of 1–1500 bytes is required.', 400, 'bad_reason');
    if (task.state !== 'awaiting_result_review') throw problem('Task is not awaiting human review.', 409, 'not_awaiting_result_review');
    const current = parseJson(task.result_json) || {};
    const payload = parseJson(task.payload_json) || {};
    let updated;
    let batchId = null;
    if (decision === 'accept') {
      const validated = codingResult.parseCodingAgentResult(current.draft);
      const draftHash = crypto.createHash('sha256').update(JSON.stringify(validated)).digest('hex');
      if (current.taskId !== task.id || current.rootId !== payload.rootId || current.modelDigest !== payload.modelDigest || current.draftSha256 !== draftHash) throw problem('The reviewed change set no longer matches its task, approved root, and qualified model evidence.', 409, 'proposal_binding_mismatch');
      this.scanner.approvedRoot(this.store, payload.rootId);
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        const batch = this.changes.createBatch(this.store, this.scanner, codingResult.toWorkspaceBatchInput(validated, payload.rootId));
        batchId = batch.id;
        this.store.put('workspaceChangeBatches', { ...batch, codingStudioTaskId: task.id, sourceDraftSha256: draftHash, modelDigest: payload.modelDigest });
        const linked = { ...current, batchId };
        updated = this.tasks.acceptResult(task.id, OPERATOR, reason, linked);
        this.store.db.exec('COMMIT');
      } catch (error) { try { this.store.db.exec('ROLLBACK'); } catch {} throw error; }
    } else if (decision === 'reject') updated = this.tasks.rejectResult(task.id, OPERATOR, reason);
    else updated = this.tasks.requestRevision(task.id, OPERATOR, reason);
    this._audit('coding_task_reviewed', { taskId: task.id, owner: OPERATOR, decision, modelDigest: payload.modelDigest, batchId });
    return { task: this.serializeTask(updated) };
  }

  async retryTask(id, input) {
    const task = this._codingTask(id);
    input = input || {};
    if (!['revision_requested', 'failed'].includes(task.state)) throw problem('Request a revision or retry a failed Coding Studio task.', 409, 'not_revision_requested');
    if (Object.keys(input).some(key => key !== 'feedback')) throw problem('Retry accepts only feedback.', 400, 'bad_retry_body');
    const feedback = typeof input.feedback === 'string' ? input.feedback.trim() : '';
    if (!feedback || Buffer.byteLength(feedback) > LIMITS.feedbackBytes) throw problem(`New feedback must be non-empty and at most ${LIMITS.feedbackBytes} bytes.`, 400, 'bad_feedback');
    if (this.isHalted()) throw problem('Maataa runtime is halted; retry is blocked.', 409, 'runtime_halted');
    const payload = parseJson(task.payload_json) || {};
    this.scanner.approvedRoot(this.store, payload.rootId);
    this._assertPolicy(task.assignee_id, payload.rootId);
    const preview = await this.planner.preview(this.store, this.scanner, this.ollama, { rootId: payload.rootId, modelId: payload.modelId, request: payload.request }, { timeoutMs: LIMITS.timeoutMs });
    if (this.isHalted()) throw problem('Maataa runtime was halted while retry was being checked.', 409, 'runtime_halted');
    if (!preview?.ready || preview.selectedModel?.id !== payload.modelId || preview.selectedModel?.digest !== payload.modelDigest) throw problem('The exact model digest is no longer qualified and installed. Recreate the task only after qualification is restored.', 412, 'model_digest_changed');
    this._assertBudget(payload.modelDigest);
    this._assertNoOtherActiveTask(task.id);
    const worker = this.registry.getByName(WORKER_NAME); this._agent(worker?.id);
    this.budgets.charge(worker.id, 'jobs', 1, 'coding-retry:' + crypto.randomUUID());
    let retried; let started;
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      retried = this.tasks.retry(task.id, { ...payload, feedback }, OPERATOR);
      started = await this.bridge.startTask(retried.id, task.creator_id);
      this.store.db.exec('COMMIT');
    } catch (error) { try { this.store.db.exec('ROLLBACK'); } catch {} throw error; }
    this._audit('coding_task_retried', { taskId: task.id, owner: OPERATOR, modelDigest: payload.modelDigest });
    return { task: this.serializeTask(started.task) };
  }

  cancelTask(id) {
    const task = this._codingTask(id);
    if (!['assigned', 'running'].includes(task.state)) throw problem('Only an assigned or running Coding Studio task can be cancelled.', 409, 'not_cancellable');
    if (task.job_id) {
      const job = this.store.jobsGet(task.job_id);
      if (job?.state === 'queued') {
        let updated;
        this.store.db.exec('BEGIN IMMEDIATE');
        try {
          const currentJob = this.store.jobsGet(task.job_id);
          const currentTask = this.tasks.get(task.id);
          if (currentJob?.state !== 'queued' || !['assigned', 'running'].includes(currentTask?.state)) throw problem('Task dispatch changed while cancellation was being applied; reload its status.', 409, 'cancel_race');
          this.engine.cancel(task.job_id);
          updated = this.tasks.cancel(task.id, OPERATOR, 'operator_cancelled');
          this.store.db.exec('COMMIT');
        } catch (error) { try { this.store.db.exec('ROLLBACK'); } catch {} throw error; }
        this._audit('coding_task_cancelled', { taskId: task.id, owner: OPERATOR });
        return { task: this.serializeTask(updated) };
      }
      this.engine.cancel(task.job_id);
      if (job?.state === 'running') {
        this._audit('coding_task_cancel_requested', { taskId: task.id, owner: OPERATOR });
        return { task: this.serializeTask(this.tasks.get(task.id)) };
      }
    }
    const updated = this.tasks.cancel(task.id, OPERATOR, 'operator_cancelled');
    this._audit('coding_task_cancelled', { taskId: task.id, owner: OPERATOR });
    return { task: this.serializeTask(updated) };
  }

  team() {
    const agents = [this.registry.getByName(PLANNER_NAME), this.registry.getByName(WORKER_NAME)].filter(Boolean).map(agent => ({ id: agent.id, name: agent.name, role: agent.role, description: agent.description, enabled: agent.enabled === 1, allowed_tools: [], supervisor_id: agent.supervisor_id || null }));
    const tasks = this.store.agentTasksList({}).filter(task => this._isCoding(task)).slice(0, 100).map(task => this.serializeTask(task));
    const halted = this.isHalted();
    return { generated_at: new Date().toISOString(), agents, tasks, controls: { runtime_halted: halted, execution_available: !halted && this.started, execution_reason: halted ? 'runtime_halted' : this.started ? null : 'coding_runner_not_started', human_result_review_available: true, review_policy: 'Accept creates a draft workspace batch only; approval and application remain separate workspace actions.' } };
  }

  detail(id) {
    const task = this._codingTask(id);
    const events = this.tasks.events(id).map(event => ({ id: event.id, kind: event.kind, actor_id: event.actor_id, reason: event.reason, payload: safeEventPayload(parseJson(event.payload_json)), timestamp: event.timestamp }));
    const halted = this.isHalted();
    return { task: this.serializeTask(task, true), events, controls: { runtime_halted: halted, execution_available: false, human_result_review_available: task.state === 'awaiting_result_review', retry_available: task.state === 'revision_requested' && !halted, cancel_available: ['assigned', 'running'].includes(task.state) } };
  }

  serializeTask(task, detail = false) {
    const payload = parseJson(task.payload_json) || {};
    const result = parseJson(task.result_json);
    const proposal = result?.proposal || null;
    const batchId = result?.batchId || null;
    const summary = { id: task.id, title: task.title, description: task.description, state: task.state, creator_id: task.creator_id, assignee_id: task.assignee_id, created_at: task.created_at, updated_at: task.updated_at, started_at: task.started_at, ended_at: task.ended_at, error: task.error ? 'Coding task failed. Retry with specific feedback or check local runtime diagnostics.' : null, codingStudio: this._isCoding(task), rootId: payload.rootId || null, modelId: payload.modelId || null, batchId };
    if (!detail) return summary;
    summary.result = result ? { proposal: proposal ? this._publicProposal(proposal) : null, acceptanceChecks: result.acceptanceChecks || [], batchId } : null;
    summary.batchPreview = batchId ? this._batchPreview(batchId) : null;
    return summary;
  }

  _publicProposal(proposal) {
    const validated = codingResult.parseCodingAgentResult({ schema: codingResult.SCHEMA, version: codingResult.VERSION, summary: proposal.summary, changes: proposal.changes });
    return { summary: validated.summary, changes: validated.changes, acceptanceChecks: proposal.acceptanceChecks || [] };
  }
  _batchPreview(batchId) {
    const batch = this.store.get('workspaceChangeBatches', batchId);
    if (!batch) return null;
    return { id: batch.id, status: batch.status, summary: batch.summary, changes: (batch.changes || []).map(change => ({ relativePath: change.relativePath, operation: change.operation, toPath: change.toPath || null, impact: change.impact || '', diff: change.diff || '' })) };
  }
  _codingTask(id) { const task = this.tasks.get(id); if (!task || !this._isCoding(task)) throw problem('Coding Studio task not found.', 404, 'not_found'); return task; }
  _isCoding(task) { return parseJson(task?.payload_json)?.codingStudio === true; }
  isCodingTask(task) { return this._isCoding(task); }
  _assertNoActiveTask(excludeId) { const active = this.store.agentTasksList({}).find(task => task.id !== excludeId && this._isCoding(task) && ACTIVE.has(task.state)); if (active) throw problem('Only one active Coding Studio task is allowed at a time.', 409, 'coding_task_active'); }
  _assertNoOtherActiveTask(excludeId) { this._assertNoActiveTask(excludeId); }
  _agent(id) { const agent = this.registry.get(id); const tools = parseJson(agent?.allowed_tools_json); if (!agent || agent.revoked_at || agent.enabled !== 1 || !Array.isArray(tools) || tools.length) throw problem('Internal Coding Studio agents are unavailable or not safely configured.', 503, 'coding_agent_unavailable'); return agent; }
  _assertBudget(digest) {
    const worker = this.registry.getByName(WORKER_NAME);
    if (!worker) throw problem('Coding worker budget is unavailable.', 503, 'budget_unavailable');
    this._agent(worker.id);
    const check = this.budgets.check(worker.id);
    if (!check.ok) throw problem('Coding worker daily budget is exhausted.', 429, 'budget_exceeded');
    const remaining = this.budgets.effectiveLimit(worker.id, 'tokens').remaining;
    if (!Number.isFinite(remaining) || remaining < LIMITS.maxTotalTokens) throw problem('Insufficient configured token budget remains for one bounded Coding Studio task.', 429, 'budget_exceeded');
    this._audit('coding_budget_checked', { workerId: worker.id, modelDigest: digest, taskLimit: LIMITS.maxTotalTokens });
  }
  _assertPolicy(agentId, rootId) {
    const subject = { type: 'agent', id: agentId };
    const resource = { type: 'workspace', id: rootId };
    const matching = this.policy.list({ subject_type: subject.type, subject_id: subject.id, resource_type: resource.type, resource_id: resource.id });
    if (!matching.length) this.policy.grant({ subject, resource, effect: 'allow', scope: 'read_only', conditions: { max_per_day: 8 }, createdBy: 'approved-workspace-root' });
    const result = this.policy.check(subject, resource, { action: 'codingStudio.propose', scope: 'read_only' });
    const grant = result.policyId ? this.store.policiesGet(result.policyId) : null;
    if (!result.allowed || grant?.scope !== 'read_only') throw problem(`Coding Studio read policy denied this task (${result.reason || 'scope_not_read_only'}).`, 403, 'policy_denied');
    this._audit('coding_policy_checked', { workerId: agentId, rootId, decision: result.decision, policyId: result.policyId });
    return result;
  }

  async _execute(ctx) {
    const payload = ctx.task.payload;
    const abortSignal = ctx.signal;
    this._assertDispatchAllowed();
    this.scanner.approvedRoot(this.store, payload.rootId);
    this._agent(ctx.agent.id);
    this._assertPolicy(ctx.agent.id, payload.rootId);
    const modelClient = {
      status: async () => {
        if (abortSignal.aborted) throw abortSignal.reason;
        const status = await this.ollama.status();
        const installed = status.models.find(model => model.name === payload.modelId);
        if (!installed || installed.digest !== payload.modelDigest) throw problem('Selected model digest changed; coding plan stopped.', 412, 'model_digest_changed');
        return status;
      },
      show: (...args) => this.ollama.show(...args, abortSignal),
      chatFull: async (...args) => {
        if (abortSignal.aborted) throw abortSignal.reason;
        this._assertDispatchAllowed();
        const freshStatus = await this.ollama.status();
        const exact = freshStatus.models.find(model => model.name === payload.modelId);
        if (!exact || exact.digest !== payload.modelDigest) throw problem('Selected model digest changed immediately before generation; coding plan stopped.', 412, 'model_digest_changed');
        const generation = args[2] || {};
        const requested = generation.options || {};
        const context = Number(requested.num_ctx) || LIMITS.maxContextTokens;
        if (context > LIMITS.maxContextTokens || context < 4096 || Number(requested.num_predict) > LIMITS.maxOutputTokens) throw problem('Planner call exceeded the fixed per-call generation limits.', 429, 'generation_limit_exceeded');
        if (this._usage.reserved + context > LIMITS.maxTotalTokens) throw problem('No fixed context-token budget remains for another planner call.', 429, 'token_budget_exceeded');
        this._usage.reserved += context;
        this._usage.incomplete = true;
        const callArgs = args.slice();
        const signals = [abortSignal, generation.signal].filter(Boolean);
        callArgs[2] = { ...generation, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] };
        const response = await this.ollama.chatFull(...callArgs);
        if (!Number.isSafeInteger(response.prompt_eval_count) || !Number.isSafeInteger(response.eval_count) || response.prompt_eval_count < 0 || response.eval_count < 0) { this._usage.tokens = this._usage.reserved; throw problem('Ollama did not return reliable token usage; the bounded context is charged and this task is stopped.', 502, 'usage_unavailable'); }
        this._usage.tokens += response.prompt_eval_count + response.eval_count;
        this._usage.incomplete = false;
        if (this._usage.tokens > LIMITS.maxTotalTokens) throw problem('Coding task exceeded its fixed total-token budget.', 429, 'token_budget_exceeded');
        return response;
      },
    };
    this._usage = { tokens: 0, reserved: 0, incomplete: false };
    try {
      const plan = await this.planner.plan(this.store, this.scanner, this.changes, modelClient,
        { rootId: payload.rootId, modelId: payload.modelId, request: payload.request, brahmiComments: payload.brahmiComments },
        { draftOnly: true, signal: abortSignal, timeoutMs: LIMITS.timeoutMs, maxOutputTokens: LIMITS.maxOutputTokens, maxContextTokens: LIMITS.maxContextTokens, maxTotalTokens: LIMITS.maxTotalTokens, requiredModelDigest: payload.modelDigest, feedback: payload.feedback });
      if (abortSignal.aborted) throw abortSignal.reason;
      return { draft: { schema: codingResult.SCHEMA, version: codingResult.VERSION, summary: plan.draft.summary, changes: plan.draft.changes }, acceptanceChecks: plan.acceptanceChecks, planner: plan.planner, usage: { tokens: this._usage.tokens }, modelDigest: payload.modelDigest };
    } finally {
      const charged = Math.min(LIMITS.maxTotalTokens, this._usage.incomplete ? this._usage.reserved : this._usage.tokens);
      if (charged > 0) this.budgets.charge(ctx.agent.id, 'tokens', charged, ctx.task.id);
      this._usage = { tokens: 0, reserved: 0, incomplete: false };
    }
  }
  async _reviewProposal(result, ctx) {
    const draft = codingResult.parseCodingAgentResult(result.draft);
    const draftSha256 = crypto.createHash('sha256').update(JSON.stringify(draft)).digest('hex');
    const proposal = { batchId: null, taskId: ctx.task.id, rootId: ctx.task.payload.rootId, draft, draftSha256, modelDigest: ctx.task.payload.modelDigest, proposal: { summary: draft.summary, changes: draft.changes, acceptanceChecks: result.acceptanceChecks || [] }, acceptanceChecks: result.acceptanceChecks || [], modelId: result.planner?.modelId || null };
    if (Buffer.byteLength(JSON.stringify(proposal)) > codingResult.LIMITS.outputBytes) throw problem('Validated proposal exceeds the persisted review-result size limit.', 413, 'result_size_limit');
    return proposal;
  }
  _reconcileCodingTasks() {
    for (const task of this.store.agentTasksList({})) {
      if (!this._isCoding(task) || !['assigned', 'running'].includes(task.state)) continue;
      const job = task.job_id ? this.store.jobsGet(task.job_id) : null;
      if (!job || job.kind !== JOB_KIND || !['queued', 'running'].includes(job.state)) {
        try { this.tasks.fail(task.id, task.state === 'assigned' ? 'coding_dispatch_interrupted_on_restart' : 'coding_job_interrupted_on_restart', task.assignee_id); } catch {}
      }
    }
  }
  _audit(action, detail) { try { this.audit({ action, ...detail }); } catch {} }
}

function sanitizeError(value) {
  return String(value).replace(/(?:\/Users\/|\/home\/|\/private\/|\/tmp\/|[A-Za-z]:\\)[^\s"'<>]+/g, '[local path]').slice(0, 500);
}
function safeEventPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const safe = {};
  for (const key of ['decision', 'result_sha256', 'accepted_result_sha256', 'payload_sha256', 'assigned_to']) {
    if (Object.hasOwn(payload, key)) safe[key] = payload[key];
  }
  return Object.keys(safe).length ? safe : null;
}

module.exports = { CodingAgentRuntime, JOB_KIND, LIMITS, PLANNER_NAME, WORKER_NAME, OPERATOR };
