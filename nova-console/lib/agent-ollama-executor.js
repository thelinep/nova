'use strict';

class AgentOllamaExecutorError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AgentOllamaExecutorError';
    this.code = code || 'agent_ollama_executor_error';
  }
}

/**
 * Build an executor function for AgentJobBridge from an Ollama client.
 *
 *   const executor = agentOllamaExecutor({
 *     chat: (params) => ollama.chatFull(params.model, params.messages, params.opts),
 *     defaultModel: 'llama3.2:latest',
 *     maxTokens: 2048,
 *   });
 *
 * The returned function accepts the executor context from AgentJobBridge
 * (task, agent, memory, tools, progress, isCancelled) and returns:
 *
 *   { output: <string>, usage: { tokens, usd? } }
 *
 * Design rules:
 *   - Model preference is read from ctx.agent.model_preference.model, with
 *     fallback to defaultModel.
 *   - Temperature preference is read from ctx.agent.model_preference.temperature,
 *     with fallback to defaultTemperature.
 *   - System prompt is composed in layers: agent instructions, memory summary,
 *     effective tools. Only sections that have content are emitted.
 *   - User prompt contains task title, description, and optional payload.
 *   - Cancellation is checked before the call. If isCancelled() is true, throw
 *     a CancelledError-shaped error so the bridge marks the task cancelled.
 *   - Response normalization accepts the four shapes from ollama-provider:
 *     string, {content}, {message:{content}}, {response}.
 */
function agentOllamaExecutor(options) {
  options = options || {};
  if (typeof options.chat !== 'function') {
    throw new AgentOllamaExecutorError('chat function required', 'bad_chat');
  }
  const chat = options.chat;
  const defaultModel = options.defaultModel || null;
  const defaultTemperature = options.defaultTemperature == null
    ? 0.4 : options.defaultTemperature;
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : 2048;
  const includeMemoryInSystem = options.includeMemoryInSystem !== false;
  const includeToolsInSystem = options.includeToolsInSystem !== false;
  const memoryPerKind = Number.isFinite(options.memoryPerKind) ? options.memoryPerKind : 3;
  const progressEveryMs = Number.isFinite(options.progressEveryMs)
    ? options.progressEveryMs : 0;

  return async function executor(ctx) {
    if (!ctx || typeof ctx !== 'object') {
      throw new AgentOllamaExecutorError('ctx required', 'bad_ctx');
    }
    const agent = ctx.agent || {};
    const task = ctx.task || {};

    if (typeof ctx.isCancelled === 'function' && ctx.isCancelled()) {
      const err = new Error('cancelled before dispatch');
      err.code = 'cancelled';
      throw err;
    }

    const model = resolveModel(agent, defaultModel);
    if (!model) {
      throw new AgentOllamaExecutorError('no model resolved', 'no_model');
    }
    const temperature = resolveTemperature(agent, defaultTemperature);

    const system = composeSystem({
      instructions: agent.instructions,
      memory: includeMemoryInSystem ? ctx.memory : null,
      tools: includeToolsInSystem ? ctx.tools : null,
      memoryPerKind,
    });
    const user = composeUser(task);

    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: user });

    if (typeof ctx.progress === 'function') {
      ctx.progress({ phase: 'requested', model, messages: messages.length });
    }

    const t0 = Date.now();
    let response;
    try {
      response = await chat({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
      });
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/cancel/i.test(msg)) {
        const err = new Error(msg);
        err.code = 'cancelled';
        throw err;
      }
      throw new AgentOllamaExecutorError('chat failed: ' + msg, 'chat_failed');
    }

    if (typeof ctx.isCancelled === 'function' && ctx.isCancelled()) {
      const err = new Error('cancelled after dispatch');
      err.code = 'cancelled';
      throw err;
    }

    const output = extractContent(response);
    const usage = extractUsage(response, output);
    const elapsed_ms = Date.now() - t0;

    if (typeof ctx.progress === 'function') {
      ctx.progress({ phase: 'completed', elapsed_ms, tokens: usage.tokens || null });
    }

    return {
      output,
      usage,
      meta: {
        model,
        temperature,
        elapsed_ms,
        job_id: ctx.jobId || null,
        agent_id: agent.id || null,
        task_id: task.id || null,
      },
    };
  };
}

