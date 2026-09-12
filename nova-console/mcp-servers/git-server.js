#!/usr/bin/env node
'use strict';
/* ===========================================================================
 * NOVA Runtime — minimal real git MCP server (Phase 3)
 *
 * Same honest substitution as fs-server.js: the official mcp-server-git
 * package is unreachable (PyPI returns 403 from this build's sandbox and
 * from the device's local VM), so this hand-rolled server speaks the real
 * MCP stdio protocol itself and runs the real system `git` binary via
 * execFileSync (array argv — no shell, so no shell-injection surface) for
 * every tool call. A repo path with no .git directory produces a real git
 * error, surfaced honestly rather than faked as success.
 * ========================================================================= */
const { execFileSync } = require('child_process');
const path = require('path');

const REPO = path.resolve(process.argv[2] || process.cwd());

const TOOLS = [
  { name: 'git_status', description: 'Show working tree status.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'git_diff', description: 'Show uncommitted changes (optionally scoped to one path).', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: [] } },
  { name: 'git_log', description: 'Show recent commit history.', inputSchema: { type: 'object', properties: { limit: { type: 'number' } }, required: [] } },
];

function runGit(args) {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  } catch (e) {
    // A real, non-zero git exit (e.g. "not a git repository") — surface the
    // real stderr/stdout rather than swallowing it or faking a clean result.
    const out = (e.stderr || e.stdout || e.message || String(e)).toString().trim();
    const err = new Error('git ' + args.join(' ') + ' failed: ' + out);
    err.code = -32000;
    throw err;
  }
}

function callTool(name, args) {
  args = args || {};
  if (name === 'git_status') {
    const text = runGit(['status', '--porcelain=v1', '-b']);
    return { content: [{ type: 'text', text: text || '(clean)' }] };
  }
  if (name === 'git_diff') {
    const gitArgs = args.path ? ['diff', '--', args.path] : ['diff'];
    const text = runGit(gitArgs);
    return { content: [{ type: 'text', text: text || '(no uncommitted changes)' }] };
  }
  if (name === 'git_log') {
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 200);
    const text = runGit(['log', '-n', String(limit), '--oneline']);
    return { content: [{ type: 'text', text: text || '(no commits)' }] };
  }
  const err = new Error('Unknown tool: ' + name); err.code = -32601; throw err;
}

/* ---- real MCP stdio server loop ---- */
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

function handleLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }
  if (msg.method === 'notifications/initialized') return;
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'nova-git-server', version: '0.1.0' },
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
process.stderr.write('nova-git-server ready, repo=' + REPO + '\n');
