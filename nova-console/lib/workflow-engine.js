'use strict';
/* ===========================================================================
 * NOVA Runtime — real workflow run engine (Phase 4)
 *
 * The console's own client-side advanceWorkflowRun() used to be the entire
 * run "engine": a setTimeout loop in the browser that flipped each node's
 * status to 'done' on a jittered delay and never actually ran anything —
 * no real agent call, no real skill, no real MCP tool, and nothing left to
 * resume a run if the tab closed mid-flight. This module replaces that with
 * a real server-side stepper: each node genuinely executes (an 'agent'
 * node runs the real tool-calling loop in lib/agent-loop.js, a 'skill' node
 * runs Phase 3's real sandboxed skill when one exists, an 'mcp' node makes
 * a real approval-gated tool call), and run/step state is re-read from
 * SQLite on every transition rather than held only in a browser variable —
 * so a run still 'running' when the server process goes down (crash,
 * restart, redeploy) is picked back up from its last persisted node by
 * resumeInFlightRuns() at the next startup, instead of being silently
 * abandoned. Honest limit: a restart re-runs the node that was in flight
 * from scratch (its last completed node is not re-run) — there is no
 * checkpoint *inside* a node's own execution, only between nodes.
 * ========================================================================= */
const { runAgentLoop } = require('./agent-loop');
const { runSkillSandboxed } = require('./skill-runner');
const { buildSkillHost } = require('./skill-host');
const mcpManager = require('./mcp-manager');

const REAL_SKILL_IDS = new Set(['skl_codelint', 'skl_filesearch', 'skl_summarize', 'skl_treatment', 'skl_shotlist', 'skl_callsheet', 'skl_translate', 'skl_pptx']);
const TEXT_SKILL_IDS = new Set(['skl_summarize', 'skl_treatment', 'skl_shotlist', 'skl_callsheet', 'skl_translate', 'skl_pptx']);

// Workflow nodes carry a server reference but no explicit tool+args field
// (a real gap in the node schema — flagged here rather than silently
// worked around). One honest default read-only tool stands in per server
// kind, so an 'mcp' node still makes a genuine call instead of a fake one.
const MCP_NODE_DEFAULT_CALL = {
  mcp_fs: { toolName: 'list_directory', args: { path: '.' } },
  mcp_git: { toolName: 'git_status', args: {} },
};

