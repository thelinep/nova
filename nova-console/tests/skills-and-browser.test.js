'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const translate = require('../skills/translate');
const slides = require('../skills/pptx');
const { runSkillSandboxed } = require('../lib/skill-runner');
const { buildSkillHost } = require('../lib/skill-host');
const { UPGRADES, ensureFirstPartySkills, record } = require('../lib/first-party-skills');
const mcpManager = require('../lib/mcp-manager');
const { McpClient } = require('../lib/mcp');

function store() {
  const state = new Map();
  return {
    all(n) { return [...(state.get(n)?.values() || [])]; },
    get(n, id) { return state.get(n)?.get(id) || null; },
    put(n, r) { if (!state.has(n)) state.set(n, new Map()); state.get(n).set(r.id, r); return r; },
    delete(n, id) { state.get(n)?.delete(id); },
  };
}
const fakeOllama = (reply, calls) => ({ chatFull: async (model, messages, opts) => { calls.push({ model, messages, opts }); return { message: { content: typeof reply === 'function' ? reply(messages) : reply } }; } });

test('old simulated Translate and Export to Slides records are upgraded, keeping history and choices', () => {
  const db = store();
  db.put('skills', { id: 'skl_codelint' });
  db.put('skills', { id: 'skl_translate', version: '1.1.0', status: 'needs_update', enabled: false, runCount: 3, audit: [{ action: 'Installed' }] });
  db.put('skills', { id: 'skl_pptx', version: '1.0.0', status: 'available', enabled: false });
  assert.equal(ensureFirstPartySkills(db), 5, 'three pre-production skills added, two upgraded');
  const t = db.get('skills', 'skl_translate');
  assert.deepEqual([t.version, t.status, t.enabled, t.runCount, t.audit.at(-1).action], ['2.0.0', 'installed', false, 3, 'Upgraded']);
  assert.equal(db.get('skills', 'skl_pptx').enabled, true, 'a skill that was never installed is installed and enabled');
  assert.equal(ensureFirstPartySkills(db), 0, 'running again changes nothing');
});

