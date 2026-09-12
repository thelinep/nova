import type { ProviderAdapter, CompletionRequest, CompletionResult, ChatMessage, ToolCall } from './types';
import { retryable } from './types';

// DeepSeek's API is OpenAI-compatible (same request/response shape), just a
// different base URL and key -- this adapter mirrors openai.ts closely.
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const API_URL = 'https://api.deepseek.com/chat/completions';

function apiKey(): string | undefined {
  return process.env.DEEPSEEK_API_KEY;
}

interface DeepSeekToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

function toDeepSeekMessages(messages: ChatMessage[]) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

function toDeepSeekTools(tools: CompletionRequest['tools']) {
  return tools?.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export const deepseekProvider: ProviderAdapter = {
  name: 'deepseek',

  isConfigured() {
    return Boolean(apiKey());
  },

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const key = apiKey();
    if (!key) throw retryable('DEEPSEEK_API_KEY is not set');

    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: request.model || DEFAULT_MODEL,
          messages: toDeepSeekMessages(request.messages),
          max_tokens: request.maxTokens ?? 1024,
          temperature: request.temperature,
          tools: toDeepSeekTools(request.tools),
        }),
        signal: AbortSignal.timeout(60000),
        cache: 'no-store',
      });
    } catch {
      throw retryable('DeepSeek request timed out or the network is unavailable');
    }

    if (response.status === 429 || response.status >= 500) {
      throw retryable(`DeepSeek returned ${response.status}`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`DeepSeek request failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;
    const content = typeof message?.content === 'string' ? message.content : '';
    const rawToolCalls = (message?.tool_calls || []) as DeepSeekToolCall[];
    const toolCalls: ToolCall[] = rawToolCalls.map((c) => ({
      id: c.id,
      name: c.function.name,
      arguments: safeJsonParse(c.function.arguments),
    }));

    if (!content.trim() && toolCalls.length === 0) {
      throw new Error('DeepSeek returned no text content and no tool calls');
    }

    return {
      content,
      provider: 'deepseek',
      model: request.model || DEFAULT_MODEL,
      usage: {
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens,
      },
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  },
};
