'use strict';
/* ===========================================================================
 * NOVA Runtime — agent and workflow builder
 *
 * Turns a goal written in plain words into a DRAFT agent or workflow, using
 * a local Ollama model. The model only chooses from what is really installed
 * here (enabled skills, configured MCP servers, local models, approved
 * agents); anything else it names is dropped and listed in the draft's
 * notes. Drafts cannot be used until a person has tested and approved them:
 *   - a draft agent can be test-run from the Agents view, but cannot be
 *     delegated to, or run from an approved workflow, until approved, and it
 *     can only be approved after at least one successful test run;
 *   - a draft workflow can be test-run, and can only be approved once every
 *     agent it uses is approved.
 * Nothing here grants new permissions: a drafted agent's tool calls go
 * through the same approval-gated pipeline as any other agent's.
 * ========================================================================= */

const REAL_SKILL_IDS = new Set(['skl_codelint', 'skl_filesearch', 'skl_summarize', 'skl_treatment', 'skl_shotlist', 'skl_callsheet', 'skl_translate', 'skl_pptx']);
const MCP_WORKFLOW_SERVERS = new Set(['mcp_fs', 'mcp_git']);   // servers a workflow 'mcp' step can call (see workflow-engine.js)
const MEMORY_SCOPES = ['none', 'session', 'workspace'];
const MAX_NEW_AGENTS_PER_WORKFLOW = 3;
const MAX_WORKFLOW_STEPS = 8;

function httpErr(status, message) { return Object.assign(new Error(message), { statusCode: status }); }
function uid(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function nowIso() { return new Date().toISOString(); }
function clip(s, n) { s = String(s == null ? '' : s).trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function isApproved(agent) { return !!agent && agent.status !== 'draft'; }

/** What the builder may choose from, right now. */
function catalog(store) {
  const skills = store.all('skills').filter(s => s.enabled && s.status !== 'available').map(s => ({
    id: s.id, name: s.name, description: clip(s.description, 200), real: REAL_SKILL_IDS.has(s.id),
    inputs: (s.manifest && s.manifest.inputs) || [],
  }));
  const mcpServers = store.all('mcpServers').map(m => ({
    id: m.id, name: m.name, status: m.status || 'unknown', tools: (m.tools || []).map(t => t.name),
    workflowStep: MCP_WORKFLOW_SERVERS.has(m.id),
  }));
  const models = store.all('models').filter(m => m.runtime === 'ollama').map(m => ({ id: m.id, name: m.name || m.id }));
  const agents = store.all('agents').filter(isApproved).map(a => ({ id: a.id, name: a.name, role: a.role, purpose: clip(a.systemPrompt, 160) }));
  return { skills, mcpServers, models, agents };
}

function pickModel(store, requested) {
  const models = store.all('models').filter(m => m.runtime === 'ollama');
  if (requested) {
    const m = store.get('models', String(requested));
    if (!m) throw httpErr(400, 'Unknown model "' + requested + '"');
    if (m.runtime !== 'ollama') throw httpErr(400, 'Model "' + requested + '" is not a local Ollama model; the builder only runs on local models.');
    return m.id;
  }
  if (!models.length) throw httpErr(503, 'No local Ollama model is available. Sync models from Ollama first.');
  return models[0].id;
}

function parseJson(text) {
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch (_) { /* try the outermost {...} */ }
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(raw.slice(a, b + 1)); } catch (_) { /* fall through */ } }
  return null;
}

/** Ask the model for JSON; if it is not valid (unparseable or fails `check`), say why and ask once more. */
async function askJson(ollama, model, system, prompt, check) {
  let messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
  let lastProblem = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await ollama.chatFull(model, messages, { format: 'json', options: { temperature: 0.2 } });
    const content = (res && res.message && res.message.content) || '';
    const obj = parseJson(content);
    lastProblem = obj ? check(obj) : 'the reply was not valid JSON';
    if (!lastProblem) return { value: obj, repaired: attempt > 0 };
    messages = [...messages, { role: 'assistant', content }, { role: 'user', content: 'Your previous reply was rejected: ' + lastProblem + '. Reply again with only the corrected JSON object.' }];
  }
  throw httpErr(502, 'The model could not produce a usable draft (' + lastProblem + '). Try a clearer goal or another model.');
}

/* ------------------------------------------------------------------ agents */

