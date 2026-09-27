'use strict';
/* ===========================================================================
 * NOVA Runtime — real agent tool-calling loop (Phase 4)
 *
 * This ports the *shape* of the multi-provider agent router already built
 * for the separate Maataa project this session (india-scraper-next/lib/
 * agent-router.ts: a capped round-trip loop, system prompt + skills-as-
 * tools + MCP-tools-as-tools, a full tool trace) — not its code, since that
 * file is explicitly off-limits to modify and targets a different local
 * stack (multi-provider chain: OpenAI/Anthropic/DeepSeek/Gemini adapters).
 * NOVA only has one real local provider, so the loop below runs against
 * Ollama directly, and every tool it can call is one of this project's own
 * real pieces: Phase 3's sandboxed skill runner for skills-as-tools, and
 * Phase 3's approval-gated gatedCall() for MCP-tools-as-tools. An agent's
 * tool call — skill or MCP — goes through the exact same gate a human
 * clicking "Call" in the MCP view goes through; nothing here bypasses
 * approval policy, and a skill with no real implementation still runs its
 * honestly-labeled simulated path rather than being silently skipped.
 * ========================================================================= */
const mcpManager = require('./mcp-manager');
const { runSkillSandboxed } = require('./skill-runner');
const { buildSkillHost } = require('./skill-host');

const MAX_TOOL_ROUNDS = 6;
// How deep hand-offs may go: an agent (depth 0) may hand off to a delegate
// (depth 1), which may hand off once more (depth 2), and no further.
const MAX_HANDOFF_DEPTH = Math.max(0, Math.min(4, Number(process.env.NOVA_AGENT_MAX_DEPTH || 2)));

// Skills with a real sandboxed entrypoint (Phase 3) — mirrors server.js's
// own REAL_SKILL_IDS. Anything else is still offered to the model as a
// tool (an agent may legitimately have it configured), but calling it
// returns an honestly-labeled simulated result instead of pretending to
// run code that doesn't exist.
const REAL_SKILL_IDS = new Set(['skl_codelint', 'skl_filesearch', 'skl_summarize', 'skl_treatment', 'skl_shotlist', 'skl_callsheet', 'skl_translate', 'skl_pptx']);

function jsonSchemaFromManifestInputs(inputNames) {
  const properties = {};
  for (const name of inputNames || []) properties[name] = { type: 'string' };
  return { type: 'object', properties };
}

// The fs/git MCP servers (mcp-servers/*.js) declare a flat
// {argName: 'string'} inputSchema rather than full JSON Schema — translate
// it into the {type:'object', properties:{...}} shape Ollama's tools field
// expects, same idea as jsonSchemaFromManifestInputs above.
function toJsonSchema(inputSchema) {
  const properties = {};
  for (const [k, v] of Object.entries(inputSchema || {})) {
    properties[k] = typeof v === 'string' ? { type: v } : v;
  }
  return { type: 'object', properties };
}

/** Builds the Ollama-shaped tool specs for everything one agent may call
 *  right now: each enabled skill in agent.skills becomes one tool, and
 *  each tool a *connected* server in agent.mcpServers currently advertises
 *  becomes one tool, namespaced "mcp__<serverId>__<toolName>" so two
 *  servers' same-named tools can't collide. A server that isn't connected
 *  contributes no tools — an agent can't call what isn't live, exactly
 *  like the manual Call button in the MCP view. */
