#!/usr/bin/env node
'use strict';
/* ===========================================================================
 * Help screenshots and videos
 *
 *   npm run help:capture        (then npm run help:build)
 *
 * Starts NOVA on a temporary data folder with a stand-in Ollama that answers
 * with fixed text, opens the console in Playwright's Chromium, and saves:
 *   public/help/media/<view>.jpg  one screenshot per screen
 *   public/help/media/<clip>.mp4  short silent clips (webm if ffmpeg is missing)
 * Your real data folder, models and library are never touched.
 *
 * Needs @playwright/test (npm i --no-save @playwright/test) and a Chromium that
 * Playwright can find. Set CAPTURE_ONLY=console,agents to redo some shots.
 * ========================================================================= */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'help', 'media');
const ONLY = (process.env.CAPTURE_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
const want = name => !ONLY.length || ONLY.includes(name);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let chromium;
if (require.main === module) try { ({ chromium } = require('@playwright/test')); }
catch (_) { try { ({ chromium } = require('playwright')); } catch (e) { console.error('Playwright is not installed. Run: npm i --no-save @playwright/test'); process.exit(1); } }

/* ---------------------------------------------------------- stand-in Ollama */
const MODELS = [
  { name: 'llama3.2:latest', model: 'llama3.2:latest', digest: '1'.repeat(64), size: 2019393189, details: { family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' } },
  { name: 'qwen2.5-coder:7b', model: 'qwen2.5-coder:7b', digest: '2'.repeat(64), size: 4683087332, details: { family: 'qwen2', parameter_size: '7.6B', quantization_level: 'Q4_K_M' } },
  { name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest', size: 274302450, details: { family: 'nomic-bert', parameter_size: '137M', quantization_level: 'F16' } },
];
const REPLY = 'Here is a short plan for the shoot:\n\n1. **Location** – Marine Drive at dusk, with the city lights starting to show.\n2. **Look** – warm, soft light and a slow push-in on the lead.\n3. **Sound** – waves, distant traffic and a single sustained piano note.\n\nWant me to turn this into a shot list?';
const DESIGN_HTML = '<!doctype html><html><head><style>body{margin:0;font:16px -apple-system,Helvetica,Arial,sans-serif;background:#0f1720;color:#f5f5f5}.hero{padding:48px 40px}.hero h1{font-size:34px;margin:0 0 10px}.hero p{color:#b6c2cf;margin:0 0 22px}.btn{display:inline-block;background:#f5a524;color:#111;padding:12px 20px;border-radius:8px;font-weight:600}.cards{display:flex;gap:16px;padding:0 40px}.card{flex:1;background:#18222e;border-radius:10px;padding:18px}</style></head><body><div class="hero"><h1>Marine Drive Nights</h1><p>A two-minute dusk film, shot on location.</p><span class="btn">Book a screening</span></div><div class="cards"><div class="card"><b>Friday</b><br>Call 6:00</div><div class="card"><b>Two actors</b><br>One drone shot</div><div class="card"><b>Budget</b><br>₹1,85,000</div></div></body></html>';
const REPLY_SOURCES = 'From **brief.md**: the dusk shoot on Marine Drive is on **Friday**, call time 6:00, with two actors and one drone shot.\n\nFrom **budget.csv**: the camera package (FX3 + lenses) is **₹42,000** of the ₹1,85,000 total.\n\nStill TBC: parking and the nearest hospital.';
const AGENT = { name: 'Shoot Planner', role: 'Pre-production', systemPrompt: 'You turn shoot notes into a shot list and a call sheet. Keep the director\'s wording, write TBC for anything the notes do not say (addresses, times, hospital), and list open questions at the end. Never invent facts.', skills: ['skl_shotlist', 'skl_callsheet'], mcpServers: [], delegates: [], memoryScope: 'session', testPrompts: ['Make a shot list from: dusk, Marine Drive, two actors, one drone shot.', 'What is still missing for the call sheet?'], notes: 'Uses the Shot List and Call Sheet skills.' };
const WORKFLOW = { name: 'Shoot notes in Hindi', description: 'Summarise the shoot notes, get a sign-off, then translate the summary to Hindi.', steps: [{ type: 'skill', ref: 'skl_summarize', label: 'Summarise the shoot notes' }, { type: 'approval', label: 'Sign-off before translating' }, { type: 'skill', ref: 'skl_translate', label: 'Translate to Hindi' }], notes: 'A sign-off comes before the translation is shared.' };
const usage = { total_duration: 1.4e9, load_duration: 1e8, prompt_eval_count: 42, prompt_eval_duration: 2e8, eval_count: 96, eval_duration: 1.1e9 };

function vector(text) { const v = new Array(64).fill(0); for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % 64] += 1; const n = Math.hypot(...v) || 1; return v.map(x => x / n); }

function startOllama() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      const json = body ? (() => { try { return JSON.parse(body); } catch (_) { return {}; } })() : {};
      const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      const url = req.url.split('?')[0];
      if (url === '/api/tags') return send({ models: MODELS });
      if (url === '/api/ps') return send({ models: [{ name: 'llama3.2:latest', size_vram: 2.4e9 }] });
      if (url === '/api/version') return send({ version: '0.12.0' });
      if (url === '/api/show') return send({ details: MODELS[0].details, model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072 }, capabilities: ['completion', 'tools'] });
      if (url === '/api/embed') return send({ embeddings: (json.input || []).map(vector) });
      if (url === '/api/embeddings') return send({ embedding: vector(json.prompt || '') });
      if (url === '/api/generate') return send({ model: json.model, response: json.prompt ? REPLY : '', done: true, ...usage });
      if (url === '/api/chat') {
        const system = (json.messages || []).filter(m => m.role === 'system').map(m => m.content).join('\n');
        if (json.stream) {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          const text = /Passages from those sources/.test(system) ? REPLY_SOURCES : REPLY;
          for (const piece of text.match(/\S+\s*/g)) { res.write(JSON.stringify({ model: json.model, message: { role: 'assistant', content: piece }, done: false }) + '\n'); await sleep(45); }
          res.end(JSON.stringify({ model: json.model, message: { role: 'assistant', content: '' }, done: true, ...usage }) + '\n');
          return;
        }
        await sleep(600);
        let content = REPLY;
        if (/helper built into Maataa Workstation/.test(system)) return send({ model: json.model, message: { role: 'assistant', content: 'Open Models, press Sync from Ollama, then press Qualify for coding on a model of 7B or more. It runs 18 short trials in a temporary folder, and you can follow them in Activity. Want me to show you?\n[tour:qualify-model]' }, done: true, ...usage });
        if (/self-contained HTML file/.test(system)) { await sleep(400); return send({ model: json.model, message: { role: 'assistant', content: '```html\n' + DESIGN_HTML + '\n```' }, done: true, ...usage }); }
        if (json.format === 'json' && /followups/.test(system)) return send({ model: json.model, message: { role: 'assistant', content: JSON.stringify({ followups: ['Make a call sheet for Friday', 'What is still TBC?', 'Translate the plan to Hindi'] }) }, done: true, ...usage });
        if (Array.isArray(json.tools) && json.tools.length) {
          const toolMsgs = (json.messages || []).filter(m => m.role === 'tool');
          if (!toolMsgs.length) return send({ model: json.model, message: { role: 'assistant', content: 'I will look at what is in your shoot folder first.', tool_calls: [{ function: { name: 'run_command', arguments: { command: 'ls -la' } } }] }, done: true, ...usage });
          const out = String(toolMsgs[toolMsgs.length - 1].content || '').split('\n').filter(l => /\.(md|csv|txt|fountain)$/.test(l)).map(l => '- ' + l.trim().split(/\s+/).pop()).join('\n');
          return send({ model: json.model, message: { role: 'assistant', content: 'Your shoot folder has:\n' + (out || '- (no notes found)') + '\n\nWant me to turn the brief into a call sheet?' }, done: true, ...usage });
        }
        if (json.format === 'json') content = JSON.stringify(/"steps"/.test(system) ? WORKFLOW : AGENT);
        else if (/translat/i.test(system)) content = '- मरीन ड्राइव पर शाम की शूटिंग अब शुक्रवार को है।\n- दो कलाकार और एक ड्रोन शॉट।\n- पार्किंग और नज़दीकी अस्पताल अभी तय नहीं (TBC)।';
        else if (/shot list/i.test(system)) content = '| # | Shot | Lens | Notes |\n| --- | --- | --- | --- |\n| 1 | Wide of Marine Drive at dusk | 24mm | City lights on |\n| 2 | Slow push-in on the lead | 50mm | Warm key |\n| 3 | Close-up, waves on the rocks | 85mm | Sound: waves |';
        else if (/summar/i.test(system)) content = '- The dusk shoot on Marine Drive moves to Friday.\n- Two actors and one drone shot.\n- Parking and the nearest hospital are still TBC.';
        return send({ model: json.model, message: { role: 'assistant', content }, done: true, ...usage });
      }
      res.writeHead(404); res.end('{}');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ---------------------------------------------------------------- NOVA */
// Example coding-check results (one model fully qualified, one partly) and one
// policy grant, so Models, Workbench and the setup checklist show their states.
function seedOversight(dataDir) {
  const { openDb, Store } = require('../lib/db');
  const q = require('../lib/model-qualifications');
  const { PolicyEngine } = require('../lib/policy');
  const { db } = openDb(dataDir); const store = new Store(db);
  const at = '2026-10-01T10:00:00.000Z';
  for (const cap of q.CAPABILITIES) for (let t = 1; t <= 3; t++) q.recordResult(store, { digest: '2'.repeat(64), model: 'qwen2.5-coder:7b', fixture: cap, trial: t, status: 'passed', completedAt: at, runId: 'docs-q-' + cap + t });
  for (const cap of q.CAPABILITIES) for (let t = 1; t <= 3; t++) q.recordResult(store, { digest: '1'.repeat(64), model: 'llama3.2:latest', fixture: cap, trial: t, status: ['multi-file', 'large-context'].includes(cap) && t === 2 ? 'failed' : 'passed', completedAt: at, runId: 'docs-l-' + cap + t });
  new PolicyEngine(store).grant({ subject: { type: 'agent', id: 'shoot-planner' }, resource: { type: 'skill', id: 'skl_shotlist' }, createdBy: 'docs' });
  db.close();
}

async function startNova(ollamaPort, dataDir) {
  const port = 8900 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, ['--no-warnings', 'server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, NOVA_LIBRARY_DIR: path.join(dataDir, 'library'), OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}` }, // no COMFYUI_URL: the Image engine shot lets NOVA start a stand-in ComfyUI
  });
  let log = '';
  child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) {
        const base = `http://127.0.0.1:${port}`;
        await sleep(600); // let the first Ollama check finish, then register the stand-in models
        await fetch(base + '/api/models/sync', { method: 'POST', headers: { Origin: base } }).catch(() => {});
        // Install the first-party skills the clips use.
        const skills = await fetch(`${base}/api/store/skills`).then(r => r.json()).catch(() => []);
        for (const rec of skills.filter(x => ['skl_shotlist', 'skl_callsheet', 'skl_translate', 'skl_treatment'].includes(x.id))) {
          if (rec) await fetch(`${base}/api/store/skills`, { method: 'PUT', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...rec, enabled: true, status: 'installed' }) }).catch(() => {});
        }
        return { child, base };
      }
    } catch (_) {}
    await sleep(250);
  }
  child.kill(); throw new Error('NOVA did not start:\n' + log);
}