const AGENT_SYSTEM = [
  'You design agents for NOVA, a local AI workspace. An agent is a local model plus instructions plus a small set of tools.',
  'Choose tools ONLY from the catalog you are given, by id. Choose the fewest tools the goal needs; an agent with no tools is fine.',
  'Skills marked "real": false are placeholders that do nothing useful; avoid them.',
  'Only choose "delegates" (other agents this agent may hand work to) when the goal clearly needs their speciality.',
  'Write the systemPrompt in the second person ("You …"): what the agent does, which tools to use when, and what it must not do',
  '(for example: never invent facts, say when a tool is unavailable, ask before changing files).',
  'Write 2 or 3 short testPrompts a person can run to check the agent works.',
  'Reply with one JSON object: {"name": str, "role": str, "systemPrompt": str, "skills": [skill ids], "mcpServers": [server ids],',
  '"delegates": [agent ids], "memoryScope": "none"|"session"|"workspace", "testPrompts": [str], "notes": str}',
].join('\n');

function agentPrompt(cat, goal) {
  return 'Goal for the new agent:\n' + goal + '\n\nCatalog:\n' + JSON.stringify({
    skills: cat.skills.map(s => ({ id: s.id, name: s.name, description: s.description, real: s.real })),
    mcpServers: cat.mcpServers.map(m => ({ id: m.id, name: m.name, tools: m.tools })),
    agents: cat.agents,
  });
}

function checkAgentShape(o) {
  if (!o || typeof o !== 'object') return 'expected a JSON object';
  if (!String(o.name || '').trim()) return '"name" is missing';
  if (String(o.systemPrompt || '').trim().length < 20) return '"systemPrompt" is missing or too short';
  for (const k of ['skills', 'mcpServers', 'delegates', 'testPrompts']) if (o[k] != null && !Array.isArray(o[k])) return '"' + k + '" must be a list';
  return null;
}

/** Keep only choices that exist here; list what was dropped. */
function sanitiseAgent(store, cat, o, extra = {}) {
  const dropped = [];
  const keep = (list, valid, label) => {
    const out = [];
    for (const id of Array.isArray(list) ? list : []) {
      const s = String(id);
      if (valid.has(s)) { if (!out.includes(s)) out.push(s); } else dropped.push(label + ' "' + s + '"');
    }
    return out;
  };
  const skills = keep(o.skills, new Set(cat.skills.map(s => s.id)), 'skill');
  const simulated = skills.filter(id => !REAL_SKILL_IDS.has(id));
  const mcpServers = keep(o.mcpServers, new Set(cat.mcpServers.map(m => m.id)), 'MCP server');
  const delegates = keep(o.delegates, new Set(cat.agents.map(a => a.id)), 'agent');
  const testPrompts = (Array.isArray(o.testPrompts) ? o.testPrompts : []).map(p => clip(p, 300)).filter(Boolean).slice(0, 3);
  const notes = [clip(o.notes, 600)];
  if (dropped.length) notes.push('Dropped because they are not installed here: ' + dropped.join(', ') + '.');
  if (simulated.length) notes.push('Placeholder skills with no real implementation: ' + simulated.join(', ') + '.');
  const offline = mcpServers.filter(id => (store.get('mcpServers', id) || {}).status !== 'connected');
  if (offline.length) notes.push('Not connected right now, so their tools are unavailable until connected: ' + offline.join(', ') + '.');
  return {
    id: uid('agt'), name: clip(o.name, 60), role: clip(o.role || 'General', 40), status: 'draft',
    systemPrompt: clip(o.systemPrompt, 4000), modelId: extra.modelId, skills, mcpServers, delegates,
    canDraftAgents: false, memoryScope: MEMORY_SCOPES.includes(o.memoryScope) ? o.memoryScope : 'session',
    plan: [], handoffs: [], createdAt: nowIso(), lastRun: null,
    draft: {
      goal: extra.goal, testPrompts: testPrompts.length ? testPrompts : [clip(extra.goal, 300)],
      notes: notes.filter(Boolean).join(' '), builtWith: extra.builtWith, repaired: !!extra.repaired,
      createdBy: extra.createdBy || 'builder', workflowId: extra.workflowId || null, tests: [],
    },
  };
}

/** Draft one agent from a goal; saved with status 'draft'. */
async function draftAgent(store, ollama, { goal, modelId, builderModelId, createdBy, workflowId } = {}) {
  goal = clip(goal, 2000);
  if (goal.length < 8) throw httpErr(400, 'Describe the goal in a sentence or two.');
  const cat = catalog(store);
  const builder = pickModel(store, builderModelId || modelId);
  const agentModel = pickModel(store, modelId || builder);
  const { value, repaired } = await askJson(ollama, builder, AGENT_SYSTEM, agentPrompt(cat, goal), checkAgentShape);
  const agent = sanitiseAgent(store, cat, value, { goal, modelId: agentModel, builtWith: builder, repaired, createdBy, workflowId });
  store.put('agents', agent);
  return agent;
}

