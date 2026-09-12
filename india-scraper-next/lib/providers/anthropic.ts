import type { ProviderAdapter, CompletionRequest, CompletionResult, ChatMessage, ToolCall } from './types';
import { retryable } from './types';

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

function apiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

// Anthropic has no 'tool' role -- a tool result is a `tool_result` content
// block inside a *user* message, and a tool call is a `tool_use` content
// block inside an *assistant* message. This folds our flat ChatMessage list
// into that shape. Returns loosely-typed content blocks (Record<string,
// unknown>) rather than AnthropicContentBlock since we're only ever
// JSON.stringify-ing this for the wire, never reading it back.
function toAnthropicMessages(messages: ChatMessage[]): { role: string; content: string | Record<string, unknown>[] }[] {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
        };
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const blocks: Record<string, unknown>[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const call of m.toolCalls) {
          blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
        }
        return { role: 'assistant', content: blocks };
      }
      return { role: m.role, content: m.content };
    });
}

export const anthropicProvider: ProviderAdapter = {
  name: 'anthropic',

  isConfigured() {
    return Boolean(apiKey());
  },

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const key = apiKey();
    if (!key) throw retryable('ANTHROPIC_API_KEY is not set');

    const system = request.messages.find((m) => m.role === 'system')?.content;

    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model: request.model || DEFAULT_MODEL,
          system,
          messages: toAnthropicMessages(request.messages),
          max_tokens: request.maxTokens ?? 1024,
          temperature: request.temperature,
          tools: request.tools?.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema,
          })),
        }),
        signal: AbortSignal.timeout(60000),
        cache: 'no-store',
      });
    } catch {
      throw retryable('Anthropic request timed out or the network is unavailable');
    }

    if (response.status === 429 || response.status >= 500) {
      throw retryable(`Anthropic returned ${response.status}`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Anthropic request failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const data = await response.json();
    const blocks = (data.content || []) as AnthropicContentBlock[];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('');
    const toolCalls: ToolCall[] = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id || b.name || 'tool_call', name: b.name || '', arguments: b.input || {} }));

    if (!text.trim() && toolCalls.length === 0) {
      throw new Error('Anthropic returned no text content and no tool calls');
    }

    return {
      content: text,
      provider: 'anthropic',
      model: request.model || DEFAULT_MODEL,
      usage: {
        inputTokens: data.usage?.input_tokens,
        outputTokens: data.usage?.output_tokens,
      },
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  },
};
