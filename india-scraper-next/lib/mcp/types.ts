// Minimal client-side types for talking to an MCP (Model Context Protocol)
// server over stdio. Deliberately only the slice this project needs --
// tool discovery and tool calls -- not the full MCP spec (no resources,
// prompts, sampling, or the SSE/HTTP transports).

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  // MCP returns a list of content blocks (text, image, ...); this client
  // only surfaces the text ones, joined, since every provider adapter here
  // feeds tool results back to the model as a plain string.
  text: string;
  isError: boolean;
}

export interface McpClient {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close(): void;
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}
