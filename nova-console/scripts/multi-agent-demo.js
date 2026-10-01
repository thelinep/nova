#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const { openDb, Store } = require('../lib/db');
const { AgentRegistry } = require('../lib/agents');
const { AgentMemory } = require('../lib/agent-memory');
const { AgentTasks } = require('../lib/agent-tasks');
const { AgentTools } = require('../lib/agent-tools');
const { AgentSupervisor } = require('../lib/agent-supervisor');
const { BudgetEngine } = require('../lib/budgets');
const { AgentBudgets } = require('../lib/agent-budgets');

const DATA_DIR = path.resolve(process.cwd(), 'data');
const OPERATOR = process.env.NOVA_OPERATOR || 'demo-operator';

function banner(n, text) {
  console.log('\n─── ' + n + ' · ' + text + ' ' + '─'.repeat(Math.max(0, 56 - text.length)));
}

function sub(text) {
  console.log('   ' + text);
}

function cleanPreviousRun(store) {
  // Hard delete any prior demo-run rows so the UNIQUE name constraint
  // does not block re-runs. Also removes dependent records for the
  // demo agents so the Workbench does not show orphans.
  const prefix = 'demo8-%';
  const db = store.db;

  const ids = db.prepare(
    "SELECT id FROM agent_registry WHERE name LIKE ?"
  ).all(prefix).map((r) => r.id);

  if (ids.length === 0) return;

  const placeholders = ids.map(() => '?').join(',');

  // Order matters: dependent tables first
  db.prepare('DELETE FROM agent_task_events WHERE task_id IN (SELECT id FROM agent_tasks WHERE creator_id IN (' + placeholders + ') OR assignee_id IN (' + placeholders + '))').run(...ids, ...ids);
  db.prepare('DELETE FROM agent_tasks WHERE creator_id IN (' + placeholders + ') OR assignee_id IN (' + placeholders + ')').run(...ids, ...ids);
  db.prepare('DELETE FROM agent_escalation_events WHERE escalation_id IN (SELECT id FROM agent_escalations WHERE escalator_id IN (' + placeholders + ') OR reviewer_id IN (' + placeholders + '))').run(...ids, ...ids);
  db.prepare('DELETE FROM agent_escalations WHERE escalator_id IN (' + placeholders + ') OR reviewer_id IN (' + placeholders + ')').run(...ids, ...ids);
  db.prepare('DELETE FROM agent_tool_bindings WHERE agent_id IN (' + placeholders + ')').run(...ids);
  db.prepare('DELETE FROM agent_memory WHERE agent_id IN (' + placeholders + ')').run(...ids);
  db.prepare('DELETE FROM agent_registry WHERE id IN (' + placeholders + ')').run(...ids);
}

