#!/usr/bin/env node
'use strict';
/* ===========================================================================
 * NOVA Runtime — minimal real filesystem MCP server (Phase 3)
 *
 * A standalone Node process that speaks the real MCP stdio wire protocol
 * (newline-delimited JSON-RPC 2.0) by hand and does real filesystem
 * operations, sandboxed to one root directory passed as argv[2]. This is
 * NOT the official @modelcontextprotocol/server-filesystem package — that
 * package (and the SDK it's built on) is unreachable from both this
 * project's build sandbox and the target device's local VM (npm and PyPI
 * both return 403 there; confirmed, not assumed). Rather than fake a
 * connection to a server that can't be installed, this implements a real,
 * minimal one: every tool call below does a real fs.* call against real
 * files under ROOT, nothing fabricated.
 * ========================================================================= */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || process.cwd());
const MAX_SEARCH_HITS = 200;
const SKIP_DIRS = new Set(['node_modules', '.git']);

function within(relPath) {
  const resolved = path.resolve(ROOT, relPath || '.');
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    throw httpish(-32602, 'Path escapes the sandboxed root: ' + relPath);
  }
  return resolved;
}
function httpish(code, message) { const e = new Error(message); e.code = code; return e; }

const TOOLS = [
  { name: 'list_directory', description: 'List entries in a directory relative to the sandboxed root.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: [] } },
  { name: 'read_file', description: 'Read a text file\'s contents by path relative to the sandboxed root.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'search_files', description: 'Search file contents for a substring under the sandboxed root.', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
];

function callTool(name, args) {
  args = args || {};
  if (name === 'list_directory') {
    const dir = within(args.path || '.');
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .map(e => (e.isDirectory() ? '[dir]  ' : '[file] ') + e.name);
    return { content: [{ type: 'text', text: entries.length ? entries.join('\n') : '(empty directory)' }] };
  }
  if (name === 'read_file') {
    if (!args.path) throw httpish(-32602, 'Missing required argument: path');
    const file = within(args.path);
    const text = fs.readFileSync(file, 'utf8');
    return { content: [{ type: 'text', text }] };
  }
  if (name === 'search_files') {
    if (!args.pattern) throw httpish(-32602, 'Missing required argument: pattern');
    const startDir = within(args.path || '.');
    const hits = [];
    const stack = [startDir];
    while (stack.length && hits.length < MAX_SEARCH_HITS) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(full); continue; }
        try {
          const text = fs.readFileSync(full, 'utf8');
          if (text.includes(args.pattern)) hits.push(path.relative(ROOT, full));
        } catch (_) { /* binary or unreadable — skip, not an error */ }
      }
    }
    return { content: [{ type: 'text', text: hits.length ? hits.join('\n') : ('No matches for "' + args.pattern + '"') }] };
  }
  throw httpish(-32601, 'Unknown tool: ' + name);
}

/* ---- real MCP stdio server loop (server side of the protocol) ---- */
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

function handleLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }
  if (msg.method === 'notifications/initialized') return; // notification — no response
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'nova-fs-server', version: '0.1.0' },
      } });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      const result = callTool(params && params.name, params && params.arguments);
      send({ jsonrpc: '2.0', id, result });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: e.code || -32000, message: e.message || String(e) } });
  }
}

let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim()) handleLine(line);
  }
});
process.stdin.on('end', () => process.exit(0)); // parent closed stdin — exit rather than orphan
process.stdin.resume();
process.stderr.write('nova-fs-server ready, root=' + ROOT + '\n');
