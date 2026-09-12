import path from 'node:path';
import { createStdioMcpClient } from './stdio-client';
import type { McpClient, McpServerConfig, McpTool } from './types';

const repoRoot = path.join(__dirname, '..', '..');

// Named MCP servers this project knows how to start. Add an entry here for
// each server an agent role should be able to reach; nothing in
// lib/agent-router.ts talks to a server that isn't listed here first.
export const MCP_SERVERS: Record<string, McpServerConfig> = {
  // The official reference filesystem server, scoped to this repo only --
  // requires `npx` to be able to fetch it the first time (not available
  // from every sandboxed environment; falls back to "unconfigured" the same
  // way a missing API key does, see listToolsFor below).
  filesystem: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', repoRoot],
  },
};

const clients = new Map<string, McpClient>();

function getClient(serverId: string): McpClient {
  const existing = clients.get(serverId);
  if (existing) return existing;
  const config = MCP_SERVERS[serverId];
  if (!config) throw new Error(`Unknown MCP server "${serverId}"`);
  const client = createStdioMcpClient(config);
  clients.set(serverId, client);
  return client;
}

export interface NamedMcpTool extends McpTool {
  serverId: string;
}

// Tools from every requested server, each tagged with which server to call
// it on -- lib/agent-router.ts uses that tag to route a tool call back to
// the right child process.
export async function listToolsFor(serverIds: string[]): Promise<NamedMcpTool[]> {
  const results: NamedMcpTool[] = [];
  for (const serverId of serverIds) {
    try {
      const client = getClient(serverId);
      const tools = await client.listTools();
      for (const tool of tools) results.push({ ...tool, serverId });
    } catch {
      // A server that fails to start (missing npx/network/package) is
      // treated like an unconfigured provider: skipped, not fatal.
      continue;
    }
  }
  return results;
}

export async function callTool(serverId: string, name: string, args: Record<string, unknown>) {
  const client = getClient(serverId);
  return client.callTool(name, args);
}

export function closeAllMcpClients(): void {
  for (const client of clients.values()) client.close();
  clients.clear();
}
