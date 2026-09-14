'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, Store } = require('../lib/db');
const { ingestDocument, searchKnowledge } = require('../lib/knowledge');
const mcp = require('../lib/mcp-manager');
const { runSkillSandboxed } = require('../lib/skill-runner');
const { runAgentLoop } = require('../lib/agent-loop');
const workflow = require('../lib/workflow-engine');
const scheduler = require('../lib/scheduler');

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-phase6-'));
  const { db } = openDb(dir);
  return { dir, store: new Store(db), close() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const embeddings = { async embed(_model, input) {
  const texts = Array.isArray(input) ? input : [input];
  return texts.map(text => [text.toLowerCase().includes('alpha') ? 1 : 0, text.toLowerCase().includes('beta') ? 1 : 0, 1]);
} };

test('knowledge ingestion writes embeddings and returns ranked local results', async () => {
  const ws = workspace();
  try {
    ws.store.put('knowledgeCollections', { id: 'kc', name: 'Integration docs', embeddingModel: 'test-embed', docCount: 0, chunkCount: 0 });
    const ingested = await ingestDocument(ws.store, embeddings, { collectionId: 'kc', name: 'alpha.md', text: '# Alpha\nAlpha is the local retrieval subject.', embeddingModel: 'test-embed' });
    assert.equal(ingested.document.status, 'embedded');
    assert.equal(ws.store.get('knowledgeCollections', 'kc').docCount, 1);
    const found = await searchKnowledge(ws.store, embeddings, { collectionId: 'kc', query: 'alpha', topK: 3, rerank: true });
    assert.equal(found.usedRealEmbeddings, true);
    assert.match(found.results[0].text, /Alpha/);
  } finally { ws.close(); }
});

test('MCP approval gates a real filesystem call and sandboxed skill uses the connected server', async () => {
  const ws = workspace();
  try {
    ws.store.put('mcpServers', { id: 'mcp_fs', name: 'Filesystem', status: 'disconnected', approvalPolicy: 'ask', logs: [] });
    await mcp.connectServer(ws.store, 'mcp_fs');
    const pending = await mcp.gatedCall(ws.store, 'mcp_fs', 'list_directory', { path: '.' }, { origin: 'manual' });
    assert.equal(pending.pending, true);
    assert.equal(mcp.listPendingApprovals().length, 1);
    const approved = await mcp.resolveApproval(ws.store, pending.approvalId, 'approve');
    assert.equal(approved.status, 'ok');

    const server = ws.store.get('mcpServers', 'mcp_fs');
    server.approvalPolicy = 'auto'; ws.store.put('mcpServers', server);
    const skill = { id: 'skl_codelint', name: 'Code Lint', manifest: { entrypoint: 'codelint.run(paths)', inputs: ['paths'], outputs: ['findings'], requiredTools: ['read_file', 'list_directory'] } };
    const result = await runSkillSandboxed(skill, { paths: ['skills'] }, (toolName, args) => mcp.gatedCall(ws.store, 'mcp_fs', toolName, args, { origin: 'skill' }));
    assert.ok(result.filesScanned > 0);
    mcp.disconnectServer(ws.store, 'mcp_fs');
  } finally { mcp.shutdownAll(); ws.close(); }
});

test('agent completion and workflow approval transitions are persisted', async () => {
  const ws = workspace();
  try {
    ws.store.put('models', { id: 'local-model', runtime: 'ollama' });
    const agent = { id: 'agent', name: 'Integration agent', modelId: 'local-model', systemPrompt: 'Be brief.', skills: [], mcpServers: [] };
    ws.store.put('agents', agent);
    const result = await runAgentLoop(ws.store, { async chat() { return { content: 'local agent complete', tool_calls: [] }; } }, agent, 'finish');
    assert.equal(result.content, 'local agent complete');

    ws.store.put('workflows', { id: 'wf', name: 'Approval workflow', nodes: [{ id: 'review', type: 'approval', label: 'Review', next: [] }] });
    const run = workflow.startRun(ws.store, 'wf');
    const waiting = await workflow.advanceRun(ws.store, embeddings, run.id);
    assert.equal(waiting.status, 'awaiting_approval');
    const completed = workflow.resolveApprovalNode(ws.store, run.id, 'approve');
    assert.equal(completed.status, 'completed');
    assert.equal(ws.store.get('workflowRuns', run.id).status, 'completed');
  } finally { ws.close(); }
});

test('scheduler recovery reschedules overdue automation without replaying a missed run', () => {
  const ws = workspace();
  try {
    ws.store.put('automations', { id: 'auto', name: 'Recovered schedule', status: 'Enabled', modelId: 'local-model', collections: [], trigger: { type: 'schedule', schedule: { kind: 'interval', everyMinutes: 10 } }, nextRun: new Date(Date.now() - 60000).toISOString(), logs: [] });
    const state = scheduler.startScheduler(ws.store, embeddings, { tickMs: 60000 });
    const recovered = ws.store.get('automations', 'auto');
    assert.equal(state.lastCatchUp.rescheduled, 1);
    assert.ok(Date.parse(recovered.nextRun) > Date.now());
    assert.equal(ws.store.all('automationRuns').length, 0);
  } finally { ws.close(); }
});
