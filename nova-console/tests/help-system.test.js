'use strict';
/* Help Center: the Markdown builder, the shipped help content, and the support report. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const help = require('../scripts/build-help');
const support = require('../lib/support-report');
const { openDb, Store, STORE_NAMES } = require('../lib/db');

const ctx = {
  media: src => '/m/' + src.replace(/^media\//, ''),
  hasMedia: src => src !== 'media/missing.jpg',
  helpLink: (id, anchor, label) => `<a data-id="${id}" data-anchor="${anchor || ''}">${label}</a>`,
};

test('renderMarkdown: headings with ids, lists, tables, code, links, media and escaping', () => {
  const md = [
    '## First part', 'Some **bold** and `code <b>` text.', '',
    '1. one', '2. two', '',
    '| A | B |', '| --- | --- |', '| x | y |', '',
    '```', 'npm start <now>', '```', '',
    'See [Agents](help:agents#test-and-approve) and [site](https://example.com).', '',
    '@screen media/shot.jpg "A shot"', '@screen media/missing.jpg "Gone"', '@video media/clip.mp4 "A clip"',
    '> **Important** Keep backups private.',
  ].join('\n');
  const { html, headings } = help.renderMarkdown(md, ctx);
  assert.deepEqual(headings.filter(h => h.level === 2).map(h => h.id), ['first-part']);
  assert.match(html, /<h2 id="first-part">First part<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code &lt;b&gt;<\/code>/);
  assert.match(html, /<ol>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ol>/);
  assert.match(html, /<table>[\s\S]*<th>A<\/th>[\s\S]*<td>y<\/td>/);
  assert.match(html, /npm start &lt;now&gt;/);
  assert.match(html, /<a data-id="agents" data-anchor="test-and-approve">Agents<\/a>/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /<img[^>]+src="\/m\/shot.jpg"[^>]+alt="A shot"/);
  assert.doesNotMatch(html, /missing\.jpg/, 'media that has not been captured is left out');
  assert.match(html, /<video[^>]+src="\/m\/clip.mp4"/);
  assert.match(html, /class="help-callout warn"/);
});

test('qaEntries groups questions under their ## heading', () => {
  const list = help.qaEntries('## Group A\n### Question one?\nAnswer.\n### Question two?\nMore.\n## Group B\n### Three?\nYes.', ctx);
  assert.deepEqual(list.map(e => [e.group, e.q, e.id]), [['Group A', 'Question one?', 'question-one'], ['Group A', 'Question two?', 'question-two'], ['Group B', 'Three?', 'three']]);
  assert.match(list[0].html, /Answer\./);
});

test('shipped help: valid articles, every screen has a guide, and help.json is up to date', () => {
  const data = help.load(help.JSON_TARGET);
  const ids = data.articles.map(a => a.id);
  assert.equal(new Set(ids).size, ids.length, 'article ids are unique');
  for (const a of data.articles) {
    assert.ok(help.SECTIONS.includes(a.section), a.id + ' has a known section');
    assert.ok(a.summary.length > 20, a.id + ' has a summary');
  }
  assert.ok(ids.includes('support'));
  assert.ok(data.faq.length >= 20 && data.troubleshooting.length >= 15);

  const views = new Set(data.articles.flatMap(a => a.views));
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const navViews = [...new Set([...html.matchAll(/class="nav-item"[^>]*data-view="([a-z]+)"/g)].map(m => m[1]))];
  const uncovered = navViews.filter(v => v !== 'console' && !views.has(v));
  assert.deepEqual(uncovered, [], 'every screen in the rail has a guide');

  const built = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'help', 'help.json'), 'utf8'));
  assert.deepEqual(built.articles.map(a => a.id), ids, 'public/help/help.json is stale: run npm run help:build');
  assert.deepEqual(built.faq.map(f => f.id), data.faq.map(f => f.id), 'FAQ in help.json is stale: run npm run help:build');
  for (const a of built.articles) {
    const src = data.articles.find(x => x.id === a.id);
    assert.equal(a.text, src.text, `${a.id} in help.json is stale: run npm run help:build`);
  }
});

test('support report: counts, checks and failures, with private details masked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-support-'));
  try {
    const { db } = openDb(dir);
    const store = new Store(db);
    const home = os.homedir();
    store.put('sessions', { id: 's1', title: 'Private chat about salaries', messages: [{ role: 'user', content: 'secret plans' }] });
    store.put('mcpServers', { id: 'mcp_fs', name: 'Filesystem', status: 'connected' });
    store.put('executions', { id: 'e1', type: 'agent', label: 'Research run', status: 'failed', detail: `Could not read ${home}/Documents/plan.txt (token=abcdef123456789)`, startedAt: '2026-09-01T10:00:00Z', finishedAt: '2026-09-01T10:00:05Z' });
    store.put('executions', { id: 'e2', type: 'skill', label: 'Fine', status: 'success', startedAt: '2026-09-01T11:00:00Z' });
    fs.writeFileSync(path.join(dir, support.LOG_NAME), `start\n[nova] listening\nerror in ${home}/x Bearer sk-abcdefghijklmnop\n`);

    const deps = {
      store, storeNames: STORE_NAMES, dataDir: dir, version: '9.9.9',
      ollamaStatus: () => ({ reachable: true, models: [{ name: 'llama3.2:latest' }] }),
      imageStatus: async () => ({ reachable: false, error: 'connect refused' }),
      audioStatus: () => new Promise(() => {}), // never answers: must time out, not hang
      transcribeStatus: () => ({ ready: false, missing: ['ffmpeg (brew install ffmpeg)'] }),
      libraryInfo: () => ({ dir: path.join(home, 'Documents', 'NOVA Library'), enabled: true }),
    };
    // ComfyUI is not installed for this check, whatever is on this computer
    // (on a Mac with ~/ComfyUI, NOVA would rightly report that it can start it).
    const comfy = require('../lib/comfy-manager');
    const prevDir = process.env.COMFY_DIR; process.env.COMFY_DIR = path.join(dir, 'no-comfyui');
    comfy.configure({ store, dataDir: dir, platform: 'linux' });
    const r = await support.buildReport(deps).finally(() => { if (prevDir === undefined) delete process.env.COMFY_DIR; else process.env.COMFY_DIR = prevDir; });
    assert.equal(r.nova.version, '9.9.9');
    assert.equal(r.data.counts.sessions, 1);
    assert.equal(r.data.counts.executions, 2);
    assert.equal(r.data.libraryDir, '~/Documents/NOVA Library');
    assert.deepEqual(r.engines.ollama.models, ['llama3.2:latest']);
    assert.equal(r.checks.find(c => c.id === 'ollama').ok, true);
    assert.equal(r.checks.find(c => c.id === 'comfy').ok, false);
    assert.match(r.checks.find(c => c.id === 'comfy').detail, /Not installed/);
    assert.equal(r.checks.find(c => c.id === 'tools').ok, true);
    assert.match(r.checks.find(c => c.id === 'voice').detail, /no answer/);
    assert.equal(r.recentFailures.length, 1);
    assert.match(r.recentFailures[0].error, /~\/Documents\/plan\.txt/);
    assert.doesNotMatch(r.recentFailures[0].error, /abcdef123456789/);
    assert.equal(r.logTail, null, 'the log is only included when asked for');
    const all = JSON.stringify(r);
    assert.doesNotMatch(all, /salaries|secret plans/, 'no chat content');
    if (home.length > 1) assert.ok(!all.includes(home + '/'), 'home folder is shown as ~');
    assert.match(r.text, /\[ok\]\s+Ollama/);

    const withLog = await support.buildReport(deps, { includeLog: true });
    assert.match(withLog.logTail, /listening/);
    assert.doesNotMatch(withLog.logTail, /sk-abcdefghijklmnop/);

    const file = support.saveReport(withLog, dir);
    assert.ok(file.startsWith(path.join(dir, 'support')));
    assert.match(fs.readFileSync(file, 'utf8'), /Maataa support report/);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('server: support report routes and help content are served', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-support-srv-'));
  const child = spawn(process.execPath, ['--no-warnings', '-e', "const {server}=require('./server'); server.on('listening',()=>console.log('READY '+server.address().port));"], {
    cwd: ROOT, env: { ...process.env, PORT: '0', DATA_DIR: dir, OLLAMA_HOST: 'http://127.0.0.1:9', COMFYUI_URL: 'http://127.0.0.1:9', NOVA_LIBRARY_DIR: path.join(dir, 'library') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = ''; const t = setTimeout(() => reject(new Error('no start: ' + out)), 15000);
      child.stdout.on('data', d => { out += d; const m = /READY (\d+)/.exec(out); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
      child.stderr.on('data', d => { out += d; });
    });
    const base = `http://127.0.0.1:${port}`;
    const report = await (await fetch(base + '/api/support/report')).json();
    assert.equal(report.checks[0].id, 'backend');
    assert.equal(report.logTail, null);
    assert.equal(typeof report.text, 'string');

    const refused = await fetch(base + '/api/support/report/save', { method: 'POST', headers: { Origin: 'http://evil.example' } });
    assert.equal(refused.status, 403);
    const saved = await (await fetch(base + '/api/support/report/save', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{"includeLog":true}' })).json();
    assert.equal(saved.ok, true);
    assert.equal(fs.readdirSync(path.join(dir, 'library', 'support')).length, 1);

    const json = await fetch(base + '/help/help.json');
    assert.equal(json.status, 200);
    assert.match(json.headers.get('content-type'), /application\/json/);
    const media = fs.readdirSync(path.join(ROOT, 'public', 'help', 'media')).find(f => f.endsWith('.mp4'));
    if (media) {
      const part = await fetch(`${base}/help/media/${media}`, { headers: { Range: 'bytes=0-99' } });
      assert.equal(part.status, 206);
      assert.equal(part.headers.get('content-type'), 'video/mp4');
      assert.equal((await part.arrayBuffer()).byteLength, 100);
    }
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
