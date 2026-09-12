// Shared contract for every cloud LLM provider adapter under lib/providers/.
//
// This is deliberately separate from lib/maataa-ai.cjs, which is the local
// Maataa conversation workspace's client and talks ONLY to a loopback Ollama
// instance -- it actively rejects anything that looks like a cloud/remote
// model by design (see localOrigin()/requireModel() in that file). Nothing
// here touches that file or its invariant. See docs/MULTI-MODEL-AGENTS.md
// for the reasoning and for which new env vars each adapter reads.

export type ProviderName = 'anthropic' | 'openai' | 'deepseek' | 'gemini';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

// A tool call the model asked for, normalized across providers. `id` is a
// real per-call id for Anthropic/OpenAI/DeepSeek; Gemini has no per-call id
// in its API, so its adapter uses the function `name` as the id -- fine
// for a role that never calls the same tool twice in one turn, a known
// limitation noted again in gemini.ts.
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: ChatRole;
  // For a 'tool' message this is the stringified result of running the tool.
  content: string;
  // Set on an assistant message that asked to run tools instead of (or
  // alongside) answering in text.
  toolCalls?: ToolCall[];
  // Set on a 'tool' message: which ToolCall.id this result answers.
  toolCallId?: string;
}

// A tool an agent may call, in MCP's own shape (name + description + JSON
// Schema input) -- lib/mcp/* hands these to the router as-is, and each
// provider adapter translates them into that vendor's own function-calling
// format.
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  // Empty string means "use this adapter's own default model".
  model: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ToolSpec[];
}

export interface CompletionUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface CompletionResult {
  // Any text the model produced alongside/instead of tool calls. Empty
  // string when the turn was pure tool-calling.
  content: string;
  provider: ProviderName;
  model: string;
  usage?: CompletionUsage;
  // Present when the model wants tools run before it continues. The caller
  // (lib/agent-router.ts) is responsible for running them and feeding
  // results back as 'tool' messages in the next request.
  toolCalls?: ToolCall[];
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  isConfigured(): boolean;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

// Marks an error as worth failing over to the next provider in a chain
// (timeout, rate limit, 5xx, or "not configured"). Anything else -- a bad
// request, a content-policy rejection -- is a plain Error and is NOT
// retried on a fallback provider. Plain function + property, no custom
// Error subclass, to match this repo's existing throw-a-message convention.
export function retryable(message: string): Error {
  const error = new Error(message);
  (error as Error & { retryable?: boolean }).retryable = true;
  return error;
}

export function isRetryable(error: unknown): boolean {
  return error instanceof Error && (error as Error & { retryable?: boolean }).retryable === true;
}
