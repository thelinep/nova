'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const builder = require('../lib/agent-builder');
const { runAgentLoop, buildToolSpecs } = require('../lib/agent-loop');
const workflowEngine = require('../lib/workflow-engine');

// In-memory store with the same API as lib/db.js's Store. No real data, no real Ollama.
function store(){const s=new Map();return{all(n){return[...(s.get(n)?.values()||[])].map(r=>JSON.parse(JSON.stringify(r)));},get(n,id){const r=s.get(n)?.get(id);return r?JSON.parse(JSON.stringify(r)):null;},put(n,r){if(!s.has(n))s.set(n,new Map());s.get(n).set(r.id,JSON.parse(JSON.stringify(r)));return r;},delete(n,id){s.get(n)?.delete(id);}};}

function seeded() {
  const db = store();
  db.put('models', { id: 'qwen2.5:7b', name: 'Qwen 2.5', runtime: 'ollama' });
  db.put('models', { id: 'demo', name: 'Demo', runtime: 'demo' });
  db.put('skills', { id: 'skl_summarize', name: 'Session Summarizer', description: 'Summarizes text', enabled: true, status: 'installed', manifest: { inputs: ['text'] } });
  db.put('skills', { id: 'skl_translate', name: 'Translate', description: 'Translates text', enabled: true, status: 'installed', manifest: { inputs: ['text', 'targetLang'] } });
  db.put('skills', { id: 'skl_webfetch', name: 'Web Fetch', description: 'Fetches a URL', enabled: true, status: 'installed', manifest: { inputs: ['url'] } });
  db.put('skills', { id: 'skl_off', name: 'Disabled', description: 'x', enabled: false, status: 'installed' });
  db.put('mcpServers', { id: 'mcp_fs', name: 'Filesystem', status: 'connected', tools: [{ name: 'list_directory' }] });
  db.put('agents', { id: 'agt_research', name: 'Research Assistant', role: 'Research', status: 'idle', systemPrompt: 'You research things in the workspace.', modelId: 'qwen2.5:7b', skills: [], mcpServers: [] });
  return db;
}

// Fake Ollama: chatFull replies in order (strings or functions of messages); chat() is used by the agent loop.
function fakeOllama(replies, calls = []) {
  return {
    calls,
    async chatFull(model, messages, opts) { calls.push({ model, messages, opts }); const r = replies.shift(); return { message: { content: typeof r === 'function' ? r(messages) : r } }; },
    async chat(model, messages, tools) { calls.push({ model, messages, tools }); const r = replies.shift(); return typeof r === 'function' ? r(messages, tools) : r; },
  };
}

const goodAgent = {
  name: 'Hindi Release Notes', role: 'Docs',
  systemPrompt: 'You turn engineering notes into short release notes and translate them to Hindi. Never invent features.',
  skills: ['skl_summarize', 'skl_translate', 'skl_nope'], mcpServers: ['mcp_fs', 'mcp_ghost'], delegates: ['agt_research', 'agt_ghost'],
  memoryScope: 'session', testPrompts: ['Summarize: fixed login bug', 'Translate: Hello'], notes: 'Keep it short.',
};

test('draftAgent keeps only installed choices, saves a draft, and repairs a bad reply once', async () => {
  const db = seeded();
  const ollama = fakeOllama(['not json at all', JSON.stringify(goodAgent)]);
  const a = await builder.draftAgent(db, ollama, { goal: 'Write release notes in Hindi from engineering notes' });
  assert.equal(a.status, 'draft');
  assert.deepEqual(a.skills, ['skl_summarize', 'skl_translate']);
  assert.deepEqual(a.mcpServers, ['mcp_fs']);
  assert.deepEqual(a.delegates, ['agt_research']);
  assert.equal(a.modelId, 'qwen2.5:7b');
  assert.equal(a.draft.repaired, true);
  assert.match(a.draft.notes, /skl_nope/); assert.match(a.draft.notes, /mcp_ghost/); assert.match(a.draft.notes, /agt_ghost/);
  assert.equal(a.draft.testPrompts.length, 2);
  assert.equal(ollama.calls[0].opts.format, 'json');
  assert.match(ollama.calls[1].messages.at(-1).content, /rejected: the reply was not valid JSON/);
  assert.ok(db.get('agents', a.id));
  // The catalog the model saw had no disabled skills and only approved agents.
  const seen = ollama.calls[0].messages[1].content;
  assert.doesNotMatch(seen, /skl_off/);
  assert.match(seen, /agt_research/);
});

