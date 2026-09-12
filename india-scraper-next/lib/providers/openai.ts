import type { ProviderAdapter, CompletionRequest, CompletionResult, ChatMessage, ToolCall } from './types';
import { retryable } from './types';

// Also covers OpenAI's code-oriented models (what people usually mean by
// "Codex") -- there is no separate Codex HTTP API; code-specialized models
// are requested through this same chat-completions endpoint by model name.
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';
const API_URL = 'https://api.openai.com/v1/chat/completions';

function apiKey(): string | undefined {
  return process.env.OPENAI_API_KEY;
}

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

function toOpenAiMessages(messages: ChatMessage[]) {
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

function toOpenAiTools(tools: CompletionRequest['tools']) {
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

export const openaiProvider: ProviderAdapter = {
  name: 'openai',

  isConfigured() {
    return Boolean(apiKey());
  },

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const key = apiKey();
    if (!key) throw retryable('OPENAI_API_KEY is not set');

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
          messages: toOpenAiMessages(request.messages),
          max_tokens: request.maxTokens ?? 1024,
          temperature: request.temperature,
          tools: toOpenAiTools(request.tools),
        }),
        signal: AbortSignal.timeout(60000),
        cache: 'no-store',
      });
    } catch {
      throw retryable('OpenAI request timed out or the network is unavailable');
    }

    if (response.status === 429 || response.status >= 500) {
      throw retryable(`OpenAI returned ${response.status}`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenAI request failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;
    const content = typeof message?.content === 'string' ? message.content : '';
    const rawToolCalls = (message?.tool_calls || []) as OpenAiToolCall[];
    const toolCalls: ToolCall[] = rawToolCalls.map((c) => ({
      id: c.id,
      name: c.function.name,
      arguments: safeJsonParse(c.function.arguments),
    }));

    if (!content.trim() && toolCalls.length === 0) {
      throw new Error('OpenAI returned no text content and no tool calls');
    }

    return {
      content,
      provider: 'openai',
      model: request.model || DEFAULT_MODEL,
      usage: {
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens,
      },
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  },
};
