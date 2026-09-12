import type { ProviderAdapter, CompletionRequest, CompletionResult, ChatMessage, ToolCall } from './types';
import { retryable } from './types';

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

function apiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

// Gemini has no "system" role and no real per-call tool-call id: a function
// call/response is matched by *name* alone. That means a role that calls
// the same tool twice in one turn can't be disambiguated the way the other
// three providers allow -- acceptable for a sketch, called out here rather
// than silently assumed to work.
function toGeminiContents(messages: ChatMessage[]) {
  const system = messages.find((m) => m.role === 'system')?.content;
  const turns = messages.filter((m) => m.role !== 'system');
  const contents: { role: string; parts: GeminiPart[] }[] = [];

  for (const m of turns) {
    if (m.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: m.toolCallId || '', response: { result: m.content } } }],
      });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      contents.push({
        role: 'model',
        parts: m.toolCalls.map((c) => ({ functionCall: { name: c.name, args: c.arguments } })),
      });
      continue;
    }
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
  }

  if (system && contents.length > 0 && contents[0].role === 'user' && contents[0].parts[0]?.text !== undefined) {
    contents[0] = { ...contents[0], parts: [{ text: `${system}\n\n${contents[0].parts[0].text}` }] };
  }
  return contents;
}

export const geminiProvider: ProviderAdapter = {
  name: 'gemini',

  isConfigured() {
    return Boolean(apiKey());
  },

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const key = apiKey();
    if (!key) throw retryable('GEMINI_API_KEY (or GOOGLE_API_KEY) is not set');

    const model = request.model || DEFAULT_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: toGeminiContents(request.messages),
          tools: request.tools?.length
            ? [{ functionDeclarations: request.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })) }]
            : undefined,
          generationConfig: {
            maxOutputTokens: request.maxTokens ?? 1024,
            temperature: request.temperature,
          },
        }),
        signal: AbortSignal.timeout(60000),
        cache: 'no-store',
      });
    } catch {
      throw retryable('Gemini request timed out or the network is unavailable');
    }

    if (response.status === 429 || response.status >= 500) {
      throw retryable(`Gemini returned ${response.status}`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Gemini request failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const data = await response.json();
    const parts = (data.candidates?.[0]?.content?.parts || []) as GeminiPart[];
    const content = parts.map((p) => p.text || '').join('');
    const toolCalls: ToolCall[] = parts
      .filter((p) => p.functionCall)
      .map((p) => ({ id: p.functionCall!.name, name: p.functionCall!.name, arguments: p.functionCall!.args || {} }));

    if (!content.trim() && toolCalls.length === 0) {
      throw new Error('Gemini returned no text content and no tool calls');
    }

    return {
      content,
      provider: 'gemini',
      model,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount,
        outputTokens: data.usageMetadata?.candidatesTokenCount,
      },
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  },
};