test('draftAgent refuses a non-local model and a vague goal; gives up after one failed repair', async () => {
  const db = seeded();
  await assert.rejects(() => builder.draftAgent(db, fakeOllama([]), { goal: 'x' }), /goal/);
  await assert.rejects(() => builder.draftAgent(db, fakeOllama([]), { goal: 'Summarize my notes each day', modelId: 'demo' }), /not a local Ollama model/);
  await assert.rejects(() => builder.draftAgent(db, fakeOllama(['{}', '{"name":"x"}']), { goal: 'Summarize my notes each day' }), /could not produce a usable draft.*systemPrompt/);
});

test('a draft agent can only be approved after a successful test, and cannot be delegated to', async () => {
  const db = seeded();
  const a = await builder.draftAgent(db, fakeOllama([JSON.stringify(goodAgent)]), { goal: 'Write release notes in Hindi' });
  assert.throws(() => builder.approveAgent(db, a.id), /test/);
  builder.recordTest(db, a.id, { ok: false, error: 'boom' });
  assert.throws(() => builder.approveAgent(db, a.id), /test/);

  // A draft is never offered as a hand-off target.
  const boss = { id: 'agt_boss', name: 'Boss', status: 'idle', modelId: 'qwen2.5:7b', delegates: [a.id, 'agt_research'] };
  db.put('agents', boss);
  const names = buildToolSpecs(db, boss).specs.map(s => s.function.name);
  assert.deepEqual(names, ['agent__agt_research']);

  builder.recordTest(db, a.id, { ok: true, instruction: 'Summarize: fixed login bug' });
  const approved = builder.approveAgent(db, a.id);
  assert.equal(approved.status, 'idle');
  assert.ok(approved.draft.approvedAt);
  assert.equal(buildToolSpecs(db, boss).specs.length, 2);
});

test('hand-off runs the delegate, logs it, and stops at the depth limit and at loops', async () => {
  const db = seeded();
  db.put('agents', { id: 'agt_a', name: 'A', status: 'idle', modelId: 'qwen2.5:7b', systemPrompt: 'a', delegates: ['agt_b'] });
  db.put('agents', { id: 'agt_b', name: 'B', status: 'idle', modelId: 'qwen2.5:7b', systemPrompt: 'b', delegates: ['agt_c', 'agt_a'] });
  db.put('agents', { id: 'agt_c', name: 'C', status: 'idle', modelId: 'qwen2.5:7b', systemPrompt: 'c', delegates: ['agt_a', 'agt_b'] });
  const toolsSeen = [];
  const ollama = fakeOllama([
    (m, tools) => { toolsSeen.push(tools.map(t => t.function.name)); return { content: '', tool_calls: [{ function: { name: 'agent__agt_b', arguments: { instruction: 'check the numbers' } } }] }; },
    (m, tools) => { toolsSeen.push(tools.map(t => t.function.name)); return { content: '', tool_calls: [{ function: { name: 'agent__agt_c', arguments: JSON.stringify({ instruction: 'double-check' }) } }] }; },
    (m, tools) => { toolsSeen.push(tools.map(t => t.function.name)); return { content: 'C: all good' }; },
    () => ({ content: 'B: C says all good' }),
    () => ({ content: 'A: done' }),
  ]);
  const result = await runAgentLoop(db, ollama, db.get('agents', 'agt_a'), 'Is the report right?');
  assert.equal(result.content, 'A: done');
  assert.deepEqual(toolsSeen[0], ['agent__agt_b']);
  assert.deepEqual(toolsSeen[1], ['agent__agt_c'], 'B cannot hand back to A (loop)');
  assert.deepEqual(toolsSeen[2], [], 'C is at the depth limit');
  assert.match(result.toolTrace[0].result, /B: C says all good/);
  assert.equal(db.get('agents', 'agt_b').handoffs[0].fromAgentId, 'agt_a');
  assert.equal(db.get('agents', 'agt_c').handoffs[0].reason, 'double-check');
});