async function main() {
  banner(0, 'NOVA multi-agent demo');
  sub('operator: ' + OPERATOR);
  sub('data dir: ' + DATA_DIR);
  sub('purpose:  exercise M1–M6 primitives end-to-end');

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const { db } = openDb(DATA_DIR);
  const store = new Store(db);

  const registry     = new AgentRegistry(store);
  const memory       = new AgentMemory(store, { registry });
  const tasks        = new AgentTasks(store, { registry });
  const tools        = new AgentTools(store, { registry });
  const supervisor   = new AgentSupervisor(store, { registry });
  const budgetEngine = new BudgetEngine(store);
  const budgets      = new AgentBudgets({ store, registry, budgetEngine });

  cleanPreviousRun(store);

  // --------------------------------------------------------------
  banner(1, 'M1 · register agents with hierarchy');

  const top = registry.create({
    name: 'demo8-lead', role: 'supervisor',
    description: 'team lead',
    instructions: { system: 'You coordinate the team.' },
    createdBy: OPERATOR,
  });
  const planner = registry.create({
    name: 'demo8-planner', role: 'planner',
    supervisorId: top.id,
    instructions: { system: 'You decompose work.' },
    createdBy: OPERATOR,
  });
  const worker = registry.create({
    name: 'demo8-worker', role: 'worker',
    supervisorId: planner.id,
    instructions: { system: 'You execute tasks.' },
    allowedTools: ['connector:github'],
    createdBy: OPERATOR,
  });
  const reviewer = registry.create({
    name: 'demo8-reviewer', role: 'reviewer',
    supervisorId: planner.id,
    instructions: { system: 'You check quality.' },
    createdBy: OPERATOR,
  });

  sub('lead:     ' + top.id.slice(0, 12) + '  (supervisor)');
  sub('planner:  ' + planner.id.slice(0, 12) + '  → reports to ' + top.id.slice(0, 12));
  sub('worker:   ' + worker.id.slice(0, 12) + '  → reports to ' + planner.id.slice(0, 12));
  sub('reviewer: ' + reviewer.id.slice(0, 12) + '  → reports to ' + planner.id.slice(0, 12));
  sub('registry health: ' + JSON.stringify(registry.health()));

  // --------------------------------------------------------------
  banner(2, 'M4 · assign per-agent budgets with cascade');

  budgets.setFromRoleDefaults(top.id,     { tokens: 500000, usd: 50, jobs: 500 });
  budgets.setFromRoleDefaults(planner.id, { tokens: 200000, usd: 20, jobs: 200 });
  budgets.setFromRoleDefaults(worker.id,  { tokens: 40000,  usd: 4,  jobs: 40  });
  budgets.setFromRoleDefaults(reviewer.id);

  const wLimit = budgets.effectiveLimit(worker.id, 'tokens');
  sub('worker token cap:           ' + wLimit.limit + ' (own budget)');
  sub('effective tightest link:    ' + wLimit.remaining + ' remaining on '
      + wLimit.agent_id.slice(0, 12));

  const charge1 = budgets.charge(worker.id, 'tokens', 5000, 'task-a');
  sub('charge 5000 tokens on worker → chain=' + charge1.chain.length
      + ' links, ok=' + charge1.ok);
  sub('  worker used:   ' + pickUsage(budgets, worker.id, 'tokens'));
  sub('  planner used:  ' + pickUsage(budgets, planner.id, 'tokens'));
  sub('  lead used:     ' + pickUsage(budgets, top.id, 'tokens'));

  // --------------------------------------------------------------
  banner(3, 'M5 · bind tools and check access');

  tools.bind(worker.id, {
    kind: 'connector', toolId: 'conn_github_demo',
    operations: ['pr:create', 'issue:read'],
    createdBy: OPERATOR,
  });
  tools.bind(reviewer.id, {
    kind: 'skill', toolId: 'lint',
    createdBy: OPERATOR,
  });

  const okCheck = tools.check(worker.id, {
    kind: 'connector', toolId: 'conn_github_demo', operation: 'pr:create',
  });
  sub('worker → create PR:      ' + okCheck.reason + '  (allowed=' + okCheck.allowed + ')');

  const deniedCheck = tools.check(worker.id, {
    kind: 'connector', toolId: 'conn_github_demo', operation: 'issue:delete',
  });
  sub('worker → delete issue:   ' + deniedCheck.reason + '  (allowed=' + deniedCheck.allowed + ')');

  const noBinding = tools.check(reviewer.id, {
    kind: 'connector', toolId: 'conn_github_demo', operation: 'pr:create',
  });
  sub('reviewer → create PR:    ' + noBinding.reason + '  (allowed=' + noBinding.allowed + ')');

  // --------------------------------------------------------------
  banner(4, 'M2 · write and recall typed memory');

  memory.remember(worker.id, {
    kind: 'observation', content: { note: 'repo uses squash merges' },
    tags: ['github', 'conventions'], scope: 'shared',
  });
  memory.remember(worker.id, {
    kind: 'decision', content: { chose: 'retry with backoff' },
    tags: ['reliability'], scope: 'supervisor-visible',
    confidence: 0.75,
  });
  memory.remember(worker.id, {
    kind: 'lesson', content: { learned: 'never force-push shared branches' },
    tags: ['git'], scope: 'supervisor-visible',
  });

  const sharedForReviewer = memory.recall(reviewer.id, { kind: 'observation' });
  sub('reviewer sees shared obs: ' + sharedForReviewer.length + ' entries');

  const supForPlanner = memory.recall(planner.id, { kind: 'lesson' });
  sub('planner sees worker lesson: ' + supForPlanner.length + ' entries');
  if (supForPlanner[0]) {
    sub('  content: ' + JSON.stringify(supForPlanner[0].content));
  }

  const privForPlanner = memory.recall(planner.id, { kind: 'decision' });
  sub('planner sees worker decision (supervisor-visible): '
      + privForPlanner.length + ' entries');

  // --------------------------------------------------------------
  banner(5, 'M3 · create, assign, hand off a task');

  const task = tasks.create({
    title: 'Open PR to add rate limiter',
    description: 'Implement a token bucket and open a PR.',
    creatorId: planner.id,
    assigneeId: worker.id,
  });
  sub('task created:  ' + task.id.slice(0, 12)
      + '  state=' + task.state + '  assignee=' + task.assignee_id.slice(0, 12));

  const started = tasks.start(task.id, worker.id);
  sub('worker started:  state=' + started.state);

  const handedOff = tasks.handoff(task.id, reviewer.id, worker.id,
    'needs code review before merge');
  sub('handoff #' + handedOff.handoff_count + ': worker → reviewer  state='
      + handedOff.state);

  const events = tasks.events(task.id);
  sub('event log:  ' + events.map((e) => e.kind).join(' → '));

  // --------------------------------------------------------------
  banner(6, 'M6 · escalate a blocked tool request');

  const escalation = supervisor.escalate({
    escalatorId: reviewer.id,
    kind: 'tool_request',
    summary: 'reviewer needs connector:github to inspect the PR',
    toolQuery: { kind: 'connector', toolId: 'conn_github_demo', operation: 'pr:read' },
    detail: { context: 'reproduced by M5 check returning no_binding' },
  });
  sub('escalation:    ' + escalation.id.slice(0, 12)
      + '  ' + escalation.escalator_id.slice(0, 12)
      + ' → ' + escalation.reviewer_id.slice(0, 12));

  const pendingForPlanner = supervisor.pending(planner.id);
  sub('planner inbox:  ' + pendingForPlanner.length + ' pending escalation(s)');

  // Planner forwards up rather than deciding alone
  const fwd = supervisor.forward(escalation.id, planner.id,
    'grant access is a team-wide decision');
  sub('planner forwarded to: ' + fwd.child.reviewer_id.slice(0, 12));
  sub('original state:       ' + fwd.closed.state);
  sub('child state:          ' + fwd.child.state);

  const leadInbox = supervisor.pending(top.id);
  sub('lead inbox:           ' + leadInbox.length + ' pending');

  // Lead approves, then we grant the tool binding
  const approved = supervisor.approve(fwd.child.id, top.id, 'approved for read-only');
  sub('lead decision:        ' + approved.state);

  tools.bind(reviewer.id, {
    kind: 'connector', toolId: 'conn_github_demo',
    operations: ['pr:read'],
    createdBy: OPERATOR,
  });
  const recheck = tools.check(reviewer.id, {
    kind: 'connector', toolId: 'conn_github_demo', operation: 'pr:read',
  });
  sub('reviewer recheck:     ' + recheck.reason + '  (allowed=' + recheck.allowed + ')');

  // --------------------------------------------------------------
  banner(7, 'final state');

  const taskState = tasks.get(task.id);
  sub('task:        ' + taskState.state + '  handoffs=' + taskState.handoff_count);

  const reviewTask = tasks.complete(task.id, { reviewed: true, note: 'lgtm' }, reviewer.id);
  sub('reviewer completes:  ' + reviewTask.state);

  // Worker memory accumulates a final decision
  memory.remember(worker.id, {
    kind: 'decision',
    content: { outcome: 'merged after review' },
    tags: ['github'],
    scope: 'supervisor-visible',
  });

  const wTok = budgets.effectiveLimit(worker.id, 'tokens');
  sub('worker tokens remaining: ' + wTok.remaining);

  const counts = tasks.countsByState(planner.id);
  sub('planner task counts:  ' + JSON.stringify(counts));

  const escCounts = supervisor.countsByState(worker.id);
  sub('worker escalations:   raised=' + JSON.stringify(escCounts.raised)
      + '  pending_review=' + escCounts.pending_review);

  sub('registry health:      ' + JSON.stringify(registry.health()));
  sub('tool bindings active: ' + tools.list(worker.id).length
      + ' (worker) / ' + tools.list(reviewer.id).length + ' (reviewer)');

  // --------------------------------------------------------------
  banner(8, 'workbench visibility');

  const { Workbench } = require('../lib/workbench');
  const wbSnap = new Workbench(store).snapshot();
  const agents = wbSnap.agents || {};
  sub('agents.registry.total:       ' + (agents.registry || {}).total);
  sub('agents.registry.by_role:      ' + JSON.stringify((agents.registry || {}).by_role));
  sub('agents.tasks.by_state:        ' + JSON.stringify((agents.tasks || {}).by_state));
  sub('agents.escalations.pending:   ' + (agents.escalations || {}).pending_total);
  sub('agents.memory.recent:         ' + ((agents.memory || {}).recent || []).length);

  console.log('');
  console.log('Open http://127.0.0.1:7777/workbench.html');
  console.log('The Agents — active work panel will show the same state.');

  db.close();

  banner(9, 'done');
}

function pickUsage(budgets, agentId, kind) {
  const u = budgets.usageChain(agentId).chain.find((c) => c.agent_id === agentId);
  if (!u) return '0';
  for (const bid of Object.keys(u.budgets)) {
    const k = u.budgets[bid].kinds[kind];
    if (k) return k.used + ' / ' + k.limit;
  }
  return 'no budget';
}

if (require.main === module) {
  main().catch((e) => {
    console.error('demo failed:', e);
    process.exit(1);
  });
}

module.exports = { main };