function buildToolSpecs(store, agent, opts = {}) {
  const specs = [];
  const owners = new Map();
  const depth = opts.depth || 0;
  const chain = opts.chain || [agent.id];

  for (const skillId of agent.skills || []) {
    const skill = store.get('skills', skillId);
    if (!skill || !skill.enabled) continue;
    const name = 'skill__' + skillId.replace(/^skl_/, '');
    const inputs = (skill.manifest && skill.manifest.inputs) || [];
    specs.push({
      type: 'function',
      function: {
        name,
        description: skill.description + (REAL_SKILL_IDS.has(skillId) ? '' : ' (simulated — no real implementation yet)'),
        parameters: jsonSchemaFromManifestInputs(inputs),
      },
    });
    owners.set(name, { kind: 'skill', skillId });
  }

  for (const serverId of agent.mcpServers || []) {
    const server = store.get('mcpServers', serverId);
    if (!server || server.status !== 'connected') continue;
    for (const t of server.tools || []) {
      const name = 'mcp__' + serverId + '__' + t.name;
      specs.push({
        type: 'function',
        function: { name, description: t.description || (t.name + ' on ' + server.name), parameters: toJsonSchema(t.inputSchema) },
      });
      owners.set(name, { kind: 'mcp', serverId, toolName: t.name });
    }
  }

  // Hand-offs: each approved delegate becomes a tool, while depth allows.
  // An agent already in this chain is never offered again (no loops), and
  // a draft agent is never offered (drafts need a person's approval first).
  if (depth < MAX_HANDOFF_DEPTH) {
    for (const delegateId of agent.delegates || []) {
      const d = store.get('agents', delegateId);
      if (!d || d.status === 'draft' || chain.includes(d.id)) continue;
      const name = 'agent__' + d.id.replace(/[^A-Za-z0-9_]/g, '_');
      specs.push({
        type: 'function',
        function: {
          name,
          description: 'Hand a task to the agent "' + d.name + '" (' + (d.role || 'General') + '): ' + String(d.systemPrompt || '').slice(0, 200) + ' It replies with its result.',
          parameters: { type: 'object', properties: { instruction: { type: 'string', description: 'What ' + d.name + ' should do' }, context: { type: 'string', description: 'Anything it needs to know' } }, required: ['instruction'] },
        },
      });
      owners.set(name, { kind: 'agent', agentId: d.id });
    }
  }

  // Drafting: an agent allowed to (canDraftAgents) may propose a new agent.
  // The result is a DRAFT: it cannot run, be delegated to or join an
  // approved workflow until a person tests and approves it.
  if (agent.canDraftAgents && agent.status !== 'draft') {
    specs.push({
      type: 'function',
      function: {
        name: 'nova__draft_agent',
        description: 'Propose a new agent for a task no available agent covers. It is saved as a draft that a person must test and approve before anyone can use it.',
        parameters: { type: 'object', properties: { goal: { type: 'string', description: 'What the new agent should do, in a sentence or two' } }, required: ['goal'] },
      },
    });
    owners.set('nova__draft_agent', { kind: 'draft' });
  }
  return { specs, owners };
}

/** Same simulated path the Skills view itself falls back to for the two
 *  skills with no real sandboxed entrypoint — invoked here so an agent
 *  calling them as a tool gets the same honest behavior, not a different
 *  fake. */
async function runSimulatedSkill(skill) {
  await new Promise(r => setTimeout(r, 300 + Math.random() * 250));
  if (skill.id === 'skl_translate') return { text: '(simulated) Translated text.' };
  return { note: '(simulated) No real implementation for this skill yet.' };
}