test('an agent allowed to draft agents creates a draft, not a usable agent', async () => {
  const db = seeded();
  db.put('agents', { id: 'agt_lead', name: 'Lead', status: 'idle', modelId: 'qwen2.5:7b', systemPrompt: 'lead', canDraftAgents: true });
  const ollama = fakeOllama([
    () => ({ content: '', tool_calls: [{ function: { name: 'nova__draft_agent', arguments: { goal: 'Translate call sheets to Hindi' } } }] }),
    JSON.stringify({ ...goodAgent, name: 'Call Sheet Translator' }),
    () => ({ content: 'Drafted it; waiting for approval.' }),
  ]);
  const r = await runAgentLoop(db, ollama, db.get('agents', 'agt_lead'), 'We need Hindi call sheets');
  assert.match(r.toolTrace[0].result, /draftAgentId/);
  const drafts = db.all('agents').filter(a => a.status === 'draft');
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].name, 'Call Sheet Translator');
  assert.equal(drafts[0].draft.createdBy, 'agent:agt_lead');
  // A draft agent itself never gets the drafting tool.
  assert.deepEqual(buildToolSpecs(db, { ...drafts[0], canDraftAgents: true }).specs.map(s => s.function.name).filter(n => n.startsWith('nova__')), []);
});

test('draftWorkflow links existing pieces, drafts missing agents, and gates approval on them', async () => {
  const db = seeded();
  const wfReply = { name: 'Hindi digest', description: 'Digest in Hindi', notes: '', steps: [
    { type: 'agent', ref: 'agt_research', label: 'Gather notes' },
    { type: 'skill', ref: 'skl_summarize', label: 'Summarize' },
    { type: 'new_agent', goal: 'Check the summary for jargon and simplify it', label: 'Simplify' },
    { type: 'skill', ref: 'skl_webfetch', label: 'Fetch' },
    { type: 'approval', label: 'Editor sign-off' },
    { type: 'skill', ref: 'skl_translate', label: 'Translate to Hindi' },
  ] };
  const ollama = fakeOllama([JSON.stringify(wfReply), JSON.stringify({ ...goodAgent, name: 'Jargon Buster', skills: [], mcpServers: [], delegates: [] })]);
  const { workflow, agents } = await builder.draftWorkflow(db, ollama, { goal: 'Weekly digest of workspace notes in Hindi' });
  assert.equal(workflow.status, 'draft');
  assert.deepEqual(workflow.nodes.map(n => n.type), ['agent', 'skill', 'agent', 'approval', 'skill']);
  assert.equal(workflow.nodes[4].targetLang, 'Hindi');
  assert.deepEqual(workflow.nodes.map(n => n.next[0] || null), ['n2', 'n3', 'n4', 'n5', null]);
  assert.match(workflow.draft.notes, /skl_webfetch/, 'placeholder skills are not workflow steps');
  assert.equal(agents.length, 1); assert.equal(agents[0].status, 'draft'); assert.equal(agents[0].draft.workflowId, workflow.id);
  assert.throws(() => builder.approveWorkflow(db, workflow.id), /Jargon Buster/);

  // The draft agent cannot run inside an approved workflow.
  db.put('workflows', { id: 'wf_live', name: 'Live', status: 'active', nodes: [{ id: 'n1', type: 'agent', ref: agents[0].id, label: 'Simplify', next: [] }] });
  const run = workflowEngine.startRun(db, 'wf_live');
  const failed = await workflowEngine.advanceRun(db, fakeOllama([{ content: 'should not run' }]), run.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /still a draft/);
  db.delete('workflows', 'wf_live');

  builder.recordTest(db, agents[0].id, { ok: true });
  builder.approveAgent(db, agents[0].id);
  assert.equal(builder.approveWorkflow(db, workflow.id).status, 'active');
});

