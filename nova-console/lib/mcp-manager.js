'use strict';
/* ===========================================================================
 * NOVA Runtime — MCP connection + approval manager (Phase 3)
 *
 * Owns the live McpClient connections (one real child process per connected
 * server) and is the single real enforcement point for a server's approval
 * policy. Both the manual "Call" button in the MCP view and a running
 * skill's declared-tool proxy call the same gatedCall() here — so "auto /
 * ask / deny" really gates the outgoing tools/call no matter who's asking,
 * not just a UI banner drawn around an already-decided result.
 *
 * Spawn specs are server-authoritative (SPAWN_SPECS below), never taken
 * from the DB row's freeform `command` display string — a browser-editable
 * field must never dictate what this process actually executes.
 * ========================================================================= */
const path = require('path');
const { McpClient } = require('./mcp');

const PROJECT_ROOT = path.join(__dirname, '..');
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — nothing waits forever

// Real servers this project can actually spawn (see mcp-servers/). Off-the-
// shelf @modelcontextprotocol/server-filesystem and mcp-server-git aren't
// installable here (npm + PyPI both 403 from this build sandbox and the
// device's local VM) — these are honest, minimal, hand-written substitutes,
// not fakes: real child processes, real protocol, real tool execution.
const SPAWN_SPECS = {
  mcp_fs: () => ({ command: process.execPath, args: [path.join(__dirname, '..', 'mcp-servers', 'fs-server.js'), PROJECT_ROOT] }),
  mcp_git: () => ({ command: process.execPath, args: [path.join(__dirname, '..', 'mcp-servers', 'git-server.js'), PROJECT_ROOT] }),
  // mcp_browser intentionally has no spec: no real implementation is wired
  // up, so connecting fails honestly (501) instead of faking success.
};

const connections = new Map(); // serverId -> McpClient
const pendingApprovals = new Map(); // approvalId -> record

function nowIso() { return new Date().toISOString(); }
function uid(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function httpErr(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e; }

function pushLog(store, server, line) {
  if (!server) return;
  server.logs = server.logs || [];
  server.logs.push({ at: nowIso(), line });
  if (server.logs.length > 200) server.logs.splice(0, server.logs.length - 200);
  store.put('mcpServers', server);
}

async function connectServer(store, id) {
  const server = store.get('mcpServers', id);
  if (!server) throw httpErr(404, 'Unknown MCP server: ' + id);
  const specFn = SPAWN_SPECS[id];
  if (!specFn) {
    server.status = 'error';
    store.put('mcpServers', server);
    pushLog(store, server, 'Connect failed: no real server implementation is wired up for "' + id + '" yet.');
    throw httpErr(501, 'No real MCP server implementation wired for "' + server.name + '" yet.');
  }

  const existing = connections.get(id);
  if (existing) { existing.close(); connections.delete(id); }

  server.status = 'starting';
  store.put('mcpServers', server);
  const spec = specFn();
  const client = new McpClient({
    command: spec.command, args: spec.args, cwd: PROJECT_ROOT,
    onLog: line => pushLog(store, store.get('mcpServers', id), line),
  });
  try {
    const initResult = await client.connect();
    const tools = await client.listTools();
    connections.set(id, client);
    const fresh = store.get('mcpServers', id) || server;
    fresh.status = 'connected';
    fresh.lastConnectedAt = nowIso();
    fresh.tools = tools.map(t => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || {} }));
    store.put('mcpServers', fresh);
    pushLog(store, fresh, 'Connected · protocolVersion ' + (initResult.protocolVersion || '?') + ' · ' +
      (initResult.serverInfo ? initResult.serverInfo.name + ' ' + initResult.serverInfo.version : 'unknown server'));
    return fresh;
  } catch (e) {
    client.close();
    const fresh = store.get('mcpServers', id) || server;
    fresh.status = 'error';
    store.put('mcpServers', fresh);
    pushLog(store, fresh, 'Connect failed: ' + e.message);
    throw httpErr(502, 'Connect failed for "' + server.name + '": ' + e.message);
  }
}

function disconnectServer(store, id) {
  const server = store.get('mcpServers', id);
  if (!server) throw httpErr(404, 'Unknown MCP server: ' + id);
  const client = connections.get(id);
  if (client) { client.close(); connections.delete(id); }
  server.status = 'disconnected';
  store.put('mcpServers', server);
  pushLog(store, server, 'Disconnected.');
  return server;
}

function createPendingApproval(store, serverId, toolName, args, opts) {
  const server = store.get('mcpServers', serverId);
  const approvalId = uid('appr');
  const record = {
    approvalId, serverId, toolName, arguments: args || {}, createdAt: nowIso(),
    origin: (opts && opts.origin) || 'manual', skillName: opts && opts.skillName,
    serverName: server ? server.name : serverId,
  };
  pendingApprovals.set(approvalId, record);
  pushLog(store, server, 'tools/call ' + toolName + ' → awaiting approval' +
    (record.origin === 'skill' ? ' (triggered by skill "' + record.skillName + '")' : ''));
  record.timer = setTimeout(() => {
    if (!pendingApprovals.has(approvalId)) return;
    pendingApprovals.delete(approvalId);
    pushLog(store, store.get('mcpServers', serverId), 'tools/call ' + toolName + ' → approval timed out, auto-rejected');
    if (record.deferred) record.deferred.reject(httpErr(408, 'Approval request timed out.'));
  }, APPROVAL_TIMEOUT_MS);
  return record;
}