/* ------------------------------------------------------------- capture */
// Icons come from a CDN. Serve a local copy when one is installed (npm i --no-save lucide@0.462.0), so captures work offline.
let LUCIDE = null;
try { LUCIDE = fs.readFileSync(require.resolve('lucide/dist/umd/lucide.min.js')); } catch (_) {}
async function newContext(browser, opts) {
  const ctx = await browser.newContext({ colorScheme: 'dark', deviceScaleFactor: 1, ...opts });
  if (LUCIDE) await ctx.route(/cdn\.jsdelivr\.net\/npm\/lucide/, route => route.fulfill({ status: 200, contentType: 'text/javascript', body: LUCIDE }));
  return ctx;
}
const park = page => page.mouse.move(2, 790);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-docs-'));
  seedOversight(dataDir);
  const ollama = await startOllama();
  const { child, base } = await startNova(ollama.address().port, dataDir);
  const browser = await chromium.launch();
  const saved = [];
  const videoDir = path.join(dataDir, 'video');
  try {
    const ctx = await newContext(browser, { viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(base + '/');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => typeof showView === 'function' && typeof ollamaStatus !== 'undefined' && ollamaStatus.reachable, null, { timeout: 15000 }).catch(() => {});
    await sleep(1500);
    const shot = async (name, fn, opts = {}) => {
      if (!want(name)) return;
      try {
        await page.evaluate(() => { const d = document.getElementById('helpDrawer'); if (d) d.remove(); });
        await fn();
        await park(page);
        await sleep(opts.wait || 700);
        const file = path.join(OUT, name + '.jpg');
        await page.screenshot({ path: file, type: 'jpeg', quality: 70 });
        saved.push(name + '.jpg');
      } catch (e) { console.warn(`  ! ${name}: ${e.message.split('\n')[0]}`); }
    };
    const view = v => () => page.evaluate(n => showView(n), v);

    // A short conversation first, so Console and Sessions have something real in them.
    await page.evaluate(() => showView('console'));
    await page.locator('#newSessionBtn').click();
    await page.locator('#composer').fill('Plan a two-minute dusk shoot on Marine Drive.');
    await page.locator('#sendBtn').click();
    await page.waitForTimeout(4500);

    await shot('console', view('console'));
    await shot('command', async () => { await page.evaluate(() => showView('console')); await page.keyboard.press('Control+k'); await page.locator('#cmdkInput').fill('go to'); }, { wait: 400 });
    await page.keyboard.press('Escape');
    for (const v of ['sessions', 'knowledge', 'retrieval', 'automations', 'evaluations', 'boards', 'timeline', 'skills', 'mcp', 'agents', 'workflows', 'collector', 'graph', 'browser', 'workspace', 'git', 'runtime', 'trace', 'history', 'diagnostics', 'settings']) await shot(v, view(v));
    await shot('models', async () => { await page.evaluate(() => showView('models')); await sleep(800); await page.locator('.model-qualify').first().scrollIntoViewIfNeeded(); await page.evaluate(() => { const c = [...document.querySelectorAll('.model-card')].find(x => /qwen2\.5-coder:7b/.test(x.textContent)); if (c) c.scrollIntoView({ block: 'center' }); }); }, { wait: 900 });
    await shot('neuron-factory', view('neurons'), { wait: 1200 });
    if (want('voice-studio')) {
      const H = { 'Content-Type': 'application/json', Origin: base };
      const c = await (await fetch(base + '/api/characters', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Meera', tagline: 'a calm first assistant director', delivery: { mood: 'warm', auto: true }, personality: 'Warm, organised and gently funny. Notices what is missing from a plan and says so kindly.', speakingStyle: 'Short sentences, film-set words, always ends with the next step.', language: 'English', voice: { engine: 'kokoro', mix: [{ voice: 'af_heart', weight: 0.7 }, { voice: 'hf_alpha', weight: 0.3 }], speed: 1.05, pitch: 1 } }) })).json();
      await fetch(base + '/api/characters', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Kabir', tagline: 'a dry-witted line producer', voice: { engine: 'kokoro', mix: [{ voice: 'bm_george', weight: 1 }] } }) });
      await shot('voice-studio', async () => { await page.evaluate(id => { vsSel = id; vsDraft = null; showView('voicestudio'); }, c.id); await sleep(1200); }, { wait: 600 });
    }
    if (want('comfy-settings')) {
      // A stand-in ComfyUI folder (a tiny Node server), so the panel shows NOVA starting it.
      const fake = path.join(dataDir, 'ComfyUI'); fs.mkdirSync(path.join(fake, '.venv', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(fake, 'main.py'), '# stand-in');
      fs.writeFileSync(path.join(fake, 'server.js'), "const port=+process.argv[process.argv.indexOf('--port')+1];require('http').createServer((q,r)=>r.end(JSON.stringify({system:{comfyui_version:'0.3'}}))).listen(port,'127.0.0.1',()=>console.log('Starting server\\nTo see the GUI go to: http://127.0.0.1:'+port));");
      fs.writeFileSync(path.join(fake, '.venv', 'bin', 'python'), `#!/bin/sh\nshift\nexec "${process.execPath}" "${path.join(fake, 'server.js')}" "$@"\n`, { mode: 0o755 });
      await fetch(base + '/api/comfy/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ dir: fake, idleMinutes: 20 }) });
      await shot('comfy-settings', async () => {
        await page.evaluate(() => showView('settings')); await sleep(800);
        await page.locator('#comfyPanel [data-comfy="start"]').click();
        await page.locator('#comfyState', { hasText: 'Running' }).waitFor({ timeout: 20000 });
        await page.locator('#comfyPanel').scrollIntoViewIfNeeded();
      }, { wait: 600 });
      await fetch(base + '/api/comfy/stop', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}' });
    }
    if (want('agent-browser')) {
      // A small local page stands in for a website, so the capture needs no internet.
      const site = http.createServer((q, r) => { r.setHeader('Content-Type', 'text/html; charset=utf-8'); r.end('<!doctype html><title>Marine Drive · call sheet</title><body style="margin:0;font:18px -apple-system,Helvetica,sans-serif;background:#f7f4ec;color:#1d1d1f"><div style="padding:28px 36px"><h1 style="margin:0 0 8px">Marine Drive shoot</h1><p style="margin:0 0 16px;color:#555">Friday · call 6:00 am · two actors · one drone shot</p><a id="more" href="#">Location details</a><img src="https://cdn.example.net/logo.png" alt=""></div></body>'); }).listen(0);
      try {
        await shot('agent-browser', async () => {
          await page.evaluate(() => showView('agentbrowser')); await sleep(900);
          await page.locator('#abDomain').fill('127.0.0.1'); await page.locator('#abAdd').click(); await sleep(500);
          await page.locator('#abUrl').fill(`http://127.0.0.1:${site.address().port}/`); await page.locator('#abOpen').click();
          await page.locator('#abTry img').waitFor({ timeout: 20000 }); await sleep(5500); // one refresh, so the log shows the blocked logo
        }, { wait: 600 });
      } finally { site.close(); }
    }
    await shot('media-image', () => page.locator('.nav-item[data-media-tab="image"]').click());
    await shot('media-video', () => page.locator('.nav-item[data-media-tab="video"]').click());
    await shot('media-audio', () => page.locator('.nav-item[data-media-tab="audio"]').click());
    await shot('media-library', () => page.locator('.nav-item[data-media-tab="library"]').click());
    await shot('media-transcribe', async () => { await page.locator('.nav-item[data-media-tab="audio"]').click(); await page.locator('#mediaView').getByText('Transcribe', { exact: true }).first().click({ timeout: 3000 }); });
    // Conversation: sources, live steps, computer approval, activity
    const shoot = path.join(dataDir, 'Marine Drive shoot');
    fs.mkdirSync(shoot, { recursive: true });
    fs.writeFileSync(path.join(shoot, 'brief.md'), '# Marine Drive dusk shoot\nFriday, unit call 6:00. Two actors, one drone shot.\nParking and nearest hospital: TBC.\n');
    fs.writeFileSync(path.join(shoot, 'budget.csv'), 'item,cost\nFX3 + lenses,42000\nDrone operator,38000\nTotal,185000\n');
    fs.writeFileSync(path.join(shoot, 'shot-ideas.txt'), 'Wide at dusk; slow push-in; waves on the rocks.\n');
    await shot('conversation-add', async () => { await page.evaluate(() => showView('console')); await page.locator('#newSessionBtn').click(); await page.locator('#addBtn').click(); await page.locator('#addMenu [data-add="folder"]').hover(); }, { wait: 400 });
    await page.keyboard.press('Escape');
    if (want('conversation') || want('computer-approval') || want('activity')) {
      try {
        await page.evaluate(() => { const s = activeSession(); s.title = 'Marine Drive shoot'; });
        await page.evaluate(p => addSource({ kind: 'folder', path: p }), shoot);
        await page.waitForSelector('.src-chip.src-ready', { timeout: 15000 });
        await page.locator('#composer').fill('What does the camera cost and when is the shoot?');
        await page.locator('#sendBtn').click();
        await page.waitForFunction(() => !TURNS[activeSession().id], null, { timeout: 30000 });
        await sleep(2500);
        await shot('conversation', () => page.evaluate(() => { const m = activeSession().messages.filter(x => x.role === 'assistant').pop(); stepsOpen.set(m.id, true); renderConvo(); }));
        await page.locator('#computerToggleBtn').click();
        await page.locator('#composer').fill('What is in my shoot folder?');
        await page.locator('#sendBtn').click();
        await page.waitForSelector('.msg-steps .approval-card', { timeout: 20000 });
        await shot('computer-approval', async () => { await page.locator('.msg-steps .approval-card').scrollIntoViewIfNeeded(); }, { wait: 500 });
        await shot('activity', () => page.locator('#activityBtn').click(), { wait: 700 });
        await page.evaluate(() => toggleActivityDrawer(false));
        await page.locator('.msg-steps .approval-go[data-d="allow"]').first().click();
        await page.waitForFunction(() => !TURNS[activeSession().id], null, { timeout: 30000 });
      } catch (e) { console.warn('  ! conversation: ' + e.message.split('\n')[0]); }
    }
    if (want('image-build')) {
      try {
        const i2c = require('../lib/image-to-code');
        fs.writeFileSync(path.join(dataDir, 'design.html'), DESIGN_HTML.replace('#f5a524', '#e0892a'));
        const design = await i2c.render(path.join(dataDir, 'design.html'), path.join(dataDir, 'Marine Drive design.png'), { width: 900, height: 420 });
        await page.evaluate(() => { showView('console'); createSession(); });
        await page.waitForFunction(() => activeSession());
        await page.setInputFiles('#sourceInput', design); await sleep(800);
        await page.locator('#composer').fill('Build this as a web page');
        await page.locator('#sendBtn').click();
        await page.waitForFunction(() => { const m = activeSession().messages.filter(x => x.role === 'assistant').pop(); return m && m.build && !m.pending && !TURNS[activeSession().id]; }, null, { timeout: 90000 });
        await shot('image-build', () => page.evaluate(() => { const m = activeSession().messages.filter(x => x.role === 'assistant').pop(); stepsOpen.set(m.id, true); renderConvo(); const el = document.querySelector('.build-card'); if (el) el.scrollIntoView({ block: 'center' }); }), { wait: 900 });
      } catch (e) { console.warn('  ! image-build: ' + e.message.split('\n')[0]); }
    }
    await shot('workbench', async () => { await page.goto(base + '/workbench.html'); await page.waitForLoadState('networkidle'); }, { wait: 1500 });
    await shot('workbench-halt', async () => { await page.locator('.btn-halt').click(); }, { wait: 500 });
    await shot('setup-checklist', async () => { await page.goto(base + '/activate.html'); await page.waitForLoadState('networkidle'); }, { wait: 1200 });
    await page.goto(base + '/'); await page.waitForLoadState('networkidle'); await sleep(1200);
    await shot('helper', async () => {
      await page.evaluate(() => { showView('models'); setPrefs({ helperSpeak: false }); });
      await page.locator('#hfFace').click(); await page.locator('#hfText').fill('How do I let Maataa change my code?'); await page.locator('#hfSend').click();
      await page.locator('#hfMsgs .hf-act').waitFor({ timeout: 15000 });
    }, { wait: 500 });
    await shot('helper-tour', async () => { await page.locator('#hfMsgs .hf-act').click(); await page.locator('.hf-tip').waitFor({ timeout: 8000 }); await page.locator('.hf-tip [data-n="next"]').click(); await sleep(1200); }, { wait: 600 });
    await shot('helper-designer', async () => { await page.keyboard.press('Escape'); await page.evaluate(() => window.novaHelper.design('nova')); await page.locator('#ndSave').waitFor({ timeout: 8000 }); await page.locator('[data-extra="headset"]').click(); await page.locator('[data-eyes="happy"]').click(); }, { wait: 500 });
    await page.evaluate(() => { document.querySelectorAll('.hf-spot,.hf-tip').forEach(n => n.remove()); });
    await shot('help', () => page.evaluate(() => openHelp()));
    await shot('help-support', () => page.evaluate(() => openHelp('support-report')), { wait: 2500 });
    await shot('help-drawer', async () => { await page.evaluate(() => showView('agents')); await page.locator('#agentsView .help-btn').first().click(); }, { wait: 900 });
    await shot('agents-builder', async () => { await page.evaluate(() => showView('agents')); await page.locator('#autoAgentBtn').click(); await page.locator('#aabGoal').fill('Plan shoots from my notes: make a shot list and a call sheet, and flag anything missing.'); });
    await ctx.close();

    // Phone width
    if (want('phone-menu')) {
      const phone = await newContext(browser, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      const p = await phone.newPage(); await p.goto(base + '/'); await p.waitForLoadState('networkidle'); await sleep(1200);
      try { await p.locator('#mobileNav').click(); await sleep(600); await p.screenshot({ path: path.join(OUT, 'phone-menu.jpg'), type: 'jpeg', quality: 70 }); saved.push('phone-menu.jpg'); } catch (e) { console.warn('  ! phone-menu: ' + e.message.split('\n')[0]); }
      await phone.close();
    }

    // Short clips
    const clip = async (name, fn) => {
      if (!want(name)) return;
      const c = await newContext(browser, { viewport: { width: 1280, height: 800 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } });
      const p = await c.newPage();
      if (process.env.CAPTURE_DEBUG) { p.on('pageerror', e => console.log('  pageerror', e.message)); p.on('response', async r => { if (/builder|workflows\/.*run/.test(r.url())) console.log('  ', r.status(), r.url().slice(-40), (await r.text().catch(() => '')).slice(0, 160)); }); }
      try {
        await p.goto(base + '/'); await p.waitForLoadState('networkidle'); await sleep(1000);
        await fn(p);
        await sleep(1200);
      } catch (e) { console.warn(`  ! ${name}: ${e.message.split('\n')[0]}`); }
      const video = p.video();
      await c.close();
      const webm = await video.path();
      const out = toMp4(webm, path.join(OUT, name));
      if (out) saved.push(path.basename(out));
    };
    const typeSlow = async (p, sel, text) => { await p.locator(sel).click(); await p.keyboard.type(text, { delay: 28 }); };

    await clip('chat', async p => {
      await p.locator('#newSessionBtn').click(); await sleep(400);
      await typeSlow(p, '#composer', 'Plan a two-minute dusk shoot on Marine Drive.');
      await p.locator('#sendBtn').click(); await sleep(5500);
    });
    await clip('build-agent', async p => {
      await p.evaluate(() => showView('agents')); await sleep(700);
      await p.locator('#autoAgentBtn').click(); await sleep(400);
      await typeSlow(p, '#aabGoal', 'Plan shoots from my notes: make a shot list and a call sheet, and flag anything missing.');
      await p.locator('#aabGo').click();
      await p.waitForFunction(() => /drafted/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
      const aid = await p.evaluate(() => (DB.agents.find(a => a.name === 'Shoot Planner') || {}).id);
      if (aid) {
        const input = p.locator(`.agent-instruction-input[data-id="${aid}"]`);
        await input.scrollIntoViewIfNeeded(); await sleep(1500);
        await input.click(); await p.keyboard.type('Make a shot list from: dusk, Marine Drive, two actors, one drone shot.', { delay: 22 });
        await p.locator(`.agent-start[data-id="${aid}"]`).click(); await sleep(5000);
        await input.scrollIntoViewIfNeeded(); await sleep(800);
      }
    });
    await clip('workflow-approval', async p => {
      await p.evaluate(() => showView('workflows')); await sleep(700);
      await p.locator('#autoWorkflowBtn').click(); await sleep(400);
      await typeSlow(p, '#wabGoal', 'Summarise my shoot notes, get my sign-off, then translate the summary to Hindi.');
      await p.locator('#wabGo').click();
      const id = await p.waitForFunction(() => { const w = DB.workflows.find(x => x.name === 'Shoot notes in Hindi'); return w && document.querySelector(`.wf-run[data-id="${w.id}"]`) ? w.id : null; }, null, { timeout: 15000 }).then(h => h.jsonValue());
      const card = p.locator(`.wf-run[data-id="${id}"]`);
      await card.scrollIntoViewIfNeeded(); await sleep(1500);
      await card.click();
      const runId = await p.waitForFunction(wid => { const r = DB.workflowRuns.find(x => x.workflowId === wid && x.status === 'awaiting_approval'); return r && document.querySelector(`.wf-approve-run[data-run="${r.id}"]`) ? r.id : null; }, id, { timeout: 25000 }).then(h => h.jsonValue());
      const approve = p.locator(`.wf-approve-run[data-run="${runId}"]`);
      await approve.scrollIntoViewIfNeeded(); await sleep(1800);
      await approve.click(); await sleep(6000);
    });
    await clip('conversation', async p => {
      await p.locator('#newSessionBtn').click(); await sleep(500);
      await p.locator('#addBtn').click(); await sleep(700);
      await p.evaluate(() => openAddForm('folder')); await sleep(300);
      await p.locator('#addFormInput').click(); await p.keyboard.type(shoot, { delay: 12 });
      await p.locator('#addFormGo').click();
      await p.waitForSelector('.src-chip.src-ready', { timeout: 15000 }); await sleep(900);
      await typeSlow(p, '#composer', 'What does the camera cost and when is the shoot?');
      await p.locator('#sendBtn').click();
      await p.waitForFunction(() => !TURNS[activeSession().id], null, { timeout: 30000 }); await sleep(2500);
      await p.locator('#computerToggleBtn').click(); await sleep(900);
      await typeSlow(p, '#composer', 'What is in my shoot folder?');
      await p.locator('#sendBtn').click();
      await p.waitForSelector('.msg-steps .approval-card', { timeout: 20000 }); await sleep(1600);
      await p.locator('.msg-steps .approval-go[data-d="allow"]').first().click();
      await p.waitForFunction(() => !TURNS[activeSession().id], null, { timeout: 30000 }); await sleep(2500);
    });
    await clip('help-tour', async p => {
      await p.evaluate(() => openHelp()); await sleep(1200);
      await typeSlow(p, '#helpSearch', 'ollama'); await sleep(1200);
      await p.locator('.help-result').first().click(); await sleep(1800);
      await p.evaluate(() => openHelp('support-report')); await sleep(3000);
    });
  } finally {
    await browser.close();
    child.kill();
    ollama.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  const bytes = saved.reduce((n, f) => n + (fs.existsSync(path.join(OUT, f)) ? fs.statSync(path.join(OUT, f)).size : 0), 0);
  console.log(`Saved ${saved.length} files to public/help/media (${(bytes / 1048576).toFixed(1)} MB). Now run: npm run help:build`);
}

function toMp4(webm, base) {
  const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0 ? 'ffmpeg' : null;
  if (!ffmpeg) { const out = base + '.webm'; fs.copyFileSync(webm, out); return out; }
  const out = base + '.mp4';
  const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', webm, '-vf', 'scale=960:-2,fps=15', '-c:v', 'libx264', '-preset', 'slow', '-crf', '32', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', out]);
  if (r.status !== 0) { console.warn('  ! ffmpeg failed: ' + String(r.stderr).slice(0, 200)); return null; }
  return out;
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { startOllama, startNova };
