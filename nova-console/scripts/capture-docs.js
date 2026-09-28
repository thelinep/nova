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
  { name: 'llama3.2:latest', model: 'llama3.2:latest', size: 2019393189, details: { family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' } },
  { name: 'qwen2.5-coder:7b', model: 'qwen2.5-coder:7b', size: 4683087332, details: { family: 'qwen2', parameter_size: '7.6B', quantization_level: 'Q4_K_M' } },
  { name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest', size: 274302450, details: { family: 'nomic-bert', parameter_size: '137M', quantization_level: 'F16' } },
];
const REPLY = 'Here is a short plan for the shoot:\n\n1. **Location** – Marine Drive at dusk, with the city lights starting to show.\n2. **Look** – warm, soft light and a slow push-in on the lead.\n3. **Sound** – waves, distant traffic and a single sustained piano note.\n\nWant me to turn this into a shot list?';
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
          for (const piece of REPLY.match(/\S+\s*/g)) { res.write(JSON.stringify({ model: json.model, message: { role: 'assistant', content: piece }, done: false }) + '\n'); await sleep(45); }
          res.end(JSON.stringify({ model: json.model, message: { role: 'assistant', content: '' }, done: true, ...usage }) + '\n');
          return;
        }
        await sleep(600);
        let content = REPLY;
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
async function startNova(ollamaPort, dataDir) {
  const port = 8900 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, ['--no-warnings', 'server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, NOVA_LIBRARY_DIR: path.join(dataDir, 'library'), OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}`, COMFYUI_URL: 'http://127.0.0.1:9' },
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
    for (const v of ['sessions', 'models', 'knowledge', 'retrieval', 'automations', 'evaluations', 'boards', 'timeline', 'skills', 'mcp', 'agents', 'workflows', 'collector', 'graph', 'browser', 'workspace', 'git', 'runtime', 'trace', 'history', 'diagnostics', 'settings']) await shot(v, view(v));
    await shot('media-image', () => page.locator('.nav-item[data-media-tab="image"]').click());
    await shot('media-video', () => page.locator('.nav-item[data-media-tab="video"]').click());
    await shot('media-audio', () => page.locator('.nav-item[data-media-tab="audio"]').click());
    await shot('media-library', () => page.locator('.nav-item[data-media-tab="library"]').click());
    await shot('media-transcribe', async () => { await page.locator('.nav-item[data-media-tab="audio"]').click(); await page.locator('#mediaView').getByText('Transcribe', { exact: true }).first().click({ timeout: 3000 }); });
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