test('a draft workflow test run counts as a test of its draft agents; discard removes only drafts', async () => {
  const db = seeded();
  const wfReply = { name: 'Simplify', steps: [{ type: 'new_agent', goal: 'Rewrite text in plain words', label: 'Rewrite' }] };
  const { workflow, agents } = await builder.draftWorkflow(db, fakeOllama([JSON.stringify(wfReply), JSON.stringify({ ...goodAgent, skills: [], mcpServers: [], delegates: [] })]), { goal: 'Rewrite notes in plain words' });
  const run = workflowEngine.startRun(db, workflow.id);
  const out = await workflowEngine.advanceRun(db, fakeOllama([{ content: 'Plain words.' }]), run.id);
  assert.equal(out.status, 'completed');
  const tested = db.get('agents', agents[0].id);
  assert.equal(tested.draft.tests[0].ok, true);
  assert.match(tested.draft.tests[0].via, /Simplify/);

  assert.throws(() => builder.discardAgent(db, agents[0].id), /used by/);
  const r = builder.discardWorkflow(db, workflow.id);
  assert.deepEqual(r.removedAgents, [agents[0].id]);
  assert.equal(db.get('agents', agents[0].id), null);
  assert.ok(db.get('agents', 'agt_research'), 'approved agents are kept');
});

test('builder routes over HTTP: draft, test run, approve (temp data dir and a stub Ollama only)', { timeout: 30000 }, async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
  const { spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-builder-'));
  const reply = JSON.stringify({ name: 'Notes Helper', role: 'Docs', systemPrompt: 'You tidy up notes into short bullet points. Never invent facts.', skills: [], mcpServers: [], delegates: [], testPrompts: ['Tidy: a b c'] });
  const upstream = http.createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/chat') { const b = JSON.parse(body); res.end(JSON.stringify({ message: { role: 'assistant', content: b.format === 'json' ? reply : '- a\n- b\n- c' } })); }
      else res.end(JSON.stringify({ models: [] }));
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0', DATA_DIR: dir, OLLAMA_HOST: 'http://127.0.0.1:' + upstream.address().port, NOVA_LIBRARY_DIR: path.join(dir, 'library') }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const base = await new Promise((resolve, reject) => {
      let out = ''; const t = setTimeout(() => reject(new Error('startup: ' + out)), 10000);
      child.stdout.on('data', d => { out += d; const m = out.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
      child.stderr.on('data', d => { out += d; });
    });
    const call = async (method, p, body) => {
      const r = await fetch(base + p, { method, headers: { Origin: base, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    assert.equal((await call('PUT', '/api/store/models', { id: 'qwen2.5:7b', name: 'Qwen', runtime: 'ollama' })).status, 200);
    const cat = await call('GET', '/api/builder/catalog');
    assert.equal(cat.status, 200); assert.ok(cat.body.models.some(m => m.id === 'qwen2.5:7b'));
    const d = await call('POST', '/api/builder/agents', { goal: 'Tidy my meeting notes into bullet points' });
    assert.equal(d.status, 201, JSON.stringify(d.body)); assert.equal(d.body.status, 'draft');
    const id = d.body.id;
    assert.equal((await call('POST', '/api/agents/' + id + '/approve')).status, 409);
    const run = await call('POST', '/api/agents/' + id + '/run', { instruction: 'Tidy: a b c' });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.agent.status, 'draft');
    assert.equal(run.body.agent.draft.tests[0].ok, true);
    const ok = await call('POST', '/api/agents/' + id + '/approve');
    assert.equal(ok.status, 200); assert.equal(ok.body.status, 'idle');
    assert.equal((await call('POST', '/api/agents/' + id + '/discard')).status, 409, 'approved agents are not discarded here');
  } finally {
    child.kill('SIGTERM');
    upstream.closeAllConnections(); await new Promise(r => upstream.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