/** Record a test run on a draft agent (called by the run route). */
function recordTest(store, agentId, entry) {
  const agent = store.get('agents', agentId);
  if (!agent || !agent.draft) return agent;
  agent.draft.tests = [...(agent.draft.tests || []), { at: nowIso(), ...entry }].slice(-10);
  store.put('agents', agent);
  return agent;
}

function approveAgent(store, agentId) {
  const agent = store.get('agents', agentId);
  if (!agent) throw httpErr(404, 'Unknown agent: ' + agentId);
  if (agent.status !== 'draft') return agent;
  const passed = (agent.draft && agent.draft.tests || []).some(t => t.ok);
  if (!passed) throw httpErr(409, 'Run at least one test of "' + agent.name + '" successfully before approving it.');
  agent.status = 'idle';
  agent.draft = { ...agent.draft, approvedAt: nowIso() };
  store.put('agents', agent);
  return agent;
}

/* --------------------------------------------------------------- workflows */

const WORKFLOW_SYSTEM = [
  'You design workflows for NOVA, a local AI workspace. A workflow is a straight line of steps; each step gets the previous step\'s output.',
  'Step types: "agent" (ref = an existing agent id), "new_agent" (goal = what a new agent for this step should do; use only when no',
  'existing agent fits), "skill" (ref = a skill id from the catalog), "mcp" (ref = a server id whose workflowStep is true; it lists',
  'files or shows git status), and "approval" (a person must sign off before the workflow continues).',
  'Use as few steps as the goal needs (at most ' + MAX_WORKFLOW_STEPS + '). Put an "approval" step before any step that publishes,',
  'sends, deletes or changes files. Give every step a short label saying what it does, for example "Translate to Hindi".',
  'Reply with one JSON object: {"name": str, "description": str, "steps": [{"type": str, "ref": str, "goal": str, "label": str}], "notes": str}',
].join('\n');

function workflowPrompt(cat, goal) {
  return 'Goal for the workflow:\n' + goal + '\n\nCatalog:\n' + JSON.stringify({
    agents: cat.agents,
    skills: cat.skills.filter(s => s.real).map(s => ({ id: s.id, name: s.name, description: s.description })),
    mcpServers: cat.mcpServers.filter(m => m.workflowStep).map(m => ({ id: m.id, name: m.name, workflowStep: true })),
  });
}

function checkWorkflowShape(o) {
  if (!o || typeof o !== 'object') return 'expected a JSON object';
  if (!String(o.name || '').trim()) return '"name" is missing';
  if (!Array.isArray(o.steps) || !o.steps.length) return '"steps" must be a non-empty list';
  if (o.steps.length > MAX_WORKFLOW_STEPS) return 'use at most ' + MAX_WORKFLOW_STEPS + ' steps';
  for (const [i, s] of o.steps.entries()) {
    if (!s || !['agent', 'new_agent', 'skill', 'mcp', 'approval'].includes(s.type)) return 'step ' + (i + 1) + ' has an unknown type';
    if (s.type === 'new_agent' && String(s.goal || '').trim().length < 8) return 'step ' + (i + 1) + ' (new_agent) needs a "goal"';
  }
  if (o.steps.every(s => s.type === 'approval')) return 'a workflow needs at least one step that does something';
  return null;
}