async function executeTool(store, owners, name, args, origin, runtime = {}) {
  const owner = owners.get(name);
  if (!owner) throw Object.assign(new Error('Tool "' + name + '" is not available to this agent'), { statusCode: 400 });

  if (owner.kind === 'skill') {
    const skill = store.get('skills', owner.skillId);
    if (!skill) throw new Error('Unknown skill: ' + owner.skillId);
    if (REAL_SKILL_IDS.has(owner.skillId)) {
      return runSkillSandboxed(skill, args, async (toolName, toolArgs) => {
        const server = mcpManager.findServerForTool(store, toolName);
        if (!server) throw Object.assign(new Error('No connected MCP server advertises tool "' + toolName + '"'), { statusCode: 502 });
        return mcpManager.gatedCall(store, server.id, toolName, toolArgs, { wait: true, origin, skillName: skill.name });
      }, buildSkillHost(store, runtime.ollama, skill, { modelId: runtime.modelId }));
    }
    return runSimulatedSkill(skill);
  }

  if (owner.kind === 'agent') {
    const target = store.get('agents', owner.agentId);
    if (!target || target.status === 'draft') throw new Error('Agent "' + owner.agentId + '" is not available for hand-off');
    const instruction = String(args.instruction || '').trim();
    if (!instruction) throw new Error('A hand-off needs an instruction');
    const from = runtime.agent;
    const at = new Date().toISOString();
    target.handoffs = [...(target.handoffs || []), { fromAgentId: from && from.id, toAgentId: target.id, reason: instruction.slice(0, 300), at }].slice(-50);
    store.put('agents', target);
    const result = await runAgentLoop(store, runtime.ollama, target, instruction, args.context, origin + ' → ' + (from ? from.name : 'agent'),
      { depth: (runtime.depth || 0) + 1, chain: [...(runtime.chain || []), target.id] });
    return { agent: target.name, content: result.content, toolCalls: result.toolTrace.map(t => t.name), rounds: result.rounds };
  }

  if (owner.kind === 'draft') {
    const builder = require('./agent-builder');
    const from = runtime.agent;
    const draft = await builder.draftAgent(store, runtime.ollama, { goal: String(args.goal || ''), modelId: from && from.modelId, createdBy: 'agent:' + (from ? from.id : '?') });
    return { draftAgentId: draft.id, name: draft.name, skills: draft.skills, mcpServers: draft.mcpServers,
      note: 'Saved as a draft. A person must test and approve it in the Agents view before it can be used.' };
  }

  // owner.kind === 'mcp' — real, approval-gated, waits for a human on 'ask'.
  return mcpManager.gatedCall(store, owner.serverId, owner.toolName, args, { wait: true, origin });
}

function parseToolArgs(call) {
  const raw = call.function && call.function.arguments;
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

function resolveOllamaModel(store, modelId) {
  const m = store.get('models', modelId);
  if (!m) throw Object.assign(new Error('Agent\'s model "' + modelId + '" does not exist'), { statusCode: 400 });
  if (m.runtime !== 'ollama') throw Object.assign(new Error('Agent\'s model "' + modelId + '" is not Ollama-backed — the real agent loop only runs against a real local Ollama model'), { statusCode: 400 });
  return m.id;
}

/** The real loop itself — ported from agent-router.ts's completeAsAgent():
 *  a system prompt, a capped round-trip loop against the model, real tool
 *  execution on every tool_call the model asks for, and a full trace of
 *  what was called and what came back. `origin` labels who's driving this
 *  (the Agents view's manual Run button, or a workflow's 'agent' node) so
 *  MCP logs and approval records say so honestly. */
async function runAgentLoop(store, ollama, agent, instruction, context, origin, opts = {}) {
  const modelName = resolveOllamaModel(store, agent.modelId);
  const depth = opts.depth || 0;
  const chain = opts.chain || [agent.id];
  const { specs, owners } = buildToolSpecs(store, agent, { depth, chain });
  const systemPrompt = agent.systemPrompt || 'You are a helpful workspace agent.';

  let messages = [
    { role: 'system', content: systemPrompt },
    ...(context ? [{ role: 'user', content: 'Context from prior steps:\n' + String(context).slice(0, 4000) }] : []),
    { role: 'user', content: instruction },
  ];
  const toolTrace = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const message = await ollama.chat(modelName, messages, specs);
    const calls = message.tool_calls || [];

    if (!calls.length) {
      return { content: message.content || '', toolTrace, rounds: round + 1 };
    }

    messages = [...messages, { role: 'assistant', content: message.content || '', tool_calls: calls }];

    for (const call of calls) {
      const name = (call.function && call.function.name) || '';
      const args = parseToolArgs(call);
      let resultText;
      try {
        const result = await executeTool(store, owners, name, args, origin || 'agent', { ollama, modelId: agent.modelId, agent, depth, chain });
        resultText = typeof result === 'string' ? result : JSON.stringify(result);
      } catch (e) {
        resultText = 'Error: ' + (e.message || String(e));
      }
      toolTrace.push({ name, arguments: args, result: resultText });
      messages = [...messages, { role: 'tool', content: resultText }];
    }
  }

  throw Object.assign(
    new Error('Agent "' + agent.name + '" did not finish within ' + MAX_TOOL_ROUNDS + ' tool-call rounds'),
    { statusCode: 504 }
  );
}

module.exports = { runAgentLoop, buildToolSpecs, MAX_TOOL_ROUNDS, MAX_HANDOFF_DEPTH };