function resolveModel(agent, fallback) {
  const pref = agent && agent.model_preference;
  if (pref && typeof pref.model === 'string' && pref.model.trim()) {
    return pref.model.trim();
  }
  return fallback;
}

function resolveTemperature(agent, fallback) {
  const pref = agent && agent.model_preference;
  if (pref && Number.isFinite(pref.temperature)) {
    return pref.temperature;
  }
  return fallback;
}

function composeSystem(input) {
  const parts = [];
  const instructions = input.instructions;

  if (instructions && typeof instructions === 'object') {
    if (typeof instructions.system === 'string' && instructions.system.trim()) {
      parts.push(instructions.system.trim());
    }
    if (Array.isArray(instructions.rules) && instructions.rules.length > 0) {
      parts.push('Rules:\n- ' + instructions.rules.map(String).join('\n- '));
    }
  }

  if (input.memory && typeof input.memory === 'object') {
    const counts = input.memory.counts || {};
    const recent = input.memory.recent || {};
    const kinds = Object.keys(recent);
    if (kinds.length > 0) {
      const lines = ['Recent memory:'];
      for (const kind of kinds) {
        const rows = recent[kind];
        if (!Array.isArray(rows) || rows.length === 0) continue;
        lines.push('  ' + kind + ' (total ' + (counts[kind] || rows.length) + '):');
        for (const r of rows) {
          lines.push('    - ' + shortJson(r.content, 160));
        }
      }
      if (lines.length > 1) parts.push(lines.join('\n'));
    }
  }

  if (Array.isArray(input.tools) && input.tools.length > 0) {
    const lines = ['Tools available to you:'];
    for (const t of input.tools) {
      const ops = Array.isArray(t.operations) && t.operations.length > 0
        ? t.operations.join(', ')
        : 'any operation';
      lines.push('  - ' + t.kind + ':' + t.tool_id + '  [' + ops + ']');
    }
    parts.push(lines.join('\n'));
  }

  return parts.join('\n\n');
}

function composeUser(task) {
  const lines = [];
  if (task.title) lines.push('# ' + task.title);
  if (task.description) lines.push(task.description);
  if (task.payload != null) {
    lines.push('Input:\n' + shortJson(task.payload, 800));
  }
  if (lines.length === 0) lines.push('(no task detail provided)');
  return lines.join('\n\n');
}

function shortJson(value, max) {
  let s;
  try { s = typeof value === 'string' ? value : JSON.stringify(value); }
  catch { s = String(value); }
  if (typeof s !== 'string') s = String(s);
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function extractContent(response) {
  if (typeof response === 'string') return response;
  if (response && typeof response.content === 'string') return response.content;
  if (response && response.message && typeof response.message.content === 'string') {
    return response.message.content;
  }
  if (response && typeof response.response === 'string') return response.response;
  throw new AgentOllamaExecutorError('unexpected chat response shape', 'bad_response');
}

function extractUsage(response, output) {
  const usage = { tokens: null, usd: null };
  if (response && typeof response === 'object') {
    if (Number.isFinite(response.prompt_eval_count) || Number.isFinite(response.eval_count)) {
      const inTokens = Number(response.prompt_eval_count) || 0;
      const outTokens = Number(response.eval_count) || 0;
      usage.tokens = inTokens + outTokens;
    } else if (response.usage && Number.isFinite(response.usage.total_tokens)) {
      usage.tokens = response.usage.total_tokens;
    }
  }
  if (usage.tokens == null && typeof output === 'string') {
    // Best-effort estimate when the model does not report counts.
    usage.tokens = Math.ceil(output.length / 4);
    usage.estimated = true;
  }
  return usage;
}

module.exports = {
  agentOllamaExecutor,
  AgentOllamaExecutorError,
  // exported for tests
  composeSystem,
  composeUser,
  extractContent,
  extractUsage,
};