/** Draft a workflow; new agents it needs are drafted too. Returns { workflow, agents }. */
async function draftWorkflow(store, ollama, { goal, modelId } = {}) {
  goal = clip(goal, 2000);
  if (goal.length < 8) throw httpErr(400, 'Describe the goal in a sentence or two.');
  const cat = catalog(store);
  const builder = pickModel(store, modelId);
  const { value, repaired } = await askJson(ollama, builder, WORKFLOW_SYSTEM, workflowPrompt(cat, goal), checkWorkflowShape);

  const workflowId = uid('wf');
  const agentIds = new Set(cat.agents.map(a => a.id));
  const skillIds = new Set(cat.skills.filter(s => s.real).map(s => s.id));
  const dropped = [], created = [];
  const nodes = [];
  for (const s of value.steps) {
    const label = clip(s.label || s.goal || s.type, 80);
    if (s.type === 'approval') { nodes.push({ type: 'approval', ref: null, label: label || 'Sign-off' }); continue; }
    if (s.type === 'agent' && agentIds.has(String(s.ref))) { nodes.push({ type: 'agent', ref: String(s.ref), label }); continue; }
    if (s.type === 'skill' && skillIds.has(String(s.ref))) { nodes.push({ type: 'skill', ref: String(s.ref), label }); continue; }
    if (s.type === 'mcp' && MCP_WORKFLOW_SERVERS.has(String(s.ref)) && store.get('mcpServers', String(s.ref))) { nodes.push({ type: 'mcp', ref: String(s.ref), label }); continue; }
    // An unknown agent reference, or an explicit new_agent step, becomes a new draft agent.
    if ((s.type === 'new_agent' || s.type === 'agent') && created.length < MAX_NEW_AGENTS_PER_WORKFLOW) {
      const stepGoal = clip(s.goal || s.label || '', 600);
      if (stepGoal.length >= 8) {
        const agent = await draftAgent(store, ollama, { goal: stepGoal + '\n(This agent is one step of a workflow whose overall goal is: ' + goal + ')', builderModelId: builder, createdBy: 'workflow-builder', workflowId });
        created.push(agent);
        nodes.push({ type: 'agent', ref: agent.id, label });
        continue;
      }
    }
    dropped.push(s.type + (s.ref ? ' "' + s.ref + '"' : '') + (label ? ' (' + label + ')' : ''));
  }
  if (!nodes.some(n => n.type !== 'approval')) throw httpErr(502, 'None of the drafted steps use something installed here. Try rewording the goal.');
  nodes.forEach((n, i) => { n.id = 'n' + (i + 1); n.x = i; n.y = 0; n.next = i + 1 < nodes.length ? ['n' + (i + 2)] : []; });
  const translate = nodes.find(n => n.ref === 'skl_translate');
  if (translate) { const m = translate.label.match(/\bto\s+([\p{L} ]{2,40})$/u); if (m) translate.targetLang = m[1].trim(); }

  const notes = [clip(value.notes, 600)];
  if (dropped.length) notes.push('Dropped steps that use something not installed here: ' + dropped.join('; ') + '.');
  if (created.length) notes.push('New draft agents for this workflow: ' + created.map(a => a.name).join(', ') + '. Test and approve them before approving the workflow.');
  const workflow = {
    id: workflowId, name: clip(value.name, 80), description: clip(value.description || goal, 400), status: 'draft',
    schedule: { type: 'manual', detail: 'Run now' }, nodes,
    draft: { goal, notes: notes.filter(Boolean).join(' '), builtWith: builder, repaired, agents: created.map(a => a.id), createdAt: nowIso() },
  };
  store.put('workflows', workflow);
  return { workflow, agents: created };
}

function approveWorkflow(store, workflowId) {
  const wf = store.get('workflows', workflowId);
  if (!wf) throw httpErr(404, 'Unknown workflow: ' + workflowId);
  if (wf.status !== 'draft') return wf;
  const waiting = wf.nodes.filter(n => n.type === 'agent').map(n => store.get('agents', n.ref)).filter(a => !a || a.status === 'draft');
  if (waiting.length) throw httpErr(409, 'Approve these agents first: ' + waiting.map(a => a ? a.name : 'a missing agent').join(', ') + '.');
  wf.status = 'active';
  wf.draft = { ...wf.draft, approvedAt: nowIso() };
  store.put('workflows', wf);
  return wf;
}

/** Discard a draft workflow and the draft agents it created (approved agents are kept). */
function discardWorkflow(store, workflowId) {
  const wf = store.get('workflows', workflowId);
  if (!wf) throw httpErr(404, 'Unknown workflow: ' + workflowId);
  if (wf.status !== 'draft') throw httpErr(409, 'Only draft workflows can be discarded here.');
  const removed = [];
  for (const id of (wf.draft && wf.draft.agents) || []) {
    const a = store.get('agents', id);
    if (a && a.status === 'draft') { store.delete('agents', id); removed.push(id); }
  }
  store.delete('workflows', workflowId);
  return { ok: true, removedAgents: removed };
}

function discardAgent(store, agentId) {
  const a = store.get('agents', agentId);
  if (!a) throw httpErr(404, 'Unknown agent: ' + agentId);
  if (a.status !== 'draft') throw httpErr(409, 'Only draft agents can be discarded here.');
  const usedBy = store.all('workflows').filter(w => (w.nodes || []).some(n => n.type === 'agent' && n.ref === agentId)).map(w => w.name);
  if (usedBy.length) throw httpErr(409, 'This draft is used by: ' + usedBy.join(', ') + '. Discard that workflow instead.');
  store.delete('agents', agentId);
  return { ok: true };
}

module.exports = {
  catalog, draftAgent, draftWorkflow, approveAgent, approveWorkflow, discardAgent, discardWorkflow, recordTest, isApproved,
  REAL_SKILL_IDS, MAX_NEW_AGENTS_PER_WORKFLOW,
};