/** Resolves a bare tool name (as a skill manifest declares it) to the
 *  connected server that currently advertises it — mirrors the same
 *  DB.mcpServers.tools lookup the frontend's skill-health check already
 *  does. Returns null if no connected server advertises that tool. */
function findServerForTool(store, toolName) {
  for (const s of store.all('mcpServers')) {
    if ((s.tools || []).some(t => t.name === toolName)) return s;
  }
  return null;
}

function listPendingApprovals(serverId) {
  const out = [];
  for (const r of pendingApprovals.values()) {
    if (serverId && r.serverId !== serverId) continue;
    out.push({ approvalId: r.approvalId, serverId: r.serverId, serverName: r.serverName, toolName: r.toolName, arguments: r.arguments, createdAt: r.createdAt, origin: r.origin, skillName: r.skillName });
  }
  return out;
}

async function executeRealCall(store, serverId, toolName, args) {
  const client = connections.get(serverId);
  if (!client) throw httpErr(502, 'Server is not connected — connect it first.');
  const server = store.get('mcpServers', serverId);
  try {
    const result = await client.callTool(toolName, args);
    const text = (result.content || []).map(c => c.text).filter(Boolean).join('\n');
    pushLog(store, server, 'tools/call ' + toolName + ' → ok (' + text.length + ' chars)');
    return result;
  } catch (e) {
    pushLog(store, server, 'tools/call ' + toolName + ' → error: ' + e.message);
    throw httpErr(502, e.message);
  }
}

/** The one real enforcement point. opts.wait=true makes an 'ask' call block
 *  until a human approves/rejects (used by the skill runner); without it,
 *  an 'ask' call just registers the pending approval and returns — the
 *  manual "Call" button's own request doesn't need to hang, since clicking
 *  Approve later is itself a separate request that performs the real call. */
async function gatedCall(store, serverId, toolName, args, opts) {
  const server = store.get('mcpServers', serverId);
  if (!server) throw httpErr(404, 'Unknown MCP server: ' + serverId);
  const policy = server.approvalPolicy;
  if (policy === 'deny') {
    pushLog(store, server, 'tools/call ' + toolName + ' → denied by server policy');
    throw httpErr(403, 'Denied by server policy (' + server.name + ').');
  }
  if (policy === 'ask') {
    const record = createPendingApproval(store, serverId, toolName, args, opts);
    if (opts && opts.wait) {
      return new Promise((resolve, reject) => { record.deferred = { resolve, reject }; });
    }
    return { pending: true, approvalId: record.approvalId };
  }
  return executeRealCall(store, serverId, toolName, args);
}

async function resolveApproval(store, approvalId, decision) {
  const record = pendingApprovals.get(approvalId);
  if (!record) throw httpErr(404, 'Unknown or already-resolved approval: ' + approvalId);
  clearTimeout(record.timer);
  pendingApprovals.delete(approvalId);
  const server = store.get('mcpServers', record.serverId);
  if (decision === 'reject') {
    pushLog(store, server, 'tools/call ' + record.toolName + ' → rejected by operator');
    if (record.deferred) record.deferred.reject(httpErr(403, 'Rejected by operator.'));
    return { status: 'rejected' };
  }
  pushLog(store, server, 'tools/call ' + record.toolName + ' → approved by operator, executing');
  try {
    const result = await executeRealCall(store, record.serverId, record.toolName, record.arguments);
    if (record.deferred) record.deferred.resolve(result);
    return { status: 'ok', result };
  } catch (e) {
    if (record.deferred) record.deferred.reject(e);
    throw e;
  }
}

function shutdownAll() {
  for (const [, client] of connections) client.close();
  connections.clear();
}

/** Called once at server startup, before anything tries to resume
 *  in-flight work (Phase 4's resumeInFlightRuns). A server row's
 *  'connected'/'starting' status describes a real child process in THIS
 *  module's in-memory `connections` Map — which a fresh process always
 *  starts empty. Without this, a restart would leave the DB claiming a
 *  server is connected when no such process exists, and the first real
 *  tools/call against it would fail with a confusing "not connected"
 *  error instead of an honest, expected-looking disconnected state. */
function reconcileOnStartup(store) {
  let reset = 0;
  for (const s of store.all('mcpServers')) {
    if (s.status === 'connected' || s.status === 'starting') {
      s.status = 'disconnected';
      store.put('mcpServers', s);
      pushLog(store, s, 'Marked disconnected on startup — no real child process survives a server restart; reconnect to resume real tool calls.');
      reset++;
    }
  }
  return reset;
}

module.exports = { connectServer, disconnectServer, gatedCall, findServerForTool, listPendingApprovals, resolveApproval, shutdownAll, reconcileOnStartup, SPAWN_SPECS };