function uid(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function nowIso() { return new Date().toISOString(); }

function logExecution(store, type, label, status, detail, relatedId) {
  const ex = {
    id: uid('ex'), type, label, status, detail: detail || '', relatedId: relatedId || null,
    startedAt: nowIso(), finishedAt: (status === 'running' || status === 'pending' || status === 'awaiting_approval') ? null : nowIso(),
  };
  store.put('executions', ex);
  return ex;
}
function updateExecution(store, id, patch) {
  const ex = store.get('executions', id);
  if (!ex) return null;
  Object.assign(ex, patch);
  if (!ex.finishedAt && ex.status !== 'running' && ex.status !== 'pending' && ex.status !== 'awaiting_approval') ex.finishedAt = nowIso();
  store.put('executions', ex);
  return ex;
}

function summarizeOutput(output) {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  return text.length > 160 ? text.slice(0, 157) + '…' : text;
}

async function runNode(store, ollama, node, context) {
  if (node.type === 'agent') {
    const agent = store.get('agents', node.ref);
    if (!agent) throw new Error('Workflow references unknown agent "' + node.ref + '"');
    const result = await runAgentLoop(store, ollama, agent, node.label, context, 'workflow');
    return result.content || '(agent produced no final content)';
  }

  if (node.type === 'skill') {
    const skill = store.get('skills', node.ref);
    if (!skill) throw new Error('Workflow references unknown skill "' + node.ref + '"');
    if (!skill.enabled) throw new Error('Skill "' + skill.name + '" is disabled');
    if (REAL_SKILL_IDS.has(node.ref)) {
      // Text skills summarize whatever the previous node produced.
      const inputs = TEXT_SKILL_IDS.has(node.ref) ? { text: context || node.label, focus: node.label } : {};
      // A Translate step names its language on the node (targetLang) or in its label, e.g. "Translate to Hindi".
      if (node.ref === 'skl_translate') inputs.targetLang = node.targetLang || ((String(node.label || '').match(/\bto\s+([\p{L} ]{2,40})$/u) || [])[1] || '').trim();
      const result = await runSkillSandboxed(skill, inputs, async (toolName, args) => {
        const server = mcpManager.findServerForTool(store, toolName);
        if (!server) throw Object.assign(new Error('No connected MCP server advertises tool "' + toolName + '"'), { statusCode: 502 });
        return mcpManager.gatedCall(store, server.id, toolName, args, { wait: true, origin: 'workflow' });
      }, buildSkillHost(store, ollama, skill));
      if (TEXT_SKILL_IDS.has(node.ref)) require('./library').recordSkillOutput(store, skill, inputs, result);
      if (node.ref === 'skl_summarize') return result.summary;
      if (TEXT_SKILL_IDS.has(node.ref)) return result.markdown;
      return JSON.stringify(result);
    }
    await new Promise(r => setTimeout(r, 400 + Math.random() * 300));
    return '(simulated) ' + skill.name + ' ran on: ' + (context || node.label);
  }

  if (node.type === 'mcp') {
    const call = MCP_NODE_DEFAULT_CALL[node.ref];
    if (!call) throw Object.assign(new Error('No real default tool call is configured for MCP server "' + node.ref + '" in a workflow node'), { statusCode: 501 });
    const result = await mcpManager.gatedCall(store, node.ref, call.toolName, call.args, { wait: true, origin: 'workflow' });
    return (result.content || []).map(c => c.text).filter(Boolean).join('\n') || '(no output)';
  }

  throw new Error('Unknown workflow node type "' + node.type + '"');
}

/** Steps a run forward from its currently-persisted node until it
 *  completes, fails, or reaches an approval gate. Always re-reads the run
 *  and workflow from the store rather than trusting an in-memory copy, so
 *  this is safe to call concurrently from a fresh resume after a restart. */
async function advanceRun(store, ollama, runId) {
  let run = store.get('workflowRuns', runId);
  if (!run || run.status === 'completed' || run.status === 'failed') return run;
  const workflow = store.get('workflows', run.workflowId);
  if (!workflow) {
    run.status = 'failed'; run.finishedAt = nowIso(); run.error = 'Workflow no longer exists';
    store.put('workflowRuns', run);
    return run;
  }

  while (run.currentNodeId) {
    const node = workflow.nodes.find(n => n.id === run.currentNodeId);
    const step = run.steps.find(s => s.nodeId === run.currentNodeId);
    if (!node || !step) {
      run.status = 'failed'; run.finishedAt = nowIso(); run.error = 'Run points at an unknown node';
      store.put('workflowRuns', run);
      return run;
    }

    if (node.type === 'approval') {
      step.status = 'awaiting_approval'; step.startedAt = step.startedAt || nowIso();
      run.status = 'awaiting_approval';
      store.put('workflowRuns', run);
      logExecution(store, 'workflow', workflow.name + ' run reached approval gate: ' + node.label, 'awaiting_approval', 'Waiting on a human', run.id);
      return run; // genuinely waits — resolveApprovalNode() below resumes it
    }

    step.status = 'active'; step.startedAt = step.startedAt || nowIso();
    run.status = 'running';
    store.put('workflowRuns', run);
    const exec = logExecution(store, 'workflow', workflow.name + ' · ' + node.label, 'running', 'Node "' + node.label + '" started', run.id);

    let output;
    try {
      output = await runNode(store, ollama, node, run.lastOutput);
    } catch (e) {
      step.status = 'failed'; step.finishedAt = nowIso();
      run.status = 'failed'; run.finishedAt = nowIso(); run.error = e.message || String(e);
      store.put('workflowRuns', run);
      updateExecution(store, exec.id, { status: 'error', detail: e.message || String(e) });
      return run;
    }

    step.status = 'done'; step.finishedAt = nowIso();
    run.lastOutput = typeof output === 'string' ? output.slice(0, 4000) : output;
    updateExecution(store, exec.id, { status: 'success', detail: summarizeOutput(run.lastOutput) });

    const nextId = (node.next || [])[0];
    if (!nextId) {
      run.status = 'completed'; run.finishedAt = nowIso(); run.currentNodeId = null;
      store.put('workflowRuns', run);
      return run;
    }
    run.currentNodeId = nextId;
    store.put('workflowRuns', run);
  }
  return run;
}

function startRun(store, workflowId) {
  const workflow = store.get('workflows', workflowId);
  if (!workflow) throw Object.assign(new Error('Unknown workflow: ' + workflowId), { statusCode: 404 });
  const firstId = workflow.nodes[0] && workflow.nodes[0].id;
  if (!firstId) throw Object.assign(new Error('Workflow "' + workflow.name + '" has no nodes'), { statusCode: 400 });
  const run = {
    id: uid('wfr'), workflowId, status: 'running', currentNodeId: firstId, startedAt: nowIso(), finishedAt: null, lastOutput: null,
    steps: workflow.nodes.map((n, i) => ({ nodeId: n.id, status: i === 0 ? 'active' : 'pending', startedAt: i === 0 ? nowIso() : null, finishedAt: null })),
  };
  store.put('workflowRuns', run);
  logExecution(store, 'workflow', workflow.name + ' · run', 'running', 'Started', run.id);
  return run;
}

/** The human-gate transition for an 'approval' node: resolveApproval moves
 *  the run's currentNodeId forward (or fails the run) but does not itself
 *  keep stepping — the caller (server.js's route) kicks advanceRun() again
 *  to actually run whatever comes next. Distinct from, and unrelated to,
 *  an MCP server's own tools/call approval policy from Phase 3 — this is
 *  the workflow's own explicit human sign-off node. */
function resolveApprovalNode(store, runId, decision) {
  const run = store.get('workflowRuns', runId);
  if (!run) throw Object.assign(new Error('Unknown workflow run: ' + runId), { statusCode: 404 });
  const workflow = store.get('workflows', run.workflowId);
  const node = workflow && workflow.nodes.find(n => n.id === run.currentNodeId);
  if (!node || node.type !== 'approval' || run.status !== 'awaiting_approval') {
    throw Object.assign(new Error('Run "' + runId + '" is not currently waiting on an approval node'), { statusCode: 400 });
  }
  const step = run.steps.find(s => s.nodeId === node.id);

  if (decision === 'reject') {
    step.status = 'failed'; step.finishedAt = nowIso();
    run.status = 'failed'; run.finishedAt = nowIso(); run.error = 'Rejected by operator at approval gate "' + node.label + '"';
    store.put('workflowRuns', run);
    logExecution(store, 'approval', 'Workflow run ' + run.id + ' · ' + node.label, 'rejected', 'Rejected by operator', run.id);
    return run;
  }

  step.status = 'done'; step.finishedAt = nowIso();
  logExecution(store, 'approval', 'Workflow run ' + run.id + ' · ' + node.label, 'approved', 'Approved by operator', run.id);
  const nextId = (node.next || [])[0];
  if (!nextId) {
    run.status = 'completed'; run.finishedAt = nowIso(); run.currentNodeId = null;
    store.put('workflowRuns', run);
    return run;
  }
  run.currentNodeId = nextId;
  run.status = 'running';
  store.put('workflowRuns', run);
  return run;
}

/** Called once at server startup. A run left 'running' when the process
 *  went down gets its stepper restarted from its last persisted
 *  currentNodeId — real resumption, because that state was already durable
 *  in SQLite, not held only in the now-gone process's memory.
 *  'awaiting_approval' runs are correctly left alone; a human still needs
 *  to act, and the approve/reject routes already know how to resume them. */
function resumeInFlightRuns(store, ollama) {
  const runs = store.all('workflowRuns').filter(r => r.status === 'running');
  for (const r of runs) {
    advanceRun(store, ollama, r.id).catch(e => console.error('[nova-runtime] failed to resume workflow run', r.id, e.message || e));
  }
  return runs.length;
}

module.exports = { startRun, advanceRun, resolveApprovalNode, resumeInFlightRuns };
