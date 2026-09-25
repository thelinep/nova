#!/usr/bin/env node
'use strict';
/* ===========================================================================
 * NOVA Runtime — browser MCP server
 *
 * Real MCP stdio server that drives a headless Chromium through Playwright,
 * which NOVA already has as a dev dependency (@playwright/test). The browser
 * starts on the first tool call and keeps one page open between calls, so
 * navigate -> read -> click -> read works like a person browsing.
 *
 * NOVA only starts this server while Settings > Privacy > "Allow network
 * access" is on, and each tool call still goes through the server's
 * approval policy. Only http and https addresses are opened.
 * ========================================================================= */

const MAX_TEXT = 20000;

const TOOLS = [
  { name: 'browser_navigate', description: 'Open a web page (http or https) and return its title, final address and the start of its text.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_get_text', description: 'Return the visible text of the current page, or of the first element matching a CSS selector.', inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: [] } },
  { name: 'browser_links', description: 'List the links on the current page (text and address), up to 100.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'browser_click', description: 'Click the first element matching a CSS selector, or the first link or button with this exact visible text.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } }, required: [] } },
  { name: 'browser_type', description: 'Type text into the first field matching a CSS selector. Set submit to press Enter afterwards.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['selector', 'text'] } },
  { name: 'browser_screenshot', description: 'Take a PNG screenshot of the current page.', inputSchema: { type: 'object', properties: { fullPage: { type: 'boolean' } }, required: [] } },
];

let browser = null, page = null;

function fail(message, code = -32000) { const e = new Error(message); e.code = code; return e; }

async function currentPage() {
  if (page && !page.isClosed()) return page;
  let chromium;
  try { ({ chromium } = require('@playwright/test')); }
  catch (_) { throw fail('Playwright is not installed. In nova-console run: npm install'); }
  try { browser = browser || await chromium.launch({ headless: true, executablePath: process.env.NOVA_BROWSER_PATH || undefined }); }
  catch (e) { throw fail('Chromium could not start (' + String(e.message).split('\n')[0] + '). In nova-console run: npx playwright install chromium'); }
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: false });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  return page;
}

function needPage() { if (!page || page.isClosed() || page.url() === 'about:blank') throw fail('No page is open. Call browser_navigate first.'); return page; }

function checkUrl(raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch (_) { throw fail('Give a full address, for example https://example.com'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fail('Only http and https addresses can be opened.');
  return url.href;
}

const clip = (text, n = MAX_TEXT) => { text = String(text || '').replace(/\n{3,}/g, '\n\n').trim(); return text.length > n ? text.slice(0, n) + `\n… (${text.length - n} more characters)` : text; };
const textResult = text => ({ content: [{ type: 'text', text }] });

async function callTool(name, args = {}) {
  if (name === 'browser_navigate') {
    const url = checkUrl(args.url);
    const p = await currentPage();
    const response = await p.goto(url, { waitUntil: 'domcontentloaded' });
    await p.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    const body = await p.locator('body').innerText().catch(() => '');
    return textResult(`Title: ${await p.title()}\nAddress: ${p.url()}\nStatus: ${response ? response.status() : 'n/a'}\n\n${clip(body, 4000)}`);
  }
  if (name === 'browser_get_text') {
    const p = needPage();
    const text = await p.locator(args.selector ? String(args.selector) : 'body').first().innerText();
    return textResult(clip(text));
  }
  if (name === 'browser_links') {
    const p = needPage();
    const links = await p.$$eval('a[href]', as => as.slice(0, 100).map(a => ({ text: (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 120), href: a.href })));
    return textResult(links.map(l => `${l.text || '(no text)'} — ${l.href}`).join('\n') || '(no links)');
  }
  if (name === 'browser_click') {
    const p = needPage();
    if (!args.selector && !args.text) throw fail('Give a selector or the visible text to click.');
    const target = args.selector ? p.locator(String(args.selector)).first() : p.getByRole('link', { name: String(args.text), exact: true }).or(p.getByRole('button', { name: String(args.text), exact: true })).first();
    await target.click();
    await p.waitForLoadState('domcontentloaded').catch(() => {});
    return textResult(`Clicked. Now at ${p.url()} — ${await p.title()}`);
  }
  if (name === 'browser_type') {
    const p = needPage();
    const field = p.locator(String(args.selector)).first();
    await field.fill(String(args.text ?? ''));
    if (args.submit) { await field.press('Enter'); await p.waitForLoadState('domcontentloaded').catch(() => {}); }
    return textResult(`Typed into ${args.selector}${args.submit ? ' and pressed Enter' : ''}. Now at ${p.url()}`);
  }
  if (name === 'browser_screenshot') {
    const p = needPage();
    const png = await p.screenshot({ fullPage: Boolean(args.fullPage) });
    return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: `Screenshot of ${p.url()} (${png.length} bytes)` }] };
  }
  throw fail('Unknown tool: ' + name, -32601);
}

/* ---- MCP stdio loop (same shape as fs-server.js and git-server.js) ---- */
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handleLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }
  if (msg.method === 'notifications/initialized') return;
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'nova-browser-server', version: '0.1.0' } } });
    else if (method === 'tools/list') send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    else if (method === 'tools/call') send({ jsonrpc: '2.0', id, result: await callTool(params && params.name, (params && params.arguments) || {}) });
    else send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: e.code || -32000, message: String(e.message || e).split('\n')[0] } });
  }
}

let buffer = '', queue = Promise.resolve();
process.stdin.on('data', chunk => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);
    if (line.trim()) queue = queue.then(() => handleLine(line)); // one browser action at a time
  }
});
async function shutdown() { try { if (browser) await browser.close(); } catch (_) {} process.exit(0); }
process.stdin.on('end', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.resume();
process.stderr.write('nova-browser-server ready\n');