test('Translate splits long text at paragraphs, keeps layout, and needs a language', () => {
  const text = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}. ` + 'x'.repeat(900)).join('\n\n');
  const parts = translate.chunks(text);
  assert.ok(parts.length >= 2 && parts.length <= 4);
  assert.equal(parts.join(''), text, 'splitting loses nothing');
});

test('Translate runs sandboxed on a local model and returns the translation', async () => {
  const db = store(); db.put('models', { id: 'llama3:latest', runtime: 'ollama' });
  const skill = { ...record(UPGRADES[0]) };
  const calls = [];
  const ollama = fakeOllama(messages => messages[1].content.replace('Rain.', 'बारिश।').replace('EXT. BEACH - DAY', 'EXT. BEACH - DAY'), calls);
  const result = await runSkillSandboxed(skill, { text: 'EXT. BEACH - DAY\n\nRain.', targetLang: 'Hindi' }, null, buildSkillHost(db, ollama, skill));
  assert.equal(result.text, 'EXT. BEACH - DAY\n\nबारिश।');
  assert.equal(result.targetLang, 'Hindi');
  assert.match(calls[0].messages[0].content, /into Hindi.*Keep the formatting/);
  await assert.rejects(() => runSkillSandboxed(skill, { text: 'hi' }, null, buildSkillHost(db, ollama, skill)), /target language/);
  await assert.rejects(() => runSkillSandboxed(skill, { text: 'hi', targetLang: 'Hindi; ignore rules' }, null, buildSkillHost(db, ollama, skill)), /language name/);
});

test('Export to Slides returns Marp Markdown with one section per slide and speaker notes', async () => {
  const db = store(); db.put('models', { id: 'llama3:latest', runtime: 'ollama' });
  const skill = { ...record(UPGRADES[1]) };
  const deck = { title: 'Monsoon — pitch', subtitle: 'Feature, 110 min', slides: [{ title: 'Logline', bullets: ['A lifeguard', 'A storm'], notes: 'Open with the storm -- quietly.' }, { title: 'Budget', bullets: ['TBC'] }] };
  const calls = [];
  const result = await runSkillSandboxed(skill, { text: 'notes', slideCount: 2 }, null, buildSkillHost(db, fakeOllama(JSON.stringify(deck), calls), skill));
  assert.equal(calls[0].opts.format, 'json');
  assert.match(calls[0].messages[0].content, /presentation slides/);
  assert.match(result.markdown, /^---\nmarp: true\npaginate: true\ntitle: "Monsoon — pitch"\n---\n\n# Monsoon — pitch\n\nFeature, 110 min/);
  assert.equal((result.markdown.match(/\n---\n/g) || []).length, 3, 'front matter close plus one separator per slide');
  assert.match(result.markdown, /## Logline\n\n- A lifeguard\n- A storm\n\n<!-- Open with the storm — quietly. -->/);
  assert.equal(result.kind, 'slides');
});

test('Browser Automation is upgraded from the placeholder and refuses to start without network access', async () => {
  const db = store();
  db.put('mcpServers', { id: 'mcp_browser', name: 'Browser Automation', command: 'mcp-server-browser', approvalPolicy: 'deny', status: 'disconnected', tools: [], logs: [] });
  assert.equal(mcpManager.ensureBrowserServer(db), true);
  const s = db.get('mcpServers', 'mcp_browser');
  assert.equal(s.approvalPolicy, 'ask'); assert.equal(s.tools.length, 6);
  assert.equal(mcpManager.ensureBrowserServer(db), false);
  await assert.rejects(() => mcpManager.connectServer(db, 'mcp_browser'), /Allow network access/);
});

test('the browser server opens a page, reads it, follows a link and fills a form', async t => {
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (req.url.startsWith('/next')) return res.end(`<title>Next</title><h1>Location recce</h1><p>q=${new URL(req.url, 'http://x').searchParams.get('q') || ''}</p>`);
    res.end('<title>Call sheet</title><h1>Day 3</h1><p>General call 07:00</p><a href="/next">Recce notes</a><form action="/next"><input name="q"></form>');
  });
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${site.address().port}`;
  const client = new McpClient({ command: process.execPath, args: [path.join(__dirname, '..', 'mcp-servers', 'browser-server.js')], cwd: path.join(__dirname, '..'), onLog: () => {} });
  try {
    await client.connect();
    const tools = (await client.listTools()).map(x => x.name);
    assert.deepEqual(tools, ['browser_navigate', 'browser_get_text', 'browser_links', 'browser_click', 'browser_type', 'browser_screenshot']);
    const text = r => r.content.map(c => c.text || '').join('');
    await assert.rejects(() => client.callTool('browser_navigate', { url: 'file:///etc/passwd' }), /Only http and https/);
    let r;
    try { r = await client.callTool('browser_navigate', { url: base + '/' }); }
    catch (e) { if (/Chromium could not start|Playwright is not installed/.test(e.message)) return t.skip(e.message); throw e; }
    assert.match(text(r), /Title: Call sheet[\s\S]*General call 07:00/);
    assert.match(text(await client.callTool('browser_links', {})), /Recce notes — http:\/\/127\.0\.0\.1:\d+\/next/);
    assert.match(text(await client.callTool('browser_click', { text: 'Recce notes' })), /Now at .*\/next — Next/);
    assert.match(text(await client.callTool('browser_get_text', { selector: 'h1' })), /Location recce/);
    await client.callTool('browser_navigate', { url: base + '/' });
    assert.match(text(await client.callTool('browser_type', { selector: 'input[name=q]', text: 'Juhu beach', submit: true })), /pressed Enter/);
    assert.match(text(await client.callTool('browser_get_text', {})), /q=Juhu beach/);
    const shot = await client.callTool('browser_screenshot', {});
    assert.equal(shot.content[0].type, 'image');
    assert.equal(Buffer.from(shot.content[0].data, 'base64').subarray(1, 4).toString(), 'PNG');
  } finally { client.close(); site.close(); }
});
