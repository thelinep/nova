import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { McpClient, McpServerConfig, McpTool, McpToolResult } from './types';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

// A from-scratch minimal MCP stdio client: no @modelcontextprotocol/sdk
// dependency, matching this repo's pattern of plain fetch/child_process over
// vendor SDKs. Speaks newline-delimited JSON-RPC 2.0 over the child's
// stdin/stdout, which is MCP's stdio transport. Only implements what this
// project uses: `initialize`, `tools/list`, `tools/call`.
export function createStdioMcpClient(config: McpServerConfig): McpClient {
  const child: ChildProcessWithoutNullStreams = spawn(config.command, config.args, {
    env: { ...process.env, ...config.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let nextId = 1;
  let buffer = '';
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let initialized: Promise<void> | null = null;

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // not every line from a server is guaranteed JSON-RPC (stray logging, etc.)
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`MCP server error: ${message.error.message}`));
      else waiter.resolve(message.result);
    }
  });

  child.on('exit', (code) => {
    const error = new Error(`MCP server "${config.command}" exited (code ${code})`);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });

  function call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = nextId++;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify(request) + '\n');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`MCP call "${method}" timed out`));
        }
      }, 30000);
    });
  }

  function ensureInitialized(): Promise<void> {
    if (!initialized) {
      initialized = call('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'maataa-agent-router', version: '0.1.0' },
      }).then(() => undefined);
    }
    return initialized;
  }

  return {
    async listTools(): Promise<McpTool[]> {
      await ensureInitialized();
      const result = (await call('tools/list')) as { tools?: McpTool[] };
      return result.tools || [];
    },

    async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
      await ensureInitialized();
      const result = (await call('tools/call', { name, arguments: args })) as {
        content?: { type: string; text?: string }[];
        isError?: boolean;
      };
      const text = (result.content || [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text || '')
        .join('\n');
      return { text, isError: Boolean(result.isError) };
    },

    close() {
      child.stdin.end();
      child.kill();
    },
  };
}
