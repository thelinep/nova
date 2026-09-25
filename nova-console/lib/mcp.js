'use strict';
/* ===========================================================================
 * NOVA Runtime — real MCP client (Phase 3)
 *
 * Speaks the actual Model Context Protocol stdio transport by hand: spawn a
 * child process, exchange newline-delimited JSON-RPC 2.0 messages over its
 * stdin/stdout, do the real `initialize` handshake, send the real
 * `notifications/initialized` notification, and make real `tools/list` /
 * `tools/call` requests. Nothing here is simulated — every message on the
 * wire is a real JSON-RPC message a real MCP server process actually reads
 * and responds to.
 *
 * This is NOT built on @modelcontextprotocol/sdk. Both npm and PyPI return
 * 403 Forbidden from this build's cloud sandbox AND from the target
 * device's local VM (confirmed directly, not assumed) — so the SDK package,
 * and the official @modelcontextprotocol/server-filesystem / mcp-server-git
 * packages the roadmap suggested, are all unreachable. Rather than fake the
 * protocol, this hand-implements the real wire format (the same one the SDK
 * implements) against two minimal real servers this project writes itself —
 * see mcp-servers/. That's the same zero-registry-dependency call Phase 1
 * made for SQLite/HTTP and Phase 2 made for chunking/reranking.
 * ========================================================================= */
const { spawn } = require('node:child_process');

const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const CALL_TIMEOUT_MS = 60000; // a first browser launch plus page load can take a while

class McpClient {
  constructor({ command, args, cwd, env, onLog }) {
    this.command = command;
    this.args = args || [];
    this.cwd = cwd;
    this.env = env || null;
    this.onLog = onLog || null;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.buffer = '';
    this.serverInfo = null;
    this.serverCapabilities = null;
    this.initialized = false;
    this.closed = false;
  }

  _log(line) { if (this.onLog) { try { this.onLog(line); } catch (_) {} } }

  start() {
    if (this.proc) return;
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env ? { ...process.env, ...this.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', chunk => this._onStdout(chunk));
    this.proc.stderr.on('data', chunk => {
      const text = chunk.toString('utf8').trim();
      if (text) this._log('[stderr] ' + text.slice(0, 500));
    });
    this.proc.on('error', err => {
      this._log('[spawn error] ' + err.message);
      this._failAllPending(new Error('MCP server process failed to start: ' + err.message));
    });
    this.proc.on('exit', (code, signal) => {
      this.closed = true;
      this._log('Process exited (code=' + code + (signal ? ', signal=' + signal : '') + ')');
      this._failAllPending(new Error('MCP server process exited (code=' + code + ')'));
    });
  }

  _failAllPending(err) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  _onStdout(chunk) {
    this.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch (e) { this._log('[unparseable line] ' + line.slice(0, 300)); continue; }
      this._handleMessage(msg);
    }
  }

  _handleMessage(msg) {
    if (msg && msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return; // response to a request we already timed out on — drop it
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || ('MCP error ' + msg.error.code)));
      else p.resolve(msg.result);
      return;
    }
    if (msg && msg.method) this._log('notification: ' + msg.method);
  }

  _writeRaw(obj) {
    if (!this.proc || this.closed) throw new Error('MCP server process is not running');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('MCP request "' + method + '" timed out after ' + (timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS) + 'ms'));
      }, timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      try { this._writeRaw({ jsonrpc: '2.0', id, method, params: params || {} }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  notify(method, params) {
    this._writeRaw({ jsonrpc: '2.0', method, params: params || {} });
  }

  /** Real MCP handshake: initialize -> notifications/initialized. */
  async connect() {
    this.start();
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'nova-runtime', version: '0.3.0' },
    });
    this.serverInfo = result.serverInfo || null;
    this.serverCapabilities = result.capabilities || null;
    this.notify('notifications/initialized', {});
    this.initialized = true;
    return result;
  }

  async listTools() {
    const res = await this.request('tools/list', {});
    return res.tools || [];
  }

  async callTool(name, args) {
    const res = await this.request('tools/call', { name, arguments: args || {} }, CALL_TIMEOUT_MS);
    return res;
  }

  close() {
    if (this.proc && !this.closed) {
      try { this.proc.stdin.end(); } catch (_) {}
      try { this.proc.kill(); } catch (_) {}
    }
    this.closed = true;
    this._failAllPending(new Error('MCP connection closed'));
  }
}

module.exports = { McpClient, PROTOCOL_VERSION };
