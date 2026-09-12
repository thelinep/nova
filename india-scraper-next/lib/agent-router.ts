import { getProvider, isRetryable } from './providers';
import type { ChatMessage, CompletionResult, ProviderName, ToolSpec } from './providers/types';
import { loadSkillPrompts, allowedToolNames } from './skills';
import { listToolsFor, callTool } from './mcp/registry';

interface ProviderChoice {
  provider: ProviderName;
  // Omit to use that adapter's own default model.
  model?: string;
}

export interface AgentRole {
  label: string;
  systemPrompt: string;
  // Tried in order. The router only advances to the next entry on a
  // retryable failure (timeout, rate limit, 5xx, missing API key) from the
  // one before it -- a non-retryable failure stops the chain immediately.
  chain: ProviderChoice[];
  maxTokens?: number;
  temperature?: number;
  // Skill ids to load -- their prompts append to systemPrompt, and any
  // `tools` they declare narrow which MCP tools get offered (lib/skills/index.ts).
  skills?: string[];
  // MCP server ids (lib/mcp/registry.ts) whose tools this role may call.
  toolServers?: string[];
}

// Central place to decide which model handles which kind of agent work.
// Nothing here is wired into app/api/maataa/route.ts or lib/maataa-ai.cjs --
// that subsystem stays local-Ollama-only by design. This config is for new,
// separate agent workflows that are allowed to call out to the real internet;
// see docs/MULTI-MODEL-AGENTS.md.
export const AGENT_ROLES: Record<string, AgentRole> = {
  'code-gen': {
    label: 'Code generation',
    systemPrompt: 'You write focused, working code changes. Prefer the smallest diff that solves the problem.',
    chain: [
      { provider: 'openai', model: process.env.OPENAI_CODE_MODEL || 'gpt-4.1' },
      { provider: 'anthropic' },
    ],
    maxTokens: 2048,
    skills: ['repo-read-only-tools'],
    toolServers: ['filesystem'],
  },

  'reasoning-writing': {
    label: 'Reasoning and writing',
    systemPrompt: 'You reason carefully and write clearly for a technical but non-expert reader.',
    chain: [
      { provider: 'anthropic' },
      { provider: 'openai' },
    ],
    maxTokens: 2048,
  },

  'bulk-classification': {
    label: 'High-volume classification',
    systemPrompt: 'You classify the input quickly and return only the requested label(s), nothing else.',
    chain: [
      { provider: 'deepseek' },
      { provider: 'anthropic', model: process.env.ANTHROPIC_FAST_MODEL || 'claude-haiku-4-5' },
    ],
    maxTokens: 256,
    temperature: 0,
    skills: ['district-domain-knowledge', 'event-planner-classification-rules'],
  },

  'vision-multimodal': {
    label: 'Vision and multimodal',
    systemPrompt: 'You describe and reason about the supplied visual content precisely.',
    chain: [
      { provider: 'gemini' },
      { provider: 'anthropic' },
    ],
    maxTokens: 1024,
  },

  'district-query-design': {
    label: 'District search-query design',
    systemPrompt:
      'You design a Google Maps business-search query template. Return a short name, a template containing ' +
      'literal {district} and {state} placeholders and no others, and a one-paragraph rationale. This is a draft ' +
      'for a human to review -- you do not execute it and have not collected anything yourself.',
    chain: [
      { provider: 'anthropic' },
      { provider: 'openai' },
    ],
    maxTokens: 512,
    skills: ['district-domain-knowledge'],
  },

  'roadmap-triage': {
    label: 'Roadmap triage',
    systemPrompt: 'Given the current roadmap and live status figures, recommend the single next priority and say why.',
    chain: [
      { provider: 'anthropic' },
      { provider: 'openai' },
    ],
    maxTokens: 1024,
    skills: ['maataa-roadmap-context', 'district-domain-knowledge'],
  },

  'status-report-writing': {
    label: 'Status report writing',
    systemPrompt: 'Turn the structured findings you are given into a short narrative status update.',
    chain: [
      { provider: 'anthropic' },
      { provider: 'openai' },
    ],
    maxTokens: 1024,
    skills: ['status-report-style', 'district-domain-knowledge'],
  },
};

export interface AgentRunResult extends CompletionResult {
  role: string;
  attempts: { provider: ProviderName; error?: string }[];
  // Every tool call made and its result, across every round of the loop --
  // empty when the role has no toolServers or the model never asked for one.
  toolTrace: { name: string; arguments: Record<string, unknown>; result: string }[];
}

const MAX_TOOL_ROUNDS = 6;

export async function completeAsAgent(roleName: string, messages: ChatMessage[]): Promise<AgentRunResult> {
  const role = AGENT_ROLES[roleName];
  if (!role) throw new Error(`Unknown agent role "${roleName}"`);

  const systemPrompt = [role.systemPrompt, loadSkillPrompts(role.skills)].filter(Boolean).join('\n\n');
  let conversation: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...messages];
  const toolTrace: AgentRunResult['toolTrace'] = [];

  let tools: ToolSpec[] | undefined;
  let toolOwner: Record<string, string> = {};
  const toolServers = role.toolServers ?? [];
  if (toolServers.length > 0) {
    const allowed = allowedToolNames(role.skills);
    const namedTools = await listToolsFor(toolServers);
    const usable = allowed ? namedTools.filter((t) => allowed.includes(t.name)) : namedTools;
    tools = usable.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    toolOwner = Object.fromEntries(usable.map((t) => [t.name, t.serverId]));
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const { result, attempts } = await runChainOnce(role, conversation, tools);
    const calls = result.toolCalls ?? [];

    if (calls.length === 0) {
      return { ...result, role: roleName, attempts, toolTrace };
    }

    conversation = [...conversation, { role: 'assistant', content: result.content, toolCalls: calls }];

    for (const call of calls) {
      const serverId = toolOwner[call.name];
      let resultText: string;
      if (!serverId) {
        resultText = `Error: tool "${call.name}" is not available to this role`;
      } else {
        try {
          const toolResult = await callTool(serverId, call.name, call.arguments);
          resultText = toolResult.isError ? `Error: ${toolResult.text}` : toolResult.text;
        } catch (error) {
          resultText = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      toolTrace.push({ name: call.name, arguments: call.arguments, result: resultText });
      conversation = [...conversation, { role: 'tool', content: resultText, toolCallId: call.id }];
    }
  }

  throw new Error(`Agent role "${roleName}" did not finish within ${MAX_TOOL_ROUNDS} tool-call rounds`);
}

async function runChainOnce(
  role: AgentRole,
  conversation: ChatMessage[],
  tools: ToolSpec[] | undefined,
): Promise<{ result: CompletionResult; attempts: AgentRunResult['attempts'] }> {
  const attempts: AgentRunResult['attempts'] = [];

  for (const choice of role.chain) {
    const adapter = getProvider(choice.provider);
    if (!adapter.isConfigured()) {
      attempts.push({ provider: choice.provider, error: 'not configured' });
      continue;
    }
    try {
      const result = await adapter.complete({
        messages: conversation,
        model: choice.model || '',
        maxTokens: role.maxTokens,
        temperature: role.temperature,
        tools,
      });
      attempts.push({ provider: choice.provider });
      return { result, attempts };
    } catch (error) {
      attempts.push({ provider: choice.provider, error: error instanceof Error ? error.message : String(error) });
      if (!isRetryable(error)) throw error;
    }
  }

  throw new Error(
    `All providers in this chain failed or are unconfigured: ` +
      attempts.map((a) => `${a.provider}${a.error ? ` (${a.error})` : ''}`).join(', '),
  );
}
